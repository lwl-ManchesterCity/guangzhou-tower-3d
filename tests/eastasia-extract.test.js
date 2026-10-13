// P1-4a 的离线判据：`scripts/extract-eastasia-footprints.mjs` 里那套"读归档 → 解 shapefile/dBASE → UTM 反算 →
// 近场盒 → 写切片"的纯函数。网络那一段不在这份判据里（它没有可断言的语义），但**每一条会改变像素的算式都在**。
//
// 另一条腿是仓库里那份切片自己：`data/jingtai-eastasia-footprints.geojson` 是这一支脚本要复现的目标，
// 所以它的内在一致性（身份递增、外环方向、`rings` 与环数、小数位）在这里逐条钉住——脚本对不对，先要有个不靠
// 脚本的对照物。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NEAR_RULES, featureOf, groupRings, parseDbf, parseShapefile, pyDumps, utmToWgs84, wgs84ToUtm,
} from '../scripts/extract-eastasia-footprints.mjs';
import { SCENES } from '../src/scenes.js';

const SLICE = 'data/jingtai-eastasia-footprints.geojson';
const CENTRE = SCENES.jingtai.center;

/** 环 → 有向面积（正＝逆时针）。测试里自己算一份，不复用脚本的私有函数。 */
const area = (ring) => {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += ring[i - 1].x * ring[i].y - ring[i].x * ring[i - 1].y;
  return sum / 2;
};
const square = (x, y, size, clockwise) => {
  const ring = [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }, { x, y }];
  return clockwise ? ring.slice().reverse() : ring;
};

/** 造一份最小可用的 .shp：`records` 是 {number, type, rings}，MultiPolygon 带钉书针表。 */
function shapefileOf(records) {
  const bodies = records.map((record) => {
    const parts = record.rings.length;
    const points = record.rings.reduce((sum, ring) => sum + ring.length, 0);
    const staple = record.type === 15 ? points * 4 : 0;
    // `Parts` 只有 NumParts 项、没有终止项，`PartTypes` 只在 MultiPolygon 出现——这两条是从真归档里对出来的，
    // 不是照 ESRI 文档的二手转述（文档写 NumParts 项，实现里很容易顺手补一个终止值）。
    const body = Buffer.alloc(44 + parts * 4 + staple + points * 16);
    body.writeInt32LE(record.type, 0);
    const flat = record.rings.flat();
    const xs = flat.map((p) => p.x), ys = flat.map((p) => p.y);
    body.writeDoubleLE(Math.min(...xs), 4); body.writeDoubleLE(Math.min(...ys), 12);
    body.writeDoubleLE(Math.max(...xs), 20); body.writeDoubleLE(Math.max(...ys), 28);
    body.writeInt32LE(parts, 36); body.writeInt32LE(points, 40);
    let at = 0;
    for (let i = 0; i < parts; i++) { body.writeInt32LE(at, 44 + i * 4); at += record.rings[i].length; }
    if (staple) {
      let q = 0;
      record.rings.forEach((ring, index) => ring.forEach(() => body.writeInt32LE(index, 44 + parts * 4 + q++ * 4)));
    }
    let p = 44 + parts * 4 + staple;
    for (const point of flat) { body.writeDoubleLE(point.x, p); body.writeDoubleLE(point.y, p + 8); p += 16; }
    return body;
  });
  const total = 100 + bodies.reduce((sum, body) => sum + 8 + body.length, 0);
  const buffer = Buffer.alloc(total);
  buffer.writeInt32BE(9994, 0);
  buffer.writeInt32BE(total / 2, 24);
  buffer.writeInt32LE(1000, 28);
  buffer.writeInt32LE(records[0]?.type ?? 5, 32);
  let at = 100;
  records.forEach((record, index) => {
    buffer.writeInt32BE(record.number ?? index + 1, at);
    buffer.writeInt32BE(bodies[index].length / 2, at + 4);
    bodies[index].copy(buffer, at + 8);
    at += 8 + bodies[index].length;
  });
  return buffer;
}

/** 造一份最小可用的 .dbf：字段定长、右侧补空格，所以"取原文去空白"与"解析成数再格式化"是两种结果。 */
function dbfOf(fields, rows) {
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.size, 0);
  const headerLength = 32 + fields.length * 32 + 1;
  const buffer = Buffer.alloc(headerLength + rows.length * recordLength);
  buffer[0] = 0x03;
  buffer.writeInt32LE(rows.length, 4);
  buffer.writeUInt16LE(headerLength, 8);
  buffer.writeUInt16LE(recordLength, 10);
  fields.forEach((field, index) => {
    const at = 32 + index * 32;
    buffer.write(field.name.padEnd(11, '\0').slice(0, 11), at, 'latin1');
    buffer[at + 11] = field.type.charCodeAt(0);
    buffer[at + 16] = field.size;
    buffer[at + 17] = field.decimals ?? 0;
  });
  buffer[32 + fields.length * 32] = 0x0d;
  rows.forEach((row, index) => {
    let at = headerLength + index * recordLength;
    buffer[at++] = 0x20;
    for (const field of fields) {
      const value = String(row[field.name] ?? '');
      buffer.write(field.numeric ? value.padStart(field.size, ' ') : value.padEnd(field.size, ' '), at, 'latin1');
      at += field.size;
    }
  });
  return buffer;
}

test('UTM 49N 的正算与反算闭合到 1e-9 度，并钉住三条定义性事实', () => {
  // 正反算必须是同一套系数：不一致就意味着"格对上了但点歪了"，这类错肉眼看不出来。
  for (const point of [CENTRE, { lat: 23.1517, lng: 113.2459 }, { lat: 23.1897, lng: 113.2864 }, { lat: 23.0, lng: 111.0 }]) {
    const back = utmToWgs84(wgs84ToUtm(point));
    assert.ok(Math.abs(back.lat - point.lat) < 1e-9, `${point.lat} 反算回来差 ${back.lat - point.lat}`);
    assert.ok(Math.abs(back.lng - point.lng) < 1e-9, `${point.lng} 反算回来差 ${point.lng - point.lng}`);
    const forth = wgs84ToUtm(utmToWgs84({ easting: 732_018.6, northing: 2_561_000 + point.lat * 1000 }));
    assert.ok(Math.abs(forth.easting - 732_018.6) < 1e-4 && Math.abs(forth.northing - (2_561_000 + point.lat * 1000)) < 1e-4,
      '反算再正算回不到原处');
  }
  // 锚点一：中央经线（49 带是 111°E）上的点东距恒等于假东 500 km，赤道与中央经线交点的北距恒为 0。
  assert.equal(wgs84ToUtm({ lat: 23.17107, lng: 111 }).easting, 500_000, '中央经线上的东距不等于假东');
  assert.equal(wgs84ToUtm({ lat: 0, lng: 111 }).northing, 0, '赤道上的北距不等于 0');
  // 锚点二：单调性。纬度升北距必须升、经度升东距必须升，级数少一项或符号错会在这里断掉。
  for (let lat = 20; lat < 26; lat++) {
    assert.ok(wgs84ToUtm({ lat: lat + 0.5, lng: 113 }).northing > wgs84ToUtm({ lat, lng: 113 }).northing, `北纬 ${lat}° 之后北距不再增长`);
    assert.ok(wgs84ToUtm({ lat, lng: 113.5 }).easting > wgs84ToUtm({ lat, lng: 113 }).easting, `东经 113° 之后东距不再增长`);
  }
  const campus = wgs84ToUtm(CENTRE);
  // 校区在 113.266°E，应当在 500 km 以东约 232 km；纬度 23.17° 的北距约 2,561 km。
  assert.ok(campus.easting > 700_000 && campus.easting < 760_000, `东距 ${campus.easting} 不在 UTM 49N 的广州量级`);
  assert.ok(campus.northing > 2_550_000 && campus.northing < 2_580_000, `北距 ${campus.northing} 不在北纬 23° 的量级`);
  // 换带到 50N 就不是同一个数：这一条挡住"区号写死在别处"的错。
  assert.notEqual(wgs84ToUtm(CENTRE, 50).easting, campus.easting);
  // 这里**不放**任何"我记得的弧长常数"：本轮按记忆写过一条 45°N 弧长 = 4,995,985 m 的断言，被这条判据自己
  // 抓出来是错的（真值约 4,984,965 m）。绝对口径交给 `--verify`：它拿仓库里那份由原实现产出的切片当对照物。
});

test('合成 shapefile：Polygon 带洞、MultiPolygon 带钉书针、空记录，逐条读回顶点', () => {
  // 外部锚点：真归档里"1 个部件、5 个点"的 Polygon 记录内容长度是 **64 个字（128 B）**（2026-10-06 从
  // Guangzhou.shp 头几条记录量出来的）。这里造的同形状必须也是 64 字——不然 fixture 与解析器会一起错：
  // 本轮两边都曾按"Parts 有终止项"来写/读，八条测试全绿，真文件却读不动。
  assert.equal(shapefileOf([{ number: 1, type: 5, rings: [square(0, 0, 10, false)] }]).readInt32BE(104), 64,
    '夹具的字节布局与真归档不一致，这条测试不说明任何事');
  const outer = square(0, 0, 100, false);
  const hole = square(20, 20, 10, true);
  const buffer = shapefileOf([
    { number: 7, type: 5, rings: [outer, hole] },
    { number: 8, type: 15, rings: [square(0, 0, 10, false), square(50, 50, 10, false)] },
    { number: 9, type: 5, rings: [] },
  ]);
  const records = parseShapefile(buffer);
  assert.equal(records.length, 3, '三条记录读成了别的条数');
  assert.deepEqual(records.map((record) => record.number), [7, 8, 9], '记录号不是归档里那一个');
  assert.deepEqual(records[0].parts.map((ring) => ring.length), [5, 5], 'Polygon 的两个环没都读回来');
  assert.deepEqual(records[0].parts[0][1], { x: 100, y: 0 }, '顶点顺序或 x/y 归属错了');
  assert.deepEqual(records[1].parts.map((ring) => ring[0]), [{ x: 0, y: 0 }, { x: 50, y: 50 }],
    'MultiPolygon 的点数组被钉书针表顶开了');
  assert.deepEqual(records[1].box, [0, 0, 60, 60], '包围盒不是这一条自己的');
  assert.deepEqual(records[2].parts, [], '空记录应当没有环');
  // 类型不认识与长度对不上都必须炸：静默跳过就是"少一栋楼"。
  assert.throws(() => parseShapefile(shapefileOf([{ number: 1, type: 3, rings: [outer] }])), /只认 0、5、15/);
  assert.throws(() => parseShapefile(buffer.subarray(0, buffer.length - 16)), /声明 \d+ B，实际 \d+ B/);
  const wrongVersion = Buffer.from(buffer);
  wrongVersion.writeInt32LE(999, 28);
  assert.throws(() => parseShapefile(wrongVersion), /版本号/);
});

test('合成 dBASE：字段名、定长切片与去空白，取的是原文不是解析后的数', () => {
  // 列名照真归档那四列写（`id`、`ORIG_OID`、`STATUS`、`ORIG_FID`）：切片里的 `dataset_id` 就是 `id` 那一列，
  // 夹具里换成"看起来更合理"的 DATASET_ID 会让这条测试验不到真东西。
  const fields = [{ name: 'id', type: 'N', size: 18, decimals: 11, numeric: true },
    { name: 'ORIG_OID', type: 'N', size: 11, numeric: true }, { name: 'STATUS', type: 'C', size: 4 },
    { name: 'ORIG_FID', type: 'N', size: 10, numeric: true }];
  const buffer = dbfOf(fields, [{ id: '6393.00000000000', ORIG_OID: '1', STATUS: '0', ORIG_FID: '251' },
    { id: '13277.00000000000', ORIG_OID: '35', STATUS: '1', ORIG_FID: '12004' }]);
  const parsed = parseDbf(buffer);
  assert.deepEqual(parsed.fields.map((field) => field.name), ['id', 'ORIG_OID', 'STATUS', 'ORIG_FID']);
  assert.equal(parsed.count, 2);
  // 行是按需取的（广州那一份有 179 万行，近场只留 1.1 万），所以这里取第 0 与第 1 行。
  assert.equal(parsed.rowAt(0).id, '6393.00000000000', '数值字段被格式化过了');
  assert.deepEqual(parsed.rowAt(1), { id: '13277.00000000000', ORIG_OID: '35', STATUS: '1', ORIG_FID: '12004' });
  const broken = dbfOf([{ name: 'A', type: 'C', size: 5 }], [{ A: 'x' }]);
  broken.writeUInt16LE(9, 10);
  assert.throws(() => parseDbf(broken), /声明记录长 9 B/);
});

test('环分组按 ESRI 的原始口径：顺时针是外环，逆时针挂成前一个的洞', () => {
  // 切片里外环是逆时针，那是输出前"先闭合再反转"翻了一次符号的结果（见 `featureOf` 那一条），
  // 分组这一步吃的还是原始环，所以这里按 ESRI 的约定验。
  const cw = square(0, 0, 10, true), ccw = square(2, 2, 4, false);
  assert.equal(groupRings([cw, ccw]).length, 1, '外环 + 洞被拆成了两个多边形');
  assert.equal(groupRings([cw, ccw])[0].length, 2, '洞没挂到外环上');
  assert.equal(groupRings([cw, cw]).length, 2, '两个外环应当是两个多边形');
  // 首环方向不对也要开一个多边形，否则整条记录的几何就没了。
  assert.equal(groupRings([ccw, ccw]).length, 1, '首环无论方向都必须开一个多边形');
  assert.equal(area(cw) < 0, true, '测试自己的方向定义反了，后面几条都不算数');
});

test('输出环 = 先闭合再反转：切片的重复首点与逆时针外环都来自这一步', () => {
  const base = wgs84ToUtm(CENTRE);
  // 原始环按 ESRI 给：顺时针、且自己就是闭合的（正方形 5 个点）。
  const raw = square(base.easting, base.northing, 10, true);
  const feature = featureOf({ number: 1, box: null, parts: [raw] }, { id: '1', STATUS: '0', ORIG_OID: '1' });
  const out = feature.geometry.coordinates[0];
  assert.equal(out.length, raw.length + 1, '闭合的正方形输出应当是 6 个点（开头多一笔重复首点）');
  assert.deepEqual(out[0], out[1], '切片里那一笔重复首点没复现');
  assert.deepEqual(out[0], out[out.length - 1], '输出环必须首尾同点');
  assert.ok(area(out.map(([lng, lat]) => ({ x: lng, y: lat }))) > 0, '反转之后外环应当是逆时针（切片实测口径）');
  // 顺序：丢掉那笔重复首点再反转，应当逐点回到原始环。
  const conv = (point) => { const { lat, lng } = utmToWgs84({ easting: point.x, northing: point.y });
    return [Number(lng.toFixed(7)), Number(lat.toFixed(7))]; };
  assert.deepEqual([...out].reverse().slice(0, -1), raw.map(conv), '点位顺序不是"先闭合再反转"');
});

test('近场盒三条口径各筛掉什么：顶点、包围盒、质心不是同一件事', () => {
  const box = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  const inside = { number: 1, box: [10, 10, 20, 20], parts: [square(10, 10, 10, false)] };
  // 跨界的这一条：四个顶点都在盒外，但包围盒与盒相交、质心在盒内。
  const straddling = { number: 2, box: [-10, -10, 110, 10], parts: [[{ x: -10, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 10 }, { x: -10, y: 10 }, { x: -10, y: -10 }]] };
  const outside = { number: 3, box: [500, 500, 510, 510], parts: [square(500, 500, 10, false)] };
  const kept = (rule) => [inside, straddling, outside].filter((record) => NEAR_RULES[rule](record, box)).map((r) => r.number);
  assert.deepEqual(kept('vertex-box'), [1], '顶点口径应当只留完全在盒里那一条');
  assert.deepEqual(kept('bbox-box'), [1, 2], '包围盒口径应当把跨界的也收进来');
  assert.deepEqual(kept('centroid-box'), [1, 2], '质心口径收的是质心在盒内的');
});

test('pyDumps 是 Python 的默认分隔符，不是 JSON.stringify', () => {
  const value = { type: 'FeatureCollection', features: [{ id: 'gz-1', n: 1.5, s: 'a"b', nil: null }] };
  assert.equal(pyDumps(value), '{"type": "FeatureCollection", "features": [{"id": "gz-1", "n": 1.5, "s": "a\\"b", "nil": null}]}');
  assert.notEqual(pyDumps(value), JSON.stringify(value), '两者相同就说明这条判据没在看分隔符');
  assert.equal(pyDumps([1, [2, 3]]), '[1, [2, 3]]');
});

test('featureOf：id 用记录号、属性是字段原文、几何按分组结果', () => {
  // 基准点取校区中心自己正算出来的 UTM 坐标，不写死数字：写死就会把"哪一带"这件事混进判据里。
  const base = wgs84ToUtm(CENTRE);
  const at = (dx, dy, size, clockwise) => square(base.easting + dx, base.northing + dy, size, clockwise);
  const record = { number: 252, box: [0, 0, 100, 100], parts: [at(0, 0, 30, true), at(10, 10, 5, false)] };
  const row = { id: '6393.00000000000', STATUS: '0', ORIG_OID: '1', ORIG_FID: '251' };
  const feature = featureOf(record, row);
  assert.equal(feature.id, 'gz-252', '身份不是记录号就对不上卡片与深链');
  assert.deepEqual(feature.properties, { osm_id: null, dataset_id: '6393.00000000000', status: '0', orig_oid: '1', rings: 2 });
  assert.equal(feature.geometry.type, 'Polygon', '外环 + 洞应当还是一个 Polygon');
  // 真归档的环是闭合的（5 个点），切片里是 6 个：开头多一个重复首点。这一笔是一次性脚本留下的，照抄。
  assert.deepEqual(feature.geometry.coordinates.map((ring) => ring.length), [6, 6]);
  assert.deepEqual(feature.geometry.coordinates[0][0], feature.geometry.coordinates[0][1], '闭合环应当在开头重复首点');
  assert.equal(feature.geometry.coordinates[0][0].length, 2, '坐标应当是 [经度, 纬度] 两个数');
  for (const ring of feature.geometry.coordinates) for (const [lng, lat] of ring) {
    assert.ok(Math.abs(lat - CENTRE.lat) < 0.01 && Math.abs(lng - CENTRE.lng) < 0.01, `反算出来的点跑到了 ${lat}/${lng}`);
    assert.ok(Math.abs(lat * 1e7 - Math.round(lat * 1e7)) < 1e-3, '坐标没收到 7 位小数');
    assert.ok(Math.abs(lng * 1e7 - Math.round(lng * 1e7)) < 1e-3, '坐标没收到 7 位小数');
  }
  // 两个外环 → MultiPolygon，且每个部件自己是一个 [外环] 数组。
  const two = featureOf({ ...record, parts: [record.parts[0], at(500, 500, 30, true)] }, row);
  assert.equal(two.geometry.type, 'MultiPolygon');
  assert.deepEqual(two.geometry.coordinates.map((polygon) => polygon.length), [1, 1]);
  // 遇到不闭合的环走正常收尾（补一个首点），不产出非法 GeoJSON——真归档里这一支走不到，但降级路径也要有判据。
  const open = { number: 9, box: null, parts: [[{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }]] };
  const ring = featureOf(open, row).geometry.coordinates[0];
  assert.equal(ring.length, 5, '不闭合的环没有被补上首点');
  assert.deepEqual(ring[0], ring[4], '补上的应当是首点');
  assert.notEqual(ring[0], ring[1], '不闭合的环不该再多重复一次首点');
});

test('仓库那份切片自己站得住：条数、身份递增、外环方向、rings 与小数位', () => {
  const slice = JSON.parse(readFileSync(SLICE, 'utf8'));
  assert.equal(slice.type, 'FeatureCollection');
  assert.equal(slice.features.length, 11_257, '切片条数变了，P1-4 那一节的对账数字全要重量');
  const ids = slice.features.map((feature) => Number(feature.id.replace('gz-', '')));
  assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]), '身份不是严格递增的记录号，说明排序或编号被改过');
  const types = slice.features.reduce((count, feature) => {
    count[feature.geometry.type] = (count[feature.geometry.type] ?? 0) + 1;
    return count;
  }, {});
  assert.deepEqual(types, { Polygon: 11_245, MultiPolygon: 12 }, '两种几何的条数与记录不符');
  let holes = 0;
  for (const feature of slice.features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const rings = polygons.flat();
    assert.equal(feature.properties.rings, rings.length, `${feature.id} 的 rings 与实际环数不符`);
    assert.equal(polygons.length === 1, feature.geometry.type === 'Polygon', `${feature.id} 的类型与部件数不符`);
    holes += polygons.reduce((sum, polygon) => sum + polygon.length - 1, 0);
    for (const polygon of polygons) polygon.forEach((ring, index) => {
      // 外环逆时针、洞顺时针——脚本的分组口径就是照这一条定的。
      assert.ok(index === 0 ? area(ring.map((p) => ({ x: p[0], y: p[1] }))) > 0 : area(ring.map((p) => ({ x: p[0], y: p[1] }))) < 0,
        `${feature.id} 第 ${index} 环的方向与「外环 CCW、洞 CW」不符`);
      assert.deepEqual(ring[0], ring[ring.length - 1], `${feature.id} 的环没闭合`);
      for (const [lng, lat] of ring) {
        assert.ok(Math.abs(lng * 1e7 - Math.round(lng * 1e7)) < 1e-6 && Math.abs(lat * 1e7 - Math.round(lat * 1e7)) < 1e-6,
          `${feature.id} 有坐标超过了 7 位小数`);
      }
    });
  }
  assert.equal(holes, 25, '洞的总数变了：22 个带洞 Polygon 这一格要重新对账');
  // 把脚本的整条输出规则反照到成品上：切片里的环 = "先闭合再反转"，所以还原成原始环（反转回去、丢掉末尾
  // 那笔重复）之后，按 ESRI 的"顺时针外环"分组必须逐条还原出切片自己的部件结构。这一条钉的是分组 + 反转
  // 两步合起来的可逆性，不是单看某一环的方向。
  const toRaw = (ring) => {
    const back = [...ring].reverse();
    return back[0][0] === back[1][0] && back[0][1] === back[1][1] ? back.slice(0, -1) : back;
  };
  for (const feature of slice.features) {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const raw = polygons.flat().map((ring) => toRaw(ring).map((p) => ({ x: p[0], y: p[1] })));
    // 还原出来的原始外环应当是顺时针（ESRI），这一条把"切片逆时针 = 反转所致"钉死。
    assert.ok(area(raw[0]) < 0, `${feature.id}：还原出的外环不是顺时针，反转这一步的解释不成立`);
    assert.deepEqual(groupRings(raw).map((polygon) => polygon.length), polygons.map((polygon) => polygon.length),
      `${feature.id}：分组 + 反转还原不出切片自己的部件结构`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  BORDER_SHADE, JOINT_SHADE, KERB_METRES, KERB_SHADE, PLAZA_PIXEL_METRES, PLAZA_SURFACE_MIN_ZOOM,
  PAVING_JOINT_METRES, STONE_FIELD_SHADE, WATER_EDGE_SHADE, plazaSurface, plazaSurfaceMesh,
} from '../src/plaza-surface.js';
import { carvePlaza } from '../src/plaza.js';
import { DEFAULT_CENTER, SCENE } from '../src/config.js';
import { destination, plane } from '../src/geo.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8')).features;
const byte = (surface, column, row) => surface.texture.image.data[((row * surface.wide) + column) * 4];
const level = (shade) => Math.round(255 * shade);
/** 一条经纬度环自己的面积，米²——用与模块同一个投影量，这样"画了多少"和"实测多少"是同一把尺。 */
function metresArea(ring, origin) {
  const points = ring.map(([lng, lat]) => plane(origin, { lng, lat }));
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    sum += a.dx * b.dy - b.dx * a.dy;
  }
  return Math.abs(sum / 2);
}

/** 一块 120 m × 80 m 的矩形广场：西半是草坪、东半是石材、中间挖一块水，边界都在可解析的位置上。 */
function synthetic() {
  const at = (east, north) => {
    const first = destination(DEFAULT_CENTER, east, 90);
    return [first.lng, destination(first, north, 0).lat];
  };
  const ring = [at(-60, -40), at(60, -40), at(60, 40), at(-60, 40)];
  const face = (kind, west, east, south, north) => ({
    type: 'Feature',
    properties: { kind, osmId: 1, area: null },
    geometry: { type: 'Polygon', coordinates: [[at(west, south), at(east, south), at(east, north), at(west, north), at(west, south)]] },
  });
  return { ring, face,
    features: [face('lawn', -60, 60, -40, 40), face('stone', 0, 60, -40, 40), face('pool', -30, -10, -10, 10)],
    metresOf: (east, north) => {
      const [lng, lat] = at(east, north);
      const { dx, dy } = plane(DEFAULT_CENTER, { lng, lat });
      return { x: dx, y: dy };
    } };
}

const columnOf = (surface, x) => Math.floor((x - surface.metres.west) / PLAZA_PIXEL_METRES);
const rowOf = (surface, y) => Math.floor((y - surface.metres.south) / PLAZA_PIXEL_METRES);
/** 一块像素范围内的亮度分布。 */
function tally(surface, west, east, south, north) {
  const counts = {};
  for (let row = rowOf(surface, south); row <= rowOf(surface, north); row += 1) {
    for (let column = columnOf(surface, west); column <= columnOf(surface, east); column += 1) {
      const value = byte(surface, column, row);
      counts[value] = (counts[value] ?? 0) + 1;
    }
  }
  return counts;
}

test('一张地面图的坐标是广场自己的米数，网格搬回场景那一格', () => {
  const { ring, features, metresOf } = synthetic();
  const surface = plazaSurface({ ring, features, origin: DEFAULT_CENTER });
  const corner = metresOf(-60, -40);
  const opposite = metresOf(60, 40);
  assert.equal(surface.wide, Math.round((opposite.x - corner.x) / PLAZA_PIXEL_METRES));
  assert.equal(surface.tall, Math.round((opposite.y - corner.y) / PLAZA_PIXEL_METRES));
  assert.equal(surface.metres.west, corner.x);
  assert.equal(surface.metres.south, corner.y);
  // 顶点量的是"离西南角多少米"，所以这块网格要自己搬回去，否则它会站在场景原点而不是广场上。
  const mesh = plazaSurfaceMesh(surface);
  assert.ok(Math.abs(mesh.position.x - corner.x) < 1e-6);
  assert.equal(mesh.position.y, 0);
  assert.ok(Math.abs(mesh.position.z + corner.y) < 1e-6);
  const uv = mesh.geometry.getAttribute('uv');
  for (let index = 0; index < uv.count; index += 1) {
    assert.ok(uv.getX(index) >= 0 && uv.getX(index) <= 1, 'u 跑到了这一圈之外');
    assert.ok(uv.getY(index) >= 0 && uv.getY(index) <= 1, 'v 跑到了这一圈之外');
  }
});

test('没被任何实测面占到的地方保持原样：这张图不画广场之外的东西', () => {
  const { ring, face } = synthetic();
  // 只给西半一块草坪：东半是"广场里但没分类"，那一半必须一个像素都没被改变。
  const only = plazaSurface({ ring, features: [face('lawn', -60, 0, -40, 40)], origin: DEFAULT_CENTER });
  const seen = new Set();
  for (let i = 0; i < only.texture.image.data.length; i += 4) seen.add(only.texture.image.data[i]);
  assert.deepEqual([...seen].sort((a, b) => a - b), [level(BORDER_SHADE), 255].sort((a, b) => a - b),
    '只有一块草坪时，图上除了草坪边线之外必须全是"不改变"');
  const east = tally(only, 10, 55, -30, 30);
  assert.deepEqual(Object.keys(east), ['255'], `没分类的那一半被画上了笔触：${JSON.stringify(east)}`);
});

test('分格缝只出现在石材上，而且每 6 m 一道', () => {
  const { ring, features, metresOf } = synthetic();
  const surface = plazaSurface({ ring, features, origin: DEFAULT_CENTER });
  const joint = level(JOINT_SHADE);
  const row = rowOf(surface, metresOf(30, 0).y);
  const columns = [];
  for (let column = 0; column < surface.wide; column += 1) if (byte(surface, column, row) === joint) columns.push(column);
  assert.ok(columns.length > 4, `这一行只找到 ${columns.length} 道缝`);
  const gaps = columns.slice(1).map((value, index) => value - columns[index]);
  assert.deepEqual([...new Set(gaps)], [Math.round(PAVING_JOINT_METRES / PLAZA_PIXEL_METRES)],
    '缝的间距不是 6 m 一格');
  // 砖是铺在石板上的，不是铺在草皮上：草坪那一半（含水）一个缝像素都不该有。
  const lawn = tally(surface, metresOf(-55, -25).x, metresOf(-35, 25).x, metresOf(-55, -25).y, metresOf(-35, 25).y);
  assert.equal(lawn[joint] ?? 0, 0, '草坪上长了分格缝');
  assert.equal(Object.keys(lawn).filter((value) => +value !== 255 && +value !== level(BORDER_SHADE)).length, 0,
    `草坪那一半出现了边线以外的笔触：${JSON.stringify(lawn)}`);
});

test('收边在两边都看得见：石材那一侧亮、草坪那一侧压一道线', () => {
  const { ring, features, metresOf } = synthetic();
  const surface = plazaSurface({ ring, features, origin: DEFAULT_CENTER });
  const border = columnOf(surface, metresOf(0, 30).x);
  const row = rowOf(surface, metresOf(0, 30).y);
  const step = Math.round(KERB_METRES / PLAZA_PIXEL_METRES);
  assert.equal(byte(surface, border + step - 1, row), level(KERB_SHADE), '石材一侧的收边没读出来');
  assert.equal(byte(surface, border - step + 1, row), level(BORDER_SHADE),
    '草坪一侧的收边没读出来——乘性贴图提不亮，那一侧只能压线');
  // 石材那一块里，本体必须是主数，缝是少数，且没有草坪那道边线混进来。
  const stone = tally(surface, metresOf(5, 5).x, metresOf(55, 35).y, metresOf(5, 5).y, metresOf(55, 35).y);
  assert.equal(stone[level(BORDER_SHADE)] ?? 0, 0, '石材里出现了草坪那一侧的边线');
  assert.ok(stone[level(STONE_FIELD_SHADE)] > (stone[level(JOINT_SHADE)] ?? 0) * 4,
    `石材里缝比本体还多：${JSON.stringify(stone)}`);
});

test('水线画在水面内侧，比草坪那道边线更暗', () => {
  const { ring, features, metresOf } = synthetic();
  const surface = plazaSurface({ ring, features, origin: DEFAULT_CENTER });
  const row = rowOf(surface, metresOf(-20, 0).y);
  const edge = columnOf(surface, metresOf(-30, 0).x);
  assert.equal(byte(surface, edge + 1, row), level(WATER_EDGE_SHADE), '水面边上没有水线');
  assert.ok(WATER_EDGE_SHADE < BORDER_SHADE && BORDER_SHADE < STONE_FIELD_SHADE, '三档压暗的次序倒了');
  assert.ok(surface.counts.edge > 0 && surface.counts.kerb > 0 && surface.counts.joint > 0,
    `三笔里有一笔一个像素都没画：${JSON.stringify(surface.counts)}`);
});

test('层序与 plazaLayers 一致：石材盖在草坪之上，贴图不改变颜色只改变明暗', () => {
  const { ring, features, metresOf } = synthetic();
  const surface = plazaSurface({ ring, features, origin: DEFAULT_CENTER });
  // 东半同时被草坪与石材覆盖：那一块里必须找得到石材的本体档，且一个像素都不该是"不改变"以外的草坪笔触。
  const stone = tally(surface, metresOf(5, -35).x, metresOf(55, 35).y, metresOf(5, -35).y, metresOf(55, 35).y);
  assert.ok(stone[level(STONE_FIELD_SHADE)] > 0, '石材盖不住草坪：那一块没有本体档');
  assert.equal(stone[level(BORDER_SHADE)] ?? 0, 0, '石材里还留着草坪那一侧的边线，说明层序倒了');
  const material = plazaSurfaceMesh(surface).material;
  assert.equal(material.blending, THREE.MultiplyBlending, '这张图是乘上去的，不是盖上去的');
  assert.equal(material.premultipliedAlpha, true, 'MultiplyBlending 不配 premultipliedAlpha 会在控制台报错');
  assert.equal(material.map.colorSpace, THREE.NoColorSpace, '乘数不是一种颜色');
  assert.equal(material.depthWrite, false, '地面那块网格不该参与遮挡');
});

test('真实广场：一张图不超过两百万格，笔触数量对得上实测面积', () => {
  const plaza = carvePlaza({ greens: load('canton-greens'), water: load('canton-water'),
    blocks: load('canton-blocks'), streets: load('canton-streets') });
  assert.equal(plaza.ring?.length > 4, true, '裁不出广场外轮廓');
  const surface = plazaSurface({ ring: plaza.ring, features: plaza.features, origin: SCENE.center });
  assert.ok(surface.wide * surface.tall <= 2.1e6, `这张图有 ${(surface.wide * surface.tall / 1e6).toFixed(2)} Mpx`);
  assert.equal(surface.tall / surface.wide > 3, true, '广场该是一条南北长的带子');
  const measured = plaza.features.filter((feature) => ['stone', 'walk'].includes(feature.properties.kind))
    .reduce((sum, feature) => sum + metresArea(feature.geometry.coordinates[0], SCENE.center), 0);
  const drawn = surface.counts.stone * PLAZA_PIXEL_METRES * PLAZA_PIXEL_METRES;
  // 画出来的必须是**并集**：实测那些面彼此重叠（一条步行带压在硬质面上是常态），所以像素数只会小于逐块相加。
  // 上限是硬道理（重叠不会让并集变大），下限挡的是"某块面整块没画上去"。
  assert.ok(drawn <= measured * 1.02,
    `并集不可能大于逐块相加：画了 ${Math.round(drawn).toLocaleString()} m²，实测加起来只有 ${Math.round(measured).toLocaleString()} m²`);
  assert.ok(drawn >= measured * 0.75,
    `实测硬质面与步行带逐块相加 ${Math.round(measured).toLocaleString()} m²，这张图上只画了 ${Math.round(drawn).toLocaleString()} m²`);
  const share = surface.counts.stone / (surface.wide * surface.tall);
  assert.ok(share > 0.01 && share < 0.08, `石材占了这张图的 ${(share * 100).toFixed(1)} %`);
  assert.equal(PLAZA_SURFACE_MIN_ZOOM, 16.5, '这一档要钉在"细节落得下像素"那一格，而不是默认机位那一格');
});

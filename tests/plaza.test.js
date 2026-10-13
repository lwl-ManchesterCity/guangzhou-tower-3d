import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PLAZA_LAWN, PLAZA_OSM_ID, PLAZA_POOL, PLAZA_SOURCE, PLAZA_STONE, PLAZA_WALK,
  MITER_LIMIT, STEPS_WIDTH_METRES, WALK_WIDTH_METRES, carvePlaza, plazaLayers, ringCentre, stoneRings, stripRing,
} from '../src/plaza.js';
import { insideRing } from '../src/buildings.js';
import { ATMOSPHERES } from '../src/atmosphere.js';
import { distanceMeters, plane } from '../src/geo.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'));
const greens = load('canton-greens').features;
const water = load('canton-water').features;
const blocks = load('canton-blocks').features;
const streets = load('canton-streets').features;
const park = greens.find((feature) => feature.properties.osmId === PLAZA_OSM_ID);
const parkRing = park.geometry.coordinates[0];
const ORIGIN = { lat: 23.121, lng: 113.3192 };

const metres = (line) => line.map(([lng, lat]) => plane(ORIGIN, { lng, lat }));
const alongEast = (from, metres_) => [from[0] + metres_ / (Math.cos(ORIGIN.lat * Math.PI / 180) * 111320), from[1]];
const alongNorth = (from, metres_) => [from[0], from[1] + metres_ / 110570];
const ringArea = (ring) => {
  const points = metres(ring.slice(0, -1));
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.dx * next.dy - next.dx * point.dy;
  }, 0) / 2);
};

test('扫出来的带：直段宽度就是点名的那个数，面积就是长×宽', () => {
  const line = [alongEast([ORIGIN.lng, ORIGIN.lat], 0), alongEast([ORIGIN.lng, ORIGIN.lat], 100)];
  const ring = stripRing(line, WALK_WIDTH_METRES);
  assert.ok(ring, '一条 100 m 的直线扫不出带');
  assert.equal(ring[0][0], ring.at(-1)[0], '环没闭合');
  assert.equal(ring.length, 5, `直段该是 4 个角加闭合点，拿到 ${ring.length} 个`);
  const points = metres(ring);
  const left = points[0], right = points.at(-2);
  assert.ok(Math.abs(Math.hypot(right.dx - left.dx, right.dy - left.dy) - WALK_WIDTH_METRES) < 0.05,
    '一条直带的两条边不是那个宽度');
  assert.ok(Math.abs(ringArea(ring) - 100 * WALK_WIDTH_METRES) / (100 * WALK_WIDTH_METRES) < 0.01,
    `100 m × 6 m 的带算出来 ${ringArea(ring).toFixed(1)} m²`);
  assert.equal(stripRing([line[0]], 6), null, '一个点也该扫出东西来了');
  assert.equal(stripRing(line, 0), null, '宽度为 0 还画一条带就是自己造东西');
});

test('转角用斜接，急弯上那根刺被夹住', () => {
  const south = alongNorth([ORIGIN.lng, ORIGIN.lat], -40);
  const east = alongEast([ORIGIN.lng, ORIGIN.lat], 60);
  const right = stripRing([south, [ORIGIN.lng, ORIGIN.lat], east], 8);
  assert.ok(right, '直角弯扫不出带');
  // 只量转角自己那两个偏移点（环里第 2 个与倒数第 2 个）——带子的另一端本来就在 60 m 之外。
  const corners = metres(right);
  // 环是 [左0,左1,左2,右2,右1,右0,闭合]，转角那两个是第 2 个与倒数第 3 个。
  const apexes = [corners[1], corners.at(-3)];
  const far = Math.max(...apexes.map((point) => Math.hypot(point.dx, point.dy)));
  assert.ok(Math.abs(far - 4 * Math.SQRT2) < 0.2, `直角弯上斜接伸出 ${far.toFixed(2)} m，理论值是 √2×半宽 = ${(4 * Math.SQRT2).toFixed(2)} m`);
  assert.ok(ringArea(right) > 96 * 8, `带子面积 ${(ringArea(right) / 8).toFixed(1)} m×宽，宽度在转角被吃掉了`);
  // 几乎回头的急弯：不夹住的话斜接长度会奔着几十倍半宽去。
  const back = alongEast(alongNorth([ORIGIN.lng, ORIGIN.lat], 40), 1.2);
  const hairpin = stripRing([alongNorth([ORIGIN.lng, ORIGIN.lat], 40), [ORIGIN.lng, ORIGIN.lat], back], 6);
  const hc = metres(hairpin);
  const reach = [hc[1], hc.at(-3)].map((point) => Math.hypot(point.dx, point.dy));
  assert.ok(Math.max(...reach) <= 3 * 3 + 0.2, `急弯上伸出 ${(Math.max(...reach) / 3).toFixed(1)} 倍半宽，miter 没夹住`);
  assert.ok(Math.max(...reach) > 3 * 3 - 0.6, '急弯没有顶到夹持上限，说明这一发没量到急弯');
});

test('花城广场切出四层，每一块都回指自己那条 OSM way', () => {
  const plaza = carvePlaza({ greens, water, blocks, streets });
  assert.equal(plaza.report.missing, false);
  // 步行带从 3 条涨到 17 条：快照的抽取半径从 1 km 提到 2.2 km 之后，广场里那些 `pedestrian`/`steps` 线整条进来了
  // （以前它们只有一段落在 1 km 圈内，被"绝大多数顶点在广场里"那条规则挡掉）。
  assert.deepEqual(plaza.report, { lawn: 20, pool: 1, stone: 4, walk: 17, missing: false });
  const kinds = new Set(plaza.features.map((feature) => feature.properties.kind));
  assert.deepEqual([...kinds].sort(), ['lawn', 'pool', 'stone', 'walk'].sort(), '冒出了一个没在名单里的层');
  for (const feature of plaza.features) {
    assert.ok(Number.isInteger(feature.properties.osmId), '一块面没有自己的 way id');
    assert.equal(feature.geometry.type, 'Polygon');
    for (const ring of feature.geometry.coordinates) {
      assert.equal(ring[0][0], ring.at(-1)[0], `${feature.properties.osmId} 的环没闭合`);
      assert.ok(ring.every((point) => Number.isFinite(point[0]) && Number.isFinite(point[1])), '环里有 NaN 坐标');
    }
    const [lng, lat] = ringCentre(feature.geometry.coordinates[0]);
    assert.ok(insideRing(parkRing, lng, lat), `${feature.properties.osmId} 的代表点跑到广场外面去了`);
  }
  const areaOf = (kind) => plaza.features.filter((feature) => feature.properties.kind === kind)
    .reduce((sum, feature) => sum + ringArea(feature.geometry.coordinates[0]), 0);
  const parkArea = ringArea(parkRing);
  // V5-5 定的那条：这条轴要读成绿轴。所以石材最多只能占广场的一小条，不能把公园改判成停车场。
  assert.ok((areaOf('stone') + areaOf('walk')) / parkArea < 0.15,
    `石材占了 ${((areaOf('stone') + areaOf('walk')) / parkArea * 100).toFixed(1)}%，绿轴就读不出来了`);
  assert.ok(areaOf('lawn') / parkArea > 0.05 && areaOf('pool') / parkArea > 0.02, '草坪或水面小到这里就等于没分层');
  assert.ok(plaza.features.every((feature) => feature.properties.kind !== 'walk' || feature.properties.swept > 0),
    '扫出来的带没记下自己用的是哪个宽度');
});

test('没有那块公园面，就什么都不切', () => {
  const empty = carvePlaza({ greens: [], water, blocks, streets });
  assert.deepEqual(empty.features, []);
  assert.equal(empty.report.missing, true);
  const wrong = carvePlaza({ greens, water: [], blocks: [], streets: [], parkId: 1 });
  assert.equal(wrong.report.missing, true, '一个不存在的 id 也切出东西来了');
});

test('四层各自的颜色来自当前氛围，切换时只有颜色跟着走', () => {
  for (const id of Object.keys(ATMOSPHERES)) {
    const theme = ATMOSPHERES[id];
    const layers = plazaLayers(theme);
    assert.equal(layers.length, 4, `${id} 档该有四层`);
    assert.equal(new Set(layers.map((layer) => layer.id)).size, 4, `${id} 档里有重名层`);
    const colourOf = (name) => layers.find((layer) => layer.id === name).paint['fill-color'];
    assert.equal(colourOf(PLAZA_LAWN), theme.grass, `${id} 档的草坪没跟着草地色走`);
    assert.equal(colourOf(PLAZA_POOL), theme.water, `${id} 档的水面没跟着水色走`);
    assert.equal(colourOf(PLAZA_STONE), theme.plaza, `${id} 档的石材不是这一档的石材色`);
    assert.equal(colourOf(PLAZA_WALK), theme.plazaWalk, `${id} 档的步行带不是这一档的石材亮色`);
    for (const layer of layers) {
      assert.equal(layer.source, PLAZA_SOURCE);
      assert.deepEqual(layer.filter, ['==', ['get', 'kind'], layer.id.replace('plaza-', '')],
        `${layer.id} 的过滤器与层名对不上，MapLibre 会静默丢层`);
      assert.ok(layer.paint['fill-opacity'] > 0.5 && layer.paint['fill-opacity'] <= 1, `${layer.id} 的透明度太透`);
    }
  }
  // 夜景的石材必须比路面暗一档，否则中轴会烧成一块白。
  const night = ATMOSPHERES.night;
  const luma = (hex) => 0.299 * Number.parseInt(hex.slice(1, 3), 16) + 0.587 * Number.parseInt(hex.slice(3, 5), 16) + 0.114 * Number.parseInt(hex.slice(5, 7), 16);
  assert.ok(luma(night.plazaWalk) < luma(night.road), `夜景石材 ${luma(night.plazaWalk).toFixed(1)} 比路面 ${luma(night.road).toFixed(1)} 还亮`);
});

test('让位名单只交得出石材那两层', () => {
  const plaza = carvePlaza({ greens, water, blocks, streets });
  const rings = stoneRings(plaza);
  const stone = plaza.features.filter((feature) => feature.properties.kind === 'stone').length;
  const walk = plaza.features.filter((feature) => feature.properties.kind === 'walk').length;
  assert.equal(rings.length, stone + walk, '让位名单的数量与石材两层对不上');
  assert.ok(rings.every((ring) => ring.length > 3 && ring[0][0] === ring.at(-1)[0]), '让位名单里有不闭合的环');
  assert.equal(stoneRings(null).length, 0, '没有广场时名单该是空的');
});

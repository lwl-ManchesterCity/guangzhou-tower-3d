import { destination, plane } from './geo.js';
import { insideRing } from './buildings.js';

// 花城广场在画面里是一整张绿皮，"粗糙"就糙在它没有中轴。OSM 其实把那条轴画下来了：广场面（way/243319596，25 万 m²）
// 之内有 4 块 `area:highway=pedestrian` 的硬质面（1,123～2,390 m²，沿经线一颗一颗排过去）、3 条 `highway=pedestrian`
// 线、1 段台阶、20 块草地（2.2 万 m²）与一块水面（0.9 万 m²）。这一格只画这些**实测有的东西**——不把 84% 的公园面
// 改判成石材，那是替 OSM 说它不是公园，也会把 V5-5 定下来的"这条轴要读成绿轴"推翻。
export const PLAZA_OSM_ID = 243319596;
export const PLAZA_SOURCE = 'canton-plaza';
export const PLAZA_LAWN = 'plaza-lawn';
export const PLAZA_POOL = 'plaza-pool';
export const PLAZA_STONE = 'plaza-stone';
export const PLAZA_WALK = 'plaza-walk';

// 一条步行街多宽。OSM 在这里没有给任何一条 `width`，所以这两个数是画的，卡片与 README 要点名。
export const WALK_WIDTH_METRES = 6;
export const STEPS_WIDTH_METRES = 4;
// 斜接伸出多长：转角越尖，把两边法线平均出来的那根 miter 越长，超过三倍就改成平接，否则会在内角顶出一个尖刺。
export const MITER_LIMIT = 3;

const openRing = (ring) => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
  ? ring.slice(0, -1)
  : ring);

/** 一个环的代表点：顶点平均。OSM 这些面都凸得差不多，够用来判"在不在这块广场里"。 */
export function ringCentre(ring) {
  const points = openRing(ring);
  return [points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length];
}

const node = (point) => ({ lng: point[0], lat: point[1] });
const bearingOf = (from, to) => {
  const { dx, dy } = plane(node(from), node(to));
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
};
/** 沿罗盘方位角走出去若干米，回来的还是 GeoJSON 那个 [lng, lat]。 */
const offset = (point, metres, bearing) => {
  const { lng, lat } = destination(node(point), metres, bearing);
  return [lng, lat];
};

/**
 * 把一条折线扫成一条等宽的带：每个顶点沿它的中角法线偏出半宽，右侧反向走回去封口。
 *
 * 偏移用 `destination`（球面），所以不需要一份 `plane()` 的反函数；转角处按 miter 拉长，超过 `MITER_LIMIT` 倍半宽
 * 就退回半宽（等于平接），这挡住的是急转弯上那根会自己戳出去的尖刺。
 */
export function stripRing(line, width) {
  const points = line.filter((point, index) => !index || point[0] !== line[index - 1][0] || point[1] !== line[index - 1][1]);
  if (points.length < 2 || !(width > 0)) return null;
  const half = width / 2;
  const left = [];
  const right = [];
  for (let index = 0; index < points.length; index += 1) {
    const before = index > 0 ? bearingOf(points[index - 1], points[index]) : null;
    const after = index < points.length - 1 ? bearingOf(points[index], points[index + 1]) : null;
    // 端点没有转角，法线就是那一段的垂线；中间的顶点用两段法线的角平分线。
    const turn = before === null || after === null ? 0 : ((after - before + 540) % 360) - 180;
    const face = (before ?? after) - 90 + turn / 2;
    // 半宽除以 cos(半转角) 就是斜接长度；转角为 0 时它正好等于半宽。
    const reach = Math.min(half * MITER_LIMIT, half / Math.max(0.3, Math.cos((turn / 2) * Math.PI / 180)));
    left.push(offset(points[index], reach, face));
    right.push(offset(points[index], reach, face + 180));
  }
  const ring = [...left, ...right.reverse()];
  ring.push([...ring[0]]);
  return ring;
}

const kindOf = (feature) => feature.properties?.kind;
const classOf = (feature) => feature.properties?.class;
const linesOf = (feature) => (feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
  : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : []);
const ringsOf = (feature) => (feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
  : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : []);

/**
 * 把广场那一格拆成四层：草坪、水面、硬质面、扫出来的步行带。
 *
 * 每一块都带着它自己那条 OSM way 的 id，所以"这一片为什么是石头"永远答得出；扫出来的带只带它那条线的 id 与一个
 * `swept` 标记，因为宽度是画的。
 */
export function carvePlaza({ greens = [], water = [], blocks = [], streets = [], parkId = PLAZA_OSM_ID } = {}) {
  const park = greens.find((feature) => feature.properties?.osmId === parkId);
  const outer = ringsOf(park ?? { geometry: { type: 'Polygon', coordinates: [] } })[0]?.[0];
  if (!outer || outer.length < 4) return { features: [], ring: null, report: { lawn: 0, pool: 0, stone: 0, walk: 0, missing: true } };
  const inPlaza = (feature) => ringsOf(feature).some((rings) => {
    const [lng, lat] = ringCentre(rings[0]);
    return insideRing(outer, lng, lat);
  });
  const keep = (feature, kind) => ringsOf(feature).map((rings) => ({
    type: 'Feature',
    properties: { kind, osmId: feature.properties.osmId, area: feature.properties.area ?? null },
    geometry: { type: 'Polygon', coordinates: rings },
  }));
  const lawn = greens.filter((feature) => kindOf(feature) === 'grass' && inPlaza(feature)).flatMap((feature) => keep(feature, 'lawn'));
  const pool = water.filter((feature) => kindOf(feature) === 'water' && inPlaza(feature)).flatMap((feature) => keep(feature, 'pool'));
  const stone = blocks.filter((feature) => kindOf(feature) === 'pedestrian' && inPlaza(feature)).flatMap((feature) => keep(feature, 'stone'));
  const walk = [];
  for (const feature of streets) {
    const highway = classOf(feature);
    const width = highway === 'pedestrian' ? WALK_WIDTH_METRES : highway === 'steps' ? STEPS_WIDTH_METRES : 0;
    if (!width) continue;
    for (const line of linesOf(feature)) {
      // 只扫"绝大多数顶点在广场里"的那几条：一条从外面进来的路不该在广场上突然变成石板。
      const inside = line.filter((point) => insideRing(outer, point[0], point[1])).length;
      if (inside < Math.max(1, Math.ceil(line.length * 0.6))) continue;
      const ring = stripRing(line, width);
      if (!ring) continue;
      walk.push({
        type: 'Feature',
        properties: { kind: 'walk', osmId: feature.properties.osmId, swept: width, area: null },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }
  return {
    features: [...lawn, ...pool, ...stone, ...walk],
    // 外轮廓一起带出去：地面那张不重复的贴图要按这一圈的包围盒定自己的米数原点（`plaza-surface.js`）。
    ring: outer,
    report: { lawn: lawn.length, pool: pool.length, stone: stone.length, walk: walk.length, missing: false },
  };
}

/**
 * 广场那四层，按当前氛围上色。
 *
 * 顺序就是层序：草坪与水面盖住底图的 park 绿，石材再盖在它们之上——OSM 这些面彼此重叠是常态（一块硬质广场面
 * 整个落在公园面里），谁在上谁就说得上话。
 */
export function plazaLayers(theme) {
  const fill = (id, kind, colour, opacity) => ({
    // `==`/`get` 上的字符串标签是安全的：布尔标签在 `match` 里会静默丢层，同一件事在桥上踩过一次。
    id, type: 'fill', source: PLAZA_SOURCE, filter: ['==', ['get', 'kind'], kind],
    paint: { 'fill-color': colour, 'fill-opacity': opacity, 'fill-antialias': false },
  });
  return [
    fill(PLAZA_LAWN, 'lawn', theme.grass, 0.92),
    fill(PLAZA_POOL, 'pool', theme.water, 1),
    fill(PLAZA_STONE, 'stone', theme.plaza, 0.95),
    fill(PLAZA_WALK, 'walk', theme.plazaWalk, 0.95),
  ];
}

/** 石材面（含扫出来的带）：给植被用——一棵树站在石板中轴上是错的。 */
export function stoneRings(plaza) {
  return (plaza?.features ?? []).filter((feature) => feature.properties.kind === 'stone' || feature.properties.kind === 'walk')
    .flatMap((feature) => ringsOf(feature).map((rings) => rings[0]));
}

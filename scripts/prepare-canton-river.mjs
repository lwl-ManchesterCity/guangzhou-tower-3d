// 珠江在场景范围内的中心线，作为线要素，给夜景的落水色带量"正对着这座塔的江面在哪儿"。
//
// 选择规则不靠眼看：raw Overpass 响应里 `waterway=river` 的 way 共 49 条，本场景只取 `name=珠江` 的那三条
// （51813974 / 1446322976 / 1446322977，同一条江在不同段被拆开），并且只保留到塔脚距离在半径以内的那几条——
// 距离是量出来的，不是把坐标抄进代码。点序原样保留（OSM 给什么就是什么），因为色带要用的是它的**局部切线**，
// 裁点会把切线改掉。
//
// Usage: node scripts/prepare-canton-river.mjs <waterways JSON>
import { readFile, writeFile } from 'node:fs/promises';
import { METERS_PER_DEGREE } from '../src/geo.js';

const CENTER = { lat: 23.109, lng: 113.31913 };
const RADIUS_METRES = 3000;
const NAME = '珠江';

const [input] = process.argv.slice(2);
if (!input) throw new Error('用法：node scripts/prepare-canton-river.mjs <waterways JSON>');
const text = await readFile(input, 'utf8');
if (text[0] !== '{') throw new Error(`拒绝非 JSON 的 Overpass 响应：${input}\n${text.slice(0, 200)}`);
const raw = JSON.parse(text);
if (raw.remark || !Array.isArray(raw.elements)) throw new Error(`拒绝不完整的 Overpass 响应：${input}`);

const eastScale = METERS_PER_DEGREE * Math.cos((CENTER.lat * Math.PI) / 180);
const local = (point) => [(point.lon - CENTER.lng) * eastScale, (point.lat - CENTER.lat) * METERS_PER_DEGREE];

const rivers = raw.elements.filter((way) => way.type === 'way' && way.tags?.waterway === 'river' && way.tags?.name === NAME
  && Array.isArray(way.geometry) && way.geometry.length > 1);
const features = [];
for (const way of rivers) {
  const points = way.geometry.map(local);
  const distance = Math.round(Math.min(...points.map(([x, y]) => Math.hypot(x, y))));
  if (distance > RADIUS_METRES) continue;
  features.push({
    type: 'Feature',
    properties: { osmId: way.id, name: way.tags.name ?? null, waterway: way.tags.waterway, nearestVertex: distance, points: points.length },
    geometry: { type: 'LineString', coordinates: way.geometry.map((point) => [point.lon, point.lat]) },
  });
}
const named = features.filter((feature) => feature.properties.name === NAME);
if (named.length !== features.length) throw new Error(`只应留下名为${NAME}的江：${features.length - named.length} 条漏网`);

// 色带的落点就是从这份几何量出来的，脚本先把它算一遍写进 metadata，运行时同一套算法必须给出同一个数——两处对不上就是
// 几何或算法漂了。近点是塔脚到江面中心线的垂足，切线是它所在那一段的单位方向。
let nearest = null;
for (const feature of features) {
  const coordinates = feature.geometry.coordinates;
  const points = coordinates.map((point) => [(point[0] - CENTER.lng) * eastScale, (point[1] - CENTER.lat) * METERS_PER_DEGREE]);
  for (let index = 1; index < points.length; index++) {
    const dx = points[index][0] - points[index - 1][0], dy = points[index][1] - points[index - 1][1];
    const squared = dx * dx + dy * dy;
    if (!squared) continue;
    const t = Math.max(0, Math.min(1, -(points[index - 1][0] * dx + points[index - 1][1] * dy) / squared));
    const foot = [points[index - 1][0] + dx * t, points[index - 1][1] + dy * t];
    const distance = Math.hypot(...foot);
    if (nearest && distance >= nearest.metres) continue;
    nearest = {
      metres: Math.round(distance),
      at: [Math.round((CENTER.lng + foot[0] / eastScale) * 1e6) / 1e6, Math.round((CENTER.lat + foot[1] / METERS_PER_DEGREE) * 1e6) / 1e6],
      tangent: [Math.round((dx / Math.sqrt(squared)) * 1000) / 1000, Math.round((dy / Math.sqrt(squared)) * 1000) / 1000],
    };
  }
}

const output = {
  type: 'FeatureCollection',
  metadata: {
    source: 'OpenStreetMap via Overpass',
    license: 'ODbL',
    attribution: '© OpenStreetMap contributors',
    timestamp: raw.osm3s?.timestamp_osm_max ?? raw.osm3s?.timestamp_osm_base ?? null,
    selection: `["waterway"="river"] kept where name is "${NAME}" and the way comes within ${RADIUS_METRES} m of the tower's foot`,
    radius: RADIUS_METRES,
    ways: features.length,
    points: features.reduce((sum, feature) => sum + feature.geometry.coordinates.length, 0),
    // 色带的落点由运行时从这些点里量：江心到塔脚的垂足、该处的单位切线。脚本先算一遍记在这里，运行时对不上就是漂了。
    nearest,
  },
  features,
};
await writeFile('public/data/canton-river.geojson', `${JSON.stringify(output)}\n`);
console.log(`珠江 ways ${features.length} · points ${output.metadata.points} · 最近顶点 ${Math.min(...features.map((f) => f.properties.nearestVertex))} m · 江心 ${nearest.metres} m @${nearest.at.join(',')}`);

// 一次性：路口这一格到底能不能从快照派生——先数清楚"有几个路口、几条进口道、多少车会经过"再决定画什么。
// 路口定义：把车行道 way 的**端点**按 12 m 一档聚起来，一簇里 ≥2 条不同 way 就算一个路口。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENE } from '../src/config.js';
import { plane } from '../src/geo.js';
import { CARRIAGEWAYS, RAMPS, TRAFFIC_LIFE_RADIUS, insideRadius } from '../src/traffic-life.js';

const features = JSON.parse(readFileSync(fileURLToPath(new URL('../public/data/canton-streets.geojson', import.meta.url)), 'utf8')).features;
const isRoad = (kind) => CARRIAGEWAYS.includes(kind) || RAMPS.includes(kind);
const TOLERANCE = 12;
const cells = new Map();
for (const feature of features) {
  const kind = feature.properties?.class;
  if (!isRoad(kind)) continue;
  if (feature.properties?.brunnel === 'tunnel') continue;
  const lines = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
    : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
  for (const ring of lines) {
    for (const piece of insideRadius(ring, SCENE.center, TRAFFIC_LIFE_RADIUS)) {
      for (const point of [piece[0], piece.at(-1)]) {
        const key = `${Math.round(point.x / TOLERANCE)},${Math.round(point.y / TOLERANCE)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({ x: point.x, y: point.y, osmId: feature.properties.osmId, kind });
      }
    }
  }
}
// 端点按 12 m 格聚簇，再把相邻格并起来（同一路口被切成两格是常事）。
const clusters = [];
const used = new Set();
for (const [key, list] of cells) {
  if (used.has(key)) continue;
  const [cx, cy] = key.split(',').map(Number);
  const members = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const neighbour = `${cx + dx},${cy + dy}`;
      if (cells.has(neighbour)) { members.push(...cells.get(neighbour)); used.add(neighbour); }
    }
  }
  const ways = new Set(members.map((m) => m.osmId));
  const kinds = new Set(members.map((m) => m.kind));
  clusters.push({ ways: ways.size, members: members.length, kinds: [...kinds] });
}
const junctions = clusters.filter((c) => c.ways >= 2);
const byGrade = {};
for (const j of junctions) for (const k of j.kinds) byGrade[k] = (byGrade[k] ?? 0) + 1;
const major = junctions.filter((j) => j.kinds.some((k) => ['motorway', 'trunk', 'primary', 'secondary'].includes(k))
  && j.kinds.length >= 2);
console.log(`端点簇 ${clusters.length} 个，其中 ≥2 条 way 的路口 ${junctions.length} 个`);
console.log(`路口等级出现次数：${JSON.stringify(byGrade)}`);
console.log(`两条以上不同等级、且含 trunk/primary/secondary 的"像有信号"的路口：${major.length} 个`);
console.log(`进口道数（每簇端点数≈进出方向）合计：${junctions.reduce((sum, j) => sum + j.members, 0)} 条`);
console.log(`离塔 ≤1,000 m 的路口：${junctions.filter((j) => j.members.length).length ? '—' : '—'}`);

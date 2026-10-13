import { readFileSync } from 'node:fs';
import { plane, distanceMeters } from '../src/geo.js';
import { PLAZA_OSM_ID } from '../src/plaza.js';
import { SCENE } from '../src/config.js';

// 花城广场要按米数画，先量清楚"广场这块面里到底有什么、每样多大"，再定贴图一个像素多少米。
const files = ['canton-greens', 'canton-streets', 'canton-blocks', 'canton-water', 'canton-buildings', 'canton-bridges'];
const load = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'));
const origin = SCENE.center;
const open = (ring) => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring);
const toXY = (ring) => open(ring).map(([lng, lat]) => plane({ lng, lat }, origin));
const areaOf = (ring) => {
  const p = toXY(ring);
  let sum = 0;
  for (let i = 0; i < p.length; i += 1) { const a = p[i]; const b = p[(i + 1) % p.length]; sum += a.dx * b.dy - b.dx * a.dy; }
  return Math.abs(sum / 2);
};
const lengthOf = (ring) => {
  const p = toXY(ring);
  let sum = 0;
  for (let i = 0; i < p.length; i += 1) { const a = p[i]; const b = p[(i + 1) % p.length]; sum += Math.hypot(b.dx - a.dx, b.dy - a.dy); }
  return sum;
};
const bbox = (ring) => {
  const p = toXY(ring);
  const xs = p.map((q) => q.dx);
  const ys = p.map((q) => q.dy);
  return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys) };
};
const inside = (ring, point) => {
  const poly = open(ring);
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const centroid = (ring) => {
  const p = open(ring);
  return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
};

let plaza = null;
const found = [];
for (const file of files) {
  for (const feature of load(file).features) {
    const id = feature.properties.osmId;
    if (id === PLAZA_OSM_ID || (feature.properties.name || '').includes('花城广场')) {
      found.push({ file, id, name: feature.properties.name, type: feature.geometry.type, tags: Object.entries(feature.properties).filter(([k, v]) => v !== undefined && v !== null && v !== '' && !['osmId', 'name', 'distance'].includes(k)).map(([k, v]) => `${k}=${v}`).join(',') });
      if (id === PLAZA_OSM_ID && feature.geometry.type === 'Polygon') plaza = feature.geometry.coordinates[0];
    }
  }
}
if (!plaza) { console.log('没找到广场面，先退出'); process.exit(1); }
const box = bbox(plaza);
console.log('广场面', PLAZA_OSM_ID, '面积', Math.round(areaOf(plaza)).toLocaleString(), 'm²  点数', plaza.length,
  '  包围盒 南北', Math.round(box.north - box.south), 'm × 东西', Math.round(box.east - box.west), 'm',
  '  周圈', Math.round(lengthOf(plaza)).toLocaleString(), 'm');
console.log('\n命中的要素：');
for (const f of found) console.log(' ', f.file, f.id, f.type, f.name, '|', f.tags);

const groups = new Map();
for (const file of files) {
  for (const feature of load(file).features) {
    if (feature.properties.osmId === PLAZA_OSM_ID) continue;
    const g = feature.geometry;
    if (!g) continue;
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((c) => c[0]) : [];
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const points = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [];
    const inPlaza = (rings.length && inside(plaza, centroid(rings[0]))) || (lines.length && inside(plaza, lines[0][Math.floor(lines[0].length / 2)]))
      || (points.length && inside(plaza, points[0]));
    if (!inPlaza) continue;
    const kind = [...rings.map((r) => ['面', Math.round(areaOf(r)), '']), ...lines.map((l) => ['线', 0, Math.round(lengthOf([...l, l[0]]))]), ...points.map(() => ['点', 0, 0])][0];
    const key = [file, ...Object.entries(feature.properties).filter(([k]) => ['highway', 'area:highway', 'leisure', 'landuse', 'natural', 'amenity', 'barrier', 'man_made', 'surface', 'footway', 'covered', 'material', 'bridge', 'steps', 'water'].includes(k)).map(([k, v]) => `${k}=${v}`)].join('|');
    const entry = groups.get(key) || { key, count: 0, area: 0, length: 0, sizes: [] };
    entry.count += 1;
    entry.area += kind[1];
    entry.length += kind[2] || 0;
    if (kind[0] === '面') {
      const b = bbox(rings[0]);
      entry.sizes.push([Math.round(b.east - b.west), Math.round(b.north - b.south)]);
    }
    groups.set(key, entry);
  }
}
console.log('\n广场面之内的要素（按标签分组）：');
for (const e of [...groups.values()].sort((a, b) => b.area - b.area || b.length - a.length)) {
  const smallest = e.sizes.length ? e.sizes.map(([w, h]) => Math.min(w, h)).sort((a, b) => a - b)[0] : null;
  console.log(` ${e.count}×  ${e.key}  面积 ${Math.round(e.area).toLocaleString()} m²  长 ${Math.round(e.length).toLocaleString()} m  最窄一圈 ${smallest ?? '—'} m`);
}

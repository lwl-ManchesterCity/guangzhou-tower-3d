// 海心桥's deck outline, as one closed OSM way. The bridge is not a building, so it is not in the building snapshot;
// this pulls the single element the tour and the landmark label already point at, and writes the outline out so the
// deck can be stood on its own measured plan instead of being marked with a dot.
//
// Usage: node scripts/prepare-haixin-bridge.mjs <Overpass JSON 路径>
// The query that produced it, for the record:
//   [out:json]; way(id:1313608038); out geom tags;
import { readFile, writeFile } from 'node:fs/promises';
import { OVERPASS_ENDPOINTS } from '../src/config.js';

const BRIDGE_OSM_ID = 1313608038;

if (!process.argv[2]) throw new Error('用法：node scripts/prepare-haixin-bridge.mjs <Overpass JSON 路径>');
const raw = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (raw.remark || !Array.isArray(raw.elements)) throw new Error('拒绝不完整的 Overpass 响应');
const way = raw.elements.find((element) => element.type === 'way' && element.id === BRIDGE_OSM_ID);
if (!way) throw new Error(`响应里没有 way/${BRIDGE_OSM_ID} 海心桥，拒绝生成快照。`);
if (!Array.isArray(way.geometry) || way.geometry.length < 4) throw new Error('桥体轮廓点数不足以构成一个闭合面');
const first = way.geometry[0];
const last = way.geometry.at(-1);
if (first.lat !== last.lat || first.lon !== last.lon) throw new Error('海心桥的 OSM 轮廓不是闭合 way，无法作为桥面外轮廓使用');

const coordinates = way.geometry.map((point) => [point.lon, point.lat]);
const feature = {
  type: 'Feature',
  properties: {
    osmId: way.id,
    name: way.tags?.name ?? '海心桥',
    structure: way.tags?.['bridge:structure'] ?? null,
    layer: Number.isFinite(Number(way.tags?.layer)) ? Number(way.tags.layer) : null,
    manMade: way.tags?.man_made ?? null,
    wikidata: way.tags?.wikidata ?? null,
  },
  geometry: { type: 'Polygon', coordinates: [coordinates] },
};

const output = {
  type: 'FeatureCollection',
  features: [feature],
  metadata: {
    source: OVERPASS_ENDPOINTS[0],
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    timestamp: raw.osm3s?.timestamp_osm_base ?? null,
    selection: `way/${BRIDGE_OSM_ID}; closed way only, taken from the live OSM database`,
    points: coordinates.length,
  },
};

await writeFile(new URL('../public/data/haixin-bridge.geojson', import.meta.url), `${JSON.stringify(output)}\n`);
console.log(JSON.stringify({ ...output.metadata, name: feature.properties.name, structure: feature.properties.structure }));

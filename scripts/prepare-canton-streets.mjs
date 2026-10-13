// The street and footway network within one kilometre of the tower, as OSM draws it. The near-field traffic lives on
// these lines, so every car and walker can be pointed back at a real way id - and so the lines are whole ways rather
// than the tile-clipped fragments `querySourceFeatures` hands back, which is what stops a light teleporting at a tile
// seam.
//
// Usage: node scripts/prepare-canton-streets.mjs <Overpass JSON 路径> [ ramps JSON 路径 ]
// The two queries that produced them, for the record (the ramps go in a second request because one query asking for
// both timed out on the endpoint):
//   [out:json][timeout:90];
//   way(around:1000,23.109,113.31913)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|
//     living_street|service|pedestrian|path|footway|steps|track)$"];
//   out geom tags;
//   [out:json][timeout:60]; way(around:1000,23.109,113.31913)["highway"~"_link$"]; out geom tags;
import { readFile, writeFile } from 'node:fs/promises';
import { OVERPASS_ENDPOINTS } from '../src/config.js';

const RADIUS_METRES = 2200;
// Carriageways the cars run on, the ramps that feed them, and the footways the walkers use. The class names are the raw
// OSM `highway` values: this snapshot is its own source, so nothing is renamed to match the basemap's rendering classes.
const CARRIAGEWAYS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
const RAMPS = CARRIAGEWAYS.map((class_) => `${class_}_link`);
const FOOTWAYS = ['path', 'pedestrian', 'steps', 'track', 'footway'];
const KNOWN = [...CARRIAGEWAYS, ...RAMPS, ...FOOTWAYS];

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error('用法：node scripts/prepare-canton-streets.mjs <Overpass JSON 路径> [ ramps JSON 路径 ]');
const elements = new Map();
let timestamp = null;
for (const input of inputs) {
  const raw = JSON.parse(await readFile(input, 'utf8'));
  if (raw.remark || !Array.isArray(raw.elements)) throw new Error(`拒绝不完整的 Overpass 响应：${input}`);
  timestamp ??= raw.osm3s?.timestamp_osm_base ?? null;
  for (const element of raw.elements) if (element.type === 'way' && !elements.has(element.id)) elements.set(element.id, element);
}

const yes = (value) => value === 'yes' || value === '1' || value === 'true';
const no = (value) => value === 'no' || value === '0' || value === 'false';

const features = [...elements.values()]
  .filter((way) => Array.isArray(way.geometry) && way.geometry.length > 1 && KNOWN.includes(way.tags?.highway))
  .map((way) => ({
    type: 'Feature',
    properties: {
      osmId: way.id,
      class: way.tags.highway,
      carriageway: CARRIAGEWAYS.includes(way.tags.highway) || RAMPS.includes(way.tags.highway),
      name: way.tags.name ?? null,
      // `oneway` is kept as a three-state: OSM silent about it is not the same record as OSM saying both ways. A ramp
      // one way is a ramp one way whether or not anybody tagged it.
      oneway: yes(way.tags.oneway) || way.tags.oneway === '-1' ? true : no(way.tags.oneway) ? false : RAMPS.includes(way.tags.highway) ? true : null,
      brunnel: yes(way.tags.tunnel) ? 'tunnel' : yes(way.tags.bridge) ? 'bridge' : yes(way.tags.ford) ? 'ford' : null,
      layer: Number.isFinite(Number(way.tags.layer)) ? Number(way.tags.layer) : null,
      // 花城广场的硬质步行带要画出来，靠的就是这两个标签：`surface` 说这条道是什么铺的，`footway` 说它是人行道、
      // 过街还是广场里的一条路径。没有它们，一条 footway 和一条穿过草坪的小径在数据上长得一样。
      surface: way.tags.surface ?? null,
      footway: way.tags.footway ?? null,
    },
    geometry: { type: 'LineString', coordinates: way.geometry.map((point) => [point.lon, point.lat]) },
  }));

const counts = {};
for (const feature of features) counts[feature.properties.class] = (counts[feature.properties.class] ?? 0) + 1;

const output = {
  type: 'FeatureCollection',
  features,
  metadata: {
    source: OVERPASS_ENDPOINTS[0],
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    timestamp,
    selection: `way(around:${RADIUS_METRES},23.109,113.31913)["highway"]; LineString only, whole ways as OSM digitised them; the radius is applied when the scene reads the file`,
    radius: RADIUS_METRES,
    classes: counts,
    points: features.reduce((total, feature) => total + feature.geometry.coordinates.length, 0),
  },
};

await writeFile(new URL('../public/data/canton-streets.geojson', import.meta.url), `${JSON.stringify(output)}\n`);
console.log(JSON.stringify({ ways: features.length, points: output.metadata.points, timestamp: output.metadata.timestamp, counts }));

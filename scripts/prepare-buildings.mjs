import { readFile, writeFile } from 'node:fs/promises';
import { normalizeBuildings, numericTag, searchIndex, towerFeature } from '../src/buildings.js';
import { DEFAULT_CENTER, RADIUS_METERS, OVERPASS_ENDPOINTS } from '../src/config.js';

if (!process.argv[2]) throw new Error('用法：node scripts/prepare-buildings.mjs <Overpass JSON 路径>');
const raw = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (raw.remark || !Array.isArray(raw.elements)) throw new Error('拒绝不完整的 Overpass 响应');
const data = normalizeBuildings(raw.elements);
// OSM names `building:levels` beside a `height` tag for some buildings. The shared derivation reports only the count it
// had to fall back on, so the count is attached here: a landmark shell's window grid is scaled by height ÷ levels, and
// that number has to come out of the snapshot rather than being a constant someone typed in.
const tagsOf = new Map(raw.elements.map((element) => [element.id, element.tags ?? {}]));
let storeys = 0;
for (const feature of data.features) {
  const levels = numericTag(tagsOf.get(feature.id)?.['building:levels']);
  if (levels > 0 && feature.properties.levels !== levels) {
    feature.properties.levels = levels;
    storeys += 1;
  }
}
data.metadata = { source: OVERPASS_ENDPOINTS[0], license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors', timestamp: raw.osm3s?.timestamp_osm_base, center: DEFAULT_CENTER, radiusMeters: RADIUS_METERS, selection: 'way[building] + way[building:part]; closed ways only, no relations', labels: 'name, name:en, building, amenity/shop/office/tourism/leisure/historic, addr:street, addr:housenumber, start_date, building:levels (kept beside a height tag too, as the storey pitch)', inputWays: raw.elements.length, buildings: data.features.length, named: data.features.filter((f) => f.properties.name).length, storeys: data.features.filter((f) => f.properties.levels > 0).length };
const tower = towerFeature(raw.elements);
if (!tower) throw new Error(`原始响应缺少广州塔轮廓 way/584204634，无法生成命中面。`);
const index = searchIndex([...data.features, tower]);
await writeFile(new URL('../public/data/canton-buildings.geojson', import.meta.url), JSON.stringify(data));
await writeFile(new URL('../public/data/canton-buildings-index.json', import.meta.url), JSON.stringify(index));
await writeFile(new URL('../public/data/canton-tower.geojson', import.meta.url), JSON.stringify({ type: 'FeatureCollection', features: [tower], metadata: data.metadata }));
console.log(JSON.stringify({ ...data.metadata, searchable: index.entries.length }));

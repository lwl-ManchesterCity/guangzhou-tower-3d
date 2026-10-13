import { readFile, writeFile } from 'node:fs/promises';
import { blockRoads } from '../src/block-layout.js';

const raw = JSON.parse(await readFile(new URL('../data/jingtai-overpass.json', import.meta.url), 'utf8'));
const roads = blockRoads(raw);
roads.source = { dataset: 'OpenStreetMap', license: 'ODbL', input: 'data/jingtai-overpass.json', purpose: '地面道路隔断示意；不代表完整路网或实测路宽' };
await writeFile(new URL('../public/data/jingtai-roads.geojson', import.meta.url), `${JSON.stringify(roads)}\n`);
console.log(`Prepared ${roads.features.length} ground-level road ways from the local OSM snapshot.`);

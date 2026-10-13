import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { OVERPASS_ENDPOINTS } from '../src/config.js';
import { SCENES } from '../src/scenes.js';

const root = new URL('../', import.meta.url);
// --raw-dir keeps a re-fetch away from the shipped snapshot: candidate runs write raw + source + artifacts side by side.
const arg = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const rawDir = `${(arg('--raw-dir') ?? 'data').replace(/\/$/, '')}/`;
const rawPath = new URL(`${rawDir}jingtai-overpass.json`, root);
const sourcePath = new URL(`${rawDir}jingtai-source.json`, root);
const { center, radius, campusId } = SCENES.jingtai;
const around = `(around:${radius},${center.lat},${center.lng})`;
export const query = `[out:json][timeout:180][maxsize:268435456];
(
 nwr${around}[building]; nwr${around}["building:part"];
 way(${campusId});
 nwr${around}[leisure~"^(pitch|track|park|garden|nature_reserve)$"];
 nwr${around}[natural=wood]; nwr${around}[landuse=forest];
 nwr${around}[amenity~"^(school|kindergarten|college|university|restaurant|cafe|fast_food|bar|pub|food_court|ice_cream)$"];
 nwr${around}[railway~"^(station|subway_entrance)$"];
 nwr${around}[public_transport=station][subway=yes];
 nwr${around}[shop];
)->.places;
way(around:2500,${center.lat},${center.lng})[highway]->.roads;
(.places;.roads;node(w.roads);node(w.places););
out body geom;`;
// Overpass geometry modes are exclusive: `geom center` silently loses geometry.
// Keep complete geom plus way node IDs; representative centers are computed locally.

if (process.argv.includes('--fetch')) {
  for (const [index, endpoint] of OVERPASS_ENDPOINTS.entries()) {
    try {
      console.log(`Fetching one complete Overpass snapshot from ${endpoint}`);
      const response = await fetch(endpoint, {
        method: 'POST', body: new URLSearchParams({ data: query }),
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(210000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const raw = JSON.parse(text);
      if (!Array.isArray(raw.elements) || raw.remark) throw new Error(raw.remark || 'Missing elements');
      const campus = raw.elements.find((element) => element.type === 'way' && element.id === campusId);
      if (!campus?.geometry || !raw.elements.some((element) => element.tags?.highway && element.geometry?.length === element.nodes?.length)) throw new Error('Missing campus or full road geometry');
      await writeFile(rawPath, text);
      await writeFile(sourcePath, `${JSON.stringify({ endpoint, fetchedAt: new Date().toISOString(), query, sha256: createHash('sha256').update(text).digest('hex'), center, radiusMeters: radius, walkingRadiusMeters: 2500, osmTimestamp: raw.osm3s?.timestamp_osm_base, attribution: '© OpenStreetMap contributors · ODbL', nameAddressSource: '用户核验附件 sonus-handoff-3d-neighborhood-v3.md；景泰校区，云龙路38号。半径遵循最新用户要求2km。' }, null, 2)}\n`);
      console.log(`Saved ${raw.elements.length} unmodified OSM elements to ${fileURLToPath(rawPath)}`);
      break;
    } catch (error) {
      console.error(`${endpoint}: ${error.message}`);
      if (index === OVERPASS_ENDPOINTS.length - 1 || error.message === 'HTTP 429') throw error;
    }
  }
}

if (!process.argv.includes('--fetch-only')) {
  const { prepareJingtai } = await import('../src/jingtai-data.js');
  const rawText = await readFile(rawPath, 'utf8');
  const source = JSON.parse(await readFile(sourcePath, 'utf8'));
  if (source.sha256 !== createHash('sha256').update(rawText).digest('hex')) throw new Error('Raw snapshot checksum mismatch');
  const result = prepareJingtai(JSON.parse(rawText), source);
  // Candidate runs keep the served snapshot intact: point --out at a scratch directory and diff before promoting.
  const outDir = arg('--out') ?? 'public/data';
  for (const [filename, data] of Object.entries(result.files)) {
    await writeFile(new URL(`${outDir.replace(/\/$/, '')}/${filename}`, root), `${JSON.stringify(data)}\n`);
  }
  console.log(JSON.stringify({ writtenTo: outDir, ...result.report }, null, 2));
}

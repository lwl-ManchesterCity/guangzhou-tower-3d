// Snapshot of Amap 住宅小区 points for the 2 km school scene, written to data/ so it never reaches dist/.
// The key is read from .env.local and never printed.
import { readFile, writeFile } from 'node:fs/promises';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../src/coords.js';

const env = Object.fromEntries((await readFile(new URL('../.env.local', import.meta.url), 'utf8'))
  .split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const key = env.AMAP_KEY;
if (!key) throw new Error('AMAP_KEY missing from .env.local');

const CENTER = [113.26646, 23.17107];
const RADIUS = 2000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function search(params) {
  const url = new URL('https://restapi.amap.com/v3/place/around');
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('key', key);
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(650);
    const body = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json();
    if (body.status === '1') return body;
    if (body.infocode !== '10021') throw new Error(`${body.infocode} ${body.info}`);
    await sleep(700 * (attempt + 1));
  }
  throw new Error('Amap kept refusing on QPS; rerun later.');
}

// Thirteen 1 km circles: the centre, a ring at 1 km and a ring at 2 km, which together cover the 2 km scene.
const bearings = [[0, 0], ...[0, 60, 120, 180, 240, 300].map((d) => [d, 1000]),
  ...Array.from({ length: 12 }, (_, i) => [i * 30, 2000])];
const places = new Map();
let requests = 0;
for (const [bearing, distance] of bearings) {
  const rad = bearing * Math.PI / 180;
  const centre = [
    CENTER[0] + Math.sin(rad) * distance / (111320 * Math.cos(CENTER[1] * Math.PI / 180)),
    CENTER[1] + Math.cos(rad) * distance / 110540,
  ];
  const location = wgs84ToGcj02(centre).map((n) => n.toFixed(6)).join(',');
  for (let page = 1; page <= 12; page++) {
    const body = await search({ location, radius: 1000, types: '120300', offset: 25, page, extensions: 'all', sortrule: 'distance' });
    requests++;
    for (const poi of body.pois || []) {
      if (places.has(poi.id)) continue;
      const [lng, lat] = poi.location.split(',').map(Number);
      places.set(poi.id, {
        id: poi.id,
        name: poi.name,
        type: poi.type,
        at: gcj02ToWgs84([lng, lat]).map((n) => Number(n.toFixed(6))),
      });
    }
    if (page * 25 >= Number(body.count)) break;
    if (page === 12) console.log(`truncated at 12 pages around ${location} (count ${body.count})`);
  }
}

const meters = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 110540);
const inside = [...places.values()]
  .filter((place) => meters(CENTER, place.at) <= RADIUS)
  .sort((a, b) => a.id.localeCompare(b.id));

const snapshot = {
  type: 'amap-place-snapshot',
  source: '高德开放平台 Web 服务 地点搜索（types=120300 住宅区）',
  fetchedAt: new Date().toISOString(),
  license: '高德数据条款限制：仅本机开发预览，文件放在 data/ 而非 public/data/，因此不随 vite build 分发。对外发布前需确认许可或改为运行时查询。',
  center: { lat: CENTER[1], lng: CENTER[0] },
  radiusMeters: RADIUS,
  coordinateSystem: 'WGS-84（由高德 GCJ-02 逐点转换）',
  places: inside,
};
const path = new URL('../data/jingtai-amap-names.json', import.meta.url);
await writeFile(path, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`requests ${requests}, fetched ${places.size}, within ${RADIUS} m ${inside.length} -> ${path.pathname}`);

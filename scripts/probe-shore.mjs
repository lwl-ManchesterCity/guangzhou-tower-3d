// 一次性：找几个离塔最近的岸线点，给湿线取证定机位。
import { readFileSync } from 'node:fs';
import { SCENE } from '../src/config.js';
import { plane } from '../src/geo.js';

const water = JSON.parse(readFileSync(new URL('../public/data/canton-water.geojson', import.meta.url), 'utf8')).features;
const pts = water
  .flatMap((f) => (f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : []))
  .flatMap((polygon) => polygon.flatMap((ring) => ring.map(([lng, lat]) => {
    const m = plane(SCENE.center, { lng, lat });
    return { lng, lat, d: Math.hypot(m.dx, m.dy) };
  })));
pts.sort((a, b) => a.d - b.d);
for (const p of pts.slice(0, 10)) console.log(`${p.d.toFixed(0)} m  ${p.lat.toFixed(5)}/${p.lng.toFixed(5)}`);

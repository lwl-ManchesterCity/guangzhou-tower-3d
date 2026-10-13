// 一次性：挑几个"值得拍"的路口，反解成经纬度，给 `scripts/shot-signals.mjs` 钉机位用。
import { readFileSync } from 'node:fs';
import { DEFAULT_CENTER } from '../src/config.js';
import { plane } from '../src/geo.js';
import { TRAFFIC_LIFE_RADIUS, createTrafficLife } from '../src/traffic-life.js';
import { deriveJunctions } from '../src/junctions.js';

const streets = JSON.parse(readFileSync(new URL('../public/data/canton-streets.geojson', import.meta.url), 'utf8')).features;

function lngLatOf(x, y) {
  const solve = (measure, target) => {
    let low = -0.08;
    let high = 0.08;
    for (let i = 0; i < 70; i++) {
      const mid = (low + high) / 2;
      if (measure(mid) < target) low = mid; else high = mid;
    }
    return (low + high) / 2;
  };
  return {
    lng: DEFAULT_CENTER.lng + solve((delta) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng + delta, lat: DEFAULT_CENTER.lat }).dx, x),
    lat: DEFAULT_CENTER.lat + solve((delta) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng, lat: DEFAULT_CENTER.lat + delta }).dy, y),
  };
}

const junctions = deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS });
createTrafficLife({ features: streets, origin: DEFAULT_CENTER, junctions });
const scored = junctions.map((junction) => ({
  junction,
  poles: junction.approaches.filter((a) => a.lit && a.stop).length,
  distance: Math.hypot(junction.x, junction.y),
})).filter((row) => row.poles >= 3).sort((a, b) => a.distance - b.distance);
console.log(`装到 3 根杆以上的路口 ${scored.length} 个，最近的一批：`);
for (const row of scored.slice(0, 8)) {
  const { lng, lat } = lngLatOf(row.junction.x, row.junction.y);
  console.log(`  ${row.distance.toFixed(0)} m｜${row.poles} 根杆｜${lng.toFixed(5)}/${lat.toFixed(5)}`);
}
const nearest = junctions.reduce((a, b) => (Math.hypot(b.x, b.y) < Math.hypot(a.x, a.y) ? b : a));
console.log('离塔最近的路口', Math.hypot(nearest.x, nearest.y).toFixed(0), 'm，杆数',
  nearest.approaches.filter((a) => a.lit && a.stop).length, JSON.stringify(lngLatOf(nearest.x, nearest.y)));

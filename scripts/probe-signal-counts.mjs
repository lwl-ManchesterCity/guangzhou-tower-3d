import { readFileSync } from 'node:fs';
import { DEFAULT_CENTER } from '../src/config.js';
import { TRAFFIC_LIFE_RADIUS, deckHeights, createTrafficLife } from '../src/traffic-life.js';
import { deriveJunctions, assignSignals, signalLost } from '../src/junctions.js';
import { createNearField } from '../src/near-field.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8')).features;
const streets = read('canton-streets.geojson');
const origin = DEFAULT_CENTER;

const junctions = deriveJunctions({ features: streets, origin, radius: TRAFFIC_LIFE_RADIUS });
const approaches = junctions.reduce((sum, j) => sum + j.approaches.filter((a) => a.lit).length, 0);
const ways = junctions.reduce((sum, j) => sum + new Set(j.approaches.map((a) => a.osmId)).size, 0);
const dist = junctions.map((j) => Math.hypot(j.x, j.y)).sort((a, b) => a - b);
console.log(`路口 ${junctions.length} 个，进口道（lit）合计 ${approaches} 条，涉及 way ${ways} 条`);
console.log(`路口离塔最近 ${Math.round(dist[0])} m，中位 ${Math.round(dist[dist.length >> 1])} m，最远 ${Math.round(dist.at(-1))} m`);

const traffic = createTrafficLife({ features: streets, origin, junctions: deriveJunctions({ features: streets, origin, radius: TRAFFIC_LIFE_RADIUS }) });
const seen = traffic.parts();
console.log('cars', traffic.counts.cars, 'approaches', seen.vehicles.approaches, 'signals', JSON.stringify(seen.signals));
console.log('report', JSON.stringify(traffic.signals));

const near = createNearField({ streets, origin });
console.log('near.signals', JSON.stringify(near.signals));
console.log('near.readout().signal', JSON.stringify(near.readout().signal));
console.log('children', near.groups[0].children.map((c) => c.name).join(', '));

// 有多少辆车真的被灯管住（signal 非空）
const junctions2 = deriveJunctions({ features: streets, origin, radius: TRAFFIC_LIFE_RADIUS });
const { cars } = (function () {
  const t = createTrafficLife({ features: streets, origin, junctions: junctions2 });
  return { cars: t.group.children.find((c) => c.name === 'traffic-cars').userData.agents };
})();
const pinned = cars.filter((a) => a.signal).length;
console.log('被灯管住的车', pinned, '/', cars.length);
const stops = junctions2.flatMap((j) => j.approaches.filter((a) => a.stop).length);
console.log('装了停止线的进口道', stops);
console.log('最大排队位次', Math.max(...cars.filter((a) => a.signal).map((a) => a.signal.rank)));
for (const at of [0, 12, 30, 48, 90, 300, 900]) {
  let held = 0;
  for (const agent of cars) {
    if (!agent.signal) continue;
    if (signalLost(agent.signal, at) > 0.001) held++;
  }
  console.log(`t=${at}s 有信号的车 ${cars.filter((a) => a.signal).length}，其中此刻白等的 ${held}`);
}

import { readFileSync } from 'node:fs';
import { DEFAULT_CENTER } from '../src/config.js';
import { TRAFFIC_LIFE_RADIUS, createTrafficLife } from '../src/traffic-life.js';
import { deriveJunctions, signalLost } from '../src/junctions.js';

const streets = JSON.parse(readFileSync(new URL('../public/data/canton-streets.geojson', import.meta.url), 'utf8')).features;
const junctions = deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS });
const both = (list) => list.some((a) => a.phase === 0) && list.some((a) => a.phase === 1);
const single = junctions.filter((j) => !both(j.approaches)).length;
const litSingle = junctions.filter((j) => !both(j.approaches.filter((a) => a.lit))).length;
console.log('路口', junctions.length, '｜单相位（全部进口道）', single, '｜单相位（只算装灯的）', litSingle);

const traffic = createTrafficLife({ features: streets, origin: DEFAULT_CENTER, junctions });
const held = traffic.group.children.find((c) => c.name === 'traffic-cars').userData.agents.filter((a) => a.signal);
for (const at of [60, 120, 200, 400]) {
  let pinned = 0;
  for (const a of held) {
    const lost = signalLost(a.signal, at);
    if (lost > 0 && Math.abs((at + 0.4 - signalLost(a.signal, at + 0.4)) - (at - lost)) < 1e-6) pinned++;
  }
  console.log(`t=${at}s 钉着 ${pinned} / 全场 ${traffic.counts.cars}（${((pinned / traffic.counts.cars) * 100).toFixed(0)}%）`);
}
const r3 = held.filter((a) => a.signal.rank >= 3);
console.log('rank≥3 的车', r3.length, '｜灯前米数（前 6 个）', r3.slice(0, 6).map((a) => (a.signal.pitch * a.speed).toFixed(1)).join(', '));
console.log('最大 rank', held.reduce((top, a) => Math.max(top, a.signal.rank), 0));
const queueOf = new Map();
for (const a of held) {
  const key = `${Math.round(a.signal.junction.seed)}:${a.signal.stop.toFixed(1)}`;
  queueOf.set(key, (queueOf.get(key) ?? 0) + 1);
}
console.log('队列数', queueOf.size, '最长一队', Math.max(...queueOf.values()), '辆');

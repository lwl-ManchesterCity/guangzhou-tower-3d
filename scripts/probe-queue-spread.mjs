import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DEFAULT_CENTER } from '../src/config.js';
import { TRAFFIC_LIFE_RADIUS, agentPosition, createTrafficLife } from '../src/traffic-life.js';
import { deriveJunctions, signalLost, SIGNAL_CYCLE_SECONDS } from '../src/junctions.js';
import { createSignalProps, LENS_COLOURS, LENS_DAY_SHARE } from '../src/signals.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8')).features;
const streets = read('canton-streets.geojson');
const origin = DEFAULT_CENTER;
const j = () => deriveJunctions({ features: streets, origin, radius: TRAFFIC_LIFE_RADIUS });

const traffic = createTrafficLife({ features: streets, origin, junctions: j() });
const cars = traffic.group.children.find((c) => c.name === 'traffic-cars').userData.agents;
const held = cars.filter((a) => a.signal);

// 1. 某一队：位次差是不是真的落成"排在灯前一列"。
const queues = new Map();
for (const agent of held) {
  const key = `${Math.round(agent.signal.junction.seed)}:${Math.round(agent.signal.approach.x * 100)}`;
  if (!queues.has(key)) queues.set(key, []);
  queues.get(key).push(agent);
}
const biggest = [...queues.values()].sort((a, b) => b.length - a.length)[0];
console.log('最大一队', biggest.length, '辆，位次', biggest.map((a) => a.signal.rank).sort((x, y) => x - y).join(','));
for (const at of [0, 60, 120, 200, 400]) {
  const spots = biggest.map((agent) => {
    const where = agentPosition(agent, at - signalLost(agent.signal, at));
    return { rank: agent.signal.rank, x: where.x, y: where.y, lost: signalLost(agent.signal, at) };
  });
  const frozen = spots.filter((s) => s.lost > 0);
  let min = Infinity; let max = 0;
  for (const a of frozen) for (const b of frozen) {
    if (a === b) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    min = Math.min(min, d); max = Math.max(max, d);
  }
  console.log(`t=${at}s 钉着的 ${frozen.length} 辆，两两最近 ${frozen.length > 1 ? min.toFixed(2) : '—'} m 最远 ${frozen.length > 1 ? max.toFixed(2) : '—'} m`);
}

// 2. 单调性扫描：车自己的钟只许往前走。
let back = 0; let jump = 0; let prev = null;
for (let s = 0; s <= 1200; s += 0.5) {
  let total = 0;
  for (const agent of held) total += signalLost(agent.signal, s);
  if (prev !== null) {
    if (total < prev - 1e-6) back++;
    if (total - prev > 0.5 * held.length * 1.0001) jump++;
  }
  prev = total;
}
console.log('累积 lost 随秒数回退的次数', back, '跳变超 1 秒/车的次数', jump);

// 3. 灯头颜色真写进缓冲了吗（判据要钉的字面数）。
const props = createSignalProps({ junctions: (() => { const x = j(); createTrafficLife({ features: streets, origin, junctions: x }); return x; })() });
const day = props.lensColours(3);
props.setLit(true);
const night = props.lensColours(3);
console.log('day', JSON.stringify(day), 'night', JSON.stringify(night));
console.log('green', JSON.stringify([...new THREE.Color(LENS_COLOURS.green)]), 'share', LENS_DAY_SHARE);
for (const at of [0, 10, 41, 44, 50, SIGNAL_CYCLE_SECONDS / 2]) {
  props.advance(at);
  console.log(`t=${at}s`, JSON.stringify(props.parts().states));
}
void THREE;

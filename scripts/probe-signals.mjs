// 一次性：路口接上之后到底有多少进口道有灯、多少车会停、一个周期里停的比例是多少。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCENE } from '../src/config.js';
import { deriveJunctions, signalLost, signalState, SIGNAL_CYCLE_SECONDS, assignSignals } from '../src/junctions.js';
import { TRAFFIC_LIFE_RADIUS, createTrafficLife, trafficAgents } from '../src/traffic-life.js';

const features = JSON.parse(readFileSync(fileURLToPath(new URL('../public/data/canton-streets.geojson', import.meta.url)), 'utf8')).features;
const junctions = deriveJunctions({ features, origin: SCENE.center, radius: TRAFFIC_LIFE_RADIUS });
const approaches = junctions.reduce((sum, j) => sum + j.approaches.filter((a) => a.lit).length, 0);
console.log(`路口 ${junctions.length} 个，装灯的进口道 ${approaches} 条`);
const { cars } = trafficAgents(features, SCENE.center, TRAFFIC_LIFE_RADIUS);
const groups = assignSignals(junctions, cars);
const withSignal = cars.filter((car) => car.signal).length;
console.log(`车 ${cars.length} 辆里 ${withSignal} 辆接上了灯，分成 ${groups} 个进口道队列`);
const ranks = cars.filter((car) => car.signal).reduce((max, car) => Math.max(max, car.signal.rank), 0);
console.log(`最长的一队 ${ranks + 1} 辆；离塔最近的一个灯路口在 ${Math.round(Math.hypot(junctions[0].x, junctions[0].y))} m`);
for (const second of [0, 12, 30, 45, 60, 78, 120, 300, 900]) {
  let pinned = 0;
  let lost = 0;
  for (const car of cars) {
    // "正在等"= 再过 50 ms 它的钟还没往前走；累计白等是另一回事（等过一次就永远 > 0）。
    if (signalLost(car.signal, second + 0.05) - signalLost(car.signal, second) > 0.04) pinned += 1;
    lost += signalLost(car.signal, second);
  }
  console.log(`  t=${second}s：${pinned} 辆正钉在停止线，累计白等 ${lost.toFixed(0)} 秒`);
}
const states = [0, 20, 41, 44, 60, 87, 90].map((t) => `${t}s 相位0=${signalState(junctions[0], 0, t)}/相位1=${signalState(junctions[0], 1, t)}`);
console.log(states.join('\n'));
const life = createTrafficLife({ features, origin: SCENE.center, junctions });
console.log('parts().vehicles =', JSON.stringify(life.parts().vehicles));

// 一次性：灯这一笔在装配期花掉多少毫秒（派生路口 / 接线 / 三层几何），以及关掉它的对照。
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CENTER } from '../src/config.js';
import { TRAFFIC_LIFE_RADIUS, createTrafficLife } from '../src/traffic-life.js';
import { deriveJunctions, assignSignals } from '../src/junctions.js';
import { createSignalProps } from '../src/signals.js';
import { createNearField } from '../src/near-field.js';

const streets = JSON.parse(readFileSync(new URL('../public/data/canton-streets.geojson', import.meta.url), 'utf8')).features;
const time = (label, run) => { const t = performance.now(); const out = run(); console.log(`${label}：${(performance.now() - t).toFixed(1)} ms`, out ?? ''); };
time('只装配车与人（不派生路口）', () => createTrafficLife({ features: streets, origin: DEFAULT_CENTER }).counts.cars);
let junctions = null;
time('deriveJunctions', () => { junctions = deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS }); return junctions.length; });
time('整套（派生 + 接线 + 三层几何）', () => createNearField({ streets, origin: DEFAULT_CENTER }).signals);
const { cars } = (() => ({ cars: createTrafficLife({ features: streets, origin: DEFAULT_CENTER }).group.children.find((c) => c.name === 'traffic-cars').userData.agents }))();
const fresh = () => deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS });
time('其中 assignSignals', () => assignSignals(fresh(), cars));
time('其中三层几何', () => { const j = fresh(); assignSignals(j, cars); return createSignalProps({ junctions: j }).report; });

import { DEFAULT_CENTER } from '../src/config.js';
import { plane } from '../src/geo.js';
import { trafficAgents } from '../src/traffic-life.js';
import { assignSignals, deriveJunctions } from '../src/junctions.js';

function pointAt(east, north) {
  const solve = (measure, target) => {
    let low = -0.06; let high = 0.06;
    for (let i = 0; i < 60; i++) {
      const mid = (low + high) / 2;
      if (measure(mid) < target) low = mid; else high = mid;
    }
    return (low + high) / 2;
  };
  return [
    DEFAULT_CENTER.lng + solve((d) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng + d, lat: DEFAULT_CENTER.lat }).dx, east),
    DEFAULT_CENTER.lat + solve((d) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng, lat: DEFAULT_CENTER.lat + d }).dy, north),
  ];
}
const way = (points, properties = {}) => ({
  type: 'Feature',
  properties: { osmId: 1, class: 'secondary', oneway: null, brunnel: null, ...properties },
  geometry: { type: 'LineString', coordinates: points.map(([e, n]) => pointAt(e, n)) },
});
const features = [
  way([[6, 0], [406, 0]], { osmId: 11 }),
  way([[-6, 0], [-406, 0]], { osmId: 12 }),
  way([[0, 6], [0, 406]], { osmId: 13 }),
  way([[0, -6], [0, -406]], { osmId: 14 }),
];
const R = 700;
const junctions = deriveJunctions({ features, origin: DEFAULT_CENTER, radius: R });
console.log('路口', junctions.length, '进口道', junctions[0].approaches.map((a) => `${a.osmId}@(${a.x.toFixed(0)},${a.y.toFixed(0)}) u=(${a.ux.toFixed(2)},${a.uy.toFixed(2)}) p${a.phase}`).join('\n        '));
const { cars } = trafficAgents(features, DEFAULT_CENTER, R);
console.log('车', cars.length, '两个流向的分布', cars.map((a) => a.sign).reduce((t, s) => ({ ...t, [s]: (t[s] ?? 0) + 1 }), {}));
const queues = assignSignals(junctions, cars);
const held = cars.filter((a) => a.signal);
console.log('管住', held.length, '队列', queues);
console.log('按 sign 分', held.map((a) => a.sign).reduce((t, s) => ({ ...t, [s]: (t[s] ?? 0) + 1 }), {}));
for (const agent of held.slice(0, 6)) {
  console.log(`osm ${agent.osmId} sign ${agent.sign} at ${agent.at.toFixed(0)}/${agent.line.length.toFixed(0)} → stop ${agent.signal.stop.toFixed(1)} reach ${agent.signal.reach.toFixed(1)} rank ${agent.signal.rank} approach ${agent.signal.approach.x.toFixed(0)},${agent.signal.approach.y.toFixed(0)}`);
}
const free = cars.filter((a) => !a.signal);
console.log('没管住的', free.length, free.slice(0, 4).map((a) => `${a.osmId}/sign${a.sign}/at${a.at.toFixed(0)}`).join(' '));

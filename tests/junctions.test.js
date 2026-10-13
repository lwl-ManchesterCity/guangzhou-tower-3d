import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CENTER } from '../src/config.js';
import { plane } from '../src/geo.js';
import {
  CAR_GAP, LANE_OFFSET, TRAFFIC_LIFE_RADIUS, agentPosition, createTrafficLife, trafficAgents,
} from '../src/traffic-life.js';
import {
  JUNCTION_MIN_WAYS, JUNCTION_TOLERANCE_METRES, SIGNAL_AMBER_SECONDS, SIGNAL_CYCLE_SECONDS,
  SIGNAL_GREEN_SECONDS, SIGNAL_HEADWAY_SECONDS, SIGNAL_QUEUE_PITCH_METRES,
  assignSignals, deriveJunctions, nextGreen, signalLost, signalState,
} from '../src/junctions.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8')).features;
const streets = read('canton-streets.geojson');

/** 离塔 `east`/`north` 米的点，按被测的 `plane` 反解成经纬度（正着算就成了"测试验自己的算术"）。 */
function pointAt(east, north) {
  const solve = (measure, target) => {
    let low = -0.06;
    let high = 0.06;
    for (let i = 0; i < 60; i++) {
      const mid = (low + high) / 2;
      if (measure(mid) < target) low = mid; else high = mid;
    }
    return (low + high) / 2;
  };
  return [
    DEFAULT_CENTER.lng + solve((delta) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng + delta, lat: DEFAULT_CENTER.lat }).dx, east),
    DEFAULT_CENTER.lat + solve((delta) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng, lat: DEFAULT_CENTER.lat + delta }).dy, north),
  ];
}
const way = (points, properties = {}) => ({
  type: 'Feature',
  properties: { osmId: 1, class: 'secondary', oneway: null, brunnel: null, ...properties },
  geometry: { type: 'LineString', coordinates: points.map(([east, north]) => pointAt(east, north)) },
});

/**
 * 一个十字路口：四条 stub 的端点都停在路口外 6 m（OSM 的 way 就是在路口断开的，端点不会正好落在中心）。
 * 半径给 700 m，是为了让这四条 stub 自己就是这一场的全部路网。
 */
const CROSS_RADIUS = 700;
const cross = (properties = {}) => [
  way([[6, 0], [406, 0]], { osmId: 11, ...properties }),
  way([[-6, 0], [-406, 0]], { osmId: 12, ...properties }),
  way([[0, 6], [0, 406]], { osmId: 13, ...properties }),
  way([[0, -6], [0, -406]], { osmId: 14, ...properties }),
];
/** 主路东西向 + 两条小区路：装灯的进口道只压在一个轴上。 */
const oneAxis = () => [
  way([[6, 0], [406, 0]], { osmId: 11 }),
  way([[-6, 0], [-406, 0]], { osmId: 12 }),
  way([[0, 6], [0, 406]], { osmId: 13, class: 'residential' }),
  way([[0, -6], [0, -406]], { osmId: 14, class: 'residential' }),
];

/** 一个完整周期里这一相位绿多少秒：与 `junction.offset` 无关（扫的就是一整圈）。 */
const greensOf = (junction, phase) => {
  let seconds = 0;
  for (let t = 0; t < SIGNAL_CYCLE_SECONDS; t += 0.5) if (signalState(junction, phase, t) === 'green') seconds += 0.5;
  return seconds;
};

const pinnedAt = (agents, seconds) => agents.filter((agent) => {
  const lost = signalLost(agent.signal, seconds);
  // 钉着的定义：再过 0.4 秒，车自己的钟一点没动。
  return lost > 0 && Math.abs((seconds + 0.4 - signalLost(agent.signal, seconds + 0.4)) - (seconds - lost)) < 1e-6;
});

test('路口是从 way 的断点派生的：四条 stub 交出一个十字、两个相位', () => {
  const junctions = deriveJunctions({ features: cross(), origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
  assert.equal(junctions.length, 1, `十字该派生出一个路口，实际 ${junctions.length} 个`);
  const [junction] = junctions;
  assert.ok(Math.hypot(junction.x, junction.y) < JUNCTION_TOLERANCE_METRES,
    `路口中心不在四条 stub 断点中间，偏了 ${Math.hypot(junction.x, junction.y)} m`);
  assert.equal(junction.approaches.length, 4, '四个断点就是四个进口道');
  assert.ok(junction.approaches.every((approach) => approach.lit), 'secondary 的进口道全被判成不装灯');
  assert.equal(junction.axes, 2, '东西加南北不该被算成一个轴的路口');
  // 东西向一个相位、南北向另一个：判据钉"分成两拨"，不钉"哪一拨"（转角来自 plane，符号不由这里定）。
  const phases = junction.approaches.map((approach) => approach.phase);
  assert.deepEqual([phases.filter((p) => p === 0).length, phases.filter((p) => p === 1).length], [2, 2],
    `十字的两个轴应是 2+2，实际 ${phases.join(',')}`);
  // 进口道的方向是"开进路口"那一边：从断点指向路口，而不是指向路的另一头。
  for (const approach of junction.approaches) {
    const into = { x: junction.x - approach.x, y: junction.y - approach.y };
    const share = into.x * approach.ux + into.y * approach.uy;
    assert.ok(share > 0, `进口道 ${approach.osmId} 的方向朝外（点积 ${share.toFixed(2)}）：车会倒着开进路口`);
  }
});

test('不成路口的都不装灯：同一条 way 的两端、只有小区路、隧道那一头', () => {
  // 一条 U 形的 way：两个断点相距 10 m，但它们是同一条路，不是两条路交出来的路口。
  const lone = [way([[200, 100], [200, 400], [210, 400], [210, 100]], { osmId: 21 })];
  assert.equal(deriveJunctions({ features: lone, origin: DEFAULT_CENTER, radius: CROSS_RADIUS }).length, 0,
    '同一条 way 的两个断点被算成了路口');
  // 四级都是 `residential`：现实里这种小路口是停车让行，不给灯。
  assert.equal(deriveJunctions({ features: cross({ class: 'residential' }), origin: DEFAULT_CENTER, radius: CROSS_RADIUS }).length, 0,
    '小区路交口也装了信号灯');
  // 只有一条主干进口道：另一头是小区路，现实里是主路让行标志而不是信号灯。
  const half = [cross()[0],
    way([[-6, 0], [-406, 0]], { osmId: 12, class: 'residential' }),
    way([[0, 6], [0, 406]], { osmId: 13, class: 'residential' }),
    way([[0, -6], [0, -406]], { osmId: 14, class: 'residential' })];
  assert.equal(deriveJunctions({ features: half, origin: DEFAULT_CENTER, radius: CROSS_RADIUS }).length, 0,
    '只有一条主干进口道也给了灯');
  // 隧道那一头不算：way 在江底断开，不是路面交口。
  const tunnel = cross();
  tunnel[0].properties.brunnel = 'tunnel';
  const left = deriveJunctions({ features: tunnel, origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
  assert.equal(left.length, 1);
  assert.equal(left[0].approaches.length, 3, '隧道那一头还留在进口道里');
  assert.equal(JUNCTION_MIN_WAYS, 2, '成路口至少要几条 way 这一格被改动了');
});

test('只有一个轴的路口不把主路按住半周期红灯：绿 80 而不是绿 40', () => {
  const junctions = deriveJunctions({ features: oneAxis(), origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
  assert.equal(junctions.length, 1, `一轴路口没派生出来（${junctions.length}）`);
  const [junction] = junctions;
  junction.offset = 0; // 全城错开的周期在这里归零，好按字面秒数对表。
  assert.equal(junction.axes, 1);
  const lit = junction.approaches.filter((approach) => approach.lit);
  assert.equal(lit.length, 2, '小区路那一头也被算成装灯的进口道');
  assert.equal(junction.solo, lit[0].phase, '长绿给的不是有车那一轴');
  assert.equal(signalState(junction, junction.solo, 60), 'green', '一轴路口的绿灯短于 60 秒');
  assert.equal(signalState(junction, junction.solo, 80), 'amber');
  assert.equal(signalState(junction, 1 - junction.solo, 60), 'red', '另一轴在主路绿灯期间也亮了');
  assert.deepEqual([greensOf(junction, junction.solo), greensOf(junction, 1 - junction.solo)], [80, 13],
    '一轴路口的绿灯分档变了：README 的示意口径要跟着改');
  // 两轴路口那一半不许跟着变：还是各 40 秒。
  const both = deriveJunctions({ features: cross(), origin: DEFAULT_CENTER, radius: CROSS_RADIUS })[0];
  both.offset = 0;
  assert.equal(signalState(both, 0, 39), 'green');
  assert.equal(signalState(both, 0, 41), 'amber');
  assert.deepEqual([greensOf(both, 0), greensOf(both, 1)], [40, 40]);
});

test('周期是绿 40 / 黄 3 / 另一轴绿 40，两轴绝不同时绿', () => {
  const junction = { offset: 0, seed: 1, axes: 2, approaches: [] };
  // 字面秒数钉着（不让 `SIGNAL_GREEN_SECONDS` 参与算期望值，否则改了常量两边一起跟着变）。
  assert.equal(signalState(junction, 0, 0), 'green');
  assert.equal(signalState(junction, 0, 20), 'green');
  assert.equal(signalState(junction, 0, 40), 'amber');
  assert.equal(signalState(junction, 0, 42), 'amber');
  assert.equal(signalState(junction, 0, 43), 'red');
  assert.equal(signalState(junction, 1, 46), 'green');
  assert.equal(signalState(junction, 1, 86), 'amber');
  assert.equal(signalState(junction, 1, 89), 'red');
  assert.equal(signalState(junction, 0, 96), 'green', '一个周期之后没回到绿：周期不闭合');

  const tally = { 0: {}, 1: {} };
  for (let t = 0; t < SIGNAL_CYCLE_SECONDS; t += 0.5) {
    const a = signalState(junction, 0, t);
    const b = signalState(junction, 1, t);
    assert.ok(!(a === 'green' && b === 'green'), `t=${t} 两轴同时绿：对头车会撞`);
    for (const [phase, state] of [[0, a], [1, b]]) tally[phase][state] = (tally[phase][state] ?? 0) + 0.5;
  }
  assert.deepEqual([tally[0].green, tally[0].amber, tally[1].green, tally[1].amber], [40, 3, 40, 3]);
  assert.deepEqual([SIGNAL_GREEN_SECONDS, SIGNAL_AMBER_SECONDS, SIGNAL_CYCLE_SECONDS], [40, 3, 96],
    '周期这三个数被改动了：README 与卡片上的示意口径要跟着改');
  // 43~46 是全红清空，89~96 是另一段清空。
  assert.equal(tally[0].red, 53);
});

test('绿灯开始那一秒之前不许放行，正在绿的时候报的就是此刻', () => {
  const junction = { offset: 0, seed: 1, axes: 2, approaches: [] };
  assert.equal(nextGreen(junction, 0, 10), 10, '正在绿却报了一个未来的时刻');
  assert.equal(nextGreen(junction, 0, 43), 96, '红灯期间的下一个绿灯不是周期开头');
  assert.equal(nextGreen(junction, 1, 0), 46, '另一轴的绿灯起点算错了');
  assert.equal(nextGreen(junction, 1, 47), 47);
});

test('红灯把车钉在自己的排队位次上：一列，而不是叠在停止线上的一摞', () => {
  const features = cross();
  const { cars } = trafficAgents(features, DEFAULT_CENTER, CROSS_RADIUS);
  const junctions = deriveJunctions({ features, origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
  assignSignals(junctions, cars);
  const held = cars.filter((agent) => agent.signal);
  assert.ok(cars.length > 8, `fixture 上的车太少（${cars.length} 辆），这一条验不出排队`);
  assert.ok(held.length >= 4, `只有一条 stub 接上了灯（${held.length} 辆）`);
  for (const agent of held) {
    const { signal } = agent;
    assert.ok(signal.reach > 0, '到停止线的时间不是正的：停止线算到了车后面');
    assert.ok(signal.lap > 0);
    assert.equal(signal.rank, Math.round(signal.rank));
    assert.ok(signal.pitch >= 0);
    // 车到线那一刻（自己的钟 = `reach`）应该正落在自己那条车道的停止点上。
    const at = agentPosition(agent, signal.reach);
    const centre = agent.line.at(signal.stop);
    const lane = { x: centre.x + LANE_OFFSET * signal.approach.rx, y: centre.y + LANE_OFFSET * signal.approach.ry };
    assert.ok(Math.hypot(at.x - lane.x, at.y - lane.y) < 0.2,
      `车到线时离自己车道的停止点 ${Math.hypot(at.x - lane.x, at.y - lane.y).toFixed(2)} m`);
    // 横向那一侧必须是车实际偏过去的那一侧，不是对面那条车道。
    assert.ok(Math.hypot(at.x - centre.x, at.y - centre.y) > LANE_OFFSET - 0.2, '车没偏到 lane 上');
  }
  // 找一拍：让同一队的车全都钉着，然后量两两之间是不是一个位次一个身位。
  const byQueue = new Map();
  for (const agent of held) {
    // 队列的归属 = 路口 + 这条 way + 停止线所在的弧长：同一个路口的另一侧不能用同一把队。
    const key = `${Math.round(agent.signal.junction.seed)}:${agent.osmId}:${agent.signal.stop.toFixed(1)}`;
    if (!byQueue.has(key)) byQueue.set(key, []);
    byQueue.get(key).push(agent);
  }
  const queue = [...byQueue.values()].sort((a, b) => b.length - a.length)[0];
  const ranked = [...queue].sort((a, b) => a.signal.rank - b.signal.rank);
  assert.ok(ranked.length >= 3, `最长的一队只有 ${ranked.length} 辆：排不出列`);
  let moment = null;
  for (let s = 1; s <= 3000 && moment === null; s += 0.5) if (pinnedAt(ranked, s).length === ranked.length) moment = s;
  assert.ok(moment !== null, `这一队 ${ranked.length} 辆车里找不到"全都钉着"的那一拍`);
  const spots = ranked.map((agent) => agentPosition(agent, moment - signalLost(agent.signal, moment)));
  for (let index = 1; index < spots.length; index += 1) {
    const gap = Math.hypot(spots[index].x - spots[index - 1].x, spots[index].y - spots[index - 1].y);
    assert.ok(Math.abs(gap - SIGNAL_QUEUE_PITCH_METRES) < 1.2,
      `位次 ${index - 1} 与 ${index} 之间隔了 ${gap.toFixed(2)} m，不是一个车位`);
  }
  assert.equal(SIGNAL_QUEUE_PITCH_METRES, 8, '车位间距这一格被改动：判据与 README 要一起改');
  assert.equal(SIGNAL_HEADWAY_SECONDS, 2.6, '放行间隔被改动：排队放行的节奏要一起看');
  // 头车就停在停止线上（一列是从它往后排的）。
  const stop = ranked[0].line.at(ranked[0].signal.stop);
  const gap = Math.hypot(spots[0].x - stop.x, spots[0].y - stop.y);
  assert.ok(Math.abs(gap - LANE_OFFSET) < 1.5, `头车离中心线停止点 ${gap.toFixed(2)} m，不在它那一侧的车道上`);
});

test('同一个口上并排三辆：绿灯一亮是一辆一辆放，不是一起弹出去', () => {
  const features = cross();
  const junctions = deriveJunctions({ features, origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
  const { cars } = trafficAgents(features, DEFAULT_CENTER, CROSS_RADIUS);
  const line = cars.find((agent) => agent.osmId === 11).line;
  // 三辆车的到线时刻故意做成一样：位次只剩"放行间隔"这一件事可验。
  const agents = [0, 1, 2].map(() => ({ line, at: 120, speed: 10, sign: -1, offset: LANE_OFFSET, osmId: 11, class: 'secondary' }));
  assignSignals(junctions, agents);
  assert.deepEqual(agents.map((agent) => agent.signal.rank), [0, 1, 2], '位次没按到场先后发出去');
  assert.deepEqual(agents.map((agent) => agent.signal.wait), [0, 2.6, 5.2], '放行间隔没按位次累加');
  // 找一个三辆都钉着的时刻，然后看它们各自在第几秒重新动起来。
  let moment = null;
  for (let s = 1; s <= 3000 && moment === null; s += 0.5) if (pinnedAt(agents, s).length === 3) moment = s;
  assert.ok(moment !== null, '找不到三辆一起钉着的那一拍');
  const movedAt = agents.map((agent) => {
    const frozen = moment - signalLost(agent.signal, moment);
    for (let s = moment; s <= moment + SIGNAL_CYCLE_SECONDS; s += 0.25) {
      if (s - signalLost(agent.signal, s) > frozen + 1e-6) return s;
    }
    return Infinity;
  });
  assert.ok(movedAt.every((second) => Number.isFinite(second)), `有一辆没在两个周期内放行：${movedAt}`);
  assert.ok(movedAt[1] > movedAt[0] && movedAt[2] > movedAt[1], `放行顺序不是按位次：${movedAt.join(' → ')}`);
  assert.ok(Math.min(movedAt[1] - movedAt[0], movedAt[2] - movedAt[1]) >= 1,
    `相邻两辆之间只隔了 ${(movedAt[1] - movedAt[0]).toFixed(2)} s：读起来是一起弹出去`);
});

test('没等到灯的那些车一点不受影响，等到灯的车回 0 秒就是出厂那一帧', () => {
  const features = cross();
  const run = () => {
    const junctions = deriveJunctions({ features, origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
    const { cars } = trafficAgents(features, DEFAULT_CENTER, CROSS_RADIUS);
    assignSignals(junctions, cars);
    return cars;
  };
  const first = run();
  const free = first.filter((agent) => !agent.signal);
  assert.ok(free.length > 0, 'fixture 上每一辆车都被灯管住了，这一条验不了"没接上灯的车"');
  for (const agent of free) assert.equal(signalLost(agent.signal, 123.4), 0, '没接上灯的车也在白等');
  // 0 秒那一帧必须一个都不等：出厂画面（截图、逐字节比对）不能被灯改动。
  assert.equal(first.reduce((sum, agent) => sum + signalLost(agent.signal, 0), 0), 0,
    't=0 就有车在灯前白等：出厂那一帧变了');
  assert.equal(pinnedAt(first.filter((agent) => agent.signal), 0).length, 0);
  // 纯函数：同一份输入两次装配，第 123.4 秒的位置逐米相同（引擎并排比读数靠这个）。
  const twice = run();
  for (let index = 0; index < first.length; index += 1) {
    const a = agentPosition(first[index], 123.4 - signalLost(first[index].signal, 123.4));
    const b = agentPosition(twice[index], 123.4 - signalLost(twice[index].signal, 123.4));
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `第 ${index} 辆车两次装配位置不同`);
  }
});

test('白等的秒数随真实时间单调，不回头也不跳秒', () => {
  const features = cross();
  const junctions = deriveJunctions({ features, origin: DEFAULT_CENTER, radius: CROSS_RADIUS });
  const { cars } = trafficAgents(features, DEFAULT_CENTER, CROSS_RADIUS);
  assignSignals(junctions, cars);
  const held = cars.filter((agent) => agent.signal);
  for (const agent of held) {
    let prevLost = null;
    let prevOwn = null;
    for (let s = 0; s <= 1800; s += 0.25) {
      const lost = signalLost(agent.signal, s);
      const own = s - lost;
      if (prevLost !== null) {
        assert.ok(lost >= prevLost - 1e-9, `${s} s 的白等秒数比上一拍少：时间倒流`);
        assert.ok(own >= prevOwn - 1e-9, `${s} s 车自己的钟退了 ${(prevOwn - own).toFixed(4)} s`);
        assert.ok(own - prevOwn <= 0.2500001, `${s} s 车自己的钟跳了 ${(own - prevOwn).toFixed(4)} s`);
      }
      assert.ok(lost <= s + 1e-9, '白等的秒数超过了已经过去的时间');
      prevLost = lost;
      prevOwn = own;
    }
  }
  // 一圈一圈地等：圈数有上限，跑了很久之后也不会把秒数算成无穷。
  const worst = held.reduce((a, b) => (b.signal.reach < a.signal.reach ? b : a), held[0]);
  const late = signalLost(worst.signal, 20000);
  assert.ok(Number.isFinite(late) && late <= 20000, `跑了 20000 秒之后白等秒数成了 ${late}`);
});

test('真快照：1.5 km 内 201 个路口、702 条进口道装灯，同一时刻约一成车在灯前', () => {
  const junctions = deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS });
  assert.equal(junctions.length, 201, '路口的总数变了（2026-10-13 量到 201）');
  const lit = junctions.reduce((sum, junction) => sum + junction.approaches.filter((a) => a.lit).length, 0);
  assert.equal(lit, 702, '装灯的进口道总数变了（2026-10-13 量到 702）');
  assert.deepEqual([junctions.filter((j) => j.axes === 2).length, junctions.filter((j) => j.axes === 1).length],
    [39, 162], '两轴/一轴的分账变了：绿灯时长那两档要重看');
  for (const junction of junctions) {
    assert.ok(Math.hypot(junction.x, junction.y) <= TRAFFIC_LIFE_RADIUS + 1);
    assert.ok(junction.offset >= 0 && junction.offset < SIGNAL_CYCLE_SECONDS, '这个路口没被错开周期');
    assert.ok([1, 2].includes(junction.axes));
  }
  // 全城不同时刻错开：`offset` 是一个都不重（种子含位置），而且铺满整个周期，
  // 否则远处两个路口会读成同一段动画在跳。按秒取整必然撞档（201 个路口落在 97 格里），所以这里比的是原值。
  const offsets = junctions.map((junction) => junction.offset);
  assert.equal(new Set(offsets).size, junctions.length, '有两个路口算出了同一个周期起点');
  assert.deepEqual([Math.min(...offsets) < 10, Math.max(...offsets) > 86], [true, true],
    `周期起点没铺满：最小 ${Math.min(...offsets).toFixed(1)}、最大 ${Math.max(...offsets).toFixed(1)} s`);

  const traffic = createTrafficLife({ features: streets, origin: DEFAULT_CENTER, junctions });
  const held = traffic.group.children.find((c) => c.name === 'traffic-cars').userData.agents.filter((a) => a.signal);
  assert.ok(held.length > 500 && held.length < 800, `被灯管住的车是 ${held.length} 辆，不在量到的那一档（637）`);
  assert.ok(held.length / traffic.counts.cars < 0.6, '灯把大半个车流量管死了：画面会读成停车场');
  for (const at of [60, 200, 400]) {
    const pinned = pinnedAt(held, at).length;
    assert.ok(pinned > 60 && pinned < traffic.counts.cars * 0.25,
      `t=${at} s 有 ${pinned} 辆车钉着，占全场 ${((pinned / traffic.counts.cars) * 100).toFixed(0)}%`);
  }
  // 位次不是摆设：真的有一队排到 8 辆以上，而且靠后的确实排在灯前几十米。
  assert.ok(held.reduce((top, agent) => Math.max(top, agent.signal.rank), 0) >= 8, '最长的队排不到 8 辆：排队没画出来');
  const far = held.filter((agent) => agent.signal.rank >= 3
    && Math.abs(agent.signal.pitch * agent.speed - agent.signal.rank * SIGNAL_QUEUE_PITCH_METRES) < 1e-6);
  assert.ok(far.length > 40, `只有 ${far.length} 辆车真按位次排在灯后（一个车位 ${SIGNAL_QUEUE_PITCH_METRES} m）`);
  // 杆数 ≥ 队列数：一条 way 的两端都落在同一个路口格时，一个队列会摆两根杆。
  assert.ok(traffic.signals.approaches >= traffic.parts().vehicles.approaches,
    '装了杆的进口道比接上车的队列还少：有一边的账没对上');
  assert.equal(CAR_GAP, 100, '车距这一格被动过：排队的稠密程度跟着变');
});

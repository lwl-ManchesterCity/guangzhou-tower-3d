// 路口与信号灯。这份快照里只有 way（`canton-streets.geojson` 41 项判据钉着"每条都是 LineString"），
// 没有 node、也没有 `highway=traffic_signals` 那类点要素，所以路口只能**派生**：把车行道被圆裁之后的端点
// 按 12 m 聚一簇，一簇里有两条以上不同的 way 就是一个路口。量到的底账（2026-10-10）：1.5 km 内端点簇 657 个、
// 其中 ≥2 条 way 的 330 个、进口道合计 1,252 条，两条以上不同等级且含 trunk/primary/secondary 的 114 个——
// 这一批才装灯，因为现实里小路口是停车让行而不是信号灯。
//
// 灯本身、停止线的位置与周期全是画的（OSM 不给），但**位置一个都不手摆**：进口道就是那条 way 自己的端点，
// 方向就是它自己的切线。周期与放行间隔写成下面这些命名常量，README 与卡片按同一句口径点名示意。
import { CARRIAGEWAYS, LANE_OFFSET, RAMPS, insideRadius, scatter } from './traffic-life.js';
import { plane } from './geo.js';

// 端点聚一档的米数。12 m 是"两条 way 的端点算同一个路口"与"十字路口的四个角不被并成一个"之间量出来的那一档。
export const JUNCTION_TOLERANCE_METRES = 12;
// 一簇里至少要几条不同的 way 才算路口。
export const JUNCTION_MIN_WAYS = 2;
// 只有这几级路装灯（含高速匝道，那是互通立交的灯）。
export const SIGNAL_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
// 一个周期：绿 40 s、黄 3 s、全红 3 s、另一轴绿 40 s、黄 3 s、全红 7 s。广州主干路常见的 90~120 s 周期里取 96 s。
export const SIGNAL_CYCLE_SECONDS = 96;
export const SIGNAL_GREEN_SECONDS = 40;
export const SIGNAL_AMBER_SECONDS = 3;
// 放行间隔：排队里两台车起步之间隔这一秒数（1 秒 2.6 m 是"路口清空一辆"的量级）。
export const SIGNAL_HEADWAY_SECONDS = 2.6;
// 排队间距：位次每往后一名，车就停在停止线前这么多米（8 m 是"一辆公交加一个车头距"的量级）。
// 没有这一格，同一路口的队会全部钉在停止线上叠成一摞——位次只该决定"什么时候走"，不该决定"叠在哪"。
export const SIGNAL_QUEUE_PITCH_METRES = 8;
// 停止线离端点多远：路口中心留 7 m，线才落在车头上而不是压在交叉口中间。
export const STOP_LINE_SETBACK_METRES = 7;
// 圈数上限：一辆车在自己的线上绕到第 32 圈之后就不再算等待（一次 `advance` 里那是 32 次常数运算，
// 而 32 圈 × 一条 1 km 的路 = 连续开 1 小时，超出这一格画面的用途）。
export const SIGNAL_LAP_CAP = 32;

const mod = (value, length) => ((value % length) + length) % length;
const isRoad = (kind) => CARRIAGEWAYS.includes(kind) || RAMPS.includes(kind);
const signalled = (kind) => SIGNAL_CLASSES.includes(kind);

/**
 * 一簇里的进口道：一条被裁过的 piece 的哪一个端点、开进路口时朝哪个方向。
 * `next` 是这条路**往内陆那一侧**的相邻点，所以方向是"端点减相邻点"——车开进路口时就是朝着它走。
 */
function pushEnd(ends, point, next, feature) {
  const dx = point.x - next.x;
  const dy = point.y - next.y;
  const span = Math.hypot(dx, dy);
  if (!span) return;
  ends.push({
    x: point.x, y: point.y,
    ux: dx / span, uy: dy / span,
    osmId: feature.properties.osmId,
    kind: feature.properties.class,
  });
}

/**
 * 从路网派生路口。
 *
 * 每条 way 先按使用半径裁成 piece（与车流同一把裁刀，所以"端点"就是车流真的会走到的端点），
 * 两端的点按 `tolerance` 聚格、再把相邻格并成一簇。一簇里 ≥`minWays` 条不同的 way 才算路口。
 * 进口道按**轴**分两个相位：东西向一律 0、南北向一律 1（|ux| ≥ |uy| 就是东西向），
 * 这样十字路口的两个方向轮流绿，而"T 字路口三条同轴进口道"自然就是同一相位。
 * @param {{features: object[], origin: {lng:number,lat:number}, radius: number,
 *   tolerance?: number, minWays?: number, classes?: string[]}} options
 */
export function deriveJunctions({ features = [], origin, radius, tolerance = JUNCTION_TOLERANCE_METRES,
  minWays = JUNCTION_MIN_WAYS, classes = SIGNAL_CLASSES } = {}) {
  const cells = new Map();
  for (const feature of features) {
    const kind = feature.properties?.class;
    if (!isRoad(kind)) continue;
    if (feature.properties?.brunnel === 'tunnel') continue;
    const lines = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    for (const ring of lines) {
      for (const piece of insideRadius(ring, origin, radius)) {
        if (piece.length < 2) continue;
        const ends = [];
        pushEnd(ends, piece[0], piece[1], feature);
        pushEnd(ends, piece.at(-1), piece.at(-2), feature);
        for (const end of ends) {
          const key = `${Math.round(end.x / tolerance)},${Math.round(end.y / tolerance)}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(end);
        }
      }
    }
  }
  const taken = new Set();
  const junctions = [];
  for (const key of cells.keys()) {
    if (taken.has(key)) continue;
    const [cx, cy] = key.split(',').map(Number);
    const ends = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const neighbour = `${cx + dx},${cy + dy}`;
        if (!cells.has(neighbour)) continue;
        taken.add(neighbour);
        ends.push(...cells.get(neighbour));
      }
    }
    const ways = new Set(ends.map((end) => end.osmId));
    if (ways.size < minWays) continue;
    // 中心取这一簇端点的平均位置：路口就在这些端点中间，不是某一条路的端点。
    const x = ends.reduce((sum, end) => sum + end.x, 0) / ends.length;
    const y = ends.reduce((sum, end) => sum + end.y, 0) / ends.length;
    if (Math.hypot(x, y) > radius) continue;
    const lit = ends.filter((end) => classes.includes(end.kind));
    if (lit.length < minWays) continue;
    // 装灯的进口道压在几个轴上：只有一个轴时（主路穿过一串小路口）另一轴根本没有车要放行，
    // 还按两轴轮流绿就是让主路一半周期在红灯前空等。量到的底账：201 个路口里 39 个是两轴、162 个是一轴。
    const axes = new Set(lit.map((end) => (Math.abs(end.ux) >= Math.abs(end.uy) ? 0 : 1)));
    // 种子把参与的 way id 与路口自己的位置混进来：只用 id 求和会让不少路口算出同一个种子，
    // 于是全城只错开 86 档周期（201 个路口），远处两个路口读起来像同一段动画在跳。
    const seed = [...ways].reduce((sum, id) => sum + (Math.abs(Number(id) || 0) % 10007), 0)
      + Math.round(x * 31 + y * 17);
    junctions.push({
      x, y, seed,
      axes: axes.size > 1 ? 2 : 1,
      solo: axes.size > 1 ? null : [...axes][0],
      // 每个路口错开半个周期以内：全城同时变绿灯会读成一段动画，而不是路口。
      offset: scatter(seed * 7 + 3) * SIGNAL_CYCLE_SECONDS,
      approaches: ends.map((end) => ({
        ...end,
        phase: Math.abs(end.ux) >= Math.abs(end.uy) ? 0 : 1,
        lit: classes.includes(end.kind),
      })),
    });
  }
  return junctions;
}

/**
 * 一个周期切成："本轴绿 → 本轴黄 → 另一轴绿 → 另一轴黄 → 清空"。
 * 只有一个轴有车要管时，那一轴的绿灯拉到 `SIGNAL_MAJOR_GREEN_SECONDS`，另一轴只留 `SIGNAL_MINOR_GREEN_SECONDS`
 * 的示意时间（162 个一轴路口若还按两轴平分，主路会有半个周期在对着空路口等红灯）。
 */
const SIGNAL_MAJOR_GREEN_SECONDS = 80;
const SIGNAL_MINOR_GREEN_SECONDS = SIGNAL_CYCLE_SECONDS - SIGNAL_MAJOR_GREEN_SECONDS - SIGNAL_AMBER_SECONDS;

/** 这一相位在这个路口的绿灯从哪一秒开始、绿多久（`axes` 决定是两轴平分还是一轴长绿）。 */
function layout(junction, phase) {
  if (junction.axes === 1) {
    return phase === junction.solo
      ? { start: 0, green: SIGNAL_MAJOR_GREEN_SECONDS }
      : { start: SIGNAL_MAJOR_GREEN_SECONDS + SIGNAL_AMBER_SECONDS, green: SIGNAL_MINOR_GREEN_SECONDS };
  }
  return phase === 0
    ? { start: 0, green: SIGNAL_GREEN_SECONDS }
    : { start: SIGNAL_GREEN_SECONDS + 2 * SIGNAL_AMBER_SECONDS, green: SIGNAL_GREEN_SECONDS };
}
const cycleOf = (junction, seconds) => mod(seconds + junction.offset, SIGNAL_CYCLE_SECONDS);

/**
 * 不早于 `seconds` 的那一段绿灯（正在绿就报当前这一段）：`begin` 与 `end` 都是**真实时刻**。
 * `signalLost` 要的是"这一列从 `begin` 开始一辆一辆放"，所以把窗口两端一起交出去。
 */
export function greenWindow(junction, phase, seconds) {
  const t = cycleOf(junction, seconds);
  const { start, green } = layout(junction, phase);
  const end = start + green;
  if (t >= start && t < end) return { begin: seconds, end: seconds + (end - t) };
  const wait = t < start ? start - t : SIGNAL_CYCLE_SECONDS - t + start;
  return { begin: seconds + wait, end: seconds + wait + green };
}

/** 此刻这一相位是绿、黄，还是红。 */
export function signalState(junction, phase, seconds) {
  const t = cycleOf(junction, seconds);
  const { start, green } = layout(junction, phase);
  if (t >= start && t < start + green) return 'green';
  if (t >= start + green && t < start + green + SIGNAL_AMBER_SECONDS) return 'amber';
  return 'red';
}

/** 不早于 `seconds` 的第一个绿灯时刻（正在绿就报现在）。 */
export function nextGreen(junction, phase, seconds) {
  return greenWindow(junction, phase, seconds).begin;
}

/**
 * 一辆车在信号前**损失了多少秒**：纯函数，只吃 `seconds`。
 *
 * 车在自己的线上绕圈，每绕到停止线一次就等一轮。第 i 圈的**真实**到线时刻 `arrival` 由上一圈的放行时刻 +
 * 一圈的时间推出来（等灯期间车自己的钟是停着的，所以真实与自钟之间只差一个累积的 `lost`）；
 * 放行时刻分两种：到线就是绿灯的直接走；到线是红的，从这一段绿灯的开始时刻按位次一辆一辆放
 * （`wait = 位次 × 放行间隔`），排到绿灯尾之外的等下一轮。
 * 位次还决定**停在哪**：`pitch` 是这一位次该停在灯前多少秒的车程，所以一个队是一列而不是叠在停止线上的一摞。
 * 这一段不累积任何状态，因此同一秒在两条渲染路径上算出来是同一个位置（引擎并排比读数那条判据靠这个）。
 * @param {{reach: number, lap: number, pitch?: number, wait?: number, junction: object, phase: number}} signal
 * @param {number} seconds
 */
export function signalLost(signal, seconds) {
  if (!signal) return 0;
  const { reach, lap, pitch = 0, wait = 0, junction, phase } = signal;
  let lost = 0;
  let arrival = reach;
  for (let lapIndex = 0; lapIndex < SIGNAL_LAP_CAP; lapIndex += 1) {
    // 车自己的钟到线那一刻是 `arrival - lost`，而它要在灯前 `pitch` 秒那里就停下来。
    const hold = Math.max(0, arrival - lost - pitch) + lost;
    if (hold > seconds) break;
    const window = greenWindow(junction, phase, arrival);
    let release = window.begin;
    if (release > arrival) {
      release = window.begin + wait;
      // 这一列排到了绿灯尾之外：接着等下一轮，从下一轮的队头往后延。
      if (release >= window.end) release = greenWindow(junction, phase, release).begin + wait;
    }
    // 此刻还钉着：损失就是"现在几点"减"该停住的那一点"。
    if (seconds < release) return lost + (seconds - hold);
    lost += release - hold;
    arrival = release + lap;
  }
  return lost;
}

/**
 * 把路口接到车流那批 agent 上：每条线找它沿线最近的进口道，算出"从当前位置到停止线要跑几米"。
 *
 * 排队位次按**同一进口道上第一次到达的先后**排（装配时算一次），所以同一路口同一方向的队是
 * 一辆一辆放的，而不是十几辆叠在一条线上。
 * @param {object[]} junctions `deriveJunctions` 的结果
 * @param {object[]} agents `trafficAgents` 交出来的车
 */
export function assignSignals(junctions, agents) {
  const lit = junctions.flatMap((junction) => junction.approaches.filter((approach) => approach.lit)
    .map((approach) => ({ junction, approach })));
  // 12 m 一格的空间索引：一条线只可能撞进它经过的那几格，不先筛就是 1,252 × 300 次全量比对。
  const grid = new Map();
  lit.forEach((entry, index) => {
    const key = `${Math.round(entry.approach.x / JUNCTION_TOLERANCE_METRES)},${Math.round(entry.approach.y / JUNCTION_TOLERANCE_METRES)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });
  const found = new Map();
  for (const agent of agents) {
    const line = agent.line;
    if (!line || line.length < 8) continue;
    let best = null;
    for (let step = 0; step < line.length; step += 4) {
      const at = line.at(step);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const bucket = grid.get(`${Math.round((at.x + dx * JUNCTION_TOLERANCE_METRES) / JUNCTION_TOLERANCE_METRES)},${Math.round((at.y + dy * JUNCTION_TOLERANCE_METRES) / JUNCTION_TOLERANCE_METRES)}`);
          for (const index of bucket ?? []) {
            const entry = lit[index];
            const distance = Math.hypot(at.x - entry.approach.x, at.y - entry.approach.y);
            if (distance > JUNCTION_TOLERANCE_METRES * 1.5) continue;
            // 只算"开进这个路口"的那一侧：车头方向与进口道方向同向才算。
            // `at.side` 是这条线的右手法线，车头是它再转 90° 再乘行进符号——`agentPosition` 里同一个式子。
            const toward = (-at.side.y * agent.sign) * entry.approach.ux + (at.side.x * agent.sign) * entry.approach.uy;
            if (toward < 0.2) continue;
            // 停止线得真的落在这个口上：同一条路被路口切成两截时，另一截的车流方向与这一侧的进口道是同一个方向，
            // 但它已经过了口——不钉这一格，它会被分到对头那一侧的队里，停到交叉口中间去。
            const here = line.at(mod(step - STOP_LINE_SETBACK_METRES * agent.sign, line.length));
            if (Math.hypot(here.x - entry.approach.x, here.y - entry.approach.y)
              > STOP_LINE_SETBACK_METRES + JUNCTION_TOLERANCE_METRES + 4) continue;
            if (!best || distance < best.distance) best = { distance, step, entry };
          }
        }
      }
    }
    if (!best) continue;
    // 停止线在进口道端点后面 `STOP_LINE_SETBACK_METRES`：车要停在线前，不是停在路口中间。
    const back = best.entry.approach;
    const stop = mod(best.step - STOP_LINE_SETBACK_METRES * agent.sign, line.length);
    // 把这一条进口道的停止线位置与朝向记回路口：灯杆与停止线那两层几何要按它摆，
    // 而"哪条线在哪个弧长过这个路口"只有 agent 这一侧算得出来。
    if (!back.stop) {
      const at = line.at(stop);
      // 行车方向的单位向量与"这一侧"的法线（车道中心线往外 `LANE_OFFSET` 那一侧，就是车实际站着的那条线）。
      const hx = -at.side.y * agent.sign;
      const hy = at.side.x * agent.sign;
      const rx = at.side.x * agent.sign;
      const ry = at.side.y * agent.sign;
      back.stop = {
        x: at.x, y: at.y, hx, hy, rx, ry,
        // 停止线要压在**这一侧的车道**上，不是压在中心线上：中心线那格只覆盖两个对向流之间的缝。
        lx: at.x + rx * LANE_OFFSET, ly: at.y + ry * LANE_OFFSET,
      };
    }
    const key = `${best.entry.junction.seed}:${back.osmId}:${back.phase}`;
    // 到线的秒数要按行进符号取：`agentPosition` 里走过的弧长是 `at + speed·秒·sign`，
    // 反着开的那一流要是没有这个 `sign`，它"到线"的时刻会算成绕了大半条路之后。
    const reach = mod((stop - agent.at) * agent.sign, line.length) / agent.speed;
    const queue = found.get(key) ?? [];
    queue.push({ agent, reach });
    found.set(key, queue);
    agent.signal = {
      reach,
      lap: line.length / agent.speed,
      rank: 0,
      junction: best.entry.junction,
      phase: back.phase,
      stop,
      // `rx/ry` 是"这一侧"的法线：车道中心线往这一边外推 `LANE_OFFSET` 才是车真正站着的那条线。
      approach: { x: back.x, y: back.y, ux: back.ux, uy: back.uy, rx: back.stop.rx, ry: back.stop.ry },
    };
  }
  // 位次：同一进口道上按第一次到达的先后排，先到的先走；靠后的既晚起步，也停在灯前一列里。
  for (const queue of found.values()) {
    queue.sort((a, b) => a.reach - b.reach);
    queue.forEach((item, rank) => {
      const { agent } = item;
      agent.signal.rank = rank;
      agent.signal.wait = rank * SIGNAL_HEADWAY_SECONDS;
      // 队列往后的长度不超过这条线的四分之一：位次再高也不把车压回它的出发点。
      agent.signal.pitch = Math.min(rank * SIGNAL_QUEUE_PITCH_METRES, agent.line.length * 0.25) / agent.speed;
    });
  }
  return found.size;
}

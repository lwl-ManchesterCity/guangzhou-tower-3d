import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { plane } from './geo.js';
import { PAD_SPREAD, createPads } from './shadow-pads.js';
import { assignSignals, signalLost } from './junctions.js';
import { createSignalProps } from './signals.js';

// Traffic a person can actually count: individual vehicles on the carriageways and individual walkers on the footways,
// within one kilometre of the tower. Everything here sits on a line from `data/canton-streets.geojson` - a real OSM way
// with a real id behind every light - and nothing is placed by eye. The far field keeps its long-exposure ribbons
// (`traffic-band` / `traffic-flow`); this is the near field, where a ribbon stops reading as a street and starts reading
// as a street with traffic on it.
//
// The lines are whole ways rather than what `querySourceFeatures` returns, because a vector tile clips a road at its own
// border: a car following a clipped fragment would reach the tile edge and restart at the other end of the street, and a
// pedestrian swarm that teleports every 1.1 km is the one thing that tells you the lights are dots.

export const TRAFFIC_LIFE_RADIUS = 1500;
// Carriageways the cars run on, the ramps that feed them, and the footways the walkers use. The class names are OSM's
// own `highway` values, so every agent can be pointed back at the way it was put on.
export const CARRIAGEWAYS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
export const RAMPS = CARRIAGEWAYS.map((class_) => `${class_}_link`);
export const FOOTWAYS = ['path', 'pedestrian', 'steps', 'track', 'footway'];
// Metres per second. A ramp is its parent road's traffic, so it takes the parent's speed; anything unlisted is a
// carriageway this scene has never seen and gets the slowest number on the table rather than `undefined`.
export const CAR_SPEED = { motorway: 14, trunk: 14, primary: 11, secondary: 9, tertiary: 8, unclassified: 7, residential: 7, living_street: 5, service: 5 };
export const CAR_FALLBACK_SPEED = 5;
// How many agents a line carries, and how short a piece of road has to be to carry none. Both are read off what the
// hero camera resolves: at ~1.5 m per pixel a 40 m stub is 27 px of street, which is not a road with traffic on it.
// 越远的街放得越稀：这一公里半的车流是给"这座城市在动"这件事服务的，不是给逐辆计数用的，而每一辆都要在
// 每个节拍上重写一次矩阵与灯色，所以实例数是帧时间的直接成本。700 m 之外按距离线性拉大间距——1,500 m 处
// 约两倍间距，也就是约一半的车。近处保持原样，因为默认机位看到的就是那一片。
// 车距 55 → 100 m 是用户 2026-10-09 那句「现在的车辆太多了，太密集了，减少点」：1,981 辆 → 1,298 辆（−34%），
// 按 300 m 分五档 63/129/215/392/499 辆，摊到各档的车行道（4.2/7.4/17.0/34.9/40.5 km）是 15.0/17.4/12.6/11.2/12.3
// 辆每公里——最密的一档在 300-600 m，约每 57 m 一辆。**只动车不动人**：他说的是车，行人 1,244 一字未改。
export const TRAFFIC_THIN_FROM_METRES = 700;
export const CAR_GAP = 100;
export const CAR_MIN_METRES = 40;
export const WALK_SPEED = 1.4;
export const WALK_GAP = 30;
export const WALK_MIN_METRES = 60;
// A two-way street gets its two flows half a carriageway apart, so they pass instead of overlapping on one line.
export const LANE_OFFSET = 3.2;
export const WALK_OFFSET = 1.3;
// Sprite size in metres, and how far off the ground the light sits: a car's lamps, and a person's head and phone. The
// sizes are deliberately larger than the object - a headlight at night is a bloom, not a disc, and at the hero camera a
// 6 m light is four pixels, which is a dust mote rather than a street with traffic on it.
// The two colours a night exposure of a city shows, and the warm dot a walker is at this distance.
export const HEADLIGHT = '#fff3d2';
export const TAILLIGHT = '#ff3b26';

const isCarriageway = (kind) => CARRIAGEWAYS.includes(kind) || RAMPS.includes(kind);
const speedOf = (kind) => CAR_SPEED[kind.replace(/_link$/, '')] ?? CAR_FALLBACK_SPEED;
const wrapped = (value, length) => ((value % length) + length) % length;
// A stable 0..1 for one place on one way, so the traffic is not metronomic: an even 55 m spacing reads as beads on a
// string, and a road of vehicles has gaps in it. Integer arithmetic only, so the same way scatters the same way in the
// browser and in a test, and a re-load never re-shuffles the traffic.
export const scatter = (seed) => {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
// How far a vehicle or a walker may be pushed off the nominal spacing, in either direction.
const JITTER = 0.4;
export const spaced = (gap, seed) => gap * (1 - JITTER + 2 * JITTER * scatter(seed));

/**
 * The part of one ring that lies inside the radius, in local metres (x east, y north), as every contiguous piece of it.
 *
 * The clip is exact rather than vertex-by-vertex: a way whose endpoints are both outside can still cross the circle, and
 * a piece list is what stops a U-shaped way from becoming one polyline that jumps the gap in the middle of it.
 */
export function insideRadius(ring, origin, radius) {
  const points = ring.map(([lng, lat]) => plane(origin, { lng, lat }));
  const pieces = [];
  let piece = null;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const ex = b.dx - a.dx;
    const ey = b.dy - a.dy;
    const quadratic = ex * ex + ey * ey;
    if (!quadratic) continue;
    // |a + t(b-a)| = radius, solved for the span of the segment that is inside the circle.
    const linear = 2 * (a.dx * ex + a.dy * ey);
    const constant = a.dx * a.dx + a.dy * a.dy - radius * radius;
    const discriminant = linear * linear - 4 * quadratic * constant;
    if (discriminant < 0) { piece = null; continue; }
    const root = Math.sqrt(discriminant);
    const from = Math.max(0, (-linear - root) / (2 * quadratic));
    const to = Math.min(1, (-linear + root) / (2 * quadratic));
    if (to - from <= 0) { piece = null; continue; }
    if (!piece) pieces.push(piece = []);
    // Both ends of the kept span are the clipped points, not the way's own vertices: a road entering the circle from
    // outside has to start its piece on the circle, or the first car would be driving in from the countryside.
    piece.push({ x: a.dx + ex * from, y: a.dy + ey * from }, { x: a.dx + ex * to, y: a.dy + ey * to });
  }
  // A segment lying wholly inside is joined to the next by its own endpoint twice, and a zero-length step has no
  // perpendicular to offset a lane by, so the repeats are dropped rather than carried into `polyline`.
  return pieces
    .map((points) => points.filter((point, index) => !index || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-6))
    .filter((points) => points.length > 1);
}

/** One line, walked from one end so every agent on it can be asked where it is at a given distance. */
export function polyline(points) {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  }
  return {
    points,
    lengths,
    length: lengths.at(-1),
    at(distance) {
      const d = Math.min(this.length, Math.max(0, distance));
      let index = Math.max(1, this.lengths.findIndex((stop) => stop >= d));
      const a = this.points[index - 1];
      const b = this.points[index];
      const span = this.lengths[index] - this.lengths[index - 1] || 1;
      const share = (d - this.lengths[index - 1]) / span;
      // The perpendicular of the segment this distance falls on: which way the lane is offset, and which way the agent
      // is travelling, both come out of it.
      return { x: a.x + (b.x - a.x) * share, y: a.y + (b.y - a.y) * share, side: { x: (b.y - a.y) / span, y: -(b.x - a.x) / span } };
    },
  };
}

/**
 * Every agent this set of ways carries: which line, how far along it, which way, how fast and how far off the centre.
 *
 * @param {object[]} features OSM `highway` LineStrings
 * @param {object} origin the point the radius is measured from, as {lat,lng}
 */
/**
 * 我们自己画出来的那些桥面，顶在多少米。
 * 车的高度只认这一张表：`canton-bridges.geojson` 里 `part === 'deck'` 的那些件是 `src/bridges.js` 真的挤出体来的，
 * 顶面高度就是它的 `height`；一条 way 被裁成多块时取最高的那一块。表里没有的留在 0——那一路我们画的是平色带，
 * 把车抬起来只会变成"车浮在平路上"。
 * 第二张表按桥名建：一条 way 自己没被扫出桥面、却明显是同一条桥的一部分时（海心桥的主道就是这样——OSM 给它的
 * 标签只有 `layer=1`，没有 `bridge`，所以抽取脚本按 `bridge` 筛的时候漏了它），可以继承同名桥面的顶高。
 * 继承只对"高架的那条"开：地面上同名的路（猎德大道在地面的那一节）不许跟着抬。
 * @param {object[]} crossingsFeatures `canton-bridges.geojson` 的 features
 */
export function deckHeights(crossingsFeatures = []) {
  const byOsmId = new Map();
  const byName = new Map();
  for (const feature of crossingsFeatures) {
    if (feature?.properties?.part !== 'deck') continue;
    const osmId = Number(feature.properties.osmId);
    const height = Number(feature.properties.height);
    // `Number(null)` 是 0，所以缺高度的件必须当场丢掉——留下一个 0 等于宣称"这块桥面贴地"，那是另一种错法。
    if (!Number.isFinite(osmId) || !(Number.isFinite(height) && height > 0)) continue;
    byOsmId.set(osmId, Math.max(byOsmId.get(osmId) ?? 0, height));
    const name = feature.properties.name;
    if (typeof name === 'string' && name) byName.set(name, Math.max(byName.get(name) ?? 0, height));
  }
  const heightOf = (feature) => {
    const properties = feature?.properties ?? {};
    const direct = byOsmId.get(Number(properties.osmId));
    if (direct !== undefined) return direct;
    if (properties.brunnel !== 'bridge' && !(Number(properties.layer) >= 1)) return 0;
    return byName.get(properties.name) ?? 0;
  };
  return { byOsmId, byName, heightOf };
}

export function trafficAgents(features, origin, radius = TRAFFIC_LIFE_RADIUS, decks = null) {
  const cars = [];
  const walkers = [];
  for (const feature of features) {
    const kind = feature.properties?.class;
    const carriage = isCarriageway(kind);
    if (!carriage && !FOOTWAYS.includes(kind)) continue;
    // A light over a road that runs under the river is a painting error, and the same rule already keeps the far-field
    // ribbons off tunnels.
    if (feature.properties?.brunnel === 'tunnel') continue;
    const lines = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    for (const ring of lines) {
      for (const kept of insideRadius(ring, origin, radius)) {
        const line = polyline(kept);
        // `oneway` as the snapshot left it: OSM saying both ways, and OSM saying nothing, both get the two counter-
        // flowing lanes a city street actually shows.
        const both = feature.properties?.oneway !== true;
        const seed = (Number(feature.properties.osmId) || 0) * 8191;
        // 这条 way 要是被我们挤成了桥体，车就得站在桥面顶上；表里没有的就是 0（地面）。
        const deck = decks?.heightOf(feature) ?? 0;
        // 这一段离原点有多远，取它所有顶点的平均位置：一条被圆裁过的路可能一头近一头远，按整段算够用。
        // 不能取"第 n/2 个顶点"——两个点的一小段会取到端点，于是整段被当成在远处，间距凭空大出一截。
        // `insideRadius` 交出来的已经是米制平面坐标，所以这里直接量，不再回到经纬度。
        const mean = kept.reduce((sum, point) => ({ x: sum.x + point.x / kept.length, y: sum.y + point.y / kept.length }), { x: 0, y: 0 });
        const thin = Math.max(1, Math.hypot(mean.x, mean.y) / TRAFFIC_THIN_FROM_METRES);
        if (carriage) {
          if (line.length < CAR_MIN_METRES) continue;
          for (let distance = 0, step = 0; distance + 4 < line.length; step += 1) {
            const gap = spaced(CAR_GAP * thin, seed + step);
            cars.push({ line, at: wrapped(distance, line.length), speed: speedOf(kind), sign: 1, offset: LANE_OFFSET, class: kind, osmId: feature.properties.osmId, deck });
            // The returning flow is started half a gap along, so the two streams interleave rather than meeting in pairs.
            if (both) cars.push({ line, at: wrapped(distance + gap / 2, line.length), speed: speedOf(kind), sign: -1, offset: LANE_OFFSET, class: kind, osmId: feature.properties.osmId, deck });
            distance += gap;
          }
        } else {
          if (line.length < WALK_MIN_METRES) continue;
          for (let distance = 0, step = 0; distance + 4 < line.length; step += 1) {
            // Neighbouring walkers face the other way, so a promenade shows people passing rather than a queue.
            walkers.push({ line, at: wrapped(distance, line.length), speed: WALK_SPEED, sign: step % 2 ? -1 : 1, offset: WALK_OFFSET, class: kind, osmId: feature.properties.osmId, deck });
            distance += spaced(WALK_GAP * thin, seed + step);
          }
        }
      }
    }
  }
  return { cars, walkers };
}

/**
 * Where an agent is after `seconds`: it walks its line and wraps, so a long session never leaves the road.
 *
 * @param {object} agent one entry from `trafficAgents`
 * @param {number} seconds
 */
export function agentPosition(agent, seconds) {
  const travelled = wrapped(agent.at + agent.speed * seconds * agent.sign, agent.line.length);
  const place = agent.line.at(travelled);
  const offset = agent.sign * agent.offset;
  return {
    x: place.x + place.side.x * offset,
    y: place.y + place.side.y * offset,
    dir: { x: -place.side.y * agent.sign, y: place.side.x * agent.sign },
    travelled,
  };
}

// 车身、灯、人都是量出来的米数，不再是一颗点。
export const CAR_LENGTH_METRES = 4.5;
export const CAR_WIDTH_METRES = 1.8;
export const CAR_HEIGHT_METRES = 1.45;
// 第二档尺度：公交。三边都是按真实单车给的（10.5 × 2.5 × 3.0 m），但**不给它另做一份几何**——
// 这一格要的是"街上不止一种尺度的车"，不是给公交建模，所以两档共用同一份车身几何、同一个 `InstancedMesh`、
// 同一个 draw call，差别全写在实例的 scale 上（长 2.33 倍、高 2.07 倍、宽 1.39 倍）。
// 代价说清楚：公交的"舱"会跟着车身一起变长，读起来更像中巴而不是箱式大巴；近景那四片灯面倒是自动落到加长的两头。
export const BUS_LENGTH_METRES = 10.5;
export const BUS_WIDTH_METRES = 2.5;
export const BUS_HEIGHT_METRES = 3.0;
// 公交只跑这五级（含高速，那是长途大巴的路）：`service`/`residential`/`living_street` 那些巷子里挤不进一辆十米半的车。
export const BUS_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
// 占比按"这一级路上十分钟能不能撞见一辆公交"给：一条线路 5~8 分钟一班、站距 500 m，摊进 100 m 间距的车流里
// 就是十分之一上下。真实全样本里公交只占 2~3 %（小汽车才是分母），但这一档镜头里的分母是我们画出来的那 1,298 辆，
// 取 6 % 时默认机位一眼扫过去只有两三辆第二尺度——用户 2026-10-04 对第 1 项的原话是「没啥变化」，别再犯一次。
export const BUS_SHARE = 0.1;
// 广州公交那两色：绿与蓝。给公交单独一组色是"两档尺度"能在画面里读出来的另一半——同色同尺才看得出是两档。
export const BUS_COLOURS = ['#1f7a4d', '#2b5f96'];
/**
 * 这一辆算不算公交：只看路等级与一个稳定哈希，所以刷新一次不会换车。
 * `index` 进来是因为同一条 way 上的车要能分开——只按 osmId 掷骰会让一条路上要么全公交要么全无。
 */
export const isBusAgent = (agent, index) => BUS_CLASSES.includes(agent.class)
  && scatter(Math.abs(Number(agent.osmId) || 0) * 131 + index * 17) < BUS_SHARE;
/** 一辆车的三边倍率与真实米数：轿车是 1，公交是上面那三个比值。 */
export function vehicleShape(agent, index) {
  if (!isBusAgent(agent, index)) {
    return { bus: false, x: 1, y: 1, z: 1, length: CAR_LENGTH_METRES, width: CAR_WIDTH_METRES, height: CAR_HEIGHT_METRES };
  }
  return {
    bus: true,
    x: BUS_LENGTH_METRES / CAR_LENGTH_METRES,
    y: BUS_HEIGHT_METRES / CAR_HEIGHT_METRES,
    z: BUS_WIDTH_METRES / CAR_WIDTH_METRES,
    length: BUS_LENGTH_METRES,
    width: BUS_WIDTH_METRES,
    height: BUS_HEIGHT_METRES,
  };
}
// 灯珠在车顶之上再抬 0.4 m（车顶上表面是 1.6 m × 倍率）。不抬就会被自己的车身在深度缓冲里挡掉：
// 实测 700 m 那一格只剩 31 个亮点，门槛 100。近景真正说得清前后的是 `traffic-lamp-quads` 那四片面。
export const CAR_LAMP_METRES = 0.4;
export const CAR_SIZE = 12;
export const CAR_CABIN_SHARE = 0.52;
export const CAR_CABIN_RAISE_METRES = 0.42;
export const WALKER_HEIGHT_METRES = 1.75;
export const WALKER_WIDTH_METRES = 0.5;
// 画出来的倍率：几何仍然是 1.75 m 的真高，只是这一档镜头里 1.75 m 只有一两个像素，放大倍率是给"人"这一档
// 单独留的。量过的数（引擎自己的 screen() 投影，花城广场那一点）：18.5 级 1.75 m = 8.0 px、16.5 级 = 2.0 px、
// 15.5 级 = 1.0 px。取 1.8 之后街景那一档是 14.4 px——够读出"一个人"，又不至于在 15 m 高的机位下变成巨人。
export const WALKER_DRAW_SCALE = 1.8;
// 脚底下那一片影的半径（米）。一个人站开的两只脚约 0.5 m 见方，取 0.3 是"贴着脚、不糊成人形"的那一档；
// 它跟着 `boost` 与上面那 1.8 倍一起放大，否则远镜头里人被放大而影子还是一个针尖。
export const WALKER_PAD_METRES = 0.3;
// 衣服颜色按 agent 自己决定（osmId + 序号），所以刷新一次不会换一批人；全是同一个色就会读成一排棋子。
export const WALKER_COLOURS = ['#d9dde1', '#3c4756', '#8d4b45', '#2f343a', '#b9925a', '#5f7361', '#7c6f9c'];
const walkerColourAt = (agent, index) => WALKER_COLOURS[(Math.abs(Number(agent.osmId) || 0) * 17 + index * 5) % WALKER_COLOURS.length];
// 远近两档：到 TRAFFIC_ZOOM_REAL 以上是真实尺度，退到 TRAFFIC_ZOOM_FLOOR 放大 TRAFFIC_FAR_BOOST 倍。
// 这条倍率是量出来的：15.5 级一屏像素约 1.6 m，4.5 m 的车只有 2.8 px，而它替掉的那批点在屏幕上约 12 px——
// 不给倍率就等于把已经看得见的车流又变回看不见。倍率随 zoom 线性插值，所以没有"到某一级突然从点变盒子"。
export const TRAFFIC_ZOOM_REAL = 17;
export const TRAFFIC_ZOOM_FLOOR = 14;
export const TRAFFIC_FAR_BOOST = 4;
// 行人 1.75 m，在 16.5 级以下连一个像素都不到，上屏只会变成噪点，所以那一档以下不画。
export const WALKER_MIN_ZOOM = 16.5;
// 灯珠跟车体是反的：越远越要收。14 级一屏像素约 8 m，一辆车是一个都不到的点，而 1,981 颗加色灯珠摊在路面上
// 就是"一串亮点"——量到的正是这个：高空位（13.6）第 8 档路面中位从 48.6 被抬到 52.1，越过它自己的 38~52。
// 那一档上"街上有车流"本来就是第 5 档那两条光轨的活（同机位实测中位 53.1，合规），所以 15 级给满、14 级以下全收。
export const TRAFFIC_LAMP_ZOOM_FULL = 15;
export const TRAFFIC_LAMP_ZOOM_FLOOR = 14;

/** 灯珠的分量：15 级以上 1，14 级以下 0，中间线性。 */
export function trafficLampShare(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(1, Math.max(0,
    (zoom - TRAFFIC_LAMP_ZOOM_FLOOR) / (TRAFFIC_LAMP_ZOOM_FULL - TRAFFIC_LAMP_ZOOM_FLOOR)));
}

/** 车体倍率：17 级 1 倍，14 级 4 倍，中间线性。 */
export function trafficScale(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  const at = Math.min(1, Math.max(0, (TRAFFIC_ZOOM_REAL - zoom) / (TRAFFIC_ZOOM_REAL - TRAFFIC_ZOOM_FLOOR)));
  return 1 + at * (TRAFFIC_FAR_BOOST - 1);
}

const box = (width, height, depth, x, y, z) => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return geometry;
};

/**
 * 一辆车：底盘加驾驶舱两道台阶，车头朝 +x。
 *
 * 两个盒子合成一份几何，所以一条街上的几百辆车是一个 InstancedMesh、一个 draw call。
 */
export function carGeometry() {
  const body = box(CAR_LENGTH_METRES, CAR_HEIGHT_METRES - CAR_CABIN_RAISE_METRES, CAR_WIDTH_METRES,
    0, (CAR_HEIGHT_METRES - CAR_CABIN_RAISE_METRES) / 2 + 0.15, 0);
  const cabin = box(CAR_LENGTH_METRES * CAR_CABIN_SHARE, CAR_CABIN_RAISE_METRES, CAR_WIDTH_METRES * 0.86,
    -CAR_LENGTH_METRES * 0.06, CAR_HEIGHT_METRES - CAR_CABIN_RAISE_METRES / 2 + 0.15, 0);
  const parts = [body, cabin];
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  return merged;
}

/**
 * 车头与车尾的灯：四片小面，前白后红，顶点色带过去。
 *
 * 形状给了车体，可是真实尺寸的头灯在 700 m 外连一个像素都不到，夜景那条"街上有点亮"的读感不能靠它。
 * 所以夜里还有一层加色点云（`traffic-lamps` 那份 sprite 云），它跟着车体同一批位置走；`traffic-lamp-quads`
 * 这四片小面在近景（17 级以上）才真的读得出前后。
 */
export function carLampGeometry() {
  const nose = CAR_LENGTH_METRES / 2 - 0.05;
  const tail = -nose;
  const half = CAR_WIDTH_METRES / 2 - 0.25;
  const colours = [];
  const positions = [];
  const quad = (x, z, rgb) => {
    const y0 = 0.55;
    const y1 = 0.85;
    const w = 0.22;
    positions.push(x, y0, z - w, x, y0, z + w, x, y1, z + w);
    positions.push(x, y0, z - w, x, y1, z + w, x, y1, z - w);
    for (let i = 0; i < 6; i++) colours.push(...rgb);
  };
  // 顶点色走线性空间，所以直接从那两个 hex 取 Color 的分量，而不是自己估一组 0~1。
  const lampColour = (hex) => { const colour = new THREE.Color(hex); return [colour.r, colour.g, colour.b]; };
  const white = lampColour(HEADLIGHT);
  const red = lampColour(TAILLIGHT);
  quad(nose, -half, white);
  quad(nose, half, white);
  quad(tail, -half, red);
  quad(tail, half, red);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 一个人：躯干加头，两段的宽度差就是那个能认出来的剪影。 */
export function walkerGeometry() {
  const torso = box(WALKER_WIDTH_METRES, WALKER_HEIGHT_METRES - 0.24, WALKER_WIDTH_METRES * 0.62,
    0, (WALKER_HEIGHT_METRES - 0.24) / 2 + 0.05, 0);
  const head = box(0.22, 0.24, 0.22, 0, WALKER_HEIGHT_METRES - 0.12, 0);
  const parts = [torso, head];
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  return merged;
}

// 车身色按 agent 自己决定（osmId + 序号），所以刷新一次不会换一批颜色。公交走另一组两色：同色同尺才看得出是两档。
const CAR_COLOURS = ['#c8ccd2', '#8d939b', '#3d434c', '#b5563f', '#e4e6e9', '#5c6874', '#2f3540'];
const carColourAt = (agent, index) => {
  const palette = isBusAgent(agent, index) ? BUS_COLOURS : CAR_COLOURS;
  const seed = (Math.abs(Number(agent.osmId) || 0) * 31 + index * 7) % palette.length;
  return palette[seed];
};

/**
 * 一颗柔光圆点，给夜景那层加色车用。裸 `POINTS` 是方的，会读成一堆方块。
 *
 * 它是白的：材质色与每辆车自己的顶点色才是给它上色的东西，所以一张图同时够头灯与尾灯用。
 * 只有浏览器要它——测试与没有 canvas 的页面传 `sprite: null`。
 */
export function trafficSprite({ size = 64 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.24, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * 近场的车与人，一组实例网格，站在塔那套米制坐标系里（+x 东、+z 南）。
 *
 * 每帧在 CPU 上重算变换：一千个实例的矩阵更新，比起一个 stepped paint property 的重新三角化不算什么，
 * 而这才是让车流连续走（而不是 `line-dasharray` 那种一秒两步）的办法。
 */
export function createTrafficLife({ features, origin, radius = TRAFFIC_LIFE_RADIUS, sprite = null, decks = null, junctions = null } = {}) {
  const group = new THREE.Group();
  group.name = 'traffic-life';
  const { cars, walkers } = trafficAgents(features, origin, radius, decks);
  // 灯与停止线接在车身上：一条线上的车按"到停止线的先后"排队，所以 `assignSignals` 必须在 agent 造好之后跑。
  const signalled = junctions?.length ? assignSignals(junctions, cars) : 0;
  // 杆、灯头、停止线挂在**这一组里面**：透视镜与"读像素先藏近场"那几条门槛因此自动覆盖它们。
  const props = signalled ? createSignalProps({ junctions }) : null;
  const body = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.4 });
  const vehicles = new THREE.InstancedMesh(carGeometry(), body, cars.length);
  vehicles.name = 'traffic-cars';
  vehicles.frustumCulled = false;
  const lamps = new THREE.InstancedMesh(carLampGeometry(), new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }), cars.length);
  lamps.name = 'traffic-lamp-quads';
  lamps.frustumCulled = false;
  // 夜景那一层加色点：还是 12 px 的那一档，离远了它就是头灯与尾灯本身。
  const glowGeometry = new THREE.BufferGeometry();
  glowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cars.length * 3), 3));
  const glowColours = new THREE.BufferAttribute(new Float32Array(cars.length * 3), 3);
  glowGeometry.setAttribute('color', glowColours);
  const glow = new THREE.Points(glowGeometry, new THREE.PointsMaterial({
    size: CAR_SIZE, color: '#ffffff', transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, vertexColors: true, map: sprite ?? null,
  }));
  glow.name = 'traffic-lamps';
  glow.frustumCulled = false;
  glow.userData.agents = cars;
  glow.userData.height = CAR_LAMP_METRES;
  const people = new THREE.InstancedMesh(walkerGeometry(), new THREE.MeshStandardMaterial({
    roughness: 0.8, metalness: 0,
  }), walkers.length);
  people.name = 'traffic-walkers';
  people.frustumCulled = false;
  group.add(vehicles, lamps, glow, people);
  if (props) group.add(props.group);
  vehicles.userData.agents = cars;
  people.userData.agents = walkers;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();
  // 车底下那一片影：与车同一次 `advance` 里摆，用同一个 `atan2(dir.y, dir.x)` 转，
  // 所以一辆横着的车下面不会是一条竖着的影。行人的贴片排在车的那一批后面，镜头退到行人那一档以下
  // 就干脆不写进去（`pads.finish()` 数到车那一半为止），免得到处是没有人也没有车的黑点。
  const pads = createPads({ name: 'traffic-shadow-pads', count: cars.length + walkers.length });
  group.add(pads.mesh);
  // `agent.deck` 是装配时定死的（来自桥面表），所以每一拍的离地米数不必再回对象上取。
  const carDecks = cars.map((agent) => agent.deck ?? 0);
  const walkerDecks = walkers.map((agent) => agent.deck ?? 0);
  // 两档尺度同样在装配时定死：按 osmId 与序号各掷一次哈希，所以刷新一次不会有一辆车突然变长。
  const shapes = cars.map(vehicleShape);
  vehicles.userData.shapes = shapes;
  // `polyline.at()` 里那一次 `findIndex` 是整条线的长度级的，一辆车一拍原本要算三遍（车身、灯带、灯珠）；
  // 现在多了影子是四遍。所以位置每拍只算一次，四批写入共用同一份。
  // 红灯那一笔也在这一句里：车自己的钟要扣掉它在停止线前白等的秒数（`signalLost` 是纯函数，
  // 同一秒在两条渲染路径上算出同一个位置，所以引擎并排比读数那条判据仍然成立）。
  const spotsOf = (agents, seconds) => agents.map((agent) => agentPosition(agent, seconds - signalLost(agent.signal, seconds)));
  const yawOf = (where) => Math.atan2(where.dir.y, where.dir.x);
  let reach = 0;
  const placeGlow = (spots, view) => {
    const buffer = glowGeometry.getAttribute('position');
    const shades = glowColours.array;
    spots.forEach((where, index) => {
      const toward = -(where.dir.x * view.x + where.dir.y * view.y);
      const colour = toward >= 0 ? head : tail;
      // 灯放在"朝着镜头的那一头"外面 0.3 m：迎面来的是车头、背身去的是车尾，所以这一颗永远在自己的车身前面，
      // 不会被车体挡掉——车有了形状之后，这一点是这层光还能数得出来的前提。公交那一档车身长一倍多，两头也跟着外移。
      const end = (toward >= 0 ? 1 : -1) * (shapes[index].length / 2 + 0.3);
      // 高度要跟着倍率走：远镜头下车体本身被放大到两三倍高（不放大就看不见形状），灯珠留在 1.9 m 就会被
      // 自己那辆被放大的车吞掉——实测 700 m 那一格只剩 31 个亮点，门槛是 100。
      buffer.setXYZ(index, where.x + where.dir.x * end, (shapes[index].height + 0.15) * boost + CAR_LAMP_METRES + carDecks[index],
        -(where.y + where.dir.y * end));
      shades[index * 3] = colour.r;
      shades[index * 3 + 1] = colour.g;
      shades[index * 3 + 2] = colour.b;
    });
    buffer.needsUpdate = true;
    glowColours.needsUpdate = true;
  };
  const place = (mesh, spots, size, decks, shapes = null) => {
    spots.forEach((where, index) => {
      // 第二个参数是离地米数：桥上的车要站在桥面顶上（`deckHeights` 给的那个数），其余仍是 0。
      position.set(where.x, decks[index], -where.y);
      spin.setFromAxisAngle(up, yawOf(where));
      // 两档尺度写在实例的 scale 上（同一份车身几何）：不给人传 `shapes`，所以人还是等比的。
      const shape = shapes?.[index];
      scale.set(size * (shape?.x ?? 1), size * (shape?.y ?? 1), size * (shape?.z ?? 1));
      matrix.compose(position, spin, scale);
      mesh.setMatrixAt(index, matrix);
      reach = Math.max(reach, Math.hypot(where.x, where.y));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.count = spots.length;
  };
  const placePads = (carSpots, walkerSpots, showWalkers) => {
    const spread = PAD_SPREAD * boost;
    carSpots.forEach((where, index) => pads.place({
      x: where.x, y: where.y, deck: carDecks[index], yaw: yawOf(where),
      // 影子的长轴压的是**这一辆**的长：公交那片比轿车长一倍多，全用 4.5 m 就是"车比影长"。
      radiusX: shapes[index].length / 2 * spread, radiusY: shapes[index].width / 2 * spread,
    }));
    if (showWalkers) {
      walkerSpots.forEach((where, index) => pads.place({
        x: where.x, y: where.y, deck: walkerDecks[index], yaw: yawOf(where),
        radiusX: WALKER_PAD_METRES * boost * WALKER_DRAW_SCALE, radiusY: WALKER_PAD_METRES * boost * WALKER_DRAW_SCALE,
      }));
    }
    pads.finish();
  };
  cars.forEach((agent, index) => vehicles.setColorAt(index, colour.set(carColourAt(agent, index))));
  if (vehicles.instanceColor) vehicles.instanceColor.needsUpdate = true;
  // 行人同理：一件"衣服色"按 osmId 与序号定死，刷新不会换人，也不会站成一排同色棋子。
  walkers.forEach((agent, index) => people.setColorAt(index, colour.set(walkerColourAt(agent, index))));
  if (people.instanceColor) people.instanceColor.needsUpdate = true;

  const head = new THREE.Color(HEADLIGHT);
  const tail = new THREE.Color(TAILLIGHT);
  const viewOf = (bearing) => ({ x: Math.sin(bearing * Math.PI / 180), y: Math.cos(bearing * Math.PI / 180) });
  let clock = 0;
  let zoom = null;
  let facing = 0;
  let lit = 0;
  // 倍率是灯珠高度的一部分（见 placeGlow），所以它存在这里，而不是只活在 advance 的参数里：
  // 镜头转动那一笔只重排颜色，不能顺手把灯按回 1 倍的高度上——那样远镜头下它们又钻回车身里去了。
  let boost = 1;
  /**
   * 走一格。
   *
   * @param {number} seconds 车流开启以来的秒数
   * @param {number} viewZoom 地图层级，决定车与人的倍率与行人是否上屏
   */
  const advance = (seconds, viewZoom = TRAFFIC_ZOOM_REAL) => {
    clock = seconds;
    zoom = viewZoom;
    boost = trafficScale(viewZoom);
    const walking = !(viewZoom > 0) || viewZoom >= WALKER_MIN_ZOOM;
    const spots = spotsOf(cars, seconds);
    const strolling = spotsOf(walkers, seconds);
    place(vehicles, spots, boost, carDecks, shapes);
    place(lamps, spots, boost, carDecks, shapes);
    place(people, strolling, boost * WALKER_DRAW_SCALE, walkerDecks);
    placeGlow(spots, viewOf(facing));
    paintLight();
    // 行人 1.75 m，在 16.5 级以下连一像素都不到：那一档以下整组收掉，不是调暗。
    people.visible = walking;
    placePads(spots, strolling, walking);
    // 灯头跟着同一拍：它读的是同一个绝对秒，所以两条渲染路径在同一秒给出同一个颜色。
    props?.advance(seconds);
  };
  // 开关那边给的是布尔（夜景 on/off），动效那边将来给的是 0~1 的走过比例，两种都收。
  const setLit = (share) => {
    lit = share === true ? 1 : share === false ? 0 : Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0;
    paintLight();
    props?.setLit(lit);
  };
  // 亮的分量是"夜景走到哪了"与"镜头退到哪了"两件事的积：前者跟着氛围走，后者把远镜头下的灯珠交还给光轨。
  const paintLight = () => {
    const share = lit * trafficLampShare(zoom);
    lamps.material.opacity = share;
    lamps.visible = share > 0.02;
    glow.material.opacity = share;
    glow.visible = share > 0.02;
  };
  advance(0, TRAFFIC_ZOOM_REAL);
  setLit(0);
  return {
    group,
    counts: { cars: cars.length, walkers: walkers.length },
    // 灯的底账：装上了灯的进口道条数与几何台数，面板与判据读这一格。
    signals: props?.report ?? null,
    advance,
    /**
     * 把层级交进来：倍率与"行人画不画"都跟着它走，所以这一笔必须在**画的那一帧**做，而不是只在动效时钟里做。
     * 与壳体的 `recede(zoom)` 同一个理由：载入那一帧、跑过又停下那一帧、以及从没动过的页面，必须落在同一个画面上。
     */
    setZoom(next) {
      if (!Number.isFinite(next) || (zoom !== null && Math.abs(next - zoom) < 0.02)) return false;
      advance(clock, next);
      return true;
    },
    setLit,
    // 车与人在白昼也在场（它们是模型，不是灯），所以整组一直可见；只有灯跟夜景。
    setVisible(on) {
      group.visible = Boolean(on);
    },
    // 车头朝哪一边亮着，是镜头决定的：朝你来是白灯、背你去是红灯。这一笔必须在画的那一帧读，
    // 否则"从没动过的页面"与"跑过又停下的页面"会按两个 bearing 排灯，逐字节比对当场挂。
    faceCamera(bearing) {
      if (Math.abs(bearing - facing) < 0.5) return false;
      facing = bearing;
      placeGlow(spotsOf(cars, clock), viewOf(bearing));
      return true;
    },
    reach() {
      return Math.round(reach);
    },
    /**
     * teardown：这一组自己造的几何与材质自己还。
     * 那颗光晕贴图（`sprite`）是调用方造好递进来的，不归这一层收——两条渲染路径共用它，谁建谁还。
     * `InstancedMesh.dispose()` 只还实例缓冲，几何与材质要各自点名，所以三样都写。
     */
    dispose() {
      for (const mesh of [vehicles, lamps, people]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }
      glowGeometry.dispose();
      glow.material.dispose();
      pads.dispose();
      props?.dispose();
      group.clear();
    },
    // 给判据看的一眼：这一组是什么、有多少、灯到不到得了。
    parts() {
      return {
        vehicles: {
          instances: vehicles.count,
          geometry: vehicles.geometry.getAttribute('position').count,
          // 两档尺度的账：`buses` 是这一场里公交那一档有几辆，实例数不变所以 `instances` 不跟着它动。
          buses: shapes.reduce((sum, shape) => sum + (shape.bus ? 1 : 0), 0),
          // 有几个进口道真的接上了灯（`assignSignals` 数出来的），判据与面板读这一格。
          approaches: signalled,
        },
        lamps: { instances: lamps.count, visible: glow.visible, opacity: glow.material.opacity },
        people: { instances: people.count, visible: people.visible },
        // 影子的台数是"车 + 在场的人"，所以它自己就能说明"人退场时影子没留下一片黑点"。
        pads: { instances: pads.mesh.count, opacity: pads.mesh.material.opacity },
        // 灯杆/灯头/停止线：没有路口时这一格是 null，判据据此分"装了灯"与"没装灯"两条路。
        signals: props?.parts() ?? null,
        lit, clock, zoom,
      };
    },
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  BUS_CLASSES, BUS_COLOURS, BUS_HEIGHT_METRES, BUS_LENGTH_METRES, BUS_SHARE, BUS_WIDTH_METRES,
  CARRIAGEWAYS, CAR_CABIN_RAISE_METRES, CAR_CABIN_SHARE, CAR_GAP, CAR_HEIGHT_METRES, CAR_LENGTH_METRES, CAR_MIN_METRES, CAR_SPEED,
  CAR_WIDTH_METRES, FOOTWAYS, HEADLIGHT, LANE_OFFSET, RAMPS, TAILLIGHT, TRAFFIC_LIFE_RADIUS, TRAFFIC_FAR_BOOST,
  TRAFFIC_LAMP_ZOOM_FLOOR, TRAFFIC_LAMP_ZOOM_FULL,
  TRAFFIC_THIN_FROM_METRES, TRAFFIC_ZOOM_FLOOR, TRAFFIC_ZOOM_REAL, WALK_GAP, WALK_MIN_METRES, WALK_OFFSET,
  WALKER_COLOURS, WALKER_DRAW_SCALE, WALKER_HEIGHT_METRES, WALKER_MIN_ZOOM, WALKER_PAD_METRES,
  agentPosition, carGeometry, carLampGeometry, createTrafficLife, deckHeights, insideRadius, isBusAgent, trafficAgents, trafficLampShare,
  trafficScale, vehicleShape, walkerGeometry,
} from '../src/traffic-life.js';
import { PAD_LIFT_METRES, PAD_SPREAD } from '../src/shadow-pads.js';
import { DEFAULT_CENTER } from '../src/config.js';
import { plane } from '../src/geo.js';

const streets = JSON.parse(readFileSync(new URL('../public/data/canton-streets.geojson', import.meta.url), 'utf8'));

/**
 * A point `east`/`north` metres from the tower, as [lng, lat].
 *
 * Solved rather than computed, because `plane` is what the code under test measures with: a fixture has to land where
 * that function says it lands, or the assertions would be checking the test's own arithmetic.
 */
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

/** A way out of local metre endpoints, dressed with whatever OSM attributes the case needs. */
const way = (points, properties = {}) => ({
  type: 'Feature',
  properties: { osmId: 1, class: 'secondary', oneway: null, brunnel: null, ...properties },
  geometry: { type: 'LineString', coordinates: points.map(([east, north]) => pointAt(east, north)) },
});
const channelOf = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const lengthOf = (points) => points.reduce((total, point, index) => index ? total + Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) : 0, 0);
const at3 = (values, index) => [values[index * 3], values[index * 3 + 1], values[index * 3 + 2]];
// The clouds are Float32 buffers, so every comparison against a number the drawing declares goes through a tolerance
// that is the storage's own, not the scene's: 1e-5 m is a hundredth of a millimetre.
const within = (actual, expected, label, epsilon = 1e-5) => {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: ${actual} is not within ${epsilon} of ${expected}`);
};
const showColour = (values, hex, label) => {
  const want = channelOf(hex);
  values.forEach((value, index) => within(value, want[index], `${label} channel ${index}`));
};

test('the radius is cut where the circle is, not where the next OSM node happens to be', () => {
  // A road that runs 4 km through the tower's foot: the piece the near field may use is the 2 km chord inside the
  // circle, and it starts on the circle rather than at the way's own end vertex.
  const pieces = insideRadius(way([[-2000, 0], [2000, 0]]).geometry.coordinates, DEFAULT_CENTER, 1000);
  assert.equal(pieces.length, 1, 'one crossing, one piece');
  const [a, b] = pieces[0];
  assert.ok(Math.abs(Math.hypot(a.x, a.y) - 1000) < 0.5, `a piece starts on the circle, got ${Math.hypot(a.x, a.y)} m`);
  assert.ok(Math.abs(Math.hypot(b.x, b.y) - 1000) < 0.5, `and ends on it, got ${Math.hypot(b.x, b.y)} m`);
  assert.ok(Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 2000) < 1, 'a diameter chord is exactly two radii long');

  // A way that leaves the circle and comes back: two pieces, and nothing joining them across the empty middle.
  const horseshoe = [[-1500, 0], [-400, 0], [-400, 1500], [400, 1500], [400, 0], [1500, 0]];
  const parts = insideRadius(way(horseshoe).geometry.coordinates, DEFAULT_CENTER, 1000);
  assert.equal(parts.length, 2, 'the two arms of the horseshoe are two lines, not one that jumps the gap');
  for (const part of parts) {
    for (const point of part) {
      assert.ok(Math.hypot(point.x, point.y) <= 1000.5, `every point kept is inside the radius, got ${Math.hypot(point.x, point.y)} m`);
    }
    assert.ok(part.length > 2, 'an arm that turns a corner keeps its corner');
  }
  const far = [[1200, 1200], [1400, 1400], [1600, 1200]];
  assert.deepEqual(insideRadius(way(far).geometry.coordinates, DEFAULT_CENTER, 1000), [], 'a way that never enters the radius keeps nothing');
});

test('a way carries traffic at the spacing the drawing gives it, on both sides of the street', () => {
  const twoWay = trafficAgents([way([[-900, 0], [900, 0]])], DEFAULT_CENTER);
  const oneWay = trafficAgents([way([[-900, 0], [900, 0]], { oneway: true })], DEFAULT_CENTER);
  assert.ok(oneWay.cars.length > 1, 'the line is long enough to carry a stream');
  assert.equal(twoWay.cars.length, oneWay.cars.length * 2, 'an unmarked street gets the returning flow as well');
  assert.deepEqual([...new Set(twoWay.cars.map((car) => car.sign))].sort(), [-1, 1], 'the two flows run opposite ways along the same line');
  assert.ok(twoWay.cars.every((car) => car.offset === LANE_OFFSET), 'both flows are half a carriageway off the centre');
  const forward = twoWay.cars.filter((car) => car.sign === 1).map((car) => car.at).sort((a, b) => a - b);
  const back = twoWay.cars.filter((car) => car.sign === -1).map((car) => car.at).sort((a, b) => a - b);
  const steps = forward.slice(1).map((at, index) => at - forward[index]);
  assert.ok(steps.every((gap) => gap > CAR_GAP * 0.55 && gap < CAR_GAP * 1.45),
    `every gap stays near the ${CAR_GAP} m spacing, got ${steps.map((gap) => Math.round(gap)).join(' ')}`);
  assert.ok(new Set(steps.map((gap) => Math.round(gap))).size > 1, 'and the spacing is not metronomic, which is what reads as beads on a string');
  assert.ok(back[0] > forward[0] && back[0] < forward[1], 'the returning flow starts between two vehicles, so the streams interleave');

  // The scatter is a function of the way and the place on it, not of the order the file happened to be read in: a
  // reload has to put the same car back in the same spot, or every pixel claim about this scene is one dice roll.
  const again = trafficAgents([way([[-900, 0], [900, 0]])], DEFAULT_CENTER);
  assert.deepEqual(again.cars.map((car) => car.at), twoWay.cars.map((car) => car.at), 'the same way scatters the same way twice');

  // The same distance down the same line, one flow each way: a street is wide enough for two, and this is what keeps a
  // two-way road from drawing one stream on top of the other.
  const paired = twoWay.cars.find((car) => car.sign === 1);
  const apart = agentPosition(paired, 0);
  const against = agentPosition({ ...paired, sign: -1 }, 0);
  assert.ok(Math.abs(Math.hypot(apart.x - against.x, apart.y - against.y) - LANE_OFFSET * 2) < 0.01,
    `the two flows are ${LANE_OFFSET * 2} m apart across the carriageway, got ${Math.hypot(apart.x - against.x, apart.y - against.y)} m`);
  assert.ok(RAMPS.every((class_) => class_.endsWith('_link')), 'a ramp is the link of a carriageway');
  assert.ok(!FOOTWAYS.some((class_) => CARRIAGEWAYS.includes(class_)), 'no class is both a road and a footway');
});

test('speed is the road it is on, and a ramp is its parent road one storey up', () => {
  const driven = (kind, seconds = 1) => {
    const { cars } = trafficAgents([way([[-900, 0], [900, 0]], { class: kind, oneway: true })], DEFAULT_CENTER);
    const car = cars[0];
    return { car, moved: agentPosition(car, seconds).travelled - car.at };
  };
  const trunk = driven('trunk');
  const alley = driven('service');
  assert.ok(Math.abs(trunk.moved - CAR_SPEED.trunk) < 0.01, `a trunk carries ${CAR_SPEED.trunk} m/s, got ${trunk.moved}`);
  assert.ok(Math.abs(alley.moved - CAR_SPEED.service) < 0.01, `an alley carries ${CAR_SPEED.service} m/s, got ${alley.moved}`);
  assert.equal(driven('trunk_link').moved, trunk.moved, 'a ramp is the same traffic');
  assert.equal(driven('unclassified').moved, 7, 'a lane OSM calls unclassified is a city street');

  // Wrapping never leaves the line: the distance is always inside the piece the agent belongs to, forwards or backwards.
  for (const seconds of [0, 1, 7.5, 4000, -12.5]) {
    const at = agentPosition(trunk.car, seconds).travelled;
    assert.ok(at >= 0 && at < trunk.car.line.length, `${seconds} s puts a car at ${at} m, outside its ${trunk.car.line.length} m line`);
  }
  const ahead = agentPosition(trunk.car, 30);
  const back = agentPosition({ ...trunk.car, sign: -1 }, 30);
  assert.ok(Math.hypot(ahead.x - back.x, ahead.y - back.y) > 1, 'the two flows of one street are never at the same point');
  assert.ok(Math.abs(Math.hypot(ahead.dir.x, ahead.dir.y) - 1) < 1e-6, 'the direction an agent reports is a unit vector');
});

test('a short stub carries nobody, and a tunnel carries nothing at all', () => {
  assert.equal(trafficAgents([way([[-15, 0], [15, 0]])], DEFAULT_CENTER).cars.length, 0,
    `a piece of road shorter than ${CAR_MIN_METRES} m is not a street with traffic on it`);
  assert.equal(trafficAgents([way([[-25, 0], [25, 0]], { class: 'footway' })], DEFAULT_CENTER).walkers.length, 0,
    `a piece of footway shorter than ${WALK_MIN_METRES} m is not a promenade`);
  assert.deepEqual(trafficAgents([way([[-900, 0], [900, 0]], { brunnel: 'tunnel' })], DEFAULT_CENTER), { cars: [], walkers: [] },
    'a road under the river gets no light over it');

  const { walkers } = trafficAgents([way([[-900, 0], [900, 0]], { class: 'footway' })], DEFAULT_CENTER);
  assert.deepEqual(walkers.slice(0, 3).map((walker) => walker.sign), [1, -1, 1],
    'neighbouring walkers face the other way, so a promenade shows people passing rather than a queue');
  assert.ok(walkers.every((walker) => walker.offset === WALK_OFFSET), 'a walker is off the centre by a pavement step, not a carriageway half');
  assert.equal(walkers[0].at, 0, 'the first walker stands at the way’s own start');
  assert.ok(walkers[1].at > WALK_GAP * 0.55 && walkers[1].at < WALK_GAP * 1.45,
    `the next is about ${WALK_GAP} m along the promenade, got ${Math.round(walkers[1].at)} m`);
});

const instanceAt = (mesh, index) => new THREE.Matrix4().fromArray(mesh.instanceMatrix.array.slice(index * 16, index * 16 + 16));
const decomposed = (mesh, index) => {
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  instanceAt(mesh, index).decompose(position, spin, scale);
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(spin);
  return { position, forward, size: scale.x };
};
// 实例的 `scale.x` 里同时装着"镜头倍率"与"这一辆是轿车还是公交"两件事，所以读倍率要先把它自己那一档除掉。
const boostOf = (mesh, index) => decomposed(mesh, index).size / (mesh.userData.shapes?.[index]?.x ?? 1);

test('近场是一组实例模型，站在塔那套米制系里，并且真的按快照铺满', () => {
  const life = createTrafficLife({ features: streets.features, origin: DEFAULT_CENTER });
  assert.deepEqual(life.group.children.map((child) => child.name),
    ['traffic-cars', 'traffic-lamp-quads', 'traffic-lamps', 'traffic-walkers', 'traffic-shadow-pads'],
    '车体、近景的四片灯面、夜景那层加色点、人、脚下那一片影——没有一颗是手放的');
  assert.equal(life.group.visible, true, '模型不是灯，白昼也该在场');
  assert.equal(life.parts().lamps.visible, false, '而车灯要等夜景');
  // 开关给的是布尔（map.js 的 lightTraffic 传的就是 true/false），写成只认数字会永远不亮。
  life.setLit(true);
  assert.equal(life.parts().lamps.visible, true, '夜景那一下要把车灯点开');
  assert.equal(life.parts().lamps.opacity, 1);
  life.setLit(false);
  assert.equal(life.parts().lamps.visible, false, '切回白昼又要收掉');
  life.setLit(0.5);
  assert.ok(Math.abs(life.parts().lamps.opacity - 0.5) < 1e-6, '走过一半时灯是半亮');
  assert.ok(life.counts.cars > 300, `${life.counts.cars} vehicles is a stream, not a scattering`);
  assert.ok(life.counts.walkers > 100, `${life.counts.walkers} walkers on the promenades`);
  const radius = TRAFFIC_LIFE_RADIUS + LANE_OFFSET;
  assert.ok(life.reach() > 900 && life.reach() <= radius, `the field reaches ${life.reach()} m out and stops there`);
  const vehicles = life.group.children.find((mesh) => mesh.name === 'traffic-cars');
  const people = life.group.children.find((mesh) => mesh.name === 'traffic-walkers');
  assert.equal(vehicles.count, life.counts.cars, '一辆车一个实例');
  assert.equal(people.count, life.counts.walkers, '一个人一个实例');
  for (const mesh of [vehicles, people]) {
    assert.equal(mesh.frustumCulled, false, 'a field measured 1 km from the tower foot cannot trust a local bounding sphere');
  }
  for (let index = 0; index < vehicles.count; index += 1) {
    const { position } = decomposed(vehicles, index);
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.z), `#${index} 在 ${JSON.stringify(position)}`);
    assert.equal(position.y, 0, `#${index} 没贴在路面上，y=${position.y}`);
    assert.ok(Math.hypot(position.x, position.z) <= radius, `#${index} 在 ${Math.round(Math.hypot(position.x, position.z))} m 外，出了近场`);
    const boost = boostOf(vehicles, index);
    assert.ok(boost > 0.99 && boost <= TRAFFIC_FAR_BOOST + 1e-6, `#${index} 的倍率 ${boost} 不在 1~${TRAFFIC_FAR_BOOST} 之间`);
  }
  // 坐标系是塔的：东为 +x、北为 -z。两条正交的合成路钉住它，翻号当场挂。
  const east = createTrafficLife({ features: [way([[200, 0], [900, 0]], { oneway: true })], origin: DEFAULT_CENTER });
  const north = createTrafficLife({ features: [way([[0, 200], [0, 900]], { oneway: true })], origin: DEFAULT_CENTER });
  const firstOf = (life2) => decomposed(life2.group.children[0], 0).position;
  assert.ok(firstOf(east).x >= 200 && Math.abs(firstOf(east).z) <= WALK_OFFSET + LANE_OFFSET, `东边应该是 +x，拿到 ${JSON.stringify(firstOf(east))}`);
  assert.ok(firstOf(north).z <= -200 && Math.abs(firstOf(north).x) <= WALK_OFFSET + LANE_OFFSET, `北边应该是 -z，拿到 ${JSON.stringify(firstOf(north))}`);

  // 倍率随层级线性走：17 级真实尺度、14 级放大 4 倍，中间没有台阶，所以不会出现"到某一级突然从点变盒子"。
  assert.equal(trafficScale(TRAFFIC_ZOOM_REAL), 1);
  assert.equal(trafficScale(TRAFFIC_ZOOM_FLOOR), TRAFFIC_FAR_BOOST);
  assert.ok(trafficScale(16) > trafficScale(16.5) && trafficScale(16.5) > trafficScale(17), '倍率必须随层级单调下降');
  // 实例矩阵是 Float32，倍率与 4 的差是存储自己的量化（3.9999999），所以按 1e-5 判等。
  life.advance(0, 14);
  within(boostOf(vehicles, 0), TRAFFIC_FAR_BOOST, '退到 14 级要放大到顶格', 1e-5);
  life.advance(0, 18);
  within(boostOf(vehicles, 0), 1, '推到 18 级就是真实尺度', 1e-5);
  // 行人 1.75 m，16.5 级以下不到一个像素，那一档整组收掉。
  life.advance(0, 16.4);
  assert.equal(life.parts().people.visible, false, '16.5 级以下不该画人');
  life.advance(0, WALKER_MIN_ZOOM);
  assert.equal(life.parts().people.visible, true, '到了那一档人就回来');
  assert.equal(CAR_HEIGHT_METRES, 1.45, '一辆车的高度是米数，不是点的直径');
  assert.equal(WALKER_HEIGHT_METRES, 1.75, '一个人 1.75 m');
});

// 用户 2026-10-10 的优化清单第 1 项：这一侧原来一处阴影都没有（`castShadow`/`shadowMap` 在 src/ 命中 0），
// 一千多辆车与两千多株树全是贴在地上浮着。影子不靠方向光贴图（楼是 MapLibre 的拉伸体，进不了 three 的
// shadow map），靠车脚下一片跟着车走的贴片。
test('影子贴在车脚下：一辆一片、长轴压着车头方向、桥上那片跟着桥面一起抬', () => {
  const bridge = way([[-400, 300], [400, 300]], { osmId: 11, brunnel: 'bridge' });
  const street = way([[-400, 340], [400, 340]], { osmId: 21 });
  const promenade = way([[-400, 380], [400, 380]], { osmId: 31, class: 'footway' });
  const deck = (osmId, part, height) => ({ type: 'Feature', properties: { osmId, part, height }, geometry: { type: 'Polygon', coordinates: [] } });
  const decks = deckHeights([deck(11, 'deck', 15.5), deck(11, 'kerb', 16.7)]);
  const life = createTrafficLife({ features: [bridge, street, promenade], origin: DEFAULT_CENTER, decks });
  life.advance(0, 18);
  assert.ok(life.counts.walkers > 0, '这份夹具没造出行人，人那一批影就没量到');
  const vehicles = life.group.children.find((mesh) => mesh.name === 'traffic-cars');
  const people = life.group.children.find((mesh) => mesh.name === 'traffic-walkers');
  const pads = life.group.children.find((mesh) => mesh.name === 'traffic-shadow-pads');
  assert.equal(pads.count, life.counts.cars + life.counts.walkers, '一片影配一辆车或一个人');
  const driven = (mesh, index) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    const shift = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(shift, turn, scale);
    return { shift, turn, scale };
  };
  const nose = (turn) => new THREE.Vector3(1, 0, 0).applyQuaternion(turn);
  for (const index of [0, 1, Math.min(7, vehicles.count - 1)]) {
    const car = driven(vehicles, index);
    const pad = driven(pads, index);
    within(pad.shift.x, car.shift.x, `#${index} 影子与车身不同 x`);
    within(pad.shift.z, car.shift.z, `#${index} 影子与车身不同 z`);
    // 长轴压车头方向：贴片是 1×1 的方形，`scale.x` 走的是旋转后的局部 +x，也就是车的前进方向。
    assert.ok(nose(car.turn).dot(nose(pad.turn)) > 0.9999, `#${index} 的影长轴与车头差了 ${Math.round(Math.acos(Math.min(1, nose(car.turn).dot(nose(pad.turn)))) * 57.3)}°`);
    assert.ok(pad.scale.x > pad.scale.z, `#${index} 的影比车身窄，那是个竖着的椭圆`);
    within(pad.scale.x / 2, CAR_LENGTH_METRES / 2 * PAD_SPREAD * car.scale.x, `#${index} 影子不是车长折算的那一片`);
  }
  // 桥上的车抬到桥面顶上，影子必须一起抬——留在 0 就是"车在桥上、影在水里"，与灯珠同一类错。
  const onBridge = [...Array(vehicles.count).keys()].find((index) => driven(vehicles, index).shift.y > 1);
  const onStreet = [...Array(vehicles.count).keys()].find((index) => index !== onBridge && driven(vehicles, index).shift.y < 1);
  assert.ok(onBridge !== undefined && onStreet !== undefined, '这份夹具没同时造出桥上与地面的车，这一发就没量到东西');
  within(driven(pads, onBridge).shift.y, PAD_LIFT_METRES + 15.5, '桥上那片影没跟着桥面抬');
  within(driven(pads, onStreet).shift.y, PAD_LIFT_METRES, '地面那片影跟着桥上那片一起抬了');
  // 行人那一档以下人不在场，他们那一批影也不该留下一片黑点：贴片是按"车先写完再写人"排的，所以截断计数就够。
  life.advance(0, 16.4);
  assert.equal(pads.count, life.counts.cars, '人退场了，人那一批影还画着');
  life.advance(0, 18);
  assert.equal(pads.count, life.counts.cars + life.counts.walkers, '人回来了，影没跟着回来');
  const walkerPad = driven(pads, life.counts.cars);
  within(walkerPad.scale.x / 2, WALKER_PAD_METRES * trafficScale(18) * WALKER_DRAW_SCALE, '人的影没跟着那 1.8 倍一起放大');
});

// 用户 2026-10-10 页面内第 3 项：整条街上只有一种尺度的车，是"车流"最露馅的一格。两档**共用同一份车身几何**
// （一个 InstancedMesh、一个 draw call，发数账不动），所以判据读的是实例的 scale，不是"有没有第二个网格"。
test('街上两档尺度：公交长一倍多、只跑那五级路、影子与灯都跟着自己那辆走', () => {
  const life = createTrafficLife({ features: streets.features, origin: DEFAULT_CENTER });
  const vehicles = life.group.children.find((mesh) => mesh.name === 'traffic-cars');
  const pads = life.group.children.find((mesh) => mesh.name === 'traffic-shadow-pads');
  const glow = life.group.children.find((mesh) => mesh.name === 'traffic-lamps');
  const shapes = vehicles.userData.shapes;
  const agents = vehicles.userData.agents;
  const driven = (mesh, index) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(index, matrix);
    const shift = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(shift, turn, scale);
    return { shift, turn, scale, nose: new THREE.Vector3(1, 0, 0).applyQuaternion(turn) };
  };
  // 实例一格没多：两档是同一批槽位里的两种尺度。
  assert.equal(vehicles.count, life.counts.cars, '两档尺度不该多出实例');
  const busAt = shapes.map((shape, index) => (shape.bus ? index : -1)).filter((index) => index >= 0);
  assert.ok(busAt.length > 20, `出厂这一公里只量到 ${busAt.length} 辆公交，第二档在画面里不存在`);
  assert.ok(busAt.length < life.counts.cars / 4, `${busAt.length}/${life.counts.cars} 辆是公交，那一条街全是巴士了`);
  assert.equal(life.parts().vehicles.buses, busAt.length, '读数里的公交数与实例上的对不上');
  // 那五级路上的占比要贴着点名的那个数：太稀等于没做，太密就成了巴士专用道。
  const onBusRoads = agents.filter((agent) => BUS_CLASSES.includes(agent.class)).length;
  const share = busAt.length / onBusRoads;
  assert.ok(share > BUS_SHARE / 2 && share < BUS_SHARE * 1.6,
    `那五级路上公交占 ${(share * 100).toFixed(1)} %，与点名的 ${(BUS_SHARE * 100).toFixed(0)} % 差太远`);
  // 两档就是两档：`scale.x` 只许落在两个值上。不能拿 `new Set()` 数——实例矩阵存的是 Float32，
  // `decompose` 出来的 1.0 有 1e-8 的抖动，逐辆去重会得到一千多个"档"。
  life.advance(0, 18);   // 倍率 1，两档的比值就是 scale 的比值
  const sedan = shapes.map((shape, index) => (shape.bus ? -1 : index)).filter((index) => index >= 0)[0];
  const sedanScale = driven(vehicles, sedan).scale.x;
  within(sedanScale, 1, '轿车那一档不该带任何倍率（18 级是真实尺度）', 1e-4);
  const offGrid = shapes.reduce((count, shape, index) => {
    const at = driven(vehicles, index).scale.x / sedanScale;
    return Math.min(Math.abs(at - 1), Math.abs(at - BUS_LENGTH_METRES / CAR_LENGTH_METRES)) > 1e-4 ? count + 1 : count;
  }, 0);
  assert.equal(offGrid, 0, `${offGrid} 辆车既不在轿车那一档、也不在公交那一档`);
  for (const index of busAt.slice(0, 5)) {
    const car = driven(vehicles, index);
    within(car.scale.x / sedanScale, BUS_LENGTH_METRES / CAR_LENGTH_METRES, '公交那一档的长不是点名的那条米数', 1e-4);
    // 高与宽各自钉：只拉长会抽出一根面条。
    within(car.scale.y / car.scale.x, (BUS_HEIGHT_METRES / CAR_HEIGHT_METRES) / (BUS_LENGTH_METRES / CAR_LENGTH_METRES), '公交的长高比不对', 1e-4);
    within(car.scale.z / car.scale.x, (BUS_WIDTH_METRES / CAR_WIDTH_METRES) / (BUS_LENGTH_METRES / CAR_LENGTH_METRES), '公交的长宽比不对', 1e-4);
    // 影子压的是**这一辆**的长宽：轿车那片是 2.5，公交是 4.2，写死一个数当场红。
    const pad = driven(pads, index);
    within(pad.scale.x / pad.scale.z, BUS_LENGTH_METRES / BUS_WIDTH_METRES, '公交的影不是按它自己那辆的长宽比的', 1e-4);
    // 灯珠要落在自己那辆的两头之外：按 4.5 m 给一辆 10.5 m 的公交点灯，灯就点在车厢中间。
    const buffer = glow.geometry.getAttribute('position');
    const offset = (buffer.getX(index) - car.shift.x) * car.nose.x + (buffer.getZ(index) - car.shift.z) * car.nose.z;
    assert.ok(Math.abs(offset) >= BUS_LENGTH_METRES / 2, `#${index} 那颗灯落在车厢里 (${offset.toFixed(2)} m)`);
    // 高度也一样按**自己那辆**给：按轿车顶算的话，公交那颗灯会埋进自己的车厢里。
    assert.ok(buffer.getY(index) >= car.shift.y + shapes[index].height, `#${index} 那颗灯比自己那辆的车顶矮`);
  }
  within(driven(pads, sedan).scale.x / driven(pads, sedan).scale.z, CAR_LENGTH_METRES / CAR_WIDTH_METRES, '轿车那片影的长宽比变了', 1e-4);
  assert.ok(driven(pads, busAt[0]).scale.x > driven(pads, sedan).scale.x * 1.5, '公交的影与轿车一样长，那是影子没跟着尺度走');
  // 归属：公交只许出现在那五级路上，而"巷子里不放"要有反例撑着。
  assert.ok(agents.every((agent, index) => !shapes[index].bus || BUS_CLASSES.includes(agent.class)), '公交跑进了不该挤进去的巷子');
  const alley = createTrafficLife({ features: [way([[-900, 0], [900, 0]], { osmId: 77, class: 'residential' })], origin: DEFAULT_CENTER });
  assert.ok(alley.counts.cars > 20, '这条居民路没造出车，下一句是空的');
  assert.equal(alley.parts().vehicles.buses, 0, '居民路这一条就放出公交了，那上面那句 every 是永真');
  const avenue = createTrafficLife({ features: [way([[-900, 0], [900, 0]], { osmId: 78, class: 'primary' })], origin: DEFAULT_CENTER });
  assert.ok(avenue.parts().vehicles.buses > 0, '主干道一辆公交都没有，"只跑那五级路"这句没有对象');
  // 颜色：公交那两色与轿车那七色各走各的，两档才在画面里分得开。
  const colour = new THREE.Color();
  const busHexes = new Set();
  const carHexes = new Set();
  shapes.forEach((shape, index) => {
    colour.fromArray(vehicles.instanceColor.array, index * 3);
    (shape.bus ? busHexes : carHexes).add(colour.getHexString());
  });
  assert.equal(busHexes.size, BUS_COLOURS.length, '公交两色只上屏了一色，读不出是涂装而不是一辆怪车');
  for (const hex of busHexes) assert.ok(BUS_COLOURS.some((value) => value.slice(1) === hex), `公交冒出一个不在两色里的 ${hex}`);
  for (const hex of carHexes) assert.ok(!BUS_COLOURS.some((value) => value.slice(1) === hex), `轿车穿走了公交的 ${hex}`);
  assert.ok(carHexes.size >= 5, `轿车只剩 ${carHexes.size} 个色号，那是色表没接上`);
  // 定死：刷新一次，第几辆是公交、是哪一色都不许变。
  const again = createTrafficLife({ features: streets.features, origin: DEFAULT_CENTER });
  assert.deepEqual(again.group.children[0].userData.shapes, shapes, '刷新一次页面，第几辆是公交变了');
});

// 两档的米数与"这一辆算不算公交"都要能被单独问：判据才不会只读到一个数组。
// 这里的绝对值一律写**字面数**：写 `BUS_LENGTH_METRES` 的话，把常数从 10.5 改成 5 两边一起变，抓不到（同第 57 条那条口径）。
test('vehicleShape 交出的就是点名的那两条尺度，公交名单里只有点名那五级', () => {
  assert.deepEqual([CAR_LENGTH_METRES, CAR_WIDTH_METRES, CAR_HEIGHT_METRES], [4.5, 1.8, 1.45], '轿车那一档的米数被人改了');
  assert.deepEqual([BUS_LENGTH_METRES, BUS_WIDTH_METRES, BUS_HEIGHT_METRES], [10.5, 2.5, 3.0], '公交那一档的米数被人改了');
  const sedan = vehicleShape({ class: 'primary', osmId: 1 }, 0);
  assert.deepEqual([sedan.bus, sedan.length, sedan.width, sedan.height], [false, 4.5, 1.8, 1.45], '轿车那一档不是点名的 4.5 × 1.8 × 1.45');
  assert.deepEqual([sedan.x, sedan.y, sedan.z], [1, 1, 1], '轿车那一档不该带任何倍率');
  let bus = null;
  for (let index = 0; index < 400 && !bus; index += 1) {
    if (isBusAgent({ class: 'primary', osmId: 1 }, index)) bus = vehicleShape({ class: 'primary', osmId: 1 }, index);
  }
  assert.ok(bus, '一条主干道上 400 个槽位里一辆公交都抽不到，那是 `BUS_SHARE` 没接上');
  assert.deepEqual([bus.length, bus.width, bus.height], [10.5, 2.5, 3.0], '公交那一档不是点名的 10.5 × 2.5 × 3.0');
  within(bus.x * bus.y * bus.z, (BUS_LENGTH_METRES / CAR_LENGTH_METRES) * (BUS_HEIGHT_METRES / CAR_HEIGHT_METRES) * (BUS_WIDTH_METRES / CAR_WIDTH_METRES), '三边倍率与米数不是一套', 1e-9);
  // 巷子那一级永远抽不到：这一句与上面那句一起，才算"按路等级分档"。
  for (let index = 0; index < 400; index += 1) {
    assert.equal(isBusAgent({ class: 'service', osmId: 1 }, index), false, `service 在第 ${index} 个槽位上放出了公交`);
  }
  assert.ok(BUS_CLASSES.every((class_) => CARRIAGEWAYS.includes(class_)), '公交名单里冒出了不是车行道的等级');
  assert.ok(!BUS_CLASSES.includes('residential'), '居民路进了公交名单，那上面那句反例就没了');
});

test('车头朝着它开走的方向，两端的灯是几何给的，不再问相机', () => {
  const life = createTrafficLife({ features: [way([[-900, 0], [900, 0]], { oneway: true })], origin: DEFAULT_CENTER });
  const vehicles = life.group.children.find((mesh) => mesh.name === 'traffic-cars');
  const driven = agentPosition(vehicles.userData.agents[0], 0);
  assert.ok(Math.abs(Math.abs(driven.dir.x) - 1) < 0.05 && Math.abs(driven.dir.y) < 0.05,
    `一条东西向的路上的车应该东西走，拿到 ${JSON.stringify(driven.dir)}`);
  const nose = decomposed(vehicles, 0).forward;
  assert.ok(Math.abs(nose.x - driven.dir.x) < 1e-5 && Math.abs(nose.z + driven.dir.y) < 1e-5,
    `车头 ${JSON.stringify(nose)} 没有对着前进方向 ${JSON.stringify(driven.dir)}`);
  // 近景由几何说清前后（下面的四片面），远景由那层加色点说：同一批位置，按 bearing 排白/红。
  // 真实尺寸的头灯在 700 m 外不到一个像素，所以这层点不能省——省了就等于把夜景那条"街上有点亮"删掉。
  const glow = life.group.children.find((child) => child.name === 'traffic-lamps');
  assert.equal(glow.isPoints, true, '远景的灯还是一层点');
  const shades = glow.geometry.getAttribute('color');
  assert.equal(shades.count, glow.geometry.getAttribute('position').count, '一个位置一个颜色');
  life.setLit(true);
  assert.equal(glow.visible, true, '点开着，点云跟着亮');
  life.setLit(false);
  assert.equal(glow.visible, false, '切回白昼，点与面一起收');
  const away = Array.from({ length: 3 }, (_, i) => shades.array[i]);
  assert.equal(life.faceCamera(90), true, '转镜头要重排');
  const turned = Array.from({ length: 3 }, (_, i) => shades.array[i]);
  assert.ok(Math.hypot(...away.map((value, index) => value - turned[index])) > 0.1,
    'bearing 换了，这一侧的灯必须换颜色');
  assert.equal(life.faceCamera(90.2), false, '镜头没动就不重写');
  const lamps = carLampGeometry();
  const position = lamps.getAttribute('position');
  const colour = lamps.getAttribute('color');
  assert.equal(position.count, 24, '四片灯面，每片两个三角形');
  const warm = channelOf(HEADLIGHT);
  const red = channelOf(TAILLIGHT);
  const front = [];
  const back = [];
  for (let index = 0; index < position.count; index += 1) {
    const rgb = [colour.getX(index), colour.getY(index), colour.getZ(index)];
    (position.getX(index) > 0 ? front : back).push(rgb);
  }
  assert.equal(front.length, 12);
  assert.equal(back.length, 12);
  for (const rgb of front) showColour(rgb, HEADLIGHT, '车头那一片');
  for (const rgb of back) showColour(rgb, TAILLIGHT, '车尾那一片');
  // 车身是两段台阶，不是一只长方盒：舱顶比车头低的那一截就是"轿车"这个剪影。
  const car = carGeometry();
  const heights = [...new Set(Array.from({ length: car.getAttribute('position').count }, (_, i) => Math.round(car.getAttribute('position').getY(i) * 100) / 100))].sort((a, b) => a - b);
  // 底盘顶与舱顶是两个不同的平面，这个台阶就是"轿车"这个剪影；轮下留的 0.15 m 是第三个。
  const round = (value) => Math.round(value * 100) / 100;
  assert.deepEqual(heights, [0.15, round(CAR_HEIGHT_METRES - CAR_CABIN_RAISE_METRES + 0.15), round(CAR_HEIGHT_METRES + 0.15)],
    `车身高度只有 ${JSON.stringify(heights)}，看不出舱`);
  assert.ok(Math.abs(heights.at(-1) - (CAR_HEIGHT_METRES + 0.15)) < 0.01, `舱顶在 ${heights.at(-1)} m，不在 ${CAR_HEIGHT_METRES} m 之上`);
  // 合并保留索引：两个盒子各 24 个顶点、12 个三角形，实例化时索引比三角汤省一半顶点。
  assert.equal(car.getAttribute('position').count, 48, '两个盒子合并后应该是 48 个顶点');
  assert.ok(car.index && car.index.count === 72, '索引没保住，一辆车就变成 24 个三角形');
  const walker = walkerGeometry();
  walker.computeBoundingBox();
  assert.ok(Math.abs(walker.boundingBox.max.y - WALKER_HEIGHT_METRES) < 1e-6, '人的头顶就在 1.75 m');
  assert.ok(CAR_CABIN_SHARE > 0.3 && CAR_CABIN_SHARE < 0.8);
  assert.ok(CAR_WIDTH_METRES < CAR_LENGTH_METRES / 2, '车身比例得像个车');
});

test('the shipped snapshot is OSM, whole ways, and every light points back at a way', () => {
  assert.equal(streets.metadata.license, 'ODbL-1.0', 'the street network is OpenStreetMap data under ODbL');
  assert.ok(streets.metadata.attribution.includes('OpenStreetMap'), 'and it says who it came from');
  // 抽取半径是**故意**比使用半径大的：一条从外面跑进来的路必须在快照里是完整的一条 way，
  // 否则它会在边界上被切成半条，车头与车道中线都会错。场景这一侧仍旧按 TRAFFIC_LIFE_RADIUS 收。
  assert.equal(streets.metadata.radius, 2200, '快照的抽取半径变了，要连同下面那条"是不是超集"一起想清楚');
  assert.ok(streets.metadata.radius > TRAFFIC_LIFE_RADIUS, '抽取半径必须覆盖使用半径，否则边界上的路是断的');
  assert.ok(streets.features.every((feature) => feature.geometry.type === 'LineString'), 'whole ways, not tile-clipped fragments');
  assert.ok(streets.features.every((feature) => Number.isFinite(feature.properties.osmId)), 'every line has the way id it came from');
  const classes = new Set(streets.features.map((feature) => feature.properties.class));
  for (const class_ of classes) {
    assert.ok([...CARRIAGEWAYS, ...RAMPS, ...FOOTWAYS].includes(class_), `${class_} is a class this drawing knows how to dress`);
  }

  const { cars, walkers } = trafficAgents(streets.features, DEFAULT_CENTER);
  const agents = [...cars, ...walkers];
  const ids = new Set(streets.features.map((feature) => feature.properties.osmId));
  assert.ok(agents.every((agent) => ids.has(agent.osmId)), 'every light sits on a way in the snapshot');
  assert.ok(cars.every((agent) => [...CARRIAGEWAYS, ...RAMPS].includes(agent.class)), 'vehicles are on carriageways');
  assert.ok(walkers.every((agent) => FOOTWAYS.includes(agent.class)), 'walkers are on footways');
  const named = new Set(streets.features.filter((feature) => feature.properties.name).map((feature) => feature.properties.osmId));
  assert.ok(agents.some((agent) => named.has(agent.osmId)), 'some of these lights are on streets OSM actually names');

  const tunnels = streets.features.filter((feature) => feature.properties.brunnel === 'tunnel');
  assert.ok(tunnels.length > 0, 'the snapshot does carry tunnels, so the rule that drops them is doing work');
  const sunkInside = tunnels.filter((feature) => insideRadius(feature.geometry.coordinates, DEFAULT_CENTER, TRAFFIC_LIFE_RADIUS)
    .some((piece) => lengthOf(piece) >= CAR_MIN_METRES));
  assert.ok(sunkInside.length > 0, `${sunkInside.length} tunnel ways would have carried traffic had the rule not been there`);
  const sunkIds = new Set(sunkInside.map((feature) => feature.properties.osmId));
  assert.ok(!agents.some((agent) => sunkIds.has(agent.osmId)), 'and not one of them has a light on it');
});

// 灯珠跟车体是反的：车越远越要放大才看得见，灯越远越要收，因为近两千颗加色点摊在沥青上就是"一串亮点"
// （定这条规则时是 1,981 颗；2026-10-09 车距 55 → 100 m 之后是 1,298 颗，门控与门槛都不受影响）。
// 逼出这条规则的是亮度预算：高空位（13.6）第 8 档路面中位被抬到 52.1，越过它自己的 38~52；把灯收掉是 48.6，
// 而"街上有车流"在那一档本来就是第 5 档光轨的活（同机位实测 53.1，合规）。
test('远镜头把近场灯珠交还给光轨：15 级满、14 级以下一点不剩', () => {
  assert.equal(trafficLampShare(TRAFFIC_LAMP_ZOOM_FULL), 1);
  assert.equal(trafficLampShare(TRAFFIC_LAMP_ZOOM_FLOOR), 0);
  assert.equal(trafficLampShare(14.5), 0.5, '中间必须是线性的一格');
  assert.ok(trafficLampShare(16) >= trafficLampShare(15.2), '退镜头不能把灯又打开');
  const life = createTrafficLife({ features: streets.features, origin: DEFAULT_CENTER });
  life.setLit(true);
  assert.equal(life.parts().lamps.opacity, 1, '出厂首屏那一档灯珠给满，近场判据数的就是它的头灯像素');
  life.advance(0, 13.6);
  assert.equal(life.parts().lamps.opacity, 0, '高空位上这些点就是把路面烧亮的东西');
  assert.equal(life.parts().lamps.visible, false);
  const vehicles = life.group.children.find((mesh) => mesh.name === 'traffic-cars');
  assert.equal(vehicles.visible, true, '收的是灯，不是车');
  life.advance(0, 15.5);
  assert.equal(life.parts().lamps.opacity, 1, '回到首屏那一档必须一点不少');
  life.setLit(false);
  assert.equal(life.parts().lamps.opacity, 0, '白昼仍旧不开灯，这一笔与镜头无关');
});

// 项 8-2（V5 遗留②）。V5 第 6 项把三公里光轨降成「带为主、点为辅」时登记了一句「近场没动」——这一条量的就是
// 那笔降级今天以什么形式存在：不是把远处的车删掉，而是让间距按「这一段离塔脚多远」线性拉大
// （`TRAFFIC_THIN_FROM_METRES` 之外每多 700 m 就多半倍间距）。两头都要钉：远档必须明显比近档稀，
// 但远档不能空——空了就是拿"降级"当名义把整条外环删了，帧时间是省了，"这座城市在动"也没了。
test('the far edge of the field is thinned, not emptied', () => {
  const agents = trafficAgents(streets.features, DEFAULT_CENTER, TRAFFIC_LIFE_RADIUS);
  // 同一条规则：一段路的远近是它自己所有顶点的平均位置到塔脚的距离，不是它的第一个点。
  const radiusOf = (line) => {
    const mean = line.points.reduce((sum, point) => ({ x: sum.x + point.x / line.points.length, y: sum.y + point.y / line.points.length }), { x: 0, y: 0 });
    return Math.hypot(mean.x, mean.y);
  };
  const bands = new Map();
  for (const car of agents.cars) {
    const radius = radiusOf(car.line);
    const key = Math.min(4, Math.floor(radius / (TRAFFIC_LIFE_RADIUS / 5)));
    const band = bands.get(key) ?? { cars: 0, metres: 0, lines: new Set() };
    band.cars += 1;
    if (!band.lines.has(car.line)) { band.lines.add(car.line); band.metres += car.line.length; }
    bands.set(key, band);
  }
  const rows = [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([key, band]) => `${key * 300}-${(key + 1) * 300}m ${Math.round(band.cars / (band.metres / 1000))} 辆/km（${band.cars} 辆 / ${(band.metres / 1000).toFixed(1)} km）`);
  const density = (band) => band.cars / band.metres;
  const ranked = [...bands.values()].sort((x, y) => density(y) - density(x));
  const far = bands.get(4);
  assert.ok(far && ranked.length >= 4, `the field needs several rings to be graded at all: ${rows.join(' · ')}`);
  // 参照取最密的那一档，不取"离塔最近的那一档"：塔脚那一圈是江与广场，密度天生比 300-600 m 那档低，
  // 拿它当分母会把一条本来存在的降级量成不存在。
  const densest = ranked[0];
  const ratio = density(far) / density(densest);
  assert.ok(ratio < 0.75, `1.2-1.5 km carries ${Math.round(density(far) * 1000)} cars/km against ${Math.round(density(densest) * 1000)} at the densest ring (ratio ${ratio.toFixed(2)}): ${rows.join(' · ')}`);
  assert.ok(ratio > 0.25, `1.2-1.5 km carries only ${Math.round(density(far) * 1000)} cars/km against ${Math.round(density(densest) * 1000)} (ratio ${ratio.toFixed(2)}): that is an empty ring, not a thinned one: ${rows.join(' · ')}`);
  assert.ok(far.cars > 20, `the far band holds ${far.cars} cars - too few for the claim to be about a field at all`);
});

// 车站在我们画出来的那块桥面上，而不是桥底下的江面上（用户 2026-10-09 拿截图问"汽车怎么都在桥下走"）。
test('cars ride the deck we draw, not the water under it', () => {
  // 桥面件是 `scripts/prepare-canton-bridges.mjs` 扫出来的：顶高 = 净空 12 + 板厚 3.5 = 15.5，写在 feature 的
  // `height` 上。这里只认 `part === 'deck'`——路缘（kerb）在桥面之上，把车抬到路缘顶等于让车骑在护栏上。
  const piece = (osmId, part, height, name = undefined) => ({
    type: 'Feature', properties: { osmId, part, height, ...(name ? { name } : {}) }, geometry: { type: 'Polygon', coordinates: [] },
  });
  const decks = deckHeights([
    piece(11, 'deck', 15.5), piece(11, 'deck', 12), piece(12, 'kerb', 16.7, '海心桥'), piece(13, 'deck', null),
    piece(31, 'deck', 15.5, '海心桥'),
  ]);
  assert.equal(decks.byOsmId.size, 2, '只有桥面那一层该进表：路缘不是车要站的层，缺高度的件也不能算');
  assert.equal(decks.byOsmId.get(11), 15.5, '同一条 way 被裁成多块时必须取最高的那块顶面');
  assert.equal(decks.byOsmId.has(12), false, 'kerb 不该进表');
  assert.equal(decks.byName.get('海心桥'), 15.5, '同名继承只能带桥面顶高，不能被同名的路缘抬到 16.7');
  assert.equal(decks.byOsmId.has(13), false, '没有顶高的桥面件不该进表');
  // 同名继承：海心桥的主道 way 在 OSM 里只有 `layer=1`、没有 `bridge` 标签，抽取脚本按 `bridge` 筛就漏了它。
  assert.equal(decks.heightOf({ properties: { osmId: 99, name: '海心桥', layer: 1 } }), 15.5,
    '同一条桥的高架 way 没继承到桥面顶高，人会站在水里');
  assert.equal(decks.heightOf({ properties: { osmId: 99, name: '海心桥', brunnel: 'bridge' } }), 15.5, '带 bridge 标签的也不继承');
  assert.equal(decks.heightOf({ properties: { osmId: 99, name: '海心桥' } }), 0, '地面上同名的路不许跟着抬');
  assert.equal(decks.heightOf({ properties: { osmId: 99, name: '没扫出桥面的某街', layer: 2 } }), 0, '表里没有的桥名不该给一个凭空的高度');

  const bridge = way([[-400, 300], [400, 300]], { osmId: 11, brunnel: 'bridge' });
  const street = way([[-400, 340], [400, 340]], { osmId: 21 });
  const { cars } = trafficAgents([bridge, street], DEFAULT_CENTER, TRAFFIC_LIFE_RADIUS, decks);
  assert.ok(cars.every((car) => car.osmId === 11 || car.deck === 0), '没有桥面的街被抬起来了');
  assert.ok(cars.some((car) => car.osmId === 11 && car.deck === 15.5), '桥上的车没有拿到桥面顶高');
  // 漏传表的时候不许把车凭空抬走（现版与新引擎都传，这一条是给第三个人准备的）。
  assert.ok(trafficAgents([bridge], DEFAULT_CENTER, TRAFFIC_LIFE_RADIUS).cars.every((car) => !car.deck),
    '不传桥面表时车应当全部留在地面');

  // 上面查的是数据，这里查真正落进矩阵的那一笔：`place()` 里那个第二参数就是离地米数。
  const life = createTrafficLife({ features: [bridge, street], origin: DEFAULT_CENTER, decks });
  life.advance(0, TRAFFIC_ZOOM_REAL);
  const vehicles = life.group.children.find((object) => object.name === 'traffic-cars');
  const glow = life.group.children.find((object) => object.name === 'traffic-lamps');
  const matrix = new THREE.Matrix4();
  const shift = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const heightOf = (index) => {
    vehicles.getMatrixAt(index, matrix);
    matrix.decompose(shift, turn, scale);
    return shift.y;
  };
  const onBridge = cars.findIndex((car) => car.osmId === 11);
  const onStreet = cars.findIndex((car) => car.osmId === 21);
  within(heightOf(onBridge), 15.5, '桥上那辆车的实例矩阵高度');
  within(heightOf(onStreet), 0, '街上那辆车不该跟着抬');
  // 灯珠跟着车身走：两辆车的灯高之差必须正好是桥面顶高，否则夜里会出现"车在桥上、灯在桥下"。
  const lampY = (index) => glow.geometry.getAttribute('position').array[index * 3 + 1];
  within(lampY(onBridge) - lampY(onStreet), 15.5, '灯珠没跟着车一起上桥');
  life.group.traverse((object) => object.geometry?.dispose?.());

  // 出厂数据这一侧的账：猎德大桥那两条 way 的顶高，与"近场里到底有多少车因此上桥"。
  const crossings = JSON.parse(readFileSync(new URL('../public/data/canton-bridges.geojson', import.meta.url), 'utf8'));
  const shipped = deckHeights(crossings.features);
  assert.equal(shipped.byOsmId.get(233809684), 15.5, '猎德大桥的桥面顶高变了，近场那批车的高度跟着变');
  const lifted = trafficAgents(streets.features, DEFAULT_CENTER, TRAFFIC_LIFE_RADIUS, shipped).cars.filter((car) => car.deck > 0);
  // 门槛 50 是按"车距 55 → 100 m 之后桥上剩 73 辆"定的：这条判据要防的是"表没接上"（那是 0）与腰斩，
  // 不是防我改间距——所以它跟着实例数走，而不是钉一个 2026-10-09 之前的 80。
  assert.ok(lifted.length > 50, `桥面上只有 ${lifted.length} 辆车，这张表大概没接上`);
  assert.equal([...new Set(lifted.map((car) => car.deck))].join(), '15.5', '出厂数据里所有桥面顶高都该是同一档示意净空');
});

// 用户 2026-10-09 拿截图说「这人稍微放大一点吧，这也太小了吧，然后怎么都是一个颜色的」。
test('行人画得读得出是个人，而且一件衣服一个色', () => {
  const build = () => createTrafficLife({ features: streets.features, origin: DEFAULT_CENTER });
  const life = build();
  const people = life.group.children.find((mesh) => mesh.name === 'traffic-walkers');
  const vehicles = life.group.children.find((mesh) => mesh.name === 'traffic-cars');

  // 放大倍率只乘在实例矩阵上：几何仍然是 1.75 m 的真高（上面那条测试钉着头顶），所以米数没被改脏。
  assert.equal(WALKER_DRAW_SCALE, 1.8, '画放大倍率是量出来的那一档：18.5 级 1.75 m = 8.0 px，乘到 14.4 px');
  life.advance(0, TRAFFIC_ZOOM_REAL);
  within(decomposed(people, 0).size, WALKER_DRAW_SCALE, '行人实例矩阵没吃到画放大那一档');
  within(decomposed(vehicles, 0).size, 1, '放大只给行人，车跟着一起吹就成了气球');
  life.advance(0, TRAFFIC_ZOOM_FLOOR);
  within(decomposed(people, 0).size, TRAFFIC_FAR_BOOST * WALKER_DRAW_SCALE, '退到 14 级该是远近倍率顶格再乘画放大');

  // 材质必须是白的： MeshStandardMaterial 会把材质色乘进逐实例颜色，留一个灰罩子七种衣服就压成一种。
  assert.equal(people.material.color.getHex(), 0xffffff, '材质带着颜色，衣服色会跟着一起被乘掉');
  const shades = people.instanceColor;
  assert.ok(shades, '没有逐实例颜色，一批人只能画成同一个色');
  const keyOf = (index) => [shades.getX(index), shades.getY(index), shades.getZ(index)].map((v) => v.toFixed(3)).join();
  const tally = new Map();
  for (let index = 0; index < people.count; index += 1) {
    const key = keyOf(index);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  assert.equal(tally.size, WALKER_COLOURS.length, `${people.count} 个人只画出了 ${tally.size} 种衣服色`);
  // 同一条步道上前后相邻的两个人不穿同一件（一眼看过去是一条街全是同款，就是"一个颜色"的实际读感）。
  const walkers = people.userData.agents;
  let matching = 0;
  for (let index = 1; index < walkers.length; index += 1) {
    if (walkers[index].osmId === walkers[index - 1].osmId && keyOf(index) === keyOf(index - 1)) matching += 1;
  }
  assert.equal(matching, 0, `${matching} 对相邻的人穿同一件衣服`);

  // 确定性：同一批输入重算一次，颜色逐个不变（刷新不换人，与车身色同一条规矩）。
  const again = build();
  const second = again.group.children.find((mesh) => mesh.name === 'traffic-walkers').instanceColor.array;
  for (let index = 0; index < people.count * 3; index += 1) {
    assert.equal(second[index], shades.array[index], `#${Math.floor(index / 3)} 的第 ${index % 3} 个通道重算之后变了`);
  }
  for (const group of [life.group, again.group]) group.traverse((object) => object.geometry?.dispose?.());
});

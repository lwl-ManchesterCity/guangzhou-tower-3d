import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DEFAULT_CENTER } from '../src/config.js';
import { TRAFFIC_LIFE_RADIUS, WALKER_MIN_ZOOM, createTrafficLife, deckHeights, trafficScale } from '../src/traffic-life.js';
import { BOAT_LIFE_RADIUS, createWaterLife } from '../src/waterlife.js';
import { deriveJunctions } from '../src/junctions.js';
import { createNearField } from '../src/near-field.js';

// 判据钉的是"装配器把两份现成的算法接成了口令上的一个"，所以数据用出厂快照：这两条渲染路径喂进来的就是这几份文件。
const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8')).features;
const streets = read('canton-streets.geojson');
const river = read('canton-river.geojson');
const water = read('canton-water.geojson');
const bridges = read('canton-bridges.geojson');
const decks = deckHeights(bridges);

// 现版那一次装配（`map.js`）：桥面表来自 crossings 快照，光晕贴图要 DOM，测试里就没有贴图——它不影响这几条数。
const asLegacy = () => createNearField({ streets, river, shore: water, origin: DEFAULT_CENTER, decks, sprite: null });
// 引擎那一次（`engine/boot.js`）：岸线照传（船要被夹回水里），`decks` 故意不传，因为这一侧还没有桥体（#170）。
const asEngine = () => createNearField({ streets, river, shore: water, origin: DEFAULT_CENTER, sprite: null });

const groupOf = (near, name) => near.groups.find((group) => group.name === name);
// 装配器自己派生路口（两条渲染路径因此不可能各算一套），并排比的那一份要拿同一把参数自己派生一次。
const junctionsOf = () => deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS });
const meshOf = (near, group, name) => groupOf(near, group).children.find((object) => object.name === name);
const shiftOf = (mesh, index, out = new THREE.Vector3()) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  matrix.decompose(out, new THREE.Quaternion(), new THREE.Vector3());
  return out;
};
const scaleOf = (mesh, index = 0) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const scale = new THREE.Vector3();
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  return scale.x;
};
// 一批实例在某一拍里总共走了多远：把每台的位置两两相减取长度再加起来。
const travelled = (mesh, before) => {
  let total = 0;
  for (let index = 0; index < mesh.count; index++) total += shiftOf(mesh, index).distanceTo(before[index]);
  return total;
};
const shiftsAt = (mesh) => Array.from({ length: mesh.count }, (_, index) => shiftOf(mesh, index).clone());

test('一个口令把三组装齐，摆进来的还是那两个模块自己那一批实例', () => {
  const near = asLegacy();
  assert.deepEqual(near.groups.map((group) => group.name), ['traffic-life', 'water-life', 'shore-wet'],
    '近场该交给场景三组：会动的两组，加一条静态的近岸湿线');
  // 湿线读的是同一份岸线快照，所以它的账也在装配器交出来的那一份里。
  assert.ok(near.shoreBand.faces >= 4 && near.shoreBand.faces <= 12, `湿线只装了 ${near.shoreBand.faces} 圈`);
  assert.ok(near.shoreBand.skipped >= 3, '宽度闸门一格都没拒，那条规则没接进来');
  // 与直接各造一次并排：装配器要是换了一份参数（半径、路网、岸线），这三个数当场分家。
  const traffic = createTrafficLife({ features: streets, origin: DEFAULT_CENTER, decks, sprite: null, junctions: junctionsOf() });
  const boats = createWaterLife({ features: river, origin: DEFAULT_CENTER, shore: water });
  assert.deepEqual(near.counts, { cars: traffic.counts.cars, walkers: traffic.counts.walkers, boats: boats.counts.boats });
  const seen = near.readout();
  assert.equal(seen.radius, TRAFFIC_LIFE_RADIUS, '车流那一场的半径不是模块自己那个数');
  assert.equal(seen.boatRadius, BOAT_LIFE_RADIUS);
  assert.equal(seen.reach, traffic.reach(), '装配器报的车流外缘不是同一批车量出来的那个');
  assert.equal(seen.boatReach, boats.reach());
  assert.equal(seen.walkerMinZoom, WALKER_MIN_ZOOM);
});

test('读数那一格还是判据在用的那 16 个键', () => {
  // 两边浏览器判据都读这一格（`nearTraffic()`），所以键名单写死在这里：改名或漏一格当场红，
  // 而不是等某一边读到一个 undefined 再被 `?? false` 悄悄吞掉。
  assert.deepEqual(Object.keys(asLegacy().readout()).sort(), [
    'boatClock', 'boatLights', 'boatRadius', 'boatReach', 'boats', 'boost', 'cars', 'clock', 'lamps', 'people',
    'radius', 'reach', 'signal', 'visible', 'walkerMinZoom', 'walkers',
  ]);
});

test('装配器传下去的每一份参数都落到了实例矩阵上，漏一格就分家', () => {
  // 与直接各造一次并排、逐台比矩阵：这是"参数没传下去"唯一的抓法。聚合数（台数、外缘）对岸线那种几十米的
  // 横向夹根本不敏感——实测漏传 `shore` 时 `boatReach` 一位不差，因为外缘是沿航道最远那端定死的。
  const near = asLegacy();
  // 比的是 120 秒那一拍而不是 0 秒：0 秒时一辆车都还没等到灯，装配器漏传 `junctions` 也能逐字相等。
  near.advance(120, 16.5);
  const traffic = createTrafficLife({ features: streets, origin: DEFAULT_CENTER, decks, sprite: null, junctions: junctionsOf() });
  traffic.advance(120, 16.5);
  const boats = createWaterLife({ features: river, origin: DEFAULT_CENTER, shore: water });
  boats.advance(120);
  const array = (mesh) => Array.from(mesh.instanceMatrix.array);
  const compared = [
    ['traffic-cars', meshOf(near, 'traffic-life', 'traffic-cars'), traffic.group.children.find((o) => o.name === 'traffic-cars')],
    ['traffic-walkers', meshOf(near, 'traffic-life', 'traffic-walkers'), traffic.group.children.find((o) => o.name === 'traffic-walkers')],
    ['water-boats', meshOf(near, 'water-life', 'water-boats'), boats.group.children.find((o) => o.name === 'water-boats')],
  ];
  for (const [name, mine, reference] of compared) {
    assert.equal(mine.count, reference.count, `${name}：装配器摆的台数与直接造那一份不是同一批`);
    assert.deepEqual(array(mine), array(reference), `${name}：矩阵逐台不一致，说明有一格参数没传下去`);
  }
});

test('桥面上那批车跟着装配器走，而引擎那一侧按 #170 留在地面', () => {
  const liftedOf = (near) => {
    const vehicles = meshOf(near, 'traffic-life', 'traffic-cars');
    let lifted = 0;
    for (let index = 0; index < vehicles.count; index++) if (shiftOf(vehicles, index).y > 1) lifted++;
    return lifted;
  };
  // 门槛与 `traffic-life.test.js` 那一条同一个口径（按实例数而不是按车距），防的是"表没接上"（那是 0）。
  assert.ok(liftedOf(asLegacy()) > 50, `装配器把桥面表弄丢了：桥上只剩 ${liftedOf(asLegacy())} 辆车`);
  assert.equal(liftedOf(asEngine()), 0, '这一侧还没有桥体，车抬起来会浮在平色路带上面——#170 迁桥体时这条要跟着改');
});

test('车、人与船共用同一把绝对秒，一次推进三组都走', () => {
  const near = asLegacy();
  near.advance(0, 16.5);
  const cars = meshOf(near, 'traffic-life', 'traffic-cars');
  const walkers = meshOf(near, 'traffic-life', 'traffic-walkers');
  const hulls = meshOf(near, 'water-life', 'water-boats');
  const before = [shiftsAt(cars), shiftsAt(walkers), shiftsAt(hulls)];
  near.advance(41.28, 16.5);
  const seen = near.readout();
  assert.equal(seen.clock, 41.28);
  assert.equal(seen.boatClock, 41.28, '船的钟与车的钟不是同一把：一次 advance 只推进了其中一组');
  // 读数里这一格 historically 叫 `boost`，装的是镜头层级（`parts().zoom`），两边判据都按它读，所以这里照它钉。
  assert.equal(seen.boost, 16.5);
  const moved = before.map((snapshot, index) => travelled([cars, walkers, hulls][index], snapshot));
  assert.ok(moved[0] > 10000, `推进 41 s 后车总共只走了 ${Math.round(moved[0])} m`);
  assert.ok(moved[1] > 100, `推进 41 s 后行人总共只走了 ${Math.round(moved[1])} m`);
  assert.ok(moved[2] > 100, `推进 41 s 后船总共只走了 ${Math.round(moved[2])} m`);
  // 停下来就是出厂那一帧：给 0 秒必须逐字回到起点，而不是回到上一次的位置。
  near.advance(0, 16.5);
  before.forEach((snapshot, index) => {
    const mesh = [cars, walkers, hulls][index];
    assert.equal(travelled(mesh, snapshot), 0, `第 ${index} 组回到 0 秒时位置没归零`);
  });
});

test('一个夜景口令切两处灯，一个总开关收三组', () => {
  const near = asLegacy();
  near.advance(0, 16.5);
  near.setLit(true);
  let seen = near.readout();
  assert.deepEqual([seen.lamps, seen.boatLights], [true, true], '夜景亮灯少切了一处');
  near.setLit(false);
  seen = near.readout();
  assert.deepEqual([seen.lamps, seen.boatLights], [false, false], '白天那两处灯没一起收掉');
  // 灯收了但客人还在场：白天车还是车、船还是船、湿线也还在岸上。
  assert.deepEqual([groupOf(near, 'traffic-life').visible, groupOf(near, 'water-life').visible], [true, true]);
  near.setVisible(false);
  assert.deepEqual(near.groups.map((group) => group.visible), [false, false, false], '高度透视镜只收走了其中一组');
  assert.equal(near.readout().visible, false);
  near.setVisible(true);
  assert.deepEqual(near.groups.map((group) => group.visible), [true, true, true]);
  // 湿线是静态的，但它跟着近场走：透视镜收走之后镜头再动，它不许自己回来。
  near.setVisible(false);
  near.setZoom(18);
  assert.equal(groupOf(near, 'shore-wet').visible, false, '透视镜收掉的湿线被一次 setZoom 放回来了');
  near.setVisible(true);
});

test('镜头那一帧的口令到车与湿线，船不需要它也得活着', () => {
  const near = asLegacy();
  const cars = meshOf(near, 'traffic-life', 'traffic-cars');
  near.advance(0, 16.5);
  const shades = () => meshOf(near, 'traffic-life', 'traffic-lamps').geometry.getAttribute('color').array.slice();
  const ahead = shades();
  near.faceCamera(180);
  assert.notDeepEqual(shades(), ahead, 'faceCamera 没转发到车：镜头转了，灯的朝向还是旧的');
  near.setZoom(14);
  assert.equal(near.readout().boost, 14, 'setZoom 没转发到车：读数里的层级还是上一帧的');
  // 实例矩阵存的是 Float32，所以倍率按存储自己的容差对（与 `traffic-life.test.js` 里 `within` 同一个口径）。
  assert.ok(Math.abs(scaleOf(cars) - trafficScale(14)) < 1e-6, '镜头退了，车却还是近景那个尺度');
  // 湿线也吃这一笔：14 级那条 7 m 的边不到两个像素，交回样式那块水面。
  assert.equal(groupOf(near, 'shore-wet').visible, false, '镜头拉到 14 级，湿线还贴在江边上');
  near.setZoom(16);
  assert.equal(groupOf(near, 'shore-wet').visible, true, '回到 15 级以上湿线没跟着回来');
  // 船不吃这两笔：调完镜头之后船的钟与外缘都不许动。
  const seen = near.readout();
  assert.equal(seen.boatClock, 0);
  assert.ok(seen.boatReach > 0, '船的那一份读数为空——说明 setZoom/faceCamera 把整组重建了');
});

test('没有江的那一侧照样装得出来，船那三格报 0 而不是把车一起拖塌', () => {
  const dry = createNearField({ streets, origin: DEFAULT_CENTER, decks });
  assert.equal(dry.groups.length, 1, '没有航道就不该有第二组');
  dry.advance(12, 16.5);
  dry.setLit(true);
  dry.setVisible(false);
  const seen = dry.readout();
  assert.deepEqual([seen.boats, seen.boatLights, seen.boatReach, seen.boatClock], [0, false, 0, 0]);
  assert.ok(seen.cars > 0 && seen.reach > 0, '少了船，车的那一份读数跟着空了');
});

test('哪一组都造不出来时报 null，与景泰那侧同一个形状', () => {
  const empty = createNearField({ origin: DEFAULT_CENTER });
  assert.equal(empty.readout(), null, '没有路网就没有近场，读数必须是 null 而不是半空的一格');
  assert.equal(empty.groups.length, 0);
  assert.deepEqual(empty.counts, { cars: 0, walkers: 0, boats: 0 });
  // 四个口令都得能空跑：引擎那边是逐组 add、逐拍 advance，少一个判断就是整页炸。
  empty.advance(1, 16.5);
  empty.setZoom(16.5);
  empty.faceCamera(30);
  empty.setLit(true);
  empty.setVisible(false);
});

test('灯是装配器从同一份路网里派生出来的，两条渲染路径拿到同一个周期', () => {
  const near = asLegacy();
  // 灯的账在装配器交出来的那一份里：路口不是手摆的，是从这 41 项 way 的断点算出来的。
  assert.ok(near.signals.junctions > 150 && near.signals.junctions < 260, `派生出 ${near.signals.junctions} 个路口`);
  assert.ok(near.signals.approaches > 200, `只有 ${near.signals.approaches} 条进口道接上了灯`);
  assert.deepEqual([near.signals.poles, near.signals.lines, near.signals.approaches],
    [near.signals.approaches, near.signals.approaches, near.signals.approaches], '杆、停止线、进口道三格数分家了');
  // 灯的三层几何挂在**车那一组里面**，不是第四组：透视镜与"读像素先藏近场"那几条门槛因此自动覆盖它。
  assert.equal(near.groups.length, 3, '灯自己成组了：藏近场的那几条浏览器门槛要重算');
  assert.ok(groupOf(near, 'traffic-life').children.some((child) => child.name === 'traffic-signals'),
    '灯没挂进 traffic-life 那一组');
  // 两边同秒同色：桥面表之类的差别不该漏进灯的相位里。
  const mine = near.readout().signal;
  const theirs = asEngine().readout().signal;
  assert.deepEqual(mine.states, theirs.states, '两条渲染路径在同一秒给出不同的灯色');
  assert.equal(mine.approaches, theirs.approaches);
  assert.equal(mine.parent, 'traffic-life');
  // 关掉派生这一格就是"没有灯"的出厂形状：读数报 null，而不是报一个空 tally。
  const dark = createNearField({ streets, river, shore: water, origin: DEFAULT_CENTER, decks, withJunctions: false });
  assert.equal(dark.readout().signal, null, '关掉路口派生之后读数还带着灯那一格');
  assert.equal(dark.signals.approaches, 0);
  assert.deepEqual(dark.groups.map((group) => group.name), ['traffic-life', 'water-life', 'shore-wet'],
    '没有灯就该少一组里的三层几何，而不是少一组');
  // 灯收了，车流本身不受影响：0 秒那一帧与有灯那一帧逐米相同。
  near.advance(0, 16.5);
  dark.advance(0, 16.5);
  const array = (who) => meshOf(who, 'traffic-life', 'traffic-cars').instanceMatrix.array;
  assert.deepEqual(array(near), array(dark), '灯一进组就改了 0 秒那一帧的车位');
  // 但 60 秒之后必须分出差别：灯真的把一批车按在停止线前——同一拍里位移不足一厘米的车，有灯那侧有一百多辆、没灯那侧一辆都没有。
  // （不能用"总行程"：车在线上绕圈，位移是欧氏距离，绕回-origin 的车反而算得远。）
  const frozenOver = (who, from, to) => {
    const mesh = meshOf(who, 'traffic-life', 'traffic-cars');
    who.advance(from, 16.5);
    const atFrom = shiftsAt(mesh);
    who.advance(to, 16.5);
    let still = 0;
    for (let index = 0; index < mesh.count; index++) if (shiftOf(mesh, index).distanceTo(atFrom[index]) < 0.01) still++;
    return still;
  };
  const withLights = frozenOver(near, 60, 61);
  const without = frozenOver(dark, 60, 61);
  assert.equal(without, 0, `没灯的那一侧也有 ${without} 辆车在 1 秒里一步没动`);
  assert.ok(withLights > 60, `有灯那一侧只有 ${withLights} 辆车在等灯，抓不住"灯按下了车"`);
});

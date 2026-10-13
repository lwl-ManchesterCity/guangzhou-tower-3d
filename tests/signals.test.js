import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DEFAULT_CENTER } from '../src/config.js';
import { ATMOSPHERES } from '../src/atmosphere.js';
import { GROUND_LAYERS } from '../src/engine/ground.js';
import { LANE_OFFSET, TRAFFIC_LIFE_RADIUS, createTrafficLife } from '../src/traffic-life.js';
import { SIGNAL_QUEUE_PITCH_METRES, deriveJunctions, signalLost } from '../src/junctions.js';
import {
  LENS_DAY_SHARE, LENS_METRES, LENS_REACH_METRES, LENS_TOP_METRES, POLE_KERB_OFFSET_METRES, POLE_LIFT_METRES,
  POLE_METRES, STOP_LINE_COLOUR, STOP_LINE_LIFT_METRES, STOP_LINE_METRES, STOP_LINE_OPACITY, STOP_LINE_THICKNESS_METRES,
  createSignalProps, poleGeometry, signalPositions, stopLineGeometry,
} from '../src/signals.js';

const read = (file) => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8')).features;
const streets = read('canton-streets.geojson');

// 灯珠写进缓冲的那 12 个数是按 `LENS_COLOURS` 那三个 hex 换算到工作色空间的字面值（2026-10-13 量）。
// 这里写死数字而不是调 `THREE.Color`，是为了改 hex 时判据当场红，而不是跟着一起改口径。
const LENS_LITERAL = {
  day: { red: [0.55, 0.01443267, 0.0056814], amber: [0.55, 0.2387845, 0.00794411], green: [0.01563432, 0.36984374, 0.080865] },
  night: { red: [1, 0.02624122, 0.01032982], amber: [1, 0.43415364, 0.01444384], green: [0.02842604, 0.67244316, 0.14702727] },
};

/** 装了灯、也真的接上车的进口道：几何层按这一批摆，所以判据读的是同一批。 */
const rigged = () => {
  const junctions = deriveJunctions({ features: streets, origin: DEFAULT_CENTER, radius: TRAFFIC_LIFE_RADIUS });
  createTrafficLife({ features: streets, origin: DEFAULT_CENTER, junctions });
  return junctions;
};
const meshOf = (group, name) => group.children.find((child) => child.name === name);
const placed = (mesh, index) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, spin, scale);
  // 场景里 +z 是平面里的南（-y），所以读回平面坐标时把 z 取负。
  const east = new THREE.Vector3(1, 0, 0).applyQuaternion(spin);
  return { x: position.x, y: -position.z, lift: position.y, scale, across: { x: east.x, y: -east.z } };
};
const near = (actual, expected, label, epsilon = 1e-4) => {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}：${actual} 与 ${expected} 差过 ${epsilon}`);
};
// 屏幕上的实际亮度：按 sRGB 的三个 0~255 通道加权，用来比"这条线压过路面之后还剩多少对比"。
const screenLum = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255);
};
const windingNormal = (geometry) => {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const at = (slot) => new THREE.Vector3().fromBufferAttribute(position, index.getX(slot));
  return new THREE.Vector3().subVectors(at(1), at(0)).cross(new THREE.Vector3().subVectors(at(2), at(0))).normalize();
};

test('只有"装了灯且接上车"的进口道才配一根杆', () => {
  const junctions = [{
    seed: 1, offset: 0, axes: 2, approaches: [
      { osmId: 1, x: 0, y: 0, ux: 1, uy: 0, kind: 'secondary', phase: 0, lit: true, stop: { x: 0, y: 0, hx: 1, hy: 0, rx: 0, ry: 1, lx: 0, ly: LANE_OFFSET } },
      { osmId: 2, x: 5, y: 0, ux: 1, uy: 0, kind: 'residential', phase: 0, lit: false },
      { osmId: 3, x: 10, y: 0, ux: 1, uy: 0, kind: 'trunk', phase: 0, lit: true },
    ],
  }];
  assert.equal(signalPositions(junctions).length, 1, '没接上车的进口道也摆了杆');
  assert.equal(signalPositions([]).length, 0);
  assert.equal(signalPositions([{ seed: 1, approaches: [] }]).length, 0);
});

test('一个进口道都没有时三层网格是空的，但都还在场景里', () => {
  const props = createSignalProps({ junctions: [] });
  assert.deepEqual(props.group.children.map((child) => child.name),
    ['signal-poles', 'signal-lenses', 'signal-stop-lines']);
  assert.deepEqual([props.report.approaches, props.report.poles, props.report.lines], [0, 0, 0]);
  // 实例数组是 `Math.max(1, 0)` 的容量：矩阵里不许留没写过的 NaN，否则一次 render 就能把整层丢掉。
  for (const child of props.group.children) {
    assert.equal(child.count, 0);
    assert.ok(child.instanceMatrix.array.slice(0, 16).every((value) => Number.isFinite(value)),
      `${child.name} 的实例矩阵里有 NaN`);
  }
  props.advance(10);
  props.setLit(true);
  assert.deepEqual(props.lensColours(3), [], '没有灯珠却读出了颜色');
  assert.equal(props.parts().first, null);
});

test('杆、灯珠、停止线三层的米数都落在进口道自己的几何上', () => {
  const junctions = rigged();
  const props = createSignalProps({ junctions });
  const rows = signalPositions(junctions);
  assert.equal(rows.length, props.report.approaches, '判据数的行与几何摆的杆分家了');
  assert.ok(rows.length > 200, `装了杆的进口道只剩 ${rows.length} 条`);
  const poles = meshOf(props.group, 'signal-poles');
  const lenses = meshOf(props.group, 'signal-lenses');
  const lines = meshOf(props.group, 'signal-stop-lines');
  assert.deepEqual([poles.count, lenses.count, lines.count], [rows.length, rows.length, rows.length]);
  // 一根杆带一个灯壳，合成一份几何：判据是"灯壳并进了杆的顶点里"，比裸柱多出来的那 24 个。
  const bare = new THREE.CylinderGeometry(0.075, 0.10125, POLE_METRES, 6, 1).getAttribute('position').count;
  assert.ok(poleGeometry().getAttribute('position').count > bare, '灯壳没并进杆的几何里，杆顶是一根光棍');
  assert.equal(stopLineGeometry().getAttribute('position').count, 4, '停止线不是四片顶点');
  // 躺平的那一片：绕序决定的法线必须朝上。`FrontSide` 加 downward 绕序 = 画零个像素（湿线那一格踩过）。
  const flat = windingNormal(stopLineGeometry());
  assert.ok(flat.y > 0.99, `停止面的法线只有 ${(flat.y * 100).toFixed(0)}% 朝上：在路面上不会画出一个像素`);

  // 逐台比：位置来自进口道自己的端点与切线，不是手摆的。
  for (const index of [0, Math.floor(rows.length / 2), rows.length - 1]) {
    const stop = rows[index].approach.stop;
    const pole = placed(poles, index);
    near(pole.x, stop.x + stop.rx * POLE_KERB_OFFSET_METRES, `第 ${index} 根杆的横向落点`);
    near(pole.y, stop.y + stop.ry * POLE_KERB_OFFSET_METRES, `第 ${index} 根杆的纵向落点`);
    near(pole.lift, POLE_LIFT_METRES, `第 ${index} 根杆的基座高度`);
    assert.ok(pole.lift > GROUND_LAYERS.road, '杆的基座埋在那条路面板底下');
    // 灯珠在杆顶之上、朝来车一侧挑出一点，等比一份球（倍率必须是 1，否则半径跟着变）。
    const lens = placed(lenses, index);
    near(lens.lift, POLE_LIFT_METRES + POLE_METRES + LENS_TOP_METRES, `第 ${index} 颗灯珠的高度`);
    near(lens.x, stop.x + stop.rx * POLE_KERB_OFFSET_METRES - stop.hx * LENS_REACH_METRES, `第 ${index} 颗灯珠的横向落点`);
    near(lens.scale.x, 1, `第 ${index} 颗灯珠被缩放到了 ${lens.scale.x} 倍`);
    // 实例矩阵存的是 Float32，所以三边都按存储自己的容差对，不写 `deepEqual`。
    [lens.scale.y, lens.scale.z].forEach((value, channel) => near(value, 1,
      `第 ${index} 颗灯珠的第 ${channel} 边不是等比`, 1e-6));
    // 停止线压在**这一侧的车道**上，长轴横跨行车方向。
    const line = placed(lines, index);
    near(line.x, stop.lx, `第 ${index} 片停止线的车道中心`);
    near(line.y, stop.ly, `第 ${index} 片停止线的车道中心`);
    near(line.lift, STOP_LINE_LIFT_METRES, `第 ${index} 片停止线的高度`);
    assert.ok(line.lift > GROUND_LAYERS.road, '停止线埋进了路面板');
    near(line.scale.x, STOP_LINE_METRES, `第 ${index} 片停止线的长度`);
    near(line.scale.z, STOP_LINE_THICKNESS_METRES, `第 ${index} 片停止线的厚度`);
    near(line.across.x * stop.rx + line.across.y * stop.ry, 1, `第 ${index} 片停止线的朝向`, 1e-3);
    near(line.across.x * stop.hx + line.across.y * stop.hy, 0, `第 ${index} 片停止线顺到了行车方向`, 1e-3);
    // 它必须在车实际站着的那条车道里，而不是压在两个对向流之间的缝上。
    near(Math.hypot(line.x - stop.x, line.y - stop.y), LANE_OFFSET, `第 ${index} 片停止线的车道偏心`, 1e-3);
  }
  near(lines.material.opacity, STOP_LINE_OPACITY, '停止线的透明度');
  // 三档氛围都得比路面自己出得来：白色那条实测只改得动 9 个像素（等于画了但看不见）。
  for (const mode of ['day', 'sunset', 'night']) {
    const road = screenLum(ATMOSPHERES[mode].road);
    const ink = road + (screenLum(STOP_LINE_COLOUR) - road) * lines.material.opacity;
    assert.ok(Math.abs(ink - road) >= 35,
      `${mode} 档停止线压过路面之后只差 ${(ink - road).toFixed(0)} 个灰度：等于没画`);
  }
  assert.equal(lines.material.depthWrite, false, '停止线写深度：它会把车底下的影贴片挡掉');
  assert.equal(lenses.material.color.getHexString(), 'ffffff', '灯珠的材质色不是白的：instanceColor 会被它带偏');
  assert.deepEqual([LENS_DAY_SHARE, STOP_LINE_OPACITY, STOP_LINE_METRES, STOP_LINE_THICKNESS_METRES,
    POLE_METRES, POLE_KERB_OFFSET_METRES, LENS_METRES, LENS_TOP_METRES, LENS_REACH_METRES, POLE_LIFT_METRES,
    STOP_LINE_LIFT_METRES, SIGNAL_QUEUE_PITCH_METRES],
  [0.55, 0.6, 3.6, 0.5, 3.2, 5.4, 0.42, 0.25, 0.25, 0.32, 0.34, 8],
  '这几格米数与档位被改动了：README 的示意口径要一起改');
  props.dispose();
  assert.equal(props.group.children.length, 0, 'dispose 没把三层收掉');
});

test('灯珠的颜色真的写进了实例缓冲，白昼半亮、夜景全亮', () => {
  const junctions = rigged();
  const props = createSignalProps({ junctions });
  const rows = signalPositions(junctions);
  const swatches = props.lensColours(60);
  assert.equal(swatches.length, 60, `前 60 颗灯珠只读出 ${swatches.length} 颗`);
  // 颜色与相位必须逐颗对上：整片写死成一种颜色时，缓冲里的数对不上它自己报的那一相。
  assert.ok(new Set(swatches.map((swatch) => swatch.state)).size >= 2,
    `前 60 颗灯珠只有一种相位：${swatches.map((swatch) => swatch.state).join(',')}`);
  for (const { state, rgb } of swatches) {
    rgb.forEach((value, channel) => near(value, LENS_LITERAL.day[state][channel],
      `白昼 ${state} 的第 ${channel} 通道`, 1e-6));
  }
  // 夜景那一档是同一份颜色乘到满：白天这 260 个亮点不该参与亮度账。
  props.setLit(true);
  for (const { state, rgb } of props.lensColours(60)) {
    rgb.forEach((value, channel) => near(value, LENS_LITERAL.night[state][channel],
      `夜景 ${state} 的第 ${channel} 通道`, 1e-6));
  }
  // 收回去要逐字回到白昼那几个数（`setLit` 走的是同一次重涂）。
  props.setLit(false);
  props.lensColours(2).forEach(({ rgb }, index) => {
    rgb.forEach((value, channel) => near(value, swatches[index].rgb[channel], `回到白昼的第 ${channel} 通道`, 1e-9));
  });
  // 三颗灯珠各归各的相位：同一时刻全城有绿有红，不是整片同色。
  const tally = props.parts().states;
  assert.ok(Object.keys(tally).length > 1, `所有进口道同一个颜色：${JSON.stringify(tally)}`);
  assert.equal(Object.values(tally).reduce((sum, value) => sum + value, 0), rows.length);
});

test('灯的秒表与车流是同一把：走一格变色，回 0 秒就是出厂那一帧', () => {
  const junctions = rigged();
  const traffic = createTrafficLife({ features: streets, origin: DEFAULT_CENTER, junctions });
  assert.ok(meshOf(traffic.group, 'traffic-signals'), '灯没挂进 `traffic-life` 那一组：透视镜与"读像素先藏近场"都不覆盖它');
  const seen = () => traffic.parts().signals;
  assert.equal(seen().parent, 'traffic-life');
  const before = JSON.stringify(seen().states);
  assert.equal(seen().clock, 0);
  // 走 10 秒：错开的周期里有进口道换了颜色，tally 必须跟着动。
  traffic.advance(10, 16.5);
  assert.equal(seen().clock, 10);
  assert.notEqual(JSON.stringify(seen().states), before, 'advance 没转发到灯：镜头走了 10 秒灯还是出厂那色');
  // 回 0 秒逐字回来（`signalLost` 与这里都是纯函数，不累积状态）。
  traffic.advance(0, 16.5);
  assert.equal(JSON.stringify(seen().states), before, '回到 0 秒灯没归位');
  // 夜景开关：一个口令同时切车灯与灯珠。
  traffic.setLit(true);
  assert.equal(seen().lit, 1);
  traffic.setLit(false);
  assert.equal(seen().lit, 0);
  // 车被红灯钉住的秒数与灯此刻的相位共用同一把秒表：60 秒那一拍应当有车正等着。
  traffic.advance(60, 16.5);
  const cars = traffic.group.children.find((child) => child.name === 'traffic-cars').userData.agents;
  assert.ok(cars.filter((agent) => agent.signal).some((agent) => signalLost(agent.signal, 60) > 0.5),
    '60 秒那一拍一辆等灯的车都没有');
  // 高度透视镜收车那一组时，灯跟着离场（它是挂在同一组里的子节点）。
  traffic.setVisible(false);
  assert.equal(meshOf(traffic.group, 'traffic-signals').visible, true, '灯自己藏了：那 `setVisible` 的账要重算');
  assert.equal(traffic.group.visible, false, '总开关没收到车那一组');
});

test('没有车的那一侧不造灯，景泰场景保持原样', () => {
  const bare = createTrafficLife({ features: [], origin: DEFAULT_CENTER });
  assert.equal(bare.parts().signals, null, '没有车就没有灯，却造了一组空网格');
  assert.equal(bare.signals, null);
  assert.deepEqual(bare.group.children.map((child) => child.name),
    ['traffic-cars', 'traffic-lamp-quads', 'traffic-lamps', 'traffic-walkers', 'traffic-shadow-pads']);
  // 只有路口、一辆车也没接上时也不造：`assignSignals` 报 0，几何层就不该进场。
  const empty = createTrafficLife({ features: streets, origin: DEFAULT_CENTER, junctions: [] });
  assert.equal(empty.parts().vehicles.approaches, 0);
  assert.equal(empty.parts().signals, null);
});

// #218 拾取的 Node 判据：合并跨度回认栋、逐栋包围盒粗筛＋三角形细测、隐形命中盒的高度读法，
// 以及点击语义（塔优先、拖动不算、修饰键不算）。全部用桩画布跑，不开浏览器；
// 真浏览器里的落点与卡片链路由 tests/engine.browser.spec.js 那侧钉。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SCENE } from '../src/config.js';
import { createProjection } from '../src/engine/projection.js';
import { buildingGeometry, blockIndexAt, mergeSolids } from '../src/engine/buildings.js';
import { createHitBoxes, createPicking, partBounds, raycastSolids } from '../src/engine/picking.js';

const origin = SCENE.center;
const project = createProjection(origin);

// 1e-4 度在此纬度约 10 m：两栋 20 m 见方的楼，B 在 A 正东约 51 m。
const square = (dx, dy) => [[origin.lng + dx, origin.lat + dy], [origin.lng + dx + 2e-4, origin.lat + dy],
  [origin.lng + dx + 2e-4, origin.lat + dy + 2e-4], [origin.lng + dx, origin.lat + dy + 2e-4], [origin.lng + dx, origin.lat + dy]];
const featureOf = (id, dx, dy, properties = {}) => ({ type: 'Feature', id,
  properties: { osmId: id, category: 'commercial', ...properties }, geometry: { type: 'Polygon', coordinates: [square(dx, dy)] } });
const centreOf = (dx, dy) => project({ lng: origin.lng + dx + 1e-4, lat: origin.lat + dy + 1e-4 });

const featureA = featureOf(1, 0, 0, { height: 30 });
const featureB = featureOf(2, 5e-4, 0, { height: 60 });
const partsOf = () => [featureA, featureB].map((feature) => buildingGeometry(feature.geometry.coordinates[0],
  { height: feature.properties.height, project, metricUV: true }));

test('blockIndexAt：手造跨度里每个顶点回认自己的栋，两段之外报 -1', () => {
  const spans = [
    { capStart: 0, capCount: 6, sideStart: 10, sideCount: 12 },
    { capStart: 6, capCount: 4, sideStart: 22, sideCount: 8 },
  ];
  for (let vertex = 0; vertex < 6; vertex++) assert.equal(blockIndexAt(spans, vertex), 0, `顶面段 ${vertex}`);
  for (let vertex = 6; vertex < 10; vertex++) assert.equal(blockIndexAt(spans, vertex), 1, `第二栋顶面 ${vertex}`);
  for (let vertex = 10; vertex < 22; vertex++) assert.equal(blockIndexAt(spans, vertex), 0, `侧壁段 ${vertex} 仍属第一栋`);
  for (let vertex = 22; vertex < 30; vertex++) assert.equal(blockIndexAt(spans, vertex), 1);
  assert.equal(blockIndexAt(spans, 30), -1, '越界要报 -1，不能落进最后一栋');
  assert.equal(blockIndexAt(spans, -1), -1);
  assert.equal(blockIndexAt([], 0), -1);
});

test('mergeSolids 的 spans 盖满合并几何：每个顶点认得出栋，逐栋顶点数与合并前一致', () => {
  const parts = partsOf();
  const before = parts.map((part) => part.getAttribute('position').count);
  const merged = mergeSolids(parts);
  const total = merged.geometry.getAttribute('position').count;
  assert.equal(merged.spans.length, 2);
  const counts = [0, 0];
  for (let vertex = 0; vertex < total; vertex++) {
    const part = blockIndexAt(merged.spans, vertex);
    assert.ok(part === 0 || part === 1, `顶点 ${vertex} 认不出栋`);
    counts[part]++;
  }
  assert.deepEqual(counts, before, '逐栋顶点数在合并前后必须一致，否则拾取会认到隔壁那栋');
  // 跨度自己也要自洽：顶面段全部排在侧壁段之前，且两段不重叠。
  for (const span of merged.spans) {
    assert.ok(span.capStart + span.capCount <= merged.caps);
    assert.ok(span.sideStart >= merged.caps);
    assert.ok(span.sideStart + span.sideCount <= total);
  }
  merged.geometry.dispose();
  merged.overlay.dispose();
});

test('partBounds＋raycastSolids：头顶射线各认各的栋，空地为 null，背面不认，近者优先', () => {
  const parts = partsOf();
  const boxesBefore = parts.map((part) => {
    part.computeBoundingBox();
    return part.boundingBox.clone();
  });
  const merged = mergeSolids(parts);
  const bounds = partBounds(merged.geometry, merged.spans);
  bounds.forEach((box, index) => {
    assert.ok(box.equals(boxesBefore[index]), `第 ${index} 栋的包围盒与合并前不一致：粗筛会把真命中筛掉`);
  });
  const down = (dx, dy) => {
    const centre = centreOf(dx, dy);
    return new THREE.Ray(new THREE.Vector3(centre.x, 200, centre.z), new THREE.Vector3(0, -1, 0));
  };
  const hitA = raycastSolids({ ray: down(0, 0), geometry: merged.geometry, spans: merged.spans, bounds });
  assert.ok(hitA && hitA.part === 0, 'A 头顶的射线要认到 A');
  assert.ok(Math.abs(hitA.point.y - 30) < 1e-3, `命中的是 30 m 的楼顶，实测 ${hitA.point.y}`);
  const hitB = raycastSolids({ ray: down(5e-4, 0), geometry: merged.geometry, spans: merged.spans, bounds });
  assert.ok(hitB && hitB.part === 1, 'B 头顶的射线要认到 B');
  assert.ok(Math.abs(hitB.point.y - 60) < 1e-3);
  assert.equal(raycastSolids({ ray: down(20e-4, 20e-4), geometry: merged.geometry, spans: merged.spans, bounds }), null,
    '两栋之外的空地不该认到任何一栋');
  // 从楼内向上打：顶面的 underside 是背面，FrontSide 语义下不认（与渲染看到的面向一致）。
  const inside = centreOf(0, 0);
  const up = new THREE.Ray(new THREE.Vector3(inside.x, 10, inside.z), new THREE.Vector3(0, 1, 0));
  assert.equal(raycastSolids({ ray: up, geometry: merged.geometry, spans: merged.spans, bounds }), null,
    '背面被认了：从楼里向上打不该命中屋顶 underside');
  // 一条水平射线先穿 B 再穿 A：报最近的 B，不是数组里排前面的 A。
  const row = centreOf(0, 0);
  const east = new THREE.Ray(new THREE.Vector3(row.x + 300, 15, row.z), new THREE.Vector3(-1, 0, 0));
  const near = raycastSolids({ ray: east, geometry: merged.geometry, spans: merged.spans, bounds });
  assert.ok(near && near.part === 1, '近者优先：射线先碰到东边的 B');
  merged.geometry.dispose();
  merged.overlay.dispose();
});

test('createHitBoxes：塔 450、其余 displayHeight 优先，base 抬起，无高度与刀锋环不立盒', () => {
  const tower = featureOf(9, 0, 0, { tower: true, height: 600 });
  const form = featureOf(8, 5e-4, 0, { displayHeight: 120, height: 999 });
  const plain = featureOf(7, 10e-4, 0, { height: 40, base: 20 });
  const untagged = featureOf(6, 15e-4, 0, {});
  const sliver = { type: 'Feature', id: 5, properties: { osmId: 5, height: 30 },
    geometry: { type: 'Polygon', coordinates: [[[origin.lng, origin.lat], [origin.lng + 1e-4, origin.lat], [origin.lng, origin.lat]]] } };
  const boxes = createHitBoxes({ features: [tower, form, plain, untagged, sliver], project });
  try {
    assert.equal(boxes.length, 3, '无高度的与三点的刀锋不立盒：现版那两层挤出也立不起来');
    const boxOf = (mesh) => {
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox;
    };
    assert.equal(boxes[0].userData.feature, tower);
    assert.ok(Math.abs(boxOf(boxes[0]).max.y - 450) < 1e-3, '塔盒是 450 m，不是快照里那个 600');
    assert.ok(Math.abs(boxOf(boxes[1]).max.y - 120) < 1e-3, 'displayHeight 优先于 height，与 landmark-forms-hit 的 coalesce 同序');
    assert.ok(Math.abs(boxOf(boxes[2]).min.y - 20) < 1e-3 && Math.abs(boxOf(boxes[2]).max.y - 60) < 1e-3, 'base 20 的盒坐在自己的基底上');
  } finally {
    for (const mesh of boxes) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
});

// 桩画布：只实现拾取用到的那几格。事件直接喂处理器，不经过真 DOM。
function stubCanvas() {
  const handlers = new Map();
  return {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (name, fn) => { handlers.set(name, fn); },
    removeEventListener: (name) => { handlers.delete(name); },
    dispatch: (name, event) => handlers.get(name)?.(event),
    listenerCount: () => handlers.size,
  };
}

function pickingRig({ withTower = false } = {}) {
  const parts = partsOf();
  const merged = mergeSolids(parts);
  const wall = new THREE.Mesh(merged.geometry, new THREE.MeshBasicMaterial());
  wall.userData = { features: [featureA, featureB], spans: merged.spans };
  wall.updateMatrixWorld();
  const tower = featureOf(9, 0, 12e-4, { tower: true, height: 600 });
  const boxes = withTower ? createHitBoxes({ features: [tower], project }) : [];
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 5000);
  const canvas = stubCanvas();
  const picked = [];
  const picking = createPicking({ canvas, camera, walls: [wall], boxes, onPick: (feature) => picked.push(feature) });
  const toScreen = (world) => {
    const point = world.clone().project(camera);
    return { clientX: (point.x * 0.5 + 0.5) * 800, clientY: (-point.y * 0.5 + 0.5) * 600 };
  };
  const dispose = () => {
    picking.dispose();
    merged.geometry.dispose();
    merged.overlay.dispose();
    wall.material.dispose();
  };
  return { canvas, camera, picking, picked, toScreen, tower, dispose };
}

test('点击认栋：水平视线先穿墙再穿塔盒时塔优先，与现版 buildingAt 同一条', () => {
  const rig = pickingRig({ withTower: true });
  try {
    const centre = centreOf(0, 0);
    // 相机在 A 正南 200 m、高 20 m，平视 A：射线先穿 A 的南墙（30 m 楼），再穿北边 120 m 处的塔盒。
    rig.camera.position.set(centre.x, 20, centre.z + 200);
    rig.camera.lookAt(centre.x, 20, centre.z);
    rig.camera.updateMatrixWorld();
    const aim = rig.toScreen(new THREE.Vector3(centre.x, 20, centre.z));
    const wallHit = rig.picking.hitAt(aim.clientX, aim.clientY);
    assert.equal(wallHit, rig.tower, '塔在更远处也要优先：现版 buildingAt 是 find(tower) ?? hits[0]');
    rig.canvas.dispatch('pointerdown', aim);
    rig.canvas.dispatch('pointerup', { ...aim, button: 0 });
    assert.deepEqual(rig.picked, [rig.tower], '一次干净的按下抬起要开一次塔');
  } finally {
    rig.dispose();
  }
});

test('点击的边界：拖动超过 4 px、右键、修饰键都不算点击；dispose 摘干净', () => {
  const rig = pickingRig();
  try {
    const centre = centreOf(5e-4, 0);
    rig.camera.position.set(centre.x, 20, centre.z + 200);
    rig.camera.lookAt(centre.x, 20, centre.z);
    rig.camera.updateMatrixWorld();
    const aim = rig.toScreen(new THREE.Vector3(centre.x, 20, centre.z));
    assert.equal(rig.picking.hitAt(aim.clientX, aim.clientY), featureB, '没有塔盒时认最近的那栋墙');
    rig.canvas.dispatch('pointerdown', aim);
    rig.canvas.dispatch('pointerup', { ...aim, clientX: aim.clientX + 10, button: 0 });
    assert.equal(rig.picked.length, 0, '挪了 10 px 是拖动，不是点击');
    rig.canvas.dispatch('pointerdown', aim);
    rig.canvas.dispatch('pointerup', { ...aim, button: 2 });
    rig.canvas.dispatch('pointerdown', aim);
    rig.canvas.dispatch('pointerup', { ...aim, button: 0, ctrlKey: true });
    assert.equal(rig.picked.length, 0, '右键与修饰键都不开卡片');
    rig.canvas.dispatch('pointerdown', aim);
    rig.canvas.dispatch('pointerup', { ...aim, clientX: aim.clientX + 3, button: 0 });
    assert.deepEqual(rig.picked, [featureB], '4 px 以内的手抖仍是点击');
    assert.equal(rig.canvas.listenerCount(), 4);
    rig.dispose();
    assert.equal(rig.canvas.listenerCount(), 0, 'dispose 要把四个监听都摘掉');
    rig.canvas.dispatch('pointerdown', aim);
    rig.canvas.dispatch('pointerup', { ...aim, button: 0 });
    assert.equal(rig.picked.length, 1, 'dispose 之后不再接事件');
  } finally {
    rig.dispose();
  }
});

test('悬停粗筛的量级：四千栋的包围盒先筛，细测只落在候选栋上', () => {
  // 用真快照的一个桶来量：粗筛之后参与三角形细测的栋数必须远小于全桶，否则悬停每帧全扫会把 FPS 吃穿。
  const parts = partsOf();
  const merged = mergeSolids(parts);
  const bounds = partBounds(merged.geometry, merged.spans);
  const centre = centreOf(0, 0);
  const ray = new THREE.Ray(new THREE.Vector3(centre.x, 200, centre.z), new THREE.Vector3(0, -1, 0));
  const candidates = bounds.filter((box) => ray.intersectsBox(box)).length;
  assert.equal(candidates, 1, 'A 头顶的射线只该粗筛出 A 一栋');
  const hit = raycastSolids({ ray, geometry: merged.geometry, spans: merged.spans, bounds });
  assert.equal(hit.part, 0);
  merged.geometry.dispose();
  merged.overlay.dispose();
});
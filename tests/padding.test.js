import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { paddingShift, viewportPadding } from '../src/padding.js';
import { applyPadding } from '../src/engine/camera.js';

// 这张表两边共用（#191）。此前新引擎根本没有这一维，所以同一串 hash 在桌面 1440×960 上
// 两边取景差 140×70 CSS 像素（2026-10-16 实测），浏览器那两册量的是差值收没收口，这里量的是表本身。
const view = (width, height, landscape = false) => {
  globalThis.innerWidth = width;
  globalThis.innerHeight = height;
  globalThis.matchMedia = () => ({ matches: landscape });
  return viewportPadding();
};

test('三个分支各自的留白，与它在屏幕上偏出的像素', () => {
  assert.deepEqual(view(1440, 960), { top: 200, left: 280, right: 0, bottom: 60 });
  assert.deepEqual(paddingShift(view(1440, 960)), { x: 140, y: 70 }, '桌面那一档就是账上写着的 140×70');
  // 手机：上面压 255 px（标题＋控制条），下面留 110 px 给那条控制条，左右各 15 px。
  assert.deepEqual(view(390, 844), { top: 255, left: 15, right: 15, bottom: 110 });
  assert.deepEqual(paddingShift(view(390, 844)), { x: 0, y: 72.5 });
  // 极矮横屏（844×390 这类车机／手机横放）：先判横屏，再判手机——顺序反了就会拿到 255 px 的顶栏留白。
  assert.deepEqual(view(844, 390, true), { top: 180, left: 20, right: 20, bottom: 65 });
  assert.deepEqual(view(667, 375, true), { top: 180, left: 20, right: 20, bottom: 65 }, '横屏那一档没排在手机之前');
  // 760 px 宽、够高：不算横屏，落手机那一档。
  assert.deepEqual(view(760, 900), { top: 255, left: 15, right: 15, bottom: 110 });
});

test('清单开合改的是留白，取景跟着走', () => {
  globalThis.innerWidth = 1440; globalThis.innerHeight = 960; globalThis.matchMedia = () => ({ matches: false });
  assert.deepEqual(paddingShift(viewportPadding(false)), { x: 140, y: 70 });
  assert.deepEqual(viewportPadding(true), { top: 200, left: 280, right: 360, bottom: 60 });
  assert.deepEqual(paddingShift(viewportPadding(true)), { x: -40, y: 70 }, '清单打开之后中心要往左让，不是继续往右偏');
  globalThis.innerWidth = 390; globalThis.innerHeight = 844;
  // 手机上那块面板占的是视口高度的 38% 再加下面那条控制条：844 × 0.38 + 129 → 450 px。
  assert.equal(viewportPadding(true).bottom, 450);
  assert.deepEqual(paddingShift(viewportPadding(true)), { x: 0, y: (255 - 450) / 2 });
});

test('投影里那一点平移与深度无关：现版那侧量的就是这张纯平移的画', () => {
  const canvas = { clientWidth: 1440, clientHeight: 960 };
  const camera = new THREE.PerspectiveCamera(36.87, 1440 / 960, 1, 20000);
  camera.position.set(0, 1600, 1800);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  // 同一张画布上两个不同深度的地面点：中心那一格离镜头 2,408 m，偏出去那一格 2,100 m。
  const near = new THREE.Vector3(0, 0, -2100), far = new THREE.Vector3(300, 0, -2400);
  const toPixel = (point) => {
    const ndc = point.clone().applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    // NDC 的 y 轴朝上，屏幕像素的 y 轴朝下，所以换回来的时候要翻一次号。
    return [(ndc.x * 0.5 + 0.5) * canvas.clientWidth, (-ndc.y * 0.5 + 0.5) * canvas.clientHeight];
  };
  const before = [toPixel(near), toPixel(far)];
  applyPadding(camera, canvas, paddingShift({ top: 200, left: 280, right: 0, bottom: 60 }));
  const after = [toPixel(near), toPixel(far)];
  const deltas = after.map((pixel, index) => [pixel[0] - before[index][0], pixel[1] - before[index][1]]);
  for (const [dx, dy] of deltas) {
    assert.ok(Math.abs(dx - 140) < 0.01, `横向只偏了 ${dx.toFixed(2)} px，应该是 140`);
    assert.ok(Math.abs(dy - 70) < 0.01, `纵向只偏了 ${dy.toFixed(2)} px，应该是 70`);
  }
  assert.deepEqual(deltas[0], deltas[1], '两点偏出的像素不一样：这不是一张纯平移的画，与现版那侧对不上');
  // 逆矩阵同步：`zoomToCursor` 与将来的拾取读的是它。
  const check = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.projectionMatrixInverse);
  assert.ok(Math.abs(check.elements[0] - 1) < 1e-6 && Math.abs(check.elements[5] - 1) < 1e-6,
    '改了正的没改逆的：两张投影矩阵开始各说一套');
});

test('留白这件事在项目里只有一处定义', async () => {
  const [mapSource, sceneSource, cameraSource] = await Promise.all(['../src/map.js', '../src/engine/scene.js', '../src/engine/camera.js']
    .map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const fragment of ['top: 200', 'top: 255', 'top: 180']) {
    assert.ok(!mapSource.includes(fragment), `src/map.js 里还留着一份自己的留白表（${fragment}）`);
  }
  assert.ok(mapSource.includes('viewportPadding(panelOpen)'), '现版那侧没在共用这张表');
  assert.ok(sceneSource.includes('padding: () => viewportPadding(false)'), '新引擎那一侧没把这张表交给相机');
  assert.ok(cameraSource.includes('applyPadding(camera, canvas, paddingShift(padding()))'), '相机算完投影没把留白折进去');
});

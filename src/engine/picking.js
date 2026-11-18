// #218 拾取：点击与悬停认栋。现版那侧认的是三层隐形挤出盒（`canton-tower-hit` 450 m、`landmark-forms-hit`
// 按 displayHeight、楼块本体），这里沿用同一语义：
// ① 楼块认的是**真画出来的墙**——合并几何里第几段顶点就是第几栋（`mergeSolids` 的 spans ＋ `blockIndexAt`）；
// ② 壳体与塔认的是同一批快照 feature 立起来的隐形盒，不进场景、不上台账，卡片读的还是快照那条记录。
// 墙那一侧不走 three 自带的整桶 raycast：一桶十几万三角形，悬停每帧全扫一遍会把 FPS 判据吃穿。
// 先按逐栋包围盒粗筛（四千个 Box3 对一条射线），只对候选栋做三角形细测——这两步都是纯函数，Node 直接钉。
import * as THREE from 'three';
import { buildingGeometry, ringOf } from './buildings.js';

/** 逐栋包围盒：一栋的顶面段与侧壁段一起量，顺序与 spans 逐位对应。 */
export function partBounds(geometry, spans) {
  const position = geometry.getAttribute('position');
  return spans.map(({ capStart, capCount, sideStart, sideCount }) => {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const [start, count] of [[capStart, capCount], [sideStart, sideCount]]) {
      for (let vertex = start; vertex < start + count; vertex++) box.expandByPoint(point.fromBufferAttribute(position, vertex));
    }
    return box;
  });
}

/**
 * 一条射线打进一份合并几何，报最近的那一栋。
 * @returns {{distance: number, part: number, point: THREE.Vector3}|null}
 */
export function raycastSolids({ ray, geometry, spans, bounds }) {
  const position = geometry.getAttribute('position');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  let best = null;
  spans.forEach((span, part) => {
    if (!ray.intersectsBox(bounds[part])) return;
    for (const [start, count] of [[span.capStart, span.capCount], [span.sideStart, span.sideCount]]) {
      for (let vertex = start; vertex < start + count; vertex += 3) {
        a.fromBufferAttribute(position, vertex);
        b.fromBufferAttribute(position, vertex + 1);
        c.fromBufferAttribute(position, vertex + 2);
        // 墙是 FrontSide：背面不认，与渲染看到的面向一致。
        if (!ray.intersectTriangle(a, b, c, true, hit)) continue;
        const distance = ray.origin.distanceTo(hit);
        if (!best || distance < best.distance) best = { distance, part, point: hit.clone() };
      }
    }
  });
  return best;
}

/**
 * 壳体与塔的隐形命中盒——现版 `landmark-forms-hit` / `canton-tower-hit` 的对应物。
 * 高度读法与那两层 paint 逐字同源：塔 450 m，其余 `displayHeight ?? height`；base 读快照自己的数。
 * 这些网格**不挂进场景**：它们不参与渲染，也不该出现在 teardown 台账里，dispose 由拾取层自己喊。
 */
export function createHitBoxes({ features = [], project, towerHeight = 450 }) {
  const boxes = [];
  for (const feature of features) {
    const ring = ringOf(feature);
    if (!ring || ring.length < 4) continue;
    const properties = feature.properties ?? {};
    const height = properties.tower ? towerHeight : Number(properties.displayHeight ?? properties.height) || 0;
    if (!(height > 0)) continue;
    const geometry = buildingGeometry(ring, { height, base: Number(properties.base) || 0, project });
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData.feature = feature;
    mesh.updateMatrixWorld();
    boxes.push(mesh);
  }
  return boxes;
}

/**
 * 点击与悬停。点击的语义与现版 `buildingAt` 对齐：所有命中里塔优先，其余取最近；
 * 拖动不算点击——按下与抬起之间挪过 4 px 就放弃（旋转手势与平移都从同一次按下开始）。
 *
 * @param {{canvas: HTMLElement, camera: THREE.Camera, walls: THREE.Mesh[], boxes: THREE.Mesh[],
 *   onPick: Function, onHover?: Function}} input
 *   `walls` 是带 `userData.features/spans` 的墙网格；`boxes` 是 `createHitBoxes` 的产物。
 */
export function createPicking({ canvas, camera, walls, boxes, onPick, onHover }) {
  const raycaster = new THREE.Raycaster();
  const boundsOf = new Map();
  const inverse = new THREE.Matrix4();
  function hitAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera({
      x: ((clientX - rect.left) / (rect.width || 1)) * 2 - 1,
      y: -((clientY - rect.top) / (rect.height || 1)) * 2 + 1,
    }, camera);
    const hits = [];
    for (const mesh of walls) {
      if (!boundsOf.has(mesh)) boundsOf.set(mesh, partBounds(mesh.geometry, mesh.userData.spans));
      inverse.copy(mesh.matrixWorld).invert();
      const hit = raycastSolids({ ray: raycaster.ray.clone().applyMatrix4(inverse), geometry: mesh.geometry,
        spans: mesh.userData.spans, bounds: boundsOf.get(mesh) });
      if (hit && hit.part >= 0) hits.push({ distance: hit.distance, feature: mesh.userData.features[hit.part] });
    }
    for (const intersection of raycaster.intersectObjects(boxes, false)) {
      hits.push({ distance: intersection.distance, feature: intersection.object.userData.feature });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return (hits.find((hit) => hit.feature?.properties?.tower) ?? hits[0])?.feature ?? null;
  }
  let press, hoverPoint, hoverFrame, dragging = false;
  const down = (event) => {
    dragging = true;
    press = { x: event.clientX, y: event.clientY };
  };
  const up = (event) => {
    dragging = false;
    if (!press || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) { press = undefined; return; }
    const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    press = undefined;
    if (moved > 4) return;
    const feature = hitAt(event.clientX, event.clientY);
    if (feature) onPick(feature);
  };
  const move = (event) => {
    if (dragging) return;
    hoverPoint = { x: event.clientX, y: event.clientY };
    hoverFrame ??= requestAnimationFrame(() => {
      hoverFrame = undefined;
      const feature = hoverPoint && hitAt(hoverPoint.x, hoverPoint.y);
      canvas.style.cursor = feature ? 'pointer' : '';
      onHover?.(feature);
    });
  };
  const leave = () => { hoverPoint = undefined; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('mousemove', move);
  canvas.addEventListener('mouseleave', leave);
  return {
    hitAt,
    dispose: () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseleave', leave);
      if (hoverFrame !== undefined) cancelAnimationFrame(hoverFrame);
      canvas.style.cursor = '';
      for (const mesh of boxes) { mesh.geometry.dispose(); mesh.material.dispose(); }
    },
  };
}
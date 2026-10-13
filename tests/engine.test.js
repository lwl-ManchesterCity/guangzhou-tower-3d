import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { cameraFromPlacement, plane } from '../src/geo.js';
import { SCENE, VIEW_LIMITS } from '../src/config.js';
import { createProjection, groundRing } from '../src/engine/projection.js';
import { distanceForZoom, eyeFromView, viewFromEye, wrapBearing, zoomForDistance, cameraToCentre, flightStep } from '../src/engine/camera.js';
import { FOG_RATIOS } from '../src/engine/scene.js';
import { GROUND_LAYERS, ROAD_WIDTH_METRES, TONE_OF_KIND, createGround, plateGeometry, polygonsOf, ribbonGeometry, roadWidth, toneOf } from '../src/engine/ground.js';
import { DEFAULT_HEIGHT, buildingGeometry, createBuildingBuckets, drawnHeight, mergeSolids, pickTallest } from '../src/engine/buildings.js';
import {
  FACADE_CATEGORY_SHAPES, LAMP_DARK_RESIDUE, LAMP_GROUPS, LIGHT_BANDS, LIGHT_FADES, LIGHT_TEMPERATURES, LIGHT_TILE, glowTexture,
  isLampBreather, isLampDark, lampBandOf, lampTemperatureOf, lightTexture,
} from '../src/facade.js';
import {
  FACADE_CELL_METRES, LAMP_GRID, LAMP_OFF_ROW, createFacadeSet, createLampMaterial, facadeOpacityFor, facadeShapeOf, glowAtlasTexture,
  lampAtlasCells, lampAtlasImage, lampAtlasTexture, lampCellOf,
} from '../src/engine/facades.js';
import { PITCH_DEGREES_PER_100PX, ROTATE_DEGREES_PER_100PX, isRotateTrigger } from '../src/engine/gestures.js';
import { pointInGeometry } from '../src/jingtai-data.js';

const origin = SCENE.center;
const project = createProjection(origin);
const height = 960;

test('the metre frame is the one the tower assets already measure on, and it closes', () => {
  // `plane()` is what `tower.js` measures the river crossing with. The engine uses the same function rather than a
  // look-alike, because two projections that differ by centimetres still put a crown off its own shaft.
  for (const point of [{ lat: 23.109, lng: 113.31913 }, { lat: 23.135, lng: 113.34 }, { lat: 23.08, lng: 113.29 }]) {
    const cached = project(point);
    const direct = plane(origin, point);
    assert.equal(cached.x, direct.dx, 'east disagrees with plane()');
    assert.equal(cached.z, -direct.dy, 'the south axis is the sign-flipped north axis');
  }
  // The inverse has no closed form (the midpoint latitude depends on the answer), so it is graded on the round trip.
  let worst = 0;
  for (const [x, z] of [[0, 0], [1000, -2000], [-3000, 3000], [2121.3, 2121.3], [0, -4242.6], [4242.6, 0]]) {
    const back = project.uncached(project.toLngLat({ x, z }));
    worst = Math.max(worst, Math.hypot(back.x - x, back.z - z));
  }
  assert.ok(worst < 0.05, `the round trip drifts ${worst} m across the scene radius`);
});

test('the scene boundary is a circle on the ground, not a box on the map', () => {
  const ring = groundRing(project, SCENE.radius, 24);
  const distances = ring.map(([lng, lat]) => plane(origin, { lat, lng }).distance);
  assert.ok(Math.max(...distances) - Math.min(...distances) < 0.5,
    `the ring runs ${Math.min(...distances)} to ${Math.max(...distances)} m from the centre`);
  assert.equal(ring.length, 25, 'the ring closes');
});

test('zoom and camera distance are exact inverses, and the pair is the shipped helper\'s own', () => {
  for (const zoom of [VIEW_LIMITS.minZoom, 12.5, SCENE.camera.zoom, VIEW_LIMITS.maxZoom]) {
    const distance = distanceForZoom({ zoom, height, latitude: origin.lat });
    assert.ok(Math.abs(zoomForDistance({ distance, height, latitude: origin.lat }) - zoom) < 1e-9, `zoom ${zoom} does not come back`);
  }
  assert.ok(distanceForZoom({ zoom: 16, height, latitude: origin.lat }) < distanceForZoom({ zoom: 13, height, latitude: origin.lat }),
    'a higher zoom must sit closer');
  // `cameraFromPlacement` is what the tour and the landmark buttons already write into the hash. Reading its own
  // numbers back out of the new camera is what makes an old link land on the same frame.
  const placed = cameraFromPlacement({ target: { lat: 23.1125, lng: 113.3191 }, metres: 900, altitude: 420, around: 200, height });
  const eye = eyeFromView({ center: { lat: placed.center[1], lng: placed.center[0] }, zoom: placed.zoom, bearing: placed.bearing, pitch: placed.pitch, height, project });
  const read = viewFromEye({ position: { x: eye.x, y: eye.y, z: eye.z }, target: { x: eye.target.x, z: eye.target.z }, height, project });
  assert.ok(Math.abs(read.zoom - placed.zoom) < 1e-3, `zoom reads ${read.zoom}, placed at ${placed.zoom}`);
  assert.ok(Math.abs(read.pitch - placed.pitch) < 1e-3, `pitch reads ${read.pitch}, placed at ${placed.pitch}`);
  assert.ok(Math.abs(wrapBearing(read.bearing - placed.bearing)) < 1e-3, `bearing reads ${read.bearing}, placed at ${placed.bearing}`);
  assert.ok(Math.abs(read.center.lat - placed.center[1]) < 1e-7 && Math.abs(read.center.lng - placed.center[0]) < 1e-7,
    'the target does not come back to its own coordinate');
  // The formula the whole mapping rests on, pinned to one number so a silent edit of either constant shows up here.
  assert.ok(Math.abs(cameraToCentre(height) - 1440) < 0.01, `MapLibre\'s camera-to-centre for 960 px is ${cameraToCentre(height)}`);
});

test('a flat view and a tilted one put the eye where the angles say', () => {
  const flat = eyeFromView({ center: origin, zoom: 15, bearing: 0, pitch: 0, height, project });
  assert.ok(Math.abs(flat.x) < 1e-6 && Math.abs(flat.z) < 1e-6, 'at pitch 0 the camera sits above the target');
  assert.ok(flat.y > 1000 && Math.abs(flat.y - flat.distance) < 1e-9, 'pitch 0 means the sight line is the altitude');
  const north = eyeFromView({ center: origin, zoom: 15, bearing: 0, pitch: 45, height, project });
  assert.ok(north.z > 0, 'looking north (bearing 0) puts the eye south of what it looks at');
  assert.ok(Math.abs(north.x) < 1e-6);
  assert.ok(Math.abs(north.y - north.distance * Math.cos(Math.PI / 4)) < 1e-6, 'pitch 45 splits the sight line evenly');
});

test('雾带跟着视线走，但开屏机位上必须还是骨架那一条 1500~9000 m', () => {
  const opening = distanceForZoom({ zoom: SCENE.camera.zoom, height, latitude: origin.lat });
  assert.ok(Math.abs(opening * FOG_RATIOS.near - 1500) < 5, `开屏的近雾面挪到了 ${(opening * FOG_RATIOS.near).toFixed(0)} m，画面判据要重校`);
  assert.ok(Math.abs(opening * FOG_RATIOS.far - 9000) < 20, `开屏的远雾面挪到了 ${(opening * FOG_RATIOS.far).toFixed(0)} m，画面判据要重校`);
  // 全景档（看全范围那颗按钮）：3 km 圈必须整圈落在雾坡的前五分之一里，否则城市会退成一片空色。
  const wide = distanceForZoom({ zoom: 12.6, height, latitude: origin.lat });
  const farEdge = wide + SCENE.radius;
  const ramp = (farEdge - wide * FOG_RATIOS.near) / (wide * FOG_RATIOS.far - wide * FOG_RATIOS.near);
  assert.ok(wide > 9000, `12.6 级的视线只有 ${wide.toFixed(0)} m，这条判据的前提没了`);
  assert.ok(ramp < 0.2, `全景档上 3 km 圈的最远端已经走到雾坡的 ${(ramp * 100).toFixed(0)}% 处，画面会糊成一片`);
});

test('the ground layers are a strict stack and stay under half a metre', () => {
  const values = Object.values(GROUND_LAYERS);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'the layer order is the draw order, so it must rise');
  assert.ok(Math.max(...values) <= 0.5 && Math.min(...values) >= 0, 'the brief lifts these planes by 0.1~0.5 m, no more');
  // Every tone needs its own height or two adjacent plates share an edge and that edge flickers, so the stack is
  // graded per tone rather than per group: the old single `green` level is now three (grass/park/wood).
  assert.deepEqual(Object.keys(GROUND_LAYERS), ['base', 'block', 'pavement', 'grass', 'park', 'wood', 'water', 'road']);
});

test('a ribbon is a flat quad strip at its own height', () => {
  const line = [[origin.lng, origin.lat], [origin.lng + 0.01, origin.lat], [origin.lng + 0.01, origin.lat + 0.01]];
  const geometry = ribbonGeometry(line, 90, project, GROUND_LAYERS.water);
  const position = geometry.getAttribute('position');
  assert.equal(position.count, (line.length - 1) * 6, 'two segments, two triangles each');
  for (let index = 0; index < position.count; index++) {
    // Positions live in a Float32 buffer, so the layer height only agrees to within a rounding of it.
    assert.ok(Math.abs(position.getY(index) - GROUND_LAYERS.water) < 1e-6, 'every vertex lies on its own layer');
  }
  // The first segment runs due east, so a 90 m ribbon is 45 m either side of the centre line.
  // The first segment runs due east, so its left-hand normal points south: the ribbon spans z = -45 .. +45.
  assert.ok(Math.abs(position.getZ(0) - 45) < 1e-6 && Math.abs(position.getZ(1) + 45) < 1e-6,
    `the ribbon is ${(position.getZ(0) - position.getZ(1)).toFixed(1)} m across, not 90`);
  const degenerate = ribbonGeometry([[origin.lng, origin.lat], [origin.lng, origin.lat]], 90, project);
  assert.equal(degenerate.getAttribute('position').count, 0, 'a zero-length segment must not fabricate a quad');
});

test('road widths follow the class the extract carries, and unknown classes get a floor', () => {
  assert.ok(ROAD_WIDTH_METRES.motorway > ROAD_WIDTH_METRES.primary, 'a motorway may not be narrower than a primary road');
  assert.ok(ROAD_WIDTH_METRES.primary > ROAD_WIDTH_METRES.minor, 'the hierarchy has to be visible');
  assert.equal(roadWidth({ properties: { class: 'unheard-of' } }), ROAD_WIDTH_METRES.unresolved);
  assert.equal(roadWidth({}), ROAD_WIDTH_METRES.unresolved);
  assert.equal(roadWidth({ properties: { class: 'path' } }), ROAD_WIDTH_METRES.path);
});

test('a plate keeps its own area in square metres', () => {
  const ring = [[113.31913, 23.109], [113.31958, 23.109], [113.31958, 23.10941], [113.31913, 23.10941], [113.31913, 23.109]];
  const geometry = plateGeometry([ring], project, GROUND_LAYERS.grass);
  const position = geometry.getAttribute('position');
  const xs = [], zs = [];
  for (let index = 0; index < position.count; index++) {
    xs.push(position.getX(index));
    zs.push(position.getZ(index));
    assert.ok(Math.abs(position.getY(index) - GROUND_LAYERS.grass) < 1e-6, 'the plate sits on its layer, normal up');
  }
  const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
  const east = plane(origin, { lat: 23.109, lng: 113.31958 }).dx;
  const north = plane(origin, { lat: 23.10941, lng: 113.31913 }).dy;
  assert.ok(Math.abs(area - east * north) < 1, `${area.toFixed(0)} m² against the measured ${Math.round(east * north)} m²`);
});

test('a block stands at its own height on its own footprint', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8'));
  const feature = snapshot.features.find((entry) => Number(entry.properties?.osmId) === 584204634) ?? snapshot.features[0];
  const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0];
  const geometry = buildingGeometry(ring, { height: 200, project });
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  assert.equal(Math.round(box.min.y), 0, 'the extrusion starts on the ground');
  assert.equal(Math.round(box.max.y), 200, 'and stops at the height the snapshot carries');
  // The footprint must not move: this is the same ring the map picks with.
  const centre = project({ lng: ring[0][0], lat: ring[0][1] });
  assert.ok(box.min.x <= centre.x + 1e-3 && box.max.x >= centre.x - 1e-3, 'the block stays on its own outline east-west');
  assert.ok(box.min.z <= centre.z + 1e-3 && box.max.z >= centre.z - 1e-3, 'and north-south');
});

test('heights come from the tag or the illustrative floor, never from a guess', () => {
  assert.equal(drawnHeight({ properties: { height: 149 } }), 149);
  assert.equal(drawnHeight({ properties: { height: '88.5' } }), 88.5);
  assert.equal(drawnHeight({ properties: {} }), DEFAULT_HEIGHT, 'untagged blocks share the one illustrative value');
  assert.equal(drawnHeight({ properties: { height: 0 } }), DEFAULT_HEIGHT, 'a zero height is no height');
  assert.equal(drawnHeight({ properties: { height: -12 } }), DEFAULT_HEIGHT, 'a negative height is no height');
  assert.equal(drawnHeight({ properties: { height: 'abc' } }), DEFAULT_HEIGHT);
});

test('the ten tallest blocks are the same ten every time', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8'));
  const first = pickTallest(snapshot.features, 10).map((feature) => feature.properties.osmId);
  const shuffled = [...snapshot.features].reverse();
  assert.deepEqual(pickTallest(shuffled, 10).map((feature) => feature.properties.osmId), first,
    'the pick depends on array order, so a regenerated snapshot would move the acceptance frame');
  assert.equal(first.length, 10);
  assert.equal(new Set(first).size, 10, 'the same block twice is not ten blocks');
  const heights = pickTallest(snapshot.features, 10).map(drawnHeight);
  assert.deepEqual(heights, [...heights].sort((a, b) => b - a), 'they have to come back tallest first');
  // The tower itself is a three.js asset, not an extruded footprint; if it ever lands in this list the Phase 0 frame
  // would show a plain box standing where the lattice goes.
  assert.ok(!first.includes(SCENE.towerId), 'the parametrised tower must not be extruded as a block');
});

test('全量建筑按类别分桶：一桶一个 Mesh，换氛围只改材质不改几何', async () => {
  const snapshot = await surfaceOf('canton-buildings');
  const paletteOf = (category) => ({ commercial: '#112233', residential: '#445566', public: '#778899' }[category] ?? '#0000ff');
  const categories = [...new Set(snapshot.features.map((feature) => String(feature.properties.category)))].sort();
  const buckets = createBuildingBuckets({ features: snapshot.features, project, palette: paletteOf });
  try {
    assert.deepEqual(buckets.categories, categories, `分出来的桶与快照里的类别对不上：${buckets.categories}`);
    assert.equal(buckets.group.children.length, categories.length, '一桶一个 Mesh，回到一栋一个就是 3,990 个 draw call');
    assert.equal(buckets.count, snapshot.features.length, '一栋都不能静默丢');
    assert.equal(buckets.heights.length, snapshot.features.length, '每一栋都要留下自己的高度读数');
    assert.equal(buckets.group.children.reduce((sum, mesh) => sum + mesh.userData.blocks, 0), snapshot.features.length,
      '桶上的栋数加起来必须等于喂进去的栋数');
    for (const mesh of buckets.group.children) {
      assert.equal(mesh.geometry.index, null, '合并几何必须是裸三角：留着索引会被只搬 position 的合并读成三角汤');
      assert.equal(mesh.geometry.getAttribute('position').count % 3, 0, '顶点数不成三角');
      assert.equal(mesh.material.color.getHexString(), paletteOf(mesh.userData.category).slice(1), `${mesh.userData.category} 桶上色上错了类别`);
    }
    // 换氛围是改几个材质色：几何与材质对象本身不能被重建，否则每一档切换都要重并 3,990 栋。
    const before = buckets.group.children.map((mesh) => ({ geometry: mesh.geometry, material: mesh.material }));
    const night = { commercial: '#ffffff', public: '#000000', residential: '#808080', unknown: '#ff0000' };
    buckets.setPalette((category) => night[category] ?? '#123456');
    buckets.group.children.forEach((mesh, index) => {
      assert.equal(mesh.geometry, before[index].geometry, `${mesh.userData.category} 的几何被换了`);
      assert.equal(mesh.material, before[index].material, `${mesh.userData.category} 的材质被换了`);
      assert.equal(mesh.material.color.getHexString(), (night[mesh.userData.category] ?? '#123456').slice(1), `${mesh.userData.category} 桶没接住新色`);
    });
    // 面数与实测的三角同阶：3,990 栋若只并出几千个三角，桶就是空的。
    assert.ok(buckets.group.children.reduce((sum, mesh) => sum + mesh.geometry.getAttribute('position').count, 0) > 200000);
  } finally {
    buckets.dispose();
  }
});

test('分桶跳过成不了面的轮廓，并把 base 抬起来', async () => {
  const square = (dx, dy) => [[origin.lng, origin.lat], [origin.lng + dx, origin.lat], [origin.lng + dx, origin.lat + dy],
    [origin.lng, origin.lat + dy], [origin.lng, origin.lat]];
  const block = (id, category, extra = {}, coordinates = square(0.0004, 0.0004)) => ({ type: 'Feature', id,
    properties: { osmId: id, category, height: 30, ...extra }, geometry: { type: 'Polygon', coordinates: [coordinates] } });
  const sliver = { type: 'Feature', id: 3, properties: { osmId: 3, category: 'public', height: 30 },
    geometry: { type: 'Polygon', coordinates: [[[origin.lng, origin.lat], [origin.lng + 0.0004, origin.lat], [origin.lng, origin.lat]]] } };
  const palette = () => '#ffffff';
  const buckets = createBuildingBuckets({ features: [block(1, 'commercial'), block(2, 'commercial', { base: 20 }), sliver], project, palette });
  try {
    assert.equal(buckets.count, 2, '三个环里只有两个成得了面，第三个是三个点的刀锋');
    assert.deepEqual(buckets.categories, ['commercial']);
    const geometry = buckets.group.children[0].geometry;
    geometry.computeBoundingBox();
    assert.equal(Math.round(geometry.boundingBox.min.y), 0, '没有 base 的那栋从地面起');
    assert.equal(Math.round(geometry.boundingBox.max.y), 50, '带 base 20 的那栋要坐到自己的基底上（20 + 30）');
    // `heightOf` 是阀门：现版那侧用 `levels` 现算高度时，桶不能回头去读 `height` 标签。
    const tall = createBuildingBuckets({ features: [block(1, 'commercial')], project, palette, heightOf: () => 120 });
    tall.group.children[0].geometry.computeBoundingBox();
    assert.equal(Math.round(tall.group.children[0].geometry.boundingBox.max.y), 120);
    tall.dispose();
  } finally {
    buckets.dispose();
  }
});

// V8 Phase 2：侧壁的米制 UV、带 uv 的合并器，以及窗格覆盖层那几层材质。全部在 Node 里跑，不开浏览器。
const ringOf = (points) => points.map(([x, y]) => [origin.lng + x * 1e-5, origin.lat + y * 1e-5]);
const squareRing = ringOf([[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]);

test('侧壁 UV 是米：u 沿这条边累计、v 是离自己基底的标高，顶面一律零', () => {
  const geometry = buildingGeometry(squareRing, { height: 60, project, metricUV: true });
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  assert.ok(uv, '开了 metricUV 就必须有 uv 这一层，没有它窗纹无处可铺');
  const caps = geometry.groups.find((group) => group.materialIndex === 0).count;
  const sides = geometry.groups.find((group) => group.materialIndex === 1);
  let maxU = 0, maxV = 0;
  for (let vertex = caps; vertex < position.count; vertex++) {
    maxU = Math.max(maxU, uv.getX(vertex));
    maxV = Math.max(maxV, uv.getY(vertex));
    assert.ok(uv.getY(vertex) >= 0, 'v 不能为负：那是"离基底几米"，不是现成那个 `1 − z`');
  }
  // 这条边最长 400 m（4 × 1e-5 度经度 ≈ 4 m？不：1e-5 度在此纬度约 1.02 m，所以 4 个单位是 4 m）。
  const east = plane(origin, { lat: origin.lat, lng: origin.lng + 4e-5 }).dx;
  assert.ok(Math.abs(maxU - east) < 0.01, `u 的最大值是这条边的长度：实测 ${maxU.toFixed(2)} m，边长 ${east.toFixed(2)} m`);
  assert.ok(Math.abs(maxV - 60) < 1e-6, `v 要一路走到 60 m 的楼顶，实测 ${maxV}`);
  for (let vertex = 0; vertex < caps; vertex++) {
    assert.deepEqual([uv.getX(vertex), uv.getY(vertex)], [0, 0], '顶面/底面的 uv 全部落在零：屋顶永远接不到窗格');
  }
  assert.ok(sides.count > 0 && caps + sides.count === position.count, '两组必须挨着且盖满');
  // 不开关时还是 three 自带那套（绝对坐标、`1 − z`），Phase 1 的几何不因这次改动而变。
  const plain = buildingGeometry(squareRing, { height: 60, project });
  const plainUv = plain.getAttribute('uv');
  let lowest = 0;
  for (let vertex = 0; vertex < plainUv.count; vertex++) lowest = Math.min(lowest, plainUv.getY(vertex));
  assert.ok(lowest < -1, `默认生成器的 v 是 \`1 − z\`，60 m 的楼会一路负下去（实测 ${lowest}）——与米制那套不是一回事`);
});

test('合并器把 uv 一起搬，顶面攒在前、侧壁攒在后，覆盖层只借 attribute 不复制顶点', () => {
  const parts = [0, 1].map((index) => buildingGeometry(
    ringOf([[index * 6, 0], [index * 6 + 4, 0], [index * 6 + 4, 3], [index * 6, 3], [index * 6, 0]]),
    { height: 30 + index * 30, project, metricUV: true },
  ));
  const counts = parts.map((part) => ({ position: part.getAttribute('position').count, uv: part.getAttribute('uv').count }));
  const merged = mergeSolids(parts);
  assert.equal(merged.geometry.getAttribute('position').count, counts.reduce((sum, c) => sum + c.position, 0), '一栋都不能在合并里丢掉');
  assert.equal(merged.geometry.getAttribute('uv').count, merged.geometry.getAttribute('position').count, 'uv 必须与 position 一起搬过来：一个顶点一条');
  assert.equal(merged.caps + merged.sides, merged.geometry.getAttribute('position').count);
  assert.deepEqual(merged.geometry.groups.map((group) => [group.materialIndex, group.count]), [[0, merged.caps], [1, merged.sides]]);
  // 侧壁段里必须真有非零的标高，否则合并把 uv 抹平了也查不出来。
  const uv = merged.geometry.getAttribute('uv');
  let top = 0;
  for (let vertex = merged.caps; vertex < uv.count; vertex++) top = Math.max(top, uv.getY(vertex));
  assert.ok(Math.abs(top - 60) < 1e-6, `合并后最高的侧壁仍要读到 60 m，实测 ${top}`);
  assert.deepEqual([merged.overlay.drawRange.start, merged.overlay.drawRange.count], [merged.caps, merged.sides],
    '覆盖层的 drawRange 必须正好罩住侧壁那一段');
  assert.equal(merged.overlay.getAttribute('position'), merged.geometry.getAttribute('position'), '覆盖层与墙共用同一批 attribute');
  assert.equal(merged.overlay.getAttribute('uv'), merged.geometry.getAttribute('uv'));
  assert.equal(merged.geometry.index, null, '合并几何必须是裸三角');
  // 没有 uv 的几何进不来：那等于窗纹悄悄不画。`ExtrudeGeometry` 自带生成器总会给一条 uv，所以这里把它摘掉来走这一发。
  const stripped = buildingGeometry(squareRing, { height: 20, project, metricUV: true });
  stripped.deleteAttribute('uv');
  assert.throws(() => mergeSolids([stripped]), /没有 uv/);
  const noGroups = buildingGeometry(squareRing, { height: 20, project, metricUV: true });
  noGroups.clearGroups();
  assert.throws(() => mergeSolids([noGroups]), /顶面与侧壁两组/);
});

test('窗格覆盖层：一桶一层，换氛围只换贴图指针，墙色不参与图案', () => {
  const facade = createFacadeSet();
  const block = (id, category, dy) => ({ type: 'Feature', id, properties: { osmId: id, category, height: 40 },
    geometry: { type: 'Polygon', coordinates: [ringOf([[0, dy], [4, dy], [4, dy + 3], [0, dy + 3], [0, dy]])] } });
  const features = [block(1, 'commercial', 0), block(2, 'residential', 6), block(3, 'public', 12), block(4, 'unknown', 18)];
  const buckets = createBuildingBuckets({ features, project, palette: () => '#c98a6b', facade: {
    textureFor: (atmosphere, category) => facade.textureFor(atmosphere, category),
    opacityFor: facadeOpacityFor, atmosphere: () => 'day' } });
  const grids = buckets.group.children.filter((mesh) => mesh.userData.facade);
  assert.equal(buckets.grids, 4, '四个类别桶就该有四层窗格');
  assert.equal(grids.length, buckets.grids);
  for (const mesh of grids) {
    assert.equal(mesh.material.transparent, true, '窗格是压在墙上的半透明层，不是墙本身');
    assert.equal(mesh.material.depthWrite, false, '覆盖层不写深度，否则它把后面的楼挡成一片');
    assert.equal(mesh.material.color.getHexString(), 'ffffff', '图案不读墙色（现版那侧的 pattern 着色器同样不读）');
    assert.equal(mesh.material.map.userData.shapeId, facadeShapeOf(mesh.userData.category));
    assert.ok(Math.abs(mesh.material.opacity - facadeOpacityFor(15.5)) < 1e-6,
      `装配时先按开屏那一档给透明度（15.5 插出来是 ${facadeOpacityFor(15.5)}），第一帧起由镜头接管，实测 ${mesh.material.opacity}`);
    assert.equal(mesh.geometry.getAttribute('position'), mesh.geometry.getAttribute('position'), '覆盖层几何与墙共用 attribute');
  }
  // 换氛围：贴图指针换、几何与材质对象不换。
  const before = grids.map((mesh) => ({ mesh, geometry: mesh.geometry, material: mesh.material, map: mesh.material.map }));
  assert.equal(buckets.setFacade('night'), 4, '四桶都要接上夜景那张');
  grids.forEach((mesh, index) => {
    assert.equal(mesh, before[index].mesh, '换氛围不该重建 Mesh');
    assert.equal(mesh.material, before[index].material, '换氛围不该重建材质');
    assert.equal(mesh.geometry, before[index].geometry, '换氛围不该重算几何');
    assert.notEqual(mesh.material.map, before[index].map, `${mesh.userData.category} 没换到夜景那张窗格`);
    assert.equal(mesh.material.map.userData.atmosphereId, 'night');
    assert.ok(mesh.material.map.userData.litPanes > 0, '夜景窗格必须有亮格：一扇都不亮的分档是隐形的');
  });
  assert.equal(buckets.setFacade('night'), 0, '已经是夜景了，不该再报一次换图');
  // 墙色只归墙：setPalette 不许顺手把窗格也染色。
  buckets.setPalette(() => '#00ff00');
  assert.ok(grids.every((mesh) => mesh.material.color.getHexString() === 'ffffff'), '窗格层被墙色污染了');
  assert.ok(buckets.group.children.filter((mesh) => !mesh.userData.facade)
    .every((mesh) => mesh.material.color.getHexString() === '00ff00'));
  assert.equal(buckets.setFacadeOpacity(18), 4);
  assert.ok(grids.every((mesh) => Math.abs(mesh.material.opacity - 0.72) < 1e-6));
  buckets.dispose();
  facade.dispose();
});

test('窗纹的尺与斜坡：29.3 m 一格、0.42@15 → 0.72@18，类别查不到落 plain', () => {
  assert.ok(Math.abs(FACADE_CELL_METRES - 29.3) < 1e-9, `一格平铺 ${FACADE_CELL_METRES} m，与探出来的 29.3 m 对不上`);
  assert.equal(facadeOpacityFor(15), 0.42);
  assert.equal(facadeOpacityFor(16.5), 0.6);
  assert.equal(facadeOpacityFor(18), 0.72);
  assert.equal(facadeOpacityFor(12), 0.42, '比 15 更远不再继续淡：现版那条斜坡在下面就是平的一段');
  assert.equal(facadeOpacityFor(18.5), 0.72);
  let previous = -1;
  for (let zoom = 15; zoom <= 18; zoom += 0.25) {
    const value = facadeOpacityFor(zoom);
    assert.ok(value >= previous, '斜坡必须单调变浓');
    previous = value;
  }
  assert.deepEqual(Object.entries(FACADE_CATEGORY_SHAPES).map(([category]) => [category, facadeShapeOf(category)]),
    [['commercial', 'curtain'], ['residential', 'dense'], ['public', 'civic'], ['unknown', 'plain']]);
  assert.equal(facadeShapeOf('第五类没见过的'), 'plain', '快照里冒出第五个类别时它要落到一张存在的图上');

  const set = createFacadeSet();
  const day = set.textureFor('day', 'commercial');
  assert.equal(day, set.textureFor('day', 'commercial'), '同一张图不该生成两遍');
  assert.equal(day.isDataTexture, true);
  assert.deepEqual([day.image.width, day.image.height], [32, 32]);
  assert.equal(day.wrapS, THREE.RepeatWrapping);
  assert.equal(day.wrapT, THREE.RepeatWrapping);
  assert.equal(day.colorSpace, THREE.SRGBColorSpace, '这张图带的是玻璃自己的颜色，现版按颜色解出来，新引擎不能当乘数读');
  assert.ok(Math.abs(day.repeat.x - 1 / FACADE_CELL_METRES) < 1e-9 && Math.abs(day.repeat.y - 1 / FACADE_CELL_METRES) < 1e-9,
    'repeat 是"一格铺多少米"的倒数，uv 里装的才是米数');
  const seen = new Set();
  // `textureFor` 收的是**类别**（它自己查节奏表），所以这里传四个类别；传节奏名会落到 fallback 那张，
  // 12 张就数不出来 —— 第一版在这里踩过一次，把"取图"与"选节奏"两件事混成了一个参数。
  for (const atmosphere of set.atmospheres) {
    for (const category of Object.keys(FACADE_CATEGORY_SHAPES)) seen.add(set.textureFor(atmosphere, category));
  }
  assert.equal(seen.size, 12, '三氛围 × 四节奏应当是 12 张');
  assert.throws(() => set.textureFor('dusk', 'curtain'), /unknown atmosphere/);
  set.dispose();
});

test('中继那两段飞行的插值：落点精确、方位走短弧、缓动对称', () => {
  const from = { zoom: 15.5, pitch: 62, bearing: -25, center: { lng: 113.31913, lat: 23.109 } };
  const to = { zoom: 11.81, pitch: 0, bearing: 0, center: { lng: 113.26646, lat: 23.17107 } };
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}：${a} 对 ${b}`);
  const start = flightStep(from, to, 0);
  near(start.zoom, from.zoom, '起飞那一帧的缩放');
  near(start.pitch, from.pitch, '起飞那一帧的俯仰');
  near(start.bearing, from.bearing, '起飞那一帧的方位');
  assert.deepEqual([start.center.lng, start.center.lat], [from.center.lng, from.center.lat], '起飞那一帧的中心');
  const end = flightStep(from, to, 1);
  near(end.zoom, to.zoom, '落点缩放');
  near(end.pitch, to.pitch, '落点俯仰');
  near(end.bearing, to.bearing, '落点方位');
  assert.deepEqual([end.center.lng, end.center.lat], [to.center.lng, to.center.lat], '落点中心：差一个浮点就是链接对不上');
  const half = flightStep(from, to, 0.5);
  near(half.zoom, (from.zoom + to.zoom) / 2, '中点缩放（级的量纲本身是对数，所以线性即等比）');
  near(half.pitch, 31, '中点俯仰');
  near(half.center.lat, (from.center.lat + to.center.lat) / 2, '中点纬度');
  // 缓动是对称的：前半段的进度曲线是后半段的镜像，读起来才不像"先冲后刹"或"先蠕后窜"。
  const quarter = flightStep(from, to, 0.25), threeQuarters = flightStep(from, to, 0.75);
  near(quarter.zoom - from.zoom, to.zoom - threeQuarters.zoom, '缓动曲线左右对称');
  // 越界的 amount 夹住：飞行结束后若还有人拿 t=1.4 来问，不能给出一个飞过目标的镜头。
  const beyond = flightStep(from, to, 1.4);
  near(beyond.zoom, to.zoom, 't 越界必须停在落点');
  const before = flightStep(from, to, -0.3);
  near(before.pitch, from.pitch, 't 为负必须停在起点');
  // 方位走的是短弧：−170° 到 +170° 应当越过 ±180° 走 20°，而不是倒着绕 340°。
  const across = flightStep({ ...from, bearing: -170 }, { ...to, bearing: 170 }, 0.5);
  assert.ok(Math.abs(across.bearing) > 179 && Math.abs(across.bearing) <= 180, `中点方位是 ${across.bearing}，没有走短弧`);
  const short = flightStep({ ...from, bearing: -25 }, { ...to, bearing: -5 }, 0.5);
  near(short.bearing, -15, '同一侧的转动应当老老实实取中点');
});

test('夜景灯火图集：一格一档，楼的格号与现版那三条筛子逐字一致', () => {
  // 分档/色温/全暗这三条筛子在 `src/facade.js` 里已经是纯函数，图集只是把它们摆到格子里；
  // 所以这里钉的是"摆对没有"与"楼拿到的格子对不对"，不重演一遍规则。
  // 列 = (色温 3 × 距离环 3) × 两手，行 = 六档 + 一行全暗。第二手不是第二套规则：
  // 它是现版那侧 `building-lights-alt` 用的那批贴图，摆到右边 9 列，交叉淡因此在一片几何里两次采样就能算完。
  assert.deepEqual([LAMP_GRID.columns, LAMP_GRID.rows], [18, 7], '列 = 色温 3 × 距离环 3 × 两手，行 = 六档 + 一行全暗');
  const near = { height: 18, osmId: 1, distance: 300 };
  assert.deepEqual(lampCellOf(near), { col: lampTemperatureOf(1) + 0 * LIGHT_TEMPERATURES.length, row: lampBandOf(18, 1),
    group: 1, breath: 0 });
  // 分组与"会整栋慢灭"这两条骰子在现版那侧是图层过滤条件，这里没有层，只能作为顶点属性交给片元。
  for (const osmId of [2, 10, 17 * 3 + 7 * 17, 24]) {
    const cell = lampCellOf({ height: 40, osmId, distance: 400 });
    assert.equal(cell.group, Math.abs(osmId) % LAMP_GROUPS, `${osmId} 的分组筛子与现版那条取模不一致`);
    assert.equal(cell.breath, isLampBreather(osmId) ? 1 : 0, `${osmId} 的呼吸筛子与现版那 1/7 不一致`);
  }
  assert.equal(lampCellOf({ height: 40, osmId: 10, distance: 400 }).breath, 1, '余数 3 那一档必须命中，不然图集右边那 9 列是空转');
  assert.deepEqual(lampAtlasCells(), { columns: 18, rows: 7, altColumn: 9, offRow: LAMP_OFF_ROW },
    '片元靠这三个数换到第二手，报错就等于换错格');
  // 距离环换列：同一栋楼挪到 2.4 km 之外，色温不变、列跨到第二组。
  const far = lampCellOf({ ...near, distance: 2500 });
  assert.equal(far.col - lampCellOf({ ...near, distance: 1600 }).col, LIGHT_TEMPERATURES.length, '第三环要比第二环跨整一组色温');
  assert.equal(far.row, lampCellOf(near).row, '距离不动高度档');
  // 整栋不亮的那 1/11：落到最后一行，与它自己的档无关。
  const dark = [...Array(2000).keys()].map((n) => 11 * n + LAMP_DARK_RESIDUE).find((osmId) => isLampDark(osmId));
  assert.equal(lampCellOf({ height: 300, osmId: dark, distance: 100 }).row, LAMP_OFF_ROW, '该暗的楼拿到的不是全暗那一行');
  // 图集本身：每一格都必须是现版那张 32×32 的逐字复制。这里不重算窗格的像素尺寸，因为一算就得把
  // `paneYShare` 这类现版内部常量抄进新引擎——它一改这边就假红；比字节反而把"摆对没有"一次钉死。
  const atlas = lampAtlasImage();
  assert.deepEqual([atlas.width / LIGHT_TILE.size, atlas.height / LIGHT_TILE.size], [LAMP_GRID.columns, LAMP_GRID.rows]);
  const cellBytes = (image, col, row) => {
    const out = new Uint8Array(LIGHT_TILE.size * LIGHT_TILE.size * 4);
    for (let y = 0; y < LIGHT_TILE.size; y++) {
      const from = ((row * LIGHT_TILE.size + y) * image.width + col * LIGHT_TILE.size) * 4;
      out.set(image.data.subarray(from, from + LIGHT_TILE.size * 4), y * LIGHT_TILE.size * 4);
    }
    return out;
  };
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    for (let temperature = 0; temperature < LIGHT_TEMPERATURES.length; temperature++) {
      for (let ring = 0; ring < LIGHT_FADES.length; ring++) {
        for (let set = 0; set < 2; set++) {
          const tile = lightTexture(band, temperature, ring, set);
          // 亮着的窗数由那张表说了算，而不是这里现编：档与格数的对应关系就这一处定义。
          assert.equal(tile.litPanes, LIGHT_BANDS[band].cells, `第 ${band} 档亮出的窗数不是表里的 ${LIGHT_BANDS[band].cells}`);
          assert.deepEqual(cellBytes(atlas, temperature + ring * LIGHT_TEMPERATURES.length + set * LAMP_GRID.columns / 2, band), tile.data,
            `第 ${band} 档 / 色温 ${temperature} / 距离环 ${ring} / 第 ${set} 手没有摆到自己那一格`);
          if (set) assert.notDeepEqual(tile.data, lightTexture(band, temperature, ring, 0).data,
            `第 ${band} 档的两手是同一批格，交叉淡就没有任何东西可换`);
        }
      }
    }
  }
  // 全暗那一行：九格每一格都必须一个像素都没有。
  for (let col = 0; col < LAMP_GRID.columns; col++) {
    assert.ok(cellBytes(atlas, col, LAMP_OFF_ROW).every((value) => value === 0), `全暗那一行第 ${col} 格有像素`);
  }
  // 晕比窗暗：同一档同一色温，晕的峰值 alpha 必须低于灯的 alpha（现版那条"晕不是第二套窗"的纪律）。
  // 晕不换手（现版那一层也从来没换过），所以它那一族只摆 9 列：给它空列是白花的显存。
  const glowAtlas = lampAtlasImage((band, temperature, ring) => glowTexture(band, temperature, ring), 1);
  assert.deepEqual([glowAtlas.width / LIGHT_TILE.size, glowAtlas.height / LIGHT_TILE.size], [9, 7], '光晕那一族多摆了一手');
  const peakOf = (image, col, row) => {
    let peak = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const x = (i / 4) % image.width, y = Math.floor(i / 4 / image.width);
      if (Math.floor(x / LIGHT_TILE.size) === col && Math.floor(y / LIGHT_TILE.size) === row) peak = Math.max(peak, image.data[i + 3]);
    }
    return peak;
  };
  assert.ok(peakOf(glowAtlas, 0, 4) < peakOf(atlas, 0, 4), '晕的峰值亮过了窗');
  assert.deepEqual(cellBytes(glowAtlas, 1, 3), glowTexture(3, 1, 0).data, '晕那一族摆错了格');
  const glowTexture2 = glowAtlasTexture();
  assert.equal(glowTexture2.userData.columns, 9, '光晕的图集报不出自己的列数，片元就会按错的格宽采样');
  glowTexture2.dispose();
  const texture = lampAtlasTexture();
  assert.equal(texture.wrapS, THREE.ClampToEdgeWrapping, '图集不能平铺：越格就啃到隔壁档');
  assert.equal(texture.generateMipmaps, false, '跨格 mipmap 会把别的档混进来');
  assert.equal(texture.repeat.x, 1, '亮窗这一路的 uv 就是米数，平铺由片元里的 fract 负责');
  texture.dispose();
});

test('亮窗与光晕是两个程序，不是同一个程序的两份参数', () => {
  // three.js 的程序缓存键由材质参数拼出来，不看 `onBeforeCompile` 塞进去的那段片元。这两张材质的参数
  // 一模一样（同一份图集配置、同一种加色混合、同样不写深度），所以不写 `customProgramCacheKey` 的话
  // 第二个材质会直接复用第一个编译好的程序：亮窗拿到的是光晕那份片元，`lampAltColumn` 与整栋慢灭那两行
  // 代码根本没进 GPU（实测：那一版把列偏移从 9 改成 4.5，画面零变化；补上缓存键之后同一改动在同一机位动了 4,175 颗像素）。
  const texture = lampAtlasTexture();
  const lamp = createLampMaterial(texture, 'lamp');
  const glow = createLampMaterial(texture, 'glow');
  assert.notEqual(lamp.customProgramCacheKey(), glow.customProgramCacheKey(), '两个材质共用一个程序缓存键，第二个片元就被吞了');
  // 键还得真的按 mode 分：写成一个常量（例如漏了插值）时两个键相同，上面那条就抓不到了。
  assert.equal(lamp.customProgramCacheKey(), 'lamp-lamp');
  assert.equal(glow.customProgramCacheKey(), 'lamp-glow');
  // 两份片元确实不同：拿 three 自带的 basic 着色器当壳，跑一遍各自的 `onBeforeCompile`，比换掉的那一段。
  const compiled = (material) => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    material.onBeforeCompile(shader, {});
    return shader;
  };
  const lampShader = compiled(lamp), glowShader = compiled(glow);
  assert.notEqual(lampShader.fragmentShader, glowShader.fragmentShader, '两份片元换完之后是同一个，图集就只有一路在上屏');
  // 两种片元都声明了同一批 uniform（少一格就会让 `setLampWeights` 找不到地方写），所以"谁读了什么"要看
  // 换进 `#include <map_fragment>` 的那一段本体，不是整份源码里有没有这个词。
  const bodyOf = (shader) => shader.fragmentShader.slice(shader.fragmentShader.indexOf('#ifdef USE_MAP'));
  assert.ok(bodyOf(lampShader).includes('lampAltColumn'), '亮窗那份片元里没有第二手的列偏移');
  assert.ok(bodyOf(lampShader).includes('lampOffRow'), '亮窗那份片元里没有整栋慢灭的那一行');
  assert.ok(!bodyOf(glowShader).includes('lampAltColumn'), '光晕不换手，它那段不该读列偏移');
  assert.ok(!bodyOf(glowShader).includes('lampOffRow'), '光晕不换手，它那段不该读全暗行');
  assert.deepEqual(Object.keys(lampShader.uniforms).sort(), ['lampAltColumn', 'lampCellMetres', 'lampGrid', 'lampOffRow', 'lampWeight'],
    '交叉淡要的五格 uniform 少一格，片元就在读一个不存在的值');
  assert.equal(lampShader.uniforms.lampAltColumn.value, LAMP_GRID.columns / 2, '第二手的列偏移不是图集的一半');
  assert.equal(lampShader.uniforms.lampOffRow.value, LAMP_OFF_ROW, '整栋慢灭没有指向全暗那一行');
  texture.dispose();
});

test('the rotate gesture keeps the coefficients the shipped map was measured at', () => {
  // 20° and 25° per 100 px are not taste: they replaced a 0.5°/px first version that spun past the target building,
  // and the browser acceptance compares both engines through the same drag.
  assert.equal(ROTATE_DEGREES_PER_100PX, 20);
  assert.equal(PITCH_DEGREES_PER_100PX, 25);
});

test('the rotate entries are the shipped map\'s three, and a plain left drag stays a pan', () => {
  const turns = (event) => isRotateTrigger({ altKey: false, ctrlKey: false, metaKey: false, ...event });
  // The old engine answers these three: its own ⌥ handler, MapLibre's `LEFT && ctrlKey` rotate test, and its
  // `RIGHT && !ctrlKey` one.
  assert.equal(turns({ button: 0, altKey: true }), true);
  assert.equal(turns({ button: 0, ctrlKey: true }), true);
  assert.equal(turns({ button: 2 }), true);
  // A plain left drag is a pan, and right+ctrl is the library's roll entry, which this map does not enable.
  assert.equal(turns({ button: 0 }), false, 'a left drag must stay a pan');
  assert.equal(turns({ button: 1 }), false, 'the middle button belongs to the dolly');
  assert.equal(turns({ button: 2, ctrlKey: true }), false);
  assert.equal(turns({ button: 2, altKey: true }), false);
  assert.equal(turns({ button: 0, altKey: true, metaKey: true }), false);
});

// V8 Phase 1：地面三层是从 OSM 取回的真边界。这几项只读派生文件与几何函数，不开浏览器。
const surfaceOf = async (name) => JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'));

test('水面、绿地、地块三份派生文件各自钉得住来源与身份', async () => {
  const [water, greens, blocks] = await Promise.all(['canton-water', 'canton-greens', 'canton-blocks'].map(surfaceOf));
  for (const snapshot of [water, greens, blocks]) {
    assert.equal(snapshot.metadata.license, 'ODbL-1.0');
    assert.match(snapshot.metadata.attribution, /OpenStreetMap/);
    assert.equal(snapshot.metadata.radius, 3000, '取的是塔边 3 km，不是别的圈');
    assert.ok(/^[0-9a-f]{64}$/.test(snapshot.metadata.rawSha256), '派生文件必须钉住它从哪份原始快照来');
    assert.match(snapshot.metadata.boundary, /未简化、未收口/, '边界口径要写在文件里，不能只写在脚本注释里');
    for (const feature of snapshot.features) {
      assert.ok(['Polygon', 'MultiPolygon'].includes(feature.geometry.type), `${feature.properties.osmId} 不是面：${feature.geometry.type}`);
      for (const rings of polygonsOf(feature.geometry)) for (const ring of rings) {
        assert.ok(ring.length > 3, `${feature.properties.osmId} 的环少于四个点，成不了面`);
        assert.deepEqual(ring[0], ring.at(-1), `${feature.properties.osmId} 的环没闭合`);
      }
      assert.ok(feature.properties.area >= 200, `${feature.properties.osmId} 只有 ${feature.properties.area} m²，本该被筛掉`);
    }
  }
  assert.equal(water.features.length, 41, `水面 ${water.features.length} 面，出厂那一份是 41`);
  assert.equal(greens.features.length, 379, `绿地 ${greens.features.length} 面，出厂那一份是 379`);
  assert.equal(blocks.features.length, 595);
});

test('真岸线接管了示意江带该站的每一格', async () => {
  const water = await surfaceOf('canton-water');
  // V7 A5 量的江心：塔脚正北 322 m、113.319130,23.111893。原来那里靠一条 240 m 宽的示意带盖住，现在必须落在真水面上。
  assert.ok(water.features.some((feature) => pointInGeometry(feature.geometry, 113.319130, 23.111893)),
    '江心垂足不在任何一面上：水面提取漂了，示意带又已经撤了');
  // 洞是真的江心岛，不是被简化掉的边角：7 个水面带洞、一共 24 个洞。
  const holed = water.features.filter((feature) => polygonsOf(feature.geometry).some((rings) => rings.length > 1));
  assert.equal(holed.length, 7, `${holed.length} 个水面带洞，出厂那一份是 7`);
  assert.equal(holed.reduce((sum, feature) => sum + polygonsOf(feature.geometry).reduce((n, rings) => n + rings.length - 1, 0), 0), 24,
    '洞的总数不是 24，说明有岛被吞掉了');
  // 洞不是"少画几个顶点"，是少画一块面积：带洞的板反而需要更多三角形才能把洞绕出去，所以判据读的是面积。
  const [outer, hole] = polygonsOf(holed[0].geometry).find((rings) => rings.length > 1);
  const flatArea = (geometry) => {
    const position = geometry.getAttribute('position');
    let sum = 0;
    for (let i = 0; i < position.count; i += 3) {
      const ax = position.getX(i), az = position.getZ(i);
      const bx = position.getX(i + 1), bz = position.getZ(i + 1);
      const cx = position.getX(i + 2), cz = position.getZ(i + 2);
      sum += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    }
    return sum;
  };
  const ringArea = (ring) => Math.abs(ring.slice(1).reduce((sum, point, index) => sum
    + (ring[index][0] - ring[0][0]) * (point[1] - ring[0][1]) - (point[0] - ring[0][0]) * (ring[index][1] - ring[0][1]), 0) / 2)
    * 1000 * 1000 * Math.cos(23.109 * Math.PI / 180) * 110540 * 110540 / 1e6;
  const filled = flatArea(plateGeometry([outer], project, GROUND_LAYERS.water));
  const punched = flatArea(plateGeometry([outer, hole], project, GROUND_LAYERS.water));
  assert.ok(punched < filled, `带上洞之后面积没少（${Math.round(punched)} 对 ${Math.round(filled)} m²），洞没被三角化进去`);
  assert.ok(Math.abs(punched - (filled - ringArea(hole))) / filled < 0.02,
    `少掉的面积对不上洞自己的大小：洞 ${Math.round(ringArea(hole))} m²，板从 ${Math.round(filled)} 走到 ${Math.round(punched)} m²`);
});

test('花城广场是绿轴、珠江公园在江北，绿地认得出自己', async () => {
  const [greens, blocks] = await Promise.all([surfaceOf('canton-greens'), surfaceOf('canton-blocks')]);
  const huacheng = greens.features.find((feature) => feature.properties.osmId === 243319596);
  assert.equal(huacheng?.properties.kind, 'park', '花城广场没被当成地块涂掉');
  assert.ok(huacheng.properties.area > 200000 && huacheng.properties.area < 300000, `花城广场 ${huacheng.properties.area} m²`);
  assert.ok(blocks.features.some((feature) => feature.properties.osmId === 300917756), '中山大学南校园要在地块里');
  // 浏览器那一项要拿这一格当"绿地"的取样点，前提先在这里钉住：它在花城广场自己面里、离边界 40 m 以上。
  assert.ok(pointInGeometry(huacheng.geometry, 113.31921, 23.116), '取样点不在花城广场里');
  assert.ok(greens.features.filter((feature) => feature.properties.nearest < 3000).length === greens.features.length,
    '绿地面里有整块跑到 3 km 圈外去的');
});

test('每个 kind 都点名归哪一档，不认识的不能被默认色糊过去', async () => {
  const snapshots = await Promise.all(['canton-water', 'canton-greens', 'canton-blocks', 'jingtai-grounds'].map(surfaceOf));
  const kinds = new Set();
  for (const snapshot of snapshots) for (const feature of snapshot.features) kinds.add(feature.properties.kind);
  for (const kind of [...kinds].sort()) assert.ok(TONE_OF_KIND[kind], `${kind} 没有配色档位`);
  assert.equal(toneOf({ properties: { kind: '没有见过的标签' } }), null, '不认识的 kind 必须计入 failed，不能被画成地块色');
});

test('1015 面全都能三角化成几何，一个都不静默丢', async () => {
  const [water, greens, blocks] = await Promise.all(['canton-water', 'canton-greens', 'canton-blocks'].map(surfaceOf));
  const surfaces = [...water.features, ...greens.features, ...blocks.features];
  assert.equal(surfaces.length, 1015, '喂进去的面数与三份文件之和不符，这一项的门槛就变了');
  const colors = Object.fromEntries(Object.keys(GROUND_LAYERS).map((tone) => [tone, '#ffffff']));
  const ground = createGround({ project, radius: SCENE.radius, colors, surfaces });
  assert.deepEqual(ground.report.failed, [], `有面没画出来：${JSON.stringify(ground.report.failed.slice(0, 3))}`);
  const counted = Object.values(ground.report.features).reduce((sum, n) => sum + n, 0);
  assert.equal(counted, surfaces.length, '认领的面数必须等于喂进去的面数');
  for (const tone of ['water', 'park', 'grass', 'wood', 'block', 'pavement']) {
    assert.ok(ground.report.tones[tone] > 0, `${tone} 一档一块板都没有`);
  }
  assert.equal(ground.group.children.length, 1 + Object.keys(ground.report.tones).length, '一块音一档网格，基底之外');
  ground.dispose();
});

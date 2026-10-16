import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { SCENE } from '../src/config.js';
import { createProjection } from '../src/engine/projection.js';
import { GROUND_LAYERS, toneOf } from '../src/engine/ground.js';
import { RIVER_FRAGMENT, RIVER_SHEEN_LIFT_METRES, createRiverSheen, riverTiles } from '../src/engine/river.js';
import { RIVER_OPACITY_STOPS, WATER_THEMES, riverOpacityFor, riverOpacityExpression, waterTexture } from '../src/water.js';
import { metresPerPixel } from '../src/engine/camera.js';
import { destination } from '../src/geo.js';

const project = createProjection(SCENE.center);
const snapshot = async (name) => (await JSON.parse(await readFile(new URL(`../public/data/${name}.geojson`, import.meta.url), 'utf8'))).features;
// 与 `scene.js` 同一份拼法：水面＋绿地＋地块，波光只认其中 `toneOf` 判成 water 的那批。
const surfacesOf = async () => [...await snapshot('canton-water'), ...await snapshot('canton-greens'), ...await snapshot('canton-blocks')];

test('三档氛围各一张贴图，像素与现版那张逐字节相同', () => {
  const tiles = riverTiles();
  assert.deepEqual(Object.keys(tiles).sort(), ['day', 'night', 'sunset'], '贴图档数与现版不是同一批');
  for (const [id, options] of Object.entries(WATER_THEMES)) {
    const shipped = waterTexture(options);
    const texture = tiles[id];
    assert.ok(texture.isTexture, `${id} 那档不是一张贴图`);
    assert.equal(texture.image.width, shipped.width);
    assert.equal(texture.image.height, shipped.height);
    assert.deepEqual([...texture.image.data], [...shipped.data], `${id} 那张图的像素与现版那份不是同一批`);
    assert.equal(texture.userData.size, options.size);
    assert.equal(texture.userData.rows, options.rows);
    assert.equal(texture.userData.dashes, shipped.dashes, `${id} 那张的短横数与自己生成的那份对不上`);
    // 屏幕节奏不能开 mipmap：非整数倍率会把 crest 与 trough 平均成一团灰，波光就没了。
    assert.equal(texture.generateMipmaps, false, `${id} 那张贴图开了 mipmap`);
    assert.equal(texture.colorSpace, THREE.SRGBColorSpace, `${id} 那张贴图没按 sRGB 解`);
  }
});

test('波光的名单就是地面那层的水面：41 面全在、并成一块网格', async () => {
  const surfaces = await surfacesOf();
  const water = surfaces.filter((feature) => toneOf(feature) === 'water');
  const river = createRiverSheen({ project, surfaces });
  assert.equal(river.mesh.name, 'river-sheen-water');
  assert.equal(river.group.children.length, 1, '波光不该被拆成好几块网格');
  const report = river.report();
  assert.equal(report.faces, water.length, '起波光的面数与判成水系的面数不一致');
  assert.ok(report.plates > 0 && report.failed.length === 0, `有面没铺出来：${JSON.stringify(report.failed)}`);
  assert.ok(report.vertices > 0);
  assert.equal(report.atmosphere, 'day');
  assert.equal(report.built, false, '还没编译就不该报 built');
  river.dispose();
});

test('波光站在水面之上、路面带之下——爬上路带就是画错', async () => {
  const surfaces = await surfacesOf();
  const river = createRiverSheen({ project, surfaces });
  const position = river.mesh.geometry.getAttribute('position');
  const expected = GROUND_LAYERS.water + RIVER_SHEEN_LIFT_METRES;
  assert.ok(expected < GROUND_LAYERS.road, `这一层 ${expected} m 已经压到路带 ${GROUND_LAYERS.road} m 上面了`);
  const ys = new Set();
  for (let index = 0; index < position.count; index++) ys.add(Math.round(position.getY(index) * 1000) / 1000);
  assert.deepEqual([...ys], [Math.round(expected * 1000) / 1000], `波光不在同一张平面上：${JSON.stringify([...ys])}`);
  river.dispose();
});

test('透明度读现版那条斜坡，并且只在跨 1/20 级时重写', async () => {
  const surfaces = await surfacesOf();
  const river = createRiverSheen({ project, surfaces });
  // 斜坡本身就是现版那条表达式：两边读同一份档表，表达式摊平出来必须逐字相同。
  assert.deepEqual(riverOpacityExpression(), ['interpolate', ['linear'], ['zoom'], 12, 0.4, 14, 0.72, 18.5, 0.72]);
  assert.deepEqual(RIVER_OPACITY_STOPS, [[12, 0.4], [14, 0.72], [18.5, 0.72]]);
  const seen = [];
  for (const zoom of [10, 12, 13, 14, 15.5, 18.5, 19]) {
    const out = river.setView({ zoom, bearing: -25, pixelRatio: 2, width: 1440, height: 960 });
    seen.push([zoom, Math.round(out.opacity * 1000) / 1000]);
    assert.equal(river.mesh.material.opacity, riverOpacityFor(zoom), `${zoom} 级上材质与斜坡不是同一个数`);
  }
  assert.deepEqual(seen, [[10, 0.4], [12, 0.4], [13, 0.56], [14, 0.72], [15.5, 0.72], [18.5, 0.72], [19, 0.72]]);
  // 按 1/20 级归档：镜头停在同一档里就不必再写这一笔；跨档必须写，不然这个计数器是空的。
  const material = river.mesh.material;
  river.setView({ zoom: 15.52, bearing: -25, pixelRatio: 2, width: 1440, height: 960 });
  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(material, 'opacity');
  Object.defineProperty(material, 'opacity', {
    configurable: true,
    get: () => descriptor.value,
    set: (value) => { writes++; descriptor.value = value; },
  });
  for (let index = 0; index < 5; index++) river.setView({ zoom: 15.52, bearing: -25, pixelRatio: 2, width: 1440, height: 960 });
  assert.equal(writes, 0, `同一档里写了 ${writes} 次透明度，归档没生效`);
  river.setView({ zoom: 15.6, bearing: -25, pixelRatio: 2, width: 1440, height: 960 });
  assert.equal(writes, 1, `跨了 1/20 级只该写一次，实际写了 ${writes} 次（0 次说明这条计数器根本没接上）`);
  Object.defineProperty(material, 'opacity', { configurable: true, ...descriptor });
  river.dispose();
});

test('滚动是一个环：绕一行回到出厂那一行，负数与多步都绕回来', async () => {
  const surfaces = await surfacesOf();
  const river = createRiverSheen({ project, surfaces });
  const size = river.report().tile;
  assert.equal(size, WATER_THEMES.day.size);
  assert.equal(river.advance(1), 1);
  assert.equal(river.advance(size - 1), 0, `走完一整圈 ${size} 行没回到出厂那一行`);
  assert.equal(river.advance(size + 6), 6, '多步没按整圈取模');
  river.reset();
  assert.equal(river.advance(-1), size - 1, '倒着滚没绕回上一行');
  assert.equal(river.reset(), 0);
  river.dispose();
});

test('换氛围＝换采样那一张图并把格子放回出厂那一行', async () => {
  const surfaces = await surfacesOf();
  const river = createRiverSheen({ project, surfaces });
  river.advance(9);
  assert.equal(river.setAtmosphere('night'), 'night');
  const report = river.report();
  assert.equal(report.scroll, 0, '换了氛围还留着上一档的偏移，现版那侧是三张都重写成第 0 行');
  assert.equal(report.atmosphere, 'night');
  // 同档重复切不该把滚动打断：按同一个按钮不该让江面当众跳一行。
  river.advance(4);
  assert.equal(river.setAtmosphere('night'), 'night');
  assert.equal(river.report().scroll, 4, '重复切同一档把偏移清零了');
  assert.equal(river.setAtmosphere('nope'), 'night', '不存在的档位把当前档改掉了');
  river.dispose();
});

test('没有水面的那一侧照样造得出来、拆得干净，贴图不留在显存里', async () => {
  // 喂给它的那批面里一个水系都没有（绿地＋地块），波光这一层就该整个不存在。
  const dry = [...await snapshot('canton-greens'), ...await snapshot('canton-blocks')];
  assert.equal(dry.filter((feature) => toneOf(feature) === 'water').length, 0, '这一份夹具里混进水面了');
  const river = createRiverSheen({ project, surfaces: dry });
  assert.equal(river.mesh, null, '一批面里没有水系，就不该有波光网格');
  assert.equal(river.group.children.length, 0);
  assert.equal(river.report().faces, 0);
  assert.equal(river.setView({ zoom: 16, bearing: 0, pixelRatio: 1, width: 800, height: 600 }), null);
  assert.equal(river.advance(3), null);
  assert.equal(river.reset(), null);
  river.dispose();
  const tiles = riverTiles();
  const fired = new Set();
  for (const texture of Object.values(tiles)) texture.addEventListener('dispose', () => fired.add(texture));
  const idle = createRiverSheen({ project, surfaces: dry, tiles });
  assert.equal(idle.mesh, null);
  assert.equal(fired.size, 3, `没有水面那一侧只还了 ${fired.size} 张贴图`);
});

test('片元是屏幕空间的：读 gl_FragCoord，不退回米制 uv，也不带非 ASCII 注释', async () => {
  assert.match(RIVER_FRAGMENT, /gl_FragCoord/, '波光的格子不是从屏幕位置来的');
  assert.match(RIVER_FRAGMENT, /riverScale/, '没有设备倍率这一格，2 倍屏上格子就只有现版的一半大');
  assert.match(RIVER_FRAGMENT, /riverRotate/, '没有转角，镜头一转波纹就会跟着画布走');
  assert.match(RIVER_FRAGMENT, /riverOffset/, '没有地面相位，平移时格子会从江面底下溜过去（现版是跟着地面走的）');
  assert.match(RIVER_FRAGMENT, /fract\(/, '平铺不是自己算的，那就得靠 uv 属性——这一块的几何没有 uv');
  assert.doesNotMatch(RIVER_FRAGMENT, /vMapUv|vUv/, '退回米制 uv 就不是"一个图像像素对一个屏幕像素"了');
  // GLSL 的源码字符集按规范只有 ASCII：注释里塞中文，个别驱动会在词法阶段就把整块材质顶回来。
  assert.doesNotMatch(RIVER_FRAGMENT, /[^\x00-\x7F]/u, '片元源码里有非 ASCII 字符');
  const surfaces = await surfacesOf();
  const river = createRiverSheen({ project, surfaces });
  const material = river.mesh.material;
  assert.equal(material.customProgramCacheKey(), 'river-sheen', '这块材质没带自己的缓存键，会和灯窗那两份撞车');
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false, '波光写了深度就会挡住它后面的东西');
  assert.equal(material.fog, true, '波光是画在水面上的，远处要跟着水面一起进雾');
  assert.equal(material.side, THREE.DoubleSide, '反着绕的水面环只靠双面才出画');
  // 双面＋半透明在 three 里默认拆成两遍画（背面一遍、正面一遍），一块平的覆盖层白付一发数：实测 25 发变 26 发、三角形多算一份。
  assert.equal(material.forceSinglePass, true, '这一层没关掉双遍绘制，一次渲染要发两发');
  river.dispose();
});

test('格子的起点跟着地面走：平移一整格回到原地，半格就是 32 个屏幕像素', async () => {
  const surfaces = await surfacesOf();
  const river = createRiverSheen({ project, surfaces });
  const centre = { lat: 23.1105, lng: 113.3205 };
  const zoom = 15.5;
  const size = river.report().tile;
  assert.equal(size, 64, '这一档贴图不是 64 像素见方');
  const mpp = metresPerPixel({ zoom, latitude: centre.lat });
  // 用投影自己反解"往东挪多少经度等于挪 N 米"，不拿 `destination` 的大圆距离去比本地米制网格，
  // 否则这里差的就不再是相位而是两套米数。
  const perDegree = project({ lat: centre.lat, lng: centre.lng + 1 }).x - project(centre).x;
  const east = (metres) => ({ lat: centre.lat, lng: centre.lng + metres / perDegree });
  const view = (patch) => river.setView({ zoom, bearing: 0, pixelRatio: 1, width: 1440, height: 960, centre, ...patch }).offset;
  const here = view({});
  assert.ok(here.every((value) => value >= 0 && value < size), `相位没按整格取余：${JSON.stringify(here)}`);
  const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}：${JSON.stringify([a, b])}`);
  // 沿正东走完整整一张贴图的米数——图案该落回同一批纹素。
  const whole = view({ centre: east(size * mpp) });
  near(whole[0], here[0], '平移一整格之后 x 方向的相位变了');
  near(whole[1], here[1], '平移一整格之后 y 方向的相位跟着动了');
  // 走半格：x 恰好挪 32 个屏幕像素（绕回环的另一侧算同一个数）。
  const half = view({ centre: east(size * mpp / 2) });
  near(((half[0] - here[0] + size * 4) % size), size / 2, '平移半格没挪 32 个屏幕像素');
  // 缩放改的是"一米占几个屏幕像素"，所以同一片地在上升一级后占的格数按 2 的幂走。
  const doubled = view({ zoom: zoom + 1 });
  near(doubled[0], (here[0] * 2) % size, '升一级缩放后 x 的相位没翻倍');
  // 没交镜头中心就不该动相位：谁把这一格清空了，波纹会在换帧那一刻当众跳一下。
  const untouched = river.setView({ zoom: zoom + 1, bearing: 0, pixelRatio: 1, width: 1440, height: 960 }).offset;
  assert.deepEqual(untouched, doubled, `没交镜头中心却把相位挪了：${JSON.stringify([doubled, untouched])}`);
  river.dispose();
});

test('拆场景时这块的几何、材质与三张贴图都还掉，组里节点摘干净（与 #177 同一口径）', async () => {
  const surfaces = await surfacesOf();
  const owned = new Set();
  const fired = new Set();
  const watch = (item, label) => { owned.add(label); item.addEventListener('dispose', () => fired.add(label)); };
  const tiles = riverTiles();
  for (const [id, texture] of Object.entries(tiles)) watch(texture, `texture:${id}`);
  const river = createRiverSheen({ project, surfaces, tiles });
  watch(river.mesh.geometry, 'geometry');
  watch(river.mesh.material, 'material');
  assert.equal(owned.size, 5, `台账只有 ${owned.size} 样，波光这一层应该交得出几何＋材质＋三张贴图`);
  river.dispose();
  assert.deepEqual([...owned].filter((label) => !fired.has(label)), [], '还有没还的：见左侧清单');
  assert.equal(river.group.children.length, 0, 'dispose 之后组里还留着节点');
});

// V8 Phase 0：引擎的装配。渲染循环、光照、FPS 面板、hash 同步都在这一个人手里，别的模块只管自己那块几何。
//
// 它不 fetch 数据、不碰 DOM 控件：数据由调用方喂进来（`data`），容器由调用方给（`container`），
// 这样这份文件能在 Node 里被单元测试直接构造 —— 现版的 `map.js` 只能在浏览器里测，是这轮最想避开的路。
import * as THREE from 'three';
import { ATMOSPHERES } from '../atmosphere.js';
import { DEFAULT_CENTER, SCENE, VIEW_LIMITS } from '../config.js';
import { formatView, parseView } from '../link.js';
import { FLY_IN_MS } from '../scene-flight.js';
import { LANDMARKS } from '../landmarks.js';
import { createRig } from './camera.js';
import { createGround } from './ground.js';
import { createBuildingBuckets, drawnHeight, pickTallest } from './buildings.js';
import {
  createFacadeSet, createLampMaterial, facadeOpacityFor, glowAtlasTexture, glowOpacityFor, lampAtlasTexture, lampCellOf,
  lampOpacityFor, setLampWeights,
} from './facades.js';
import { createProjection } from './projection.js';
import { createRiverSheen } from './river.js';
import { LAMP_PERIODS_MS, lampWeight } from '../facade.js';
import { createBloom } from './bloom.js';

// 与现版同一个 120 ms 一拍：车流、行人与交叉淡都骑这一拍，两引擎的动效因此按同一个步长推进，
// 判据可以把"同一秒的同一格"在两边各读一次来对。
const MOTION_STEP_MS = 120;

// One colour per ground tone, and every one of them is a colour the shipped map already puts on that layer
// (`src/atmosphere.js`), so this is the same palette rather than a new one. `pavement` is a pedestrian area, drawn in
// the same paving the road ribbons use; `block` is the generic landuse tint under a residential block.
// The keys here are the tone names `createGround` names its meshes with, so a mode switch is one lookup per mesh.
export const groundColors = (preset) => ({
  // The base disc stands in for the style's `background` layer, which is what the map paints under everything -
  // `footprint` is the colour a building's own pad gets, and using it here greyed the whole ground a shade darker
  // than the shipped picture.
  base: preset.background,
  block: preset.land,
  pavement: preset.road,
  grass: preset.grass,
  park: preset.park,
  wood: preset.wood,
  water: preset.water,
  road: preset.road,
});

// The same four-category wall palette the map uses today, read off the block's own `category`, so the new engine does
// not invent a fifth colour for the untagged ones. Buckets are per category, so this answers by category.
export const wallColors = (preset) => (category) =>
  preset.buildings?.[category] ?? preset.buildings?.unknown ?? preset.footprint;

export const skyFor = (preset) => ({ background: preset.sky?.['sky-color'] ?? preset.background, fog: preset.sky?.['fog-color'] ?? preset.background });

// The fog band rides the sight line rather than sitting at a fixed 1.5~9 km. These two ratios are chosen so the
// opening camera (zoom 15.5 = 2,234 m of sight line) keeps exactly the band the skeleton shipped with, while a camera
// pulled out to the 看全范围 level stops putting the whole city behind 100 % fog - at 12 km out a fixed 9 km far plane
// is an empty sky with a ghost in it.
export const FOG_RATIOS = { near: 0.671, far: 4.029 };

/**
 * 地标名牌（Phase 1 版）。只负责一件事：名字落在该落的像素上，出了画面就收。
 * 剪影、拥挤避让与点击开卡是 Phase 4 的交互，这里不复制第二套，免得两条引擎各长一份名牌逻辑。
 */
function createLabels({ container, screen }) {
  const plates = LANDMARKS.map((landmark) => {
    const node = document.createElement('span');
    node.className = 'landmark engine-landmark';
    node.dataset.osmId = String(landmark.osmId);
    const name = document.createElement('span');
    name.className = 'landmark-name';
    name.textContent = landmark.name;
    node.append(name);
    container.append(node);
    return { landmark, node };
  });
  return {
    count: plates.length,
    place: () => {
      for (const { landmark, node } of plates) {
        const [lng, lat] = landmark.center;
        const point = screen({ lng, lat, altitude: 0 });
        if (!point.onScreen) node.classList.add('is-hidden');
        else {
          node.classList.remove('is-hidden');
          // 与 MapLibre 那侧 `anchor: 'bottom'`、offset [0, -6] 同一个挂法：牌压在它指的那一点上方。
          node.style.transform = `translate(-50%, -100%) translate(${point.x}px, ${point.y - 6}px)`;
        }
      }
    },
    // 布局读数只在验收时取：每帧读 `getBoundingClientRect` 会强制整块重排。
    // 取的是盒子的**下边中点**，不是中心：牌是按 `anchor: bottom` 挂在投影点上方 6 px 的，盒子自己高多少（拥挤时
    // 现版那块会收掉名字）不该体现在落点上，而中心会 —— 实测差 11.7 px，正是牌高的一半。
    report: () => plates.map(({ landmark, node }) => {
      const box = node.getBoundingClientRect();
      return { osmId: landmark.osmId, name: landmark.name, hidden: node.classList.contains('is-hidden'),
        x: Math.round((box.x + box.width / 2) * 10) / 10, y: Math.round((box.y + box.height) * 10) / 10 };
    }),
    dispose: () => { for (const { node } of plates) node.remove(); },
  };
}

/** Frames per second and the longest gap between them, the two numbers the brief's FPS ≥ 50 line is graded on. */
export function createFpsMeter({ every = 500, onSample } = {}) {
  let frames = 0, windowStart = 0, longest = 0, previous = 0;
  return {
    tick: (time) => {
      if (!windowStart) { previous = windowStart = time; return null; }
      longest = Math.max(longest, time - previous);
      previous = time;
      frames++;
      if (time - windowStart < every) return null;
      const sample = { fps: Math.round(frames * 1000 / (time - windowStart) * 10) / 10, frames, ms: Math.round(longest * 10) / 10 };
      frames = 0;
      longest = 0;
      windowStart = time;
      onSample?.(sample);
      return sample;
    },
  };
}

/**
 * @param {{container: HTMLElement, canvas?: HTMLCanvasElement, mode?: string, data: {buildings?: object[], streets?: object[], water?: object[], greens?: object[], blocks?: object[], grounds?: object[]},
 *   nearField?: object, // 近场三组（车、人、船，`src/near-field.js` 造好交进来）
 *   bases?: object, // 楼根接地带（`src/shadow-pads.js`，与现版同一份）
 *   testBuildings?: number, // 0 = 画全量；给一个 N 就只立最高的 N 栋 limits?: object, onFrame?: Function, writeHash?: boolean}} options
 */
export function createEngineScene(options) {
  const {
    container, canvas = container.querySelector('canvas') ?? document.createElement('canvas'),
    mode = 'day', data = {}, testBuildings = 0, limits = VIEW_LIMITS, onFrame, writeHash = true, arrive = null,
  } = options;
  // 当前氛围的 id。窗纹按 id 取图（`FACADE_THEMES` 的键就是它），所以这个 id 必须活着，不能只剩一堆混好的颜色。
  let atmosphereId = ATMOSPHERES[mode] ? mode : 'day';
  const project = createProjection(SCENE.center ?? DEFAULT_CENTER);
  if (!canvas.parentElement) {
    // Appended, not swapped in: `#map` also carries the loading strip and the error banner, and wiping the container
    // would take them with it - the same nodes the rest of this file then tries to hide.
    canvas.className = 'engine-canvas';
    container.prepend(canvas);
  }
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(sun, hemisphere);
  const fog = new THREE.Fog(0x000000, 1500, 9000);
  scene.fog = fog;

  const surfaces = [...(data.water ?? []), ...(data.greens ?? []), ...(data.blocks ?? []), ...(data.grounds ?? [])];
  const ground = createGround({ project, radius: SCENE.radius, colors: groundColors(ATMOSPHERES[atmosphereId] ?? ATMOSPHERES.day),
    streets: data.streets ?? [], surfaces });
  // 江面那层波光：与现版同一个形状——水面是一层平色，波光压在它上面、只带 alpha。像素出自 `src/water.js` 那三张图，
  // 挑面的名单也出自同一张 `toneOf` 表，所以"画了水色的那些面"与"起波光的这些面"必然是同一批。
  const river = createRiverSheen({ project, surfaces, atmosphere: atmosphereId });
  // 默认画全量：3,990 面按类别并成几桶。`testBuildings` 留着一个调试阀门——要只看最高的 N 栋时传个数进来，
  // 现版那套"取真实最高的 10 栋、按高度再按 id 排序"的确定性还在 `pickTallest` 里。
  const features = testBuildings ? pickTallest(data.buildings ?? [], testBuildings) : (data.buildings ?? []);
  // Phase 2 的窗纹：像素、节奏表、类别映射与透明度斜坡全部读 `src/facade.js` 那一套，现版与新引擎共用同一份定义。
  // 夜景亮窗走图集（`lampAtlasTexture`）：一格一档（高度带 × 色温 × 距离环，外加一行"整栋不亮"），
  // 楼的格号作为逐顶点属性带进几何，片元里 `fract` 回自己那一格 —— 桶因此还是四个，不必按档拆。
  const facades = createFacadeSet();
  const lampTexture = lampAtlasTexture();
  const glowTexture = glowAtlasTexture();
  const lampMaterial = createLampMaterial(lampTexture, 'lamp');
  const glowMaterial = createLampMaterial(glowTexture, 'glow');
  const buildings = createBuildingBuckets({ features, project,
    palette: wallColors(ATMOSPHERES[atmosphereId] ?? ATMOSPHERES.day),
    facade: { textureFor: facades.textureFor, opacityFor: facadeOpacityFor, atmosphere: () => atmosphereId,
      lamp: { cellOf: lampCellOf, material: lampMaterial, opacityFor: lampOpacityFor },
      glow: { material: glowMaterial, opacityFor: glowOpacityFor } } });
  // 车流、行人与船是现版那套确定性算法的产物：同一份路网、同一个米制原点（`project` 的 x/−y 与它的
  // `position.set(x, 0, -y)` 逐字相同），所以这一层不需要第二份"怎么摆车"的代码，摆进来的就是同一批实例。
  // 装配与开关都在 `src/near-field.js` 那一个口令后面，由调用方造好交进来（那颗光晕贴图要 DOM），
  // 没有它的时候引擎照样能构造——学校的场景就没有近场。
  const nearField = options.nearField ?? null;
  for (const group of nearField?.groups ?? []) scene.add(group);
  // 楼根那一圈接地带与近场同一份模块、同一条镜头门控（现版那侧在 `tower.js` 的 render 里读同一个数）。
  const bases = options.bases ?? null;
  if (bases) scene.add(bases.group);
  scene.add(ground.group, river.group, buildings.group);

  // 现版那个循环写的是样式与 global state，这里写的是一格图集里的两个采样权重与一批实例矩阵。
  // 两组的周期与 `lampWeight` 都从 `src/facade.js` 取，所以同一时刻两边给同一组楼的是同一个数。
  const motion = { on: false, previous: undefined, carry: 0, life: 0, lamp: 0, lights: 0, lampTicks: 0, riverSteps: 0 };
  const lampMaterials = [lampMaterial, glowMaterial];
  const lampWeights = () => LAMP_PERIODS_MS.map((period) => lampWeight((motion.lamp / period) % 1));
  function stepMotion(elapsed, view) {
    motion.life += elapsed;
    nearField?.advance(motion.life / 1000, view.zoom);
    // 江面每一拍滚一整行（一个 CSS 像素），与现版那句 `scrollRiver(steps)` 同一个步长；滚的是偏移量而不是像素，
    // 所以这一格不像现版那样每拍重传一张图，但绕回一行的环是同一个（`river.js` 里那句取模与它逐字对应）。
    const riverSteps = Math.round(elapsed / MOTION_STEP_MS);
    if (riverSteps > 0) {
      river.advance(riverSteps);
      motion.riverSteps += riverSteps;
    }
    motion.lights++;
    // 灯窗那一拍只在夜景推进，与现版 `map.js` 里 `atmosphereId === 'night'` 那道闸门同一条。白天那八层本来就不画，
    // 让权重跟着走有两处不对：读数轨上两引擎同一秒报的不是同一批数（现版 `lampTicks` 在白天是 0），
    // 而画面上一按到夜景，现版从出厂那一对 1/1 起步、这一侧却从半路开始淡。
    if (atmosphereId === 'night') {
      motion.lamp += elapsed;
      setLampWeights(lampMaterials, ...lampWeights());
      motion.lampTicks++;
    }
  }
  // 停下来不是暂停：车流回到出厂那一格、两组的权重回到 1/1，也就是"这个功能不存在的那一页"画的同一帧。
  function settleMotion(zoom) {
    motion.life = 0;
    motion.lamp = 0;
    nearField?.advance(0, zoom);
    river.reset();
    setLampWeights(lampMaterials, 1, 1);
  }

  // One preset walks the whole frame: the sun, the sky the fog fades into, the ground tones and the wall tones. It has
  // to run at boot as well as on a switch - with only the switch calling it, the first picture was lit by the
  // placeholder lights above and cleared to the renderer's black, which is the black band the Phase 0 screenshots
  // show over the far field.
  const applyPreset = (preset) => {
    const tower = preset.tower;
    hemisphere.color.set(tower.hemisphere[0]);
    hemisphere.groundColor.set(tower.hemisphere[1]);
    hemisphere.intensity = tower.hemisphere[2];
    sun.color.set(tower.directional[0]);
    sun.intensity = tower.directional[1];
    sun.position.set(...tower.position);
    const sky = skyFor(preset);
    scene.background = new THREE.Color(sky.background);
    fog.color.set(sky.fog);
    const colors = groundColors(preset);
    buildings.setPalette(wallColors(preset));
    // 换氛围时换的是每桶材质上那张贴图的指针：12 张（三氛围 × 四节奏）按需生成，生成过就留着。
    buildings.setFacade(atmosphereId);
    for (const mesh of ground.group.children) {
      // Every plate is named after the tone it is painted in, so a mode switch is one lookup per mesh and a tone
      // that ever gains its own colour needs no change here.
      const color = colors[mesh.name.replace('ground-', '')];
      if (color) mesh.material.color.set(color);
    }
  };

  applyPreset(ATMOSPHERES[atmosphereId] ?? ATMOSPHERES.day);

  const screenPoint = new THREE.Vector3();
  const stored = writeHash ? parseView(globalThis.location?.hash).camera : null;
  // 开屏那一格：地址里的深链最优先，其次是接力留下的中继那一格（V4-8 的下半场），最后才是本场景的默认机位。
  const heroView = { center: SCENE.center, zoom: SCENE.camera.zoom, bearing: SCENE.camera.bearing, pitch: SCENE.camera.pitch };
  const rig = createRig({
    canvas,
    project,
    limits,
    initial: stored ?? arrive ?? heroView,
  });

  const screen = ({ lng, lat, altitude = 0 }) => {
    const ground = project({ lng, lat });
    screenPoint.set(ground.x, altitude, ground.z).project(rig.camera);
    return { x: (screenPoint.x * 0.5 + 0.5) * (canvas.clientWidth || 1), y: (-screenPoint.y * 0.5 + 0.5) * (canvas.clientHeight || 1), onScreen: screenPoint.z < 1 };
  };
  const labels = createLabels({ container, screen });
  const stats = createFpsMeter();
  const panel = document.createElement('div');
  panel.className = 'engine-stats';
  panel.setAttribute('aria-live', 'off');
  container.append(panel);

  function motionAvailable() { return Boolean(nearField?.groups.length) || Boolean(river.mesh) || atmosphereId === 'night'; }
  function motionStatus() {
    const sheen = river.report();
    return { on: motion.on, available: motionAvailable(), stepMs: MOTION_STEP_MS, lampMs: LAMP_PERIODS_MS,
      lights: motion.lights, lampTicks: motion.lampTicks, lamps: lampWeights(),
      // 江面那三格与现版同名同义：`phase` 是此刻滚到第几行、`steps` 是这一页一共滚了几行、`tiles` 是有几档贴图
      // （没有水面的那侧就是 0）。判据因此可以把同一秒的两边并排对。
      phase: sheen.scroll, steps: motion.riverSteps, tiles: river.mesh ? river.tiles.length : 0 };
  }
  // 与现版同名同形状的读数，判据才能两边并排：车与人的数、场半径、当前画不画行人，以及行人那一档的阈值。
  // 这一份形状定义在 `src/near-field.js`，两边读的是同一个 `readout()`。
  function nearTraffic() {
    return nearField?.readout() ?? null;
  }
  let lastHash = 0, samples = { fps: 0, ms: 0, frames: 0 }, facadeBand = -1;
  let lastWidth = 0, lastHeight = 0;
  // 泛光那条链是**按需建**的：两块 HalfFloat 缓冲在 2 倍屏上是 2,880 × 1,920 各一份（约 41 MB / 块），
  // 加进 UnrealBloomPass 自己的五级 mip 就是百来兆——白昼不画它，就不该在白昼那份画面上占这笔。
  // 强度这一格存在外面：开页直接是夜景时链还没建，先记着，建的那一刻再补上去。
  let bloom = null;
  // 开页直接是夜景（`?atmosphere=night`）时没人调 `setMode`，所以初值按这一场的氛围算，不能留 0。
  let bloomShare = atmosphereId === 'night' ? 1 : 0;
  const nightNow = () => atmosphereId === 'night';
  const setBloomShare = (next) => {
    bloomShare = Math.min(1, Math.max(0, Number(next) || 0));
    bloom?.setShare(bloomShare);
    return bloomShare;
  };
  const ensureBloom = () => {
    if (!bloom) {
      bloom = createBloom({ renderer, scene, camera: rig.camera, width: lastWidth, height: lastHeight });
      bloom.setShare(bloomShare);
    }
    return bloom;
  };
  const resize = () => {
    const width = container.clientWidth || globalThis.innerWidth;
    const height = container.clientHeight || globalThis.innerHeight;
    renderer.setSize(width, height, false);
    rig.resize(width, height);
    lastWidth = width;
    lastHeight = height;
    bloom?.setSize(width, height);
  };
  resize();
  globalThis.addEventListener('resize', resize);
  // 合成器把每一道 pass 都走一次 `renderer.render`，而 `info.autoReset` 默认在每次 render 开头清零——
  // 不关掉的话夜景那一帧 `counts().drawCalls` 会报成最后一道贴图的 1 发，那几条数发数的判据当场失去意义。
  renderer.info.autoReset = false;

  const frame = (time) => {
    const view = rig.update(time);
    fog.near = view.distance * FOG_RATIOS.near;
    fog.far = view.distance * FOG_RATIOS.far;
    // 窗格覆盖层的透明度跟着缩放走（现版那条 0.42@15 / 0.6@16.5 / 0.72@18 的斜坡）。它是一笔 uniform 写入，
    // 所以按 1/20 级归档，缩放停住之后就不必再写。
    const band = Math.round(view.zoom * 20);
    if (band !== facadeBand) {
      facadeBand = band;
      buildings.setFacadeOpacity(view.zoom);
    }
    // 车与灯珠的倍率、以及"车头朝哪一边亮"都是镜头的函数，现版那侧每帧交一次，这里也一样：
    // 两个 setter 自己带阈值，镜头停住时它们直接返回。
    if (nearField) {
      nearField.setZoom(view.zoom);
      nearField.faceCamera(view.bearing);
    }
    // 接地带的门控读的也是这一帧的镜头：与现版那侧同一条理由（载入那帧与跑过又停下那帧必须是一张画）。
    bases?.setZoom(view.zoom);
    // 波光的透明度读 zoom，格子读转角、设备倍率与画布中心——斜坡那一格内部按 1/20 级归档，镜头停住就不必再写。
    river.setView({ zoom: view.zoom, bearing: view.bearing, pixelRatio: renderer.getPixelRatio(),
      width: lastWidth, height: lastHeight, centre: view.center });
    if (motion.on) {
      // 后台标签页停 rAF，回到前台那一帧的差值是整个空档；不夹一下车流会瞬移，与现版那条江面同一个理由。
      const delta = motion.previous === undefined ? 0 : Math.min(time - motion.previous, 4 * MOTION_STEP_MS);
      motion.previous = time;
      motion.carry += delta;
      if (motion.carry >= MOTION_STEP_MS) {
        const steps = Math.floor(motion.carry / MOTION_STEP_MS);
        motion.carry -= steps * MOTION_STEP_MS;
        stepMotion(steps * MOTION_STEP_MS, view);
      }
    } else {
      motion.previous = undefined;
    }
    // 泛光只挂在夜景这一档：白昼与日落那份画面走的还是原来那条直连路径，一个像素都不过合成器，
    // 所以两档之间的所有像素判据与首屏成本一字未动。
    renderer.info.reset();
    if (nightNow()) ensureBloom().render();
    else renderer.render(scene, rig.camera);
    labels.place();
    const sample = stats.tick(time);
    if (sample) {
      samples = sample;
      const features = ground.report.features;
      const greens = (features.park ?? 0) + (features.grass ?? 0) + (features.wood ?? 0);
      panel.textContent = `V8 Phase 2 · three ${samples.fps} fps · 最长帧 ${samples.ms} ms · ${buildings.count} 栋 / 窗纹 ${buildings.grids} 层 / `
        + `灯火 ${buildings.lamps + buildings.glows} 层 / 波光 ${river.mesh ? 1 : 0} 层 / 江上 ${nearField?.counts.boats ?? 0} 船 / 地面 ${ground.group.children.length} 块：`
        + `水 ${features.water ?? 0}·绿 ${greens}·地块 ${features.block ?? 0}·铺装 ${features.pavement ?? 0}·路 ${features.road ?? 0}`;
    }
    // The hash is the shared language between the two engines, but writing it on every frame would push a new entry
    // into the history stack at 60 Hz; half a second is how often a person can read it.
    if (writeHash && time - lastHash > 500) {
      lastHash = time;
      globalThis.history?.replaceState(null, '', formatView({
        zoom: view.zoom, center: view.center, bearing: view.bearing, pitch: view.pitch,
      }));
    }
    onFrame?.(view, sample);
  };
  renderer.setAnimationLoop(frame);

  // V4-8 接力的下半场（引擎这一侧）：开屏开在中继那一格的，第一帧之后就降回默认机位；地址里带深链时不降，
  // 因为那一条链接说的就是用户要看的那一格。减弱动效下直接落位，不飞。
  if (arrive && !stored) {
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    rig.flyTo(heroView, still ? 0 : FLY_IN_MS);
  }

  return {
    engine: 'three',
    canvas,
    renderer,
    scene,
    rig,
    camera: rig.camera,
    view: rig.view,
    setView: rig.setView,
    // 缓动版：Phase 2 之前 `setView` 是唯一改镜头的出口，所以"回到广州塔""看全范围"都是瞬移。接力（V4-8）
    // 需要的是现版那一段飞行动作，于是补一个 `flyTo`；`liftOff` 是它在接力里的名字——引擎这侧没有导览、
    // 环绕、卡片要让开，升起就是升起。
    flyTo: rig.flyTo,
    liftOff: (view, duration) => rig.flyTo(view, duration),
    /**
     * Where a ground point lands on the canvas, in CSS pixels. The map used to hand this over as `map.project`; the
     * browser claims about "the pixel over the channel is water" need it, and so will the raycast picking in Phase 4.
     */
    screen,
    stats: () => samples,
    landmarkLabels: () => labels.report(),
    counts: () => ({ buildings: buildings.count, ground: ground.group.children.length, facades: buildings.grids,
      lamps: buildings.lamps, glows: buildings.glows, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      // 泛光那一格并进读数：判据要能分清"这一帧多了几发"是灯火层多的还是后处理链多的。
      bloom: bloom ? { ...bloom.report(), built: true } : { share: bloomShare, built: false },
      // 江面波光那一层单独报一发数：它是新增的写入者，发数账与像素判据都要能把它摘出去。
      river: river.report() }),
    /**
     * 泛光的阀门：给一个数是档位（0~1，夜景给满），给一个对象是逐格改那三个数（`{strength, radius, threshold}`）。
     * 取证脚本扫参数靠后一种；判据读 `counts().bloom` 那一格看它落在哪一档。
     */
    setBloom: (next) => (next && typeof next === 'object'
      ? (bloom ? bloom.setTune(next) : bloomShare) : setBloomShare(next)),
    bloomState: () => (bloom ? bloom.report() : { share: bloomShare, strength: 0, built: false }),
    setMode: (id) => {
      atmosphereId = ATMOSPHERES[id] ? id : 'day';
      applyPreset(ATMOSPHERES[atmosphereId]);
      // 车灯与船灯跟着夜景走，与现版那条 `setTrafficLamps(lit)` 同一个开关；白天车还在路上，只是不亮灯。
      nearField?.setLit(atmosphereId === 'night');
      // 泛光跟着夜景同一把开关：白昼与日落没有该晕的发光体，那一档连那条链都不走。
      setBloomShare(atmosphereId === 'night' ? 1 : 0);
      // 江面那三档贴图与现版同一份，换氛围就是换采样那一张图并把格子放回出厂那一行。
      river.setAtmosphere(atmosphereId);
      return atmosphereId;
    },
    /** 动效总开关。关掉 = 现版那侧的"全部停下"：车流与交叉淡都回到出厂那一格。 */
    setMotion: (next) => {
      motion.on = Boolean(next) && motionAvailable();
      if (!motion.on) {
        motion.carry = 0;
        motion.previous = undefined;
        settleMotion(rig.view().zoom);
      }
      return motionStatus();
    },
    motionStatus: () => motionStatus(),
    /**
     * 交叉淡的两把权重。动效循环写的就是这一对数，验收在停帧之后把它钉到两端——现版那侧对应的是
     * `map.setGlobalStateProperty('lamp-0'/'lamp-1')`，同一件事的两种写法，因为这边没有 global state。
     * 1/1 是出厂那一帧，所以"钉上去再放回 1/1"必须回到同一张画面，这条判据两边共用。
     */
    setLampWeights: (w0, w1) => {
      setLampWeights(lampMaterials, w0, w1);
      return lampWeights();
    },
    nearTraffic: () => nearTraffic(),
    dispose: () => {
      renderer.setAnimationLoop(null);
      globalThis.removeEventListener('resize', resize);
      rig.dispose();
      ground.dispose();
      buildings.dispose();
      facades.dispose();
      // 灯火与光晕那两份材质是这里造、发给四个桶共用的，`buildings.dispose()` 只还它自己那批墙与窗格，所以还由这里喊（#177）。
      for (const material of lampMaterials) material.dispose();
      lampTexture.dispose();
      glowTexture.dispose();
      labels.dispose();
      // 近场那几组与楼根接地带是调用方喂进来的客人（`boot.js` 建），但它们自己造的几何与材质得有人喊还——
      // 以前这里只收了自己那五块，换一次场景就把车、人、船、湿线与灯的三层留在显存里（#177）。
      nearField?.dispose();
      bases?.dispose?.();
      river.dispose();
      bloom?.dispose();
      panel.remove();
      renderer.dispose();
    },
  };
}

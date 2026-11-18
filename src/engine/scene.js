// V8 Phase 0：引擎的装配。渲染循环、光照、FPS 面板、hash 同步都在这一个人手里，别的模块只管自己那块几何。
//
// 它不 fetch 数据、不碰 DOM 控件：数据由调用方喂进来（`data`），容器由调用方给（`container`），
// 这样这份文件能在 Node 里被单元测试直接构造 —— 现版的 `map.js` 只能在浏览器里测，是这轮最想避开的路。
import * as THREE from 'three';
import { ATMOSPHERES } from '../atmosphere.js';
import { DEFAULT_CENTER, SCENE, VIEW_LIMITS } from '../config.js';
import { formatView, parseView } from '../link.js';
import { isLandscapeViewport, viewportPadding } from '../padding.js';
import { LANDMARKS } from '../landmarks.js';
import { TOWER_OSM_ID } from '../config.js';
import { createTour, TOUR_STOPS } from '../tour.js';
import { buildingId, geometryPoint } from '../map/helpers.js';
import { createRig } from './camera.js';
import { createGround } from './ground.js';
import { createPlazaGround } from './plaza.js';
import { createBuildingBuckets, drawnHeight, pickTallest, ringOf } from './buildings.js';
import { createHitBoxes, createPicking } from './picking.js';
import { createEngineCards } from './cards.js';
import {
  createFacadeSet, createLampMaterial, facadeOpacityFor, glowAtlasTexture, glowOpacityFor, lampAtlasTexture, lampCellOf,
  lampOpacityFor, setLampWeights,
} from './facades.js';
import { createProjection } from './projection.js';
import { createRiverSheen } from './river.js';
import { createLandmarks, underShell } from './landmarks.js';
import { LAMP_PERIODS_MS, lampWeight } from '../facade.js';
import { TREE_MIN_ZOOM } from '../vegetation.js';
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
 * @param {{container: HTMLElement, canvas?: HTMLCanvasElement, mode?: string, data: {buildings?: object[], streets?: object[], water?: object[], greens?: object[], blocks?: object[]},
 *   nearField?: object, // 近场三组（车、人、船，`src/near-field.js` 造好交进来）
 *   bases?: object, // 楼根接地带（`src/shadow-pads.js`，与现版同一份）
 *   greenery?: object, // 树（`src/vegetation.js`，与现版同一份装配，#218）
 *   testBuildings?: number, // 0 = 画全量；给一个 N 就只立最高的 N 栋 limits?: object, onFrame?: Function, writeHash?: boolean}} options
 */
export function createEngineScene(options) {
  const {
    container, canvas = container.querySelector('canvas') ?? document.createElement('canvas'),
    mode = 'day', data = {}, testBuildings = 0, limits = VIEW_LIMITS, onFrame, writeHash = true,
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

  const surfaces = [...(data.water ?? []), ...(data.greens ?? []), ...(data.blocks ?? [])];
  const ground = createGround({ project, radius: SCENE.radius, colors: groundColors(ATMOSPHERES[atmosphereId] ?? ATMOSPHERES.day),
    streets: data.streets ?? [], surfaces });
  // 江面那层波光：与现版同一个形状——水面是一层平色，波光压在它上面、只带 alpha。像素出自 `src/water.js` 那三张图，
  // 挑面的名单也出自同一张 `toneOf` 表，所以"画了水色的那些面"与"起波光的这些面"必然是同一批。
  const river = createRiverSheen({ project, surfaces, atmosphere: atmosphereId });
  // 花城广场那四类实测面与地面那张按广场米数铺开的乘性贴图（#192）。现版那侧它是四张 `fill` 层加一块贴在塔那一层
  // 地面通道上的网格，这一侧的"底图"就是上面那几块平色板，所以补的是同一件事的对应物：三块板 + 一张乘性网格。
  // 快照里没有那块公园面（`carvePlaza` 报 `missing`）就整层不存在，不造空壳。
  const plaza = createPlazaGround({ greens: data.greens ?? [], water: data.water ?? [], blocks: data.blocks ?? [],
    streets: data.streets ?? [], project, origin: SCENE.center ?? DEFAULT_CENTER, preset: ATMOSPHERES[atmosphereId] ?? ATMOSPHERES.day });
  // 默认画全量：3,990 面按类别并成几桶。`testBuildings` 留着一个调试阀门——要只看最高的 N 栋时传个数进来，
  // 现版那套"取真实最高的 10 栋、按高度再按 id 排序"的确定性还在 `pickTallest` 里。
  // 有壳体站在那几块地上之后，盒子必须先让位：现版那侧是样式里的 `formFilter`（`['!', ['in', osmId, …]]`），
  // 这里同一件事写成一次过滤——**壳体与它底下的盒子不能同时画**，一栋塔两套皮在夜景就是两圈发光轮廓。
  const shellFeatures = SCENE.towerId && (data.bridge ?? []).length
    ? [...(data.buildings ?? []), ...data.bridge] : [];
  const bucketFeatures = (data.buildings ?? []).filter((feature) =>
    !shellFeatures.length || !underShell(feature));
  const features = testBuildings ? pickTallest(bucketFeatures, testBuildings) : bucketFeatures;
  // 地标那一整批资产（广州塔网格、东西塔与省博的壳体、海心桥、塔顶光柱、三塔落水带）走的是现版同一批纯工厂，
  // 搬进来的只有"谁交镜头"这一格。快照里没有桥面，就没有壳体，这一整块不存在。
  const landmarks = shellFeatures.length
    ? createLandmarks({ features: shellFeatures, river: data.river ?? [], origin: SCENE.center ?? DEFAULT_CENTER, mode: atmosphereId })
    : null;
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
  // 树（#218）：同一份 `createVegetation` 装配由 `boot.js` 交进来，这里只管挂进场景、交镜头门控与还资源。
  const greenery = options.greenery ?? null;
  if (greenery) scene.add(greenery.group);
  scene.add(ground.group, river.group, buildings.group);
  if (plaza) scene.add(plaza.group);
  if (landmarks) scene.add(landmarks.group);

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
    // 塔身的色相与三顶皇冠的呼吸骑同一拍（现版那侧也是这一拍：`map.js` 里 `motion.hue`/`motion.breath` 都在
    // `motion.river >= MOTION_STEP_MS` 那个分支里推进）。差别只有一处：现版的 `breath` 累的是整帧差值、
    // `hue` 累的是整步数，这里两样都按整步走——皇冠的周期是 7 s 与 8 s，一步 120 ms 是 1.7 % 的相位，
    // 两边不对齐这件事本来就不成立（夜景画面从来不在跨引擎闸门里）。
    landmarks?.advance(elapsed);
  }
  // 停下来不是暂停：车流回到出厂那一格、两组的权重回到 1/1，也就是"这个功能不存在的那一页"画的同一帧。
  function settleMotion(zoom) {
    motion.life = 0;
    motion.lamp = 0;
    nearField?.advance(0, zoom);
    river.reset();
    // 塔身转回出厂那一格色相、皇冠回到第 0 毫秒：现版那句"停下要把出厂帧还回来"在地标这一层的同一件事。
    landmarks?.reset();
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
    // 广场那三块板不吃上面那张表：它们刷的是 `plaza.js` 那四层自己的档位（草坪用水边草色、石材用广场色、
    // 步行带用广场步道色），与现版那四张 `fill` 层的 paint 是同一份对应物。
    plaza?.setAtmosphere(preset);
  };

  applyPreset(ATMOSPHERES[atmosphereId] ?? ATMOSPHERES.day);

  const screenPoint = new THREE.Vector3();
  const storedLink = writeHash ? parseView(globalThis.location?.hash) : { camera: null, selection: null };
  // 开屏那一格：地址里的深链最优先，其次是接力留下的中继那一格（V4-8 的下半场），最后才是本场景的默认机位。
  const heroView = { center: SCENE.center, zoom: SCENE.camera.zoom, bearing: SCENE.camera.bearing, pitch: SCENE.camera.pitch };
  const rig = createRig({
    canvas,
    project,
    limits,
    // 取景留白与现版同一张表（`src/padding.js`）。这一侧的街区清单还是灰的（`main.js` 那句边界说明），
    // 所以 `panelOpen` 恒为 false；同一串 hash 因此在两边落在同一格画面上（#191，改之前差 140×70 px）。
    padding: () => viewportPadding(false),
    initial: storedLink.camera ?? heroView,
  });

  const screen = ({ lng, lat, altitude = 0 }) => {
    const ground = project({ lng, lat });
    screenPoint.set(ground.x, altitude, ground.z).project(rig.camera);
    return { x: (screenPoint.x * 0.5 + 0.5) * (canvas.clientWidth || 1), y: (-screenPoint.y * 0.5 + 0.5) * (canvas.clientHeight || 1), onScreen: screenPoint.z < 1 };
  };
  const labels = createLabels({ container, screen });

  // ── #218：拾取、卡片、检索定位与导览。语义逐条对齐现版 `map.js`，差别只写在对应位置。 ──
  const still = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const towerHeight = 450;
  // 卡片与深链读的那份快照：楼块＋桥＋塔。现版 `selectFeature` 只查楼块快照，壳体命中时回退到命中 feature 本身；
  // 这一侧壳体与塔的命中盒本来就是从这批 feature 立的，所以查同一批就是"读同一条记录"。
  const snapshot = [...(data.buildings ?? []), ...(data.bridge ?? []), ...(data.tower ?? [])];
  let selection = null;
  let focusToken = 0;
  const cards = createEngineCards({ container, scene, screen, project, onClosed: () => { selection = null; } });
  // 导览适配器：`createTour` 只吃 stop/once/off/flyTo 四件事（`src/tour.js`），这里把 rig 包成那副形状。
  // 两个必须记住的陷阱：① rig 的飞行被输入打断时 promise 也 resolve（取消与到达同形），所以"到站"只认
  // 登记在案的监听器；② visit() 先 map.stop() 再登记新监听器，旧飞行的 resolve 落在微任务里——发射时必须
  // 只喊**还在册**的那几位，否则旧飞行会把新登记的到站回调提前喊掉（导览会在半路开始计时）。
  const moveendWaiters = new Set();
  const tourMap = {
    stop: () => rig.cancelFlight(),
    once: (event, fn) => { if (event === 'moveend') moveendWaiters.add(fn); },
    off: (event, fn) => { moveendWaiters.delete(fn); },
    flyTo: (camera) => {
      const waiters = [...moveendWaiters];
      rig.flyTo(camera, camera.duration ?? 0).then(() => {
        for (const fn of waiters) if (moveendWaiters.delete(fn)) fn();
      });
    },
  };
  let tourMarker, tourStop;
  const placeTourMarker = () => {
    if (!tourMarker || !tourStop) return;
    const point = screen({ lng: tourStop.center[0], lat: tourStop.center[1] });
    tourMarker.style.visibility = point.onScreen ? '' : 'hidden';
    // 与现版 Marker `anchor: 'top'`、offset [0, 12] 同一个挂法。
    tourMarker.style.transform = `translate(-50%, 0) translate(${point.x}px, ${point.y + 12}px)`;
  };
  const tour = createTour(tourMap, {
    // 相机公式逐字取自现版（`map.js` 的 tour.camera）：可用高度夹在顶栏与播放条之间，430 px 以上不补级。
    // 差别一处：现版逐站交 padding，这一侧的留白折在投影里（#191）且恒为面板关闭档，所以 padding 不交。
    camera(stop) {
      const player = document.getElementById('tour-player').getBoundingClientRect();
      const top = Math.max(...[...document.querySelector('.topbar').children].map((node) => node.getBoundingClientRect().bottom)) + 24;
      const bottom = isLandscapeViewport() ? globalThis.innerHeight - 40 : player.top - 20;
      const height = Math.max(100, bottom - top);
      return { center: { lng: stop.center[0], lat: stop.center[1] }, bearing: stop.bearing, pitch: stop.pitch,
        zoom: stop.zoom + Math.min(0, Math.log2(height / 430)), duration: still() ? 0 : 2200 };
    },
    onChange(state) {
      options.onTourChange?.(state);
      if (state.index < 0) { tourMarker?.remove(); tourMarker = undefined; tourStop = undefined; return; }
      tourStop = TOUR_STOPS[state.index];
      if (!tourMarker) {
        tourMarker = document.createElement('div');
        tourMarker.className = 'tour-marker engine-tour-marker';
        tourMarker.setAttribute('aria-hidden', 'true');
        container.append(tourMarker);
      }
      tourMarker.textContent = `${String(state.index + 1).padStart(2, '0')} · ${tourStop.name}`;
      placeTourMarker();
    },
  });
  // 与现版 `manualInteraction` 同一件事：用户一碰镜头，导览让位、检索定位作废。
  const manualInteraction = () => { focusToken++; tour.exit(); options.onInteraction?.(); };
  canvas.addEventListener('pointerdown', manualInteraction);
  canvas.addEventListener('wheel', manualInteraction, { passive: true });
  const interrupt = () => { manualInteraction(); cards.close(); };
  // 开卡统一入口（现版 `selectFeature` 的对应物）：点击、检索定位与深链都走这里，卡片、高亮与地址栏因此同源。
  function selectFeature(feature) {
    const record = snapshot.find((item) => String(item.properties.osmId) === String(feature.properties.osmId)) ?? feature;
    const { properties, geometry } = record;
    const ring = ringOf({ geometry });
    const points = ring.map(([lng, lat]) => screen({ lng, lat }));
    const near = points.reduce((a, b) => (b.y > a.y ? b : a));
    options.onBuildingClick?.({
      properties,
      outline: { type: 'Feature', properties: { height: properties.tower ? towerHeight : properties.displayHeight ?? properties.height, base: properties.base }, geometry },
      lngLat: ring[points.indexOf(near)],
    });
    const [lng, lat] = geometryPoint(geometry);
    selection = { osmId: buildingId(properties.osmId), lat, lng };
  }
  const hitFeatures = [...(landmarks?.forms.forms ?? []).filter((form) => form.hit).map((form) => form.feature), ...(data.tower ?? [])];
  const picking = createPicking({
    canvas, camera: rig.camera,
    walls: buildings.group.children.filter((mesh) => mesh.userData.features),
    boxes: createHitBoxes({ features: hitFeatures, project, towerHeight }),
    onPick: selectFeature,
  });
  // 检索定位（现版 `focusBuilding`）：飞到楼块自己的点上、不低于 15.4 级，停稳后开卡。现版要等瓦片加载所以
  // 重试 24 次；这一侧快照就在手里，飞行 promise 落定即选。取消与到达同形（rig 的 stopFlight 也 resolve），
  // 所以用令牌区分：pointerdown/wheel 把令牌推进，落定的那一段就不再开卡。
  function focusBuilding({ osmId, lng, lat }) {
    const token = ++focusToken;
    tour.exit();
    options.onInteraction?.();
    const view = rig.view();
    rig.flyTo({ ...view, center: { lng, lat }, zoom: Math.max(view.zoom, 15.4) }, still() ? 0 : 800).then(() => {
      if (token !== focusToken) return;
      const feature = snapshot.find((item) => String(item.properties.osmId) === String(osmId));
      if (feature) selectFeature(feature);
    });
  }
  // 深链里那一栋：现版等瓦片就绪再拾取，这一侧快照即取即开。setTimeout 是刻意的——main.js 要在 boot 的
  // promise 落定后才把 neighborhood 接上，开卡回调（showBuilding）在那之前喊出去会扑空。
  if (storedLink.selection) {
    const { osmId } = storedLink.selection;
    setTimeout(() => {
      const feature = snapshot.find((item) => String(item.properties.osmId) === String(osmId));
      if (feature) selectFeature(feature);
    }, 0);
  }

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
      bloom = createBloom({ renderer, scene, camera: rig.camera, width: lastWidth, height: lastHeight,
        // 地标那一层不吃泛光：塔冠关着泛光就有 248/255，比任何还能让灯芯起晕的门槛都亮，留在链里就是
        // 塔把整条链的能量摊到全幅（现版那侧的塔本来就没有这条链）。理由与数字在 `bloom.js` 顶上。
        exclude: landmarks ? [landmarks.group] : [] });
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
    // 卡片尺寸随断点变（窄屏那套 padding/max-height），换布局要重量一次，否则席位按旧盒子算。
    cards.measure();
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
    // 树与接地带同一条门控（14.5 级）：现版那侧在 `tower.js` 的 render 里每帧交同一个数。
    greenery?.setZoom(view.zoom);
    // 广场那张乘性贴图读的也是这一帧：它与接地带同一条理由——载入那帧与跑过又停下那帧必须给同一个答案。
    plaza?.setZoom(view.zoom);
    // 波光的透明度读 zoom，格子读转角、设备倍率与画布中心——斜坡那一格内部按 1/20 级归档，镜头停住就不必再写。
    river.setView({ zoom: view.zoom, bearing: view.bearing, pixelRatio: renderer.getPixelRatio(),
      width: lastWidth, height: lastHeight, centre: view.center });
    // 壳体的墙色是那条距离斜坡的产物，而斜坡跟着镜头，所以它必须在**它被画的那一帧**读 zoom——
    // 与现版那侧 `tower.js` 的 `render` 里那句 `forms.recede(mapRef.getZoom())` 同一格。
    landmarks?.update(view.zoom);
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
    cards.place();
    placeTourMarker();
    const sample = stats.tick(time);
    if (sample) {
      samples = sample;
      const features = ground.report.features;
      const greens = (features.park ?? 0) + (features.grass ?? 0) + (features.wood ?? 0);
      panel.textContent = `V8 Phase 2 · three ${samples.fps} fps · 最长帧 ${samples.ms} ms · ${buildings.count} 栋 / 窗纹 ${buildings.grids} 层 / `
        + `灯火 ${buildings.lamps + buildings.glows} 层 / 波光 ${river.mesh ? 1 : 0} 层 / 壳体 ${landmarks?.report().shells ?? 0} 片 / 广场 ${plaza?.report().plates ?? 0} 层 / 江上 ${nearField?.counts.boats ?? 0} 船 / 树 ${greenery?.report.trees ?? 0} 株 / 地面 ${ground.group.children.length} 块：`
        + `水 ${features.water ?? 0}·绿 ${greens}·地块 ${features.block ?? 0}·铺装 ${features.pavement ?? 0}·路 ${features.road ?? 0}`;
    }
    // The hash is the shared language between the two engines, but writing it on every frame would push a new entry
    // into the history stack at 60 Hz; half a second is how often a person can read it.
    if (writeHash && time - lastHash > 500) {
      lastHash = time;
      globalThis.history?.replaceState(null, '', formatView({
        zoom: view.zoom, center: view.center, bearing: view.bearing, pitch: view.pitch,
      }, selection));
    }
    onFrame?.(view, sample);
  };
  renderer.setAnimationLoop(frame);

  return {
    engine: 'three',
    canvas,
    renderer,
    scene,
    rig,
    camera: rig.camera,
    view: rig.view,
    setView: rig.setView,
    // 缓动版：Phase 2 之前 `setView` 是唯一改镜头的出口，所以"回到广州塔""看全范围"都是瞬移。
    // 界面那一侧的镜头按钮走 `flyTo`，卡片要让开、导览要停这些是现版那侧的事，引擎这一侧没有。
    flyTo: rig.flyTo,
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
      river: river.report(),
      // 地标这一层同理：壳体名单、几片壳、三条落水带在不在、夜景权重走到哪——"关掉这一层少了什么"要能报得出来。
      landmarks: landmarks ? landmarks.report() : null,
      // 广场这一层报的是四类面各切出几块、贴图画了多少格缝/收边/水线，以及那块乘性网格此刻在不在。
      plaza: plaza ? plaza.report() : null }),
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
      // 地标这一层跟着换：塔身那五份自发光基线、壳体的墙色斜坡、落水带与光柱的夜景权重都在这一句后面。
      landmarks?.setAtmosphere(atmosphereId);
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
    /** 与现版 `nearTrees()` 同名同形状（`map.js` 那句展开 report 再加 visible/minZoom/zoom）。 */
    nearTrees: () => (greenery
      ? { ...greenery.report, visible: greenery.group.visible, minZoom: TREE_MIN_ZOOM, zoom: rig.view().zoom } : null),
    // ── #218 的交互面：与现版返回对象同名，main.js 不必学第二套词汇。 ──
    showBuilding(building, content) {
      manualInteraction();
      cards.open(building, content);
    },
    focusBuilding,
    hasCard: cards.hasCard,
    closeCard: cards.close,
    cardState: cards.cardState,
    buildingSelection: () => selection,
    tour,
    startTour() { focusToken++; cards.close(); tour.start(!still()); },
    interrupt,
    // 透视镜在这一侧还没接（界面灰着），但卡片的事实行要读 lens.mode——给一个恒定的出厂档，与现版开屏那一格同值。
    get lens() { return { mode: 'use', category: 'all', source: 'all' }; },
    dispose: () => {
      renderer.setAnimationLoop(null);
      globalThis.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', manualInteraction);
      canvas.removeEventListener('wheel', manualInteraction);
      tour.exit();
      tourMarker?.remove();
      picking.dispose();
      cards.dispose();
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
      // 树与它们那片接地影同属这一位客人：七具网格、四份材质与影那张贴图都在 `createVegetation.dispose` 手里。
      greenery?.dispose();
      river.dispose();
      // 广场那三块板、那张乘性网格与它背后那张贴图都是这一层造的（`engine/plaza.js`），所以也这一层还——
      // 与 `river` 那一层同一个口径：谁造的谁还。
      plaza?.dispose();
      // 地标这一层的几何、材质与贴图都在它自己手里（立面图集、灯图、塔网格那道高度斜坡的贴图），还由这一层喊。
      landmarks?.dispose();
      bloom?.dispose();
      panel.remove();
      renderer.dispose();
    },
  };
}

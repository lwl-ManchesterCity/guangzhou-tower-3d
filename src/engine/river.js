// V8 Phase 3 第一格：把江面那层波光接进新引擎。
//
// 现版那侧的江面是**两层**：底下一层 `fill` 出水色（`src/atmosphere.js` 的 `water`），上面一层 `fill-pattern` 只带 alpha
// 出波光（`src/water.js` 的 `waterTexture`）。之所以分两层，是因为 MapLibre 的 `fill-pattern` 会让着色器无视
// `fill-color`——波光层里放不进第二种颜色，平色也只能由下面那层给。这里沿用同一个形状：一块与水面包**同几何**的覆盖网格，
// 材质不受光、不写深度，像素仍然出自 `waterTexture`，所以两引擎读的是同一份波纹，改一处两边一起变。
//
// 与立面窗纹那一层不一样的是**贴图挂在哪个坐标系里**。现版量过两件事，而这两件事是分开成立的：
// ① 一张图在屏幕上占多宽不随缩放走——32 像素的那张在 16 级占 32.1 个屏幕像素、64 像素的那张在 16 级占 63.4、在 18 级占 64.0
//    （`src/water.js` 顶部），也就是一个图像像素对一个 CSS 像素；
// ② 但这张格子的**相位跟着地面走**——把镜头平移 119 个屏幕像素，现版与新版各自的"开减关"差值图都要挪同样的 119 像素才对得上
//    （相关 0.94 对 0.93），原地不动地比只有 0.81 对 0.64（`scripts/probe-river-pan.mjs`，2026-10-14 实测）。
// 所以这里把两件事分开做：格子的大小仍然按屏幕算（片元里拿 `gl_FragCoord`，一个纹素对一个 CSS 像素，绝不随缩放胀大），
// 而格子的**起点**按镜头中心脚下那片地算（`riverOffset`）——平移时波纹跟着江面走，不是从江面底下溜过去。
// 这一格最早只做对了①：当时同屏位置比的两张差值图有 94% 的像素本来就一样，也就是整张格子被钉死在视口上。
import * as THREE from 'three';
import { GROUND_LAYERS, mergePositions, plateGeometry, polygonsOf, toneOf } from './ground.js';
import { WATER_THEMES, riverOpacityFor, waterTexture } from '../water.js';
import { metresPerPixel } from './camera.js';

// 波光站在水面那一档之上、路面带之下：现版那侧它是紧贴着底图水面上插的那一层，桥面、路带与体块都压在它上面。
export const RIVER_SHEEN_LIFT_METRES = 0.02;

/** 三档氛围各一张贴图，像素与现版逐字同源（`waterTexture` 是纯函数，Node 里也造得出来）。 */
export const riverTiles = () => Object.fromEntries(Object.entries(WATER_THEMES).map(([id, options]) => {
  const image = waterTexture(options);
  const texture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat);
  // 这张图带的是波光的颜色与 alpha（ crest 纯白 / trough 是岸影那档），按 sRGB 解，与灯窗图集同一口径。
  texture.colorSpace = THREE.SRGBColorSpace;
  // 屏幕空间平铺靠片元里的 `fract`，所以包装方式其实用不上；留着 RepeatWrapping 是为了边界那一格不必特判。
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // 不开 mipmap：这张图是"屏幕节奏"，缩放出一个非整数倍率就会把 crest 与 trough 平均成一团灰。
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.userData = { size: image.width, rows: options.rows, dashes: image.dashes };
  texture.needsUpdate = true;
  return [id, texture];
}));

// 片元里那两句注释用英文：GLSL 的源码字符集按规范只有 ASCII，中文注释在个别驱动上会被词法阶段顶回来。
// 屏幕位置 → CSS 像素 → 转回地面系（镜头转角时波纹跟着地面走）；滚动是整数个 CSS 像素，与现版那句 `scrollWater(tile, phase)`
// 同一件事——现版每拍重传一张行循环过的像素，这里只挪一个数，因为那份平移本来就是精确的行循环、不重采样。
export const RIVER_FRAGMENT = `#include <color_fragment>
	vec2 riverPoint = ( gl_FragCoord.xy - riverCenter ) / riverScale;
	float riverCos = cos( riverRotate );
	float riverSin = sin( riverRotate );
	vec2 riverGround = vec2( riverPoint.x * riverCos - riverPoint.y * riverSin, riverPoint.x * riverSin + riverPoint.y * riverCos );
	vec2 riverUv = fract( ( riverGround + riverOffset + vec2( 0.0, riverScroll ) ) / riverTile );
	diffuseColor *= texture2D( riverMap, riverUv );`;

/**
 * @param {{project: Function, surfaces: object[], tiles?: object, atmosphere?: string,
 *   lift?: number}} input `surfaces` 就是地面那一层拿到的那批面，按 `toneOf` 挑出水系，
 *   所以"画了水色的那些面"与"起波光的这些面"是同一份名单，不会出现一边有河、一边有晕。
 */
export function createRiverSheen({ project, surfaces = [], tiles = riverTiles(), atmosphere = 'day',
  lift = RIVER_SHEEN_LIFT_METRES } = {}) {
  const group = new THREE.Group();
  group.name = 'river-sheen';
  const waters = surfaces.filter((feature) => toneOf(feature) === 'water');
  const parts = [];
  const failed = [];
  for (const feature of waters) {
    if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') {
      failed.push({ osmId: feature?.properties?.osmId, error: `不是面：${feature.geometry?.type}` });
      continue;
    }
    for (const rings of polygonsOf(feature.geometry)) {
      try {
        const plate = plateGeometry(rings, project, GROUND_LAYERS.water + lift);
        if (plate.getAttribute('position').count) parts.push(plate);
        else plate.dispose();
      } catch (error) {
        failed.push({ osmId: feature.properties.osmId, error: error.message });
      }
    }
  }
  if (!parts.length) {
    // 交得出水面的那一格之外，这一层仍然要交出同一个形状：读数是个函数、口令能喊、贴图不留在显存里。
    for (const texture of Object.values(tiles)) texture.dispose();
    const idle = { faces: 0, plates: 0, failed, atmosphere, scroll: 0, tile: 0, rotate: 0, scale: 0,
      opacity: 0, vertices: 0, built: false };
    return { group, mesh: null, tiles: Object.keys(tiles), report: () => idle,
      setAtmosphere: () => null, setView: () => null, advance: () => null, reset: () => null, dispose: () => group.clear() };
  }

  const textureFor = (id) => tiles[id] ?? tiles.day;
  // 状态先于材质存在：`onBeforeCompile` 可能在第一次渲染时才跑（现版那侧的贴图上传就是这一刻），
  // 而在那之前 `setView`/`advance`/`setAtmosphere` 都可能已经写过几轮。编译那一刻按这份状态种 uniform，
  // 否则谁先跑谁就丢——实测：开页时还没编译，转角与画布中心的两次写入直接不见了，画出来的是"格子钉在画布左下角、不随镜头转"。
  const state = { atmosphere, scroll: 0, rotate: 0, scale: 1, center: [0, 0], offset: [0, 0],
    opacity: riverOpacityFor(15.5), band: -1, faces: waters.length, plates: parts.length };
  const material = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: state.opacity,
    // 双面是必须的：41 面水系里有环是反的（`plateGeometry` 那句镜像转向就是为它写的），只留正面那些面就是不出画。
    // 但半透明＋双面在 three 里默认走两遍（背面一遍、正面一遍，为了透明体的排序），一块平铺的网格被同一批像素盖两次的可能没有，
    // 白付一发数。`forceSinglePass` 就是给这种"一片平的覆盖层"留的口子：仍然关着剔除，所以反环照样画。
    forceSinglePass: true,
  });
  material.onBeforeCompile = (shader) => {
    const tile = textureFor(state.atmosphere);
    shader.uniforms.riverMap = { value: tile };
    shader.uniforms.riverTile = { value: new THREE.Vector2(tile.userData.size, tile.userData.size) };
    shader.uniforms.riverScroll = { value: state.scroll };
    shader.uniforms.riverRotate = { value: state.rotate };
    // 一个 CSS 像素占几个设备像素（`gl_FragCoord` 给的是设备像素），以及画布中心（同样的设备像素）。
    shader.uniforms.riverScale = { value: state.scale };
    shader.uniforms.riverCenter = { value: new THREE.Vector2(state.center[0], state.center[1]) };
    // 格子的相位起点：镜头中心那一格地面在图案坐标系里的位置，单位与 `riverGround` 一样是 CSS 像素。
    shader.uniforms.riverOffset = { value: new THREE.Vector2(state.offset[0], state.offset[1]) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D riverMap;\nuniform vec2 riverTile;\nuniform float riverScroll;\nuniform float riverRotate;\nuniform float riverScale;\nuniform vec2 riverCenter;\nuniform vec2 riverOffset;')
      .replace('#include <color_fragment>', RIVER_FRAGMENT);
    material.userData.shader = shader;
  };
  // 这块材质的参数与灯窗／光晕那两份一模一样（不受光的半透明层），差别只在片元。three 的程序缓存不看源码，
  // 不写这一句就会把那份片元复用成别人的（同一轮里 `lamp-glow`／`lamp-lamp` 已经踩过一次）。
  material.customProgramCacheKey = () => 'river-sheen';

  const geometry = mergePositions(parts);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'river-sheen-water';
  mesh.renderOrder = 1;
  group.add(mesh);

  const uniform = (name, value) => {
    const shader = material.userData.shader;
    if (!shader) return false;
    if (value instanceof THREE.Vector2) shader.uniforms[name].value.copy(value);
    else shader.uniforms[name].value = value;
    return true;
  };
  return {
    group,
    mesh,
    tiles: Object.keys(tiles),
    report: () => ({ faces: state.faces, plates: state.plates, failed, atmosphere: state.atmosphere,
      scroll: state.scroll, tile: textureFor(state.atmosphere).userData.size, rotate: Math.round(state.rotate * 1000) / 1000,
      scale: state.scale, center: state.center, offset: state.offset,
      opacity: Math.round(state.opacity * 1000) / 1000, vertices: geometry.getAttribute('position').count,
      built: Boolean(material.userData.shader) }),
    /** 换氛围＝换采样那一张图，并把格子放回出厂那一行——现版 `swapArt` 里"三张都重写成 `scrollWater(tile, 0)`"同一件事。 */
    setAtmosphere: (id) => {
      if (!tiles[id] || id === state.atmosphere) return state.atmosphere;
      state.atmosphere = id;
      state.scroll = 0;
      uniform('riverMap', tiles[id]);
      uniform('riverScroll', 0);
      return id;
    },
    /** 每帧交镜头：斜坡读 zoom，平铺读转角、倍率、画布中心，以及镜头中心脚下那片地在图案里占第几格。 */
    setView: ({ zoom, bearing = 0, pixelRatio = 1, width = 0, height = 0, centre = null }) => {
      const band = Math.round(zoom * 20);
      if (band !== state.band) {
        state.band = band;
        state.opacity = riverOpacityFor(zoom);
        material.opacity = state.opacity;
      }
      // MapLibre 的 bearing 是"地图顺时针转多少度"，而画面上的格子要跟着地面反向转，所以这里带一个负号。
      const rotate = -(bearing * Math.PI) / 180;
      const scale = Math.max(0.5, pixelRatio);
      const center = [Math.round(width * scale / 2), Math.round(height * scale / 2)];
      // 相位起点：镜头中心那一点的米制地面坐标，换成"这一级缩放下占几个 CSS 像素"，再按整格取余。
      // 取余是必须的——顺着江走上十分钟这个数就涨到几万，`fract` 前那步减法会把浮点精度吃掉。
      const size = textureFor(state.atmosphere).userData.size;
      const wrap = (value) => ((value % size) + size) % size;
      const offset = !centre ? state.offset : (() => {
        const perMetre = 1 / metresPerPixel({ zoom, latitude: centre.lat });
        const ground = project(centre);
        return [wrap(ground.x * perMetre), wrap(-ground.z * perMetre)];
      })();
      if (rotate !== state.rotate || scale !== state.scale || center[0] !== state.center[0] || center[1] !== state.center[1]
        || offset[0] !== state.offset[0] || offset[1] !== state.offset[1]) {
        state.rotate = rotate;
        state.scale = scale;
        state.center = center;
        state.offset = offset;
        uniform('riverRotate', rotate);
        uniform('riverScale', scale);
        uniform('riverCenter', new THREE.Vector2(center[0], center[1]));
        uniform('riverOffset', new THREE.Vector2(offset[0], offset[1]));
      }
      return { opacity: state.opacity, rotate, scale, center, offset };
    },
    /** 一拍走 `steps` 个整像素（与现版 `scrollRiver` 那句 `phase = (phase + steps) % tile.height` 同一个环）。 */
    advance: (steps) => {
      const size = textureFor(state.atmosphere).userData.size;
      state.scroll = (((state.scroll + steps) % size) + size) % size;
      uniform('riverScroll', state.scroll);
      return state.scroll;
    },
    reset: () => {
      state.scroll = 0;
      uniform('riverScroll', 0);
      return state.scroll;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
      for (const texture of Object.values(tiles)) texture.dispose();
      group.clear();
    },
  };
}

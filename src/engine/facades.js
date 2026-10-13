// V8 Phase 2：把 `src/facade.js` 那套程序生成的窗格像素接到 three 的材质上。
//
// 现版的立面是**一个独立的半透明覆盖层**（`fill-extrusion-pattern` 的 pattern 着色器不读 `fill-extrusion-color`，
// 玻璃自己带 rgba，墙从图里透明的地方透出来），所以这里也不把窗纹烘进墙色：墙是一层，窗格是压在它上面的一层，
// 两层共用同一份几何（覆盖层只画侧壁那一段，见 `buildings.js` 的 `mergeSolids`）。
//
// 贴图本身一张都不在这里生成——`facadeTexture`/`facadeOptions`/`FACADE_CATEGORY_SHAPES` 全部用现成的，
// 现版与新引擎因此永远读同一份节奏表，改一处两边一起变。
import * as THREE from 'three';
import {
  FACADE_CATEGORY_SHAPES, FACADE_FALLBACK_SHAPE, FACADE_METRES_PER_PIXEL, FACADE_SHAPES, FACADE_THEMES, FACADE_TILE_SIZE,
  LAMP_GROUPS, LAMP_SET_SEEDS, LIGHT_BANDS, LIGHT_FADES, LIGHT_TEMPERATURES, LIGHT_TILE,
  facadeOptions, facadeTexture, glowTexture, isLampBreather, isLampDark,
  lampBandOf, lampTemperatureOf, lightTexture, windowsOffTile,
} from '../facade.js';

// 一个窗格平铺的米数。现版那侧是量出来的：32 个图像像素在墙上占 29.3 m（对 600 m 那根针探出来的），
// 所以一像素约 0.92 m、一个 8 像素的带约 7.3 m——四档节奏全部落在这个 7.3/14.7 m 的格子上，
// 比它更细的间距在 15.5 级会被 mipmap 平均回墙面（见 `facade.js` 顶部与地标那轮的同一处教训）。
export const FACADE_CELL_METRES = FACADE_TILE_SIZE * FACADE_METRES_PER_PIXEL;

// 覆盖层的透明度斜坡：现版是 `fill-extrusion-opacity` 的分段插值，实测锚点 0.42@15 / 0.6@16.5 / 0.72@18。
// 这条斜坡是"远处别看太密、近处要读得出来"那笔账，所以新引擎照搬同一组锚点而不是自己顺一个数。
export const FACADE_OPACITY_STOPS = [[15, 0.42], [16.5, 0.6], [18, 0.72]];

// 三条斜坡（窗格、亮窗、光晕）共用一个分段线性求值器：低于首档取首值、高于末档取末值。
function rampAt(stops, zoom) {
  if (!(zoom > stops[0][0])) return stops[0][1];
  for (let index = 1; index < stops.length; index++) {
    if (zoom <= stops[index][0]) {
      const [from, fromValue] = stops[index - 1], [to, toValue] = stops[index];
      return fromValue + (toValue - fromValue) * ((zoom - from) / (to - from));
    }
  }
  return stops[stops.length - 1][1];
}

export function facadeOpacityFor(zoom) {
  return rampAt(FACADE_OPACITY_STOPS, zoom);
}

// 类别 → 节奏。查不到落 `plain`：快照里只有四类，但第五类冒出来时不能得到一个不存在的贴图。
export const facadeShapeOf = (category) => FACADE_CATEGORY_SHAPES[category] ?? FACADE_FALLBACK_SHAPE;

/**
 * 光晕层的斜坡：现版 `building-glow` 的 `fill-extrusion-opacity` 原样搬（14 级 0、15 级 0.44、16.5 级 0.56、
 * 18 级 0.66）。它比亮窗低一档是设计而非巧合——晕比窗亮就不再是溢出光，而是第二套糊掉的窗。
 */
export const GLOW_OPACITY_STOPS = [[14, 0], [15, 0.44], [16.5, 0.56], [18, 0.66]];

export function glowOpacityFor(zoom) {
  return rampAt(GLOW_OPACITY_STOPS, zoom);
}

/** 亮窗层的透明度斜坡。锚点是现版那条 `lampOpacity` 原样搬过来的：14 级 0、15 级 0.62、16.5 级 0.72、18 级 0.8。
 * 现版那侧还要再乘一个交叉淡换的权重（`lampWeight(cycle)`，两组楼各自 11 s / 17 s 换一批窗），
 * 新引擎的动效还没回来（车流、行人、江面、呼吸都在 Phase 3~4），所以这里乘的是权重 1 —— 也就是出厂那一帧。 */
export const LAMP_OPACITY_STOPS = [[14, 0], [15, 0.62], [16.5, 0.72], [18, 0.8]];

export function lampOpacityFor(zoom) {
  return rampAt(LAMP_OPACITY_STOPS, zoom);
}

/** 一张窗格贴图（带 alpha 的半透明层，不是乘数）。
 *
 * 与地标壳体那张网格贴图**不是**同一口径：那张是白底乘数，所以 `NoColorSpace` 不当颜色解；这张带的是玻璃自己的
 * rgba（现版 `FACADE_THEMES` 里的 `[16,26,34,168]` 那一档），MapLibre 那边按颜色解出来，这里也得按 sRGB 解，
 * 否则同一串字节在新引擎上会偏暗一档。平铺与过滤沿用：`RepeatWrapping` 让米制 uv 直接平铺，
 * `LinearMipmapLinear` + mipmap 让远处那 7.3 m 的格子被平均掉而不是闪成噪点。墙色由材质自己的 color 管，不烘进图。
 */
export function facadeMapTexture(atmosphereId, shapeId) {
  const image = facadeTexture(facadeOptions(atmosphereId, shapeId));
  const texture = new THREE.DataTexture(image.data, image.width, image.height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // uv 里装的已经是米数，所以 repeat 就是"一格贴图铺多少米"的倒数——与 `landmark-forms.js` 那套
  // `repeat.set(perimeter/cell, 1/cell)` 同一把尺，只是这里不需要按周长算。
  texture.repeat.set(1 / FACADE_CELL_METRES, 1 / FACADE_CELL_METRES);
  texture.needsUpdate = true;
  texture.userData = { atmosphereId, shapeId, litPanes: image.litPanes };
  return texture;
}

/**
 * 12 张贴图（三氛围 × 四节奏）与它们的取用口。
 *
 * 一次生成、换氛围只改材质上的指针：现版那侧换窗纹是"换 pattern 名字"，这里换的是 `material.map`，
 * 都不重算顶点。
 */
export function createFacadeSet() {
  const textures = new Map();
  const textureFor = (atmosphereId, category) => {
    const shapeId = facadeShapeOf(category);
    if (!FACADE_THEMES[atmosphereId]) throw new Error(`unknown atmosphere: ${atmosphereId}`);
    const key = `${atmosphereId}/${shapeId}`;
    if (!textures.has(key)) textures.set(key, facadeMapTexture(atmosphereId, shapeId));
    return textures.get(key);
  };
  return {
    textureFor,
    shapes: Object.keys(FACADE_SHAPES),
    atmospheres: Object.keys(FACADE_THEMES),
    dispose: () => {
      for (const texture of textures.values()) texture.dispose();
      textures.clear();
    },
  };
}

// ---------------------------------------------------------------- 夜景亮窗（Phase 2 后半）
//
// 现版那侧的亮窗是**逐楼**决定的：高度带（6 档，`LIGHT_BANDS`，同一档里还按 OSM id 掷骰子分粗细两行）、
// 色温（3 档，按 id 模十分配 4/4/2）、距离环（3 环，把远处灯压暗），再加 1/11 的楼整栋不亮。
// 新引擎把 3,990 栋并成了 4 个桶，"这一格属于哪一档"因此需要一个逐楼的通道 —— 走图集：
// 一格一档，楼的 uv 里再带一个格号（顶点属性 `aLampCell`），片元里 `fract` 回自己那一格。
// 这样既不用按 (类别 × 档) 把桶切成 72 个，也不用逐楼一份材质，一桶一发明暗层就够。

// 图集的一族 = 一套交叉淡。现版那侧是四层（两组楼 × 两批窗），这里把它压成一族里的两段列：
// 前 9 列是出厂那一手，后 9 列是另一手，同一档的左右两格只差"哪几格亮着"。
export const LAMP_PICKS = LAMP_SET_SEEDS.length;
/** 图集的格子数：列 = 色温 × 距离环 × 两批窗，行 = 六个高度带 + 最后一行"整栋不亮"。 */
export const LAMP_GRID = {
  columns: LIGHT_TEMPERATURES.length * LIGHT_FADES.length * LAMP_PICKS,
  rows: LIGHT_BANDS.length + 1,
};
export const LAMP_OFF_ROW = LIGHT_BANDS.length;
// 另一手相对出厂那一手的列偏移（片元里加一次就换到该读的那一格）。
export const LAMP_ALT_COLUMN = LAMP_GRID.columns / LAMP_PICKS;

// 亮窗这一族的画笔，也是图集的默认。纹理工厂与测试共用它，所以"图集里摆的是哪一族"只有一个定义处。
// 第四参数就是现版 `lightTexture` 的那一手（0 = 出厂、1 = 另一手），图集因此与现版共用同一份换窗规则。
const lampPainter = (band, temperature, ring, set = 0) => lightTexture(band, temperature, ring, set);

/**
 * 一栋楼落在图集的哪一格，以及它属于交叉淡的哪一组、是不是那 1/7 会整栋慢灭的。
 * 三条筛子全部复用现版那几个纯函数，所以两边永远分给同一档；后两条在现版那侧是图层过滤条件，
 * 这里没有"层"可以挂，于是作为逐顶点属性交给片元。
 */
export function lampCellOf({ height, osmId, distance }) {
  const ring = Math.max(0, LIGHT_FADES.findIndex((row) => distance < row.below));
  return {
    col: lampTemperatureOf(osmId) + ring * LIGHT_TEMPERATURES.length,
    row: isLampDark(osmId) ? LAMP_OFF_ROW : lampBandOf(height, osmId),
    group: Math.abs(osmId) % LAMP_GROUPS,
    breath: isLampBreather(osmId) ? 1 : 0,
  };
}

/**
 * 把 6×9×两手灯格与一行"全暗"拼成一张图。像素仍然出自 `lightTexture` / `glowTexture`，这里只负责摆放。
 *
 * `painter` 收 (band, temperature, ring, set) 返回一张 32×32 的 RGBA —— 亮窗与光晕是同一套格子、同一条
 * 分档/色温/距离环的规则，只差画的是硬边方窗还是羽化的团。默认是亮窗那一族。
 *
 * 导出的是"摆完的像素"而不是纹理：测试要逐格比对摆放，而纹理一旦交给 WebGL 就读不回来了。
 */
export function lampAtlasImage(painter = lampPainter, picks = LAMP_PICKS) {
  const cell = LIGHT_TILE.size;
  const columns = lampColumns(picks);
  const width = columns * cell, height = LAMP_GRID.rows * cell;
  const data = new Uint8Array(width * height * 4);
  const blit = (col, row, image) => {
    for (let y = 0; y < cell; y++) {
      const from = (y * cell) * 4;
      const to = ((row * cell + y) * width + col * cell) * 4;
      data.set(image.data.subarray(from, from + cell * 4), to);
    }
  };
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    for (let temperature = 0; temperature < LIGHT_TEMPERATURES.length; temperature++) {
      for (let ring = 0; ring < LIGHT_FADES.length; ring++) {
        for (let set = 0; set < picks; set++) {
          blit(temperature + ring * LIGHT_TEMPERATURES.length + set * columns / picks, band, painter(band, temperature, ring, set));
        }
      }
    }
  }
  const off = windowsOffTile(cell);
  for (let col = 0; col < columns; col++) blit(col, LAMP_OFF_ROW, off);
  return { width, height, data, columns, rows: LAMP_GRID.rows };
}

/** 一手还是两手：亮窗摆两手（交叉淡要读第二手），光晕只摆一手——它从来不换手，给它空列是白花的显存。 */
const lampColumns = (picks) => LIGHT_TEMPERATURES.length * LIGHT_FADES.length * picks;

function lampAtlas(painter, picks = LAMP_PICKS) {
  const image = lampAtlasImage(painter, picks);
  const texture = new THREE.DataTexture(image.data, image.width, image.height);
  // 这张图带的是灯自己的颜色（钠黄 / 暖白 / 冷白），不是乘数，所以按 sRGB 解。
  texture.colorSpace = THREE.SRGBColorSpace;
  // 图集不能 RepeatWrapping：越出一格就会啃到隔壁档的灯。格内的平铺改由片元里的 `fract` 负责。
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // 也不开 mipmap：一格只有 32 像素、八格共享一行，跨格过滤会把别的档的灯混进来。
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.repeat.set(1, 1);
  texture.userData = { cells: image.columns * image.rows, size: image.width, columns: image.columns, picks };
  texture.needsUpdate = true;
  return texture;
}

export const lampAtlasTexture = () => lampAtlas(lampPainter);
export const glowAtlasTexture = () => lampAtlas((band, temperature, ring) => glowTexture(band, temperature, ring), 1);

// 现版那侧的灯不是直接上屏的：它要再乘一次 `map.setLight` 的结果 —— 夜景那盏 #c3d8fc / 强度 0.38 把三个通道
// 各按约 [0.50, 0.58, 0.74] 缩了一遍（`src/facade.js` 顶部记着这次探数，暖白灯到屏上因此近乎中性灰）。
// 新引擎的亮窗层是不受光的加色层，没有这一乘，实测同一机位下灯芯中位亮度 93.9 对现版 51.2，正好差这一档。
// 所以把同一个系数搬到材质色上，而不是去调 `LIGHT_BANDS` 的 alpha —— 那张表是现版与新引擎共用的。
export const LAMP_LIGHT_TINT = [0.50, 0.58, 0.74];

/**
 * 亮窗 / 光晕材质：加色、不写深度、不吃雾。
 *
 * 为什么 `fog: false`：远处灯的衰减在现版那侧是**烘进格子里**的（`LIGHT_FADES` 那一环，因为 MapLibre 的
 * `fill-extrusion-opacity` 不能按要素给值），新引擎再叠一层雾等于把同一笔衰减算两遍；而加色层混向雾色
 * 本身也是错的——那会把整片天空的颜色往城市上加。
 */
export function createLampMaterial(texture, mode = 'lamp') {
  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  material.color.setRGB(...LAMP_LIGHT_TINT);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.lampGrid = { value: new THREE.Vector2(1 / (texture.userData.columns ?? LAMP_GRID.columns), 1 / LAMP_GRID.rows) };
    shader.uniforms.lampCellMetres = { value: FACADE_CELL_METRES };
    // 两组的交叉淡权重（1 = 出厂那一手满、另一手空），与现版那两条 global-state 是同一对数。
    shader.uniforms.lampWeight = { value: new THREE.Vector2(1, 1) };
    shader.uniforms.lampAltColumn = { value: LAMP_ALT_COLUMN };
    shader.uniforms.lampOffRow = { value: LAMP_OFF_ROW };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aLampCell;\nattribute vec2 aLampBits;\nvarying vec2 vLampCell;\nvarying vec2 vLampBits;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampCell = aLampCell;\nvLampBits = aLampBits;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLampCell;\nvarying vec2 vLampBits;\nuniform vec2 lampGrid;\nuniform float lampCellMetres;\nuniform vec2 lampWeight;\nuniform float lampAltColumn;\nuniform float lampOffRow;')
      .replace('#include <map_fragment>', mode === 'glow' ? GLOW_FRAGMENT : LAMP_FRAGMENT);
    // 材质编译一次，之后每拍只改这一对数：交叉淡在现版那侧是四层的 opacity，在这里是一格里的两次采样。
    material.userData.shader = shader;
  };
  material.userData.mode = mode;
  // 两个材质的参数一模一样（同一张图集、同一种加色混合），只有 `onBeforeCompile` 塞进去的那段片元不同：
  // three.js 的程序缓存键不看着色器源码，所以不写这一句，第二个材质会直接复用第一个编译好的程序——
  // 亮窗因此拿到的是光晕那份片元，交叉淡的第二手根本没被采样（实测：把列偏移从 9 改成 4.5，画面零变化）。
  material.customProgramCacheKey = () => `lamp-${mode}`;
  return material;
}

// 出厂那一手按 w 加权、另一手按 1−w 加权，两次的和就是现版那两层加色叠出来的结果——加色混合不看目标 alpha，
// 所以"两层各乘一个 opacity"与"一格里的两次采样各乘一个权重"落在屏幕上逐位相同。
// 会呼吸的那 1/7 在另一手上被换到"整栋不亮"那一行，于是它整面墙跟着权重一起暗；其余的楼两行数一样，只是换格。
const LAMP_FRAGMENT = `#ifdef USE_MAP
  vec2 lampTile = vMapUv / lampCellMetres;
  vec2 lampLocal = mix(0.5 * lampGrid, vec2(1.0) - 0.5 * lampGrid, fract(lampTile));
  float lampW = mix(lampWeight.x, lampWeight.y, vLampBits.x);
  vec4 lampShip = texture2D(map, (vLampCell + lampLocal) * lampGrid);
  vec2 lampAlt = vec2(vLampCell.x + lampAltColumn, mix(vLampCell.y, lampOffRow, vLampBits.y));
  vec4 lampOther = texture2D(map, (lampAlt + lampLocal) * lampGrid);
  diffuseColor *= lampShip * lampW + lampOther * (1.0 - lampW);
#endif`;

// 晕不换手（现版那一层也从来没换过）：它是溢出光，不是窗。它唯一跟着走的是自己那栋楼——
// 一栋灭了窗的楼不能再留着它窗亮时糊在墙上的那一片暖光，所以呼吸的那一撮把自己的权重乘进来。
const GLOW_FRAGMENT = `#ifdef USE_MAP
  vec2 lampTile = vMapUv / lampCellMetres;
  vec2 lampLocal = mix(0.5 * lampGrid, vec2(1.0) - 0.5 * lampGrid, fract(lampTile));
  float lampW = mix(1.0, mix(lampWeight.x, lampWeight.y, vLampBits.x), vLampBits.y);
  diffuseColor *= texture2D(map, (vLampCell + lampLocal) * lampGrid) * lampW;
#endif`;

/** 把两组的交叉淡权重交给两个材质：1 是出厂那一手满、另一手空，也就是没有动效的页面画的那一帧。 */
export function setLampWeights(materials, w0, w1) {
  for (const material of materials) {
    const uniform = material.userData.shader?.uniforms.lampWeight;
    if (!uniform) continue;
    uniform.value.set(w0, w1);
  }
}

/** 图集里到底摆了什么：测试用它逐格比对摆放，浏览器判据用它确认另一手不是空的。 */
export const lampAtlasCells = (picks = LAMP_PICKS) => ({
  columns: lampColumns(picks), rows: LAMP_GRID.rows, altColumn: LAMP_ALT_COLUMN, offRow: LAMP_OFF_ROW,
});

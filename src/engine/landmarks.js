// V8 Phase 3 第二格：把地标那一整批资产接进新引擎（#190，#170 剩下的那一半）。
//
// 现版那侧它们站在**另一套 `THREE.Scene`** 里，借 MapLibre 的画布与 GL 上下文补画（`src/tower.js:507`），
// 相机是每帧把 MapLibre 算好的投影矩阵左乘一张米制 modelMatrix 塞进一张裸 `THREE.Camera`。
// 这一格要搬的不是几何也不是材质——那些工厂全是纯函数，两边本来就能调——要搬的是**"谁把镜头交给它们"**：
// 现版读 `map.getZoom()/getBearing()` 与 `args.defaultProjectionData.mainMatrix`，这里读引擎自己的 `rig.view()`
// 与引擎自己的透视相机。米制原点两边是同一个（`createProjection` 复用的就是 `geo.plane`），所以网格一字不改。
//
// 三处必须记住的差别，都写在下面的对应位置：
// ① **雾只许有一层**。壳体那批材质没有逐面的方向光，所以现版把距离斜坡 `recedeColor` 直接烘进 `material.color`；
//    引擎的 `scene.fog` 再打一遍就是双重雾化，广州塔自己的网格与光柱在现版那座场景里同样没有雾。
//    因此这一层所有材质一律 `fog = false`——不是"引擎不雾化地标"，而是"这一层的雾化在它自己手里"。
// ② **氛围切换是瞬切，不是 1.2 s 走查**。现版那侧 `share` 在两个 preset 之间走，壳体的墙色与灯的亮度都骑那个数；
//    引擎这一侧没有走查（`setMode` 一次到位），所以交进去的是"两端都是新那一档、share 0"，
//    于是 `recede()` 落到的颜色与走完那 1.2 s 之后的是同一个数。
// ③ **发数与像素判据都要能把这一层摘出去**：它一进来就是十几发，所以 `counts().landmarks` 报出每一块在不在、
//    几发、几颗顶点，验收用"藏掉这一层再读一次"的自差，不拿两引擎互差（#191）。

import * as THREE from 'three';
import { ATMOSPHERES } from '../atmosphere.js';
import { DEFAULT_CENTER } from '../config.js';
import { FORM_OSM_IDS, LANDMARK_FORMS, createLandmarkForms } from '../landmark-forms.js';
import {
  SHELL_SPILL_ALPHA, applyTowerAtmosphere, applyTowerHue, applyTowerPulse,
  channelCrossing, createGlowBand, createTowerBeam, createTowerModel, outlineRing,
} from '../tower.js';

// 与现版 `map.js` 那三个数同源：色相 40 s 转一圈、默认档 `single`（全 shaft 一个色相），呼吸那一档留给界面按钮（引擎这一侧没有）。
export const TOWER_CYCLE_MS = 40000;
export const TOWER_MODE = 'single';

/**
 * 这块地上站着一片壳体，所以盒子必须让位。
 *
 * 现版那侧是样式里的 `formFilter`（`['!', ['in', osmId, …]]`），三个挤出层与窗纹层都带它。引擎这边没有样式表，
 * 但**一栋塔两套皮**是同一件错：盒子在夜景就是一圈发光的边压在壳体外面（那条判据在 `tests/browser.spec.js` 里点名过）。
 */
export const underShell = (feature) => FORM_OSM_IDS.includes(feature?.properties?.osmId);

/** 一个 feature 轮廓环的质心（落水带要知道塔脚在哪，与现版 `tower.js` 的 `onAdd` 同一个算法）。 */
function ringCentre(ring) {
  const open = ring.slice(0, -1);
  if (!open.length) return null;
  return [open.reduce((sum, point) => sum + point[0], 0) / open.length,
    open.reduce((sum, point) => sum + point[1], 0) / open.length];
}

/** 这一层自己的雾化归自己管：把场景的雾从这批材质上摘下来（见文件头 ①）。 */
function unfogOff(group) {
  const materials = new Set();
  group.traverse((object) => {
    for (const material of [].concat(object.material ?? [])) if (material) materials.add(material);
  });
  for (const material of materials) material.fog = false;
  return materials.size;
}

/**
 * 地标那一整批资产（广州塔网格、东西塔与省博的壳体、海心桥、塔顶光柱、三塔落水带）在新引擎里的一块场景分支。
 *
 * @param {object} options
 * @param {object[]} options.features 建筑快照＋海心桥轮廓——与现版喂 `createLandmarkForms` 的是同一批
 * @param {object[]} options.river 珠江中心线（落水带的位置从它上面量，不是手摆的坐标）
 * @param {{lng:number,lat:number}} [options.origin] 场景原点，两边同一个
 * @param {string} [options.mode] 开屏氛围
 */
export function createLandmarks({ features = [], river = [], origin = DEFAULT_CENTER, mode = 'day' } = {}) {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const forms = createLandmarkForms({ features, origin });
  group.add(forms.group);
  const model = createTowerModel();
  // 现版那座场景里它没有名字（只有一个 `model` 变量）；这里必须命名，teardown 台账按"最近的有名祖先"归类。
  model.name = 'tower-model';
  const beam = createTowerBeam();
  group.add(model, beam);

  // 三塔各在自家门前的江面上留一条自己的光。与现版同一句：轴从珠江中心线上量，量不到就没有这一条。
  const lines = (river ?? []).map((feature) => feature.geometry?.coordinates).filter((line) => line?.length > 1);
  const bandAt = (foot, options, name) => {
    const axis = channelCrossing(lines, foot);
    if (!axis) return null;
    const glow = createGlowBand({ axis, ...options });
    glow.mesh.name = name;
    group.add(glow.mesh);
    return glow;
  };
  const hero = bandAt([origin.lng, origin.lat], {}, 'river-glow');
  const spills = [];
  for (const form of forms.forms) {
    if (!LANDMARK_FORMS[form.osmId]?.night?.spill) continue;
    const outline = outlineRing(form.feature);
    const foot = outline && ringCentre(outline);
    if (!foot) continue;
    const spill = bandAt(foot, { colour: LANDMARK_FORMS[form.osmId].night.glow, alpha: SHELL_SPILL_ALPHA },
      `${form.osmId}:spill`);
    if (spill) spills.push(spill);
  }

  // 摘雾必须放在**全部块都挂进来之后**：三条落水带与光柱是后面才 add 的，先摘就会漏掉它们（现版那座场景里没有雾，
  // 这几块同样不该吃引擎的雾——判据"这一层不许被场景的雾打第二遍"量的就是这一格）。
  const materials = unfogOff(group);
  let preset = (ATMOSPHERES[mode] ?? ATMOSPHERES.day).tower;
  // 顶点账在装配完就算一次：这块几何之后不再变，而 `report()` 每 500 ms 就要被面板读一次。
  let vertices = 0;
  group.traverse((object) => { vertices += object.geometry?.getAttribute('position')?.count ?? 0; });
  let atmosphereId = ATMOSPHERES[mode] ? mode : 'day';
  let night = -1;
  let hueMs = 0;
  let hueShift = 0;
  let painted = null;

  const paintBands = (share) => {
    for (const glow of [hero, ...spills].filter(Boolean)) {
      glow.material.opacity = glow.alpha * share;
      glow.mesh.visible = share > 0;
    }
    return share;
  };
  // 现版那侧 `paintBand` 读的是 `forms.nightShare()`，而那一格必须在**它画的那一帧**取——
  // 只挂在动效拍上时，"动效关着切到夜景"会画出一片没有灯的江面（实测 28.9 对 44.9）。这里同样每帧读。
  const sync = () => {
    const lit = forms.nightShare();
    if (lit !== night) night = paintBands(lit);
    beam.visible = lit > 0;
    return lit;
  };
  const paintTower = () => {
    applyTowerHue(model, preset, hueShift, TOWER_MODE);
    applyTowerPulse(model, preset, 1);
  };
  forms.setAtmosphere({ from: ATMOSPHERES[atmosphereId], to: ATMOSPHERES[atmosphereId], share: 0 });
  applyTowerAtmosphere(model, preset);
  paintTower();

  return {
    group,
    forms,
    /** 每帧一次：壳体按这一帧的 zoom 重算墙色（那条斜坡跟着镜头），落水带与光柱跟着夜景权重。 */
    update: (zoom) => {
      painted = forms.recede(zoom);
      return { receded: Boolean(painted), night: sync() };
    },
    /** 动效那一拍推进色相（默认档 `single`：整根 shaft 一个色相、40 s 转一圈），并把三顶皇冠的时钟递过去。 */
    advance: (elapsedMs) => {
      hueMs += elapsedMs;
      hueShift = (hueMs % TOWER_CYCLE_MS) / TOWER_CYCLE_MS;
      paintTower();
      forms.setBreath(hueMs);
      return { hue: Math.round(hueShift * 1000) / 1000, breathMs: hueMs };
    },
    /** 停下来＝回到出厂那一帧：色相转回 0（现版那句"cycle 0 是逐字出厂色"同一个契约），皇冠回到第 0 毫秒。 */
    reset: () => {
      hueMs = 0;
      hueShift = 0;
      paintTower();
      forms.setBreath(0);
      return { hue: 0, breathMs: 0 };
    },
    setAtmosphere: (id) => {
      if (!ATMOSPHERES[id]) return atmosphereId;
      atmosphereId = id;
      preset = ATMOSPHERES[id].tower;
      applyTowerAtmosphere(model, preset);
      paintTower();
      forms.setAtmosphere({ from: ATMOSPHERES[id], to: ATMOSPHERES[id], share: 0 });
      return atmosphereId;
    },
    /** 光柱与落水带各自的状态：判据要能在"画面里没有它"和"有但没亮"之间分得清。 */
    spillState: () => [hero, ...spills].filter(Boolean).map(({ mesh, material }) => ({
      name: mesh.name, visible: mesh.visible, opacity: Math.round(material.opacity * 100) / 100 })),
    report: () => ({
      ids: forms.ids,
      shells: forms.forms.length,
      bands: [hero, ...spills].filter(Boolean).map(({ mesh }) => mesh.name),
      beam: beam.visible,
      night: Math.round((night < 0 ? 0 : night) * 100) / 100,
      hue: Math.round(hueShift * 1000) / 1000,
      materials,
      vertices,
      visible: group.visible,
    }),
    dispose: () => {
      const geometries = new Set();
      const owned = new Set();
      group.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of [].concat(object.material ?? [])) {
          if (!material || owned.has(material)) continue;
          owned.add(material);
          // 贴图握在材质属性上（壳体的立面图集、灯图、塔网格那道高度斜坡的 `ladderMap`），先还图再还材质。
          for (const value of Object.values(material)) if (value && value.isTexture) value.dispose();
          material.dispose();
        }
        if (object.isInstancedMesh) object.dispose();
      });
      for (const geometry of geometries) geometry.dispose();
      group.clear();
    },
  };
}

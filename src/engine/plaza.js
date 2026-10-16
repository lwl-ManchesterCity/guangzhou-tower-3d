// 花城广场那四层实测面与地面那张不重复的乘性贴图，在新引擎这一侧的对应物（#192）。
//
// 现版那侧是四张 MapLibre `fill` 层加一张贴在 `tower.js` 地面通道上的网格；引擎这一侧的"底图"就是
// `ground.js` 那几块平色板，所以这里做的是同一件事的另一半：把广场自己的四类面（草坪／硬质面／扫出来的步行带）
// 垫在那些平色板之上，再把 `plaza-surface.js` 那张按广场米数铺开的乘性网格压在它们顶上。
// 层序不是随手挑的：`canton-blocks` 里那些 `kind=pedestrian` 的面在 `ground.js` 判成 `pavement`，标高 0.06 m，
// 而盖住它的那块公园面是 0.13 m——于是整片广场在引擎里就是一张绿皮。石材与步行带必须站在这几层之上才说得上话。
//
// 池面（`pool`）这里没有第四块板：`canton-water` 那一面本来就被 `ground.js` 画成水色，江面波光那一层也按同一批
// 水面面起波，再叠一块同色的板只是多一次覆盖。贴图里那一圈水线（`WATER_EDGE_SHADE`）压的就是这一层画出来的水色。
import * as THREE from 'three';
import { PLAZA_SURFACE_MIN_ZOOM, plazaSurface, plazaSurfaceMesh } from '../plaza-surface.js';
import { carvePlaza } from '../plaza.js';
import { GROUND_LAYERS, mergePositions, plateGeometry, polygonsOf } from './ground.js';

// 三个标高都从 `GROUND_LAYERS` 往上抬同一把台阶：广场的板要盖住引擎那些底图平色板与路带，而那张乘性贴图又要
// 站在它们所有人之上一格——它自己 `depthWrite: false`，所以这一格差只是"谁先被画"的秩序，不是厚度。
export const PLAZA_LAYERS = {
  lawn: GROUND_LAYERS.road + 0.01,
  stone: GROUND_LAYERS.road + 0.02,
  walk: GROUND_LAYERS.road + 0.03,
  surface: GROUND_LAYERS.road + 0.04,
};

// 每一类刷哪一档氛围色，与现版那四张 `fill` 层逐字同一张表（`plaza.js` 的 `plazaLayers`）。
export const plazaColors = (preset) => ({
  'plaza-lawn': preset.grass,
  'plaza-stone': preset.plaza,
  'plaza-walk': preset.plazaWalk,
});

/**
 * @param {{greens: object[], water: object[], blocks: object[], streets: object[],
 *   project: Function, origin: {lng: number, lat: number}, preset: object}} input
 * @returns {{group: THREE.Group, report: Function, setZoom: Function, setAtmosphere: Function, dispose: Function}|null}
 *   快照里没有那块公园面就整个返回 null，不造一层空壳。
 */
export function createPlazaGround({ greens = [], water = [], blocks = [], streets = [], project, origin, preset }) {
  const plaza = carvePlaza({ greens, water, blocks, streets });
  if (!plaza.ring) return null;
  const surface = plazaSurface({ ring: plaza.ring, features: plaza.features, origin });
  const group = new THREE.Group();
  group.name = 'plaza-ground';
  const meshes = [];
  const colours = plazaColors(preset);
  for (const [kind, y] of [['lawn', PLAZA_LAYERS.lawn], ['stone', PLAZA_LAYERS.stone], ['walk', PLAZA_LAYERS.walk]]) {
    const features = plaza.features.filter((feature) => feature.properties.kind === kind);
    const parts = [];
    for (const feature of features) {
      for (const rings of polygonsOf(feature.geometry)) {
        const plate = plateGeometry(rings, project, y);
        if (plate.getAttribute('position').count) parts.push(plate);
        else plate.dispose();
      }
    }
    if (!parts.length) continue;
    const name = `plaza-${kind}`;
    // 与那些平色板同一个理由：不受光。底图把这些面画成平色，色板里的 hex 就是像素本身。
    const mesh = new THREE.Mesh(mergePositions(parts), new THREE.MeshBasicMaterial({ color: colours[name], side: THREE.DoubleSide }));
    mesh.name = name;
    group.add(mesh);
    meshes.push(mesh);
  }
  const decal = plazaSurfaceMesh(surface);
  decal.position.y = PLAZA_LAYERS.surface;
  decal.visible = false;
  group.add(decal);
  const report = () => ({ classes: plaza.report, wide: surface.wide, tall: surface.tall, counts: surface.counts,
    plates: meshes.length, minZoom: PLAZA_SURFACE_MIN_ZOOM, surface: decal.visible === true });
  return {
    group,
    report,
    // 与楼根接地带同一类门控：读的是**画的那一帧**的镜头，所以载入那一帧与跑过又停下那一帧必须给同一个答案。
    // 16.5 之前这张图不落像素（6 m 一条缝在 15.4 级是 1 格），而它作为整块透明面参与排序会把逐字节回帧那条判据弄红。
    setZoom: (zoom) => { decal.visible = zoom >= PLAZA_SURFACE_MIN_ZOOM; },
    setAtmosphere: (next) => {
      const colours = plazaColors(next);
      for (const mesh of meshes) mesh.material.color.set(colours[mesh.name]);
    },
    dispose: () => {
      for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
      decal.geometry.dispose();
      decal.material.dispose();
      // 贴图归造它的那一方还（`plaza-surface.js` 造，这一层是唯一用户），与那颗光晕贴图归 `boot.js` 同一条归属。
      surface.texture.dispose();
      group.clear();
    },
  };
}

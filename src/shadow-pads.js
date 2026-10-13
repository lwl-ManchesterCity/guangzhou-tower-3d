// 贴地那一片暗影管的是"这东西确实压在地面上"。这一轮之前全画面一处阴影都没有（`castShadow`/`shadowMap` 在
// `src/` 里命中 0），1,298 辆车、1,244 个行人、2,381 株树与 3,990 栋楼都是贴在地上浮着。
//
// 真做方向光阴影在现版这一侧做不到，原因是归属而不是省事：楼是 MapLibre 的 `fill-extrusion`，它不进 three 的
// 阴影贴图；而一张盖满 3 km 的 shadow map 按 2,048 px 算是 1.5 m/px，比一条车道还粗，画出来的边比楼本身还糊。
// 所以按"谁的地盘谁画"分两半：
// ① **会动的（车、人）与树**——它们在 three 的米制场景里，就在那儿发贴片：一份径向衰减的 DataTexture +
//    每类一个 `InstancedMesh`，跟着物体的位姿走（车还要跟桥面一起抬，否则就是"车在桥上、影在水里"）。
// ② **楼根**——楼也有 three 里的那一侧（新引擎），所以这一半不用 MapLibre 的 `line-offset`：那条的
//    `line-width` 单位是**像素**，画出来是一圈等宽描边而不是三米宽的接地带，拉到 18 级就变成贴在墙根的一条线。
//    这里改成按实测轮廓向外偏一圈的合并几何：一个 draw call、米制宽度、朝外衰减。
//
// 宽度与深浅都是画的（OSM 不给任何东西的阴影），位置全部从实测矢量派生，卡片与 README 按同一句口径点名"示意"。
import * as THREE from 'three';
import { plane } from './geo.js';

// 贴片的峰值不透明度刻意低：贴片是 alpha 混合，两辆车间隙小的时候会叠，0.34 叠两层才到 0.56。
export const PAD_OPACITY = 0.34;
export const PAD_COLOUR = '#101510';
// 抬离地面的米数。新引擎最高的那块地面是 `GROUND_LAYERS.road = 0.3`，贴片必须压在它上面，否则在路面上被自己那
// 条路带挡住；现版那侧地面在 0，抬 0.38 m 在 40 px 的一辆车下面看不出这点高差。
export const PAD_LIFT_METRES = 0.38;
// 影子的椭圆比车身大一圈：正好等大的贴片会被车体吃掉一半，看上去像"车下面缺一块"。
export const PAD_SPREAD = 1.25;
export const PAD_TEXTURE_STEPS = 32;
// 中心那一段实心（车正下方），往外平方衰减到边。 plateau 太宽就成了一块饼干。
export const PAD_CORE_SHARE = 0.34;

// 楼根部那条接地带。
export const BASE_BAND_WIDTH_METRES = 3.2;
export const BASE_BAND_OPACITY = 0.26;
export const BASE_BAND_LIFT_METRES = 0.34;
export const BASE_BAND_MIN_ZOOM = 15;
// 只给这一圈以内的楼画：外头那些在屏幕上不到 3 px，画了是一条脏边而不是一片影。
// 按出厂快照量的：任一回字落进 1,200 m 的楼是 286 面 / 2,047 个环顶点，合并之后一个 draw call。
export const BASE_BAND_MAX_METRES = 1200;

// 近岸那一圈湿线。宽度是画的（OSM 不给"水边"这一要素，岸线就是水面多边形的边），位置全部从实测岸线派生。
// 7 m 是"在 15.7 级读得出是一条边、在 17 级读得出它有深浅"的那一档；再窄就成了贴岸的一条线。
export const WET_BAND_WIDTH_METRES = 7;
// 比楼根带略深一点：水本来就是画面里最暗的那一档面，湿线要压得住它才读得出来，而压得住的前提是它只有一条边那么宽。
export const WET_BAND_OPACITY = 0.3;
export const WET_BAND_MIN_ZOOM = 15;
export const WET_BAND_MAX_METRES = 1200;
// 水面宽度不到 `宽度 × 这一倍数` 的那一圈不画（见 `wetBandGeometry`：小水塘会被整块涂黑，那不是近岸）。
export const WET_BAND_MIN_WIDTH_SHARE = 3;

/**
 * 一张径向衰减的 alpha 图：中心实心，边上透明。
 *
 * 用 `DataTexture` 而不是 `CanvasTexture`（`trafficSprite` 那一颗）是为了能在 Node 里被构造与被判据读——
 * 这一模块的两条渲染路径共用，测试要在不带 DOM 的那一侧也跑得到同一批数。
 */
export function padTexture({ steps = PAD_TEXTURE_STEPS, core = PAD_CORE_SHARE } = {}) {
  const data = new Uint8Array(steps * steps * 4);
  const centre = (steps - 1) / 2;
  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const at = Math.hypot(x - centre, y - centre) / centre;
      // 方的贴图四个角比半径远，不夹住就会在角上留一圈不该有的淡影（判据量的正是这个角）。
      const share = at >= 1 ? 0 : at <= core ? 1 : (1 - (at - core) / (1 - core)) ** 2;
      data.set([255, 255, 255, Math.round(255 * share)], (y * steps + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, steps, steps, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** 一条沿宽度方向衰减的 alpha 图：贴墙那一头实心，外沿那一头没了。 */
export function bandTexture({ steps = PAD_TEXTURE_STEPS } = {}) {
  const data = new Uint8Array(steps * 4);
  for (let x = 0; x < steps; x += 1) {
    const at = x / (steps - 1);
    const share = at < 0.12 ? 1 : (1 - (at - 0.12) / 0.88) ** 1.6;
    data.set([255, 255, 255, Math.round(255 * share)], x * 4);
  }
  const texture = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const padMaterial = (map, opacity) => new THREE.MeshBasicMaterial({
  map, transparent: true, opacity, color: PAD_COLOUR, depthWrite: false,
  // 贴片压在别人的地面之上，靠 polygonOffset 而不是靠抬米数去躲共面闪烁。
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});

/** 一片躺平的单位方形，实例的 scale 就是它的长半轴与短半轴（米）。 */
export function padGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * 一批接触阴影贴片，一个实例网格。
 *
 * @param {{name: string, count: number, opacity?: number}} options count 为 0 时网格照样给（`InstancedMesh` 允许 0 台），
 *   调用方就不必为"这一侧没有车"再写一个分支。
 */
export function createPads({ name, count, opacity = PAD_OPACITY }) {
  const map = padTexture();
  const material = padMaterial(map, opacity);
  const mesh = new THREE.InstancedMesh(padGeometry(), material, Math.max(1, count));
  mesh.name = name;
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let written = 0;
  return {
    mesh,
    /**
     * 摆一片。`yaw` 用与车体同一个角：贴片是椭圆，长轴必须压在行进方向上，
     * 否则一辆横着的车下面是一条竖着的影。
     */
    place({ x, y, deck = 0, yaw = 0, radiusX, radiusY }) {
      position.set(x, PAD_LIFT_METRES + deck, -y);
      spin.setFromAxisAngle(up, yaw);
      scale.set(radiusX * 2, 1, radiusY * 2);
      matrix.compose(position, spin, scale);
      mesh.setMatrixAt(written, matrix);
      written += 1;
    },
    finish() {
      mesh.count = written;
      mesh.instanceMatrix.needsUpdate = true;
      written = 0;
    },
    dispose() {
      mesh.geometry.dispose();
      map.dispose();
      material.dispose();
    },
  };
}

/** 环的面积符号：GeoJSON 没规定绕序，所以内外侧要按这一圈自己算（负面积就是顺时针）。 */
const ringSense = (points) => {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].dx * next.dy - next.dx * points[index].dy;
  }
  return area >= 0 ? 1 : -1;
};

/**
 * 一圈轮廓 → 每个顶点的法线（相邻两条边的法线平均）。
 * `sense` 决定这一圈的法线朝外还是朝内，所以同一份函数既够楼根（朝外）也够近岸（朝水）。
 * `mitre` 是尖角处允许把偏移拉长的倍数：楼根那条要贴住墙脚，给 2；近岸那条给 1——
 * 凹角上 2 倍斜接会把带子甩到堤岸上去（量到 6 颗），宁可留一个看不见的小豁口。
 */
function ringNormals(points, sense, width, mitre = 2) {
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const dx = next.dx - point.dx;
    const dy = next.dy - point.dy;
    const span = Math.hypot(dx, dy);
    if (!span) return null;
    // 逆时针环的外侧是每条边的右手边，顺时针反过来。
    return { x: sense * dy / span, y: -sense * dx / span };
  });
  return points.map((_, index) => {
    const previous = edges[(index - 1 + points.length) % points.length];
    const current = edges[index];
    if (!previous || !current) return current || previous || { x: 0, y: 0 };
    let nx = previous.x + current.x;
    let ny = previous.y + current.y;
    const length = Math.hypot(nx, ny);
    if (!length) return current;
    nx /= length;
    ny /= length;
    // 尖角的斜接长度 = 1 / cos(半夹角)，用点积还原；夹在 `mitre` 倍以内免得一根刺。
    const stretch = Math.min(mitre, 1 / Math.max(0.5, nx * current.x + ny * current.y));
    return { x: nx * stretch, y: ny * stretch };
  });
}

/**
 * 一圈（米制、首点不重复）→ 一条 `width` 米宽的带：u=0 在这一圈自己的边上（最深），u=1 在偏出去的那一头（淡到没有）。
 * `sense` 决定往哪一边偏，所以楼根（朝外）与近岸（朝水里）共用这一份写法。
 * 朝上还是朝下由"这一圈的绕序"与"往哪边偏"两件事一起决定，与其推符号公式（推错过一次：湿线在场景里、在画面外，
 * 逐像素 A/B 量到 0 个像素变化），不如直接量第一个三角形：法线的 y 分量为负就整条反过来发。
 */
function ringBand(points, { width, lift, sense, mitre = 2 }) {
  const normals = ringNormals(points, sense, width, mitre);
  const a = points[0];
  const b = points[1 % points.length];
  const an = normals[0];
  const bn = normals[1 % points.length];
  // 世界坐标是 (x, 常数 y, -y北)，所以 n.y = dz₁·dx₂ − dx₁·dz₂，其中 1 指向偏出去那一头、2 指向环的下一个点。
  const flip = ((-(b.dy + bn.y * width) + a.dy) * (b.dx - a.dx) - (b.dx + bn.x * width - a.dx) * (-(b.dy) + a.dy)) < 0;
  const positions = [];
  const uvs = [];
  const tri = (a, b, c) => {
    for (const corner of (flip ? [a, c, b] : [a, b, c])) {
      positions.push(corner[0], lift, corner[1]);
      uvs.push(corner[2], corner[3]);
    }
  };
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const an = normals[index];
    const bn = normals[(index + 1) % points.length];
    // 四个角：岸上两个（u=0）、偏出去两个（u=1）。
    const a0 = [a.dx, -a.dy, 0, 0];
    const b0 = [b.dx, -b.dy, 0, 1];
    const aOut = [a.dx + an.x * width, -(a.dy + an.y * width), 1, 1];
    const bOut = [b.dx + bn.x * width, -(b.dy + bn.y * width), 1, 0];
    tri(a0, bOut, b0);
    tri(a0, aOut, bOut);
  }
  return { positions, uvs };
}

/** 若干段带合成一份非索引几何。 */
function bandGeometry(parts) {
  const positions = parts.flatMap((part) => part.positions);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(parts.flatMap((part) => part.uvs), 2));
  geometry.computeVertexNormals();
  return { geometry, vertices: positions.length / 3 };
}

/** 环的"平均宽度"粗估：`2 × 面积 / 周长`。一条 240 m 宽、16 km 长的江带算出来是 230 m；一块方形算出来是边长的一半（偏保守，正是这一格要的方向）。 */
function ringWidth(points) {
  let perimeter = 0;
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    perimeter += Math.hypot(b.dx - a.dx, b.dy - a.dy);
    twice += a.dx * b.dy - b.dx * a.dy;
  }
  return perimeter ? Math.abs(twice) / perimeter : 0;
}

/**
 * 楼根一圈的接地带：按实测轮廓向外偏 `width` 米的一条带，贴墙那头最深、外沿淡到没有，合成一份几何。
 *
 * 面与环全部来自 `canton-buildings.geojson`（OSM 轮廓 + 影像轮廓那一轮晋升的同一份快照），一个都不手摆；
 * "任一回字落进 `maxDistance` 以内才画"是距离闸门，不是取舍。
 */
export function baseBandGeometry({ features = [], origin, width = BASE_BAND_WIDTH_METRES, maxDistance = BASE_BAND_MAX_METRES } = {}) {
  const ringsOf = (feature) => (feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates[0]]
    : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates.map((parts) => parts[0]) : []);
  const parts = [];
  for (const feature of features) {
    for (const raw of ringsOf(feature)) {
      if (!raw || raw.length < 4) continue;
      const points = raw.slice(0, -1).map(([lng, lat]) => plane(origin, { lng, lat }));
      if (!points.some((point) => Math.hypot(point.dx, point.dy) <= maxDistance)) continue;
      // 只走外环：楼的中庭洞不参与接地带，画在洞边上会把影投到楼里面。
      parts.push(ringBand(points, { width, lift: BASE_BAND_LIFT_METRES, sense: ringSense(points) }));
    }
  }
  const built = bandGeometry(parts);
  return { geometry: built.geometry, faces: parts.length, vertices: built.vertices };
}

/**
 * 近岸那一圈湿线：沿实测水边线向**水里**偏出一条带，岸边那头最深、往江心淡到没有。
 *
 * 与楼根那条是同一套几何写法（`ringBand`），差别只有两笔：偏的方向朝水，以及**水面不够宽就不画**。
 * 后者是量出来的：出厂快照里落进 1,200 m 的水环有 11 条，其中 7 条不到 2 公顷——按 `2 × 面积 / 周长` 估的水面宽度
 * 不到三条带宽（21 m）的那一圈，画上去不是"近岸"而是把整个小水塘涂黑，所以按这一条拒掉。
 * 洞也走：水面多边形的洞就是江心洲与岛，它们的岸线一样该有湿线（绕序相反，所以法线自动朝外、还是朝水）。
 */
export function wetBandGeometry({ features = [], origin, width = WET_BAND_WIDTH_METRES, maxDistance = WET_BAND_MAX_METRES, minWidth = WET_BAND_MIN_WIDTH_SHARE } = {}) {
  const polygonsOf = (feature) => (feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
    : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : []);
  const parts = [];
  let skipped = 0;
  for (const feature of features) {
    for (const polygon of polygonsOf(feature)) {
      const rings = polygon.map((raw) => (raw?.length > 3 ? raw.slice(0, -1).map(([lng, lat]) => plane(origin, { lng, lat })) : null));
      const outer = rings[0];
      if (!outer) continue;
      if (!outer.some((point) => Math.hypot(point.dx, point.dy) <= maxDistance)) continue;
      // 宽度闸门按**外环**算：洞是江心洲，它的"宽度"是岛的宽度不是水面的宽度，拿它当闸门会把洲那一圈岸错拒掉。
      if (ringWidth(outer) < width * minWidth) {
        skipped += 1;
        continue;
      }
      rings.forEach((points, index) => {
        if (!points) return;
        // 外环朝水里＝朝这一圈自己围的那一侧；洞（岛）的水在环的另一侧，所以符号反过来。
        // 这一格不能按绕序统一取：绕序只告诉你"这一圈围的是哪一边"，而水在哪一边要看它是外环还是洞。
        parts.push(ringBand(points, { width, lift: PAD_LIFT_METRES, sense: index ? ringSense(points) : -ringSense(points), mitre: 1 }));
      });
    }
  }
  const built = bandGeometry(parts);
  return { geometry: built.geometry, faces: parts.length, skipped, vertices: built.vertices };
}

/**
 * 近岸湿线那一层：一个网格，镜头门控与楼根带同一条口径。
 *
 * 挂在近场那三组里（`src/near-field.js`），所以高度透视镜把近场收走时它一起走，像素判据那几条"读之前先藏近场"的
 * 门槛不必再加一格。
 */
export function createShoreBand({ features, origin, width = WET_BAND_WIDTH_METRES, maxDistance = WET_BAND_MAX_METRES, minZoom = WET_BAND_MIN_ZOOM, opacity = WET_BAND_OPACITY } = {}) {
  const built = wetBandGeometry({ features, origin, width, maxDistance });
  const map = bandTexture();
  const material = padMaterial(map, opacity);
  const mesh = new THREE.Mesh(built.geometry, material);
  mesh.name = 'shore-wet-line';
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.name = 'shore-wet';
  group.add(mesh);
  let zoom = null;
  let shown = true;
  // 与楼根带同一套：镜头门控与总开关是两件事，任何一个变了都要重算，但谁也不能把对方顶掉
  // （不然透视镜把湿线收走之后，下一帧镜头一动它又自己回来了）。
  const apply = () => { group.visible = shown && (zoom === null || zoom >= minZoom); };
  apply();
  return {
    group,
    mesh,
    report: { faces: built.faces, skipped: built.skipped, vertices: built.vertices, width, maxDistance, minZoom },
    setZoom(next) {
      if (zoom !== null && Math.abs(next - zoom) < 0.02) return false;
      zoom = next;
      apply();
      return true;
    },
    setShown(on) {
      if (shown === Boolean(on)) return false;
      shown = Boolean(on);
      apply();
      return true;
    },
    visible: () => group.visible,
    dispose() {
      built.geometry.dispose();
      map.dispose();
      material.dispose();
      group.clear();
    },
  };
}

/**
 * 楼根接地带的那一层：一个网格，镜头门控与树同一条口径（拉远到看不清就不画，交回样式那块地）。
 *
 * 静态，所以没有每帧更新的矩阵；只有 `setZoom` 会碰它。
 */
export function createBaseBands({ features, origin, width = BASE_BAND_WIDTH_METRES, maxDistance = BASE_BAND_MAX_METRES, minZoom = BASE_BAND_MIN_ZOOM } = {}) {
  const built = baseBandGeometry({ features, origin, width, maxDistance });
  const map = bandTexture();
  const material = padMaterial(map, BASE_BAND_OPACITY);
  const mesh = new THREE.Mesh(built.geometry, material);
  mesh.name = 'building-bases';
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.name = 'building-bases-group';
  group.add(mesh);
  let zoom = null;
  let shown = true;
  const apply = () => { group.visible = shown && (zoom === null || zoom >= minZoom); };
  apply();
  return {
    group,
    mesh,
    report: { faces: built.faces, vertices: built.vertices, width, maxDistance, minZoom },
    setZoom(next) {
      if (zoom !== null && Math.abs(next - zoom) < 0.02) return false;
      zoom = next;
      apply();
      return true;
    },
    setShown(on) {
      if (shown === Boolean(on)) return false;
      shown = Boolean(on);
      apply();
      return true;
    },
    visible: () => group.visible,
    dispose() {
      built.geometry.dispose();
      map.dispose();
      material.dispose();
      group.clear();
    },
  };
}

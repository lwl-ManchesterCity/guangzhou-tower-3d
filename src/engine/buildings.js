// V8 Phase 1：建筑体块。几何走 `Shape + ExtrudeGeometry`，这正是迁移的直接红利 —— 现版的窗纹是
// `fill-extrusion-pattern` 按米制平方铺的，换到 ExtrudeGeometry 之后侧壁可以自己出 UV（Phase 2 做），
// 不再被 MapLibre 的拉伸规则绑住。Phase 0 那十栋样品已经退休：现在默认画快照里的全部 3,990 栋，按类别并桶，
// `pickTallest` 留给"只画 N 栋"的对照档（`testBuildings`）。
import * as THREE from 'three';

// The same floor the extrusions use today: an untagged footprint gets an illustrative thickness from its own outline,
// never a guessed storey count.
export const DEFAULT_HEIGHT = 9.6;

const ringOf = (feature) => (feature.geometry.type === 'Polygon'
  ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0]?.[0]);

const shortEdge = (ring) => {
  let shortest = Infinity;
  for (let index = 1; index < ring.length; index++) {
    const dx = ring[index][0] - ring[index - 1][0], dy = ring[index][1] - ring[index - 1][1];
    shortest = Math.min(shortest, Math.hypot(dx, dy));
  }
  return Number.isFinite(shortest) ? shortest : 0;
};

/** The height a block is drawn at: OSM's own tag when it has one, otherwise the illustrative floor. */
export const drawnHeight = (feature) => {
  const height = Number(feature.properties?.height ?? feature.properties?.displayHeight);
  return Number.isFinite(height) && height > 0 ? height : DEFAULT_HEIGHT;
};

/**
 * The `count` tallest blocks, ordered by height then id so two runs pick the same ten.
 *
 * A tie broken by array order would move as soon as the snapshot is regenerated, and the acceptance reads pixel
 * positions off this list.
 */
export function pickTallest(features, count) {
  return [...features]
    .map((feature) => ({ feature, height: drawnHeight(feature), osmId: Number(feature.properties?.osmId) }))
    .sort((a, b) => b.height - a.height || a.osmId - b.osmId)
    .slice(0, count)
    .map((entry) => entry.feature);
}

/**
 * 侧壁的米制 UV，Phase 2 的窗纹靠它。
 *
 * `ExtrudeGeometry` 自带的 `WorldUVGenerator` 给的是 `(x 或 y, 1 − z)`：u 取的是**绝对**坐标里的那一个轴，
 * 所以同一栋楼两条平行的墙各自错位、而不同楼之间又跟着世界原点跑；v 还反过来。窗纹要的是"沿这条边铺几米、
 * 离自己基底几米"，所以自己写：u 从这条边的起点累计到终点，v 就是标高米数。顶面写零不是省事——覆盖层只画侧壁
 * 那一段（见 `mergeSolids` 的 `overlay`），屋顶永远接不到窗格，这是 2026-10-04「顶面不再挂窗格」那条裁定在新引擎里的落点。
 */
export const facadeUVGenerator = {
  generateTopUV: () => [new THREE.Vector2(0, 0), new THREE.Vector2(0, 0), new THREE.Vector2(0, 0)],
  // f4(a, b, c, d) 里 a、b 是同一条边的下端点，c、d 是它们各自正上方的端点，所以 (a,d) 与 (b,c) 是两条竖边。
  generateSideWallUV: (geometry, vertices, ia, ib, ic, id) => {
    const at = (index) => [vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]];
    const [a, b, c, d] = [ia, ib, ic, id].map(at);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [
      new THREE.Vector2(0, a[2]), new THREE.Vector2(length, b[2]),
      new THREE.Vector2(length, c[2]), new THREE.Vector2(0, d[2]),
    ];
  },
};

/**
 * One block, standing at its own footprint.
 *
 * @param {number[][]} ring `[lng, lat]` pairs, closed
 * @param {{height: number, base?: number, project: Function, metricUV?: boolean}} options
 */
export function buildingGeometry(ring, { height, base = 0, project, metricUV = false }) {
  const shape = new THREE.Shape();
  ring.forEach(([lng, lat], index) => {
    const point = project({ lng, lat });
    if (index === 0) shape.moveTo(point.x, -point.z);
    else shape.lineTo(point.x, -point.z);
  });
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height, bevelEnabled: false, ...(metricUV ? { UVGenerator: facadeUVGenerator } : {}),
  });
  // Extrusion runs along +Z; turning it flat by -90° about X sends that axis up and leaves the footprint at y = base.
  geometry.rotateX(-Math.PI / 2);
  if (base) geometry.translate(0, base, 0);
  geometry.computeVertexNormals();
  return geometry;
}

// `ExtrudeGeometry` 每个 shape 先加顶/底面那一组（materialIndex 0）、再加侧壁那一组（1），所以两段是前后相邻的。
const capAndSideCounts = (part) => {
  const groups = part.groups.filter((group) => group.materialIndex === 0 || group.materialIndex === 1);
  if (groups.length !== 2) throw new Error(`体块几何应当有顶面与侧壁两组，实际 ${groups.length} 组`);
  const caps = groups.find((group) => group.materialIndex === 0);
  const sides = groups.find((group) => group.materialIndex === 1);
  if (caps.start !== 0 || caps.count + sides.count !== part.getAttribute('position').count) {
    throw new Error('体块的两组不挨着，合并器的前提变了');
  }
  return [caps.count, sides.count];
};

/**
 * 把同色的体块并成一份，**position 与其余逐顶点属性一起搬**，并且把顶面与侧壁各自攒成连续一段。
 *
 * 地面那层的 `mergePositions` 只搬 position，这里不能复用：窗纹靠 uv，夜景亮窗还靠一个逐楼的格号
 * （`aLampCell`，图集里那一档灯在哪一格）。两趟循环是为了让顶面全部攒在前面、侧壁全部攒在后面 —— 覆盖层
 * 因此可以只借同一批 attribute、把 `drawRange` 摆在侧壁起点上，不复制一份顶点（3,990 栋那一段实测 37 万个顶点）。
 *
 * @param {THREE.BufferGeometry[]} parts
 * @param {string[]} [extra] 除 uv 之外要一起搬的逐顶点属性名
 * @returns {{geometry: THREE.BufferGeometry, overlay: THREE.BufferGeometry, caps: number, sides: number}}
 */
export function mergeSolids(parts, extra = []) {
  const channels = ['position', 'uv', ...extra];
  for (const part of parts) for (const name of channels) {
    if (!part.getAttribute(name)) throw new Error(`体块没有 ${name}：生成时要把这一层带上`);
  }
  const items = new Map(channels.map((name) => [name, parts[0].getAttribute(name).itemSize]));
  for (const name of channels) {
    const size = items.get(name);
    if (!parts.every((part) => part.getAttribute(name).itemSize === size)) throw new Error(`${name} 在各块之间的分量数不一致`);
  }
  const spans = parts.map((part) => capAndSideCounts(part));
  const buffers = new Map(channels.map((name) => [name, []]));
  // 两趟：先把每一块的顶面抄完，再抄侧壁，两段各自连续。
  for (const pass of [0, 1]) parts.forEach((part, index) => {
    const [caps, sides] = spans[index];
    const from = pass === 0 ? 0 : caps;
    const count = pass === 0 ? caps : sides;
    for (const name of channels) {
      const array = part.getAttribute(name).array;
      const size = items.get(name);
      const target = buffers.get(name);
      for (let vertex = from; vertex < from + count; vertex++) {
        for (let channel = 0; channel < size; channel++) target.push(array[vertex * size + channel]);
      }
    }
  });
  const total = buffers.get('position').length / 3;
  const caps = spans.reduce((sum, [count]) => sum + count, 0);
  const geometry = new THREE.BufferGeometry();
  for (const [name, values] of buffers) geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, items.get(name)));
  geometry.computeVertexNormals();
  geometry.addGroup(0, caps, 0);
  geometry.addGroup(caps, total - caps, 1);
  const overlay = new THREE.BufferGeometry();
  for (const name of channels) overlay.setAttribute(name, geometry.getAttribute(name));
  overlay.drawRange = { start: caps, count: total - caps };
  for (const part of parts) part.dispose();
  return { geometry, overlay, caps, sides: total - caps };
}


/**
 * 全量建筑：按 `category` 分桶，每桶一份合并几何。
 *
 * 一栋一个 Mesh 就是 3,990 个 draw call，那一档 FPS 判据与"合并之后 draw call 在一百以内"都过不去；分桶之后
 * 一桶一个。颜色挂在材质上（一个类别一面墙），所以换氛围是改几个材质色，不必回头重算顶点色。
 *
 * Phase 2 起每桶其实是**两层**：墙（一份合并几何）与压在它上面的窗格覆盖层（同一批 attribute、`drawRange` 只罩住
 * 侧壁那一段）。覆盖层是半透明的、不写深度，靠 `polygonOffset` 压在墙前面一点点——这与现版"立面是独立覆盖层、
 * 图案着色器不读墙色"同构，所以两边可以共用同一张 `facadeTexture` 的像素与同一条透明度斜坡。
 *
 * @param {{features: object[], project: Function, palette: Function, heightOf?: Function,
 *   facade?: null | { textureFor: Function, opacityFor: Function, atmosphere: () => string }}} input
 *   `palette(category)` 给每一桶一个墙色；`facade` 缺席时就是 Phase 1 那副光板墙
 * @returns {{group: THREE.Group, count: number, heights: number[], categories: string[],
 *   setPalette: Function, setFacade: Function, dispose: Function}}
 */
export function createBuildingBuckets({ features, project, palette, heightOf = drawnHeight, facade = null }) {
  const group = new THREE.Group();
  group.name = 'buildings';
  const buckets = new Map();
  const heights = [];
  const lamp = facade?.lamp ?? null;
  for (const feature of features) {
    const ring = ringOf(feature);
    if (!ring || ring.length < 4) continue;
    const height = heightOf(feature);
    // `ExtrudeGeometry` comes out non-indexed already, and asking again makes three warn once per block — 3,990
    // warnings is enough to red-flag every item in the file that asserts the console stayed clean.
    const solid = buildingGeometry(ring, { height, base: Number(feature.properties?.base) || 0, project, metricUV: true });
    const geometry = solid.index ? solid.toNonIndexed() : solid;
    const category = String(feature.properties?.category ?? 'unknown');
    if (lamp) {
      // 逐楼的图集格号：一栋之内每个顶点带的是同一个格子，片元再按 uv 的小数部分在格子内平铺。
      // 同一段还带两个骰子——交叉淡的分组与"这一栋会整栋慢灭"——现版那侧它们是图层过滤条件，
      // 这里四个桶共用一个材质，没有层可以挂，只能作为顶点属性走到片元去。
      const cell = lamp.cellOf({ height, osmId: Number(feature.properties?.osmId) || 0,
        distance: Number(feature.properties?.distance) || 0 });
      const count = geometry.getAttribute('position').count;
      const values = new Float32Array(count * 2);
      const bits = new Float32Array(count * 2);
      for (let vertex = 0; vertex < count; vertex++) {
        values[vertex * 2] = cell.col;
        values[vertex * 2 + 1] = cell.row;
        bits[vertex * 2] = cell.group;
        bits[vertex * 2 + 1] = cell.breath;
      }
      geometry.setAttribute('aLampCell', new THREE.BufferAttribute(values, 2));
      geometry.setAttribute('aLampBits', new THREE.BufferAttribute(bits, 2));
    }
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(geometry);
    heights.push(height);
  }
  const merged = [], materials = [];
  for (const [category, parts] of buckets) {
    const { geometry, overlay } = mergeSolids(parts, lamp ? ['aLampCell', 'aLampBits'] : []);
    const material = new THREE.MeshLambertMaterial({ color: palette(category) });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `buildings-${category}`;
    mesh.userData = { category, blocks: parts.length };
    merged.push(geometry);
    materials.push(material);
    group.add(mesh);
    if (!facade) continue;
    // 覆盖层不写深度、排在墙之后：`polygonOffset` 把它的每个像素往镜头方向挪一点点，否则它与墙共面，
    // 深度测试按谁先到画布判胜负，窗格就会在斜面上闪成斑马纹。
    const grid = new THREE.MeshLambertMaterial({
      color: 0xffffff, map: facade.textureFor(facade.atmosphere(), category),
      transparent: true, depthWrite: false, opacity: facade.opacityFor(15.5),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh2 = new THREE.Mesh(overlay, grid);
    mesh2.name = `building-facade-${category}`;
    mesh2.renderOrder = 1;
    mesh2.userData = { category, facade: true };
    merged.push(overlay);
    materials.push(grid);
    group.add(mesh2);
    if (!lamp) continue;
    // 亮窗层与光晕层都共用窗格那份侧壁几何，只换材质（加色、不写深度、不吃雾）。它们只在夜景里出现：
    // 白昼与日落点灯是作画错误，现版那侧同样是三层 `visibility` 门控。晕在窗之下（renderOrder 2 对 3），
    // 与现版"晕先插、灯盖在上面"的层序一致。
    if (facade.glow) {
      const halo = new THREE.Mesh(overlay, facade.glow.material);
      halo.name = `building-glow-${category}`;
      halo.renderOrder = 2;
      halo.visible = facade.atmosphere() === 'night';
      halo.userData = { category, glow: true };
      group.add(halo);
    }
    const lamps = new THREE.Mesh(overlay, lamp.material);
    lamps.name = `building-lamps-${category}`;
    lamps.renderOrder = 3;
    lamps.visible = facade.atmosphere() === 'night';
    lamps.userData = { category, lamp: true };
    group.add(lamps);
  }
  return {
    group,
    count: heights.length,
    heights,
    // 覆盖层网格数：一桶一张窗格，所以它同时是"窗纹这一层到底画了几发"的读数。
    grids: [...group.children].filter((mesh) => mesh.userData.facade).length,
    lamps: [...group.children].filter((mesh) => mesh.userData.lamp).length,
    glows: [...group.children].filter((mesh) => mesh.userData.glow).length,
    categories: [...buckets.keys()].sort(),
    // 墙色只归墙：窗格、亮窗、光晕各有自己的颜色口径（现版那侧的图案着色器也不读 `fill-extrusion-color`）。
    setPalette: (next) => {
      for (const mesh of group.children) {
        if (mesh.userData.facade || mesh.userData.lamp || mesh.userData.glow) continue;
        mesh.material.color.set(next(mesh.userData.category));
      }
    },
    // 换氛围＝换 12 张里的那一张指针 + 两层灯火的可见性，几何一个顶点都不动。
    setFacade: (atmosphereId) => {
      if (!facade) return 0;
      let swapped = 0;
      for (const mesh of group.children) {
        if (mesh.userData.facade) {
          const next = facade.textureFor(atmosphereId, mesh.userData.category);
          if (mesh.material.map !== next) { mesh.material.map = next; swapped++; }
        } else if (mesh.userData.lamp || mesh.userData.glow) {
          const wanted = atmosphereId === 'night';
          if (mesh.visible !== wanted) { mesh.visible = wanted; swapped++; }
        }
      }
      return swapped;
    },
    setFacadeOpacity: (zoom) => {
      if (!facade) return 0;
      let written = 0;
      for (const mesh of group.children) {
        if (mesh.userData.facade) {
          mesh.material.opacity = facade.opacityFor(zoom);
          written++;
        } else if (mesh.userData.lamp && facade.lamp) {
          // 同一层共用一个材质，写一次就够；跟着窗格一起写是为了让"斜坡"只有一处入口。
          mesh.material.opacity = facade.lamp.opacityFor(zoom);
        } else if (mesh.userData.glow && facade.glow) {
          mesh.material.opacity = facade.glow.opacityFor(zoom);
        }
      }
      return written;
    },
    dispose: () => {
      for (const geometry of merged) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

import * as THREE from 'three';
import { plane } from './geo.js';
import { seededRandom } from './facade.js';
import { TRAFFIC_LIFE_RADIUS, insideRadius, polyline, scatter, spaced } from './traffic-life.js';
import { createPads } from './shadow-pads.js';

// 近场的绿化不再是地面上的一块颜色。OSM 在这一公里里到底有多少树是量过的：`natural=tree` 一共 6 个点，
// `natural=tree_row` 0 条（3 公里内才有 173 个点、14 条）。所以"按真树摆"这条路在塔边是空的，能立起来的只有
// 两件事——沿实测的路中线放行道树，和在实测的绿地面里按面积放树冠。两者的位置都从矢量算出来，一个都不手摆；
// 间距、密度、树高是画的，都写成命名常量，卡片与 README 上点名。
export const VEGETATION_RADIUS = 1000;

// 只有这两级路有那种够宽的绿化带：近场实测 trunk 3,818 m、secondary 7,154 m，加起来 11 km。
export const AVENUES = ['trunk', 'secondary'];
// 从车行道中线到树线的水平距离。7.4 m 是"这条路上停满车之后剩下的那一条"，可我们的路只画成一条平色带，
// 6 m 宽的树冠压过去就把路盖住了——2026-10-09 用户说「植被树那些有点太多太乱，不符合实际」，量到的"乱"
// 有一半是这个：树站在行车道正中而不是路缘外。挪到 8.6 m 之后树线落在带子外面。
export const TREE_OFFSET_METRES = 8.6;
// 株距 10 → 14 m：10 m 是广州榕树的真实株距，但那是**一侧**；两侧各一排、又在 1 km 里铺满 14.8 km 的两级路，
// 就得到 2,967 株行道树，画面里是一条绿带而不是一排行道树。14 m 是"数得出一棵一棵"的那一档。
export const TREE_GAP_METRES = 14;
// 一棵树占多少绿地。公园是散步的树，疏；林地是一片冠，密；开放草坪最疏。
// 2026-10-09 按"广场那片是草坪不是树林"重定：park 400 → 700、grass 600 → 1200、wood 150 → 240。
// 原来的密度下 6 m 冠径的树彼此压着（量到 132 对间距 <4 m 的重复位），读出来是一块绿地毯而不是一片树。
export const GREEN_DENSITY = { park: 700, grass: 1200, wood: 240 };
// 两株树的最小间距：冠径 2 × 3 m，站得比这更近就不是两棵而是一坨。
export const TREE_MIN_SEPARATION_METRES = 5;
// 每棵树的冠径与干高都是画的：OSM 没有给这些绿地里任何一棵树的高度。
export const TRUNK_METRES = 2.6;
export const TRUNK_BOTTOM_METRES = 0.17;
export const TRUNK_TOP_METRES = 0.1;
export const TRUNK_SIDES = 6;
export const CANOPY_RADIUS_METRES = 3;
// 接地的那一片比冠小一圈：正午的树影不是冠的等高投影，而是"冠下面那一块地被遮住了"。
// 1.0 会让贴片边缘与冠边缘一样粗（看上去是地上画了一个圆），0.86 是量出来"读得出是一株树的影、又不像一个碟子"的那一档。
// 半径按**这一种的冠径**折算，不是按 `CANOPY_RADIUS_METRES`：棕榈那片影跟着榕的冠径走就成了地上画错尺寸。
export const TREE_PAD_SHARE = 0.86;
// 一株的缩放范围：一排完全等大的树是围栏，不是树林。
export const TREE_SCALE_FROM = 0.75;
export const TREE_SCALE_TO = 1.3;
// 三种剪影，不是三种颜色：一棵树读得出是什么靠的是轮廓。数全是画的（OSM 在这一公里里给的只有 6 个 `natural=tree`
// 点，没有一个带种名），比例照实物——榕是"宽过头顶的一把伞"（冠 5.3 m 宽 × 3.0 m 高，整株 4.7 m），香樟是"立起来的卵"
// （4.9 m 宽 × 5.9 m 高，整株 8.1 m），棕榈是"一根杆子顶上一圈叶"（6.2 m 的净干、4.8 m 的叶展）。
// 下面写的全是**倍数**：干那组乘 `TRUNK_METRES`/`TRUNK_*_METRES`，冠那组乘 `CANOPY_RADIUS_METRES`（`sink` 是例外，它是米），
// 所以改上面那一组常量等于整体缩放，改这里只改身形。
export const SPECIES = ['banyan', 'camphor', 'palm'];
export const SPECIES_LABEL = { banyan: '榕', camphor: '香樟', palm: '棕榈' };
export const SPECIES_SHAPE = {
  // 榕的冠是三块扁穹顶叠出来的：一棵大榕的树冠不是一个球，是一片起伏的坨（`lobeShare` 是每块占冠径的比例）。
  banyan: { trunk: { girth: 1.7, height: 0.8 }, crown: { radius: 1.15, rise: 0.5, sink: 0.4, lobes: 3, lobeShare: 0.62 } },
  camphor: { trunk: { girth: 1.05, height: 1 }, crown: { radius: 0.95, rise: 1.15, sink: 0.4 } },
  // `fronds` 片叶从杆顶放射：中段挑到最宽、叶尖收窄并垂下 `droop`（`arch`/`droop`/`width` 都乘冠径）。
  palm: { trunk: { girth: 0.42, height: 2.4 }, crown: { radius: 0.8, fronds: 9, arch: 0.14, droop: 0.45, width: 0.14 } },
};
// 每种树占多少：`roadside`/`park` 是广州街头的实际配比（榕与香樟当家，棕榈只在广场那一片多），
// `wood` 给棕榈记 0 —— 一片密冠里插一根光杆读不出来是树。
export const SPECIES_MIX = {
  roadside: { banyan: 0.5, camphor: 0.42, palm: 0.08 },
  park: { banyan: 0.34, camphor: 0.42, palm: 0.24 },
  grass: { banyan: 0.28, camphor: 0.34, palm: 0.38 },
  wood: { banyan: 0.5, camphor: 0.5, palm: 0 },
};
// 同一条路栽同一种苗，这是"行道树"读得出来的前提：一路随机换三种就是用户 2026-10-09 说的那种乱。
// 所以一条街（一块绿地）先按 `SPECIES_MIX` 定一个主种，再留这一成的补种余地。
export const SPECIES_INTERPLANT = 0.18;
// 树冠比草地暗，靠的是这一组色；夜里没有自发光，它们跟着半球光一起暗下去。
export const CANOPY_COLOURS = {
  roadside: '#4c7a43',
  park: '#456f3e',
  grass: '#5a854a',
  wood: '#2f5a35',
};
// 14.5 级以下一棵树的冠不到两个像素，那时它该是地图上那块绿，而不是一堆抖动。
export const TREE_MIN_ZOOM = 14.5;

const RING_STEP = 1e-6;

/** 射线法：一个米制点在不在这个环里。环是 [x, y]，首点不重复。 */
export function insidePolygonRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || RING_STEP) + xi) inside = !inside;
  }
  return inside;
}

/** 一个面（外环 + 若干洞）在不在里面——湖中间不该长树。 */
function insideFace(rings, x, y) {
  if (!insidePolygonRing(rings[0], x, y)) return false;
  return !rings.slice(1).some((hole) => insidePolygonRing(hole, x, y));
}

/**
 * 把一批面（水面、楼块）变成"这一点不能站树"的判定：先按外接框筛掉绝大多数，再做射线法。
 * 用户 2026-10-09 那句「太多太乱，不符合实际」里最扎眼的一条就是 220 株树长在珠江里——桥两侧的路被当成
 * 有路缘的街，于是树线跟着路跨了江。楼块同理：树长在别人家屋顶上。
 * @param {object[]} faces GeoJSON Polygon/MultiPolygon 要素
 * @param {{lng:number,lat:number}} origin 与树同一个米制原点
 */
export function faceBlocker(faces = [], origin, radius = Infinity) {
  const project = (ring) => ring.map(([lng, lat]) => {
    const { dx, dy } = plane(origin, { lng, lat });
    return [dx, dy];
  });
  // 楼块快照有 3,990 面，全投影一遍不值：先按经纬度框把整块圆外的面剔掉（1° ≈ 111 km，所以半径换成度数
  // 就是同一个框），剩下的才进米制平面。坐标嵌套按 Polygon / MultiPolygon 不同，所以一路走到叶子为止。
  const span = radius / 111000 * 1.5;
  const near = (feature) => {
    const stack = [feature.geometry?.coordinates];
    while (stack.length) {
      const node = stack.pop();
      if (!Array.isArray(node)) continue;
      if (typeof node[0] === 'number') {
        if (Math.abs(node[0] - origin.lng) <= span && Math.abs(node[1] - origin.lat) <= span) return true;
        continue;
      }
      stack.push(...node);
    }
    return false;
  };
  const polys = faces.filter((feature) => radius === Infinity || near(feature)).flatMap((feature) => (feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
    : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : []));
  const boxes = polys.map((rings) => {
    const outer = rings.map(project);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of outer[0]) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { rings: outer, minX, maxX, minY, maxY };
  });
  return (x, y) => boxes.some((box) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
    && insideFace(box.rings, x, y));
}

/**
 * 去掉挤在一起的树：冠径 6 m，两株中心距小于 `TREE_MIN_SEPARATION_METRES` 就合成一坨。
 * 按 5 m 的格子建索引，每个候选只看自己那一格与相邻八格，所以是"先来的人占位"——同一份输入顺序不变，
 * 结果一株都不差（刷新不换树，与车流、船同一条规矩）。
 */
export function thinCloseTrees(trees = [], minDistance = TREE_MIN_SEPARATION_METRES) {
  const cells = new Map();
  const kept = [];
  for (const tree of trees) {
    const cx = Math.floor(tree.x / minDistance);
    const cy = Math.floor(tree.y / minDistance);
    let crowded = false;
    for (let dx = -1; dx <= 1 && !crowded; dx += 1) {
      for (let dy = -1; dy <= 1 && !crowded; dy += 1) {
        const bucket = cells.get(`${cx + dx},${cy + dy}`);
        if (bucket?.some((other) => Math.hypot(other.x - tree.x, other.y - tree.y) < minDistance)) crowded = true;
      }
    }
    if (crowded) continue;
    const key = `${cx},${cy}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(tree);
    kept.push(tree);
  }
  return kept;
}

/**
 * 行道树：沿实测的车行道中线，两侧各偏出一个树线距离，按 jitter 过的间距一步一步放。
 *
 * 位置是"这条线的第几步"，不是坐标表里的一个点，所以路改了树跟着改；`seed` 带着 osmId，同一条路刷新还是同一批树。
 */
export function avenueTrees(features = [], origin, radius = VEGETATION_RADIUS, classes = AVENUES) {
  const trees = [];
  for (const feature of features) {
    const kind = feature.properties?.class;
    if (!classes.includes(kind)) continue;
    // 从桥下穿过去的路上没有街面，也没有树池。
    if (feature.properties?.brunnel === 'tunnel') continue;
    // 桥上同样没有：那一段路在江中心，两侧是水。用户 2026-10-09 截图里"树长在珠江里"就是这一条——
    // 路被桥带着跨江，树线跟着路两侧各排一排，量到 220 株落在水面多边形里。
    if (feature.properties?.brunnel === 'bridge' || Number(feature.properties?.layer) >= 1) continue;
    const lines = feature.geometry?.type === 'LineString' ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    const seed = (Number(feature.properties.osmId) || 0) * 4093;
    for (const ring of lines) {
      for (const piece of insideRadius(ring, origin, radius)) {
        const line = polyline(piece);
        for (let distance = 0, step = 0; distance + 2 < line.length; step += 1) {
          for (const side of [-1, 1]) {
            const place = line.at(distance);
            const x = place.x + place.side.x * TREE_OFFSET_METRES * side;
            const y = place.y + place.side.y * TREE_OFFSET_METRES * side;
            // 中线被圆裁过，树线却可能探到圆外去：那一侧的树站在那公里之外，是这一组东西不该有的越界。
            if (Math.hypot(x, y) > radius) continue;
            trees.push({ x, y, kind: 'roadside', patch: seed, seed: seed + step * 2 + (side > 0 ? 1 : 0) });
          }
          distance += spaced(TREE_GAP_METRES, seed + step);
        }
      }
    }
  }
  return trees;
}

/**
 * 绿地里的树冠：按面的面积算出该有几株，再用固定种子在面的外接矩形里抽，抽到落在面内为止。
 *
 * 这是"撒"不是"摆"：株数由 `area / GREEN_DENSITY[kind]` 决定，位置由 osmId 决定的种子序列决定，
 * 洞（湖、广场铺装）会被拒掉，圆外的也会被拒掉——所以同一份快照重跑一次，一株都不会挪。
 */
export function canopyTrees(features = [], origin, radius = VEGETATION_RADIUS, density = GREEN_DENSITY, avoid = [], blocked = null) {
  const trees = [];
  for (const feature of features) {
    const kind = feature.properties?.kind;
    const perTree = density[kind];
    if (!perTree) continue;
    const polygons = feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
    const seed = (Number(feature.properties.osmId) || 0) * 8191 + 17;
    for (const rings of polygons) {
      const local = rings.map((ring) => ring.slice(0, ring[0][0] === ring.at(-1)[0] && ring.length > 1 ? -1 : undefined)
        .map(([lng, lat]) => plane(origin, { lng, lat })));
      const outer = local[0].map((point) => ({ x: point.dx, y: point.dy }));
      const box = outer.reduce((sum, point) => ({
        minX: Math.min(sum.minX, point.x), maxX: Math.max(sum.maxX, point.x),
        minY: Math.min(sum.minY, point.y), maxY: Math.max(sum.maxY, point.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
      const area = Math.abs(outer.reduce((sum, point, index) => {
        const next = outer[(index + 1) % outer.length];
        return sum + point.x * next.y - next.x * point.y;
      }, 0) / 2);
      const wanted = Math.max(1, Math.round(area / perTree));
      const rings2 = local.map((ring) => ring.map((point) => [point.dx, point.dy]));
      const next = seededRandom(seed);
      let placed = 0;
      // 公园与草坪是**栽**出来的，不是长出来的：同一份密度换算成格距，一株一颗地按格子放，
      // 只加 ±12% 的抖动免得成了棋盘。林地（wood）反过来——那本来就该是一片不规则的冠。
      const grid = kind === 'wood' ? 0 : Math.sqrt(perTree);
      const offX = grid ? next() * grid : 0;
      const offY = grid ? next() * grid : 0;
      const accept = (x, y) => {
        if (Math.hypot(x, y) > radius) return false;
        if (!insideFace(rings2, x, y)) return false;
        // 石板中轴上不长树：一块硬质面（或一条扫出来的步行带）盖住的地方，这一株要退让。
        if (avoid.some((ring) => insidePolygonRing(ring, x, y))) return false;
        // 水面与楼块：绿地面自己不会盖到江里，但一块 `leisure=park` 可以贴着河岸把树送进水里。
        return !blocked?.(x, y);
      };
      if (grid) {
        for (let gx = box.minX + offX; gx <= box.maxX && placed < wanted; gx += grid) {
          for (let gy = box.minY + offY; gy <= box.maxY && placed < wanted; gy += grid) {
            const x = gx + (next() - 0.5) * grid * 0.24;
            const y = gy + (next() - 0.5) * grid * 0.24;
            if (!accept(x, y)) continue;
            trees.push({ x, y, kind, patch: seed, seed: seed + placed, row: true });
            placed += 1;
          }
        }
      }
      // 格子填不满就补抽：一块长条形绿地里格点大多落在面外，只按格子放会凭空少掉几百株，
      // 而株数是密度算出来的、不该被排布方式改掉。先成行，再补齐。
      // 抽到一半还填不上就是这块面太碎（长条、或被洞占满），此时宁可少几株也不让一次构建转不完。
      for (let attempt = 0; attempt < wanted * 40 && placed < wanted; attempt += 1) {
        const x = box.minX + next() * (box.maxX - box.minX);
        const y = box.minY + next() * (box.maxY - box.minY);
        if (!accept(x, y)) continue;
        trees.push({ x, y, kind, patch: seed, seed: seed + placed });
        placed += 1;
      }
    }
  }
  return trees;
}

/** 这一批绿地与路，一共该立起多少株：给测试与面板用的两个名单。 */
export function treePlaces({ streets = [], greens = [], origin, radius = VEGETATION_RADIUS, avoid = [], water = [], buildings = [] } = {}) {
  // 让位名单进来时是经纬度（它就是从 GeoJSON 里拿的），树的位置算在米制平面上，所以先搬到同一个坐标系。
  const avoidRings = avoid.map((ring) => ring.map(([lng, lat]) => {
    const { dx, dy } = plane(origin, { lng, lat });
    return [dx, dy];
  }));
  const blocked = water.length || buildings.length ? faceBlocker([...water, ...buildings], origin, radius) : null;
  const roadside = avenueTrees(streets, origin, radius).filter((tree) => !blocked?.(tree.x, tree.y));
  const canopy = canopyTrees(greens, origin, radius, GREEN_DENSITY, avoidRings, blocked);
  // 去重按"行道树先占位"的顺序走：那一排是城里真栽下去的，公园里的散株才是让位的一方。
  const kept = new Set(thinCloseTrees([...roadside, ...canopy]));
  return {
    roadside: roadside.filter((tree) => kept.has(tree)),
    canopy: canopy.filter((tree) => kept.has(tree)),
  };
}

/** 按名单抽签：`value` 是 [0,1) 的一个数。名单的和不必正好是 1——`wood` 那格棕榈记 0，就永远抽不到棕榈。 */
function pickSpecies(mix, value) {
  const total = SPECIES.reduce((sum, name) => sum + (mix[name] ?? 0), 0);
  let acc = 0;
  for (const name of SPECIES) {
    acc += mix[name] ?? 0;
    if (value * total < acc) return name;
  }
  return SPECIES.reduce((best, name) => ((mix[name] ?? 0) > (mix[best] ?? 0) ? name : best), SPECIES[0]);
}

/**
 * 这一株算哪一棵：先看它属于哪一条街（或哪一块绿地），那条路按 `SPECIES_MIX` 定一个主种；
 * 再留 `SPECIES_INTERPLANT` 的余地补一株别种——现实里同一条路栽的是同一种苗，一路随机换三种就是"乱"。
 * 用的数是树身上带的 `patch`（osmId 派生），所以刷新一次页面一株都不会换种。
 */
export function speciesOf(tree) {
  const mix = SPECIES_MIX[tree.kind] ?? SPECIES_MIX.park;
  const base = pickSpecies(mix, scatter((tree.patch ?? tree.seed) * 3 + 11));
  if (scatter(tree.seed + 7331) >= SPECIES_INTERPLANT) return base;
  return pickSpecies(mix, scatter(tree.seed + 443));
}

/** 一株树的干：底坐在地上，顶在 `TRUNK_METRES × 该种的干高倍数`，粗细走同一个倍数（棕榈要的正是又细又高）。 */
export function trunkGeometry(species) {
  const { girth, height } = SPECIES_SHAPE[species].trunk;
  const metres = TRUNK_METRES * height;
  const geometry = new THREE.CylinderGeometry(TRUNK_TOP_METRES * girth, TRUNK_BOTTOM_METRES * girth, metres, TRUNK_SIDES, 1, true);
  geometry.translate(0, metres / 2, 0);
  return geometry;
}

/**
 * 一株树的冠：榕是压扁的穹顶，香樟是立起来的卵，棕榈是从杆顶放射出去的一圈叶。
 * 身形全写在几何里、不写在实例的 scale 里，所以一株放大 1.3 倍还是它自己那一类。
 */
export function crownGeometry(species) {
  const { trunk, crown } = SPECIES_SHAPE[species];
  const top = TRUNK_METRES * trunk.height;
  // `sink` 说的是"冠的下沿比干顶低这几米"，所以整体定位按几何自己的最低点算：二十面体的最低顶点不在赤道面上，
  // 拿半径当半高会让香樟那顶卵悬在干顶上面一毫米，放大镜头就是一条缝。
  const floor = top - crown.sink;
  if (!crown.rise) return frondGeometry(top, crown);
  const radius = CANOPY_RADIUS_METRES * crown.radius;
  const rise = CANOPY_RADIUS_METRES * crown.rise;
  if (!crown.lobes) return crownBuffer([domeVertices(radius, rise)], floor);
  // 榕：三块扁穹顶一圈叠开，一大两小、一高一低——三个一模一样的球拼出来的是分子模型，不是一棵树。
  const lobe = radius * crown.lobeShare;
  const ring = radius - lobe;
  const parts = [];
  for (let index = 0; index < crown.lobes; index += 1) {
    const size = 1 - 0.16 * (index % 3);
    const angle = (index / crown.lobes) * Math.PI * 2;
    const vertices = domeVertices(lobe * size, rise * size);
    const dx = Math.cos(angle) * ring;
    const dz = Math.sin(angle) * ring;
    const dy = rise * 0.28 * ((index % 3) - 1);
    const shifted = new Float32Array(vertices.length);
    for (let i = 0; i < vertices.length; i += 3) {
      shifted[i] = vertices[i] + dx;
      shifted[i + 1] = vertices[i + 1] + dy;
      shifted[i + 2] = vertices[i + 2] + dz;
    }
    parts.push(shifted);
  }
  return crownBuffer(parts, floor);
}

/**
 * 一顶扁穹顶的顶点，球心在原点。
 * `PolyhedronGeometry` already writes one triangle per face with its own vertices, so the hard edges are there
 * before any normal is computed - and calling `toNonIndexed()` on it is a console warning on every page load.
 */
function domeVertices(radius, rise) {
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  geometry.scale(radius, rise, radius);
  return geometry.getAttribute('position').array;
}

/** 若干组顶点合成一份非索引几何，并整体抬到"最低点落在 `floor`"。 */
function crownBuffer(parts, floor) {
  let low = Infinity;
  for (const part of parts) {
    for (let i = 1; i < part.length; i += 3) low = Math.min(low, part[i]);
  }
  const positions = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 3, at += 3) {
      positions[at] = part[i];
      positions[at + 1] = part[i + 1] - low + floor;
      positions[at + 2] = part[i + 2];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 棕榈的那一圈叶：`fronds` 片从杆顶放射，三段宽（根部收在轴上、中段最宽、叶尖收窄），先往上挑再垂下来。 */
function frondGeometry(top, { radius, fronds, arch, droop, width }) {
  const span = CANOPY_RADIUS_METRES * radius;
  const spine = [
    // 根部收在杆顶那一点上（不留缝，否则放大看得见一圈悬空的叶），中段挑起来最宽，叶尖收窄并垂下去。
    { at: 0, y: top, half: 0.02 },
    { at: 0.5, y: top + span * arch, half: width },
    { at: 1, y: top - span * droop, half: width * 0.3 },
  ];
  const positions = [];
  for (let index = 0; index < fronds; index += 1) {
    const angle = (index / fronds) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const edge = spine.map((point) => {
      const along = span * point.at;
      const across = span * point.half;
      return [
        [dx * along - dz * across, point.y, dz * along + dx * across],
        [dx * along + dz * across, point.y, dz * along - dx * across],
      ];
    });
    for (let i = 0; i + 1 < edge.length; i += 1) {
      const [a0, a1] = edge[i];
      const [b0, b1] = edge[i + 1];
      positions.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * 近场的树：三种各一份干、各一份冠，加一片共用的接地影——七个 draw call，全部走实例。
 *
 * 树不动，所以没有每帧更新的矩阵：全部变换在装配时写一次，之后只有镜头门控会碰它。
 * 分种是按株切成三份名单，每具网格自己连续，而影子那一份仍按全场顺序走，所以第 n 片影就在第 n 号树脚下。
 */
export function createVegetation({ streets = [], greens = [], origin, radius = VEGETATION_RADIUS, avoid = [], water = [], buildings = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'vegetation';
  const places = treePlaces({ streets, greens, origin, radius, avoid, water, buildings });
  const trees = [...places.roadside, ...places.canopy];
  const planted = trees.map((tree) => speciesOf(tree));
  const sizes = trees.map((tree) => TREE_SCALE_FROM + (TREE_SCALE_TO - TREE_SCALE_FROM) * scatter(tree.seed + 31));
  // 每一种的名单存的是"这一株在全场里排第几"，所以冠与影用的是同一个数出来的位置，不会两种树抢一个槽位。
  const slots = SPECIES.map((species) => ({ species, indices: planted.reduce((all, name, index) => (name === species ? [...all, index] : all), []) }));
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 0.94, metalness: 0 });
  const crownMaterial = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0 });
  // 棕榈的叶是单面薄片：反面不画的话，一半叶子按镜头方向转过去就没了。
  const frondMaterial = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  // 树底下那一片：树冠比草地暗是一回事，"这一株确实压在地面上"是另一回事——没有它，两千顶冠就是贴在绿毯上的浮片。
  // 挂在 `vegetation` 这一组里，所以 14.5 级那道镜头门控与高度透视镜的开关自动带着它走，不必再写第二个判断。
  const pads = createPads({ name: 'vegetation-pads', count: trees.length });
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const colour = new THREE.Color();
  const bodies = [];
  const bySpecies = {};
  const speciesByKind = {};
  for (const slot of slots) {
    const trunks = new THREE.InstancedMesh(trunkGeometry(slot.species), trunkMaterial, Math.max(1, slot.indices.length));
    trunks.name = `vegetation-${slot.species}-trunks`;
    const crowns = new THREE.InstancedMesh(crownGeometry(slot.species), slot.species === 'palm' ? frondMaterial : crownMaterial, Math.max(1, slot.indices.length));
    crowns.name = `vegetation-${slot.species}-crowns`;
    for (const mesh of [trunks, crowns]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.count = slot.indices.length;
      group.add(mesh);
    }
    bySpecies[slot.species] = slot.indices.length;
    slot.indices.forEach((index, local) => {
      const tree = trees[index];
      position.set(tree.x, 0, -tree.y);
      // 绕自己转一下再放：同一颗二十面体在一条街上看几百次，转个角度就不像了。
      spin.setFromAxisAngle(up, scatter(tree.seed + 977) * Math.PI * 2);
      scale.setScalar(sizes[index]);
      matrix.compose(position, spin, scale);
      trunks.setMatrixAt(local, matrix);
      crowns.setMatrixAt(local, matrix);
      crowns.setColorAt(local, colour.set(CANOPY_COLOURS[tree.kind] ?? CANOPY_COLOURS.park));
      const row = speciesByKind[tree.kind] ?? (speciesByKind[tree.kind] = {});
      row[slot.species] = (row[slot.species] ?? 0) + 1;
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    bodies.push({ trunks, crowns });
  }
  pads.mesh.frustumCulled = false;
  pads.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  group.add(pads.mesh);
  trees.forEach((tree, index) => {
    // 影子比冠小一圈，但**这一种的**冠小一圈：榕 3.45 m、香樟 2.85 m、棕榈 2.4 m。
    const radius = CANOPY_RADIUS_METRES * SPECIES_SHAPE[planted[index]].crown.radius * sizes[index] * TREE_PAD_SHARE;
    pads.place({ x: tree.x, y: tree.y, radiusX: radius, radiusY: radius });
  });
  pads.finish();
  let shown = true;
  let zoom = null;
  const apply = () => { group.visible = shown && (zoom === null || zoom >= TREE_MIN_ZOOM); };
  return {
    group,
    report: {
      trees: trees.length,
      roadside: places.roadside.length,
      canopy: places.canopy.length,
      byKind: places.canopy.reduce((counts, tree) => ({ ...counts, [tree.kind]: (counts[tree.kind] ?? 0) + 1 }), {}),
      bySpecies,
      speciesByKind,
      radius,
    },
    /** 镜头门控：拉远到一棵树不到两个像素时，把这一整组收掉，交回地图上那块绿。 */
    setZoom(next) {
      if (zoom !== null && Math.abs(next - zoom) < 0.02) return false;
      zoom = next;
      apply();
      return true;
    },
    /** 高度透视镜与动效开关用：那是数据视图，不是一座花园。 */
    setVegetation(on) {
      if (shown === on) return false;
      shown = on;
      apply();
      return true;
    },
    visible: () => group.visible,
    dispose() {
      for (const body of bodies) {
        body.trunks.geometry.dispose();
        body.crowns.geometry.dispose();
      }
      trunkMaterial.dispose();
      crownMaterial.dispose();
      frondMaterial.dispose();
      pads.dispose();
      group.clear();
    },
  };
}

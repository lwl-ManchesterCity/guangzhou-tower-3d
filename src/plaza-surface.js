import * as THREE from 'three';
import { plane } from './geo.js';

// 花城广场的四层颜色是实测面（`plaza.js` 从 OSM 裁出来的草坪／水面／硬质面／步行带），但它们现在是四块**平色**。
// 平色在 15.7 级读起来就是几张彩纸：广场真正有的那些"建出来的边"——石材的分格缝、草坪与石板之间那道收边、
// 水线——一个都没有。这一格把塔的立面图那套办法搬到地面上：一张**以广场自己的米数为坐标、不重复**的乘性贴图，
// 缝在哪、边在哪，全从实测面的边界算，不靠手摆。
//
// 一个像素多少米。0.5 m 与塔的立面图同一档：广场的包围盒量出来是 1,552 m × 321 m，0.5 m 就是 3,104 × 642 px
// （两百万格），还能整张交给 GPU；再细一档到 0.25 m 就是八百万格，而 15.7 级一屏像素本来就有 1.6~2 m，多出来的
// 那两倍分辨率在验收机位上落不到像素上。
export const PLAZA_PIXEL_METRES = 0.5;
// 一格石材多大。OSM 在这里没有任何铺装信息，所以这个数是画的。第一版照真实砖缝取 1.2 m，结果画了等于没画：
// 17 级一屏像素约 1 m，一条 1.2 m 的缝就是 1 格，被线性过滤平均成一层灰；量到能读出来的最小档是 6 m 一条，
// 那正好是这种大广场按色带分铺的板块宽度。缝宽本身仍是 0.5 m 一档（一格像素）。
export const PAVING_JOINT_METRES = 6;
// 收边与水线多宽，同样是画的。收边取两米：一块草坪被花岗岩围着，那条"围"在实景里就是一圈边框石，
// 而 0.6 m 那种真收边在 15.7 级连一个像素都占不到——画了等于没画。
export const KERB_METRES = 2;
export const WATER_EDGE_METRES = 1.5;
// 乘性贴图只有"压暗"这一种笔：混合方式是 `MultiplyBlending`，一张 8 位贴图最大就是 1.0，乘不出比原样更亮的像素。
// 所以"收边比周围亮"是靠把**石材本体**压到 0.9、让收边那一圈保持 1.0 读出来的，不是写了个大于 1 的数。
export const STONE_FIELD_SHADE = 0.9;
export const JOINT_SHADE = 0.66;
// 收边在两边都要看得见，而乘性贴图只会压暗、不会提亮，所以它分两笔：石材那一侧"不压暗"（本体已经被压到 0.9，
// 保持 1.0 就是一条亮边），草坪那一侧压一道 0.86 的边线（那是边框石压在草皮上的那道阴影）。
export const KERB_SHADE = 1;
export const BORDER_SHADE = 0.86;
export const WATER_EDGE_SHADE = 0.72;
// 什么时候开始画这张图。第一档定在 15 级，结果两头不讨好：15.4 的默认机位一屏像素约 1.6 m，缝与收边都落不到像素
// 上（量出来是 1.7 % 的石材被压暗，画了等于没画），而它作为一个整块透明面参与排序，把逐字节回帧那条判据弄红了
// ——出厂帧与停下动效那一帧之间它翻了一次面。所以这一档钉在"细节真的落得下像素"的 16.5 级（一屏约 0.8 m，
// 6 m 一条缝是 7 格、2 m 收边是 2.5 格），并且离场景里任何一个常用机位都远，不会在边界上抖。
export const PLAZA_SURFACE_MIN_ZOOM = 16.5;

const open = (ring) => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
  ? ring.slice(0, -1) : ring);

/** 一条环换算到"以广场西南角为原点"的米制坐标。 */
function toMetres(ring, origin, west, south) {
  return open(ring).map(([lng, lat]) => {
    const { dx, dy } = plane(origin, { lng, lat });
    return { x: dx - west, y: dy - south };
  });
}

/**
 * 把若干条米制环填进一张类别缓冲：逐行求交、按奇偶配对。
 *
 * 为什么不逐点判在不在面里：那要给两百万个像素各跑一遍三十块面；按行扫描只在每块面自己的包围盒里走，
 * 实测这些面加起来不到二十万格。`higher` 是给层序用的——石材要能盖在草坪之上，和 `plazaLayers` 那四层一致。
 */
function rasterise(classMap, wide, tall, rings, value, higher) {
  for (const ring of rings) {
    const left = Math.max(0, Math.floor(Math.min(...ring.map((p) => p.x)) / PLAZA_PIXEL_METRES));
    const right = Math.min(wide - 1, Math.ceil(Math.max(...ring.map((p) => p.x)) / PLAZA_PIXEL_METRES));
    const low = Math.max(0, Math.floor(Math.min(...ring.map((p) => p.y)) / PLAZA_PIXEL_METRES));
    const high = Math.min(tall - 1, Math.ceil(Math.max(...ring.map((p) => p.y)) / PLAZA_PIXEL_METRES));
    for (let row = low; row <= high; row += 1) {
      const at = (row + 0.5) * PLAZA_PIXEL_METRES;
      const crossings = [];
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if ((a.y > at) === (b.y > at)) continue;
        crossings.push(a.x + ((at - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      if (!crossings.length) continue;
      crossings.sort((m, n) => m - n);
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const from = Math.max(left, Math.floor(crossings[pair] / PLAZA_PIXEL_METRES));
        const to = Math.min(right, Math.ceil(crossings[pair + 1] / PLAZA_PIXEL_METRES));
        for (let column = from; column <= to; column += 1) {
          const index = row * wide + column;
          if (!higher || classMap[index] < value) classMap[index] = value;
        }
      }
    }
  }
}

/** 这一格的类别在 `step` 像素之外是不是变了——变了就说明这里有一条建出来的边。 */
function neighbourChanges(classMap, wide, tall, row, column, step) {
  const own = classMap[row * wide + column];
  for (const [dr, dc] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
    const r = row + dr;
    const c = column + dc;
    if (r < 0 || c < 0 || r >= tall || c >= wide) continue;
    if (classMap[r * wide + c] !== own) return true;
  }
  return false;
}

/** 落在间距为 `step` 的那组线上吗（横竖各一组，缝宽一格）。 */
const onJoint = (index, step) => index % step < 1;

/**
 * 广场地面那张不重复的乘性贴图，加上铺它的那块网格。
 *
 * uv 用"离广场西南角多少米"，所以 1.2 m 一道缝就是每 2.4 格一道缝——与塔壳那条"v 是标高米数"是同一套约定。
 * 没被任何实测面占到的地方保持 1.0，等于对底图那一处原样不加改变。
 *
 * @param {object} options
 * @param {number[][]} options.ring 广场外轮廓（经纬度），网格就铺这一圈
 * @param {object[]} options.features `carvePlaza` 的结果，`properties.kind` 是 lawn／pool／stone／walk
 * @param {number[]} options.origin 场景原点
 */
export function plazaSurface({ ring, features = [], origin }) {
  const points = open(ring).map(([lng, lat]) => plane(origin, { lng, lat }));
  const west = Math.min(...points.map((p) => p.dx));
  const south = Math.min(...points.map((p) => p.dy));
  const wide = Math.max(8, Math.round((Math.max(...points.map((p) => p.dx)) - west) / PLAZA_PIXEL_METRES));
  const tall = Math.max(8, Math.round((Math.max(...points.map((p) => p.dy)) - south) / PLAZA_PIXEL_METRES));
  // 0 是"广场里但没分类"，往上依次是草坪、水面、石材、步行带——后画的盖在前面那层上。
  const order = { lawn: 1, pool: 2, stone: 3, walk: 4 };
  const classMap = new Uint8Array(wide * tall);
  const byClass = new Map();
  for (const feature of features) {
    const value = order[feature.properties?.kind];
    const outer = feature.geometry?.coordinates?.[0];
    if (!value || !outer || outer.length < 4) continue;
    if (!byClass.has(value)) byClass.set(value, []);
    byClass.get(value).push(toMetres(outer, origin, west, south));
  }
  for (const value of [...byClass.keys()].sort((a, b) => a - b)) {
    rasterise(classMap, wide, tall, byClass.get(value), value, true);
  }

  const kerbStep = Math.max(1, Math.round(KERB_METRES / PLAZA_PIXEL_METRES));
  const edgeStep = Math.max(1, Math.round(WATER_EDGE_METRES / PLAZA_PIXEL_METRES));
  const jointStep = Math.max(1, Math.round(PAVING_JOINT_METRES / PLAZA_PIXEL_METRES));
  const data = new Uint8Array(wide * tall * 4);
  const counts = { joint: 0, kerb: 0, edge: 0, stone: 0, lawn: 0, pool: 0 };
  for (let row = 0; row < tall; row += 1) {
    for (let column = 0; column < wide; column += 1) {
      const kind = classMap[row * wide + column];
      let value = 1;
      if (kind >= 3) {
        value = STONE_FIELD_SHADE;
        counts.stone += 1;
        if (onJoint(column, jointStep) || onJoint(row, jointStep)) {
          value = JOINT_SHADE;
          counts.joint += 1;
        }
      } else if (kind === 1) counts.lawn += 1;
      else if (kind === 2) counts.pool += 1;
      if (kind && neighbourChanges(classMap, wide, tall, row, column, kind === 2 ? edgeStep : kerbStep)) {
        // 三笔各有各的方向：水边往里压暗，石材边保持不动（于是它比被压过的本体亮），草坪边压一道线。
        value = kind === 2 ? WATER_EDGE_SHADE : (kind === 1 ? BORDER_SHADE : KERB_SHADE);
        counts[kind === 2 ? 'edge' : 'kerb'] += 1;
      }
      const byte = Math.round(255 * Math.min(1, Math.max(0.4, value)));
      const index = (row * wide + column) * 4;
      data[index] = byte;
      data[index + 1] = byte;
      data[index + 2] = byte;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, wide, tall, THREE.RGBAFormat);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  // 乘数，不是颜色：颜色仍由底图那四层与氛围表决定，这张图只把"缝、边、水线"压上去。
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  const positions = new Float32Array(points.length * 3);
  const uvs = new Float32Array(points.length * 2);
  points.forEach((point, index) => {
    positions[index * 3] = point.dx - west;
    positions[index * 3 + 1] = 0;
    positions[index * 3 + 2] = -(point.dy - south);
    uvs[index * 2] = Math.min(1, (point.dx - west) / (wide * PLAZA_PIXEL_METRES));
    uvs[index * 2 + 1] = Math.min(1, (point.dy - south) / (tall * PLAZA_PIXEL_METRES));
  });
  const flat = points.map((point) => new THREE.Vector2(point.dx - west, -(point.dy - south)));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(THREE.ShapeUtils.triangulateShape(flat, []).flat());
  geometry.computeVertexNormals();
  return { texture, geometry, wide, tall, counts,
    metres: { west, south, wide: wide * PLAZA_PIXEL_METRES, tall: tall * PLAZA_PIXEL_METRES } };
}

/**
 * 把那张图铺成一块地面网格。
 *
 * 材质是 `MeshBasicMaterial` 而不是 Standard：这块东西要的是"把缝和边压到底图颜色上"，不该再被场景的灯打一次；
 * `MultiplyBlending` 让它乘在已经画好的底图之上，所以 1.0 的那一片完全不改变原样，只有缝、边、水线会动颜色。
 * `depthWrite: false` 与 `renderOrder: -1` 是配套的：它站在地面上，但不参与遮挡树、车和人。
 */
export function plazaSurfaceMesh(surface) {
  const material = new THREE.MeshBasicMaterial({
    map: surface.texture, transparent: true, depthWrite: false,
    blending: THREE.MultiplyBlending, side: THREE.DoubleSide,
    // three 明确要求：`MultiplyBlending` 得配预乘 alpha，否则它在状态里报一条错并把这块东西画错——而这条报错会
    // 撞在浏览器判据那句"控制台零错误零警告"上。
    premultipliedAlpha: true,
  });
  const mesh = new THREE.Mesh(surface.geometry, material);
  mesh.name = 'canton-plaza-surface';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  // 顶点量的是"离广场西南角多少米"，所以这块网格要自己搬回场景那一格：塔的米制坐标原点在广州塔脚下。
  mesh.position.set(surface.metres.west, 0, -surface.metres.south);
  return mesh;
}

// 江面上的船：与近场车流同一套做法——路线是数据里量出来的，位置是确定的，动效骑同一个 120 ms 一拍。
//
// 为什么不是"手放几颗点"：OSM 在这一带没有 `route=ferry`、也没有码头要素（`data/canton-waterways-overpass.json`
// 里只有 river/canal/stream 三类），所以能拿的只有珠江自己的中心线（`public/data/canton-river.geojson`，
// way/51813974 等三条，顶点是实测的）。船沿中心线走 = 航线跟着真河道，包括转弯与江心洲的分汊。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { insideRadius, polyline, scatter, spaced, agentPosition } from './traffic-life.js';
import { plane } from './geo.js';

// 船的可见度决定半径：2.2 km 外一条 46 m 的船只剩几个像素，与其画一颗噪点，不如让江面在那一段空着。
export const BOAT_LIFE_RADIUS = 2200;
// 珠江上的水上巴士与夜游船实测航速在 8~11 km/h，取中间值。
export const BOAT_SPEED_METRES_PER_SECOND = 2.6;
export const BOAT_SPEED_JITTER = 0.35;
// 间隔：真实珠江不是客运高峰期，一条航道上一段只走一两艘。
export const BOAT_GAP_METRES = 420;
export const BOAT_GAP_JITTER = 0.45;
// 短于这个长度的分汊不放船：转个弯就出画的船读起来是噪声。
export const BOAT_MIN_METRES = 300;
// 横向游移的上限：完全压在中心线上会显得像轨道（±12 m 时 18 条船在 16.2 级排成一条直线，截图量到的）。
// 但珠江这一带两条航道不一般宽：主航道（塔前面那条）容得下 ±90 m 不出水，二沙岛北支 ±20 m 就擦岸。
// 所以这是一个**上限**，每条船实际拿到的数由 `shoreMask` 沿着它自己那一段航道夹到岸线之内。
export const BOAT_WANDER_METRES = 55;
export const HULL_LENGTH_METRES = 46;
// 船头那一段菱形占的纵向长度：船身盒子只有 `HULL_LENGTH_METRES - PROW_METRES`，两者加起来才是 46 m。
export const PROW_METRES = 3.4;
export const HULL_WIDTH_METRES = 9;
export const HULL_HEIGHT_METRES = 4.2;
export const DECK_HEIGHT_METRES = 3.2;
// 吃水：船体下沿压到水面以下一点，否则船会像浮在贴图上面的盒子。
export const BOAT_DRAFT_METRES = 1.1;
export const HULL_COLOUR = '#3a4048';
export const SUPERSTRUCTURE_COLOUR = '#dfe3df';
// 夜游船在江面上最好认的就是那一圈窗带的暖光，和桅顶那颗白灯。
export const BOAT_LIGHT_COLOUR = '#ffd9a0';
export const BOAT_MAST_METRES = 6.4;

const wrapped = (value, length) => ((value % length) + length) % length;
/**
 * 把一条船的横向游移夹到岸线之内：从想要的那一档开始按 1、0.8、0.6、0.45、0.3、0.15、0 逐档往下退，
 * 取第一个"整段航道都还在水里"的数。沿航道每 20 m 取一个点——只量中点会漏掉转弯处那几十米的卡口。
 */
function fitShore(line, offset, inWater) {
  if (!inWater || !offset) return offset;
  // 每 20 m 采一个点：按"固定 15 个点"量会漏掉窄汊里那一处几十米宽的卡口（实测二沙岛北支在 15 点档上
  // 仍有 8 个采样点擦岸，40 m 档还剩 2 个），20 m 档 0 个。整批 18 条船夹一遍实测 21 ms，是一次开页成本。
  const steps = Math.max(8, Math.ceil(line.length / 20));
  const samples = Array.from({ length: steps }, (_, index) => line.at((line.length * (index + 0.5)) / steps));
  for (const share of [1, 0.8, 0.6, 0.45, 0.3, 0.15, 0]) {
    const at = offset * share;
    if (samples.every((place) => inWater(place.x + place.side.x * at, place.y + place.side.y * at))) return at;
  }
  return 0;
}

const box = (width, height, depth, x, y, z) => {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(x, y, z);
  return geometry;
};

/**
 * 船体：一层船身 + 两层上层建筑 + 一根桅 + 一个切出来的船头，合成一份几何，所以一条船是一个实例、一次矩阵更新。
 * 高度从水面往上算：船身压下去 BOAT_DRAFT_METRES，甲板与桥楼叠在吃水线之上。
 * **艏向约定**：长轴走 z，**船头在 +z**（`place()` 里让 +z 对着前进方向）。上层建筑与桅放在 −z 那端（船尾），
 * 否则 46 m 的方盒子在 40 px 里根本分不出头尾。
 */
export function boatGeometry() {
  // 船身往后挪半个船头，好让"船身 + 船头"整体仍然是 46 m：`HULL_LENGTH_METRES` 说的是船的总长。
  const hullBack = -PROW_METRES / 2;
  const parts = [
    box(HULL_WIDTH_METRES, HULL_HEIGHT_METRES, HULL_LENGTH_METRES - PROW_METRES, 0, HULL_HEIGHT_METRES / 2 - BOAT_DRAFT_METRES, hullBack),
    box(HULL_WIDTH_METRES * 0.82, DECK_HEIGHT_METRES, (HULL_LENGTH_METRES - PROW_METRES) * 0.78, 0, HULL_HEIGHT_METRES - BOAT_DRAFT_METRES + DECK_HEIGHT_METRES / 2, hullBack + HULL_LENGTH_METRES * 0.04),
    box(HULL_WIDTH_METRES * 0.58, DECK_HEIGHT_METRES * 0.82, (HULL_LENGTH_METRES - PROW_METRES) * 0.42, 0, HULL_HEIGHT_METRES - BOAT_DRAFT_METRES + DECK_HEIGHT_METRES * 1.4, hullBack - HULL_LENGTH_METRES * 0.14),
    box(0.7, BOAT_MAST_METRES, 0.7, 0, HULL_HEIGHT_METRES - BOAT_DRAFT_METRES + DECK_HEIGHT_METRES * 2.1, hullBack - HULL_LENGTH_METRES * 0.16),
  ];
  // 船头：五边形棱柱（两肩直角、尖端收在正中），从船身前端一直补到 46 m 的那条线。方盒子在 40 px 里
  // 分不出头尾，光把长轴转正还不够——用户那句「怎么横着移动」里有一半是"看不出这条船往哪儿走"。
  const prowHeight = HULL_HEIGHT_METRES * 0.74;
  const prowShape = new THREE.Shape();
  prowShape.moveTo(-HULL_WIDTH_METRES / 2, 0);
  prowShape.lineTo(-HULL_WIDTH_METRES / 2, PROW_METRES * 0.45);
  prowShape.lineTo(0, PROW_METRES);
  prowShape.lineTo(HULL_WIDTH_METRES / 2, PROW_METRES * 0.45);
  prowShape.lineTo(HULL_WIDTH_METRES / 2, 0);
  prowShape.closePath();
  const prow = new THREE.ExtrudeGeometry(prowShape, { depth: prowHeight, bevelEnabled: false, curveSegments: 1 });
  prow.rotateX(Math.PI / 2);   // 形状的 y（往前）→ 几何的 +z；挤出方向（+z）→ 向下的 −y
  prow.translate(0, prowHeight - BOAT_DRAFT_METRES, hullBack + (HULL_LENGTH_METRES - PROW_METRES) / 2);
  // `ExtrudeGeometry` 写出来的本来就是非索引几何，再调一次 `toNonIndexed()` 会在每次开页喊一嗓子
  // （THREE 的那条警告会被判据当成 console 报错，整套跟着连带红），所以这里直接推进去，
  // 索引→非索引的转换交给下面那一次 `flat`。
  parts.push(prow);
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  const colours = [HULL_COLOUR, SUPERSTRUCTURE_COLOUR, SUPERSTRUCTURE_COLOUR, SUPERSTRUCTURE_COLOUR, HULL_COLOUR].flatMap((hex, index) => {
    const channel = new THREE.Color(hex).toArray();
    return Array.from({ length: flat[index].getAttribute('position').count }, () => channel).flat();
  });
  const merged = mergeGeometries(flat, false);
  // 两份都要收：`flat` 里换了对象的那些，原始那只在 `parts` 里，只 dispose 一边就漏一份顶点缓冲。
  for (const part of new Set([...parts, ...flat])) part.dispose();
  merged.computeVertexNormals();
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  // 窗带那一圈：贴在上层建筑侧面的一薄条，夜景才亮。跟着上层建筑一起挪到 −z 那端。
  const strip = box(HULL_WIDTH_METRES * 0.86, 1.1, (HULL_LENGTH_METRES - PROW_METRES) * 0.72, 0,
    HULL_HEIGHT_METRES - BOAT_DRAFT_METRES + DECK_HEIGHT_METRES * 0.62, hullBack + HULL_LENGTH_METRES * 0.04);
  return { hull: merged, strip };
}

/**
 * 把 `canton-water.geojson` 那 41 片水面投进塔的米制系，给出"这一点还泡在水里吗"的判定。
 * 船不能上岸：岸线是数据里有的东西，不该靠注释里一句"约 300 m 宽"来保证。
 * @param {object[]} faces `canton-water.geojson` 的 features（Polygon）
 * @param {{lng:number,lat:number}} origin 与车流同一个米制原点
 */
export function shoreMask(faces = [], origin) {
  const ring = (points) => points.map(([lng, lat]) => {
    const { dx, dy } = plane(origin, { lng, lat });
    return [dx, dy];
  });
  const polygons = faces
    .filter((feature) => feature.geometry?.type === 'Polygon')
    .map((feature) => feature.geometry.coordinates.map(ring));
  const inRing = (points, x, y) => {
    let hit = false;
    for (let index = 0, prev = points.length - 1; index < points.length; prev = index++) {
      const [ax, ay] = points[index];
      const [bx, by] = points[prev];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
    }
    return hit;
  };
  return (x, y) => polygons.some((poly) => inRing(poly[0], x, y) && !poly.slice(1).some((hole) => inRing(hole, x, y)));
}

/**
 * 把珠江中心线切成"能跑船的航道段"：与路网同一套裁圆与折线长度，只是这里没有车道、也没有红绿灯。
 * @param {object[]} features `canton-river.geojson` 的 features（LineString，waterway=river）
 * @param {((x:number,y:number)=>boolean)=null} inWater 给了就把每条船的横向游移夹到岸线之内
 */
export function boatRoutes(features = [], origin, radius = BOAT_LIFE_RADIUS, inWater = null) {
  const boats = [];
  for (const feature of features) {
    if (feature.properties?.waterway && !['river', 'canal'].includes(feature.properties.waterway)) continue;
    const ring = feature.geometry?.type === 'LineString' ? feature.geometry.coordinates : null;
    if (!ring || ring.length < 2) continue;
    for (const kept of insideRadius(ring, origin, radius)) {
      const line = polyline(kept);
      if (line.length < BOAT_MIN_METRES) continue;
      const osmId = Number(feature.properties.osmId) || 0;
      const seed = osmId * 4093;
      const speed = BOAT_SPEED_METRES_PER_SECOND * (1 + (scatter(seed + 7) - 0.5) * 2 * BOAT_SPEED_JITTER);
      // 双向：珠江上行与下行本来就是两条航迹，错开之后画面不会变成一列火车。
      for (let distance = 0, step = 0; distance + HULL_LENGTH_METRES * 3 < line.length; step += 1) {
        const gap = spaced(BOAT_GAP_METRES, seed + step * 3);
        const sign = step % 2 ? -1 : 1;
        const wander = (scatter(seed + step * 11) - 0.5) * 2 * BOAT_WANDER_METRES;
        boats.push({
          line, at: wrapped(distance, line.length), speed, sign, osmId,
          // `agentPosition` 是车流那套：横向偏移要乘一次行进方向（车靠右行驶，两条车道各占一侧）。
          // 船没有左右舵的规矩，而这一带的散列恰好按步数奇偶翻符号，跟着乘的结果是上行下行叠在同一行里
          // ——实测第 5~9 号船的有效横向全落在 +24~+35 m，屏幕上就是一条直线。所以这里预乘 `sign` 把它抵消。
          offset: sign * fitShore(line, wander, inWater),
        });
        distance += gap;
      }
    }
  }
  return { boats };
}

/**
 * 江面上的船。接口与 `createTrafficLife` 对齐（advance / setLit / setZoom / parts / dispose），
 * 所以两条渲染路径都用同一种方式挂它：现版挂在塔那套 three.js 场景里，新引擎直接进自己的场景。
 */
export function createWaterLife({ features = [], origin, radius = BOAT_LIFE_RADIUS, shore = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'water-life';
  const { boats } = boatRoutes(features, origin, radius, shore.length ? shoreMask(shore, origin) : null);
  const { hull, strip } = boatGeometry();
  const hulls = new THREE.InstancedMesh(hull, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0.15,
  }), boats.length);
  hulls.name = 'water-boats';
  hulls.frustumCulled = false;
  const lights = new THREE.InstancedMesh(strip, new THREE.MeshBasicMaterial({
    color: BOAT_LIGHT_COLOUR, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }), boats.length);
  lights.name = 'water-lights';
  lights.frustumCulled = false;
  group.add(hulls, lights);

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const unit = new THREE.Vector3(1, 1, 1);
  let clock = 0;
  let lit = 0;
  let reach = 0;

  const place = () => {
    boats.forEach((boat, index) => {
      const where = agentPosition(boat, clock);
      position.set(where.x, 0, -where.y);
      // 长轴在几何里走 z，而 `atan2(dir.y, dir.x)` 那套是给"车头朝 +x"的车用的——直接抄过来，船就横在航道上
      // （用户 2026-10-09：「游轮的移动方向错了，怎么横着移动」，量到的就是长轴与前进方向点积 0.000）。
      // 加这 90° 之后几何的 +z（船头）正好压在前进方向上。
      spin.setFromAxisAngle(up, Math.atan2(where.dir.y, where.dir.x) + Math.PI / 2);
      matrix.compose(position, spin, unit);
      hulls.setMatrixAt(index, matrix);
      lights.setMatrixAt(index, matrix);
      reach = Math.max(reach, Math.hypot(where.x, where.y));
    });
    hulls.instanceMatrix.needsUpdate = true;
    lights.instanceMatrix.needsUpdate = true;
    hulls.count = lights.count = boats.length;
  };
  const paint = () => {
    lights.material.opacity = lit;
    lights.visible = lit > 0.02;
  };
  place();
  paint();

  return {
    group,
    counts: { boats: boats.length },
    /**
     * 与车流同一个用法：给的是"车流开起来一共走了多少秒"这一把绝对读数，不是增量。
     * 两条渲染路径都是 `motion.life / 1000` 直接递进来的，累积成增量就会每帧再乘一次时长——
     * 船会在江上乱跳，而且"动效关掉回出厂帧"也回不去。
     */
    advance(seconds) {
      clock = Number.isFinite(seconds) ? seconds : 0;
      place();
    },
    setLit(share) {
      lit = share === true ? 1 : share === false ? 0 : Math.min(1, Math.max(0, Number(share) || 0));
      paint();
    },
    setVisible(on) { group.visible = Boolean(on); },
    reach: () => Math.round(reach),
    parts() {
      return { hulls: { instances: hulls.count, visible: hulls.visible }, lights: { visible: lights.visible, opacity: lights.material.opacity }, lit, clock };
    },
    // teardown：几何、材质、组里的节点，三样都要还。少一样就是引擎那句 `dispose()` 谈不成"没漏"（#177）。
    dispose() {
      hull.dispose();
      strip.dispose();
      hulls.material.dispose();
      lights.material.dispose();
      group.clear();
    },
  };
}

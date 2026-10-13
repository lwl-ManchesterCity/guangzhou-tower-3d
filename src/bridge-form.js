// 海心桥的几何。OSM 给的是桥面闭合轮廓（way/1313608038：101 个点、周圈 1,220 m、自身面积 6,846 m²），
// 而这条轮廓**不是一条直的带子**——画出来是一个 L：主跨从东北落到西南，两端各接一段弯曲的引桥。所以
// "把环拆成两条等长的边再配中线"这条路走不通（试过：配对之后半宽平均 35 m、最大 107 m，桥面会渲成一面墙）。
//
// 这一版只做数据支持得起的事：桥面仍是 OSM 原环按米数加密后拉伸（走 `landmark-forms.js` 那条 loft 路径），
// 拱肋与吊杆挂在**跨径线**上。跨径线不是猜的：在所有顶点对里取"沿线每个采样点都落在轮廓内部"的最长那条，
// 它就是这座桥跨水的那一跨。拱高、偏心、管径、桥台尺寸是示意常数，命名在这里，卡片与测试都指着它们说事。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { plane } from './geo.js';

export const CHORD_SAMPLES = 24;
export const STATIONS = 32;
// 示意常数：拱肋抬多高、往哪一侧偏、管多粗；吊杆几道、多粗；桥台平面多大。
export const ARCH_RISE_METRES = 36;
export const ARCH_OFFSET_METRES = 9;
export const ARCH_RIB_RADIUS_METRES = 2.2;
export const HANGER_COUNT = 14;
export const HANGER_RADIUS_METRES = 0.28;
export const ABUTMENT_METRES = 9;

/** 折线按弧长等分。只用在跨径线上；建筑轮廓要保住角点，走 `landmark-forms.js` 的 refineRing。 */
export function resample(points, count) {
  if (points.length < 2) throw new Error(`重采一条至少两个点的折线，拿到 ${points.length} 个`);
  const total = points.reduce((sum, point, index) => sum
    + (index ? Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) : 0), 0);
  if (!(total > 0)) throw new Error('重采一条零长折线');
  const out = [];
  let segment = 0;
  let walked = 0;
  for (let index = 0; index <= count; index += 1) {
    const at = (total * index) / count;
    while (segment < points.length - 2) {
      const next = Math.hypot(points[segment + 1].x - points[segment].x, points[segment + 1].y - points[segment].y);
      if (walked + next > at) break;
      walked += next;
      segment += 1;
    }
    const a = points[segment];
    const b = points[segment + 1];
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const t = span ? Math.min(1, Math.max(0, (at - walked) / span)) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

const insideRing = (points, x, y) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/**
 * 轮廓内部最长的顶点对连线，即这座桥跨水的那一跨。
 *
 * 判据是"沿线每一个采样点都在轮廓内"，所以 L 形的两条腿不会被当成跨径：从一条腿跨到另一条腿的那条线要穿出
 * 轮廓，直接被否掉。
 */
export function crossingChord(ring, origin, samples = CHORD_SAMPLES) {
  const points = (ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring)
    .map(([lng, lat]) => {
      const { dx, dy } = plane(origin, { lng, lat });
      return { x: dx, y: dy };
    });
  if (points.length < 4) throw new Error(`桥面轮廓只有 ${points.length} 个点`);
  let best = null;
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const from = points[a];
      const to = points[b];
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (best && length <= best.length) continue;
      let clear = true;
      for (let step = 1; step < samples; step += 1) {
        const t = step / samples;
        if (!insideRing(points, from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)) { clear = false; break; }
      }
      if (clear) best = { from, to, length };
    }
  }
  if (!best) throw new Error('桥面轮廓里找不到一条完整落在内部的跨径线');
  return { ...best, stations: resample([best.from, best.to], STATIONS) };
}

const vertex = (point, y) => [point.x, y, -point.y];

/**
 * 拱肋与吊杆，合成一个几何。
 *
 * 肋沿跨径线起拱：两端落在桥面之上 2 m，跨中往一侧偏 ARCH_OFFSET_METRES、抬到 ARCH_RISE_METRES。吊杆逐站从肋
 * 落到桥面顶，站号与跨径线共用同一份，所以杆一定落在桥面内；两端高差不足 4 m 的站不出杆。
 */
export function ribGeometry(chord, deckTop) {
  const { stations } = chord;
  const last = stations.length - 1;
  const axis = { x: stations[last].x - stations[0].x, y: stations[last].y - stations[0].y };
  const length = Math.hypot(axis.x, axis.y) || 1;
  const side = { x: -axis.y / length, y: axis.x / length };
  const at = (fraction) => stations[Math.round(fraction * last)];
  const point = (fraction, offset, y) => {
    const station = at(fraction);
    return new THREE.Vector3(...vertex({ x: station.x + side.x * offset, y: station.y + side.y * offset }, y));
  };
  const curve = new THREE.CatmullRomCurve3([
    point(0, 0, deckTop + 2),
    point(0.2, ARCH_OFFSET_METRES * 0.55, deckTop + ARCH_RISE_METRES * 0.58),
    point(0.44, ARCH_OFFSET_METRES, deckTop + ARCH_RISE_METRES),
    point(0.72, ARCH_OFFSET_METRES * 0.6, deckTop + ARCH_RISE_METRES * 0.62),
    point(1, 0, deckTop + 2),
  ], false, 'catmullrom', 0.5);
  const parts = [new THREE.TubeGeometry(curve, 96, ARCH_RIB_RADIUS_METRES, 8, false).toNonIndexed()];
  const hangers = [];
  for (let index = 1; index <= HANGER_COUNT; index += 1) {
    const fraction = index / (HANGER_COUNT + 1);
    const onDeck = new THREE.Vector3(...vertex(at(fraction), deckTop + 0.2));
    const onRib = curve.getPoint(fraction);
    if (onRib.y - onDeck.y < 4) continue;
    const drop = new THREE.Vector3().subVectors(onDeck, onRib);
    const cylinder = new THREE.CylinderGeometry(HANGER_RADIUS_METRES, HANGER_RADIUS_METRES, drop.length(), 6, 1, false);
    cylinder.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3().addVectors(onRib, onDeck).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), drop.clone().normalize()),
      new THREE.Vector3(1, 1, 1),
    ));
    hangers.push(cylinder.toNonIndexed());
    cylinder.dispose();
  }
  const merged = mergeGeometries([...parts, ...hangers], false);
  for (const part of [...parts, ...hangers]) part.dispose();
  merged.computeVertexNormals();
  return { geometry: merged, hangers: hangers.length, span: Math.round(chord.length) };
}

/** 桥台：跨径线两端各一块从地面顶到桥面底下的方箱。 */
export function abutmentGeometry(chord, bottom) {
  const boxes = [chord.from, chord.to].map((point) => {
    const box = new THREE.BoxGeometry(ABUTMENT_METRES, Math.max(0.1, bottom), ABUTMENT_METRES);
    box.translate(point.x, bottom / 2, -point.y);
    const baked = box.toNonIndexed();
    box.dispose();
    return baked;
  });
  const merged = mergeGeometries(boxes, false);
  for (const box of boxes) box.dispose();
  return merged;
}

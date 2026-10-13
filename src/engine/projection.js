// V8 Phase 0：经纬度 ↔ 局部米制。整个引擎只有这一个坐标系，地标资产搬进来时不需要第二次换算。
//
// 正向用 `src/geo.js` 里那个 `plane()` —— 它不是近似等距圆柱，而是取两点中间纬度的 Mercator 平面，
// 现版的塔身、壳体、落水色带全都按它量（`tower.js` 的 `channelCrossing` 就是），所以新引擎复用同一个函数，
// 而不是另写一份"看起来一样"的投影：两份投影在 3 公里半径上差的是厘米级，够让一顶皇冠偏离它的塔身。
// 反向没有闭式（中间纬度依赖未知的目标纬度），用两次定点迭代收敛，误差在 0.05 m 以内，由单元测试钉住。
import { EARTH_RADIUS, plane } from '../geo.js';

const radians = (degrees) => degrees * Math.PI / 180;

/**
 * @param {{lat: number, lng: number}} origin 场景中心，也是局部坐标的原点
 */
export function createProjection(origin) {
  // 一次转换、全局复用：`plane()` 每次调用都算一遍中间纬度的周长，3,990 栋楼 × 每栋几个顶点，
  // 这份开销在装载时付一次就好，不该出现在渲染循环里。
  const cache = new Map();
  const key = (lat, lng) => `${lat.toFixed(7)},${lng.toFixed(7)}`;
  const toMetres = (point) => {
    const id = key(point.lat, point.lng);
    let hit = cache.get(id);
    if (!hit) {
      const { dx, dy } = plane(origin, point);
      hit = { x: dx, z: -dy };
      cache.set(id, hit);
    }
    return hit;
  };
  toMetres.uncached = (point) => {
    const { dx, dy } = plane(origin, point);
    return { x: dx, z: -dy };
  };
  toMetres.origin = origin;

  /**
   * The inverse of `toMetres`, by fixed-point iteration on the midpoint latitude the forward map depends on.
   *
   * @param {{x: number, z: number}} position metres east (x) and south (z) of the scene centre
   * @returns {{lat: number, lng: number}}
   */
  toMetres.toLngLat = ({ x, z }) => {
    const circumference = (latitude) => 2 * Math.PI * EARTH_RADIUS * Math.cos(radians(latitude));
    const mercatorY = (latitude) => (180 - Math.log(Math.tan(Math.PI / 4 + radians(latitude) / 2)) / radians(1)) / 360;
    const toLatitude = (y) => (2 * Math.atan(Math.exp(radians(180 - 360 * y))) - Math.PI / 2) / radians(1);
    let lat = origin.lat, lng = origin.lng;
    for (let step = 0; step < 3; step++) {
      const per = circumference((origin.lat + lat) / 2);
      lng = origin.lng + (x * 360) / per;
      // `z` runs south and `dy` runs north, so a point north of the origin has `mercatorY` smaller by `z/per`.
      lat = toLatitude(mercatorY(origin.lat) + z / per);
    }
    return { lat, lng };
  };
  return toMetres;
}

// A ring of `radius` metres around the origin, as a closed polygon in the local frame. The scene's own boundary is a
// circle on the ground, not a rectangle on the map, and the data layer already clips to it (`radiusPolygon`).
export function groundRing(project, radius, segments = 96) {
  const ring = [];
  for (let index = 0; index <= segments; index++) {
    const angle = (2 * Math.PI * index) / segments;
    const point = project.toLngLat({ x: Math.sin(angle) * radius, z: -Math.cos(angle) * radius });
    ring.push([point.lng, point.lat]);
  }
  return ring;
}

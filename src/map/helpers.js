// map.js 拆出来的纯函数那一份（#219）：不碰 map 实例、不碰 DOM，Node 那侧可以直接单元测试。
import { ATMOSPHERES, baseAtmospherePaint } from '../atmosphere.js';
import { insideRing, interiorPoint } from '../buildings.js';

// Plain OSM way ids stay numbers; a namespaced id (relation/…) is only meaningful as text, and the card seat hit-test
// compares it with String(), so keeping the string is what lets a relation avoid covering itself.
export const buildingId = (id) => (id === undefined || id === null ? id : /^\d+$/.test(String(id)) ? Number(id) : String(id));

// 只认 Polygon 的取点：数据准备与可步行图留在 Node 那侧，不进客户端这一份。
// 眼下的建筑快照全是 Polygon，而空洞必须参与—— unnamed、没进索引的 relation 也一样要把点落在肉上。
export function geometryPoint(geometry) {
  const polygon = geometry.coordinates;
  const contains = (point) => insideRing(polygon[0], ...point) && !polygon.slice(1).some((ring) => insideRing(ring, ...point));
  const point = interiorPoint(polygon[0]);
  if (polygon.length === 1 || contains(point)) return point;
  const lats = polygon[0].map((p) => p[1]);
  const min = Math.min(...lats), max = Math.max(...lats);
  for (let row = 1; row < 32; row++) {
    const y = min + (max - min) * row / 32;
    const xs = [];
    for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const candidate = [(xs[i - 1] + xs[i]) / 2, y];
      if (contains(candidate)) return candidate;
    }
  }
  throw new Error('no interior building point');
}

// 底图里这三族线图层在三维视角下是"画在面上的东西"：隧道线（路/铁在地下，虚线却压在草坪与江面上）、
// 行政边界（现实里没有线，跨江那一段在画面里就是一道划痕）、水系中心线（我们自己画了水面，中心线叠上去
// 像江上裂了几条缝）。用户 2026-10-09 说「别的地方也是，优化一下」，量到的正是这三族：机位 15.5 级扫一遍，
// 压在开阔水面上的采样点里 `tunnel_transit_rail_hatching` 198 次、`waterway_river` 178 次、`boundary_3` 134 次。
// 水系的名字留着（`waterway_line_label` 那一层是"珠江"三个字，不是线）。
export const SUBSURFACE_LINES = /^(tunnel_|boundary_(2|3|disputed)$|waterway_(river|other|tunnel)$)/;

export function neighborhoodStyle(style) {
  style.projection = { type: 'mercator' };
  style.layers = style.layers.filter((layer) => layer.type !== 'fill-extrusion' && !['poi', 'housenumber'].includes(layer['source-layer']) && !layer.id.includes('shield')
    && !(layer.type === 'line' && SUBSURFACE_LINES.test(layer.id)));
  for (const layer of style.layers) {
    const source = layer['source-layer'];
    if (layer.type === 'fill' && source === 'building') {
      delete layer.maxzoom;
      layer.paint = {};
    }
    layer.paint = { ...layer.paint, ...baseAtmospherePaint(layer, ATMOSPHERES.day) };
    if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      layer.layout['text-field'] = ['coalesce', ['get', 'name:zh'], ['get', 'name:en'], ['get', 'name']];
      if (['transportation_name', 'place'].includes(source)) layer.minzoom = Math.max(layer.minzoom ?? 0, source === 'place' ? 16 : 16.5);
    }
  }
  return style;
}
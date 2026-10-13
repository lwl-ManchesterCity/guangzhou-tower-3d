import { insideRing, interiorPoint } from './buildings.js';
import { polygonsOf } from './footprints.js';
import { featureCollection, METERS_PER_DEGREE } from './geo.js';

export const BLOCK_LAYOUT = { bearing: -15, separationMeters: 8, roadSetbackMeters: 6, campusSetbackMeters: 5 };

export function blockRoads(raw) {
  return featureCollection(raw.elements.filter(element => element.type === 'way'
    && /^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)(?:_link)?$/.test(element.tags?.highway)
    && (!element.tags.bridge || element.tags.bridge === 'no')
    && (!element.tags.tunnel || element.tags.tunnel === 'no')
    && (!element.tags.layer || Number(element.tags.layer) === 0))
    .sort((a, b) => a.id - b.id).map(element => ({
      type: 'Feature', id: element.id,
      properties: { osmId: element.id, highway: element.tags.highway,
        ...Object.fromEntries(['bridge', 'tunnel', 'layer'].filter(key => element.tags[key] !== undefined).map(key => [key, element.tags[key]])) },
      geometry: { type: 'LineString', coordinates: element.geometry.map(point => [point.lon, point.lat]) },
    })));
}

export const segmentsOf = features => features.flatMap(feature => feature.geometry.coordinates.slice(1)
  .map((end, index) => [feature.geometry.coordinates[index], end]));
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
export function crosses(a, b, p, q) {
  const abp = cross(a, b, p), abq = cross(a, b, q), pqa = cross(p, q, a), pqb = cross(p, q, b);
  const onSegment = (start, end, point) => point[0] >= Math.min(start[0], end[0]) && point[0] <= Math.max(start[0], end[0])
    && point[1] >= Math.min(start[1], end[1]) && point[1] <= Math.max(start[1], end[1]);
  return (abp * abq < 0 && pqa * pqb < 0) || (abp === 0 && onSegment(a, b, p)) || (abq === 0 && onSegment(a, b, q))
    || (pqa === 0 && onSegment(p, q, a)) || (pqb === 0 && onSegment(p, q, b));
}
const bounds = points => points.reduce(([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)], [Infinity, Infinity, -Infinity, -Infinity]);
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const contains = (ring, point) => ring.every((start, index) => cross(start, ring[(index + 1) % ring.length], point) >= -1e-7);
const intersects = (ring, a, b) => contains(ring, a) || contains(ring, b)
  || ring.some((point, index) => crosses(a, b, point, ring[(index + 1) % ring.length]));

function clip(ring, nx, ny, limit) {
  const result = [];
  for (let index = 0; index < ring.length; index++) {
    const p = ring[index], q = ring[(index + 1) % ring.length];
    const dp = p[0] * nx + p[1] * ny - limit, dq = q[0] * nx + q[1] * ny - limit;
    if (dp <= 0) result.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) result.push([p[0] + (q[0] - p[0]) * dp / (dp - dq), p[1] + (q[1] - p[1]) * dp / (dp - dq)]);
  }
  return result;
}

function closest(point, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

function refineBlock(ring) {
  const box = bounds(ring), widths = [box[2] - box[0], box[3] - box[1]];
  const axis = widths[0] > widths[1] ? 0 : 1;
  const trim = Math.min(widths[axis] * 0.12, (widths[axis] - 6 * widths[1 - axis]) / 2);
  if (trim > 0) {
    ring = clip(ring, axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, box[axis + 2] - trim);
    ring = clip(ring, axis === 0 ? -1 : 0, axis === 1 ? -1 : 0, -box[axis] - trim);
  }
  const corners = ring;
  for (let index = 0; index < corners.length; index++) {
    const p = corners[index], before = corners[(index + corners.length - 1) % corners.length], after = corners[(index + 1) % corners.length];
    const a = [before[0] - p[0], before[1] - p[1]], b = [after[0] - p[0], after[1] - p[1]];
    const la = Math.hypot(...a), lb = Math.hypot(...b);
    if ((a[0] * b[0] + a[1] * b[1]) / (la * lb) <= 0.5) continue;
    const cut = Math.min(3, la * 0.15, lb * 0.15);
    const q = [p[0] + a[0] / la * cut, p[1] + a[1] / la * cut];
    const r = [p[0] + b[0] / lb * cut, p[1] + b[1] / lb * cut];
    const nx = r[1] - q[1], ny = q[0] - r[0];
    ring = clip(ring, nx, ny, q[0] * nx + q[1] * ny);
  }
  return ring;
}

export const schematicThickness = shortSide => Math.round(Math.min(24, Math.max(9.6, shortSide * 0.24)) * 10) / 10;

// Scenes that draw every footprint on its own have no block envelope to measure, so the same illustrative thickness is
// taken from each outline's own bounding box. Only the 9.6 m placeholders gain a display height; a footprint with a
// tagged or level-derived height keeps its source number and gets no displayHeight field at all, so the render
// expression falls back to the truth instead of to a second copy of an invented number.
export function schematicDisplayHeights(features, { center }) {
  const metersX = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
  return features.map(feature => {
    const properties = feature.properties;
    if (properties.heightSource !== 'estimate') return feature;
    const box = bounds(feature.geometry.coordinates[0].slice(0, -1)
      .map(([lng, lat]) => [(lng - center.lng) * metersX, (lat - center.lat) * METERS_PER_DEGREE]));
    const side = Math.min(box[2] - box[0], box[3] - box[1]);
    return { ...feature, properties: { ...properties, displayHeight: properties.base + schematicThickness(side) } };
  });
}

export function layoutBlocks(entries, { center, roads = [], campusGeometry = null }) {
  const angle = BLOCK_LAYOUT.bearing * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const metersX = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
  const project = ([lng, lat]) => {
    const x = (lng - center.lng) * metersX, y = (lat - center.lat) * METERS_PER_DEGREE;
    return [x * c + y * s, -x * s + y * c];
  };
  const unproject = ([u, v]) => [center.lng + (u * c - v * s) / metersX, center.lat + (u * s + v * c) / METERS_PER_DEGREE];
  const segments = segmentsOf(roads).map(segment => segment.map(project).sort((a, b) => a[0] - b[0] || a[1] - b[1]))
    .sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || a[1][0] - b[1][0] || a[1][1] - b[1][1])
    .map(points => ({ points, box: bounds(points) }));
  const campus = campusGeometry?.coordinates[0].slice(0, -1).map(project);
  const campusArea = campus?.reduce((sum, p, index) => sum + p[0] * campus[(index + 1) % campus.length][1] - p[1] * campus[(index + 1) % campus.length][0], 0);
  const campusSign = campusArea > 0 ? 1 : -1;
  const planes = campus?.map((p, index) => {
    const q = campus[(index + 1) % campus.length], dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
    const nx = -dy / length * campusSign, ny = dx / length * campusSign;
    return { nx, ny, limit: p[0] * nx + p[1] * ny };
  });
  const items = entries.map(({ shape, members }) => {
    const points = members.flatMap(feature => polygonsOf(feature.geometry).flatMap(polygon => polygon[0])).map(project);
    const box = bounds(points), [w, south, e, n] = box, mid = [(w + e) / 2, (south + n) / 2];
    const nearby = segments.filter(segment => overlaps(box, segment.box));
    const candidates = members.flatMap(feature => polygonsOf(feature.geometry).map(polygon => interiorPoint(polygon[0]))).map(project)
      .filter(point => (!campus || !insideRing([...campus, campus[0]], ...point))
        && nearby.every(({ points: [a, b] }) => { const q = closest(point, a, b); return Math.hypot(point[0] - q[0], point[1] - q[1]) > 0.01; }))
      .sort((p, q) => Math.hypot(p[0] - mid[0], p[1] - mid[1]) - Math.hypot(q[0] - mid[0], q[1] - mid[1]) || p[0] - q[0] || p[1] - q[1]);
    if (!candidates.length) throw new Error(`No off-road block anchor for ${shape.properties.osmId}`);
    return { shape, box, site: candidates[0], nearby, ring: [[w, south], [e, south], [e, n], [w, n]] };
  });
  const assigned = new Set();
  for (const item of items) {
    if (assigned.has(item)) continue;
    const coincident = items.filter(other => Math.hypot(other.site[0] - item.site[0], other.site[1] - item.site[1]) < 1e-6)
      .sort((a, b) => String(a.shape.properties.osmId).localeCompare(String(b.shape.properties.osmId), 'en'));
    coincident.forEach(other => assigned.add(other));
    if (coincident.length < 2) continue;
    const site = [...coincident[0].site];
    const clearances = coincident.flatMap(other => [site[0] - other.box[0], other.box[2] - site[0], site[1] - other.box[1], other.box[3] - site[1],
      ...other.nearby.map(({ points: [a, b] }) => { const q = closest(site, a, b); return Math.hypot(site[0] - q[0], site[1] - q[1]); })]);
    if (campus) for (let i = 0; i < campus.length; i++) {
      const q = closest(site, campus[i], campus[(i + 1) % campus.length]);
      clearances.push(Math.hypot(site[0] - q[0], site[1] - q[1]));
    }
    // Identical centres still need separate cells; a bounded offset keeps every anchor off roads and inside its envelope.
    const radius = Math.min(1, ...clearances) / 4;
    coincident.forEach((other, index) => { other.site = [site[0] + radius * (2 * index / (coincident.length - 1) - 1), site[1]]; });
  }
  for (const item of items) {
    for (const other of items) {
      if (item === other || !overlaps(item.box, other.box)) continue;
      const dx = other.site[0] - item.site[0], dy = other.site[1] - item.site[1];
      const axis = Math.abs(dx) > Math.abs(dy) ? 0 : 1, delta = other.site[axis] - item.site[axis], sign = Math.sign(delta);
      const gap = Math.min(BLOCK_LAYOUT.separationMeters / 2, Math.abs(delta) / 4);
      item.ring = clip(item.ring, axis === 0 ? sign : 0, axis === 1 ? sign : 0, sign * (item.site[axis] + other.site[axis]) / 2 - gap);
    }
    for (const { points: [a, b] } of item.nearby) {
      if (!intersects(item.ring, a, b)) continue;
      const q = closest(item.site, a, b), dx = item.site[0] - q[0], dy = item.site[1] - q[1], distance = Math.hypot(dx, dy);
      const nx = -dx / distance, ny = -dy / distance;
      // An endpoint uses its supporting plane, not the infinite extension of a short dead-end road.
      item.ring = clip(item.ring, nx, ny, q[0] * nx + q[1] * ny - Math.min(BLOCK_LAYOUT.roadSetbackMeters, distance / 2));
    }
    if (planes) {
      const plane = [...planes].sort((a, b) => (item.site[0] * a.nx + item.site[1] * a.ny - a.limit) - (item.site[0] * b.nx + item.site[1] * b.ny - b.limit))[0];
      const clearance = plane.limit - item.site[0] * plane.nx - item.site[1] * plane.ny;
      item.ring = clip(item.ring, plane.nx, plane.ny, plane.limit - Math.min(BLOCK_LAYOUT.campusSetbackMeters, clearance / 2));
    }
    item.ring = refineBlock(item.ring);
    if (item.ring.length < 3) throw new Error(`Empty schematic block ${item.shape.properties.osmId}`);
  }
  return items.map(item => {
    const p = item.shape.properties, box = bounds(item.ring);
    const shortSide = Math.min(box[2] - box[0], box[3] - box[1]);
    const thickness = schematicThickness(shortSide);
    const displayHeight = p.aggregate || p.heightSource === 'estimate' ? p.base + thickness : p.height;
    return { ...item.shape, properties: { ...p, schematic: true, displayHeight },
      geometry: { type: 'Polygon', coordinates: [[...item.ring, item.ring[0]].map(unproject)] } };
  });
}

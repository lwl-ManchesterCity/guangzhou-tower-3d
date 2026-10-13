import { footprintGap, polygonsOf } from './footprints.js';
import { METERS_PER_DEGREE } from './geo.js';
import { interiorPoint } from './buildings.js';
import { crosses, layoutBlocks, segmentsOf } from './block-layout.js';

export const GROUP_RULES = { gapMeters: 45, maxSpanMeters: 280 };

const CELL_DEGREES = 0.002; // ~200 m, so a 45 m test only ever needs a cell and its neighbours
const cellOf = (value) => Math.floor(value / CELL_DEGREES);

const bboxOf = (vertices) => vertices.reduce(
  ([a, b, c, d], [lng, lat]) => [Math.min(a, lng), Math.min(b, lat), Math.max(c, lng), Math.max(d, lat)],
  [Infinity, Infinity, -Infinity, -Infinity],
);

const boxGap = (A, B, metersX) => Math.hypot(
  Math.max(B[0] - A[2], A[0] - B[2], 0) * metersX,
  Math.max(B[1] - A[3], A[1] - B[3], 0) * METERS_PER_DEGREE,
);

const spanOf = ([minLng, minLat, maxLng, maxLat], metersX) => Math.hypot(
  (maxLng - minLng) * metersX,
  (maxLat - minLat) * METERS_PER_DEGREE,
);

const merge = (A, B) => [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])];

// The campus polygon and the parametric tower are single objects by definition, and a courtyard would otherwise be
// filled in by the buildings around it, so neither takes part in grouping.
const groupable = (feature) => Boolean(feature.properties)
  && !feature.properties.campus && !feature.properties.tower
  && (feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon');

const statsOf = (geometries, metersX) => ({
  count: geometries.length,
  area: Math.round(geometries.reduce((total, feature) => total + (feature.properties.area ?? 0), 0)),
  span: Math.round(spanOf(geometries.map((feature) => bboxOf(polygonsOf(feature.geometry).flat(2))).reduce(merge), metersX)),
  names: [...new Set(geometries.map((feature) => feature.properties.name).filter(Boolean))],
  sources: {
    osm: geometries.filter((feature) => !feature.properties.footprintSource).length,
    imagery: geometries.filter((feature) => feature.properties.footprintSource).length,
  },
  distance: Math.min(...geometries.map((feature) => feature.properties.distance ?? Infinity)),
});

const soleGroup = (feature, metersX) => {
  const key = String(feature.properties.osmId);
  return { id: key, members: [key], features: [feature], ...statsOf([feature], metersX), sole: true };
};

// Single-linkage on outline gaps, shortest gap first, a merge refused once the joined cluster would span more than the
// cap. Ties break on source id, so the partition does not depend on the order the features arrived in.
function partition(nodes, { metersX, gapMeters, maxSpanMeters }, barriers) {
  const grid = new Map();
  nodes.forEach((node, index) => {
    node.index = index;
    for (let x = cellOf(node.bbox[0]); x <= cellOf(node.bbox[2]); x += 1) {
      for (let y = cellOf(node.bbox[1]); y <= cellOf(node.bbox[3]); y += 1) {
        const cell = `${x}:${y}`;
        if (!grid.has(cell)) grid.set(cell, []);
        grid.get(cell).push(node);
      }
    }
  });
  // Candidates come from bounding boxes, then the real outline-to-outline gap decides, so a long block that passes
  // within reach while every one of its own corners sits further away still gets its edge.
  const edges = [];
  for (const node of nodes) {
    const seen = new Set();
    for (let x = cellOf(node.bbox[0]) - 1; x <= cellOf(node.bbox[2]) + 1; x += 1) {
      for (let y = cellOf(node.bbox[1]) - 1; y <= cellOf(node.bbox[3]) + 1; y += 1) {
        for (const other of grid.get(`${x}:${y}`) ?? []) {
          if (other === node || seen.has(other.index)) continue;
          seen.add(other.index);
          // One direction per pair: measuring a pair from both ends yields two distances, and the sort below would then
          // let the input order decide which merge is attempted first.
          const [a, b] = node.key < other.key ? [node, other] : [other, node];
          if (node !== a || boxGap(a.bbox, b.bbox, metersX) > gapMeters) continue;
          if (barriers.some(([p, q]) => crosses(a.point, b.point, p, q))) continue;
          edges.push({ gap: footprintGap(a.feature, b.feature), a: a.index, b: b.index, aKey: a.key, bKey: b.key });
        }
      }
    }
  }
  const usable = edges.filter((edge) => edge.gap <= gapMeters);
  usable.sort((x, y) => x.gap - y.gap
    || (x.aKey < y.aKey ? -1 : x.aKey > y.aKey ? 1 : (x.bKey < y.bKey ? -1 : x.bKey > y.bKey ? 1 : 0)));
  const parent = nodes.map((_, index) => index);
  const boxes = nodes.map((node) => [...node.bbox]);
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  for (const edge of usable) {
    const a = find(edge.a);
    const b = find(edge.b);
    if (a === b) continue;
    const joined = merge(boxes[a], boxes[b]);
    if (spanOf(joined, metersX) > maxSpanMeters) continue;
    parent[b] = a;
    boxes[a] = joined;
  }
  const members = new Map();
  for (const node of nodes) {
    const root = find(node.index);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(node);
  }
  return [...members.values()].map((list) => {
    const sorted = [...list].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    const features = sorted.map((node) => node.feature);
    return {
      id: sorted[0].key,
      members: sorted.map((node) => node.key),
      features,
      ...statsOf(features, metersX),
      sole: sorted.length === 1,
    };
  });
}

// Sorted by source id so the partition does not depend on the order the snapshot's features arrive in.
function toNodes(features, metersX) {
  const nodes = [];
  for (const feature of features) {
    const key = String(feature.properties?.osmId ?? '');
    if (!key || !groupable(feature)) continue;
    nodes.push({ feature, key, bbox: bboxOf(polygonsOf(feature.geometry).flat(2)), point: interiorPoint(polygonsOf(feature.geometry)[0][0]) });
  }
  return nodes.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

function rulesOf(center, gapMeters, maxSpanMeters) {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) {
    throw new Error('building groups need the scene centre to turn degrees into metres');
  }
  return { metersX: Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE, gapMeters, maxSpanMeters };
}

const byMember = (groups) => {
  const byId = new Map();
  for (const group of groups) for (const key of group.members) byId.set(key, group);
  return byId;
};

// What the card reports when only part of a group is drawn: the same stats the whole pass would give that subset.
export function groupStats(features, center) {
  return statsOf(features, rulesOf(center, GROUP_RULES.gapMeters, GROUP_RULES.maxSpanMeters).metersX);
}

export function groupShape(features, height = 9.6) {
  if (features.length === 1) return features[0];
  const members = [...features].sort((a, b) => String(a.properties.osmId).localeCompare(String(b.properties.osmId), 'en'));
  const points = members.flatMap(feature => polygonsOf(feature.geometry).flatMap(polygon => polygon[0]))
    .map(point => [...point]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .filter((point, index, list) => !index || point[0] !== list[index - 1][0] || point[1] !== list[index - 1][1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const chain = (list) => {
    const hull = [];
    for (const point of list) {
      while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  const ring = [...chain(points), ...chain([...points].reverse())];
  ring.push([...ring[0]]);
  const categories = new Map();
  for (const { properties } of members) categories.set(properties.category, (categories.get(properties.category) ?? 0) + 1);
  const category = [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0][0];
  return {
    type: 'Feature',
    properties: { osmId: members[0].properties.osmId, groupId: String(members[0].properties.osmId), groupCount: members.length,
      aggregate: true, category, height, base: 0, heightSource: 'estimate',
      distance: Math.min(...members.map(feature => feature.properties.distance)) },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

export function groupDisplay(grouping, category = 'all') {
  const entries = [], byMember = new Map();
  for (const group of grouping.groups) {
    const members = group.features.filter(feature => !feature.properties.campus && !feature.properties.tower
      && (category === 'all' || feature.properties.category === category));
    if (members.length) entries.push({ shape: groupShape(members), members });
  }
  const features = layoutBlocks(entries, grouping.layout);
  entries.forEach((entry, index) => {
    for (const member of entry.members) byMember.set(String(member.properties.osmId), features[index]);
  });
  return { features, byMember };
}

// One pass over a whole collection: what the audit-side counts and the tests read.
export function groupBuildings(features, {
  center = null,
  gapMeters = GROUP_RULES.gapMeters,
  maxSpanMeters = GROUP_RULES.maxSpanMeters,
  roads = [], campusGeometry = null,
} = {}) {
  const rules = rulesOf(center, gapMeters, maxSpanMeters);
  const barriers = segmentsOf(roads);
  if (campusGeometry) for (const ring of campusGeometry.coordinates) barriers.push(...ring.slice(1).map((end, index) => [ring[index], end]));
  const groups = partition(toNodes(features, rules.metersX), rules, barriers);
  const byId = byMember(groups);
  for (const feature of features) {
    const key = String(feature.properties?.osmId ?? '');
    if (!key || byId.has(key) || !feature.properties.osmId) continue;
    const group = soleGroup(feature, rules.metersX);
    groups.push(group);
    byId.set(key, group);
  }
  groups.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {
    rules: { gapMeters, maxSpanMeters },
    layout: { center, roads, campusGeometry },
    groups,
    groupOf: (osmId) => byId.get(String(osmId)) ?? null,
  };
}

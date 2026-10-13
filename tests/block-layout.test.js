import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BLOCK_LAYOUT, blockRoads, crosses, layoutBlocks, schematicDisplayHeights, schematicThickness } from '../src/block-layout.js';
import { groupBuildings, groupDisplay, groupShape } from '../src/groups.js';

// Independent metre-plane predicates: none use production crosses/insideRing/clip/segmentsOf.
const center = { lat: 23.17107, lng: 113.26646 };
const metersY = 6371008.8 * Math.PI / 180;
const metersX = Math.cos(center.lat * Math.PI / 180) * metersY;
const toGeo = ([x, y]) => [center.lng + x / metersX, center.lat + y / metersY];
const toMeters = ([lng, lat]) => [(lng - center.lng) * metersX, (lat - center.lat) * metersY];
const EPS = 1e-6; // Metres, only for floating-point round trips, not a visual clearance allowance.
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const edgesOf = points => points.map((point, i) => [point, points[(i + 1) % points.length]]);
const signedArea = points => points.slice(1, -1).reduce((sum, p, i) => sum + cross(points[0], p, points[i + 2]) / 2, 0);
const boundsOf = points => [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
  Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
const boxesOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const polygon = points => ({ type: 'Polygon', coordinates: [[...points, points[0]].map(toGeo)] });
const boxGeometry = ([w, s, e, n]) => polygon([[w, s], [e, s], [e, n], [w, n]]);
const building = (osmId, box, properties = {}) => ({ type: 'Feature',
  properties: { osmId, category: 'residential', height: 24, base: 3, distance: 100, area: 100, ...properties },
  geometry: boxGeometry(box) });
const entry = members => ({ shape: groupShape(members), members });
const road = (id, points) => ({ type: 'Feature', id, properties: { osmId: id, highway: 'residential' },
  geometry: { type: 'LineString', coordinates: points.map(toGeo) } });
const unclosed = geometry => geometry.coordinates[0].slice(0, -1).map(toMeters);
// Cyclic vertex ordering is immaterial; 0.00001 m rounding only removes round-trip noise.
const canonicalVertices = feature => validConvex(feature)
  .map(point => point.map(value => Number(value.toFixed(5)))).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const canonicalFeatures = features => features.map(feature => ({ properties: feature.properties, vertices: canonicalVertices(feature) }))
  .sort((a, b) => String(a.properties.osmId).localeCompare(String(b.properties.osmId)));

function validConvex(feature) {
  const label = String(feature.properties?.osmId ?? 'fixture');
  assert.equal(feature.geometry.type, 'Polygon', label);
  assert.equal(feature.geometry.coordinates.length, 1, `one exterior without holes: ${label}`);
  const ring = feature.geometry.coordinates[0];
  assert.ok(ring.length >= 4, `at least three corners: ${label}`);
  assert.ok(ring.every(point => point.length === 2 && point.every(Number.isFinite)), `finite coordinates: ${label}`);
  assert.deepEqual(ring[0], ring.at(-1), `closed ring: ${label}`);
  const points = unclosed(feature.geometry), area = signedArea(points), sign = Math.sign(area);
  assert.ok(Math.abs(area) > EPS * EPS, `positive nondegenerate area: ${label}`);
  for (const [a, b] of edgesOf(points)) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert.ok(length > EPS, `no duplicate consecutive vertices: ${label}`);
    // All vertices must lie in every edge's inward half-plane. This also rejects self-crossing stars.
    assert.ok(points.every(p => sign * cross(a, b, p) / length >= -EPS), `convex, non-self-crossing outline: ${label}`);
  }
  return points;
}

function assertRectangle(feature) {
  const points = validConvex(feature);
  assert.equal(points.length, 4, 'an unconstrained block is a rectangle');
  const angle = -15 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const vectors = edgesOf(points).map(([a, b]) => [b[0] - a[0], b[1] - a[1]]);
  vectors.forEach(([x, y], i) => {
    const [u, v] = vectors[(i + 1) % 4];
    assert.ok(Math.abs(x * u + y * v) / (Math.hypot(x, y) * Math.hypot(u, v)) < 1e-7, 'adjacent edges meet at right angles in metres');
    assert.ok(Math.min(Math.abs(x * c + y * s), Math.abs(-x * s + y * c)) / Math.hypot(x, y) < 1e-7,
      'rectangle edges follow the -15 degree axes, not longitude/latitude axes');
  });
}

// Convex SAT checks positive-area intersections, including containment; touching is permitted.
function positiveOverlap(a, b) {
  if (!boxesOverlap(boundsOf(a), boundsOf(b))) return false;
  for (const [p, q] of [...edgesOf(a), ...edgesOf(b)]) {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const nx = -(q[1] - p[1]) / length, ny = (q[0] - p[0]) / length;
    const pa = a.map(([x, y]) => x * nx + y * ny), pb = b.map(([x, y]) => x * nx + y * ny);
    if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= EPS) return false;
  }
  return true;
}

function assertSeparated(features) {
  const polygons = features.map(validConvex), failures = [];
  for (let i = 0; i < polygons.length; i++) for (let j = i + 1; j < polygons.length; j++) {
    if (positiveOverlap(polygons[i], polygons[j])) failures.push([features[i].properties.osmId, features[j].properties.osmId]);
  }
  assert.deepEqual(failures, [], 'display blocks must not overlap with positive area');
}

// Interior intervals also catch short segments wholly contained in a block.
function segmentEnters(points, a, b) {
  let low = 0, high = 1;
  const sign = Math.sign(signedArea(points));
  for (const [p, q] of edgesOf(points)) {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const da = sign * cross(p, q, a) / length, db = sign * cross(p, q, b) / length;
    const slope = db - da;
    if (Math.abs(slope) < 1e-12) {
      if (da <= EPS) return false;
    } else if (slope > 0) low = Math.max(low, (EPS - da) / slope);
    else high = Math.min(high, (EPS - da) / slope);
    if (low >= high) return false;
  }
  return low < high;
}

function assertRoadsOutside(features, roads) {
  const segments = roads.flatMap(feature => feature.geometry.coordinates.slice(1).map((point, index) => ({
    id: feature.properties.osmId, index, a: toMeters(feature.geometry.coordinates[index]), b: toMeters(point),
  })));
  const failures = [];
  for (const feature of features) {
    const points = validConvex(feature), box = boundsOf(points);
    for (const { id, index, a, b } of segments) {
      if (boxesOverlap(box, boundsOf([a, b])) && segmentEnters(points, a, b)) failures.push({ block: feature.properties.osmId, road: id, segment: index });
    }
  }
  assert.deepEqual(failures, [], 'road centreline must not enter any schematic block');
}

function assertCampusOutside(features, campusGeometry) {
  const campus = unclosed(campusGeometry);
  const failures = features.filter(feature => positiveOverlap(validConvex(feature), campus)).map(feature => feature.properties.osmId);
  assert.deepEqual(failures, [], 'campus must not overlap any schematic block with positive area');
}

const sourceProperties = ({ displayHeight, ...properties }) => properties;

function assertDisplayHeight(feature, source) {
  const box = boundsOf(unclosed(feature.geometry).map(intoLayout));
  const short = Math.min(box[2] - box[0], box[3] - box[1]);
  // Fixed -15-degree axes and a piecewise oracle, independent of production height code.
  const thickness = short <= 40 ? 9.6 : short >= 100 ? 24 : Math.round(short * 2.4) / 10;
  assert.equal(feature.properties.displayHeight,
    source.aggregate || source.heightSource === 'estimate' ? source.base + thickness : source.height,
    `displayHeight follows the final short side or exact known height: ${source.osmId}`);
}

function assertProperties(features, entries) {
  assert.equal(features.length, entries.length);
  for (const original of entries) {
    const feature = features.find(feature => feature.properties.osmId === original.shape.properties.osmId);
    assert.ok(feature);
    assert.notStrictEqual(feature, original.shape);
    assert.notStrictEqual(feature.geometry, original.shape.geometry);
    assert.deepEqual(sourceProperties(feature.properties), { ...original.shape.properties, schematic: true }, 'all source properties survive exactly');
    assertDisplayHeight(feature, original.shape.properties);
  }
}

const readJSON = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
let shipped;
function realScene() {
  if (!shipped) {
    const buildings = readJSON('public/data/jingtai-buildings.geojson').features;
    const roads = readJSON('public/data/jingtai-roads.geojson').features;
    const campusGeometry = readJSON('public/data/jingtai-grounds.geojson').features
      .find(feature => feature.properties.kind === 'campus' && feature.properties.target).geometry;
    const options = { center, roads, campusGeometry };
    const grouping = groupBuildings(buildings, options);
    shipped = { buildings, options, grouping, display: groupDisplay(grouping) };
  }
  return shipped;
}

async function mutatedLayout(from, to) {
  const url = new URL('../src/block-layout.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must replace exactly one source fragment');
  const changed = source.replace(from, to).replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

// Fixed test axes and Euclidean measurements, independent of production projection/refinement.
const bearing = -15 * Math.PI / 180;
const fromLayout = ([u, v]) => [u * Math.cos(bearing) - v * Math.sin(bearing), u * Math.sin(bearing) + v * Math.cos(bearing)];
const intoLayout = ([x, y]) => [x * Math.cos(bearing) + y * Math.sin(bearing), -x * Math.sin(bearing) + y * Math.cos(bearing)];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ANGLE_EPS = 1e-5; // Degrees; only numerical noise, not a permitted residual acute corner.
const noRefinement = () => mutatedLayout('item.ring = refineBlock(item.ring);', '');
const layoutPolygon = points => polygon(points.map(fromLayout));
const cornersOfBox = ([w, s, e, n]) => [[w, s], [e, s], [e, n], [w, n]];
const layoutBuilding = (id, points, properties = {}) => ({ ...building(id, [0, 0, 1, 1], properties), geometry: layoutPolygon(points) });
const layoutEntries = (grouping, category) => grouping.groups
  .map(group => group.features.filter(feature => !feature.properties.campus && !feature.properties.tower
    && (category === 'all' || feature.properties.category === category)))
  .filter(members => members.length).map(entry);

function measurements(feature) {
  const points = validConvex(feature), box = boundsOf(points.map(intoLayout));
  const widths = [box[2] - box[0], box[3] - box[1]];
  const angles = points.map((p, i) => {
    const a = points[(i + points.length - 1) % points.length], b = points[(i + 1) % points.length];
    const cosine = ((a[0] - p[0]) * (b[0] - p[0]) + (a[1] - p[1]) * (b[1] - p[1])) / (distance(a, p) * distance(b, p));
    return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
  });
  return { points, box, widths, angles, minAngle: Math.min(...angles), aspect: Math.max(...widths) / Math.min(...widths),
    area: Math.abs(signedArea(points)), perimeter: edgesOf(points).reduce((sum, [a, b]) => sum + distance(a, b), 0) };
}

function assertContained(inner, outer) {
  const sign = Math.sign(signedArea(outer));
  for (const [a, b] of edgesOf(outer)) {
    assert.ok(inner.every(p => sign * cross(a, b, p) / distance(a, b) >= -EPS),
      'refinement stays inside every baseline half-plane, not merely its bbox or area');
  }
}

function assertOnlyShrinks(features, baseline, entries, options) {
  assertProperties(features, entries);
  assertProperties(baseline, entries);
  assert.deepEqual(features.map(feature => feature.properties.osmId), baseline.map(feature => feature.properties.osmId), 'no feature deleted or reordered');
  const pairs = features.map((feature, i) => {
    assert.deepEqual(sourceProperties(feature.properties), sourceProperties(baseline[i].properties),
      'including source heights, bases, categories and provenance; derived displayHeight is checked independently');
    const before = measurements(baseline[i]), after = measurements(feature);
    assertContained(after.points, before.points);
    assert.ok(after.area <= before.area + before.perimeter * EPS, 'no area expansion');
    const changed = JSON.stringify(canonicalVertices(feature)) !== JSON.stringify(canonicalVertices(baseline[i]));
    if (changed) assert.ok(before.area - after.area > before.perimeter * EPS, 'a changed shape must lose positive area');
    return { feature, before, after, changed };
  });
  for (const shapes of [baseline, features]) {
    assertSeparated(shapes);
    assertRoadsOutside(shapes, options.roads ?? []);
    if (options.campusGeometry) assertCampusOutside(shapes, options.campusGeometry);
  }
  return pairs;
}

function assertMemberMapping(display, entries) {
  const expected = entries.flatMap(({ members }) => members.map(member => String(member.properties.osmId))).sort();
  assert.deepEqual([...display.byMember.keys()].sort(), expected, 'every selected source member occurs exactly once');
  assert.equal(new Set(display.features).size, entries.length);
  for (const original of entries) {
    const feature = display.features.find(feature => feature.properties.osmId === original.shape.properties.osmId);
    assert.ok(feature, 'every selected group retains its displayed feature');
    for (const member of original.members) assert.strictEqual(display.byMember.get(String(member.properties.osmId)), feature);
  }
}

function assertChamfer(features, baseline, entries, options) {
  const [{ before, after }] = assertOnlyShrinks(features, baseline, entries, options);
  assert.ok(before.aspect < 6, 'acute fixture must not exercise the narrow-strip branch');
  const acute = before.angles.flatMap((angle, i) => angle < 60 - ANGLE_EPS ? [i] : []);
  assert.equal(acute.length, 1, 'fixture must really have one acute corner after barrier clipping');
  assert.ok(after.minAngle >= 60 - ANGLE_EPS, 'acute-corner refinement must remove the sub-60-degree corner');
  assert.equal(after.points.length, before.points.length + 1, 'one corner becomes exactly one inset plane');
  const index = acute[0], tip = before.points[index];
  const adjacent = [before.points[(index + before.points.length - 1) % before.points.length], before.points[(index + 1) % before.points.length]];
  const cut = Math.min(3, ...adjacent.map(p => distance(p, tip) * 0.15));
  for (const end of adjacent) {
    const newCorner = after.points.find(p => Math.abs(cross(tip, end, p)) / distance(tip, end) <= EPS && Math.abs(distance(p, tip) - cut) <= EPS);
    assert.ok(newCorner, 'each chamfer endpoint retreats min(3 m, 15% of either adjacent edge)');
  }
  for (const point of before.points.filter((_, i) => i !== index)) {
    assert.ok(after.points.some(p => distance(p, point) <= EPS), 'nonacute corners stay untouched');
  }
  const expectedLoss = cut * cut * Math.sin(before.angles[index] * Math.PI / 180) / 2;
  assert.ok(Math.abs(before.area - after.area - expectedLoss) <= before.perimeter * EPS, 'only the analytic corner triangle is removed');
  return cut;
}

function assertStripTrim(features, baseline, entries, options) {
  const [{ before, after }] = assertOnlyShrinks(features, baseline, entries, options);
  assertRectangle(baseline[0]);
  assertRectangle(features[0]);
  assert.ok(before.aspect > 6, 'strip fixture must really exceed the ratio threshold');
  assert.ok(before.minAngle > 60, 'strip fixture must not exercise the acute-corner branch');
  assert.ok(after.aspect < before.aspect - ANGLE_EPS, 'narrow-strip refinement must reduce the aspect ratio');
  const axis = before.widths[0] > before.widths[1] ? 0 : 1, other = 1 - axis;
  const trim = Math.min(before.widths[axis] * 0.12, (before.widths[axis] - 6 * before.widths[other]) / 2);
  assert.ok(Math.abs(after.box[axis] - before.box[axis] - trim) <= EPS, 'low end retreats by the specified trim');
  assert.ok(Math.abs(before.box[axis + 2] - after.box[axis + 2] - trim) <= EPS, 'high end retreats by the same trim');
  for (const index of [other, other + 2]) assert.ok(Math.abs(after.box[index] - before.box[index]) <= EPS, 'short-axis bounds stay fixed');
  assert.ok(Math.abs(before.area - after.area - 2 * trim * before.widths[other]) <= before.perimeter * EPS, 'only the two end strips are removed');
}

function refinementSummary(pairs) {
  const changed = pairs.filter(pair => pair.changed), sum = values => values.reduce((a, b) => a + b, 0);
  const round = value => Number(value.toFixed(6));
  const beforeArea = sum(pairs.map(pair => pair.before.area)), loss = sum(pairs.map(pair => pair.before.area - pair.after.area));
  const acute = pairs.filter(pair => pair.before.minAngle < 60 - ANGLE_EPS), strips = pairs.filter(pair => pair.before.aspect > 6 + ANGLE_EPS);
  return { total: pairs.length, affected: changed.length, acuteBefore: acute.length,
    acuteAfter: pairs.filter(pair => pair.after.minAngle < 60 - ANGLE_EPS).length,
    minAngle: ['before', 'after'].map(key => round(Math.min(...pairs.map(pair => pair[key].minAngle)))),
    stripsBefore: strips.length, stripsAfter: pairs.filter(pair => pair.after.aspect > 6 + ANGLE_EPS).length,
    maxAspect: ['before', 'after'].map(key => round(Math.max(...pairs.map(pair => pair[key].aspect)))),
    meanAcuteMinAngle: ['before', 'after'].map(key => round(sum(acute.map(pair => pair[key].minAngle)) / (acute.length || 1))),
    meanStripAspect: ['before', 'after'].map(key => round(sum(strips.map(pair => pair[key].aspect)) / (strips.length || 1))),
    areaLossM2: round(loss), areaLossPercent: round(100 * loss / beforeArea),
    maxShapeLossPercent: round(Math.max(...pairs.map(pair => 100 * (pair.before.area - pair.after.area) / pair.before.area))) };
}

test('unconstrained singletons, concave and multipart footprints become oriented right-angle rectangles', () => {
  assert.equal(BLOCK_LAYOUT.bearing, -15);
  const singleton = building('single', [0, 0, 40, 20], { height: 57, base: 6, heightSource: 'tag' });
  singleton.geometry.coordinates.push(boxGeometry([10, 5, 15, 10]).coordinates[0].reverse());
  const concave = building('concave', [200, 0, 260, 60]);
  concave.geometry = polygon([[200, 0], [260, 0], [260, 15], [215, 15], [215, 60], [200, 60]]);
  const multipart = building('multipart', [400, 0, 440, 20]);
  multipart.geometry = { type: 'MultiPolygon', coordinates: [boxGeometry([400, 0, 420, 20]).coordinates, boxGeometry([435, 30, 450, 40]).coordinates] };
  const entries = [entry([singleton]), entry([concave]), entry([multipart]),
    entry([building('group-a', [600, 0, 620, 20]), building('group-b', [640, 30, 660, 50])])];
  const before = structuredClone(entries), options = { center }, optionsBefore = structuredClone(options);
  const features = layoutBlocks(entries, options);
  features.forEach(assertRectangle);
  assertProperties(features, entries);
  assertSeparated(features);
  features.forEach((feature, i) => assert.notDeepEqual(feature.geometry, entries[i].shape.geometry));
  assert.equal(features[0].properties.height, 57);
  assert.equal(features[0].properties.base, 6);
  assert.equal(features[3].properties.height, 9.6);
  assert.equal(features[3].properties.base, 0);
  assert.deepEqual(entries, before);
  assert.deepEqual(options, optionsBefore);
  assert.deepEqual(layoutBlocks([], options), []);
});

test('illustrative heights use lower/linear/upper bounds on either short axis and add the exact base', () => {
  for (const aggregate of [false, true]) for (const axis of [0, 1]) {
    for (const [short, thickness] of [[20, 9.6], [40, 9.6], [61.3, 14.7], [100, 24], [120, 24]]) {
      const orient = points => points.map(([u, v]) => axis ? [v, u] : [u, v]);
      const boxes = aggregate ? [[0, 0, short * 1.5 - 2, short], [short * 1.5 + 2, 0, short * 3, short]]
        : [[0, 0, short * 3, short]];
      const entries = [entry(boxes.map((box, i) => layoutBuilding(String(i), orient(cornersOfBox(box)),
        { heightSource: 'estimate', height: 9.6, base: 3.25 })))];
      const before = structuredClone(entries), features = layoutBlocks(entries, { center });
      assertProperties(features, entries);
      const widths = measurements(features[0]).widths;
      assert.ok(Math.abs(widths[1 - axis] - short) < EPS, 'fixture exercises the specified final short side');
      assert.ok(widths[axis] > widths[1 - axis] * 2.9, 'long side must yield a different linear result');
      assert.equal(features[0].properties.displayHeight, (aggregate ? 0 : 3.25) + thickness);
      assert.deepEqual(layoutBlocks(entries, { center }), features);
      assert.deepEqual(entries, before);
    }
  }
});

test('known singletons retain exact height and base above the illustrative cap', () => {
  for (const [heightSource, height, base] of [['tag', 73.25, 5.125], ['height', 88.75, 4.2], ['levels', 96, 31]]) {
    const entries = [entry([layoutBuilding(heightSource, cornersOfBox([0, 0, 180, 61.3]),
      { heightSource, height, base, ...(heightSource === 'levels' ? { levels: 30 } : {}) })])];
    const before = structuredClone(entries), features = layoutBlocks(entries, { center });
    assertProperties(features, entries);
    assert.equal(features[0].properties.displayHeight, height);
    assert.equal(features[0].properties.height, height);
    assert.equal(features[0].properties.base, base);
    assert.deepEqual(entries, before);
  }
});

// Independent oracle for the per-building path: its own metre axes, its own envelope, and the clamp restated piecewise.
const cantonCenter = { lat: 23.109, lng: 113.31913 };
const cantonMetersX = Math.cos(cantonCenter.lat * Math.PI / 180) * metersY;
const illustrative = short => short <= 40 ? 9.6 : short >= 100 ? 24 : Math.round(short * 2.4) / 10;
function expectedDisplay(feature) {
  const { lng, lat } = cantonCenter;
  const ring = feature.geometry.coordinates[0];
  const xs = ring.map(point => (point[0] - lng) * cantonMetersX), ys = ring.map(point => (point[1] - lat) * metersY);
  const side = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return feature.properties.base + illustrative(side);
}
function assertSchematic(result, source) {
  assert.equal(result.length, source.length);
  const lifted = [];
  result.forEach((feature, index) => {
    const original = source[index];
    assert.deepEqual(feature.geometry, original.geometry, `geometry must survive: ${original.properties.osmId}`);
    for (const [key, value] of Object.entries(original.properties)) {
      assert.equal(feature.properties[key], value, `source property must survive: ${original.properties.osmId}/${key}`);
    }
    if (original.properties.heightSource === 'estimate') {
      assert.notStrictEqual(feature, original, 'lifted features are new objects');
      assert.equal(feature.properties.displayHeight, expectedDisplay(feature),
        `displayHeight follows the outline envelope and adds the exact base: ${original.properties.osmId}`);
      lifted.push(feature);
    } else {
      assert.strictEqual(feature, original, 'a known height is drawn from the source number, untouched');
      assert.equal('displayHeight' in feature.properties, false, `no invented field on ${original.properties.osmId}`);
    }
  });
  return lifted;
}

test('both display paths share one thickness curve', () => {
  assert.deepEqual([[20, 9.6], [40, 9.6], [61.3, 14.7], [99.5, 23.9], [100, 24], [140, 24]].map(([short]) => [short, schematicThickness(short)]),
    [[20, 9.6], [40, 9.6], [61.3, 14.7], [99.5, 23.9], [100, 24], [140, 24]], 'the clamp and its rounding are the single source');
  const shared = building('shared', [0, 0, 61.3, 61.3], { heightSource: 'estimate', height: 9.6, base: 0 });
  assert.equal(schematicDisplayHeights([shared], { center: cantonCenter })[0].properties.displayHeight,
    schematicThickness(61.3), 'a per-building outline and a block envelope of the same short side display the same depth');
});

test('per-building display heights lift only the placeholders, on either axis and past concave envelopes', () => {
  const placeholder = (id, box, base) => building(id, box, { heightSource: 'estimate', height: 9.6, base });
  const fixtures = [
    placeholder('short-is-x', [0, 0, 20, 61.3], 0),
    placeholder('short-is-y', [100, 0, 613, 61.3], 3.25),
    placeholder('wide-cap', [800, 0, 1000, 140], 6),
  ];
  // An L-shaped outline is measured on its envelope, exactly like a rectangle of the same envelope.
  const concave = placeholder('concave', [1100, 0, 1220, 61.3], 0);
  concave.geometry = { type: 'Polygon', coordinates: [[
    [1100, 0], [1220, 0], [1220, 61.3], [1160, 61.3], [1160, 20], [1100, 20], [1100, 0],
  ].map(([u, v]) => toGeo([u, v]))] };
  const known = [
    building('known-height', [1400, 0, 1460, 20], { heightSource: 'height', height: 88.75, base: 4.2 }),
    building('known-levels', [1500, 0, 1560, 20], { heightSource: 'levels', height: 96, base: 0, levels: 30 }),
  ];
  const features = [...fixtures, concave, ...known];
  const before = structuredClone(features);
  const result = schematicDisplayHeights(features, { center: cantonCenter });
  assertSchematic(result, features);
  assert.deepEqual(result.slice(0, 4).map(feature => feature.properties.displayHeight),
    [9.6, 3.25 + 14.7, 6 + 24, 14.7], 'lower bound, linear band, upper bound and the concave envelope');
  known.forEach((feature, index) => assert.strictEqual(result[4 + index], feature,
    'a tagged or level-derived height is returned untouched'));
  assert.deepEqual(features, before, 'the input snapshot must not be modified');
  assert.deepEqual(schematicDisplayHeights(features, { center: cantonCenter }), result, 'same input yields the same field');
});

test('the shipped canton snapshot lifts 410 of its 2,920 placeholders and leaves 1,070 known heights alone', () => {
  const snapshot = readJSON('public/data/canton-buildings.geojson');
  const before = structuredClone(snapshot.features);
  const result = schematicDisplayHeights(snapshot.features, { center: cantonCenter });
  const lifted = assertSchematic(result, snapshot.features);
  assert.deepEqual(snapshot.features, before, 'the published file must be read, never rewritten');
  assert.equal(snapshot.features.length, 3990);
  assert.equal(lifted.length, 2920, 'every placeholder gets exactly one display height');
  assert.equal(result.length - lifted.length, 1070, 'tagged and level-derived heights stay on their source numbers');
  const values = lifted.map(feature => feature.properties.displayHeight);
  assert.equal(new Set(values).size, 105, 'the lifted placeholders are no longer one flat number');
  const bins = [0, 0, 0, 0, 0];
  for (const value of values) bins[value <= 9.6 ? 0 : value < 13 ? 1 : value < 17 ? 2 : value < 21 ? 3 : 4]++;
  assert.deepEqual(bins, [2510, 216, 116, 52, 26], 'lower bound, three middle bands and upper bound');
  assert.equal(Math.max(...result.filter(f => f.properties.heightSource !== 'estimate').map(f => f.properties.height)), 530);
});

test('displayHeight assertions kill coefficient/floor/cap/rounding/guard/long-side mutants', async t => {
  const snapshot = readJSON('public/data/canton-buildings.geojson');
  const correct = schematicDisplayHeights(snapshot.features, { center: cantonCenter });
  for (const [name, from, to] of [
    ['coefficient', 'shortSide * 0.24', 'shortSide * 0.3'],
    ['floor', 'Math.max(9.6, shortSide', 'Math.max(8, shortSide'],
    ['cap', 'Math.min(24, Math.max', 'Math.min(30, Math.max'],
    ['rounding', 'Math.round(Math.min', 'Math.floor(Math.min'],
    ['long side', 'const side = Math.min(', 'const side = Math.max('],
    ['known heights', "!== 'estimate') return feature;", "!== 'estimate') return { ...feature, properties: { ...feature.properties, displayHeight: feature.properties.height } };"],
    ['placeholder guard', "!== 'estimate') return feature;", "=== 'estimate') return feature;"],
  ]) await t.test(name, async () => {
    const mutant = await mutatedLayout(from, to);
    const broken = mutant.schematicDisplayHeights(snapshot.features, { center: cantonCenter });
    assert.notDeepEqual(broken, correct, 'the mutant must change the derived field');
    assert.throws(() => assertSchematic(broken, snapshot.features), /displayHeight follows|new objects|invented field|untouched|must survive/,
      'the same positive assertion must reject the defect');
  });
  assert.deepEqual(schematicDisplayHeights(snapshot.features, { center: cantonCenter }), correct);
});

test('height assertions kill coefficient/cap/floor/long-side/base/source-height/known-height mutants', async t => {
  const specs = [
    ['floor', 20, { heightSource: 'estimate' }], ['linear', 61.3, { heightSource: 'estimate' }],
    ['rounds-up', 61.5, { heightSource: 'estimate' }],
    ['cap', 120, { heightSource: 'estimate' }], ['tag', 61.3, { heightSource: 'tag', height: 73.25 }],
    ['levels', 61.3, { heightSource: 'levels', height: 96, levels: 30 }],
  ];
  const entries = specs.map(([id, short, properties], i) => entry([layoutBuilding(id,
    cornersOfBox([i * 400, 0, i * 400 + 200, short]), { ...properties, base: 3.25 })]));
  const snapshot = structuredClone(entries), correct = layoutBlocks(entries, { center });
  assertProperties(correct, entries);
  for (const [name, from, to, message] of [
    ['coefficient', 'shortSide * 0.24', 'shortSide * 0.3', /displayHeight follows/],
    ['cap', 'Math.min(24, Math.max', 'Math.min(30, Math.max', /displayHeight follows/],
    ['floor', 'Math.max(9.6, shortSide', 'Math.max(8, shortSide', /displayHeight follows/],
    ['long side', 'const shortSide = Math.min(', 'const shortSide = Math.max(', /displayHeight follows/],
    ['base', '? p.base + thickness :', '? thickness :', /displayHeight follows/],
    ['source height', 'schematic: true, displayHeight', 'schematic: true, displayHeight, height: displayHeight', /all source properties/],
    ['known height', ': p.height;', ': p.base + thickness;', /displayHeight follows/],
    ['rounding', 'Math.round(Math.min', 'Math.floor(Math.min', /displayHeight follows/],
  ]) await t.test(name, async () => {
    const mutant = await mutatedLayout(from, to), broken = mutant.layoutBlocks(entries, { center });
    assert.deepEqual(broken.map(feature => feature.geometry), correct.map(feature => feature.geometry), 'height-only defect');
    assert.throws(() => assertProperties(broken, entries), message, 'the same positive assertion must reject the defect');
  });
  assert.deepEqual(layoutBlocks(entries, { center }), correct);
  assert.deepEqual(entries, snapshot);
});

test('overlapping envelopes are separated, including a contained envelope', () => {
  const entries = [entry([building('wide', [0, 0, 100, 80])]), entry([building('right', [70, 20, 150, 90])]),
    entry([building('contained', [10, 15, 25, 30])])];
  assert.throws(() => assertSeparated(entries.map(entry => entry.shape)), { code: 'ERR_ASSERTION' });
  const features = layoutBlocks(entries, { center });
  features.forEach(assertRectangle);
  assertSeparated(features);
  assertProperties(features, entries);
});

test('road endpoint and collinear contacts count as barriers, but disjoint extensions do not', async () => {
  const check = intersects => {
    for (const [p, q] of [[[5, -5], [5, 0]], [[5, 0], [5, 5]], [[2, 0], [8, 0]], [[10, 0], [12, 0]]]) {
      assert.equal(intersects([0, 0], [10, 0], p, q), true, 'contact is a barrier');
    }
    assert.equal(intersects([0, 0], [10, 0], [11, 0], [12, 0]), false);
    assert.equal(intersects([0, 0], [10, 0], [5, 1], [5, 5]), false);
  };
  check(crosses);
  const mutant = await mutatedLayout('return (abp * abq < 0 && pqa * pqb < 0) ||', 'return (abp * abq < 0 && pqa * pqb < 0); false ||');
  assert.throws(() => check(mutant.crosses), /contact is a barrier/);
});

test('distinct groups with coincident interior anchors still require non-overlapping display shapes', () => {
  // Distinct, long footprints share a centre; the default 280 m cap correctly keeps them in separate groups.
  const buildings = [building('same-anchor-a', [0, 0, 320, 40]), building('same-anchor-b', [10, -10, 310, 50])];
  const grouping = groupBuildings(buildings, { center });
  assert.equal(grouping.groups.length, 2);
  const display = groupDisplay(grouping);
  assert.equal(display.byMember.size, 2);
  assertSeparated(display.features);
});

const roadCases = [
  ['through road', [[75, -30], [75, 90]]],
  ['short road wholly inside the uncut block', [[70, 20], [80, 20]]],
  ['dead-end with its endpoint inside the block', [[75, -30], [75, 15]]],
];
for (const [name, points] of roadCases) test(`${name} stays outside the schematic block`, () => {
  const entries = [entry([building('road-block', [0, 0, 100, 60])])], roads = [road(1, points)];
  const plain = layoutBlocks(entries, { center });
  assert.throws(() => assertRoadsOutside(plain, roads), { code: 'ERR_ASSERTION' }, 'fixture must actually be obstructed without road clipping');
  const options = { center, roads }, before = structuredClone({ entries, options });
  const features = layoutBlocks(entries, options);
  assertRoadsOutside(features, roads);
  assertProperties(features, entries);
  assert.deepEqual({ entries, options }, before);
  if (name.startsWith('dead-end')) {
    assert.ok(segmentEnters(validConvex(features[0]), [80, 50], [80, 50]),
      'a point beyond the dead-end survives: do not extend the road into an infinite barrier');
  }
});

test('campus interior is excluded even when completely contained, in either ring winding', () => {
  const entries = [entry([building('campus-block', [0, 0, 100, 60])])];
  const campusGeometry = boxGeometry([70, 15, 90, 45]);
  assert.throws(() => assertCampusOutside(layoutBlocks(entries, { center }), campusGeometry), { code: 'ERR_ASSERTION' });
  for (const reverse of [false, true]) {
    const campus = structuredClone(campusGeometry);
    if (reverse) campus.coordinates[0].reverse();
    const before = structuredClone(campus);
    const features = layoutBlocks(entries, { center, campusGeometry: campus });
    assertCampusOutside(features, campusGeometry);
    assertProperties(features, entries);
    assert.deepEqual(campus, before);
  }
});

test('layout is stable under entry/member/road shuffles and does not mutate any input', () => {
  const entries = [entry([building('a', [0, 0, 30, 30]), building('b', [45, 20, 100, 70])]),
    entry([building('c', [80, 40, 150, 100])]), entry([building('d', [300, 0, 330, 20])])];
  const options = { center, roads: [road(1, [[70, -40], [70, 130]]), road(2, [[-50, 60], [200, 60]])],
    campusGeometry: boxGeometry([200, 200, 240, 240]) };
  const before = structuredClone({ entries, options });
  const baseline = layoutBlocks(entries, options);
  assertSeparated(baseline);
  assertRoadsOutside(baseline, options.roads);
  assertCampusOutside(baseline, options.campusGeometry);
  assert.deepEqual(layoutBlocks(entries, options), baseline);
  assert.deepEqual(canonicalFeatures(layoutBlocks([...entries].reverse(), options)), canonicalFeatures(baseline), 'entry order');
  const shuffled = entries.map(({ shape, members }) => ({ shape, members: [...members].reverse() }));
  assert.deepEqual(canonicalFeatures(layoutBlocks(shuffled, options)), canonicalFeatures(baseline), 'member order');
  const reversedSegments = options.roads.map(feature => ({ ...feature,
    geometry: { ...feature.geometry, coordinates: [...feature.geometry.coordinates].reverse() } }));
  assert.deepEqual(canonicalFeatures(layoutBlocks(entries, { ...options, roads: reversedSegments })), canonicalFeatures(baseline), 'segment direction');
  const reverseRoadOrder = layoutBlocks(entries, { ...options, roads: [...options.roads].reverse() });
  assert.deepEqual({ entries, options }, before);
  assert.deepEqual(canonicalFeatures(reverseRoadOrder), canonicalFeatures(baseline), 'road feature order');
});

const rawWay = (id, tags = {}, points = [[75, -30], [75, 90]]) => ({ type: 'way', id,
  tags: { highway: 'residential', ...tags }, geometry: points.map(point => { const [lon, lat] = toGeo(point); return { lon, lat }; }) });

test('road extraction keeps only eligible ground-level highway ways with deterministic order and coordinates', () => {
  const included = [rawWay(10), rawWay(2, { highway: 'primary_link', bridge: 'no', tunnel: 'no', layer: '0' }),
    rawWay(7, { highway: 'tertiary', layer: 0 })];
  const excluded = [rawWay(100, { bridge: 'yes' }), rawWay(101, { bridge: 'viaduct' }), rawWay(102, { tunnel: 'yes' }),
    rawWay(103, { tunnel: 'building_passage' }), rawWay(104, { layer: '1' }), rawWay(105, { layer: '-1' }),
    rawWay(106, { layer: 'unknown' }), rawWay(107, { highway: 'footway' }), rawWay(108, { highway: 'service' }),
    rawWay(109, { highway: 'residential_fake' }), { ...rawWay(110), type: 'node' }, { ...rawWay(111), type: 'relation' },
    { ...rawWay(112), tags: {} }];
  const raw = { elements: [...excluded, ...included] }, before = structuredClone(raw);
  const result = blockRoads(raw);
  assert.equal(result.type, 'FeatureCollection');
  assert.deepEqual(result.features.map(feature => feature.id), [2, 7, 10]);
  for (const feature of result.features) {
    const source = included.find(element => element.id === feature.id);
    assert.deepEqual(feature.geometry, { type: 'LineString', coordinates: source.geometry.map(({ lon, lat }) => [lon, lat]) });
    assert.equal(feature.properties.osmId, source.id);
    assert.equal(feature.properties.highway, source.tags.highway);
  }
  assert.deepEqual(blockRoads({ elements: [...raw.elements].reverse() }), result);
  assert.deepEqual(raw, before);
  for (const highway of ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified']) {
    for (const suffix of ['', '_link']) assert.equal(blockRoads({ elements: [rawWay(1, { highway: highway + suffix })] }).features.length, 1);
  }
});

test('bridge/tunnel/layer filtering controls barriers, and road widths are only schematic whitespace', () => {
  const entries = [entry([building('road-block', [0, 0, 100, 60])])];
  const plain = layoutBlocks(entries, { center });
  for (const tags of [{ bridge: 'yes' }, { tunnel: 'yes' }, { layer: '1' }, { layer: '-1' }]) {
    const roads = blockRoads({ elements: [rawWay(1, tags)] }).features;
    assert.equal(roads.length, 0);
    assert.deepEqual(layoutBlocks(entries, { center, roads }), plain, 'non-ground ways cannot carve blocks');
  }
  const ground = blockRoads({ elements: [rawWay(1, { bridge: 'no', tunnel: 'no', layer: '0' })] }).features;
  const clipped = layoutBlocks(entries, { center, roads: ground });
  assertRoadsOutside(clipped, ground);
  assert.notDeepEqual(clipped, plain);
  const withWidths = ground.map(feature => ({ ...feature, properties: { ...feature.properties, width: 120, lanes: 12 } }));
  assert.deepEqual(layoutBlocks(entries, { center, roads: withWidths }), clipped,
    'OSM width/lanes must not be presented as measured schematic road width');
});

test('served roads reproduce exactly from the local OSM source without network access', () => {
  const raw = readJSON('data/jingtai-overpass.json'), before = structuredClone(raw);
  const served = readJSON('public/data/jingtai-roads.geojson');
  const expected = blockRoads(raw);
  assert.equal(expected.features.length, 1011);
  assert.equal(new Set(expected.features.map(feature => feature.id)).size, 1011);
  assert.deepEqual(expected.features, served.features);
  assert.equal(served.type, expected.type);
  assert.deepEqual(blockRoads({ ...raw, elements: [...raw.elements].reverse() }), expected);
  assert.deepEqual(raw, before);
  assert.equal(served.source.input, 'data/jingtai-overpass.json');
  assert.match(served.source.purpose, /不代表.*实测路宽/);
});

test('category filtering happens before layout, so a hidden overlapping group cannot carve a visible block', () => {
  const visible = building('visible', [0, 0, 100, 60]);
  const hidden = building('hidden', [70, 20, 150, 80], { category: 'commercial' });
  // A tiny span cap keeps these deliberately overlapping members in separate groups.
  const grouping = groupBuildings([visible, hidden], { center, maxSpanMeters: 1 });
  assert.equal(grouping.groups.length, 2);
  const before = structuredClone(grouping.groups);
  const all = groupDisplay(grouping), filtered = groupDisplay(grouping, 'residential');
  const alone = layoutBlocks([entry([visible])], { center });
  assert.deepEqual(filtered.features, alone, 'filter first; hidden geometry cannot affect the visible layout');
  assert.deepEqual([...filtered.byMember.keys()], ['visible']);
  assert.strictEqual(filtered.byMember.get('visible'), filtered.features[0]);
  assert.notDeepEqual(all.byMember.get('visible').geometry, filtered.features[0].geometry, 'fixture detects layout-before-filter');
  assertSeparated(all.features);
  assert.deepEqual(grouping.groups, before);
});

test('every real displayed shape is finite, closed, convex and nondegenerate', () => {
  const { display } = realScene();
  assert.equal(display.features.length, 472);
  assert.equal(display.byMember.size, 5686);
  for (const feature of display.features) {
    assert.equal(feature.properties.schematic, true);
    validConvex(feature);
  }
});

test('all 472 real display shapes are pairwise non-overlapping by independent SAT', () => {
  assertSeparated(realScene().display.features);
});

test('reversing real road order must not alter the geometry of any displayed group', () => {
  const { grouping, display, options } = realScene();
  const before = structuredClone(options);
  const reverse = groupDisplay({ ...grouping, layout: { ...options, roads: [...options.roads].reverse() } });
  assert.deepEqual(options, before);
  assert.deepEqual([...reverse.byMember.keys()].sort(), [...display.byMember.keys()].sort());
  const changed = display.features.flatMap((feature, index) => {
    assert.deepEqual(reverse.features[index].properties, feature.properties);
    return JSON.stringify(canonicalVertices(reverse.features[index])) === JSON.stringify(canonicalVertices(feature))
      ? [] : [feature.properties.osmId];
  });
  assert.deepEqual(changed, [], 'same roads, members and parameters must yield the same schematic geometry');
});

test('none of the 1011 served road centrelines enters a real display shape', () => {
  const { display, options } = realScene();
  assertRoadsOutside(display.features, options.roads);
});

test('the target campus never overlaps a real display shape', () => {
  const { display, options } = realScene();
  assertCampusOutside(display.features, options.campusGeometry);
});

for (const category of ['unknown', 'commercial', 'public', 'residential']) test(`real ${category} lens keeps every selected member and all geometric exclusions`, () => {
  const { buildings, grouping, options } = realScene();
  const before = structuredClone({ buildings, options });
  const display = groupDisplay(grouping, category);
  const expected = buildings.filter(feature => feature.properties.category === category);
  assert.deepEqual([...display.byMember.keys()].sort(), expected.map(feature => String(feature.properties.osmId)).sort());
  assert.ok(display.features.length > 0);
  display.features.forEach(feature => assert.equal(feature.properties.schematic, true));
  assertSeparated(display.features);
  assertRoadsOutside(display.features, options.roads);
  assertCampusOutside(display.features, options.campusGeometry);
  assert.deepEqual({ buildings, options }, before);
});

test('independent predicates reject in-memory broken geometries, including containment and short internal roads', () => {
  const square = building('square', [0, 0, 100, 100]);
  validConvex(square);
  const points = validConvex(square);
  assert.ok(segmentEnters(points, [10, 10], [20, 10]));
  assert.ok(segmentEnters(points, [-10, 50], [110, 50]));
  assert.ok(segmentEnters(points, [-10, 50], [10, 50]));
  assert.ok(!segmentEnters(points, [-10, 0], [110, 0]), 'boundary-only contact is not interior');
  assert.ok(!segmentEnters(points, [110, 20], [120, 20]));
  assertSeparated([square, building('touching', [100, 0, 120, 20])]);
  for (const [name, geometry] of [
    ['open', { type: 'Polygon', coordinates: [square.geometry.coordinates[0].slice(0, -1)] }],
    ['nonfinite', polygon([[0, 0], [NaN, 0], [10, 10]])],
    ['zero area', polygon([[0, 0], [10, 0], [20, 0]])],
    ['concave', polygon([[0, 0], [100, 0], [20, 20], [100, 100], [0, 100]])],
    ['self-crossing', polygon([[0, 0], [100, 100], [0, 100], [100, 0]])],
  ]) assert.throws(() => validConvex({ ...square, geometry }), { code: 'ERR_ASSERTION' }, name);
  assert.throws(() => assertRectangle(square), { code: 'ERR_ASSERTION' }, 'wrong bearing is not accepted as regularization');
  assert.throws(() => assertSeparated([square, building('contained', [10, 10, 20, 20])]), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertRoadsOutside([square], [road(1, [[10, 10], [20, 10]])]), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertCampusOutside([square], boxGeometry([10, 10, 20, 20])), { code: 'ERR_ASSERTION' });
});

test('positive geometric assertions kill no-road/no-campus/no-separation and wrong-height source mutants', async t => {
  const one = [entry([building('a', [0, 0, 100, 60])])];
  const roads = [road(1, [[70, 20], [80, 20]])], campusGeometry = boxGeometry([70, 15, 90, 45]);
  const two = [...one, entry([building('b', [70, 20, 150, 80])])];
  for (const [name, from, to, entries, options, check] of [
    ['roads', 'segmentsOf(roads).map(segment', 'segmentsOf([]).map(segment', one, { center, roads }, features => assertRoadsOutside(features, roads)],
    ['campus', 'if (planes) {', 'if (false) {', one, { center, campusGeometry }, features => assertCampusOutside(features, campusGeometry)],
    ['separation', 'for (const other of items) {', 'for (const other of []) {', two, { center }, assertSeparated],
    ['height', 'schematic: true', 'schematic: true, height: 999', one, { center }, features => assertProperties(features, one)],
  ]) await t.test(name, async () => {
    check(layoutBlocks(entries, options));
    const mutant = await mutatedLayout(from, to);
    const broken = mutant.layoutBlocks(entries, options);
    assert.throws(() => check(broken), { code: 'ERR_ASSERTION' }, `${name} mutant must fail the same positive assertion`);
  });
});

test('acute fixtures after road/campus clipping exercise both retreat caps and kill the no-chamfer mutant', async t => {
  const baselineLayout = await noRefinement();
  const noChamfer = await mutatedLayout('if ((a[0] * b[0] + a[1] * b[1]) / (la * lb) <= 0.5) continue;', 'if (true) continue;');
  const noTrim = await mutatedLayout('if (trim > 0) {', 'if (false) {');
  for (const barrier of ['road', 'campus']) for (const scale of [1, 0.1]) await t.test(`${barrier}, scale ${scale}`, () => {
    const scaled = points => points.map(([x, y]) => [x * scale, y * scale]);
    const entries = [entry([layoutBuilding('acute', scaled([[0, 0], [100, 0], [100, 50]]))]),
      entry([layoutBuilding('ordinary-neighbour', scaled(cornersOfBox([140, 0, 160, 10])))])];
    const roads = [road(1, scaled([[-20, -10], [120, 60]]).map(fromLayout))];
    const campusGeometry = layoutPolygon(scaled([[-20, -10], [120, 60], [120, 160], [-20, 90]]));
    const options = { center, ...(barrier === 'road' ? { roads } : { campusGeometry }) };
    const snapshot = structuredClone({ entries, options });
    const plain = baselineLayout.layoutBlocks(entries, { center });
    assert.throws(() => barrier === 'road' ? assertRoadsOutside(plain, roads) : assertCampusOutside(plain, campusGeometry),
      { code: 'ERR_ASSERTION' }, 'the barrier must actually cut this fixture');
    const baseline = baselineLayout.layoutBlocks(entries, options), features = layoutBlocks(entries, options);
    const check = shapes => assertChamfer(shapes, baseline, entries, options);
    const cut = check(features);
    if (scale === 1) assert.equal(cut, 3, 'long edges exercise the 3 m cap');
    else assert.ok(cut > 0 && cut < 3, 'short edges exercise the 15% cap');
    assert.deepEqual(canonicalVertices(features[1]), canonicalVertices(baseline[1]), 'ordinary neighbour is not chamfered');
    assert.deepEqual(canonicalFeatures(noTrim.layoutBlocks(entries, options)), canonicalFeatures(features), 'acute fixture is independent of trimming');
    for (const mutant of [baselineLayout, noChamfer]) {
      assert.throws(() => check(mutant.layoutBlocks(entries, options)), /acute-corner refinement must remove/,
        'the same positive chamfer assertion must reject disabled refinement');
    }
    assert.deepEqual({ entries, options }, snapshot);
  });
});

test('narrow fixtures trim both ends on either -15-degree axis and kill the no-trim mutant', async t => {
  const baselineLayout = await noRefinement();
  const noTrim = await mutatedLayout('if (trim > 0) {', 'if (false) {');
  const noChamfer = await mutatedLayout('if ((a[0] * b[0] + a[1] * b[1]) / (la * lb) <= 0.5) continue;', 'if (true) continue;');
  for (const axis of [0, 1]) for (const length of [91, 130]) await t.test(`axis ${axis}, length ${length} m`, () => {
    // Origin-centred coordinates avoid interiorPoint rounding perturbing the analytic 13 m clearance.
    const orient = points => points.map(([u, v]) => axis === 0 ? [u - length / 2, v - 10] : [v - 10, u - length / 2]);
    const entries = [entry([layoutBuilding('strip', orient(cornersOfBox([0, 0, length, 20])))]),
      entry([layoutBuilding('ordinary-neighbour', orient(cornersOfBox([length + 30, 0, length + 45, 10])))])];
    const roads = [road(1, orient([[-20, 16], [length + 20, 16]]).map(fromLayout))];
    const campusGeometry = layoutPolygon(orient(cornersOfBox([-20, 16, length + 20, 50])));
    const options = { center, ...(axis === 0 ? { roads } : { campusGeometry }) };
    const snapshot = structuredClone({ entries, options });
    const plain = baselineLayout.layoutBlocks(entries, { center });
    assert.throws(() => axis === 0 ? assertRoadsOutside(plain, roads) : assertCampusOutside(plain, campusGeometry), { code: 'ERR_ASSERTION' });
    const baseline = baselineLayout.layoutBlocks(entries, options), features = layoutBlocks(entries, options);
    assert.ok(Math.abs(measurements(baseline[0]).widths[1 - axis] - 13) <= EPS, 'the barrier clips the short side from 20 m to 13 m');
    const check = shapes => assertStripTrim(shapes, baseline, entries, options);
    check(features);
    assert.ok(Math.abs(measurements(features[0]).aspect - (length === 91 ? 6 : 7.6)) <= ANGLE_EPS,
      'ratio 7 reaches 6; ratio 10 uses the 12%-per-end cap, not an invented hard ratio limit');
    assert.deepEqual(canonicalVertices(features[1]), canonicalVertices(baseline[1]));
    assert.deepEqual(canonicalFeatures(noChamfer.layoutBlocks(entries, options)), canonicalFeatures(features), 'strip fixture is independent of chamfering');
    for (const mutant of [baselineLayout, noTrim]) {
      assert.throws(() => check(mutant.layoutBlocks(entries, options)), /narrow-strip refinement must reduce/,
        'the same positive aspect assertion must reject disabled trimming');
    }
    assert.deepEqual({ entries, options }, snapshot);
  });
});

test('ordinary rectangles up to ratio six are unchanged, and containment rejects a smaller translated polygon', async () => {
  const baselineLayout = await noRefinement();
  const entries = [2, 5.9, 6].map((ratio, i) => entry([layoutBuilding(`ordinary-${i}`, cornersOfBox([i * 200, 0, i * 200 + ratio * 10, 10]))]));
  const baseline = baselineLayout.layoutBlocks(entries, { center }), features = layoutBlocks(entries, { center });
  assertOnlyShrinks(features, baseline, entries, { center });
  features.forEach(assertRectangle);
  assert.deepEqual(canonicalFeatures(features), canonicalFeatures(baseline), 'normal rectangles are neither trimmed nor chamfered');
  const outer = [[0, 0], [10, 0], [0, 10]], inner = [[1, 1], [3, 1], [1, 3]];
  assertContained(inner, outer);
  const shifted = inner.map(([x, y]) => [x + 7, y]);
  assert.ok(Math.abs(signedArea(shifted)) < Math.abs(signedArea(outer)));
  assert.ok(shifted.every(([x, y]) => x >= 0 && x <= 10 && y >= 0 && y <= 10));
  assert.throws(() => assertContained(shifted, outer), /every baseline half-plane/, 'less area and an unchanged bbox are insufficient');
});

test('real refinement is shrink-only in every lens, preserves properties/mapping and reports all/near500m improvements', async t => {
  const { buildings, grouping, display: allDisplay, options } = realScene();
  const snapshot = structuredClone({ buildings, groups: grouping.groups, rules: grouping.rules, options });
  assert.deepEqual(grouping.rules, { gapMeters: 45, maxSpanMeters: 280 });
  const baselineLayout = await noRefinement();
  for (const category of ['all', 'unknown', 'commercial', 'public', 'residential']) await t.test(category, () => {
    const entries = layoutEntries(grouping, category), entriesBefore = structuredClone(entries);
    const display = category === 'all' ? allDisplay : groupDisplay(grouping, category);
    const baseline = baselineLayout.layoutBlocks(entries, options);
    assertMemberMapping(display, entries);
    const pairs = assertOnlyShrinks(display.features, baseline, entries, options);
    const summary = refinementSummary(pairs);
    t.diagnostic(`${category}: ${JSON.stringify(summary)}`);
    const expectedAffected = { all: 12, unknown: 7, commercial: 0, public: 3, residential: 1 }[category];
    const eligible = pairs.filter(({ before }) => before.minAngle < 60 - ANGLE_EPS || before.aspect > 6 + ANGLE_EPS)
      .map(({ feature }) => feature.properties.osmId);
    assert.equal(eligible.length, expectedAffected, 'snapshot trigger count, not a target to reduce group counts');
    const assertProgress = shapes => {
      const checked = assertOnlyShrinks(shapes, baseline, entries, options);
      assert.deepEqual(checked.filter(pair => pair.changed).map(({ feature }) => feature.properties.osmId), eligible,
        'real refinement must change exactly the eligible shapes');
      for (const { before, after, changed } of checked) {
        if (before.minAngle < 60 - ANGLE_EPS) assert.ok(after.minAngle >= 60 - ANGLE_EPS, 'real acute corners are removed');
        if (before.aspect > 6 + ANGLE_EPS) assert.ok(after.aspect < before.aspect - ANGLE_EPS, 'real narrow aspect ratios improve');
        if (before.minAngle >= 60 + ANGLE_EPS && before.aspect < 6 - ANGLE_EPS) assert.equal(changed, false, 'ordinary real shapes stay untouched');
      }
    };
    assertProgress(display.features);
    if (expectedAffected) assert.throws(() => assertProgress(baseline), /real refinement must change exactly/,
      'the same positive assertion rejects the no-refinement mutant in every lens with eligible shapes');
    else assert.deepEqual(canonicalFeatures(display.features), canonicalFeatures(baseline), 'a lens with no eligible shapes stays entirely unchanged');
    if (category === 'all') {
      assert.equal(summary.affected, 12);
      assert.equal(summary.acuteBefore, 12);
      assert.equal(summary.acuteAfter, 0);
      assert.equal(summary.stripsBefore, 1);
      assert.equal(summary.stripsAfter, 0);
      assert.ok(Math.abs(summary.areaLossM2 - 252.432433) < 0.001, 'reproducible measured area loss, in square metres');
      assert.equal(pairs.length, 472, 'refinement must not reduce the number of groups');
      assert.equal(display.byMember.size, 5686);
      // near500m means a group has at least one original member within 500 m, not a moved display centroid.
      const nearIds = new Set(grouping.groups.filter(group => group.features.some(feature => feature.properties.distance <= 500))
        .map(group => groupShape(group.features).properties.osmId));
      const near = pairs.filter(pair => nearIds.has(pair.feature.properties.osmId));
      assert.equal(near.length, 55);
      const nearSummary = refinementSummary(near);
      assert.equal(nearSummary.affected, 3, 'three original near500m groups really shrink');
      assert.equal(nearSummary.acuteBefore, 3);
      assert.equal(nearSummary.acuteAfter, 0);
      assert.equal(nearSummary.stripsBefore, 1);
      assert.equal(nearSummary.stripsAfter, 0);
      assert.ok(Math.abs(nearSummary.areaLossM2 - 229.600708) < 0.001);
      t.diagnostic(`near500m: ${JSON.stringify(nearSummary)}`);
    }
    assert.deepEqual(entries, entriesBefore);
  });
  assert.deepEqual({ buildings, groups: grouping.groups, rules: grouping.rules, options }, snapshot);
});

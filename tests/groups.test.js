import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insideRing } from '../src/buildings.js';
import { vertexList } from '../src/footprints.js';
import { METERS_PER_DEGREE } from '../src/geo.js';
import { SCENES } from '../src/scenes.js';
import { GROUP_RULES, groupBuildings, groupDisplay, groupShape, groupStats } from '../src/groups.js';

const root = new URL('../', import.meta.url);
const center = SCENES.jingtai.center;
const kx = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
// Metres offset from the scene centre, so a rule's threshold reads as itself: box [20, -5, 40, 5] is a 20 × 10 m block
// whose west edge sits 20 m east of the centre.
const ringOf = ([west, south, east, north]) => [[west, south], [east, south], [east, north], [west, north], [west, south]]
  .map(([x, y]) => [Number((center.lng + x / kx).toFixed(7)), Number((center.lat + y / METERS_PER_DEGREE).toFixed(7))]);
const block = (osmId, box, properties = {}) => ({
  type: 'Feature',
  properties: { osmId, area: 200, distance: 100, category: 'residential', height: 12, base: 0, heightSource: 'estimate', ...properties },
  geometry: { type: 'Polygon', coordinates: [ringOf(box)] },
});
const group = (result, osmId) => result.groupOf(osmId);
const partitionOf = (result) => result.groups.map((entry) => entry.members.join(',')).sort().join('|');
// A row of n blocks, each 20 m wide and 10 m from the next: its east-west extent is n*30 - 10.
const row = (n) => Array.from({ length: n }, (_, i) => block(String(i + 1), [i * 30, -5, i * 30 + 20, 5]));
const rules = { center };
const readJSON = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const served = readJSON('public/data/jingtai-buildings.geojson');
const roads = readJSON('public/data/jingtai-roads.geojson').features;
const campusGeometry = readJSON('public/data/jingtai-grounds.geojson').features
  .find(feature => feature.properties.kind === 'campus' && feature.properties.target).geometry;
// These measured counts apply ONLY to the formal road/campus-aware scene parameters.
const formal = { center: { lat: 23.17107, lng: 113.26646 }, roads, campusGeometry };
let snapshotGrouping;
const shippedGrouping = () => snapshotGrouping ??= groupBuildings(served.features, formal);
const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const convexRingOf = (feature) => {
  assert.equal(feature.geometry.type, 'Polygon');
  assert.equal(feature.geometry.coordinates.length, 1);
  const [ring] = feature.geometry.coordinates;
  assert.ok(ring.length >= 4);
  assert.deepEqual(ring.at(-1), ring[0], 'the convex ring must be closed');
  const vertices = ring.slice(0, -1);
  assert.ok(vertices.every(point => point.every(Number.isFinite)));
  const orientation = Math.sign(turn(...vertices.slice(0, 3)));
  assert.ok(vertices.every((point, i) => orientation * turn(point,
    vertices[(i + 1) % vertices.length], vertices[(i + 2) % vertices.length]) > 0), 'every corner must turn the same way');
  return ring;
};

test('the shipped rule is what the card text will quote', () => {
  assert.deepEqual(GROUP_RULES, { gapMeters: 45, maxSpanMeters: 280 });
});

test('gaps immediately below and above 45 m merge and split respectively', () => {
  for (const [gapMeters, count] of [[44.9, 1], [45.1, 2]]) {
    const list = [block('1', [0, -5, 20, 5]), block('2', [20 + gapMeters, -5, 40 + gapMeters, 5])];
    const actualGap = (list[1].geometry.coordinates[0][0][0] - list[0].geometry.coordinates[0][1][0]) * kx;
    assert.ok(Math.abs(actualGap - gapMeters) < 0.02, 'the fixture really straddles 45 m after coordinate rounding');
    assert.equal(groupBuildings(list, rules).groups.length, count);
    assert.equal(groupBuildings(list, { ...rules, gapMeters: 46 }).groups.length, 1,
      'explicitly widening only the gap must join the above-threshold pair');
  }
});

test('the diagonal span cap distinguishes 279.9 m from 280.1 m and stops chaining', () => {
  for (const [span, count] of [[279.9, 1], [280.1, 2]]) {
    const width = Math.sqrt(span ** 2 - 10 ** 2);
    const list = [block('1', [0, -5, 120, 5]), block('2', [width - 120, -5, width, 5])];
    const points = list.flatMap(feature => vertexList(feature.geometry));
    const actualSpan = Math.hypot((Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]))) * kx,
      (Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]))) * METERS_PER_DEGREE);
    assert.ok(Math.abs(actualSpan - span) < 0.02, 'unrounded diagonal, not the rounded group.span, straddles 280 m');
    assert.equal(groupBuildings(list, rules).groups.length, count);
    assert.equal(groupBuildings(list, { ...rules, maxSpanMeters: 281 }).groups.length, 1,
      'explicitly widening only the span must join the above-threshold pair');
  }
  const chained = groupBuildings(row(11), rules);
  assert.ok(chained.groups.length > 1, '320 m of row cannot chain into one group');
  assert.ok(chained.groups.every(entry => entry.sole || entry.span <= 280));
  assert.equal(groupBuildings(row(11), { ...rules, maxSpanMeters: 400 }).groups.length, 1);
});

test('roads and the campus block member-interior links, not unrelated nearby links', () => {
  const list = [block('left', [-20, -5, -10, 5]), block('right', [10, -5, 20, 5])];
  const road = { type: 'Feature', properties: {}, geometry: { type: 'LineString',
    coordinates: [ringOf([0, -30, 0, -30])[0], ringOf([0, 30, 0, 30])[0]] } };
  assert.equal(groupBuildings(list, rules).groups.length, 1, 'the gap alone permits merging');
  for (const barriers of [{ roads: [road] }, { campusGeometry: block('campus', [-3, -10, 3, 10]).geometry }]) {
    const result = groupBuildings(list, { ...rules, ...barriers });
    assert.deepEqual(result.groups.map(entry => entry.members), [['left'], ['right']]);
    assert.equal(groupBuildings(list, { ...rules, ...barriers, gapMeters: 1000, maxSpanMeters: 1000 }).groups.length, 2);
  }
  const remoteRoad = structuredClone(road);
  remoteRoad.geometry.coordinates = [ringOf([0, 15, 0, 15])[0], ringOf([0, 30, 0, 30])[0]];
  assert.equal(groupBuildings(list, { ...rules, roads: [remoteRoad] }).groups.length, 1);
});

test('the campus outline and the tower take no part in grouping', () => {
  // Both sit 5 m from the row, well inside the gap rule: only the exclusion keeps them out of it.
  const list = [...row(4), block('campus', [25, -30, 45, -10], { campus: true }), block('tower', [25, 10, 45, 30], { tower: true })];
  const result = groupBuildings(list, rules);
  assert.deepEqual(group(result, 'campus').members, ['campus']);
  assert.deepEqual(group(result, 'tower').members, ['tower']);
  assert.ok(!result.groups.some((entry) => !entry.sole && entry.features.some((feature) => feature.properties.campus || feature.properties.tower)),
    'no multi-block group may hold the campus or the tower');
  // With the gap rule lifted the row merges into one group, and the campus and the tower are still the only two left out.
  const wide = groupBuildings(list, { ...rules, gapMeters: 10_000, maxSpanMeters: 10_000 });
  assert.equal(wide.groups.length, 3);
  assert.equal(wide.groupOf('1').count, 4);
  assert.equal(wide.groupOf('campus').count, 1);
  assert.equal(wide.groupOf('tower').count, 1);
});

test('the partition does not depend on the order the features arrive in', () => {
  const list = [...row(6), block('far', [900, -5, 920, 5]), block('near', [5, 200, 25, 220])];
  const forward = groupBuildings(list, rules);
  const backward = groupBuildings([...list].reverse(), rules);
  const third = groupBuildings([...list].filter((_, i) => i % 2 === 0).concat([...list].filter((_, i) => i % 2)), rules);
  assert.equal(partitionOf(backward), partitionOf(forward));
  assert.equal(partitionOf(third), partitionOf(forward));
});

test('a group reports what its members add up to', () => {
  const list = [
    block('2', [-10, -5, 10, 5], { area: 200, distance: 300, name: '甲楼' }),
    block('10', [20, -5, 40, 5], { area: 50, distance: 120, name: '乙楼', footprintSource: 'east-asian' }),
    block('1', [50, -5, 70, 5], { area: 5, distance: 900, name: '甲楼' }),
  ];
  const result = groupBuildings(list, rules);
  const joined = group(result, '2');
  assert.deepEqual(joined.members, ['1', '10', '2'], 'members sort by source id, not by input order');
  assert.equal(joined.count, 3);
  assert.equal(joined.area, 255);
  assert.equal(joined.distance, 120, 'the group sits as close as its closest member');
  assert.deepEqual(joined.names, ['甲楼', '乙楼'], 'one name per distinct label');
  assert.deepEqual(joined.sources, { osm: 2, imagery: 1 });
  assert.equal(joined.id, '1', 'the group is named by its lowest source id');
  assert.equal(joined.sole, false);
  assert.equal(joined.span, 81, '80 × 10 m of blocks read as one 81 m span');
  // The same stats over a subset is what the card shows while a lens filter hides part of the group.
  assert.deepEqual(groupStats([list[0]], center), {
    count: 1, area: 200, span: 22, names: ['甲楼'], sources: { osm: 1, imagery: 0 }, distance: 300,
  });
  assert.equal(groupStats(list.slice(0, 2), center).count, 2);
});

test('an unknown id has no group, and a missing centre is refused', () => {
  const result = groupBuildings(row(2), rules);
  assert.equal(group(result, 'nope'), null);
  assert.equal(group(result, undefined), null);
  assert.throws(() => groupBuildings(row(2), {}), /scene centre/);
  assert.throws(() => groupStats(row(1), { lat: NaN, lng: 0 }), /scene centre/);
});

// Road/campus-aware partition counts are not interchangeable with a no-road run.
test('the served snapshot has 472 groups and exactly one complete mapping for all 5686 members', () => {
  assert.deepEqual(center, formal.center);
  const before = structuredClone({ served, formal });
  const result = shippedGrouping();
  assert.deepEqual({ served, formal }, before, 'grouping must not mutate the formal source data or barriers');
  assert.equal(served.features.length, 5686);
  assert.equal(result.groups.length, 472);
  assert.equal(result.groups.filter(entry => entry.sole).length, 94);
  assert.equal(result.groups.filter(entry => !entry.sole).length, 378);
  assert.equal(Math.max(...result.groups.map(entry => entry.count)), 129);
  assert.ok(result.groups.every(entry => entry.sole || entry.span <= 280));
  const originals = new Map(served.features.map(feature => [String(feature.properties.osmId), feature]));
  assert.equal(originals.size, 5686);
  const ids = result.groups.flatMap(entry => entry.members);
  assert.equal(ids.length, 5686);
  assert.equal(new Set(ids).size, 5686, 'duplicates cannot compensate for missing members');
  assert.deepEqual([...ids].sort(), [...originals.keys()].sort());
  for (const entry of result.groups) {
    assert.equal(entry.count, entry.members.length);
    assert.equal(entry.features.length, entry.count);
    entry.members.forEach((id, index) => {
      assert.strictEqual(result.groupOf(id), entry);
      assert.strictEqual(entry.features[index], originals.get(id), `unaltered source member ${id}`);
    });
  }
  const touched = result.groups.filter(entry => entry.features.some(feature => feature.properties.distance <= 500));
  assert.equal(touched.length, 55, '55 touched groups is an aggregation count, not increased member coverage');
  assert.equal(Math.max(...touched.map(entry => entry.count)), 102);
});

test('100/200/300/500 m member partitions preserve every id, not just group counts', () => {
  const grouping = shippedGrouping(), display = groupDisplay(grouping);
  let lower = -Infinity;
  for (const [upper, expectedCount, cumulative] of [[100, 48, 48], [200, 153, 201], [300, 147, 348], [500, 425, 773], [Infinity, 4913, 5686]]) {
    const inBin = feature => feature.properties.distance > lower && feature.properties.distance <= upper;
    const expected = served.features.filter(inBin).map(feature => String(feature.properties.osmId)).sort();
    const actual = grouping.groups.flatMap(entry => entry.features.filter(inBin).map(feature => String(feature.properties.osmId))).sort();
    assert.equal(expected.length, expectedCount, `member count in (${lower}, ${upper}] m`);
    assert.equal(served.features.filter(feature => feature.properties.distance <= upper).length, cumulative);
    assert.deepEqual(actual, expected, `no lost or duplicated source members in (${lower}, ${upper}] m`);
    for (const id of expected) {
      const entry = grouping.groupOf(id);
      assert.ok(entry.members.includes(id));
      assert.strictEqual(display.byMember.get(id), display.byMember.get(entry.members[0]), `display mapping for ${id}`);
      assert.ok(display.features.includes(display.byMember.get(id)));
    }
    lower = upper;
  }
});

test('disconnected buildings become one closed hull containing the gap', () => {
  const list = row(2);
  list[1].properties.category = 'commercial';
  const gap = ringOf([25, 0, 25, 0])[0];
  assert.ok(list.every(feature => !insideRing(feature.geometry.coordinates[0], ...gap)));
  const shape = groupShape(list);
  assert.equal(shape.geometry.type, 'Polygon');
  assert.equal(shape.geometry.coordinates.length, 1);
  assert.ok(insideRing(shape.geometry.coordinates[0], ...gap), 'the space between buildings belongs to the hull');
  assert.deepEqual(convexRingOf(shape), ringOf([0, -5, 50, 5]));
  assert.deepEqual(shape.properties, {
    osmId: '1', groupId: '1', groupCount: 2, aggregate: true,
    category: 'commercial', height: 9.6, base: 0, heightSource: 'estimate', distance: 100,
  });
  assert.equal(groupShape(list, 18).properties.height, 18);
  assert.deepEqual(groupShape([...list].reverse()), shape, 'category ties must not depend on arrival order');
});

test('shuffled shapes keep their majority and representative without changing inputs', () => {
  const list = [
    block('2', [30, -5, 50, 5], { category: 'commercial', height: 60, base: 4, heightSource: 'tag' }),
    block('10', [60, -5, 80, 5]),
    block('1', [0, -5, 20, 5]),
  ];
  const before = structuredClone(list);
  const shape = groupShape(list);
  assert.deepEqual(list, before, 'shaping must not sort or modify the input features');
  assert.equal(shape.properties.category, 'residential', 'member majority beats the first category');
  assert.equal(shape.properties.osmId, '1');
  assert.equal(shape.properties.groupId, '1');
  assert.equal(shape.properties.groupCount, 3);
  for (const order of [[2, 1, 0], [1, 0, 2]]) {
    const shuffled = order.map(index => list[index]);
    const snapshot = structuredClone(shuffled);
    assert.deepEqual(groupShape(shuffled), shape);
    assert.deepEqual(shuffled, snapshot);
  }
  assert.deepEqual(list, before);
});

test('holes and every MultiPolygon exterior shape the hull while singletons retain identity', () => {
  const courtyard = block('1', [0, 0, 20, 20]);
  courtyard.geometry.coordinates.push(ringOf([5, 5, 15, 15]).reverse());
  const right = ringOf([40, 0, 60, 20]);
  const top = ringOf([20, 40, 40, 60]);
  const multipart = block('2', [40, 0, 60, 20]);
  multipart.geometry = { type: 'MultiPolygon', coordinates: [
    [top, ringOf([25, 45, 35, 55]).reverse()],
    [right, ringOf([45, 5, 55, 15]).reverse()],
  ] };
  const list = [courtyard, multipart];
  const before = structuredClone(list);
  for (const feature of list) {
    assert.strictEqual(groupShape([feature]), feature);
    assert.strictEqual(groupShape([feature], 30), feature);
  }
  const shape = groupShape(list);
  const outer = courtyard.geometry.coordinates[0];
  assert.deepEqual(convexRingOf(shape), [outer[0], right[1], right[2], top[2], top[3], outer[3], outer[0]]);
  assert.ok(insideRing(shape.geometry.coordinates[0], ...ringOf([10, 10, 10, 10])[0]), 'aggregate hulls fill former holes');
  assert.deepEqual(list, before);
});

// Written as piecewise bounds from the rule rather than production's clamp/round expression.
const displayThickness = short => short <= 40 ? 9.6 : short >= 100 ? 24 : Math.round(short * 2.4) / 10;
const layoutShortSide = feature => {
  const angle = -15 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const axes = convexRingOf(feature).slice(0, -1).map(([lng, lat]) => {
    const x = (lng - center.lng) * kx, y = (lat - center.lat) * METERS_PER_DEGREE;
    return [x * c + y * s, -x * s + y * c];
  });
  return Math.min(Math.max(...axes.map(p => p[0])) - Math.min(...axes.map(p => p[0])),
    Math.max(...axes.map(p => p[1])) - Math.min(...axes.map(p => p[1])));
};
const expectedDisplayHeight = ({ properties: p, geometry }) => p.aggregate || p.heightSource === 'estimate'
  ? p.base + displayThickness(layoutShortSide({ properties: p, geometry })) : p.height;

function assertDisplay(display, grouping, category = 'all') {
  const visible = grouping.groups.map(entry => entry.features.filter(feature => !feature.properties.campus && !feature.properties.tower
    && (category === 'all' || feature.properties.category === category))).filter(members => members.length);
  const ids = visible.flatMap(members => members.map(feature => String(feature.properties.osmId))).sort();
  assert.deepEqual([...display.byMember.keys()].sort(), ids, 'complete visible-member mapping');
  assert.equal(display.features.length, visible.length);
  assert.equal(new Set(display.features).size, visible.length);
  for (const members of visible) {
    const shape = display.byMember.get(String(members[0].properties.osmId));
    assert.ok(display.features.includes(shape), 'every mapping points to a displayed feature');
    for (const member of members) {
      assert.strictEqual(display.byMember.get(String(member.properties.osmId)), shape);
      assert.notStrictEqual(shape, member, 'even singleton display features are new schematic objects');
      assert.notStrictEqual(shape.geometry, member.geometry);
    }
    const { displayHeight, ...source } = shape.properties;
    assert.deepEqual(source, { ...groupShape(members).properties, schematic: true }, 'height/base and all source-shape properties survive layout');
    assert.equal(displayHeight, expectedDisplayHeight(shape), 'display thickness follows the final short side and never overwrites the source height');
    convexRingOf(shape);
  }
}

function assertRectangle(feature) {
  const vertices = convexRingOf(feature).slice(0, -1).map(([lng, lat]) => [(lng - center.lng) * kx, (lat - center.lat) * METERS_PER_DEGREE]);
  assert.equal(vertices.length, 4);
  const angle = -15 * Math.PI / 180;
  const edges = vertices.map((p, i) => [vertices[(i + 1) % 4][0] - p[0], vertices[(i + 1) % 4][1] - p[1]]);
  edges.forEach(([dx, dy], i) => {
    const next = edges[(i + 1) % 4];
    assert.ok(Math.abs(dx * next[0] + dy * next[1]) / (Math.hypot(dx, dy) * Math.hypot(...next)) < 1e-7, 'right angles in metres');
    assert.ok(Math.min(Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)),
      Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle))) / Math.hypot(dx, dy) < 1e-7, 'aligned to the -15 degree layout axes');
  });
}

test('display filters before layout, regularizes singletons too, and preserves properties and members', () => {
  const list = row(3);
  list[0].properties.category = 'commercial';
  const singleton = block('solo', [300, -5, 320, 5], { height: 42, base: 5, heightSource: 'tag' });
  singleton.geometry.coordinates.push(ringOf([305, -2, 315, 2]).reverse());
  const input = [...list, singleton,
    block('campus', [25, -30, 45, -10], { campus: true }),
    block('tower', [25, 10, 45, 30], { tower: true })];
  const before = structuredClone(input);
  const grouping = groupBuildings(input, rules);
  assert.deepEqual(grouping.groupOf('1').members, ['1', '2', '3']);
  const groupBefore = structuredClone(grouping.groups);
  for (const category of ['all', 'residential', 'commercial', 'industrial']) {
    const display = groupDisplay(grouping, category);
    assertDisplay(display, grouping, category);
    display.features.forEach(assertRectangle);
    assert.deepEqual(groupDisplay(grouping, category), display, 'repeat calls are deterministic');
    assert.deepEqual(groupDisplay(groupBuildings([...input].reverse(), rules), category), display, 'shuffled input is deterministic');
  }
  const all = groupDisplay(grouping), filtered = groupDisplay(grouping, 'residential');
  assert.equal(all.byMember.get('1').properties.height, 9.6);
  assert.equal(all.byMember.get('1').properties.base, 0);
  assert.equal(all.byMember.get('1').properties.displayHeight, 9.6, 'a 10 m wide block sits on the lower bound');
  assert.equal(filtered.byMember.get('solo').properties.height, 42);
  assert.equal(filtered.byMember.get('solo').properties.base, 5);
  assert.equal(all.byMember.get('solo').properties.displayHeight, 42, 'a known height is drawn at its own height, not a thickness');
  assert.notDeepEqual(all.byMember.get('solo').geometry, singleton.geometry);
  assert.notDeepEqual(all.byMember.get('1').geometry, groupShape(list).geometry);
  const shape = filtered.byMember.get('2');
  assert.equal(shape.properties.groupId, '2');
  assert.equal(shape.properties.groupCount, 2);
  assert.ok(!insideRing(shape.geometry.coordinates[0], ...ringOf([10, 0, 10, 0])[0]), 'hidden members must not expand the layout envelope');
  assert.deepEqual(groupDisplay(grouping, 'industrial'), { features: [], byMember: new Map() });
  assert.deepEqual(grouping.groups, groupBefore);
  assert.deepEqual(input, before);
});

test('the formal display maps all 5686 members to 472 schematic shapes without changing source data', () => {
  const before = structuredClone({ served, formal });
  const grouping = shippedGrouping(), groupBefore = structuredClone(grouping.groups);
  const display = groupDisplay(grouping);
  assert.equal(display.features.length, 472);
  assert.equal(display.features.filter(feature => feature.properties.aggregate).length, 378);
  assert.equal(display.byMember.size, 5686);
  assertDisplay(display, grouping);
  for (const category of ['unknown', 'commercial', 'public', 'residential']) assertDisplay(groupDisplay(grouping, category), grouping, category);
  assert.deepEqual(groupDisplay(grouping), display);
  assert.deepEqual(groupDisplay(groupBuildings([...served.features].reverse(), formal)), display);
  assert.deepEqual(grouping.groups, groupBefore);
  assert.deepEqual({ served, formal }, before);
});

test('groupShape remains the strict enclosing convex hull before schematic layout', () => {
  for (const entry of shippedGrouping().groups) {
    const shape = groupShape(entry.features);
    if (entry.sole) {
      assert.strictEqual(shape, entry.features[0]);
      continue;
    }
    const ring = convexRingOf(shape), orientation = Math.sign(turn(...ring.slice(0, 3)));
    for (const feature of entry.features) for (const point of vertexList(feature.geometry)) {
      assert.ok(ring.slice(1).every((end, i) => orientation * turn(ring[i], end, point) >= -1e-15),
        `vertex ${point} of ${feature.properties.osmId} must be inside or on pre-layout hull ${entry.id}`);
    }
  }
});

async function mutatedGroups(from, to) {
  const source = readFileSync(new URL('../src/groups.js', import.meta.url), 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must replace exactly one source fragment');
  const changed = source.replace(from, to).replace(/from '(\.\/[^']+)'/g,
    (_, path) => `from '${new URL(path, new URL('../src/groups.js', import.meta.url)).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

test('display assertions reject wrong heights/bases, omitted mappings, late filtering and skipped layout', async t => {
  const list = row(3);
  list[0].properties.category = 'commercial';
  list.push(block('solo', [400, 0, 420, 10], { height: 42, base: 5 }));
  const grouping = groupBuildings(list, rules);
  assertDisplay(groupDisplay(grouping, 'residential'), grouping, 'residential');
  for (const [name, from, to] of [
    ['height', 'height, base: 0,', 'height: 99, base: 0,'],
    ['base', 'height, base: 0,', 'height, base: 7,'],
    ['mapping', 'byMember.set(String(member.properties.osmId), features[index])', 'byMember.set("omitted", features[index])'],
    ['filter', "(category === 'all' || feature.properties.category === category)", 'true'],
    ['layout', 'layoutBlocks(entries, grouping.layout)', 'entries.map(entry => entry.shape)'],
  ]) await t.test(name, async () => {
    const mutant = await mutatedGroups(from, to);
    const broken = mutant.groupDisplay(grouping, 'residential');
    assert.throws(() => assertDisplay(broken, grouping, 'residential'), { code: 'ERR_ASSERTION' });
  });
  // Two tampers of the new field must be refused by the same positive oracle, so the check is not merely tolerated.
  for (const [label, tamper] of [
    ['constant thickness', properties => { properties.displayHeight = 24; }],
    ['unclamped short side', (properties, feature) => { properties.displayHeight = layoutShortSide(feature) * 0.24; }],
  ]) await t.test(`display height: ${label}`, () => {
    const display = groupDisplay(grouping, 'residential');
    const aggregate = display.features.find(feature => feature.properties.aggregate);
    tamper(aggregate.properties, aggregate);
    assert.throws(() => assertDisplay(display, grouping, 'residential'), { code: 'ERR_ASSERTION' }, label);
  });
});

test('barrier assertions reject source mutants which ignore roads or campus boundaries', async t => {
  const list = [block('left', [-20, -5, -10, 5]), block('right', [10, -5, 20, 5])];
  const campus = block('campus', [-3, -10, 3, 10]).geometry;
  const road = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [campus.coordinates[0][0], campus.coordinates[0][3]] } };
  for (const [name, options, from, to] of [
    ['roads', { ...rules, roads: [road] }, 'const barriers = segmentsOf(roads);', 'const barriers = [];'],
    ['campus', { ...rules, campusGeometry: campus }, 'if (campusGeometry) for', 'if (false) for'],
  ]) await t.test(name, async () => {
    const assertSplit = result => assert.deepEqual(result.groups.map(entry => entry.members), [['left'], ['right']]);
    assertSplit(groupBuildings(list, options));
    const mutant = await mutatedGroups(from, to);
    assert.throws(() => assertSplit(mutant.groupBuildings(list, options)), { code: 'ERR_ASSERTION' });
  });
});

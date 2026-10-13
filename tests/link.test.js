import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatView, parseView } from '../src/link.js';
import { DEFAULT_CENTER, TOWER_OSM_ID, VIEW_LIMITS } from '../src/config.js';
import { insideRing, interiorPoint } from '../src/buildings.js';
import { SCENES } from '../src/scenes.js';
import { groupBuildings, groupDisplay, groupStats } from '../src/groups.js';

const camera = { zoom: 16.25, center: { lng: DEFAULT_CENTER.lng, lat: DEFAULT_CENTER.lat }, bearing: -30.5, pitch: 48 };

test('a settled camera round-trips through the address bar', () => {
  const hash = formatView(camera);
  assert.equal(hash, '#map=16.25/23.109/113.31913/-30.5/48');
  assert.deepEqual(parseView(hash), { camera, selection: null });
});

test('a pasted OpenStreetMap link keeps its own three parts and gains the missing ones as defaults', () => {
  assert.deepEqual(parseView('#map=16/23.109/113.31913').camera, { zoom: 16, center: { lng: 113.31913, lat: 23.109 }, bearing: 0, pitch: 0 });
  assert.deepEqual(parseView('#map=16/23.109/113.31913&layers=T&foo=bar').camera.zoom, 16);
});

test('coordinates are rounded to what the scene can actually reuse', () => {
  const hash = formatView({ zoom: 15.999, center: { lng: 113.3191234, lat: 23.1089999 }, bearing: 181, pitch: 88 });
  assert.equal(hash, '#map=16/23.109/113.31912/-179/88');
  const { camera: shared } = parseView(hash);
  assert.deepEqual(shared, { zoom: 16, center: { lng: 113.31912, lat: 23.109 }, bearing: -179, pitch: VIEW_LIMITS.maxPitch });
});

test('a camera outside the scene or the map limits is ignored, not clamped, so the link still lands on the tower', () => {
  for (const hash of [
    '#map=9.5/23.109/113.31913',
    `#map=${VIEW_LIMITS.maxZoom + 0.5}/23.109/113.31913`,
    '#map=16/52.52/13.405',
    '#map=16/23.5/113.31913',
    '#map=16/89/113.31913',
    '#map=16/23.109/200',
    '#map=16/23.109',
    '#map=16/23.109/113.31913/0/55/99',
    '#map=16/23.109/abc',
    '#map=16/23.109/113.31913/0/abc',
    '#map=&b=1@23.109,113.31913',
    'nonsense',
    '',
  ]) assert.equal(parseView(hash).camera, null, hash);
  assert.equal(parseView('#map=16/23.4/113.31913').camera.zoom, 16);
});

test('the selected block travels with the interior point that a click would have used', () => {
  const selection = { osmId: TOWER_OSM_ID, lat: 23.1090126, lng: 113.3191463 };
  const hash = formatView(camera, selection);
  assert.equal(hash, '#map=16.25/23.109/113.31913/-30.5/48&b=584204634@23.109013,113.319146');
  assert.deepEqual(parseView(hash).selection, { osmId: TOWER_OSM_ID, lat: 23.109013, lng: 113.319146 });
  assert.equal(parseView(hash).camera.zoom, 16.25);
  // A link that only names a block is still usable: the camera falls back to the hero view beside it.
  assert.deepEqual(parseView('#b=584204634@23.109013,113.319146'), { camera: null, selection: { osmId: TOWER_OSM_ID, lat: 23.109013, lng: 113.319146 } });
});

test('a malformed selection is dropped on its own without taking the camera down with it', () => {
  for (const b of ['abc@23.109,113.31913', '-5@23.109,113.31913', '0@23.109,113.31913', '1.5@23.109,113.31913', '99999999999999999999@23.109,113.31913', '584204634@', '584204634@23.109', '584204634@52.52,13.405', '584204634@23.109,abc', '584204634']) {
    const parsed = parseView(`#map=16/23.109/113.31913&b=${b}`);
    assert.equal(parsed.selection, null, b);
    assert.equal(parsed.camera.zoom, 16, b);
  }
});

function relationRoundTrips(parse, format) {
  for (const osmId of ['relation/1', 'relation/4778776', `relation/${Number.MAX_SAFE_INTEGER}`]) {
    const selection = { osmId, lat: 23.1710704, lng: 113.2664604 };
    const rounded = { osmId, lat: 23.17107, lng: 113.26646 };
    const hash = format(camera, selection);
    assert.equal(hash, `${format(camera)}&b=${osmId}@23.17107,113.26646`);
    assert.deepEqual(parse(hash), { camera, selection: rounded });
    assert.deepEqual(parse(`#b=${encodeURIComponent(`${osmId}@23.17107,113.26646`)}`), { camera: null, selection: rounded });
  }
  // Existing bare ways, including previously accepted leading zeroes, remain numbers.
  for (const id of ['1', '00012', String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(parse(`#b=${id}@23.109,113.31913`).selection.osmId, Number(id));
  }
}

test('relation links round-trip verbatim while legacy way IDs remain numeric', () => relationRoundTrips(parseView, formatView));

function rejectsUnsafeRelations(parse) {
  const ids = [
    'relation/0', 'relation/-1', 'relation/+1', 'relation/01', 'relation/1.5', 'relation/1e3', 'relation/0x10',
    'relation/9007199254740992', 'relation/9007199254740993', 'relation/99999999999999999999',
    'relation/Infinity', 'relation/NaN', 'relation/', 'relation//1', 'relation/1/2', 'relation/1x',
    'relation/ 1', 'relation/1 ', ' relation/1', 'relation/1\n', 'Relation/1', 'way/1', 'node/1',
    '9007199254740992', '+1', '1e3', '0x10',
  ];
  const selections = ids.map(id => `${id}@23.109,113.31913`).concat([
    'relation/1', 'relation/1@', 'relation/1@23.109', 'relation/1@52.52,13.405',
    'relation/1@23.109,abc', 'relation/1@NaN,113.31913', 'relation/1@23.109,113.31913@junk',
    'relation/1@23.109,113.31913,0',
  ]);
  for (const b of selections) {
    const parsed = parse(`${formatView(camera)}&b=${encodeURIComponent(b)}`);
    assert.equal(parsed.selection, null, b);
    assert.deepEqual(parsed.camera, camera, b);
  }
}

test('relation selection syntax and safe-integer boundaries are validated independently of the camera', () => rejectsUnsafeRelations(parseView));

function footprintRoundTrips(parse, format) {
  for (const osmId of ['eastasia/1', 'eastasia/4780', `eastasia/${Number.MAX_SAFE_INTEGER}`]) {
    const hash = format(camera, { osmId, lat: 23.1090126, lng: 113.3191463 });
    assert.equal(hash, `${formatView(camera)}&b=${osmId}@23.109013,113.319146`);
    assert.deepEqual(parse(hash).selection, { osmId, lat: 23.109013, lng: 113.319146 }, osmId);
  }
}

function rejectsForeignPrefixes(parse) {
  // A prefix neither snapshot emits would open no card at all, so it must fail to parse rather than look shareable.
  for (const id of ['eastasia/0', 'eastasia/-1', 'eastasia/01', 'eastasia/1.5', 'eastasia/1e3', 'eastasia/', 'eastasia//1', 'eastasia/1/2', 'eastasia/1x', 'EASTASIA/1', 'eastasia/9007199254740992', 'way/1', 'node/1', 'foo/1']) {
    assert.equal(parse(`${formatView(camera)}&b=${encodeURIComponent(`${id}@23.109,113.31913`)}`).selection, null, id);
  }
}

test('footprint ids round-trip with their namespace, and no other prefix is admitted', () => {
  footprintRoundTrips(parseView, formatView);
  rejectsForeignPrefixes(parseView);
});

const schoolLayout = {
  center: SCENES.jingtai.center,
  roads: JSON.parse(await readFile(new URL('../public/data/jingtai-roads.geojson', import.meta.url))).features,
  campusGeometry: JSON.parse(await readFile(new URL('../public/data/jingtai-grounds.geojson', import.meta.url))).features.find(f => f.properties.target && f.properties.kind === 'campus').geometry,
};

// Execute only the real geometry/selection/picking callbacks in Node, without loading MapLibre, a DOM or a browser.
function mapSelectionHarness(source, features, school = true, activeLens = { mode: 'use', category: 'all', source: 'all' }) {
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `missing map section: ${from}`);
    return source.slice(start, end);
  };
  return new Function('insideRing', 'interiorPoint', 'buildings', 'school', 'groupBuildings', 'groupDisplay', 'groupStats', 'DEFAULT_CENTER', 'roads', 'campusGeometry', `
    ${section('const buildingId =', 'function neighborhoodStyle(')}
    let selection, focus, card, projected, hits = [];
    const lens = ${JSON.stringify(activeLens)}, towerHeight = 450, extrusions = [];
    const onBuildingClick = value => { card = value; };
    const anchorPoint = geometry => ({ lngLat: geometry.coordinates[0][0] });
    const writeHash = () => {};
    const box = point => [[point.x - 2, point.y - 2], [point.x + 2, point.y + 2]];
    const map = {
      project: ([x, y]) => { projected = [x, y]; return { x, y }; },
      getCanvas: () => ({ clientWidth: 1024, clientHeight: 768 }),
      queryRenderedFeatures: () => hits,
    };
    ${section('  function selectFeature(', "  map.on('click',")}
    ${section('  function focusPick()', '  function focusStep()')}
    return {
      geometryPoint,
      get projected() { return projected; },
      select(feature) { selectFeature(feature); return { selection, card }; },
      pick(block, candidates) { focus = block; hits = candidates; return focusPick(); },
    };
  `)(insideRing, interiorPoint, { features }, school, groupBuildings, groupDisplay, groupStats, SCENES.jingtai.center, schoolLayout.roads, schoolLayout.campusGeometry);
}

const mapSource = readFile(new URL('../src/map.js', import.meta.url), 'utf8');
const schoolBuildings = readFile(new URL('../public/data/jingtai-buildings.geojson', import.meta.url), 'utf8').then(JSON.parse);
const containsPoint = (geometry, { lng, lat }) => insideRing(geometry.coordinates[0], lng, lat)
  && !geometry.coordinates.slice(1).some(ring => insideRing(ring, lng, lat));

function snapshotSelections(harness, features) {
  const relations = features.filter(feature => String(feature.properties.osmId).startsWith('relation/'));
  assert.equal(relations.length, 15);
  for (const feature of relations) {
    // A rendered tile can omit the hole; the original complete geometry must still drive sharing and highlighting.
    const rendered = { ...feature, geometry: { type: 'Polygon', coordinates: [feature.geometry.coordinates[0]] } };
    const { selection, card } = harness.select(rendered);
    assert.equal(selection.osmId, feature.properties.osmId);
    assert.equal(card.outline.geometry, feature.geometry);
    assert.equal(containsPoint(feature.geometry, selection), true, selection.osmId);
    const reopened = parseView(formatView(camera, selection)).selection;
    assert.equal(reopened.osmId, selection.osmId);
    assert.equal(containsPoint(feature.geometry, reopened), true, `rounded ${selection.osmId}`);
    const wrongWay = { properties: { osmId: Number(selection.osmId.split('/')[1]) } };
    const wrongRelation = { properties: { osmId: 'relation/999999' } };
    assert.equal(harness.pick(reopened, [wrongWay, wrongRelation, rendered]), rendered);
    assert.equal(harness.pick(reopened, [wrongWay, wrongRelation]), null);
  }
  const way = features.find(feature => typeof feature.properties.osmId === 'number');
  const renderedWay = { ...way, properties: { ...way.properties, osmId: String(way.properties.osmId) } };
  const { selection } = harness.select(renderedWay);
  assert.equal(selection.osmId, way.properties.osmId);
  assert.equal(typeof selection.osmId, 'number');
  assert.equal(harness.pick(selection, [renderedWay]), renderedWay);
}

test('all shipped relations, including unnamed ones, select and share full footprints outside holes', async () => {
  const { features } = await schoolBuildings;
  const before = structuredClone(features);
  const { entries } = JSON.parse(await readFile(new URL('../public/data/jingtai-buildings-index.json', import.meta.url)));
  const unindexed = features.find(feature => feature.properties.osmId === 'relation/4778776');
  assert.equal(entries.some(entry => entry.osmId === unindexed.properties.osmId), false);
  const [lng, lat] = interiorPoint(unindexed.geometry.coordinates[0]);
  assert.equal(containsPoint(unindexed.geometry, { lng, lat }), false, 'fixture reproduces the original courtyard bug');
  snapshotSelections(mapSelectionHarness(await mapSource, features), features);
  assert.deepEqual(features, before);
});

test('a neighbouring block selects with its group only in the school scene', async () => {
  const { features } = await schoolBuildings;
  const source = await mapSource;
  const clicked = features.find((feature) => String(feature.properties.osmId) === '893906742');
  const grouped = mapSelectionHarness(source, features).select(clicked);
  assert.equal(grouped.card.group.count, 56);
  assert.equal(grouped.card.group.outlines.length, 1, 'the highlight is one continuous group shape');
  assert.equal(grouped.card.group.merged, true);
  assert.deepEqual(grouped.card.group.outlines[0].geometry, grouped.card.displayOutline.geometry);
  assert.equal(grouped.card.outline.geometry, clicked.geometry, 'the original member geometry remains available for provenance');
  assert.notDeepEqual(grouped.card.displayOutline.geometry, clicked.geometry);
  const height = mapSelectionHarness(source, features, true, { mode: 'height', category: 'all', source: 'all' }).select(clicked);
  assert.equal(height.card.group.merged, false);
  assert.equal(height.card.group.outlines.length, 56);
  assert.ok(height.card.group.outlines.every(outline => outline.properties.height === 0));
  assert.equal(String(grouped.selection.osmId), '893906742', 'the share link still names one building');
  assert.ok(grouped.card.group.rules.maxSpanMeters > grouped.card.group.rules.gapMeters);
  // The other scene draws one block per card, so the same selection carries no group at all.
  assert.equal(mapSelectionHarness(source, features, false).select(clicked).card.group, undefined);
});

// The public member must leave both the count and area when residential filtering is applied.
test('a filtered lens reports and highlights only the drawn part of a group', async () => {
  const { features } = await schoolBuildings;
  const source = await mapSource;
  const home = features.find((feature) => String(feature.properties.osmId) === '893915142');
  const all = mapSelectionHarness(source, features).select(home).card.group;
  assert.equal(all.count, 33);
  assert.equal(all.area, 7905);
  const residential = mapSelectionHarness(source, features, true, { mode: 'use', category: 'residential', source: 'all' })
    .select(home).card.group;
  assert.equal(residential.count, 32, 'a filtered-out block leaves the card as surely as it leaves the map');
  assert.equal(residential.outlines.length, 1, 'filtered members still form a single displayed shape');
  const grouping = groupBuildings(features, schoolLayout);
  assert.deepEqual(residential.outlines[0].geometry, groupDisplay(grouping, 'residential').byMember.get('893915142').geometry);
  assert.equal(residential.area, 7599, 'the footprint total follows the drawn members');
  const lone = mapSelectionHarness(source, features, true, { mode: 'use', category: 'public', source: 'all' })
    .select(features.find((feature) => String(feature.properties.osmId) === '893915147')).card;
  assert.equal(lone.group, undefined, 'one drawn member is not a group');
});

function syntheticGroupFocusSelections(source, features) {
  const grouping = groupBuildings(features, schoolLayout);
  const display = groupDisplay(grouping);
  const harness = mapSelectionHarness(source, features);
  const canton = mapSelectionHarness(source, features, false);
  const requestFor = (feature) => {
    const [lng, lat] = harness.geometryPoint(feature.geometry);
    return parseView(formatView(camera, { osmId: feature.properties.osmId, lng, lat })).selection;
  };
  // Each target differs from its rendered representative; the relation also has a courtyard hole.
  for (const osmId of [893915147, 'relation/4779478', 'eastasia/2']) {
    const original = features.find(feature => feature.properties.osmId === osmId);
    assert.ok(original, `missing focus fixture: ${osmId}`);
    const shape = display.byMember.get(String(osmId));
    assert.equal(shape?.properties.aggregate, true, `${osmId}: fixture must render as a synthetic group`);
    assert.notEqual(String(shape.properties.osmId), String(osmId), `${osmId}: fixture must not be the representative`);
    const representative = features.find(feature => feature.properties.osmId === shape.properties.osmId);
    assert.ok(representative, `${osmId}: representative must be a real snapshot member`);
    const rendered = structuredClone(shape);
    const wrongGroup = structuredClone(display.features.find(feature => feature.properties.aggregate
      && feature.properties.groupId !== shape.properties.groupId));
    assert.ok(wrongGroup, `${osmId}: fixture needs an unrelated rendered group`);
    const request = requestFor(original);
    assert.equal(request.osmId, osmId);
    assert.equal(containsPoint(original.geometry, request), true, `${osmId}: shared focus point must be inside the original`);
    assert.equal(harness.pick(request, []), null, `${osmId}: a group must actually be rendered`);
    assert.equal(harness.pick(request, [wrongGroup]), null, `${osmId}: an unrelated group cannot satisfy focus`);
    assert.equal(canton.pick(request, [rendered]), null, `${osmId}: Canton cannot focus a school synthetic hit`);
    const picked = harness.pick(request, [wrongGroup, rendered]);
    assert.ok(picked, `${osmId}: groupId matching must resolve a non-representative member`);
    assert.equal(picked, original, `${osmId}: group hit must return the requested original feature, not the synthetic candidate`);
    const { selection, card } = harness.select(picked);
    const [lng, lat] = harness.geometryPoint(original.geometry);
    assert.deepEqual(selection, { osmId, lng, lat }, `${osmId}: selection must retain the requested identity and original interior point`);
    assert.notEqual(selection.osmId, representative.properties.osmId, `${osmId}: sharing must not name the representative`);
    assert.equal(containsPoint(original.geometry, selection), true, `${osmId}: selection must stay inside the original, outside its holes`);
    assert.equal(containsPoint(representative.geometry, selection), false, `${osmId}: selection must not move into the representative`);
    assert.deepEqual(parseView(formatView(camera, selection)).selection, request, `${osmId}: reopening must preserve the requested member`);
    assert.equal(card.properties, original.properties, `${osmId}: the card must describe the requested member`);
    assert.equal(card.outline.geometry, original.geometry, `${osmId}: provenance must retain the complete original footprint`);
    assert.ok(card.displayOutline, `${osmId}: the card must expose the synthetic display outline`);
    assert.deepEqual(card.displayOutline, shape, `${osmId}: display must use the rendered group hull`);
    assert.equal(card.displayOutline.geometry.type, 'Polygon');
    assert.equal(card.displayOutline.geometry.coordinates.length, 1);
    assert.ok(card.group, `${osmId}: the card must include its displayed group`);
    assert.equal(card.group.merged, true);
    assert.equal(card.group.count, shape.properties.groupCount);
    assert.equal(card.group.outlines.length, 1, `${osmId}: highlight must be one continuous group shape`);
    assert.deepEqual(card.group.outlines[0].geometry, card.displayOutline.geometry, `${osmId}: highlight and display must share the same hull`);
  }
  // The public member belongs to this group, but only its residential neighbours are drawn by this lens.
  const hidden = features.find(feature => feature.properties.osmId === 893915147);
  const residentialDisplay = groupDisplay(grouping, 'residential');
  const visibleShape = residentialDisplay.byMember.get('893915142');
  assert.equal(hidden.properties.category, 'public');
  assert.equal(residentialDisplay.byMember.has(String(hidden.properties.osmId)), false);
  assert.equal(visibleShape.properties.aggregate, true);
  assert.equal(visibleShape.properties.groupId, display.byMember.get(String(hidden.properties.osmId)).properties.groupId);
  const filtered = mapSelectionHarness(source, features, true, { mode: 'use', category: 'residential', source: 'all' });
  assert.equal(filtered.pick(requestFor(hidden), [structuredClone(visibleShape)]), null,
    'a nonvisible lens member cannot focus through its visible neighbours, even with the same groupId');
}

test('synthetic group focus preserves non-representative way, relation and eastasia members and rejects unrelated or hidden hits', async () => {
  const { features } = await schoolBuildings;
  const before = structuredClone(features);
  syntheticGroupFocusSelections(await mapSource, features);
  assert.deepEqual(features, before);
});

test('schematic focus projects the displayed interior but shares the original member point', async () => {
  const { features } = await schoolBuildings;
  const source = await mapSource;
  const display = groupDisplay(groupBuildings(features, schoolLayout));
  const harness = mapSelectionHarness(source, features);
  const original = features.find(feature => {
    const [lng, lat] = harness.geometryPoint(feature.geometry);
    return !containsPoint(display.byMember.get(String(feature.properties.osmId)).geometry, { lng, lat });
  });
  assert.ok(original, 'the fixture must actually lie outside its schematic shape');
  const shape = display.byMember.get(String(original.properties.osmId));
  const [lng, lat] = harness.geometryPoint(original.geometry);
  const request = { osmId: original.properties.osmId, lng, lat };
  const check = target => {
    target.pick(request, [shape]);
    const [x, y] = target.projected;
    assert.ok(containsPoint(shape.geometry, { lng: x, lat: y }), 'focus must project into the displayed block');
    assert.deepEqual(target.select(original).selection, request);
  };
  check(harness);
  const from = 'map.project(display ? geometryPoint(display.geometry) : [lng, lat])';
  assert.equal(source.split(from).length, 2);
  assert.throws(() => check(mapSelectionHarness(source.replace(from, 'map.project([lng, lat])'), features)), /focus must project into the displayed block/);
  const single = features.find(feature => !display.byMember.get(String(feature.properties.osmId)).properties.aggregate);
  const card = harness.select(single).card;
  assert.deepEqual(card.displayOutline, display.byMember.get(String(single.properties.osmId)));
  assert.equal(card.displayOutline.properties.height, single.properties.height);
  assert.equal(card.displayOutline.properties.base, single.properties.base);
});

test('in-memory map mutants fail the synthetic group focus and continuous highlight contracts', async (t) => {
  const source = await mapSource, { features } = await schoolBuildings;
  for (const [name, from, to, message] of [
    ['groupId matching removed',
      '|| (display?.properties.groupId && candidate.properties.groupId === display.properties.groupId)', '',
      /groupId matching must resolve a non-representative member/],
    ['synthetic hit returned instead of requested member',
      'if (hit?.properties.groupId) return buildings.features.find(building => String(building.properties.osmId) === String(osmId)) ?? null;',
      'if (hit?.properties.groupId) return hit;',
      /group hit must return the requested original feature, not the synthetic candidate/],
    ['highlight split into member outlines',
      'outlines: merged ? [selectionOutline(display)] : members.map(selectionOutline)',
      'outlines: members.map(selectionOutline)',
      /highlight must be one continuous group shape/],
    ['display outline omitted', '...(display ? { displayOutline: display } : {}),', '',
      /the card must expose the synthetic display outline/],
  ]) await t.test(name, () => {
    assert.equal(source.split(from).length, 2, `${name}: mutation must have exactly one target`);
    const mutant = source.replace(from, to);
    assert.throws(() => syntheticGroupFocusSelections(mutant, features), { code: 'ERR_ASSERTION', message });
  });
});

test('in-memory link and map defects are caught by the relation behavior assertions', async (t) => {
  const linkSource = (await readFile(new URL('../src/link.js', import.meta.url), 'utf8'))
    .replace("'./config.js'", JSON.stringify(new URL('../src/config.js', import.meta.url).href));
  for (const [name, from, to, check] of [
    ['source prefix lost', 'namespaced ? id : numericId', 'numericId', module => relationRoundTrips(module.parseView, module.formatView)],
    ['unsafe IDs allowed', 'Number.isSafeInteger(numericId)', 'Number.isInteger(numericId)', module => rejectsUnsafeRelations(module.parseView)],
    ['relation prefix omitted in output', '${selection.osmId}@', "${String(selection.osmId).replace('relation/', '')}@", module => relationRoundTrips(module.parseView, module.formatView)],
    ['any prefix admitted', '/^(?:relation|eastasia)\\/[1-9]\\d*$/', '/^[a-z][a-z0-9]*\\/[1-9]\\d*$/', module => rejectsForeignPrefixes(module.parseView)],
    ['footprint prefix dropped in output', '${selection.osmId}@', "${String(selection.osmId).replace('eastasia/', '')}@", module => footprintRoundTrips(module.parseView, module.formatView)],
  ]) await t.test(name, async () => {
    assert.equal(linkSource.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(linkSource.replace(from, to)).toString('base64')}`);
    assert.throws(() => check(mutant), { code: 'ERR_ASSERTION' });
  });
  const source = await mapSource, { features } = await schoolBuildings;
  for (const [name, from, to] of [
    ['selection coerces relation to number', 'osmId: buildingId(properties.osmId)', 'osmId: Number(properties.osmId)'],
    ['selection ignores holes', 'const [lng, lat] = geometryPoint(geometry);', 'const [lng, lat] = interiorPoint(geometry.coordinates[0]);'],
    ['tile geometry replaces full footprint', '?.geometry ?? feature.geometry', '&& false || feature.geometry'],
    ['focus coerces relation to number', 'String(candidate.properties.osmId) === String(osmId)', 'Number(candidate.properties.osmId) === osmId'],
  ]) await t.test(name, () => {
    assert.equal(source.split(from).length, 2);
    const mutant = mapSelectionHarness(source.replace(from, to), features);
    assert.throws(() => snapshotSelections(mutant, features), { code: 'ERR_ASSERTION' });
  });
});

function focusTimers(source, instant, hitInitially) {
  const start = source.indexOf('  function focusStep()');
  const end = source.indexOf('  // One hit-test', start);
  assert.ok(start > 0 && end > start);
  return new Function('instant', 'hitInitially', `
    let focus, selected = 0, nextTimer = 0, hit = hitInitially;
    const timers = new Map();
    const setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
    const clearTimeout = id => timers.delete(id);
    const manualInteraction = () => {}, resetLens = () => {}, writeHash = () => {};
    const padding = () => ({}), reducedMotion = { matches: instant };
    const focusPick = () => hit ? {} : null;
    const selectFeature = () => selected++;
    const school = true, lens = { mode: 'use' };
    const displayForLens = () => ({ byMember: new Map() });
    const map = { isMoving: () => false, isSourceLoaded: () => true, getZoom: () => 16,
      easeTo() { if (instant) focusStep(); } };
    ${source.slice(start, end)}
    return {
      start() { try { focusBuilding({ osmId: 1, lng: 113, lat: 23 }); } catch (error) { return error.message; } },
      finish() { hit = true; focusStep(); },
      state() { return { selected, pending: timers.size, focusing: Boolean(focus) }; }
    };
  `)(instant, hitInitially);
}

function focusTimerContract(source) {
  for (const [instant, hitInitially] of [[true, true], [true, false], [false, true]]) {
    const harness = focusTimers(source, instant, hitInitially);
    assert.equal(harness.start(), undefined);
    if (!instant || !hitInitially) {
      assert.deepEqual(harness.state(), { selected: 0, pending: 1, focusing: true });
      harness.finish();
    }
    assert.deepEqual(harness.state(), { selected: 1, pending: 0, focusing: false });
  }
}

test('instant and animated search focus clear their single retry timer after selection', async () => {
  focusTimerContract(await mapSource);
});

test('focus timing assertions reject synchronous completion and duplicate retry defects', async () => {
  const source = await mapSource;
  const timer = '    focus.timer = setTimeout(focusStep, 900);\n';
  const move = source.split('\n').find(line => line.includes('map.easeTo({ center: [block.lng, block.lat]')) + '\n';
  assert.equal(source.split(timer).length, 2);
  for (const mutant of [source.replace(timer, '').replace(move, move + timer), source.replace('    clearTimeout(focus.timer);\n', '')]) {
    assert.notEqual(mutant, source);
    assert.throws(() => focusTimerContract(mutant), { code: 'ERR_ASSERTION' });
  }
});

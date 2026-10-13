import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatView, parseView } from '../src/link.js';
import { DEFAULT_CENTER, TOWER_OSM_ID, VIEW_LIMITS } from '../src/config.js';
import { insideRing, interiorPoint } from '../src/buildings.js';

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

// Execute only the real geometry/selection/picking callbacks in Node, without loading MapLibre, a DOM or a browser.
function mapSelectionHarness(source, features) {
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `missing map section: ${from}`);
    return source.slice(start, end);
  };
  return new Function('insideRing', 'interiorPoint', 'buildings', `
    ${section('const buildingId =', 'function neighborhoodStyle(')}
    let selection, focus, card, hits = [];
    const lens = { mode: 'use' }, towerHeight = 450, extrusions = [];
    const onBuildingClick = value => { card = value; };
    const anchorPoint = geometry => ({ lngLat: geometry.coordinates[0][0] });
    const writeHash = () => {};
    const box = point => [[point.x - 2, point.y - 2], [point.x + 2, point.y + 2]];
    const map = {
      project: ([x, y]) => ({ x, y }),
      getCanvas: () => ({ clientWidth: 1024, clientHeight: 768 }),
      queryRenderedFeatures: () => hits,
    };
    ${section('  function selectFeature(', "  map.on('click',")}
    ${section('  function focusPick()', '  function focusStep()')}
    return {
      geometryPoint,
      select(feature) { selectFeature(feature); return { selection, card }; },
      pick(block, candidates) { focus = block; hits = candidates; return focusPick(); },
    };
  `)(insideRing, interiorPoint, { features });
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

test('in-memory link and map defects are caught by the relation behavior assertions', async (t) => {
  const linkSource = (await readFile(new URL('../src/link.js', import.meta.url), 'utf8'))
    .replace("'./config.js'", JSON.stringify(new URL('../src/config.js', import.meta.url).href));
  for (const [name, from, to, check] of [
    ['relation prefix lost', 'relation ? id : numericId', 'numericId', module => relationRoundTrips(module.parseView, module.formatView)],
    ['unsafe IDs allowed', 'Number.isSafeInteger(numericId)', 'Number.isInteger(numericId)', module => rejectsUnsafeRelations(module.parseView)],
    ['relation prefix omitted in output', '${selection.osmId}@', "${String(selection.osmId).replace('relation/', '')}@", module => relationRoundTrips(module.parseView, module.formatView)],
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatView, parseView } from '../src/link.js';
import { DEFAULT_CENTER, TOWER_OSM_ID, VIEW_LIMITS } from '../src/config.js';

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


// 这一册剩下的两格只看 `src/map.js` 里搜索聚焦那一段的时序：一轮只重试一个定时器。
const mapSource = readFile(new URL('../src/map.js', import.meta.url), 'utf8');

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

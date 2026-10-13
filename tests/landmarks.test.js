import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPROACH_PITCH, CLEARANCE_METRES, DECLUTTER_PAD, LANDMARKS, MINIMUM_ALTITUDE, approachAltitude, approachCamera, declutter, landmarkFacts } from '../src/landmarks.js';
import { createLandmarkForms } from '../src/landmark-forms.js';
import { SCENE } from '../src/config.js';
import { GLYPH_BOX, LANDMARK_GLYPHS } from '../src/landmark-glyphs.js';
import { VIEW_LIMITS } from '../src/config.js';
import { TOUR_STOPS } from '../src/tour.js';
import { distanceMeters } from '../src/geo.js';

const buildings = JSON.parse(readFileSync(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8'));
const tower = JSON.parse(readFileSync(new URL('../public/data/canton-tower.geojson', import.meta.url), 'utf8'));
const height = 960;
const bridge = JSON.parse(readFileSync(new URL('../public/data/haixin-bridge.geojson', import.meta.url), 'utf8'));
const crossings = JSON.parse(readFileSync(new URL('../public/data/canton-bridges.geojson', import.meta.url), 'utf8'));

test('卡片点名的层高与裙房，一个来自快照、一个点名是画的', () => {
  const forms = createLandmarkForms({ features: [...buildings.features, ...bridge.features], origin: SCENE.center });
  const factsOf = (osmId) => landmarkFacts(LANDMARKS.find((landmark) => landmark.osmId === osmId), forms.forms).join(' / ');
  const west = factsOf(184738716);
  assert.match(west, /立面按快照 103 层切成每层 4\.27 m/, '西塔的卡片没报出快照自己给的层数与层高');
  assert.match(west, /外立面每 51\.3 m（12 层）一颗菱形斜撑、绕环 4 颗，管径按施工方资料由底部 1\.8 m 渐变到顶部 0\.7 m/,
    '卡片没说西塔那一格换成了有出处的菱形，或把渐变管径说成了一个示意常量');
  assert.match(west, /裙房 24 m、平面外扩 1\.25 倍为示意/, '裙房是画的，卡片必须点名');
  const east = factsOf(511404889);
  assert.match(east, /立面按快照 111 层切成每层 4\.77 m/, '东塔的层高没跟着它自己的层数走');
  assert.match(east, /角部 8 根巨柱站在这条轮廓自己标出的硬角上，6 道环形桁架按施工方资料画、标高为示意/,
    '东塔的卡片没报出那 8 根柱子与 6 道桁架，或没点名桁架标高是等分的');
  assert.ok(!/裙房 24 m/.test(east) || east.includes('外扩'), '东塔的裙房报了却没说外扩');
  const museum = factsOf(240896442);
  assert.match(museum, /每层 3\.20 m/, '省博的层高该是 16 m ÷ 5 层');
  assert.ok(!museum.includes('裙房'), '省博没有裙房，卡片不该凭空报一个');
  assert.ok(!/每层/.test(factsOf(1313608038)), '桥面没有楼层可报，别给它编一层');
});

// Where a landmark's plate hangs, measured off the shipped geometry rather than remembered: the vertex centroid for a
// footprint, the middle of the bounding box for a long thin thing like a bridge deck (whose centroid sits at one end of
// the river it crosses).
const footpoint = (geometry) => {
  const points = [];
  const walk = (node) => (typeof node[0] === 'number' ? points.push(node) : node.forEach(walk));
  walk(geometry.coordinates);
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  return { centroid: [xs.reduce((sum, x) => sum + x, 0) / xs.length, ys.reduce((sum, y) => sum + y, 0) / ys.length],
    middle: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] };
};

test('every landmark is an element the shipped snapshots actually contain', () => {
  const named = new Map(buildings.features.map((feature) => [feature.properties.osmId, feature]));
  // A bridge way arrives twice (the two carriageways) and each of those twice more (deck and kerb), so the plate is
  // checked against the union of everything that way's own name carries in the shipped file.
  const decks = new Map();
  for (const feature of crossings.features) {
    if (feature.properties.part !== 'deck' || !feature.properties.name) continue;
    decks.set(feature.properties.osmId, feature);
  }
  const towerId = tower.features[0].properties.osmId;
  const tourIds = new Set(TOUR_STOPS.filter((stop) => typeof stop.osmId === 'number').map((stop) => stop.osmId));
  // Seven: the six the V4 brief named, plus 猎德大桥 - which the shipped frame leaves out at x≈1543 of 1440 (V5 遗留①),
  // so the debt being paid here is "it has a name where it is drawn", not "it is in the hero shot".
  assert.equal(LANDMARKS.length, 7, 'the six from V4 plus the bridge V5 asked to be reachable');
  assert.equal(new Set(LANDMARKS.map((landmark) => landmark.osmId)).size, 7, 'no landmark is listed twice');
  for (const landmark of LANDMARKS) {
    const source = named.get(landmark.osmId) ?? decks.get(landmark.osmId);
    if (landmark.osmId === towerId) assert.ok(tourIds.has(landmark.osmId), 'the tower is the model this scene anchors on');
    else if (!source) {
      assert.ok(tourIds.has(landmark.osmId),
        `${landmark.name} is in neither the building snapshot nor the tour: it would be a coordinate typed in by eye`);
      assert.equal(landmark.height, null, `${landmark.name} has no measured height to claim`);
      continue;
    }
    if (!source) continue;
    assert.equal(source.properties.name, landmark.name, `${landmark.name} must be the name the snapshot carries`);
    if (landmark.heightSource === 'height') {
      assert.equal(source.properties.height, landmark.height, `${landmark.name}'s metres come from OSM \`height\``);
    }
    if (landmark.heightSource === 'levels') {
      assert.ok(source.properties.levels >= 1, `${landmark.name} is measured by floor count`);
      assert.equal(landmark.height, Math.round(source.properties.levels * 3.2 * 10) / 10, '3.2 m a floor, said out loud');
    }
    const foot = footpoint(source.geometry);
    const on = named.get(landmark.osmId) ? foot.centroid : foot.middle;
    assert.ok(distanceMeters({ lat: on[1], lng: on[0] }, { lat: landmark.center[1], lng: landmark.center[0] }) < 120,
      `${landmark.name}'s label sits on its own footprint, not next to it (${on} vs ${landmark.center})`);
  }
});

test('an approach camera clears the roof it is flying to', () => {
  for (const landmark of LANDMARKS) {
    const camera = approachCamera(landmark, height);
    const altitude = approachAltitude(landmark);
    assert.ok(Number.isFinite(camera.zoom) && Number.isFinite(camera.pitch), `${landmark.name} solves to a real camera`);
    assert.ok(Math.abs(camera.pitch - APPROACH_PITCH) < 0.01, `${landmark.name} arrives at ${camera.pitch}°, not ${APPROACH_PITCH}°`);
    assert.ok(camera.pitch <= VIEW_LIMITS.maxPitch, `${landmark.name} stays under the map's ${VIEW_LIMITS.maxPitch}° ceiling`);
    assert.ok(camera.zoom >= VIEW_LIMITS.minZoom && camera.zoom <= VIEW_LIMITS.maxZoom,
      `${landmark.name} lands at zoom ${camera.zoom}, outside the map's ${VIEW_LIMITS.minZoom}-${VIEW_LIMITS.maxZoom}`);
    if (landmark.height) {
      assert.ok(altitude >= landmark.height + CLEARANCE_METRES,
        `${landmark.name} is ${landmark.height} m tall and the eye would sit ${altitude} m up - inside the building`);
    } else {
      assert.equal(altitude, MINIMUM_ALTITUDE, `${landmark.name} has no height, so it gets the floor`);
      // The brief's own 250 m only survives for things that are not towers: distance follows from the altitude.
      assert.ok(Math.abs(altitude * Math.tan(APPROACH_PITCH * Math.PI / 180) - 250) < 20,
        `${landmark.name} is looked at from ${altitude * Math.tan(APPROACH_PITCH * Math.PI / 180)} m`);
    }
    assert.deepEqual(camera.center, [landmark.center[0], landmark.center[1]], `${landmark.name} is what the eye is on`);
    assert.equal(camera.duration, 1800, 'the brief asks for 1.8 s');
    assert.equal(camera.curve, 1.3, 'the brief asks for curve 1.3');
  }
});

test('a taller landmark is looked at from further out, and the camera is a lookup not a counter', () => {
  const tower = LANDMARKS.find((landmark) => landmark.name === '广州塔');
  const museum = LANDMARKS.find((landmark) => landmark.heightSource === 'levels');
  assert.ok(approachAltitude(tower) > approachAltitude(museum) * 3, 'the tower needs the sky to itself');
  const first = approachCamera(tower, height);
  assert.deepEqual(approachCamera(tower, height), first, 'asking twice gives the same camera');
  const taller = approachCamera(tower, 1920);
  assert.ok(Math.abs(taller.pitch - first.pitch) < 0.01, 'the pitch is geometry, not a canvas measurement');
  assert.ok(taller.zoom > first.zoom + 0.9, `a taller canvas pulls the zoom in: ${first.zoom} → ${taller.zoom}`);
});

const coordinates = (path) => [...path.matchAll(/-?\d*\.?\d+/g)].map((match) => Number(match[0]));

test('every landmark carries its own silhouette, not the shared diamond and not the fallback', () => {
  const ids = LANDMARKS.map((landmark) => String(landmark.osmId)).sort();
  assert.deepEqual(Object.keys(LANDMARK_GLYPHS).sort(), ids, 'one drawing per landmark, and nothing left over');
  const shapes = Object.values(LANDMARK_GLYPHS).map((paths) => paths.join('|'));
  assert.equal(new Set(shapes).size, ids.length, 'six plates that all look the same point at nothing');
});

test('a silhouette fits its box, uses commands that render, and fills the plate', () => {
  const [boxWidth, boxHeight] = GLYPH_BOX.split(' ').slice(2).map(Number);
  for (const landmark of LANDMARKS) {
    for (const path of LANDMARK_GLYPHS[landmark.osmId]) {
      assert.match(path, /^M/, `${landmark.name}: a line that never picks up its pen draws nothing`);
      assert.match(path, /^[MLCZ0-9., -]+$/, `${landmark.name} uses a command this project never drew with`);
      const numbers = coordinates(path);
      assert.equal(numbers.length % 2, 0, `${landmark.name} has an x with no y`);
      for (let i = 0; i < numbers.length; i += 2) {
        assert.ok(numbers[i] >= 0 && numbers[i] <= boxWidth, `${landmark.name} reaches x=${numbers[i]}, outside 0-${boxWidth}`);
        assert.ok(numbers[i + 1] >= 0 && numbers[i + 1] <= boxHeight, `${landmark.name} reaches y=${numbers[i + 1]}, outside 0-${boxHeight}`);
      }
    }
    const all = LANDMARK_GLYPHS[landmark.osmId].flatMap(coordinates);
    const x = all.filter((_, index) => index % 2 === 0);
    const y = all.filter((_, index) => index % 2 === 1);
    const feet = Math.max(...y);
    const span = Math.max(Math.max(...x) - Math.min(...x), feet - Math.min(...y));
    // 花城广场 is the one drawn in plan rather than in elevation, so the claim is that a mark fills the 16 px plate
    // either by standing up or by running across it - not that everything is a tower.
    assert.ok(feet >= 20, `${landmark.name} floats ${boxHeight - feet} above the ground line`);
    assert.ok(span >= 12, `${landmark.name} is a smudge: it only spans ${span} of ${boxWidth}`);
  }
});

// A nameplate hangs above its own point (`anchor: 'bottom'`, offset [0, -6]), so both of its boxes are built from the
// point rather than typed in. The widths are the shipped plate's: 11 px text in a pill with 6/9 px of padding, and the
// 16 px silhouette on its own.
const NAME = { w: 96, h: 24 };
const GEM = { w: 28, h: 24 };
const TOWER = 584204634, EAST = 511404889, WEST = 184738716, MUSEUM = 240896442, BRIDGE = 1313608038, SQUARE = 243319596;
const plate = (osmId, x, y) => {
  const landmark = LANDMARKS.find((entry) => entry.osmId === osmId);
  const hung = ({ w, h }) => ({ x: x - w / 2, y: y - 6 - h, w, h });
  return { osmId, height: landmark.height, box: hung(NAME), diamond: hung(GEM) };
};
const verdicts = (entries, options) => Object.fromEntries(declutter(entries, options).map(({ osmId, state }) => [osmId, state]));

test('plates that keep their distance all get to speak, and the air is what decides it', () => {
  const spread = [TOWER, EAST, WEST, MUSEUM, BRIDGE, SQUARE].map((osmId, i) => plate(osmId, i * 200, 300));
  assert.deepEqual(verdicts(spread), Object.fromEntries(spread.map(({ osmId }) => [osmId, 'full'])),
    'six plates 200 px apart have no reason to hide anything');
  const crowded = declutter(spread, { pad: 200 }).map(({ state }) => state);
  assert.deepEqual(crowded, ['full', 'hidden', 'full', 'hidden', 'full', 'hidden'],
    `200 px of demanded air costs every second plate: ${JSON.stringify(crowded)}`);
});

test('the gap that reads as one line is measured, not guessed', () => {
  const touching = verdicts([plate(TOWER, 0, 300), plate(EAST, 99, 300)]);
  assert.deepEqual(touching, { [TOWER]: 'full', [EAST]: 'diamond' },
    'a 3 px gap between two pills is a garbled line, and the shorter one gives up its text');
  const clear = verdicts([plate(TOWER, 0, 300), plate(EAST, 105, 300)]);
  assert.deepEqual(Object.values(clear), ['full', 'full'], '9 px of air is enough for both to speak');
  assert.ok(DECLUTTER_PAD >= 4 && DECLUTTER_PAD <= 6, `the shipped air is ${DECLUTTER_PAD} px, outside the range measured here`);
});

test('the shorter plate is the one that gives its text up, whichever order they arrive in', () => {
  const asShipped = [plate(BRIDGE, 40, 300), plate(TOWER, 0, 300), plate(EAST, 80, 300)];
  const ranked = [plate(TOWER, 0, 300), plate(EAST, 80, 300), plate(BRIDGE, 40, 300)];
  assert.deepEqual(verdicts(asShipped), verdicts(ranked), 'the verdict is the snapshot height, not the drawing order');
  // The bridge has no height in OSM, so it is the first to lose its name; the east tower's silhouette still clears the
  // tower's plate, so it degrades rather than disappears.
  assert.deepEqual(verdicts(asShipped), { [TOWER]: 'full', [BRIDGE]: 'hidden', [EAST]: 'diamond' });
});

test('a crowded column parks the plates that would only read as one blob', () => {
  const column = [plate(WEST, 300, 300), plate(EAST, 300, 300), plate(TOWER, 300, 300)];
  assert.deepEqual(verdicts(column), { [TOWER]: 'full', [EAST]: 'hidden', [WEST]: 'hidden' },
    'nothing is nudged sideways: one name per point, and the tallest one owns it');
});

test('a parked plate reserves no space for the ones behind it', () => {
  // The east tower is parked under the tower's own plate, so the west tower is only ever asked about the tower - and
  // its silhouette lands in the air the parked plate left behind.
  const states = verdicts([plate(TOWER, 0, 300), plate(EAST, 50, 300), plate(WEST, 75, 300)]);
  assert.deepEqual(states, { [TOWER]: 'full', [EAST]: 'hidden', [WEST]: 'diamond' },
    `a plate that is not on the picture cannot block one: ${JSON.stringify(states)}`);
});

test('every plate asked about gets exactly one verdict, back in the order it was asked', () => {
  const entries = LANDMARKS.map((landmark, i) => plate(landmark.osmId, i * 40, 300));
  const report = declutter(entries);
  assert.deepEqual(report.map(({ osmId }) => osmId), entries.map(({ osmId }) => osmId), 'one verdict per plate, unmoved');
  assert.deepEqual([...new Set(report.map(({ state }) => state))].sort(), ['diamond', 'full', 'hidden'],
    'a crowded ladder really does reach all three states');
  for (const { state } of report) assert.ok(['full', 'diamond', 'hidden'].includes(state), `${state} is not a verdict`);
});

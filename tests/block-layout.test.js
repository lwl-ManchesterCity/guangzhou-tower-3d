import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schematicDisplayHeights, schematicThickness } from '../src/block-layout.js';

// 这一册只剩广州塔那一侧：`block-layout.js` 现在只派生每栋自己的示意厚度（`displayHeight`）。
// 街坊包络、道路与校园裁避那些几何属于景泰，随场景一起撤了，对应的 30 余项判据也一并撤。
// 独立预言机：自己的米制轴、自己的外接框、分档写成条件式，不复用生产里那行 clamp。
const center = { lat: 23.109, lng: 113.31913 };
const metersY = 6371008.8 * Math.PI / 180;
const metersX = Math.cos(center.lat * Math.PI / 180) * metersY;
const toGeo = ([x, y]) => [center.lng + x / metersX, center.lat + y / metersY];
const polygon = points => ({ type: 'Polygon', coordinates: [[...points, points[0]].map(toGeo)] });
const boxGeometry = ([w, s, e, n]) => polygon([[w, s], [e, s], [e, n], [w, n]]);
const building = (osmId, box, properties = {}) => ({ type: 'Feature',
  properties: { osmId, category: 'residential', height: 24, base: 3, distance: 100, area: 100, ...properties },
  geometry: boxGeometry(box) });

const illustrative = short => short <= 40 ? 9.6 : short >= 100 ? 24 : Math.round(short * 2.4) / 10;
function expectedDisplay(feature) {
  const { lng, lat } = center;
  const ring = feature.geometry.coordinates[0];
  const xs = ring.map(point => (point[0] - lng) * metersX), ys = ring.map(point => (point[1] - lat) * metersY);
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

const readJSON = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

async function mutatedLayout(from, to) {
  const url = new URL('../src/block-layout.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must replace exactly one source fragment');
  const changed = source.replace(from, to).replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

test('one thickness curve sets the display depth, and its clamp and rounding are the single source', () => {
  assert.deepEqual([[20, 9.6], [40, 9.6], [61.3, 14.7], [99.5, 23.9], [100, 24], [140, 24]].map(([short]) => [short, schematicThickness(short)]),
    [[20, 9.6], [40, 9.6], [61.3, 14.7], [99.5, 23.9], [100, 24], [140, 24]], 'the clamp and its rounding are the single source');
  const shared = building('shared', [0, 0, 61.3, 61.3], { heightSource: 'estimate', height: 9.6, base: 0 });
  assert.equal(schematicDisplayHeights([shared], { center })[0].properties.displayHeight,
    schematicThickness(61.3), 'a per-building outline displays exactly the depth the curve prescribes');
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
  const result = schematicDisplayHeights(features, { center });
  assertSchematic(result, features);
  assert.deepEqual(result.slice(0, 4).map(feature => feature.properties.displayHeight),
    [9.6, 3.25 + 14.7, 6 + 24, 14.7], 'lower bound, linear band, upper bound and the concave envelope');
  known.forEach((feature, index) => assert.strictEqual(result[4 + index], feature,
    'a tagged or level-derived height is returned untouched'));
  assert.deepEqual(features, before, 'the input snapshot must not be modified');
  assert.deepEqual(schematicDisplayHeights(features, { center }), result, 'same input yields the same field');
});

test('the shipped canton snapshot lifts 2,920 of its 3,990 placeholders and leaves 1,070 known heights alone', () => {
  const snapshot = readJSON('public/data/canton-buildings.geojson');
  const before = structuredClone(snapshot.features);
  const result = schematicDisplayHeights(snapshot.features, { center });
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
  const correct = schematicDisplayHeights(snapshot.features, { center });
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
    const broken = mutant.schematicDisplayHeights(snapshot.features, { center });
    assert.notDeepEqual(broken, correct, 'the mutant must change the derived field');
    assert.throws(() => assertSchematic(broken, snapshot.features), /displayHeight follows|new objects|invented field|untouched|must survive/,
      'the same positive assertion must reject the defect');
  });
  assert.deepEqual(schematicDisplayHeights(snapshot.features, { center }), correct);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Use MapLibre's already-installed expression engine, without a browser or new dependencies.
import { Color, createExpression, featureFilter } from '@maplibre/maplibre-gl-style-spec';
import * as lens from '../src/lens.js';

const feature = (height, heightSource, category = 'commercial', extra = {}) => ({
  type: 'Feature', properties: { height, heightSource, category, ...extra }, geometry: null,
});
const colors = ['#94c9c4', '#529fac', '#477aaf', '#6965a6', '#985d91'];
const boundaries = [
  [0, 0], [9.6, 0], [19.999, 0], [20, 1], [20.001, 1],
  [59.999, 1], [60, 2], [60.001, 2], [99.999, 2], [100, 3], [100.001, 3],
  [199.999, 3], [200, 4], [200.001, 4], [600, 4], [Number.MAX_VALUE, 4],
];
const empty = () => ({
  total: 0, sources: { height: 0, levels: 0, estimate: 0 },
  bins: Array.from({ length: 5 }, () => ({ height: 0, levels: 0 })),
});
const expectedSummary = (total, [height, levels, estimate], bins) => ({
  total, sources: { height, levels, estimate }, bins: bins.map(([height, levels]) => ({ height, levels })),
});
const mixedFeatures = () => [
  feature(20, 'height'), feature(60, 'levels'), feature(9.6, 'estimate'),
  feature(200, 'height', 'residential'), feature(9.6, 'levels', 'residential'),
  feature(100, 'levels', 'residential'), feature(0, 'estimate', 'residential'),
  feature(0, 'height', 'public'), feature(9.6, 'estimate', 'public'),
  feature(9.6, 'height', 'unknown'), feature(59.999, 'levels', 'unknown'),
  feature(9.6, 'estimate', 'unknown'), feature(200, 'estimate', 'unknown'),
];

const behaviors = {
  boundaries(module) {
    for (const source of ['height', 'levels']) {
      for (const [height, bin] of boundaries) {
        const expected = empty();
        expected.total = 1;
        expected.sources[source] = 1;
        expected.bins[bin][source] = 1;
        assert.deepEqual(module.heightSummary([feature(height, source)]), expected, `${source} at ${height} m`);
      }
    }
  },
  unknown(module) {
    // Render height is not provenance: even a zero or a tall placeholder remains unknown.
    for (const height of [0, 9.6, 20, 60, 100, 200, 600, undefined]) {
      const expected = empty();
      expected.total = 1;
      expected.sources.estimate = 1;
      assert.deepEqual(module.heightSummary([feature(height, 'estimate')]), expected, `unknown at ${height}`);
    }
    assert.deepEqual(module.heightSummary([
      feature(0, 'estimate'), feature(9.6, 'estimate'),
      feature(0, 'height'), feature(9.6, 'height'), feature(9.6, 'levels'),
    ]), expectedSummary(5, [2, 1, 2], [[2, 1], [0, 0], [0, 0], [0, 0], [0, 0]]));
  },
  categories(module) {
    const features = mixedFeatures();
    const expected = {
      all: expectedSummary(13, [4, 4, 5], [[2, 1], [1, 1], [0, 1], [0, 1], [1, 0]]),
      commercial: expectedSummary(3, [1, 1, 1], [[0, 0], [1, 0], [0, 1], [0, 0], [0, 0]]),
      residential: expectedSummary(4, [1, 2, 1], [[0, 1], [0, 0], [0, 0], [0, 1], [1, 0]]),
      public: expectedSummary(2, [1, 0, 1], [[1, 0], [0, 0], [0, 0], [0, 0], [0, 0]]),
      unknown: expectedSummary(4, [1, 1, 2], [[1, 0], [0, 1], [0, 0], [0, 0], [0, 0]]),
      absent: empty(),
    };
    assert.deepEqual(module.heightSummary(features), expected.all);
    assert.deepEqual(module.heightSummary([]), empty());
    for (const [category, summary] of Object.entries(expected)) {
      assert.deepEqual(module.heightSummary(features, category), summary, category);
      assert.deepEqual(module.heightSummary([], category), empty(), `empty ${category}`);
    }
  },
  tower(module) {
    const building = feature(20, 'height', 'public');
    const taggedTower = feature(600, 'height', 'public', { tower: true });
    const expected = expectedSummary(1, [1, 0, 0], [[0, 0], [1, 0], [0, 0], [0, 0], [0, 0]]);
    // Start with a fully annotated tower so a missing guard fails an assertion, not a TypeError.
    assert.deepEqual(module.heightSummary([taggedTower, building]), expected);
    assert.deepEqual(module.heightSummary([taggedTower, building], 'public'), expected);
    assert.deepEqual(module.heightSummary([taggedTower]), empty());
    const outline = { type: 'Feature', properties: { tower: true, name: '广州塔' }, geometry: null };
    assert.deepEqual(module.heightSummary([outline, building]), expected);
    assert.deepEqual(module.heightSummary([outline]), empty());
  },
  filters(module) {
    assert.deepEqual(module.lensFilter(), ['all', true, true]);
    const categories = ['commercial', 'residential', 'public', 'unknown'];
    const sources = ['height', 'levels', 'estimate'];
    const features = categories.flatMap(category => sources.map(source => feature(9.6, source, category)));
    for (const category of ['all', ...categories, 'absent']) {
      for (const source of ['all', ...sources, 'absent']) {
        const expression = module.lensFilter(category, source);
        const compiled = featureFilter(expression, 'filter');
        for (const item of features) {
          const expected = (category === 'all' || item.properties.category === category)
            && (source === 'all' || item.properties.heightSource === source);
          assert.equal(compiled.filter({ zoom: 15 }, item), expected,
            `${category}/${source} against ${item.properties.category}/${item.properties.heightSource}`);
        }
      }
      assert.deepEqual(module.lensFilter(category), module.lensFilter(category, 'all'));
    }
  },
  colors(module) {
    const parsed = createExpression(module.heightColor(), 'fill-extrusion-color', {
      type: 'color', default: '#000000', 'property-type': 'data-driven', transition: false,
    });
    assert.equal(parsed.result, 'success', JSON.stringify(parsed.value));
    for (const source of ['height', 'levels', 'estimate']) {
      for (const [height, bin] of boundaries) {
        assert.deepEqual(parsed.value.evaluateWithoutErrorHandling({ zoom: 15 }, feature(height, source)),
          Color.parse(source === 'estimate' ? '#9fa9ad' : colors[bin]), `${source} color at ${height} m`);
      }
    }
    // The unknown case must short-circuit before the numeric step reads a missing height.
    assert.deepEqual(parsed.value.evaluateWithoutErrorHandling({ zoom: 15 }, { properties: { heightSource: 'estimate' } }), Color.parse('#9fa9ad'));
  },
};

test('height legend fixes the five half-open bins and a separate unknown color', () => {
  assert.deepEqual(lens.HEIGHT_BINS, [
    { label: '0–20', min: 0, max: 20, color: '#94c9c4' },
    { label: '20–60', min: 20, max: 60, color: '#529fac' },
    { label: '60–100', min: 60, max: 100, color: '#477aaf' },
    { label: '100–200', min: 100, max: 200, color: '#6965a6' },
    { label: '200+', min: 200, max: Infinity, color: '#985d91' },
  ]);
  assert.equal(lens.UNKNOWN_HEIGHT_COLOR, '#9fa9ad');
});

for (const [key, title] of [
  ['boundaries', 'OSM height and building:levels occupy distinct bins at every boundary'],
  ['unknown', 'unknown zero and default 9.6 m never masquerade as annotated heights'],
  ['categories', 'category summaries count all sources independently and support empty selections'],
  ['tower', 'tower outlines and annotated towers never enter height distributions'],
  ['filters', 'MapLibre filters intersect category and height source, including all and no matches'],
  ['colors', 'MapLibre colors keep unknown gray before evaluating exact numeric step boundaries'],
]) test(title, () => behaviors[key](lens));

test('height color and combined filter expressions retain the intended MapLibre structure', () => {
  assert.deepEqual(lens.heightColor(), ['case', ['==', ['get', 'heightSource'], 'estimate'], '#9fa9ad',
    ['step', ['get', 'height'], '#94c9c4', 20, '#529fac', 60, '#477aaf', 100, '#6965a6', 200, '#985d91']]);
  assert.deepEqual(lens.lensFilter('residential', 'levels'), ['all',
    ['==', ['get', 'category'], 'residential'], ['==', ['get', 'heightSource'], 'levels']]);
  assert.deepEqual(lens.lensFilter('all', 'estimate'), ['all', true, ['==', ['get', 'heightSource'], 'estimate']]);
});

test('lens operations do not mutate inputs, constants or results from earlier calls', () => {
  const features = mixedFeatures();
  const before = structuredClone(features);
  for (const item of features) { Object.freeze(item.properties); Object.freeze(item); }
  Object.freeze(features);
  const binsBefore = structuredClone(lens.HEIGHT_BINS);
  const first = lens.heightSummary(features);
  const firstBefore = structuredClone(first);
  for (const category of ['all', 'commercial', 'residential', 'public', 'unknown', 'absent']) {
    lens.heightSummary(features, category);
    lens.lensFilter(category, 'levels');
    lens.heightColor();
  }
  assert.deepEqual(first, firstBefore);
  first.sources.height = -1;
  first.bins[0].height = -1;
  assert.deepEqual(lens.heightSummary(features), firstBefore);
  const color = lens.heightColor();
  const filter = lens.lensFilter('public', 'height');
  const colorBefore = structuredClone(color);
  const filterBefore = structuredClone(filter);
  color[1][1][1] = 'broken';
  color[3][2] = '#000000';
  filter[1][1][1] = 'broken';
  assert.deepEqual(lens.heightColor(), colorBefore);
  assert.deepEqual(lens.lensFilter('public', 'height'), filterBefore);
  assert.deepEqual(features, before);
  assert.deepEqual(lens.HEIGHT_BINS, binsBefore);
});

test('published 3 km snapshot matches independently counted source and bin totals', async () => {
  const { features } = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url)));
  const tower = JSON.parse(await readFile(new URL('../public/data/canton-tower.geojson', import.meta.url)));
  // Fixed counts for this immutable bundle, not expectations derived from lens.js.
  const expected = {
    all: expectedSummary(3990, [54, 1016, 2920], [[1, 295], [7, 400], [5, 208], [22, 112], [19, 1]]),
    commercial: expectedSummary(282, [23, 139, 120], [[0, 54], [3, 25], [3, 39], [4, 20], [13, 1]]),
    residential: expectedSummary(1415, [5, 756, 654], [[0, 162], [1, 349], [1, 159], [3, 86], [0, 0]]),
    public: expectedSummary(236, [1, 33, 202], [[0, 27], [1, 5], [0, 1], [0, 0], [0, 0]]),
    unknown: expectedSummary(2057, [25, 88, 1944], [[1, 52], [2, 21], [1, 9], [15, 6], [6, 0]]),
  };
  const inBin = [h => h >= 0 && h < 20, h => h >= 20 && h < 60, h => h >= 60 && h < 100,
    h => h >= 100 && h < 200, h => h >= 200 && Number.isFinite(h)];
  for (const [category, summary] of Object.entries(expected)) {
    const selected = features.filter(({ properties: p }) => !p.tower && (category === 'all' || p.category === category));
    const count = (source, accepts = () => true) => selected.filter(({ properties: p }) => p.heightSource === source && accepts(p.height)).length;
    const independent = expectedSummary(selected.length, [count('height'), count('levels'), count('estimate')],
      inBin.map(accepts => [count('height', accepts), count('levels', accepts)]));
    assert.deepEqual(independent, summary, `independent ${category}`);
    assert.deepEqual(lens.heightSummary(features, category), summary, `lens ${category}`);
    assert.deepEqual(lens.heightSummary([...features, ...tower.features], category), summary, `tower excluded from ${category}`);
    assert.equal(summary.bins.reduce((sum, bin) => sum + bin.height + bin.levels, 0), summary.sources.height + summary.sources.levels);
    assert.equal(summary.total, summary.sources.height + summary.sources.levels + summary.sources.estimate);
  }
});

// Reuse the real behavioral assertions against source mutants loaded only from memory.
const mutations = [
  ['changed 20 m bin edge', 'boundaries', 'max: 20, color:', 'max: 21, color:'],
  ['unknown incorrectly binned as short', 'unknown', "if (p.heightSource === 'estimate') continue;", "if (p.heightSource === 'estimate') { summary.bins[0].height++; continue; }"],
  ['unknown mixed into tagged source counts', 'unknown', 'summary.sources[p.heightSource]++;', "summary.sources[p.heightSource === 'estimate' ? 'height' : p.heightSource]++;"],
  ['levels mixed into tagged height bins', 'boundaries', 'summary.bins[index][p.heightSource]++;', 'summary.bins[index].height++;'],
  ['summary category ignored', 'categories', 'p.category !== category', 'false'],
  ['tower included', 'tower', 'p.tower || ', ''],
  ['unknown shares the lowest numeric color', 'colors', "UNKNOWN_HEIGHT_COLOR = '#9fa9ad'", "UNKNOWN_HEIGHT_COLOR = '#94c9c4'"],
  ['levels colored unknown instead of estimates', 'colors', "['get', 'heightSource'], 'estimate'], UNKNOWN_HEIGHT_COLOR", "['get', 'heightSource'], 'levels'], UNKNOWN_HEIGHT_COLOR"],
  ['color step moved by one meter', 'colors', '[bin.min, bin.color]', '[bin.min + 1, bin.color]'],
  ['filter uses union instead of intersection', 'filters', "return ['all', category", "return ['any', category"],
  ['filter ignores category', 'filters', "category === 'all' ? true : ['==', ['get', 'category'], category]", 'true'],
  ['filter reads the wrong source property', 'filters', "['get', 'heightSource'], source", "['get', 'category'], source"],
];

test('in-memory lens mutations are rejected by the focused behavioral assertions', async (t) => {
  const source = await readFile(new URL('../src/lens.js', import.meta.url), 'utf8');
  for (const [name, behavior, from, to] of mutations) {
    await t.test(name, async () => {
      assert.equal(source.split(from).length, 2, `mutation needs exactly one source target: ${from}`);
      const mutantSource = source.replace(from, to);
      // Import errors are not assertion kills; no production file or helper artifact is written.
      const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
      assert.throws(() => behaviors[behavior](mutant), { name: 'AssertionError', code: 'ERR_ASSERTION' }, `surviving mutant: ${name}`);
    });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ATMOSPHERES, baseAtmospherePaint, buildingAtmosphereColor } from '../src/atmosphere.js';

const layer = (type, source, paint = {}) => ({ id: source, type, 'source-layer': source, paint });

test('atmospheres keep water, land, roads and labels in separate palettes', () => {
  const fixtures = [
    [layer('background'), 'background-color', ['#e9eeeb', '#d9b6a0', '#182b40']],
    [layer('fill', 'water'), 'fill-color', ['#94c1c6', '#a98c9c', '#102d46']],
    [layer('line', 'waterway'), 'line-color', ['#94c1c6', '#a98c9c', '#102d46']],
    [layer('fill', 'park'), 'fill-color', ['#b1c9af', '#9a9e80', '#234344']],
    [layer('fill', 'transportation', { 'fill-pattern': 'pedestrian_polygon' }), 'fill-pattern', ['pedestrian_polygon', null, null]],
    [layer('fill', 'transportation', { 'fill-pattern': 'pedestrian_polygon' }), 'fill-color', ['#e4eae3', '#d2b19a', '#1c3044']],
    [layer('line', 'transportation'), 'line-color', ['#f6f7f2', '#efd0ac', '#46596c']],
    [layer('line', 'transportation', { 'line-gap-width': 2 }), 'line-color', ['#c5ceca', '#aa8d82', '#2b4058']],
    [{ ...layer('symbol', 'water_name'), layout: { 'text-field': '珠江' } }, 'text-color', ['#537f8c', '#674c65', '#85b6ce']],
  ];
  for (const [input, property, expected] of fixtures) {
    assert.deepEqual(Object.values(ATMOSPHERES).map(theme => baseAtmospherePaint(input, theme)[property]), expected);
  }
});

test('building atmosphere colors preserve classification and fade at the 3 km boundary', () => {
  const expression = buildingAtmosphereColor(ATMOSPHERES.night);
  assert.deepEqual(expression, ['interpolate', ['linear'], ['get', 'distance'], 0,
    ['match', ['get', 'category'], 'commercial', '#607a97', 'residential', '#485b73', 'public', '#638d9d', '#3b4e64'], 1600,
    ['match', ['get', 'category'], 'commercial', '#607a97', 'residential', '#485b73', 'public', '#638d9d', '#3b4e64'], 3000, '#26384c']);
  for (const theme of Object.values(ATMOSPHERES)) {
    assert.deepEqual(buildingAtmosphereColor(theme).slice(-2), [3000, theme.distant]);
  }
});

test('atmosphere paints do not mutate geometry, filters or the original daytime palette', () => {
  const input = { ...layer('line', 'boundary', { 'line-color': '#999999', 'line-width': 2 }), filter: ['==', ['get', 'level'], 2] };
  const original = structuredClone(input);
  const theme = structuredClone(ATMOSPHERES.night);
  assert.deepEqual(baseAtmospherePaint(input, ATMOSPHERES.night), { 'line-color': '#3b5066' });
  assert.deepEqual(baseAtmospherePaint(input, ATMOSPHERES.day), {});
  assert.deepEqual(input, original);
  assert.deepEqual(ATMOSPHERES.night, theme);
});

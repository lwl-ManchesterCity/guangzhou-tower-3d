import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCENES, resolveScene } from '../src/scenes.js';
import { addGrounds, styleGrounds } from '../src/grounds.js';
import { normalizeBuildings, searchIndex } from '../src/buildings.js';
import { distanceMeters, radiusPolygon } from '../src/geo.js';

function sceneContract(scenes, resolve) {
  assert.deepEqual(scenes.canton.center, { lat: 23.109, lng: 113.31913 });
  assert.equal(scenes.canton.radius, 3000);
  assert.deepEqual(scenes.jingtai.center, { lat: 23.17107, lng: 113.26646 });
  assert.equal(scenes.jingtai.radius, 2000);
  assert.equal(scenes.jingtai.campusId, 1178149399);
  assert.equal(scenes.jingtai.towerId, undefined);
  assert.notEqual(scenes.canton.buildings, scenes.jingtai.buildings);
  assert.notEqual(scenes.canton.index, scenes.jingtai.index);
  assert.equal(resolve('?scene=jingtai'), scenes.jingtai);
  assert.equal(resolve('?scene=canton'), scenes.canton);
  for (const query of ['', '?scene=nope', '?scene=toString', '?scene=__proto__']) assert.equal(resolve(query), scenes.canton);
  assert.deepEqual(scenes.canton.camera, { zoom: 15.5, mobileZoom: 15, landscapeZoom: 14.4, pitch: 62, bearing: -25 });
  assert.deepEqual(scenes.jingtai.camera, { zoom: 16.65, mobileZoom: 16.7, landscapeZoom: 16.45, pitch: 58, bearing: 0 });
}

test('scene identities, independent assets and query selection preserve both regions', () => {
  sceneContract(SCENES, resolveScene);
  for (const scene of Object.values(SCENES)) for (const [lng, lat] of radiusPolygon(scene.center, scene.radius).geometry.coordinates[0]) {
    assert.ok(Math.abs(distanceMeters(scene.center, { lat, lng }) - scene.radius) < 0.001);
  }
});

test('building conversion accepts a second region without changing default tower data', () => {
  const school = SCENES.jingtai;
  const raw = [{ type: 'way', id: 10, tags: { building: 'yes', name: '未知高度' }, geometry: [
    { lat: 23.171, lon: 113.266 }, { lat: 23.171, lon: 113.2661 }, { lat: 23.1711, lon: 113.2661 }, { lat: 23.171, lon: 113.266 },
  ] }];
  assert.equal(normalizeBuildings(raw).features.length, 0);
  const features = normalizeBuildings(raw, { center: school.center, radius: school.radius, towerId: null }).features;
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.height, 9.6);
  assert.equal(features[0].properties.heightSource, 'estimate');
  assert.equal(features[0].properties.category, 'unknown');
  const index = searchIndex(features, { center: school.center, radius: school.radius });
  assert.deepEqual(index.center, school.center);
  assert.equal(index.radiusMeters, 2000);
  assert.equal(index.entries[0].osmId, 10);
});

function groundsContract(add, style) {
  const layers = new Map(), sources = new Map();
  const map = {
    addSource: (id, source) => sources.set(id, source),
    addLayer: (layer, before) => layers.set(layer.id, { ...layer, before }),
    getStyle: () => ({ layers: [{ id: 'road', 'source-layer': 'transportation' }] }),
    setPaintProperty: (id, key, value) => { layers.get(id).paint[key] = value; },
  };
  const data = { type: 'FeatureCollection', features: [] };
  add(map, data);
  assert.equal(sources.get('school-grounds').data, data);
  assert.equal(layers.get('school-mountain').before, 'road');
  assert.equal(layers.get('school-parks').before, 'road');
  assert.equal(layers.get('school-campus').paint['fill-opacity'], 0.9);
  assert.equal(layers.get('school-campus').paint['fill-color'], '#72b7b0');
  assert.equal(layers.get('school-boundary').paint['line-color'], '#276d69');
  assert.equal(layers.get('school-boundary').paint['line-width'], 2.5);
  assert.deepEqual(layers.get('school-pitches').paint['fill-color'], ['case', ['==', ['get', 'target'], true], '#4a7c59', '#91b18c']);
  assert.deepEqual(layers.get('school-pitch-edge').filter, ['all', ['==', ['get', 'kind'], 'pitch'], ['==', ['get', 'target'], true]]);
  assert.equal(layers.get('school-pitch-edge').paint['line-color'], '#b5493a');
  for (const [id, fill, edge] of [['night', '#669f98', '#b4e2d6'], ['sunset', '#83b6a4', '#346c5c'], ['day', '#72b7b0', '#276d69']]) {
    style(map, id);
    assert.notEqual(layers.get('school-mountain').paint['fill-color'], layers.get('school-parks').paint['fill-color']);
    assert.equal(layers.get('school-campus').paint['fill-color'], fill);
    assert.equal(layers.get('school-boundary').paint['line-color'], edge);
    assert.equal(layers.get('school-campus').paint['fill-opacity'], 0.9);
    assert.equal(layers.get('school-pitch-edge').paint['line-color'], '#b5493a');
  }
}

test('school grounds keep true geometry, a distinct teal campus and exclusive red-green pitches', () => groundsContract(addGrounds, styleGrounds));

test('in-memory scene and ground defects are rejected without changing the running app', async () => {
  const sceneSource = await readFile(new URL('../src/scenes.js', import.meta.url), 'utf8');
  const groundSource = await readFile(new URL('../src/grounds.js', import.meta.url), 'utf8');
  const mutations = [
    [sceneSource, 'radius: 2000', 'radius: 1000', module => sceneContract(module.SCENES, module.resolveScene)],
    [sceneSource, '23.17107', '23.16768', module => sceneContract(module.SCENES, module.resolveScene)],
    [sceneSource, "Object.hasOwn(SCENES, id)", 'true', module => sceneContract(module.SCENES, module.resolveScene)],
    [groundSource, "'#4a7c59'", "'#b5493a'", module => groundsContract(module.addGrounds, module.styleGrounds)],
    [groundSource, "['all', ['==', ['get', 'kind'], 'pitch'], ['==', ['get', 'target'], true]]", "['==', ['get', 'kind'], 'pitch']", module => groundsContract(module.addGrounds, module.styleGrounds)],
    [groundSource, "'line-width': 2.5", "'line-width': 0", module => groundsContract(module.addGrounds, module.styleGrounds)],
    ...[['zoom: 16.65', 'zoom: 15.8'], ['mobileZoom: 16.7', 'mobileZoom: 16.1'], ['landscapeZoom: 16.45', 'landscapeZoom: 15.8'], ['pitch: 58', 'pitch: 48'], ['bearing: 0', 'bearing: 5'], ['pitch: 62', 'pitch: 48']].map(([from, to]) => [sceneSource, from, to, module => sceneContract(module.SCENES, module.resolveScene)]),
    ...[
      ["'fill-opacity': 0.9", "'fill-opacity': 0.5"],
      ["'fill-color': '#72b7b0'", "'fill-color': '#eadba1'"],
      ["'line-color': '#276d69'", "'line-color': '#c1a052'"],
      ["'#669f98'", "'#b9a578'"], ["'#83b6a4'", "'#dfbe84'"],
      ["'#abc594', '#72b7b0'", "'#abc594', '#eadba1'"],
      ["'#b4e2d6'", "'#c1a052'"], ["'#346c5c'", "'#c1a052'"],
      ["'#346c5c' : '#276d69'", "'#346c5c' : '#c1a052'"],
    ].map(([from, to]) => [groundSource, from, to, module => groundsContract(module.addGrounds, module.styleGrounds)]),
  ];
  for (const [source, from, to, check] of mutations) {
    assert.equal(source.split(from).length, 2, from);
    const module = await import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString('base64')}`);
    assert.throws(() => check(module), { code: 'ERR_ASSERTION' });
  }
});

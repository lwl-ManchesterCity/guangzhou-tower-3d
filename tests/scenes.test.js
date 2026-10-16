import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCENES, resolveScene } from '../src/scenes.js';
import { normalizeBuildings, searchIndex } from '../src/buildings.js';
import { distanceMeters, radiusPolygon } from '../src/geo.js';

// 景泰那格撤了，`SCENES` 只剩广州塔：这一册看着像只剩一条断言的场景表，但它守的是「未知 scene 必须落回塔」。
function sceneContract(scenes, resolve) {
  assert.deepEqual(Object.keys(scenes), ['canton'], '场景表里只剩广州塔');
  assert.deepEqual(scenes.canton.center, { lat: 23.109, lng: 113.31913 });
  assert.equal(scenes.canton.radius, 3000);
  assert.equal(scenes.canton.towerId, 584204634);
  assert.equal(scenes.canton.campusId, undefined);
  assert.equal(scenes.canton.buildings, 'canton-buildings.geojson');
  assert.equal(scenes.canton.index, 'canton-buildings-index.json');
  assert.equal(resolve('?scene=canton'), scenes.canton);
  // 旧链接里还写着 `?scene=jingtai`：它不能再指向一个已撤下的场景，只能安静地落回塔。
  for (const query of ['', '?scene=jingtai', '?scene=nope', '?scene=toString', '?scene=__proto__']) {
    assert.equal(resolve(query), scenes.canton, query);
  }
  assert.deepEqual(scenes.canton.camera, { zoom: 15.5, mobileZoom: 15, landscapeZoom: 14.4, pitch: 62, bearing: -25 });
}

test('the single scene keeps its identity, assets, camera and the fallback for unknown queries', () => {
  sceneContract(SCENES, resolveScene);
  for (const scene of Object.values(SCENES)) for (const [lng, lat] of radiusPolygon(scene.center, scene.radius).geometry.coordinates[0]) {
    assert.ok(Math.abs(distanceMeters(scene.center, { lat, lng }) - scene.radius) < 0.001);
  }
});

test('building conversion keeps the tower placeholder rule and the 3 km clip without a second region', () => {
  const scene = SCENES.canton;
  const raw = [{ type: 'way', id: 10, tags: { building: 'yes', name: '未知高度' }, geometry: [
    { lat: 23.1105, lon: 113.3205 }, { lat: 23.1105, lon: 113.3215 }, { lat: 23.1115, lon: 113.3215 }, { lat: 23.1105, lon: 113.3205 },
  ] }];
  // 传空 towerId 才是「这一份快照里没有那座塔」的写法，默认值会把 584204634 那条轮廓带进来。
  const features = normalizeBuildings(raw, { center: scene.center, radius: scene.radius, towerId: null }).features;
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.height, 9.6);
  assert.equal(features[0].properties.heightSource, 'estimate');
  assert.equal(features[0].properties.category, 'unknown');
  const index = searchIndex(features, { center: scene.center, radius: scene.radius });
  assert.deepEqual(index.center, scene.center);
  assert.equal(index.radiusMeters, 3000);
  assert.equal(index.entries[0].osmId, 10);
  // 圆外的体块一条都不留：半径这道门与场景表里的 3000 m 是同一个数。
  const outside = [{ type: 'way', id: 11, tags: { building: 'yes' }, geometry: [
    { lat: 39.9, lon: 116.4 }, { lat: 39.9, lon: 116.401 }, { lat: 39.901, lon: 116.401 }, { lat: 39.9, lon: 116.4 },
  ] }];
  assert.equal(normalizeBuildings(outside, { center: scene.center, radius: scene.radius, towerId: null }).features.length, 0);
});

test('in-memory scene defects are rejected without changing the running app', async () => {
  const sceneSource = await readFile(new URL('../src/scenes.js', import.meta.url), 'utf8');
  const mutations = [
    ['radius: 3000', 'radius: 1000'],
    ['23.109', '23.16768'],
    ['113.31913', '113.26646'],
    ['canton-buildings.geojson', 'jingtai-buildings.geojson'],
    ['canton-buildings-index.json', 'jingtai-buildings-index.json'],
    ['towerId: 584204634', 'towerId: undefined'],
    ['Object.hasOwn(SCENES, id)', 'true'],
    ...[['zoom: 15.5', 'zoom: 15.8'], ['mobileZoom: 15', 'mobileZoom: 16.1'], ['landscapeZoom: 14.4', 'landscapeZoom: 15.8'],
      ['pitch: 62', 'pitch: 48'], ['bearing: -25', 'bearing: 5']].map(([from, to]) => [from, to]),
  ];
  for (const [from, to] of mutations) {
    assert.equal(sceneSource.split(from).length, 2, from);
    const module = await import(`data:text/javascript;base64,${Buffer.from(sceneSource.replace(from, to)).toString('base64')}`);
    assert.throws(() => sceneContract(module.SCENES, module.resolveScene), { code: 'ERR_ASSERTION' }, from);
  }
});

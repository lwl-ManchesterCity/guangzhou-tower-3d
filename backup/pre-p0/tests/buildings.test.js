import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3 } from 'three';
import { buildingCategory, buildingHeight, buildingLabels, formatAddress, insideRing, interiorPoint, normalizeBuildings, ringCentroid, searchIndex, towerFeature } from '../src/buildings.js';
import { applyTowerAtmosphere, createTowerModel, towerPoint } from '../src/tower.js';
import { DEFAULT_CENTER, TOWER_OSM_ID } from '../src/config.js';
import { ATMOSPHERES } from '../src/atmosphere.js';
import { distanceMeters } from '../src/geo.js';

const way = (id, tags = { building: 'office', height: '50' }) => ({ type: 'way', id, tags, geometry: [
  { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lng }, { lat: DEFAULT_CENTER.lat + 0.0001, lon: DEFAULT_CENTER.lng },
  { lat: DEFAULT_CENTER.lat + 0.0001, lon: DEFAULT_CENTER.lng + 0.0001 }, { lat: DEFAULT_CENTER.lat, lon: DEFAULT_CENTER.lng },
] });

test('building uses come from explicit tags, never names or heights', () => {
  assert.equal(buildingCategory({ building: 'office' }), 'commercial');
  assert.equal(buildingCategory({ building: 'apartments' }), 'residential');
  assert.equal(buildingCategory({ building: 'school' }), 'public');
  assert.equal(buildingCategory({ building: 'yes', name: '某商务中心', height: '300' }), 'unknown');
  assert.equal(buildingCategory({ 'building:part': 'commercial' }), 'commercial');
});

test('height uses strict numeric tags and documents estimation', () => {
  assert.deepEqual(buildingHeight({ height: '50 m', min_height: '10' }), { height: 50, base: 10, heightSource: 'height', levels: null });
  assert.deepEqual(buildingHeight({ 'building:levels': '10' }), { height: 32, base: 0, heightSource: 'levels', levels: 10 });
  assert.deepEqual(buildingHeight({ height: '50oops', 'building:levels': '某广场' }), { height: 9.6, base: 0, heightSource: 'estimate', levels: null });
});

test('only whitelisted tags reach the snapshot so untrusted text stays out', () => {
  assert.deepEqual(buildingLabels({
    name: '星海音乐厅', 'name:en': 'Xinghai Concert Hall', building: 'public', amenity: 'theatre',
    'addr:street': '晴波路', 'addr:housenumber': '33', start_date: '2010', description: '<img src=x onerror=alert(1)>',
  }), { name: '星海音乐厅', nameEn: 'Xinghai Concert Hall', type: 'public', place: 'theatre', street: '晴波路', house: '33', built: '2010' });
  assert.deepEqual(buildingLabels({ building: 'yes', office: 'yes', note: '自由文本' }), {});
  assert.deepEqual(buildingLabels({ 'building:part': 'roof', tourism: 'museum' }), { type: 'roof', place: 'museum' });
});

test('the tower outline survives as a hit target with its own labels', () => {
  const tower = { type: 'way', id: TOWER_OSM_ID, tags: { man_made: 'tower', tower: 'observation', name: '广州塔', height: '600' }, geometry: way(1).geometry };
  const feature = towerFeature([way(9, { building: 'apartments' }), tower]);
  assert.equal(feature.id, TOWER_OSM_ID);
  assert.deepEqual(feature.properties, { osmId: TOWER_OSM_ID, tower: true, kind: 'tower', distance: 0, name: '广州塔' });
  assert.equal(feature.geometry.coordinates[0].length, 4);
  assert.deepEqual(feature.geometry.coordinates[0][0], feature.geometry.coordinates[0].at(-1));
  assert.equal(towerFeature([way(9, { building: 'apartments' })]), null);
});

test('geometry filters duplicate, invalid, underground and tower block features', () => {
  const invalid = way(2); invalid.geometry[1].lat = NaN;
  const outside = way(3); outside.geometry.forEach((p) => { p.lat += 1; });
  const result = normalizeBuildings([way(1), way(1), invalid, outside, way(TOWER_OSM_ID), way(4, { building: 'yes', height: '0' }), way(5, { building: 'yes', 'building:levels': '-1' })]);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.category, 'commercial');
  assert.ok(result.features[0].properties.area > 0);
});

test('building footprints inside 3 km survive while the old 3–5 km annulus is excluded', () => {
  const inside = way(1);
  const annulus = way(2);
  inside.geometry.forEach((point) => { point.lat += 0.025; });
  annulus.geometry.forEach((point) => { point.lat += 0.035; });
  const distances = (building) => building.geometry.map((point) => distanceMeters(DEFAULT_CENTER, { lat: point.lat, lng: point.lon }));
  assert.ok(distances(inside).every((distance) => distance > 2500 && distance < 3000));
  assert.ok(distances(annulus).every((distance) => distance > 3000 && distance < 5000));
  assert.deepEqual(normalizeBuildings([annulus, inside]).features.map((feature) => feature.id), [1]);
});

test('snapshot is geographically fixed, attributed and includes all four classifications', async () => {
  const data = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url)));
  assert.equal(data.metadata.radiusMeters, 3000);
  assert.deepEqual(data.metadata.center, DEFAULT_CENTER);
  assert.equal(data.metadata.license, 'ODbL-1.0');
  assert.equal(data.features.length, 3990);
  assert.equal(data.metadata.buildings, 3990);
  assert.deepEqual(new Set(data.features.map((f) => f.properties.category)), new Set(['commercial', 'residential', 'public', 'unknown']));
  assert.ok(data.features.every((f) => f.id !== TOWER_OSM_ID && f.properties.distance <= 3000 && f.properties.height > f.properties.base));
  assert.equal(new Set(data.features.map((f) => f.id)).size, data.features.length);
});

test('snapshot carries whitelisted labels only, and the tower outline ships beside it', async () => {
  const data = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url)));
  const allowed = new Set(['osmId', 'category', 'height', 'base', 'heightSource', 'distance', 'area', 'levels', 'name', 'nameEn', 'type', 'place', 'street', 'house', 'built']);
  assert.ok(data.features.every((f) => Object.keys(f.properties).every((key) => allowed.has(key))));
  assert.ok(data.features.some((f) => f.properties.heightSource === 'levels' && f.properties.levels > 0));
  assert.ok(data.features.some((f) => f.properties.name && f.properties.type && f.properties.place));
  assert.equal(data.metadata.named, data.features.filter((f) => f.properties.name).length);
  assert.equal(data.metadata.named, 624);
  const tower = JSON.parse(await readFile(new URL('../public/data/canton-tower.geojson', import.meta.url)));
  assert.equal(tower.features.length, 1);
  assert.equal(tower.features[0].properties.tower, true);
  assert.equal(tower.features[0].properties.name, '广州塔');
  assert.equal(tower.features[0].properties.osmId, TOWER_OSM_ID);
});

test('footprint anchors use ray casting and an origin-shifted centroid', () => {
  const square = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.equal(insideRing(square, 1, 1), true);
  assert.equal(insideRing(square, 3, 1), false);
  assert.deepEqual(ringCentroid(square), [1, 1]);
  // An area centroid of a 4e-5 degree footprint at longitude 113 is a difference of large products: computed on the
  // absolute coordinates it lands 1.8 km away, so the ring has to be shifted to its own average first.
  const s = 1e-5;
  const L = [[0, 0], [4, 0], [4, 2], [1, 2], [1, 4], [0, 4], [0, 0]].map(([x, y]) => [Number((113.31913 + x * s).toFixed(7)), Number((23.109 + y * s).toFixed(7))]);
  assert.ok(Math.abs(ringCentroid(L)[0] - 113.319147) < 1e-9, String(ringCentroid(L)));
  assert.ok(Math.abs(ringCentroid(L)[1] - 23.109014) < 1e-9, String(ringCentroid(L)));
  // A ring with no area of its own is a sliver, so the vertex average stands in for the centroid.
  assert.deepEqual(ringCentroid([[1, 1], [2, 2], [1, 1], [2, 2], [1, 1]]), [1.5, 1.5]);
});

test('an anchor for a concave block is searched back inside its own outline', () => {
  const u = [[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6], [0, 0]];
  const [cx, cy] = ringCentroid(u);
  assert.equal(insideRing(u, cx, cy), false, 'the centroid sits in the notch');
  const [lng, lat] = interiorPoint(u);
  assert.equal(insideRing(u, lng, lat), true);
  assert.equal(interiorPoint([[1, 1], [2, 2], [1, 1]]).length, 2);
  for (const point of interiorPoint(u)) assert.ok(Number(point.toFixed(7)) === point);
});

test('the search index keeps every block a query can name, with the point a pick needs', () => {
  const square = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  const block = (properties) => ({ type: 'Feature', id: properties.osmId, properties, geometry: { type: 'Polygon', coordinates: [square] } });
  const { entries } = searchIndex([
    block({ osmId: 2, category: 'unknown', height: 9.6, distance: 900 }),
    block({ osmId: 3, name: '某楼', category: 'residential', height: 20.4, distance: 100 }),
    block({ osmId: 1, street: '某路', house: '3', category: 'commercial', height: 33.6, heightSource: 'levels', distance: 500 }),
  ]);
  assert.deepEqual(entries, [
    { osmId: 3, name: '某楼', nameEn: '', street: '', house: '', category: 'residential', height: 20, heightSource: 'estimate', distance: 100, lat: 1, lng: 1 },
    { osmId: 1, name: '', nameEn: '', street: '某路', house: '3', category: 'commercial', height: 34, heightSource: 'levels', distance: 500, lat: 1, lng: 1 },
  ]);
  // The tower has no snapshot height of its own, but it stays findable as a public landmark.
  const tower = searchIndex([{ type: 'Feature', id: TOWER_OSM_ID, properties: { osmId: TOWER_OSM_ID, tower: true, name: '广州塔', distance: 0 }, geometry: { type: 'Polygon', coordinates: [square] } }]).entries[0];
  assert.deepEqual(tower, { osmId: TOWER_OSM_ID, tower: true, name: '广州塔', nameEn: '', street: '', house: '', category: 'public', height: 0, heightSource: 'estimate', distance: 0, lat: 1, lng: 1 });
});

test('housenumbers that already carry a suffix are not suffixed twice', () => {
  assert.equal(formatAddress('赤岗北路', '118'), '赤岗北路 118 号');
  assert.equal(formatAddress('赤岗北路', '1 - 2'), '赤岗北路 1 - 2 号');
  assert.equal(formatAddress('滨江东路', '795号'), '滨江东路 795号');
  assert.equal(formatAddress('珠江东路', 'Zhujiang Road East 4号'), '珠江东路 Zhujiang Road East 4号');
  assert.equal(formatAddress('新港中路', ''), '新港中路');
  assert.equal(formatAddress('', '33'), '');
});

test('the shipped index is the shipped snapshot: same blocks, same anchors, same provenance', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url)));
  const tower = JSON.parse(await readFile(new URL('../public/data/canton-tower.geojson', import.meta.url)));
  const shipped = JSON.parse(await readFile(new URL('../public/data/canton-buildings-index.json', import.meta.url)));
  assert.deepEqual(shipped, searchIndex([...snapshot.features, ...tower.features]));
  assert.equal(shipped.radiusMeters, 3000);
  assert.equal(shipped.entries.length, 638);
  assert.equal(shipped.entries.length, snapshot.features.filter((f) => f.properties.name || f.properties.street).length + 1);
  const rings = new Map([...snapshot.features, ...tower.features].map((f) => [f.id, f.geometry.coordinates[0]]));
  for (const item of shipped.entries) {
    assert.equal(rings.has(item.osmId), true, `检索结果 ${item.osmId} 不在快照里`);
    // A shared link re-opens the card by picking this point, so it has to fall inside the block it names.
    assert.equal(insideRing(rings.get(item.osmId), item.lng, item.lat), true, `锚点落在楼外：${item.osmId} ${item.name}`);
    assert.ok(Number.isSafeInteger(item.osmId) && item.osmId > 0);
    assert.ok(['height', 'levels', 'estimate'].includes(item.heightSource));
    assert.ok(item.distance <= 3000 && item.height >= 0);
    assert.ok(!item.house || !formatAddress(item.street, item.house).includes('号 号'));
  }
});

test('tower has a narrow twisted waist, 600m silhouette and bounded draw calls', () => {
  const waist = towerPoint(0.55, 0);
  assert.ok(Math.hypot(waist.x, waist.z) < 20);
  const model = createTowerModel();
  const box = new Box3().setFromObject(model);
  assert.ok(Math.abs(box.max.y - 600) < 0.01);
  assert.ok(box.min.y >= -1);
  assert.ok(model.children.length < 16);
  const materials = new Set();
  model.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) materials.add(o.material); if (o.isInstancedMesh) o.dispose(); });
  materials.forEach((m) => m.dispose());
});

test('tower atmospheres', async (t) => {
  const model = createTowerModel();
  const original = model.children.map((mesh) => ({ mesh, geometry: mesh.geometry, material: mesh.material }));
  const materials = [...new Set(original.map(({ material }) => material))];
  const sequence = ['day', 'sunset', 'night', 'day'];
  t.after(() => {
    model.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    materials.forEach((material) => material.dispose());
  });

  await t.test('model retains the default daylight materials and Group', () => {
    assert.equal(model.isGroup, true);
    assert.deepEqual(materials.map((material) => material.name), ['silver', 'pale', 'diagonal', 'glass', 'warm']);
    for (const material of materials) {
      assert.equal(material.color.getHexString(), ATMOSPHERES.day.tower.colors[material.name].slice(1));
      assert.equal(material.emissive.getHexString(), '000000');
      assert.equal(material.emissiveIntensity, 1);
    }
  });

  await t.test('colors match all three presets and restore daylight after night', () => {
    for (const key of sequence) {
      const preset = ATMOSPHERES[key].tower;
      applyTowerAtmosphere(model, preset);
      for (const material of materials) {
        assert.equal(material.color.getHexString(), preset.colors[material.name].slice(1), `${key} ${material.name} color`);
      }
    }
  });

  await t.test('emission matches all three presets and turns off after night', () => {
    for (const key of sequence) {
      const preset = ATMOSPHERES[key].tower;
      applyTowerAtmosphere(model, preset);
      for (const material of materials) {
        const [color, intensity] = preset.emission[material.name];
        assert.equal(material.emissive.getHexString(), color.slice(1), `${key} ${material.name} emissive`);
        assert.equal(material.emissiveIntensity, intensity, `${key} ${material.name} emissiveIntensity`);
      }
    }
  });

  await t.test('switching preserves every mesh, geometry and shared material identity', () => {
    for (const key of sequence) {
      applyTowerAtmosphere(model, ATMOSPHERES[key].tower);
      assert.equal(model.children.length, original.length);
      original.forEach(({ mesh, geometry, material }, index) => {
        assert.ok(model.children[index] === mesh, `${key} mesh identity`);
        assert.ok(mesh.geometry === geometry, `${key} geometry identity`);
        assert.ok(mesh.material === material, `${key} material identity`);
      });
    }
  });
});

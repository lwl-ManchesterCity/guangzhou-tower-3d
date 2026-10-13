import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AdditiveBlending, Box3, Color } from 'three';
import { buildingCategory, buildingHeight, buildingLabels, formatAddress, insideRing, interiorPoint, normalizeBuildings, ringCentroid, searchIndex, towerFeature } from '../src/buildings.js';
import { applyTowerAtmosphere, applyTowerHue, applyTowerPulse, SPILL_REACH_METRES, channelCrossing, createGlowBand, createTowerBeam, createTowerModel, outlineRing, towerBreath, towerGlow, towerHue, towerPoint } from '../src/tower.js';
import { LANDMARK_FORMS } from '../src/landmark-forms.js';
import { DEFAULT_CENTER, TOWER_OSM_ID } from '../src/config.js';
import { ATMOSPHERES } from '../src/atmosphere.js';
import { distanceMeters, plane } from '../src/geo.js';

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

// The pulse may only scale the light an atmosphere has already decided to emit: the shipped baseline is the top of its
// range, a preset with no emission has nothing to breathe, and putting the loop back has to land on that baseline
// exactly. Stated as one pass over the module so a mutant is graded against the same rules, not a looser sibling.
function assertPulse(tower) {
  const model = tower.createTowerModel();
  const materials = [...new Set(model.children.map((mesh) => mesh.material))];
  try {
    assert.equal(tower.towerBreath(0), 0, 'a cycle opens dimmed');
    assert.equal(tower.towerBreath(0.5), 1, 'a cycle peaks at the atmosphere baseline');
    assert.equal(tower.towerBreath(1), 0, 'a wrapped cycle hands back the frame it opened on');
    for (const cycle of [0.1, 0.25, 0.4]) assert.ok(tower.towerBreath(cycle) < tower.towerBreath(cycle + 0.05), `the first half has to swell at ${cycle}`);
    for (const cycle of [0.6, 0.75, 0.9]) assert.ok(tower.towerBreath(cycle) > tower.towerBreath(cycle + 0.05), `the second half has to settle at ${cycle}`);
    for (const cycle of [0, 0.2, 0.5, 0.8, 1]) assert.ok(Math.abs(tower.towerBreath(cycle) - tower.towerBreath(1 - cycle)) < 1e-12, 'the swell and the settle are mirror images');
    for (const bad of [-0.01, 1.01, Number.NaN, undefined]) assert.throws(() => tower.towerBreath(bad), /between 0 and 1/, 'a cycle outside the range is refused');

    const baselines = Object.entries(ATMOSPHERES)
      .flatMap(([key, atmosphere]) => Object.entries(atmosphere.tower.emission).map(([name, [, intensity]]) => [key, name, intensity]));
    assert.ok(baselines.some(([, , b]) => b > 0) && baselines.some(([, , b]) => b === 0),
      'the contract needs both a lit preset and a dark one to mean anything');
    for (const [key, name, baseline] of baselines) {
      assert.equal(tower.towerGlow(baseline, 1), baseline, `${key} ${name}: amount 1 has to be the shipped frame`);
      if (!baseline) {
        for (const amount of [0, 0.4, 1]) assert.equal(tower.towerGlow(baseline, amount), 0, `${key} ${name}: no emission, nothing to breathe`);
        continue;
      }
      const trough = tower.towerGlow(baseline, 0);
      assert.ok(trough > baseline * 0.5 && trough < baseline * 0.7,
        `${key} ${name}: the dip has to read and still keep better than half the light (${trough} of ${baseline})`);
      let previous = -1;
      for (const amount of [0, 0.2, 0.5, 0.8, 1]) {
        const glow = tower.towerGlow(baseline, amount);
        assert.ok(glow >= previous && glow <= baseline, `${key} ${name}: the glow has to climb inside its baseline`);
        previous = glow;
      }
    }
    for (const bad of [-0.01, 1.2, Number.NaN, undefined]) assert.throws(() => tower.towerGlow(0.5, bad), /between 0 and 1/, 'an amount outside the range is refused');
    assert.throws(() => tower.towerGlow(-0.1, 0.5), /negative/, 'a preset cannot ask for a negative light');

    for (const key of ['day', 'sunset', 'night']) {
      const preset = ATMOSPHERES[key].tower;
      tower.applyTowerAtmosphere(model, preset);
      const shipped = materials.map((material) => material.emissiveIntensity);
      const painted = materials.map((material) => [material.color.getHexString(), material.emissive.getHexString()]);
      tower.applyTowerPulse(model, preset, tower.towerBreath(0.37));
      assert.deepEqual(materials.map((material) => [material.color.getHexString(), material.emissive.getHexString()]), painted,
        `${key}: a pulse is a brightness change, not a repaint`);
      tower.applyTowerPulse(model, preset, 1);
      assert.deepEqual(materials.map((material) => material.emissiveIntensity), shipped, `${key}: putting the loop back has to be the preset frame`);
      tower.applyTowerPulse(model, preset, tower.towerBreath(0));
      assert.deepEqual(materials.map((material) => material.emissiveIntensity), shipped.map((v) => tower.towerGlow(v, 0)),
        `${key}: the trough is the same frame at either end of the cycle`);
      for (const material of materials) {
        const baseline = preset.emission[material.name][1];
        assert.equal(material.emissiveIntensity, tower.towerGlow(baseline, 0), `${key} ${material.name}: trough`);
        if (!baseline) assert.equal(material.emissiveIntensity, 0, `${key}: a tower with no emission cannot be lit by the pulse`);
      }
    }

    const preset = ATMOSPHERES.night.tower;
    tower.applyTowerAtmosphere(model, preset);
    const [first, ...rest] = materials;
    const listed = first.name;
    first.name = 'unlisted';
    assert.doesNotThrow(() => tower.applyTowerPulse(model, preset, 0.4), 'a material the preset does not know is skipped');
    assert.equal(first.emissiveIntensity, preset.emission[listed][1], 'an unlisted material keeps what the atmosphere gave it');
    for (const material of rest) {
      assert.equal(material.emissiveIntensity, tower.towerGlow(preset.emission[material.name][1], 0.4), `${material.name} still pulses`);
    }
    first.name = listed;
  } finally {
    model.traverse((object) => { if (object.geometry) object.geometry.dispose(); if (object.isInstancedMesh) object.dispose(); });
    materials.forEach((material) => material.dispose());
  }
}

async function mutatedTower(from, to) {
  const url = new URL('../src/tower.js', import.meta.url);
  const source = await readFile(url, 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must replace exactly one source fragment');
  const changed = source.replace(from, to)
    .replace(/from '([^./][^']*)'/g, (specifier, name) => `from '${import.meta.resolve(name)}'`)
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

const pulseRejects = /opens dimmed|peaks at|hands back the frame|has to swell|has to settle|mirror images|between 0 and 1|refused|shipped frame|nothing to breathe|better than half the light|climb inside|negative|not a repaint|preset frame|either end|trough|cannot be lit|skipped|keeps what the atmosphere|still pulses|mean anything/;

const pulseModule = { createTowerModel, applyTowerAtmosphere, applyTowerPulse, towerBreath, towerGlow };

test('tower pulse', async (t) => {
  assertPulse(pulseModule);
  const specs = [
    ['the tower goes fully dark at the trough', 'return baseline * (1 - (1 - TOWER_GLOW_FLOOR) * (1 - amount));', 'return baseline * amount;'],
    ['the dip is too shallow to see', 'export const TOWER_GLOW_FLOOR = 0.55;', 'export const TOWER_GLOW_FLOOR = 0.9;'],
    ['day lighting is invented by the pulse', 'if (!baseline) return 0;', 'if (!baseline) return 0.2;'],
    ['half a cycle is billed as a whole one', 'return 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2);', 'return 0.5 - 0.5 * Math.cos(cycle * Math.PI);'],
    ['amount bounds dropped', 'if (!(amount >= 0 && amount <= 1)) throw', 'if (false) throw'],
    ['baseline bounds dropped', 'if (!(baseline >= 0)) throw', 'if (false) throw'],
    ['an unlisted material stops the loop', 'if (!entry) continue;', ''],
  ];
  for (const [name, from, to] of specs) await t.test(name, async () => {
    const mutant = await mutatedTower(from, to);
    assert.throws(() => assertPulse(mutant), pulseRejects, `${name} must be rejected`);
    assert.doesNotThrow(() => assertPulse(pulseModule), 'the shipped module must still pass');
  });
});

test('the tower colour cycle turns every lit material and leaves the rest alone', () => {
  const night = ATMOSPHERES.night.tower;
  const model = createTowerModel();
  applyTowerAtmosphere(model, night);
  const shipped = new Map();
  model.traverse((object) => { if (object.material?.emissive) shipped.set(object.material.name, object.material.emissive.getHexString()); });
  assert.ok(shipped.size >= 4, `the tower should light several materials, saw ${shipped.size}`);

  applyTowerHue(model, night, towerHue(1));
  model.traverse((object) => {
    if (!object.material?.emissive) return;
    assert.equal(object.material.emissive.getHexString(), shipped.get(object.material.name),
      `${object.material.name}: a whole turn of the wheel has to land back where the preset put it`);
  });

  const shift = 0.25;
  applyTowerHue(model, night, shift);
  const seen = new Set();
  model.traverse((object) => {
    const material = object.material;
    if (!material?.emissive) return;
    const entry = night.emission[material.name];
    if (!entry) return;
    seen.add(material.name);
    if (!entry[1]) {
      assert.equal(material.emissive.getHexString(), new Color(entry[0]).getHexString(),
        `${material.name} does not glow in this theme, so there is no hue to turn`);
      return;
    }
    const base = new Color(entry[0]);
    const wanted = { h: 0, s: 0, l: 0 };
    const got = { h: 0, s: 0, l: 0 };
    base.getHSL(wanted);
    material.emissive.getHSL(got);
    assert.ok(Math.abs((got.h - wanted.h + 1) % 1 - shift) < 1e-6, `${material.name} turned by ${got.h - wanted.h}`);
    assert.ok(Math.abs(got.s - wanted.s) < 1e-6 && Math.abs(got.l - wanted.l) < 1e-6, `${material.name} lost its saturation or lightness`);
  });
  assert.ok(seen.size >= 4, `the cycle reached ${seen.size} materials`);
  applyTowerHue(model, night, 0);
  model.traverse((object) => {
    if (object.material?.emissive && shipped.has(object.material.name)) {
      assert.equal(object.material.emissive.getHexString(), shipped.get(object.material.name), 'stopping hands back the shipped colour');
    }
  });
  assert.throws(() => towerHue(1.4), /between 0 and 1/);
  assert.throws(() => towerHue(-0.1), /between 0 and 1/);
});

test('the night show this scene defaults to puts the whole shaft on one hue', async () => {
  const { TOWER_MODES } = await import('../src/tower.js');
  assert.deepEqual(TOWER_MODES, ['single', 'cycle', 'breath'], '单色 is first because it is what the page opens on');
  const night = ATMOSPHERES.night.tower;
  const model = createTowerModel();
  applyTowerAtmosphere(model, night);
  const shipped = new Map();
  model.traverse((object) => {
    if (!object.material?.emissive) return;
    shipped.set(object.material.name, { emissive: object.material.emissive.getHexString(), color: object.material.color.getHexString() });
  });
  const glowing = () => Object.entries(night.emission).filter(([, [, intensity]]) => intensity).map(([name]) => name);
  assert.ok(glowing().length >= 4, 'the preset lights several materials, which is the thing being collapsed');
  const handBack = (scheme) => {
    applyTowerHue(model, night, 0, scheme);
    model.traverse((object) => {
      const before = shipped.get(object.material?.name);
      if (!before) return;
      for (const property of ['emissive', 'color']) {
        assert.equal(object.material[property].getHexString(), before[property],
          `${object.material.name}.${property}: shift 0 in the ${scheme} scheme has to be the preset, or stopping does not hand the frame back`);
      }
    });
  };
  handBack('single');
  handBack('cycle');

  const hsl = (name, property = 'emissive') => {
    const found = { h: 0, s: 0, l: 0 };
    model.traverse((object) => { if (object.material?.name === name) object.material[property].getHSL(found); });
    return found;
  };
  const arc = (a, b) => Math.abs(((a - b + 1.5) % 1) - 0.5);
  applyTowerHue(model, night, 0.3, 'single');
  const one = hsl(glowing()[0]);
  for (const name of glowing()) {
    // Both halves of the material: the lattice is also lit by the scene's own lights, so a diffuse colour left behind
    // by the glow keeps a second hue on the shaft - which is the whole thing this scheme exists to stop.
    for (const property of ['emissive', 'color']) {
      const got = hsl(name, property);
      assert.ok(arc(got.h, one.h) < 1e-6, `${name}.${property} sits ${arc(got.h, one.h).toFixed(3)} of a turn from the show's hue: the shaft is still in more than one colour`);
    }
    const wanted = { h: 0, s: 0, l: 0 };
    new Color(night.emission[name][0]).getHSL(wanted);
    const got = hsl(name);
    assert.ok(Math.abs(got.s - wanted.s) < 1e-6 && Math.abs(got.l - wanted.l) < 1e-6, `${name} lost the saturation or lightness that makes the lattice read`);
  }
  // Not vacuous: the scheme this scene shipped with is measurably multi-colour at the same point of the wheel, which is
  // exactly the 彩虹渐变 the brief retires to an option.
  applyTowerHue(model, night, 0.3, 'cycle');
  const spread = glowing().flatMap((a) => glowing().map((b) => arc(hsl(a).h, hsl(b).h)));
  assert.ok(Math.max(...spread) > 0.1, `the 彩虹 scheme is indistinguishable from the default at ${Math.max(...spread).toFixed(3)} of a turn`);
  // And the shaft stays in one colour all the way round the wheel, which is the whole point: a scheme that only holds
  // at one sampled shift is a coincidence.
  for (const shift of [0.001, 0.12, 0.37, 0.62, 0.99]) {
    applyTowerHue(model, night, shift, 'single');
    const names = glowing();
    const widest = Math.max(...names.flatMap((a) => names.map((b) => arc(hsl(a).h, hsl(b).h))));
    assert.ok(widest < 1e-6, `at ${shift} of the wheel the shaft is ${widest.toFixed(3)} of a turn across`);
  }
  // A theme that lights nothing has no show to run. The loop reaches this branch in every atmosphere, so a preset whose
  // emission baselines are all zero - daylight - must be left alone rather than crash on a crown it never named.
  const day = ATMOSPHERES.day.tower;
  assert.ok(Object.values(day.emission).every(([, intensity]) => !intensity), 'daylight is the case this guards');
  const before = new Map();
  applyTowerAtmosphere(model, day);
  model.traverse((object) => { if (object.material?.emissive) before.set(object.material.name, `${object.material.color.getHexString()}/${object.material.emissive.getHexString()}`); });
  for (const shift of [0, 0.2, 1]) assert.doesNotThrow(() => applyTowerHue(model, day, shift, 'single'), `the show must survive daylight at ${shift}`);
  model.traverse((object) => {
    const was = before.get(object.material?.name);
    if (was === undefined) return;
    assert.equal(`${object.material.color.getHexString()}/${object.material.emissive.getHexString()}`, was,
      `${object.material.name}: the tower does not light up a sunny afternoon`);
  });
  applyTowerAtmosphere(model, night);
});

test('the beam over the mast is a night-only light that is not part of the silhouette', () => {
  const beam = createTowerBeam();
  assert.equal(beam.visible, false, 'a beam that burns by day is a painting error');
  assert.ok(beam.position.y > 600, `the beam starts above the roof, at ${beam.position.y}`);
  const box = new Box3().setFromObject(createTowerModel());
  assert.ok(Math.abs(box.max.y - 600) < 0.01, 'the tower model itself still tops out at 600 m - the beam lives beside it');
  assert.ok(beam.material.blending !== 0, 'additive blending is what keeps the sky behind it a sky');
  assert.equal(beam.material.depthWrite, false, 'a transparent cone must not write depth over the city');
});

test('the three bands of light on the water lie on the measured channel, each in front of its own tower', async () => {
  const river = JSON.parse(await readFile(new URL('../public/data/canton-river.geojson', import.meta.url), 'utf8'));
  const buildings = JSON.parse(await readFile(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8'));
  // What the snapshot is: the three ways OSM draws the 珠江 through this box, and nothing else. The band positions are
  // measured out of these coordinates, so the file has to be checked for what it claims to be before they are trusted.
  assert.equal(river.features.length, 3, 'the river snapshot holds the three 珠江 ways inside the scene radius');
  for (const feature of river.features) {
    assert.equal(feature.properties.name, '珠江', `${feature.properties.osmId} is not the river the bands are measured from`);
    assert.equal(feature.properties.waterway, 'river', `${feature.properties.osmId} is not drawn as a river`);
    assert.ok(feature.geometry.coordinates.length > 1, `${feature.properties.osmId} has no line to measure a channel from`);
    assert.ok(feature.properties.nearestVertex < 3000, `${feature.properties.osmId} lies outside the scene`);
  }
  const lines = river.features.map((feature) => feature.geometry.coordinates);
  const footOf = (osmId) => {
    const feature = buildings.features.find((entry) => Number(entry.properties?.osmId) === osmId);
    const ring = outlineRing(feature);
    const open = ring.slice(0, -1);
    // The same vertex average the layer takes, so the test measures the point the bands are actually built on.
    return [open.reduce((sum, point) => sum + point[0], 0) / open.length, open.reduce((sum, point) => sum + point[1], 0) / open.length];
  };
  const easting = (point) => plane(DEFAULT_CENTER, { lng: point[0], lat: point[1] }).dx;
  const tower = channelCrossing(lines, [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat]);
  assert.ok(Math.abs(Math.hypot(tower.ux, tower.uz) - 1) < 1e-9, 'the axis has to be a direction, not a stride');
  // The reach is a measurement, so the test names the number rather than the constant it came from: at 200 m every one
  // of the 21 axis samples of all three bands lay on drawn water at all three cameras, and at 260 m two of the three
  // started putting samples on the bank. A literal is what makes changing it cost a decision.
  assert.equal(tower.length, 200, 'the band is as long as the reach measured across the channel');
  // 320 m due north of the tower's own foot, on a stretch the line runs due east - the same number the snapshot's
  // metadata records from the same geometry, which is what stops the two readings of it drifting apart.
  assert.ok(Math.abs(tower.cx) < 1, `the channel in front of the tower sits ${tower.cx} m off its own easting`);
  assert.ok(Math.abs(tower.cz + 320) < 5, `the nearest water is ${-tower.cz} m north of the tower, not 320 m`);
  assert.ok(Math.abs(river.metadata.nearest.metres - Math.hypot(tower.cx, tower.cz)) <= 2,
    'the snapshot records a nearest point the runtime no longer agrees with');
  assert.ok(Math.abs(tower.from - (Math.hypot(tower.cx, tower.cz) - SPILL_REACH_METRES / 2)) < 1,
    'the near end of the band is not half a reach in from the water');
  // The two towers on the north bank get the same stretch of water, slid along the channel to their own easting. That
  // they land on the same line as the tower's band is the claim - the alternative reading of "nearest water", each
  // shell's own perpendicular, falls in a north-channel creek the basemap barely draws as water at all.
  for (const osmId of [511404889, 184738716]) {
    const foot = footOf(osmId);
    const axis = channelCrossing(lines, foot);
    assert.ok(axis, `${osmId} has no band to draw`);
    assert.equal(axis.length, SPILL_REACH_METRES, `${osmId}: the same reach as the tower's`);
    assert.ok(Math.abs(axis.cx - easting(foot)) < 1, `${osmId}'s band is not on its own easting (${axis.cx})`);
    assert.ok(Math.abs(axis.cz + 320) < 5, `${osmId}'s band is not on the channel the tower's band lies on (${axis.cz})`);
    const stand = plane(DEFAULT_CENTER, { lng: foot[0], lat: foot[1] });
    const out = Math.hypot(axis.cx - stand.dx, axis.cz + stand.dy);
    assert.ok(out > 900 && out < 960, `${osmId} stands ${out} m from its own band, not the measured ~930`);
    assert.ok(Math.abs(axis.from - (out - SPILL_REACH_METRES / 2)) < 1, `${osmId}: the band's near end is not between it and the water`);
    // The axis points away from the tower that owns it, which is what makes the bright end the near one below.
    const toCentre = { x: axis.cx - stand.dx, z: axis.cz + stand.dy };
    assert.ok(toCentre.x * axis.ux + toCentre.z * axis.uz > 0, `${osmId}'s axis runs back toward its own tower`);
  }
  // Only the two towers on the north bank ask; the 16 m museum and the bridge deck do not.
  assert.deepEqual(Object.entries(LANDMARK_FORMS).filter(([, form]) => form.night?.spill).map(([id]) => Number(id)),
    [184738716, 511404889], 'a form that asks for a band of water, or one that stops asking, is a change to this picture');
  assert.equal(channelCrossing([], [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat]), null,
    'with no river line to measure, the band is dropped rather than throwing inside onAdd');
  const band = createGlowBand({ axis: tower });
  assert.equal(band.mesh.visible, false, 'a band of light lying on the water by day is a painting error');
  assert.equal(band.mesh.name, 'river-glow');
  const position = band.mesh.geometry.getAttribute('position');
  const uv = band.mesh.geometry.getAttribute('uv');
  const corners = [];
  for (let at = 0; at < position.count; at += 1) {
    assert.ok(Math.abs(position.getY(at) - 1.5) < 1e-6, 'the band has to lie flat on the water, not stand in it');
    corners.push([position.getX(at), position.getZ(at), uv.getY(at)]);
  }
  const centre = corners.reduce((sum, corner) => [sum[0] + corner[0] / corners.length, sum[1] + corner[1] / corners.length], [0, 0]);
  assert.ok(Math.hypot(centre[0] - tower.cx, centre[1] - tower.cz) < 1e-3,
    `the band sits at ${Math.round(centre[0])},${Math.round(centre[1])}, not on the channel at ${Math.round(tower.cx)},${Math.round(tower.cz)}`);
  assert.ok(corners.every(([, , v]) => v === 0 || v === 1), 'the band is one quad');
  const nearEnd = corners.find(([, , v]) => v === 0), farEnd = corners.find(([, , v]) => v === 1);
  assert.ok(Math.hypot(nearEnd[0], nearEnd[1]) < Math.hypot(farEnd[0], farEnd[1]),
    'the band fades toward the bank instead of away from it');
  const across = Math.hypot(corners[0][0] - corners[1][0], corners[0][1] - corners[1][1]);
  assert.ok(Math.abs(across - 90) < 1, `the band is ${across} m across, not the drawn 90`);
  const data = band.material.map.image.data;
  const steps = band.material.map.image.width;
  assert.equal(band.material.map.image.height, steps, 'the fade runs along the band and across it');
  const at = (v, u) => data[(v * steps + u) * 4 + 3];
  const middle = (steps - 1) / 2 | 0;
  const column = Array.from({ length: steps }, (_, v) => at(v, middle));
  const peakRow = column.indexOf(Math.max(...column));
  assert.ok(column[0] < 40, `the band starts at ${column[0]} of 255 on the bank side, which is a cut across the water`);
  assert.ok(column[steps - 1] < 5, 'the band has to let go before its far end');
  assert.ok(peakRow > 2 && peakRow < steps - 4, `the band peaks at row ${peakRow} of ${steps}, so its brightest row is on an edge`);
  assert.ok(column[peakRow] > 250, 'the ramp costs the band its brightness');
  for (let v = 1; v < steps; v += 1) {
    assert.ok(column[v] <= column[v - 1] || v <= peakRow, 'the band brightened away from the bank');
    assert.ok(column[v] >= column[v - 1] || v > peakRow, 'the band brightened toward the bank past its peak');
  }
  assert.ok(at(peakRow, 0) < 5 && at(peakRow, middle) > 250, 'the long edges have to feather out, not stop on a line');
  for (let u = 1; u <= middle; u += 1) assert.ok(at(peakRow, u) >= at(peakRow, u - 1), 'the band thinned toward its own middle');
  assert.equal(band.material.map.generateMipmaps, false);
  assert.equal(band.material.blending, AdditiveBlending, 'additive is what keeps the river under it a river');
});

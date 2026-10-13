import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { distanceToGeometry, normalizeBuildings, searchIndex } from '../src/buildings.js';
import { METERS_PER_DEGREE } from '../src/geo.js';
import {
  EASTASIA_SOURCE, MERGE_RULES, REJECT_REASONS, footprintArea, footprintGap, polygonsOf, vertexList,
  normalizeFootprints, mergeJingtaiBuildings, validateMergedJingtai,
} from '../src/footprints.js';

const root = new URL('../', import.meta.url);
const center = { lat: 23.17107, lng: 113.26646 };
const radius = 2000;
const kx = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
// Same fixture unit as the coverage audit: metres offset from the scene centre, so a rule's threshold is readable as-is.
const ringOf = ([west, south, east, north]) => [[west, south], [east, south], [east, north], [west, north], [west, south]]
  .map(([x, y]) => [Number((center.lng + x / kx).toFixed(7)), Number((center.lat + y / METERS_PER_DEGREE).toFixed(7))]);
const footprint = (record, box) => ({ type: 'Feature', id: `gz-${record}`, properties: { dataset_id: `${record}.00000000000`, status: '0', orig_oid: `${record}`, rings: 1 }, geometry: { type: 'Polygon', coordinates: [ringOf(box)] } });
const multiFootprint = (record, boxes) => ({ type: 'Feature', id: `gz-${record}`, properties: { dataset_id: `${record}.00000000000`, status: '1', orig_oid: `${record}`, rings: boxes.length }, geometry: { type: 'MultiPolygon', coordinates: boxes.map((box) => [ringOf(box)]) } });
const osmFeature = (id, box, name = `OSM楼牌${id}`) => ({ type: 'Feature', id, properties: { osmId: id, name, category: 'residential', height: 18, base: 0, heightSource: 'height', distance: 0, area: 600 }, geometry: { type: 'Polygon', coordinates: [ringOf(box)] } });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const reasons = (result) => Object.fromEntries(Object.entries(result.stats.rejected).filter(([, count]) => count));
const merge = (footprints, options = {}) => normalizeFootprints(collection(...footprints), { center, radius, osmFeatures: [], ...options });

const NEAR = [-40, -20, 20, 20], TINY = [-1.5, -1.5, 1.5, 1.5], FAR = [900, -20, 940, 20];

test('footprintArea uses the same plane as the OSM path', () => {
  assert.ok(Math.abs(footprintArea(footprint(1, [-50, -50, 50, 50]).geometry, center) - 10000) < 10);
  // A hole is subtracted: an 80×80 block with a 40×40 courtyard is 4 800 m², not 6 400.
  const withHole = { type: 'Polygon', coordinates: [ringOf([-40, -40, 40, 40]), ringOf([-20, -20, 20, 20])] };
  assert.ok(Math.abs(footprintArea(withHole, center) - 4800) < 10);
});

test('footprintGap measures outline to outline, and reports 0 on contact', () => {
  const a = footprint(1, NEAR), b = footprint(2, NEAR);
  assert.equal(footprintGap(a, b), 0);
  assert.ok(Math.abs(footprintGap(footprint(3, [-40, -20, 20, 20]), footprint(4, [70, -20, 130, 20])) - 50) < 1, 'a 50 m gap must read 50');
  assert.ok(Math.abs(footprintGap(footprint(5, [-140, -20, -80, 20]), footprint(6, [-70, -20, -10, 20])) - 10) < 1);
});

test('vertexList reaches every vertex of every ring', () => {
  const polygon = { type: 'Polygon', coordinates: [ringOf(NEAR), ringOf([-10, -10, 10, 10])] };
  const multi = { type: 'MultiPolygon', coordinates: [[ringOf(NEAR)], [ringOf(FAR)]] };
  assert.equal(vertexList(polygon).length, 10);
  assert.equal(vertexList(multi).length, 10);
  assert.ok(vertexList(multi).every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)), 'no ring may leak out as a "point"');
  assert.throws(() => polygonsOf({ type: 'LineString', coordinates: [] }), /Polygon or MultiPolygon/);
});

test('a sub-threshold outline is dropped and a real block survives the same pass', () => {
  const result = merge([footprint(1, TINY), footprint(2, NEAR)]);
  assert.deepEqual(reasons(result), { 'tiny-area': 1 });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.area, 2400);
  // The floor is the rule under test: lowering it must let the sliver through, or the count proves nothing.
  assert.equal(merge([footprint(1, TINY), footprint(2, NEAR)], { minAreaSquareMeters: 1 }).features.length, 2);
});

test('an outline already covered by OSM yields to OSM, 16 m away does not', () => {
  const osm = [osmFeature(101, [-45, -25, 25, 25])];
  const overlapping = merge([footprint(1, NEAR), footprint(2, FAR)], { osmFeatures: osm });
  assert.deepEqual(reasons(overlapping), { 'matches-osm': 1 });
  assert.deepEqual(overlapping.features.map((feature) => feature.properties.sourceRecord), ['gz-2']);
  // 15 m is the boundary, so 14 m has to match and 16 m must not; the third case is a footprint inside the OSM one.
  assert.equal(merge([footprint(3, [-39, -39, 21, -11])], { osmFeatures: osm }).features.length, 0, '14 m must match');
  assert.equal(merge([footprint(4, [-11, -11, 9, 9])], { osmFeatures: osm }).features.length, 0, 'inside an OSM footprint must match too');
  assert.equal(merge([footprint(5, [-41, -61, 19, -41])], { osmFeatures: osm }).features.length, 1, '16 m must stay');
});

test('two outlines on one spot keep the larger one', () => {
  const result = merge([footprint(1, [-12, -12, 12, 12]), footprint(2, [-10, -10, 10, 10])]);
  assert.deepEqual(reasons(result), { 'duplicate-footprint': 1 });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].properties.area, 576, 'the 24×24 block is the one kept');
  assert.equal(merge([footprint(1, [-12, -12, 12, 12]), footprint(2, [-10, -10, 10, 10])], { duplicateMeters: 0 }).features.length, 2, 'disabling the merge must leave both');
});

test('nothing is painted on the campus polygon', () => {
  const campus = { type: 'Polygon', coordinates: [ringOf([-200, -200, 200, 200])] };
  // One vertex inside is enough: the source has no teaching building, so no part of any outline may claim school land.
  const clipped = footprint(1, [150, -20, 250, 20]);
  assert.equal(vertexList(clipped.geometry).filter(([lng, lat]) => distanceToGeometry({ lat, lng }, campus) === 0).length, 3, 'two west vertices plus the closing repeat');
  const result = merge([clipped, footprint(2, [300, -20, 360, 20])], { campusGeometry: campus });
  assert.deepEqual(reasons(result), { 'inside-campus': 1 });
  assert.equal(result.features.length, 1);
  assert.equal(merge([clipped], { campusGeometry: null }).features.length, 1, 'the rule only runs when the caller passes a campus');
  assert.throws(() => merge([clipped], { campusGeometry: { type: 'MultiPolygon', coordinates: [] } }), /must be a Polygon/);
});

test('footprints are keyed as their own source and claim nothing it does not hold', () => {
  const result = merge([footprint(7, NEAR), multiFootprint(9, [FAR, [1000, -20, 1040, 20]])]);
  assert.equal(result.features.length, 3);
  for (const feature of result.features) {
    const p = feature.properties;
    assert.match(p.osmId, /^eastasia\/[1-9]\d*$/);
    assert.doesNotMatch(String(p.osmId), /^(?:relation\/)?\d+$/, 'an id that parses as an OSM way would fabricate a link');
    assert.match(p.sourceId, /^eastasia\/gz-[1-9]\d*(#p[1-9]\d*)?$/);
    assert.equal(p.heightSource, 'estimate');
    assert.equal(p.height, 9.6);
    assert.equal(p.category, 'unknown');
    assert.equal(feature.geometry.type, 'Polygon');
    for (const key of ['name', 'nameEn', 'street', 'house', 'type', 'place']) assert.ok(!(key in p), key);
    assert.equal(p.sourceLicense, EASTASIA_SOURCE.license);
    assert.equal(p.sourceCrs, EASTASIA_SOURCE.memberCrs);
  }
  assert.deepEqual(result.features.map((feature) => feature.properties.sourceId).sort(), ['eastasia/gz-7', 'eastasia/gz-9#p1', 'eastasia/gz-9#p2']);
});

test('the merged file keeps OSM features untouched and stays out of the name index', () => {
  const osm = collection(osmFeature(101, NEAR), osmFeature(102, [800, -20, 840, 20]));
  const footprints = merge([footprint(3, FAR), footprint(4, [-700, -20, -640, 20])]);
  const merged = mergeJingtaiBuildings(osm, footprints.features);
  assert.equal(merged.features.length, 4);
  assert.deepEqual(merged.features.slice(0, 2), osm.features);
  const index = searchIndex(merged.features.filter((feature) => feature.geometry.type === 'Polygon'), { center, radius });
  const added = new Set(footprints.features.map((feature) => String(feature.properties.osmId)));
  assert.ok(index.entries.length > 0, 'the OSM entries must still be indexed, or this assertion proves nothing');
  assert.ok(index.entries.every((entry) => !added.has(String(entry.osmId))), 'a footprint with no name must not reach the search index');
});

test('validateMergedJingtai passes on a real merge and fails on each way to break it', () => {
  const osm = collection(osmFeature(101, NEAR));
  const campus = { type: 'Polygon', coordinates: [ringOf([-1200, 800, -800, 1200])] };
  const options = { center, radius, campusGeometry: campus };
  const footprints = () => merge([footprint(3, FAR), footprint(4, [500, -20, 560, 20])], { campusGeometry: campus });
  assert.equal(validateMergedJingtai(mergeJingtaiBuildings(osm, footprints().features), osm, footprints(), options), true);
  // Every case rebuilds from scratch, so one mutation can never be the reason the next assertion throws.
  const breakAdded = (mutate) => () => {
    const local = footprints();
    const merged = mergeJingtaiBuildings(osm, local.features);
    mutate(merged.features.at(-1), merged);
    return validateMergedJingtai(merged, osm, local, options);
  };
  assert.throws(breakAdded((feature, merged) => { merged.features.pop(); }), /Merged total/);
  assert.throws(breakAdded((feature) => { feature.properties.height = 42; }), /claims a height/);
  assert.throws(breakAdded((feature) => { feature.properties.osmId = 987654; }), /must be namespaced/);
  assert.throws(breakAdded((feature) => { feature.properties.name = '妄称有名'; }), /carries naming/);
  assert.throws(breakAdded((feature) => { feature.properties.category = 'residential'; }), /claims a use/);
  assert.throws(breakAdded((feature) => { feature.geometry.coordinates = [ringOf([3000, -20, 3040, 20])]; }), /outside 2000 m/);
  assert.throws(breakAdded((feature) => { feature.geometry.coordinates = [ringOf(TINY)]; }), /below the/);
  // The campus guard must not depend on the normaliser having run it: stale properties would hide an intrusion otherwise.
  const stray = merge([footprint(5, [-1100, 900, -900, 1100])]);
  assert.throws(() => validateMergedJingtai(mergeJingtaiBuildings(osm, stray.features), osm, stray, options), /inside campus/);
  assert.throws(() => {
    const local = footprints();
    const merged = mergeJingtaiBuildings(osm, local.features);
    merged.features[0] = { ...merged.features[0], properties: { ...merged.features[0].properties, height: 99 } };
    return validateMergedJingtai(merged, osm, local, options);
  }, /OSM features changed/);
});

test('duplicate detection is not a no-op: two identical outlines fail the merged check', () => {
  const osm = collection(osmFeature(101, NEAR));
  const footprints = merge([footprint(3, FAR), footprint(4, [500, -20, 560, 20])]);
  const merged = mergeJingtaiBuildings(osm, footprints.features);
  const clone = structuredClone(merged.features.at(-1));
  clone.properties.osmId = 'eastasia/999';
  clone.properties.sourceId = 'eastasia/gz-999';
  merged.features.push(clone);
  assert.throws(() => validateMergedJingtai(merged, osm, { features: [...footprints.features, clone] }, { center, radius }), /Duplicate footprints kept/);
});

test('the shipped footprint slice input is the one the audit measured', () => {
  const path = new URL('data/jingtai-eastasia-footprints.geojson', root);
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(digest, 'fb478410cfbc3cec9bf284859db3a2830fafd19dba768801e9bf848782fb9cb3');
  assert.equal(EASTASIA_SOURCE.archiveMd5, 'd356f487b19eaa13c6e12eb42ac3ca53');
  assert.equal(EASTASIA_SOURCE.memberCrs, 'EPSG:32649');
  assert.deepEqual(REJECT_REASONS, Object.keys(merge([]).stats.rejected));
});

test('the promoted merge reproduces from local inputs', (t) => {
  const candidateUrl = new URL('candidates/jingtai-p1-merge/jingtai-buildings.geojson', root);
  if (!existsSync(candidateUrl)) return t.skip('run node scripts/merge-jingtai-footprints.mjs first');
  const served = JSON.parse(readFileSync(new URL('public/data/jingtai-buildings.geojson', root), 'utf8'));
  const grounds = JSON.parse(readFileSync(new URL('public/data/jingtai-grounds.geojson', root), 'utf8'));
  const slice = JSON.parse(readFileSync(new URL('data/jingtai-eastasia-footprints.geojson', root), 'utf8'));
  // Feeding the promoted file back in would make every outline "match OSM" and reproduce it unchanged, so the merge has
  // to be rebuilt from the ODbL layer alone — the same bytes that shipped before promotion.
  const osm = { type: served.type, features: served.features.filter((feature) => !feature.properties.footprintSource) };
  assert.equal(served.features.length - osm.features.length, 4780, 'stripping the added layer must actually remove something');
  assert.equal(createHash('sha256').update(`${JSON.stringify(osm)}\n`).digest('hex'), 'a7936a9265a72d36ae37bba89333108f697043c2863d8fa83eb40d413a249075');
  const campusGeometry = grounds.features.find((feature) => feature.properties.campus).geometry;
  const result = normalizeFootprints(slice, { center, radius, campusGeometry, osmFeatures: osm.features, ...MERGE_RULES });
  const merged = mergeJingtaiBuildings(osm, result.features);
  assert.deepEqual(JSON.parse(readFileSync(candidateUrl, 'utf8')), merged, 'candidate file is stale for these inputs');
  assert.deepEqual(served, merged, 'the promoted product must equal the reviewed candidate, feature for feature');
  assert.equal(validateMergedJingtai(merged, osm, result, { center, radius, campusGeometry }), true);
  const inBand = (limit) => merged.features.filter((feature) => distanceToGeometry(center, feature.geometry) <= limit).length;
  assert.equal(inBand(100), 48);
  assert.equal(inBand(500), 772);
  assert.ok(inBand(2000) > 5000);
  assert.deepEqual(result.stats.rejected['invalid-geometry'], 0);
  assert.equal(result.stats.rejected['inside-campus'], 8);
});

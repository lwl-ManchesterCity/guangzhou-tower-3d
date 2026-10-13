import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METERS_PER_DEGREE } from '../src/geo.js';
import { distanceToGeometry, normalizeBuildings } from '../src/buildings.js';
import { auditArtifact, assessAgainstReference, formatCoverageReport, COVERAGE_BANDS, NEAR_FIELD_METERS, GAP_CAUSES } from '../src/coverage-audit.js';

const center = { lat: 23.17107, lng: 113.26646 };
const radius = 2000;
const kx = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
// Boxes are [west, south, east, north] offsets in metres from the scene centre: the unit the radius rule is written in.
const ringOf = ([west, south, east, north]) => [[west, south], [east, south], [east, north], [west, north], [west, south]].map(([x, y]) => [center.lng + x / kx, center.lat + y / METERS_PER_DEGREE]);
const polygon = (...boxes) => ({ type: 'Polygon', coordinates: boxes.map(ringOf) });
const openRing = (box) => ringOf(box).slice(0, -1);
const building = (id, box, tags = { building: 'residential' }) => ({ type: 'way', id, tags, geometry: ringOf(box).map(([lon, lat]) => ({ lon, lat })) });
const feature = (id, box, properties = {}) => ({ type: 'Feature', id, properties: { osmId: id, heightSource: 'estimate', ...properties }, geometry: polygon(box) });
const artifact = (features) => ({ type: 'FeatureCollection', features });

const NEAR = [-120, -60, 60, 60], CROSSING = [1990, -300, 2001, 300], MID = [420, -40, 470, 40], LEVELS = [1500, -40, 1560, 40], EDGE = [2400, -40, 2460, 40], AWAY = [-4000, -40, -3940, 40];
const raw = { elements: [
  building(1, NEAR, { building: 'residential', name: '近处住宅' }),
  building(2, CROSSING),
  building(3, MID),
  building(4, LEVELS, { building: 'apartments', 'building:levels': '-1' }),
  building(5, EDGE),
  building(6, AWAY),
] };
const full = artifact([feature(1, NEAR), feature(2, CROSSING), feature(3, MID)]);
const audit = (source, file = full, options = {}) => auditArtifact(source, file, { center, radius, bands: COVERAGE_BANDS, nearField: NEAR_FIELD_METERS, ...options });

test('radius rule measures the nearest edge, not the nearest corner, and reads interiors and holes as inside', () => {
  assert.equal(distanceToGeometry(center, polygon(NEAR)), 0);
  assert.ok(Math.abs(distanceToGeometry(center, polygon([-300, -300, 300, 300], [-100, -100, 100, 100])) - 100) < 0.5, 'a centre inside a hole is measured against the hole edge');
  assert.ok(Math.abs(distanceToGeometry(center, polygon([300, -40, 360, 40])) - 300) < 0.5);
  const crossing = polygon(CROSSING);
  assert.ok(Math.abs(distanceToGeometry(center, crossing) - 1990) < 1);
  const corners = crossing.coordinates[0].flatMap(([lng, lat]) => [Math.hypot((lng - center.lng) * kx, (lat - center.lat) * METERS_PER_DEGREE)]);
  assert.ok(Math.min(...corners) > radius, 'every corner is outside the circle, so the old vertex rule dropped this block');
  const multi = { type: 'MultiPolygon', coordinates: [polygon([900, -40, 960, 40]).coordinates, polygon([-400, -40, -340, 40]).coordinates] };
  assert.ok(Math.abs(distanceToGeometry(center, multi) - 340) < 1);
  const unclosed = { type: 'Polygon', coordinates: [openRing([700, -40, 760, 40])] };
  assert.throws(() => distanceToGeometry(center, unclosed), /closed rings/);
  assert.throws(() => distanceToGeometry(center, { type: 'Point', coordinates: [center.lng, center.lat] }), /Polygon or MultiPolygon/);
});

test('normalizeBuildings keeps a block that only crosses the circle and still drops one outside it', () => {
  const kept = normalizeBuildings([raw.elements[1]], { center, radius, towerId: null });
  assert.deepEqual(kept.features.map((f) => f.id), [2]);
  assert.equal(kept.features[0].properties.distance, 1990);
  assert.equal(normalizeBuildings([raw.elements[5]], { center, radius, towerId: null }).features.length, 0);
});

test('audit classifies every non-drawn source element and labels the four gap stages', () => {
  const result = audit(raw);
  assert.equal(result.nearField.artifactTotal, 3);
  assert.equal(result.nearField.sourceElements, 2);
  assert.deepEqual(result.lostInConversion, []);
  assert.equal(result.bands.at(-1).sourceElements, 4);
  assert.equal(result.bands.at(-1).artifactFeatures, 3);
  assert.deepEqual(Object.keys(result.exclusions), ['negative-levels']);
  assert.equal(result.exclusions['negative-levels'][0].id, 'way/4');
  assert.ok(!result.exclusions.radius, 'blocks beyond the scene radius are not reported as coverage gaps');
  assert.ok(!Object.values(result.exclusions).flat().some((item) => ['way/5', 'way/6'].includes(item.id)));
  assert.deepEqual(result.boundaryRescued.map((item) => item.id), ['way/2']);
  assert.equal(result.renderStage, null);
  assert.equal(result.inArtifactNotRendered, null);
  assert.equal(result.nearField.weak.length, 2);
  assert.ok(GAP_CAUSES.includes(result.nearField.weak[0].stage));
});

test('render evidence separates "in artifact but not drawn" from "the camera never looked there"', () => {
  const result = audit(raw, full, { render: { osmIds: ['way/1', 'way/2'], camera: { zoom: 16.7 }, capturedAt: 'probe' } });
  assert.deepEqual(result.inArtifactNotRendered.map((item) => item.id), ['way/3']);
  assert.deepEqual(result.nearField.weak.map((item) => item.id), ['way/1', 'way/3']);
  assert.equal(result.bands[0].rendered, 1);
  assert.equal(result.renderStage.capturedAt, 'probe');
});

test('coverage needs an independent checklist, and OSM alone never yields a coverage rate', () => {
  const unassessed = assessAgainstReference(null, full, { center });
  assert.equal(unassessed.assessed, false);
  assert.match(unassessed.reason, /覆盖率尚不能评估/);
  assert.match(unassessed.reason, /不能自证完整/);
  const checked = assessAgainstReference({ name: '示例清单', license: 'CC-BY-4.0', items: [
    { label: '已收录楼栋', lat: center.lat, lng: center.lng + 10 / kx },
    { label: '清单有、快照无', lat: center.lat + 800 / METERS_PER_DEGREE, lng: center.lng },
  ] }, full, { center });
  assert.equal(checked.assessed, true);
  assert.deepEqual(checked.items.map((item) => [item.label, item.matched]), [['已收录楼栋', true], ['清单有、快照无', false]]);
  assert.equal(checked.unmatched[0].stage, 'not-in-source');
});

test('report text is derived from the audit, and the real snapshot shows no conversion loss', () => {
  const text = formatCoverageReport({ raw, source: { sha256: 'abc' }, artifacts: { 正式: { audit: audit(raw), note: '第二来源说明段落' } }, reference: assessAgainstReference(null, full, { center }) });
  assert.match(text, /## 正式/);
  assert.match(text, /第二来源说明段落/, 'an artifact with a second source must say so above the band table');
  assert.match(text, /\| 100 \|/);
  assert.match(text, /negative-levels/);
  assert.match(text, /覆盖率尚不能评估/);
  const real = JSON.parse(readFileSync(new URL('../data/jingtai-overpass.json', import.meta.url), 'utf8'));
  const live = JSON.parse(readFileSync(new URL('../public/data/jingtai-buildings.geojson', import.meta.url), 'utf8'));
  const osmLayer = { type: live.type, features: live.features.filter((feature) => !feature.properties.footprintSource) };
  // Two artifacts, two probes: the P0 evidence was captured while only the ODbL layer existed, so it can only judge that layer.
  const promoted = JSON.parse(readFileSync(new URL('../docs/audits/jingtai-render-p1-live.json', import.meta.url), 'utf8'));
  const p0 = JSON.parse(readFileSync(new URL('../docs/audits/jingtai-render.json', import.meta.url), 'utf8'));
  const result = audit(real, live, { render: { ...promoted.cameras.near, capturedAt: promoted.capturedAt } });
  assert.equal(result.bands[0].sourceElements, 0, 'the 100 m band is empty in the OSM source itself');
  assert.equal(result.bands[0].artifactFeatures, 48, 'the imagery outlines are what fills the 100 m band');
  assert.equal(result.nearField.sourceElements, 157);
  assert.equal(result.nearField.artifactFeatures, 772);
  assert.deepEqual(result.lostInConversion, []);
  assert.deepEqual(result.inArtifactNotRendered, []);
  assert.equal(result.bands.at(-1).artifactFeatures, 5686);
  assert.equal(result.bands.at(-1).sourceElements, 908, 'the source column stays an OSM-only count');
  assert.equal(result.nearField.weak.length, result.nearField.artifactFeatures);
  assert.equal(result.boundaryRescued.length, 0);
  const osmOnly = audit(real, osmLayer, { render: { ...p0.cameras.near, capturedAt: p0.capturedAt } });
  assert.equal(osmOnly.bands.at(-1).artifactFeatures, 906);
  assert.deepEqual(osmOnly.inArtifactNotRendered, [], 'the ODbL layer must still render exactly as the P0 probe recorded');
});

test('deleting a verified building, a wrong radius cut and piling up far blocks each break a different check', () => {
  const verified = audit(raw);
  assert.deepEqual(verified.nearField.gaps, []);
  assert.deepEqual(verified.inArtifactNotRendered ?? [], []);

  const deleted = artifact(full.features.filter((f) => f.properties.osmId !== 1));
  assert.throws(() => assert.deepEqual(audit(raw, deleted).nearField.gaps.map((gap) => gap.id), []), /way\/1/);
  assert.equal(audit(raw, deleted).exclusions['conversion-gap'][0].detail, '几何有效且单独通过生成规则，却不在产物中');
  assert.throws(() => assert.equal(audit(raw, deleted).bands[0].artifactFeatures, 1, 'the 100 m band must keep its verified building'), /100 m band/);

  const noRadiusCut = (source, file, options = {}) => assert.equal(audit(source, file, options).bands[3].radiusExcluded, 0, 'no in-scene building may be cut by the radius');
  noRadiusCut(raw, full);
  assert.throws(() => noRadiusCut({ elements: [raw.elements[2]] }, artifact([]), { radius: 300 }), /radiusExcluded|no in-scene/);

  const extra = [building(9, [1600, -40, 1660, 40]), building(10, [1700, -40, 1760, 40])];
  const farOnly = artifact([feature(2, CROSSING), feature(5, EDGE), feature(9, [1600, -40, 1660, 40]), feature(10, [1700, -40, 1760, 40])]);
  const crowded = audit({ elements: [...raw.elements, ...extra] }, farOnly);
  assert.ok(crowded.bands.at(-1).artifactFeatures > crowded.bands[2].artifactFeatures, 'the 2 km count grew while the near field emptied');
  assert.throws(() => assert.equal(crowded.nearField.sourceElements, crowded.nearField.artifactFeatures, 'near-field source elements must all reach the artifact'), /near-field source elements/);
});

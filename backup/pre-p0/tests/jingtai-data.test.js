import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SCENES } from '../src/scenes.js';
import { distanceMeters } from '../src/geo.js';
import { buildWalkingGraph, footAccess, footDirections, shortestWalk } from '../src/walking.js';
import { geometryFromElement, geometryPoint, pointInGeometry, prepareJingtai, REQUIRED_STATIONS, validateJingtai, walkingForStations } from '../src/jingtai-data.js';

const root = new URL('../', import.meta.url);
const rawText = readFileSync(new URL('data/jingtai-overpass.json', root), 'utf8');
const raw = JSON.parse(rawText);
const source = JSON.parse(readFileSync(new URL('data/jingtai-source.json', root), 'utf8'));
const filenames = ['jingtai-buildings.geojson', 'jingtai-buildings-index.json', 'jingtai-grounds.geojson', 'jingtai-pois.json', 'jingtai-metadata.json'];
const files = Object.fromEntries(filenames.map((name) => [name, JSON.parse(readFileSync(new URL(`public/data/${name}`, root), 'utf8'))]));
const way = (id, nodes, coordinates, tags = {}) => ({ type: 'way', id, nodes, geometry: coordinates.map(([lon, lat]) => ({ lat, lon })), tags: { highway: 'footway', ...tags } });
const node = (id, lon, lat, tags = {}) => ({ type: 'node', id, lon, lat, tags });
const geom = (coordinates) => coordinates.map(([lon, lat]) => ({ lon, lat }));

// These tests do not issue HTTP requests or mutate the saved raw snapshot.
test('raw snapshot preserves geometry, way node IDs, exact campus and 2km query provenance', () => {
  assert.equal(source.sha256, createHash('sha256').update(rawText).digest('hex'));
  assert.match(source.endpoint, /^https:\/\/maps\.mail\.ru\//);
  assert.match(source.query, /around:2000,23\.17107,113\.26646/);
  assert.match(source.query, /around:2500,23\.17107,113\.26646/);
  assert.match(source.query, /out body geom;/);
  assert.equal(raw.remark, undefined);
  assert.equal(raw.elements.length, 23492);
  const campus = raw.elements.find((e) => e.type === 'way' && e.id === 1178149399);
  assert.equal(campus.tags.name, '景泰小学');
  assert.equal(campus.tags.amenity, 'school');
  assert.equal(campus.nodes.length, campus.geometry.length);
  assert.ok(pointInGeometry(geometryFromElement(campus), 113.26646, 23.17107));
  assert.ok(!pointInGeometry(geometryFromElement(campus), 113.27002, 23.16768));
  assert.equal(SCENES.jingtai.radius, 2000);
  for (const e of raw.elements.filter((e) => e.type === 'way' && e.tags?.highway)) assert.equal(e.geometry.length, e.nodes.length, `road geometry/nodes ${e.id}`);
});

test('all five generated artifacts reproduce byte-for-byte using only local input', () => {
  const regenerated = prepareJingtai(raw, source);
  for (const [name, value] of Object.entries(regenerated.files)) {
    assert.equal(`${JSON.stringify(value)}\n`, readFileSync(new URL(`public/data/${name}`, root), 'utf8'), name);
  }
  assert.equal(validateJingtai(raw, files), true);
});

test('2km building height provenance is preserved without counting campus as a building', () => {
  const buildings = files['jingtai-buildings.geojson'].features;
  assert.equal(buildings.length, 906);
  assert.ok(!buildings.some((f) => f.properties.osmId === 1178149399));
  const counts = buildings.reduce((result, f) => { result[f.properties.heightSource] = (result[f.properties.heightSource] ?? 0) + 1; return result; }, {});
  assert.deepEqual(counts, { estimate: 897, levels: 5, height: 4 });
  assert.ok(buildings.filter((f) => f.properties.heightSource === 'estimate').every((f) => f.properties.height === 9.6));
  assert.ok(buildings.some((f) => f.properties.distance > 1000));
  const entry = files['jingtai-buildings-index.json'].entries.find((e) => e.campus);
  assert.equal(entry.osmId, 1178149399);
  assert.equal(entry.height, 0);
  assert.equal(entry.heightSource, 'estimate');
  assert.equal(entry.street, '云龙路');
  assert.equal(entry.house, '38');
});

test('POIs prioritize schools, parks and stations; include real pitches, parks and all three required stations', () => {
  const { pois, total } = files['jingtai-pois.json'];
  assert.equal(total, 115);
  assert.equal(pois.length, total);
  assert.equal(pois[0].id, 'way/1178149399');
  const priorities = { school: 0, park: 1, transit: 2, food: 3, shop: 4 };
  assert.ok(pois.every((p, i) => i === 0 || priorities[p.category] >= priorities[pois[i - 1].category]));
  assert.equal(pois.filter((p) => p.category === 'transit').length, 8);
  assert.equal(pois.filter((p) => p.leisure === 'pitch').length, 23);
  for (const p of pois) {
    for (const key of ['id', 'lat', 'lng', 'distance', 'name', 'category', 'label', 'address', 'openingHours', 'osmUrl']) assert.ok(key in p, `${p.id} ${key}`);
    assert.ok(!['visit', 'bus_stop', 'subway_entrance'].includes(p.category));
  }
  for (const station of REQUIRED_STATIONS) {
    const matching = pois.filter((p) => p.name === `${station.name}站` && p.category === 'transit');
    assert.equal(matching.length, 1);
    assert.equal(matching[0].lat, station.lat);
    assert.equal(matching[0].lng, station.lng);
    assert.ok(distanceMeters(station, matching[0].osmCoordinate) < 10);
  }
  for (const name of ['三泰公园东苑', '三泰公园西苑']) assert.ok(pois.some((p) => p.name === name));
});

test('grounds preserve polygon and multipolygon mountains; missing campus sports are explicit, not invented', () => {
  const grounds = files['jingtai-grounds.geojson'].features;
  assert.equal(grounds.filter((f) => f.properties.kind === 'pitch').length, 19);
  assert.equal(grounds.filter((f) => f.properties.kind === 'track').length, 1);
  assert.equal(grounds.filter((f) => f.properties.kind === 'campus').length, 1);
  assert.deepEqual(grounds.filter((f) => f.properties.target).map((f) => f.properties.kind), ['campus']);
  assert.deepEqual(files['jingtai-metadata.json'].report.targetSports, []);
  assert.match(files['jingtai-metadata.json'].report.campusSportsNote, /无 pitch\/track/);
  assert.equal(grounds.find((f) => f.properties.sourceId === 'relation/8249243').geometry.type, 'Polygon');
  assert.equal(grounds.find((f) => f.properties.sourceId === 'relation/10076268').geometry.type, 'MultiPolygon');
  for (const anchor of files['jingtai-metadata.json'].report.tourAnchors) {
    const feature = grounds.find((f) => f.properties.sourceId === anchor.sourceId);
    if (anchor.kind === 'park') assert.ok(pointInGeometry(feature.geometry, anchor.lng, anchor.lat));
    else {
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      assert.ok(polygons.some((rings) => rings[0].some(([lng, lat]) => lng === anchor.lng && lat === anchor.lat)));
    }
  }
});

test('real routing limitations include campus/entrance evidence and never substitute multiplied straight-line distance', () => {
  const metadata = files['jingtai-metadata.json'].walking;
  assert.ok(metadata.nodeCount > 5000);
  assert.ok(metadata.directedEdgeCount > metadata.nodeCount);
  assert.equal(metadata.radiusMeters, 2500);
  assert.deepEqual(metadata.origins, []);
  assert.ok(metadata.originCandidates.every((candidate) => !candidate.onGraph));
  assert.ok(metadata.nearbyRoadNodesNotUsed.length > 0);
  for (const station of REQUIRED_STATIONS) {
    const poi = files['jingtai-pois.json'].pois.find((p) => p.name === `${station.name}站`);
    assert.match(poi.walkingUnavailable, /校门\/校园边界/);
    assert.equal(poi.walkingDistance, undefined);
    assert.equal(poi.walkingRoute, undefined);
    assert.ok(poi.walking.entrances.length >= 2);
    assert.equal(poi.walking.originReference, 'way/1178149399');
    assert.equal(poi.walking.endpointAccessDistances.origin, null);
    assert.ok(poi.walking.entrances.every((entry) => entry.id.startsWith('node/') && entry.source.includes('explicit station-name')));
  }
});

test('Dijkstra sums mapped edges, not endpoint chord, and respects disconnected node IDs', () => {
  const elements = [way(1, [1, 2, 3, 4], [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]]), way(2, [5, 6], [[0.001, 0], [0.002, 0]])];
  const graph = buildWalkingGraph(elements);
  const route = shortestWalk(graph, 1, [4]);
  const chord = distanceMeters(graph.nodes.get(1), graph.nodes.get(4));
  assert.ok(route.distance > chord * 2.9);
  assert.deepEqual(route.nodeIds, [1, 2, 3, 4]);
  assert.deepEqual(route.wayIds, [1, 1, 1]);
  assert.equal(shortestWalk(graph, 1, [6]), null, 'coincident coordinates with different OSM IDs must not connect');
  assert.equal(shortestWalk(graph, 999, [4]), null);
  const disconnected = buildWalkingGraph([elements[0], way(3, [4, 6], [[0.001, 0], [0.002, 0]], { access: 'private' })]);
  assert.equal(shortestWalk(disconnected, 1, [6]), null);
});

test('foot/no, private roads, gates, restricted/conditional access and highway defaults are excluded', () => {
  for (const tags of [{ highway: 'footway', foot: 'no' }, { highway: 'service', access: 'private' }, { highway: 'residential', access: 'no' }, { highway: 'footway', foot: 'private' }, { highway: 'footway', foot: 'customers' }, { highway: 'motorway' }, { highway: 'trunk' }, { highway: 'construction', foot: 'yes' }, { highway: 'pedestrian', area: 'yes' }, { highway: 'footway', 'foot:conditional': 'no @ (Mo-Fr)' }]) assert.equal(footAccess(tags), false, JSON.stringify(tags));
  assert.equal(footAccess({ highway: 'service', access: 'no', foot: 'yes' }), true, 'explicit pedestrian permission overrides general access');
  const graph = buildWalkingGraph([way(1, [1, 2, 3], [[0, 0], [0, 0.001], [0, 0.002]]), node(2, 0, 0.001, { barrier: 'gate', access: 'private' })]);
  assert.equal(shortestWalk(graph, 1, [3]), null);
  const privateRoad = buildWalkingGraph([way(1, [1, 2], [[0, 0], [0, 0.001]], { foot: 'no' })]);
  assert.equal(privateRoad.exclusions.length, 1);
  assert.equal(privateRoad.nodes.size, 0);
});

test('oneway:foot controls pedestrians, vehicle oneway and roundabouts do not', () => {
  assert.deepEqual(footDirections({ oneway: 'yes', junction: 'roundabout' }), { forward: true, backward: true });
  assert.deepEqual(footDirections({ 'oneway:foot': '-1' }), { forward: false, backward: true });
  assert.deepEqual(footDirections({ 'oneway:foot': 'yes' }), { forward: true, backward: false });
  assert.deepEqual(footDirections({ oneway: 'yes', 'oneway:foot': 'no' }), { forward: true, backward: true });
  assert.deepEqual(footDirections({ 'foot:backward': 'no' }), { forward: true, backward: false });
  const graph = buildWalkingGraph([way(1, [1, 2], [[0, 0], [0, 0.001]], { 'oneway:foot': '-1' })]);
  assert.equal(shortestWalk(graph, 1, [2]), null);
  assert.ok(shortestWalk(graph, 2, [1]));
});

test('station routing chooses reachable actual entry, stores node/way and zero-connector evidence', () => {
  const campus = { type: 'way', id: 1178149399, nodes: [1, 9, 10, 11, 1], geometry: geom([[0, 0], [-0.001, 0], [-0.001, -0.001], [0, -0.001], [0, 0]]), tags: { amenity: 'school' } };
  const network = [campus, way(100, [1, 2, 3, 4], [[0, 0], [0, 0.001], [0.001, 0.001], [0.001, 0]]), node(1, 0, 0, { barrier: 'gate', foot: 'yes' }), node(4, 0.001, 0, { railway: 'subway_entrance', name: '测试站A出口' }), node(7, 0.0001, 0, { railway: 'subway_entrance', name: '测试站B出口' })];
  const pois = [{ category: 'transit', name: '测试站', distance: 111 }];
  walkingForStations(network, campus, pois);
  assert.ok(pois[0].walkingDistance > 300);
  assert.equal(pois[0].walkingUnavailable, undefined);
  assert.equal(pois[0].walkingRoute.type, 'LineString');
  assert.equal(pois[0].walking.entrance.nodeId, 4);
  assert.equal(pois[0].walking.origin.nodeId, 1);
  assert.deepEqual(pois[0].walking.endpointAccessDistances, { origin: 0, entrance: 0 });
  assert.deepEqual(pois[0].walking.nodeIds, [1, 2, 3, 4]);
  const blocked = structuredClone(network);
  blocked.find((e) => e.id === 100).tags.access = 'private';
  const unavailable = [{ category: 'transit', name: '测试站', distance: 111 }];
  walkingForStations(blocked, campus, unavailable);
  assert.ok(unavailable[0].walkingUnavailable);
  assert.equal(unavailable[0].walkingDistance, undefined);
});

test('multipolygon joins exact endpoints, assigns holes and separates islands; refuses open/ambiguous data', () => {
  const relation = { type: 'relation', id: 1, tags: { type: 'multipolygon' }, members: [
    { type: 'way', ref: 1, role: 'outer', geometry: geom([[0, 0], [4, 0], [4, 4]]) },
    { type: 'way', ref: 2, role: 'outer', geometry: geom([[0, 0], [0, 4], [4, 4]]) },
    { type: 'way', ref: 3, role: 'inner', geometry: geom([[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]) },
    { type: 'way', ref: 4, role: 'outer', geometry: geom([[5, 0], [6, 0], [6, 1], [5, 1], [5, 0]]) },
  ] };
  const geometry = geometryFromElement(relation);
  assert.equal(geometry.type, 'MultiPolygon');
  assert.equal(geometry.coordinates.length, 2);
  assert.equal(geometry.coordinates[0].length, 2);
  assert.ok(pointInGeometry(geometry, 0.5, 0.5));
  assert.ok(!pointInGeometry(geometry, 2, 2));
  assert.ok(pointInGeometry(geometry, 5.5, 0.5));
  assert.ok(pointInGeometry(geometry, ...geometryPoint(geometry)));
  const open = structuredClone(relation); open.members.splice(1, 1);
  assert.throws(() => geometryFromElement(open), /unclosed/);
  const ambiguous = structuredClone(relation); ambiguous.members.push(structuredClone(ambiguous.members[1]));
  assert.throws(() => geometryFromElement(ambiguous), /ambiguous/);
  const outsideHole = structuredClone(relation); outsideHole.members[2].geometry = geom([[8, 8], [9, 8], [9, 9], [8, 9], [8, 8]]);
  assert.throws(() => geometryFromElement(outsideHole), /hole outside/);
});

test('in-memory corruptions trigger assertions: campus identity, coordinates, height, pitch target, transit, missing reason', () => {
  const corruptions = [
    [f => { f['jingtai-grounds.geojson'].features.find((e) => e.properties.campus).properties.osmId = 712654234; }, /campus identity/],
    [f => { f['jingtai-grounds.geojson'].features.find((e) => e.properties.kind === 'pitch').properties.target = true; }, /sports target/],
    [f => { f['jingtai-buildings.geojson'].features[0].properties.height = 27; }, /Invented height/],
    [f => { f['jingtai-pois.json'].pois.find((p) => p.name === '飞翔公园站').lat += 0.001; }, /required station/],
    [f => { delete f['jingtai-pois.json'].pois.find((p) => p.name === '飞翔公园站').walkingUnavailable; }, /walking limitation/],
    [f => { const p = f['jingtai-pois.json'].pois.find((p) => p.name === '飞翔公园站'); p.walkingDistance = Math.round(p.distance * 1.3); }, /lacks verified campus/],
    [f => { f['jingtai-pois.json'].pois.find((p) => p.name === '飞翔公园站').walking.entrances[0].nodeId = 123; }, /evidence differs/],
    [f => { f['jingtai-buildings-index.json'].entries.find((e) => e.campus).lng = 113.27002; }, /outside footprint/],
    [f => { const ring = f['jingtai-grounds.geojson'].features.find((e) => e.properties.kind === 'pitch').geometry.coordinates[0]; ring[1][0] += 0.00001; }, /geometry differs/],
  ];
  for (const [mutate, expected] of corruptions) {
    const bad = structuredClone(files); mutate(bad);
    assert.throws(() => validateJingtai(raw, bad), expected);
  }
  const wrongRaw = structuredClone(raw);
  wrongRaw.elements.find((e) => e.type === 'way' && e.id === 1178149399).id = 712654234;
  assert.throws(() => prepareJingtai(wrongRaw, source), /campus way missing/);
});

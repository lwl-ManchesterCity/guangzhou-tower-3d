import test from 'node:test';
import assert from 'node:assert/strict';
import { buildingId, geometryPoint, neighborhoodStyle } from '../src/map/helpers.js';
import { insideRing } from '../src/buildings.js';
import { ATMOSPHERES } from '../src/atmosphere.js';

test('a plain way id stays a number and a namespaced one stays text, so the card seat can compare it with String()', () => {
  assert.equal(buildingId('12345'), 12345);
  assert.equal(buildingId(12345), 12345);
  assert.equal(buildingId('relation/9'), 'relation/9');
  assert.equal(buildingId(undefined), undefined);
  assert.equal(buildingId(null), null);
});

test('a building point lands inside the outline', () => {
  const square = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const [lng, lat] = geometryPoint(square);
  assert.ok(insideRing(square.coordinates[0], lng, lat));
});

test('a courtyard block gets a point on its meat, not in the hole the centroid falls into', () => {
  const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
  const [lng, lat] = geometryPoint({ type: 'Polygon', coordinates: [outer, hole] });
  assert.ok(insideRing(outer, lng, lat), 'point must sit inside the outer ring');
  assert.ok(!insideRing(hole, lng, lat), 'point must not sit in the courtyard');
});

test('an outline whose hole eats all of it says so instead of handing back a point off the meat', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  assert.throws(() => geometryPoint({ type: 'Polygon', coordinates: [ring, ring] }), /no interior building point/);
});

test('the basemap loses its extrusions, poi/housenumber labels, shields and the three subsurface line families, but keeps the river name', () => {
  const style = { layers: [
    { id: 'buildings-3d', type: 'fill-extrusion', paint: {} },
    { id: 'poi-z', type: 'symbol', 'source-layer': 'poi', layout: { 'text-field': ['get', 'name'] } },
    { id: 'housenum', type: 'symbol', 'source-layer': 'housenumber', layout: { 'text-field': ['get', 'name'] } },
    { id: 'road-shield', type: 'symbol', layout: { 'text-field': ['get', 'ref'] } },
    { id: 'tunnel_transit_rail_hatching', type: 'line', paint: {} },
    { id: 'boundary_3', type: 'line', paint: {} },
    { id: 'waterway_river', type: 'line', paint: {} },
    { id: 'waterway_line_label', type: 'symbol', 'source-layer': 'waterway', layout: { 'text-field': ['get', 'name'] } },
  ] };
  const ids = neighborhoodStyle(style).layers.map((layer) => layer.id);
  assert.deepEqual(ids, ['waterway_line_label']);
  assert.deepEqual(style.projection, { type: 'mercator' });
});

test('building footprints lose their zoom cap and old paint, and take the day theme footprint colour', () => {
  const style = { layers: [{ id: 'building', type: 'fill', 'source-layer': 'building', maxzoom: 14, paint: { 'fill-color': '#old' } }] };
  const [layer] = neighborhoodStyle(style).layers;
  assert.ok(!('maxzoom' in layer));
  assert.equal(layer.paint['fill-color'], ATMOSPHERES.day.footprint);
  assert.equal(layer.paint['fill-opacity'], 0.5);
});

test('labels read Chinese first, and street/place names wait for a zoom where they resolve', () => {
  const style = { layers: [
    { id: 'road-name', type: 'symbol', 'source-layer': 'transportation_name', minzoom: 12, layout: { 'text-field': ['get', 'name'] } },
    { id: 'place', type: 'symbol', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'] } },
  ] };
  const [road, place] = neighborhoodStyle(style).layers;
  assert.deepEqual(road.layout['text-field'], ['coalesce', ['get', 'name:zh'], ['get', 'name:en'], ['get', 'name']]);
  assert.equal(road.minzoom, 16.5);
  assert.equal(place.minzoom, 16);
});
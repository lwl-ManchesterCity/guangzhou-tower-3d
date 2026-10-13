import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METERS_PER_DEGREE } from '../src/geo.js';
import { BRIDGE_DECK, BRIDGE_PARAPET, BRIDGE_SOURCE, bridgeLayers } from '../src/bridges.js';
import { ATMOSPHERES } from '../src/atmosphere.js';

const snapshot = JSON.parse(readFileSync(new URL('../public/data/canton-bridges.geojson', import.meta.url), 'utf8'));
const CENTER = { lat: 23.109, lng: 113.31913 };
const eastScale = METERS_PER_DEGREE * Math.cos((CENTER.lat * Math.PI) / 180);
const local = ([lng, lat]) => [(lng - CENTER.lng) * eastScale, (lat - CENTER.lat) * METERS_PER_DEGREE];
const rings = (geometry) => geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
const centre = (ring) => {
  const points = ring.map(local);
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
};
const perimeterLength = (ring) => {
  const points = ring.map(local);
  return points.reduce((sum, point, index) => index ? sum + Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) : 0, 0);
};
const area = (ring) => {
  const points = ring.map(local);
  let sum = 0;
  for (let index = 0; index < points.length - 1; index++) sum += points[index][0] * points[index + 1][1] - points[index + 1][0] * points[index][1];
  return Math.abs(sum) / 2;
};

const decks = snapshot.features.filter((feature) => feature.properties.part === 'deck');
const parapets = snapshot.features.filter((feature) => feature.properties.part === 'kerb');

test('every bridge deck comes back to an OSM way that crosses water', () => {
  assert.ok(decks.length >= 10, `the frame needs its crossings, got ${decks.length}`);
  assert.equal(parapets.length, decks.length, 'every deck is supposed to have a pair of parapets');
  const ids = decks.map((feature) => feature.properties.osmId);
  assert.equal(new Set(ids).size, ids.length, 'one deck per way');
  for (const feature of snapshot.features) {
    assert.equal(typeof feature.properties.osmId, 'number', `${feature.properties.name}: a deck with no way id behind it is a placed prop`);
    assert.ok(['deck', 'kerb'].includes(feature.properties.part), 'only two parts are drawn');
    assert.ok(feature.properties.height > feature.properties.base, 'a deck has to be above the water and a parapet above the deck');
    if (feature.properties.part === 'deck') {
      assert.ok(feature.properties.base >= 8 && feature.properties.base <= 15,
        `${feature.properties.name}: the deck sits ${feature.properties.base} m up, and the brief allows 8-15`);
    }
    for (const ring of rings(feature.geometry)) {
      assert.deepEqual(ring[0], ring.at(-1), `${feature.properties.osmId}: an unclosed ring renders as a wedge`);
      for (const [lng, lat] of ring) {
        const [x, y] = local([lng, lat]);
        assert.ok(Math.hypot(x, y) < 3600, `${feature.properties.osmId}: a vertex ${Math.round(Math.hypot(x, y))} m out is past the 3 km scene`);
      }
    }
  }
  // The named crossings the brief asks to be able to count from the default camera.
  const names = new Set(decks.map((feature) => feature.properties.name).filter(Boolean));
  for (const wanted of ['猎德大桥', '广州大桥', '海心桥']) {
    assert.ok(names.has(wanted), `${wanted} is not in the snapshot: ${[...names].join('、')}`);
  }
});

test('the deck is a strip of the width it declares, and the parapets are its two edges', () => {
  for (const feature of decks) {
    const { width } = feature.properties;
    const ring = feature.geometry.coordinates[0];
    // A swept strip of length L and width W has perimeter 2(L + W) and area L·W, so L and W are the two roots of
    // t² - (p/2)t + a. Taking the smaller root in the numerically stable form recovers the width from the ring alone,
    // which is what keeps this from being the generator agreeing with itself.
    const half = perimeterLength(ring) / 2;
    const surface = area(ring);
    const measured = 2 * surface / (half + Math.sqrt(Math.max(0, half * half - 4 * surface)));
    assert.ok(Math.abs(measured - width) < width * 0.35,
      `${feature.properties.name}: declares ${width} m and the ring measures ${measured.toFixed(1)} m`);
    assert.ok(feature.properties.foot === ['footway', 'path', 'pedestrian', 'steps', 'cycleway'].includes(feature.properties.highway),
      `${feature.properties.name}: foot flag disagrees with its own highway class`);
  }
  for (const feature of parapets) {
    assert.equal(feature.geometry.type, 'MultiPolygon', 'a parapet is two strips, not one wide one');
    assert.equal(feature.geometry.coordinates.length, 2, 'one strip on each edge of the deck');
    assert.ok(Math.abs(feature.properties.height - feature.properties.base - 1.2) < 1e-6,
      `${feature.properties.name}: the upstand is ${feature.properties.height - feature.properties.base} m tall, not 1.2`);
  }
});

test('the snapshot says out loud which numbers are drawing constants', () => {
  const { metadata } = snapshot;
  assert.equal(metadata.source, 'OpenStreetMap via Overpass');
  assert.equal(metadata.license, 'ODbL');
  assert.match(metadata.selection, /waterway/, 'the selection has to name the water test it applied');
  assert.deepEqual(Object.keys(metadata.schematic).sort(), ['clearance', 'deckThickness', 'parapet', 'widths'],
    'every constant that is not measured has to be in the record');
  assert.equal(metadata.schematic.clearance, 12);
  assert.equal(metadata.ways, decks.length, 'the count in the record is the count in the file');
  assert.equal(metadata.points, snapshot.features.length);
});

test('the two bridge layers are the pair the renderer looks up, and both atmospheres colour them', () => {
  for (const [id, theme] of Object.entries(ATMOSPHERES)) {
    const layers = bridgeLayers(theme);
    assert.deepEqual(layers.map((layer) => layer.id), [BRIDGE_DECK, BRIDGE_PARAPET], `${id}: the deck first, the parapet on top`);
    for (const layer of layers) {
      assert.equal(layer.type, 'fill-extrusion', `${id}/${layer.id}: only an extrusion can be lifted off the water`);
      assert.equal(layer.source, BRIDGE_SOURCE);
      assert.deepEqual(layer.filter, ['==', ['get', 'part'], layer.id === BRIDGE_DECK ? 'deck' : 'kerb']);
      // A `match` refuses a boolean label and MapLibre drops the whole layer in silence, so the deck's split is a
      // `case` - and this is the assertion that keeps it from being "fixed" back.
      const colour = layer.paint['fill-extrusion-color'];
      if (layer.id === BRIDGE_DECK) assert.equal(colour[0], 'case', `${id}: the deck's foot split has to be a case`);
      else assert.equal(typeof colour, 'string', `${id}: the parapet is one flat colour`);
      assert.deepEqual(layer.paint['fill-extrusion-height'], ['coalesce', ['get', 'height'], 0]);
      assert.deepEqual(layer.paint['fill-extrusion-base'], ['coalesce', ['get', 'base'], 0]);
      assert.equal(layer.paint['fill-extrusion-vertical-gradient'], false, 'a deck is flat: a gradient would read as a slope');
    }
    const deck = layers[0].paint['fill-extrusion-color'];
    assert.deepEqual(deck, ['case', ['==', ['get', 'foot'], true], theme.bridgeFoot, theme.bridge]);
    assert.equal(layers[1].paint['fill-extrusion-color'], theme.bridgeParapet);
  }
});

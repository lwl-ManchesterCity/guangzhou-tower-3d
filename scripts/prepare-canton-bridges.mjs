// The bridges that cross water within three kilometres of the tower, as deck and parapet polygons.
//
// OSM draws a river crossing as a highway way tagged `bridge`, and the same tag sits on every elevated interchange in
// the city - 339 ways in this box, most of them viaducts over land. What makes one of them a *bridge over the river* is
// that it crosses a waterway, so that is the test: the way's polyline must intersect a `waterway=river|stream|canal`
// polyline in the same box. Nothing is placed by hand and every feature carries the OSM way id it came from.
//
// The deck is a ribbon swept along the way at a 示意 width, because OSM gives a bridge as a line and a line has no
// width. The parapet is two narrower ribbons on its edges, which is the "双线" the drawing is after.
//
// Usage: node scripts/prepare-canton-bridges.mjs <bridges JSON> <waterways JSON>
import { readFile, writeFile } from 'node:fs/promises';
import { METERS_PER_DEGREE, plane } from '../src/geo.js';

const CENTER = { lat: 23.109, lng: 113.31913 };
const RADIUS_METRES = 3000;
// Drawing constants, not measurements: OSM carries no deck width and no clearance above the water for any of these.
// The clearance is the one 海心桥's own form already uses, so the two readings of a bridge over this river agree.
const CLEARANCE_METRES = 12;
const DECK_THICKNESS = 3.5;
const PARAPET_HEIGHT = 1.2;
const PARAPET_WIDTH = 1.4;
// Widths by the OSM `highway` value, in metres of deck. Graded by what the class carries, not measured per bridge.
const WIDTHS = {
  motorway: 18, trunk: 17, primary: 15, secondary: 13, tertiary: 12, unclassified: 10, residential: 10,
  service: 8, pedestrian: 7, footway: 5, path: 5, steps: 4, cycleway: 4, track: 6,
};
const WATERWAYS = ['river', 'stream', 'canal'];
const MIN_SPAN = 24;

const [bridgeInput, waterInput] = process.argv.slice(2);
if (!bridgeInput || !waterInput) throw new Error('用法：node scripts/prepare-canton-bridges.mjs <bridges JSON> <waterways JSON>');
const read = async (path) => {
  const text = await readFile(path, 'utf8');
  if (text[0] !== '{') throw new Error(`拒绝非 JSON 的 Overpass 响应：${path}\n${text.slice(0, 200)}`);
  const raw = JSON.parse(text);
  if (raw.remark || !Array.isArray(raw.elements)) throw new Error(`拒绝不完整的 Overpass 响应：${path}`);
  return raw;
};
const bridgeResponse = await read(bridgeInput);
const waterResponse = await read(waterInput);

const radians = (degrees) => (degrees * Math.PI) / 180;
const eastScale = METERS_PER_DEGREE * Math.cos(radians(CENTER.lat));
// A flat plane in metres around the tower: over three kilometres the difference to the sphere is well under the width
// of a deck, and every offset below is a perpendicular on this plane.
const toLocal = ([lng, lat]) => [(lng - CENTER.lng) * eastScale, (lat - CENTER.lat) * METERS_PER_DEGREE];
const toLngLat = ([x, y]) => [CENTER.lng + x / eastScale, CENTER.lat + y / METERS_PER_DEGREE];

const lines = (raw, accept) => raw.elements
  .filter((way) => way.type === 'way' && Array.isArray(way.geometry) && way.geometry.length > 1 && accept(way.tags))
  .map((way) => ({ id: way.id, tags: way.tags, points: way.geometry.map((node) => toLocal([node.lon, node.lat])) }));

const waters = lines(waterResponse, (tags) => WATERWAYS.includes(tags.waterway));
// A way carrying both `bridge` and `tunnel` is one structure going under something else and over nothing: the tag is
// read on the whole way, and OSM does tag a sunken road that way.
const crossings = lines(bridgeResponse, (tags) => tags.highway && tags.bridge !== 'no' && !tags.tunnel && tags.layer !== '-1');

const lengthOf = (points) => points.reduce((sum, point, index) => index ? sum + Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) : 0, 0);
// Segment intersection, done on the plane. Shared endpoints do not count: a bridge that merely starts at a culvert's
// mouth has not crossed anything.
const spans = (a, b) => {
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      const d1 = cross(r, s, p), d2 = cross(r, s, q), d3 = cross(p, q, r), d4 = cross(p, q, s);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
  }
  return false;
};
const crossesWater = (points) => waters.some((water) => spans(points, water.points));

// Sweep the way into a strip between two perpendicular offsets. Each vertex takes the normal of the average of its two
// neighbouring segments, so a mitre at a corner cannot fly out on a tight bend.
function ribbon(points, from, to) {
  const left = [], right = [];
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next[0] - previous[0], dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    const [x, y] = points[index];
    left.push([x + nx * from, y + ny * from]);
    right.push([x + nx * to, y + ny * to]);
  }
  return [[...left, ...right.reverse(), left[0]].map(toLngLat)];
}
const ring = (points, from, to) => ({ type: 'Polygon', coordinates: ribbon(points, from, to) });
const half = (width) => width / 2;

const kept = crossings.filter((way) => lengthOf(way.points) >= MIN_SPAN && crossesWater(way.points));
const features = [];
for (const way of kept) {
  const foot = ['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway'].includes(way.tags.highway);
  const width = WIDTHS[way.tags.highway] ?? 10;
  const middle = way.points[Math.floor(way.points.length / 2)];
  const distance = Math.round(Math.hypot(middle[0], middle[1]));
  const base = CLEARANCE_METRES;
  const deck = base + DECK_THICKNESS;
  const shared = {
    osmId: way.id, name: way.tags.name ?? null, highway: way.tags.highway, foot, width, distance,
    structure: way.tags['bridge:structure'] ?? null,
  };
  features.push({
    type: 'Feature',
    properties: { ...shared, part: 'deck', base, height: deck },
    geometry: ring(way.points, -half(width), half(width)),
  });
  features.push({
    type: 'Feature',
    properties: { ...shared, part: 'kerb', base: deck, height: deck + PARAPET_HEIGHT },
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        ribbon(way.points, -half(width), -half(width) + PARAPET_WIDTH),
        ribbon(way.points, half(width) - PARAPET_WIDTH, half(width)),
      ],
    },
  });
}

const output = {
  type: 'FeatureCollection',
  metadata: {
    source: 'OpenStreetMap via Overpass',
    license: 'ODbL',
    attribution: '© OpenStreetMap contributors',
    timestamp: bridgeResponse.osm3s?.timestamp_osm_base ?? null,
    selection: `way(around:${RADIUS_METRES},${CENTER.lat},${CENTER.lng})["highway"]["bridge"] kept where the way crosses a "waterway"~"^(river|stream|canal)$" line`,
    radius: RADIUS_METRES,
    // Stated out loud because the file is served to a browser: these are drawing constants, not surveyed values.
    schematic: { clearance: CLEARANCE_METRES, deckThickness: DECK_THICKNESS, parapet: PARAPET_HEIGHT, widths: WIDTHS },
    bridges: [...new Set(kept.map((way) => way.tags.name).filter(Boolean))],
    ways: kept.length,
    points: features.length,
  },
  features,
};
await writeFile('public/data/canton-bridges.geojson', `${JSON.stringify(output)}\n`);
console.log(`crossings ${kept.length}/${crossings.length} · features ${features.length} · ${output.metadata.bridges.join('、')}`);

import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateKey, distanceMeters, formatCoordinates, radiusPolygon } from '../src/geo.js';
import { DEFAULT_CENTER, RADIUS_METERS } from '../src/config.js';
import { buildQuery, createPoiService, normalizePois, poisGeoJSON } from '../src/pois.js';

const center = { lat: 23.1135, lng: 113.2394 };
const node = (id, tags = { name: '测试咖啡', amenity: 'cafe' }) => ({ type: 'node', id, lat: center.lat, lon: center.lng, tags });
const response = (elements) => ({ ok: true, json: async () => ({ elements }) });

test('fixed scene covers three kilometers around the actual OSM tower footprint', () => {
  assert.deepEqual(DEFAULT_CENTER, { lat: 23.10900, lng: 113.31913 });
  assert.equal(RADIUS_METERS, 3000);
  for (const [lng, lat] of radiusPolygon(DEFAULT_CENTER, RADIUS_METERS).geometry.coordinates[0]) assert.ok(Math.abs(distanceMeters(DEFAULT_CENTER, { lat, lng }) - 3000) < 0.001);
  assert.match(buildQuery(DEFAULT_CENTER), /around:3000,23\.109000,113\.319130/);
});

test('default POI selection keeps the inner 3 km and excludes the old 3–5 km annulus', () => {
  const inside = { ...node(1), lat: DEFAULT_CENTER.lat + 0.025, lon: DEFAULT_CENTER.lng };
  const annulus = { ...node(2), lat: DEFAULT_CENTER.lat + 0.035, lon: DEFAULT_CENTER.lng };
  const distance = (poi) => distanceMeters(DEFAULT_CENTER, { lat: poi.lat, lng: poi.lon });
  assert.ok(distance(inside) > 2500 && distance(inside) < 3000);
  assert.ok(distance(annulus) > 3000 && distance(annulus) < 5000);
  assert.deepEqual(normalizePois([annulus, inside], DEFAULT_CENTER).map((poi) => poi.id), ['node/1']);
  assert.deepEqual(normalizePois([annulus, inside], DEFAULT_CENTER, 5000).map((poi) => poi.id), ['node/1', 'node/2']);
});

test('geographic distances and radius polygon use real meters', () => {
  assert.equal(distanceMeters(center, center), 0);
  const polygon = radiusPolygon(center, 500);
  const ring = polygon.geometry.coordinates[0];
  assert.equal(ring.length, 97);
  assert.deepEqual(ring[0], ring.at(-1));
  for (const [lng, lat] of ring) assert.ok(Math.abs(distanceMeters(center, { lat, lng }) - 500) < 0.001);
  const acrossDateline = distanceMeters({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 });
  assert.ok(acrossDateline > 222 && acrossDateline < 223);
});

test('cache key uses coordinate and radius; coordinate display preserves hemispheres', () => {
  assert.equal(coordinateKey(center, 500), '23.113500,113.239400,500');
  assert.notEqual(coordinateKey(center, 500), coordinateKey(center, 600));
  assert.equal(formatCoordinates({ lat: -23, lng: -74 }), '23.00000° S · 74.00000° W');
});

test('Overpass query contains configured categories and radius', () => {
  const query = buildQuery(center, 500);
  assert.match(query, /around:500,23\.113500,113\.239400/);
  assert.match(query, /\[shop\]/);
  assert.match(query, /subway_entrance/);
  assert.match(query, /out center tags;/);
});

test('POIs deduplicate OSM identities, prefer Chinese names and exclude out-of-radius or malformed data', () => {
  const elements = [node(1, { 'name:zh': '中文名', name: 'English', amenity: 'cafe' }), node(1), { ...node(2), lat: 24 }, { ...node(3), lon: '113' }, { ...node(4), type: 'invalid' }];
  const pois = normalizePois(elements, center);
  assert.equal(pois.length, 1);
  assert.equal(pois[0].name, '中文名');
  assert.equal(pois[0].label, '咖啡馆');
  assert.equal(pois[0].osmUrl, 'https://www.openstreetmap.org/node/1');
});

test('polygon centers, category labels and missing names are supported', () => {
  const elements = [{ type: 'way', id: 2, center: { lat: center.lat, lon: center.lng }, tags: { tourism: 'museum', name: '博物馆' } }, node(3, { railway: 'subway_entrance' }), node(4, { shop: 'supermarket' })];
  const pois = normalizePois(elements, center);
  assert.deepEqual(pois.map((poi) => poi.category), ['visit', 'transit', 'shop']);
  assert.equal(pois[1].name, '地铁出入口（未命名）');
  assert.equal(pois[2].label, '超市');
  assert.deepEqual(poisGeoJSON(pois).features[0].geometry.coordinates, [center.lng, center.lat]);
});

test('untrusted text stays text and OSM links are built only from validated identities', () => {
  const name = '<img src=x onerror=alert(1)>';
  const pois = normalizePois([node(1, { name, amenity: 'cafe' }), { ...node(2), id: 'javascript:alert(1)' }], center);
  assert.equal(pois.length, 1);
  assert.equal(pois[0].name, name);
  assert.equal(pois[0].osmUrl, 'https://www.openstreetmap.org/node/1');
});

test('repeated and concurrent requests share one query and cache successful results', async () => {
  let calls = 0;
  const service = createPoiService({ endpoints: ['https://example.test/query'], fetcher: async () => { calls++; return response([node(1)]); } });
  const [a, b] = await Promise.all([service.load(center), service.load(center)]);
  assert.deepEqual(a.pois, b.pois);
  assert.equal(calls, 1);
  assert.equal((await service.load(center)).cached, true);
  assert.equal(calls, 1);
});

test('bounded LRU cache evicts old positions', async () => {
  let calls = 0;
  const service = createPoiService({ endpoints: ['https://example.test/query'], cacheSize: 1, fetcher: async () => { calls++; return response([]); } });
  await service.load(center);
  await service.load({ lat: 40.7336, lng: -74.0027 });
  await service.load(center);
  assert.equal(calls, 3);
});

test('failed queries retry on next action rather than caching errors', async () => {
  let calls = 0;
  const service = createPoiService({ endpoints: ['https://example.test/query'], fetcher: async () => { calls++; if (calls === 1) throw new TypeError('Failed to fetch'); return response([]); } });
  await assert.rejects(service.load(center), /无法连接/);
  assert.deepEqual((await service.load(center)).pois, []);
  assert.equal(calls, 2);
});

test('rate limiting is reported without retrying other instances', async () => {
  let calls = 0;
  const service = createPoiService({ endpoints: ['https://example.test/a', 'https://example.test/b'], fetcher: async () => { calls++; return { ok: false, status: 429 }; } });
  await assert.rejects(service.load(center), /查询较频繁/);
  assert.equal(calls, 1);
});

test('Overpass partial results with remark are treated as incomplete', async () => {
  const service = createPoiService({ endpoints: ['https://example.test/query'], fetcher: async () => ({ ok: true, json: async () => ({ elements: [], remark: 'runtime timeout' }) }) });
  await assert.rejects(service.load(center), /未完成/);
});

test('secondary endpoint is used after a failed primary endpoint', async () => {
  let calls = 0;
  const service = createPoiService({ endpoints: ['https://example.test/a', 'https://example.test/b'], fetcher: async () => ++calls === 1 ? { ok: false, status: 503 } : response([node(1)]) });
  assert.equal((await service.load(center)).pois.length, 1);
  assert.equal(calls, 2);
});

test('dense neighborhoods keep the nearest 200 POIs and retain the total count', async () => {
  const service = createPoiService({ endpoints: ['https://example.test/query'], fetcher: async () => response(Array.from({ length: 250 }, (_, index) => node(index + 1))) });
  const result = await service.load(center);
  assert.equal(result.pois.length, 200);
  assert.equal(result.total, 250);
});

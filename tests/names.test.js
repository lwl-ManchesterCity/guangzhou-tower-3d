import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAmapPlaces, nameGroups } from '../src/names.js';

const square = (id, west, south, side = 0.0009) => ({
  type: 'Feature',
  properties: { groupId: id },
  geometry: {
    type: 'Polygon',
    coordinates: [[[west, south], [west + side, south], [west + side, south + side], [west, south + side], [west, south]]],
  },
});
const place = (id, name, lng, lat) => ({ id, name, type: '商务住宅;住宅区;住宅小区', at: [lng, lat] });
// Roughly 1 degree of latitude is 110.5 km, so 0.00018 deg is about 20 m and 0.00054 deg about 60 m.
const LAT_20M = 0.00018;

test('a place inside the envelope names the block and reports no rival', () => {
  const shape = square('a', 113.26, 23.17);
  const named = nameGroups([shape], [place('1', '交委小区', 113.26045, 23.17045)]);
  assert.deepEqual([...named], [['a', { name: '交委小区', id: '1', type: '商务住宅;住宅区;住宅小区', inside: true, distance: 0, others: 0 }]]);
});

test('a place beside the block still names it within 40 m and is marked as outside', () => {
  const shape = square('a', 113.26, 23.17);
  const northEdge = 23.17 + 0.0009;
  const near = nameGroups([shape], [place('1', '近处小区', 113.26045, northEdge + LAT_20M)]);
  assert.equal(near.get('a').name, '近处小区');
  assert.equal(near.get('a').inside, false);
  assert.ok(near.get('a').distance > 15 && near.get('a').distance < 25, String(near.get('a').distance));
  assert.equal(nameGroups([shape], [place('1', '远处小区', 113.26045, northEdge + 3 * LAT_20M)]).size, 0);
});

test('the candidate closest to the middle of the block wins and the rest are counted', () => {
  const shape = square('a', 113.26, 23.17);
  const places = [
    place('1', '偏在一角', 113.26005, 23.17005),
    place('2', '靠近正中', 113.26045, 23.17045),
    place('3', '另一角', 113.26085, 23.17085),
  ];
  for (const order of [places, [...places].reverse(), [places[1], places[2], places[0]]]) {
    const named = nameGroups([shape], order);
    assert.equal(named.get('a').name, '靠近正中');
    assert.equal(named.get('a').others, 2);
  }
});

test('a block with no group identity is left unnamed', () => {
  const singleton = { type: 'Feature', properties: { osmId: '9' }, geometry: square('a', 113.26, 23.17).geometry };
  assert.equal(nameGroups([singleton], [place('1', '某小区', 113.26045, 23.17045)]).size, 0);
});

test('one place can name two neighbouring blocks, which is why the card says inferred', () => {
  const left = square('left', 113.26, 23.17);
  const right = square('right', 113.2609, 23.17);
  const named = nameGroups([left, right], [place('1', '两栋之间的门牌', 113.26085, 23.17045)]);
  assert.equal(named.get('left').name, '两栋之间的门牌');
  assert.equal(named.get('right').name, '两栋之间的门牌');
  assert.equal(named.get('left').inside, true);
  assert.equal(named.get('right').inside, false);
  assert.ok(named.get('right').distance < 10, String(named.get('right').distance));
});

test('a place inside the envelope outranks a nearer one that lies outside it', () => {
  // A long block keeps its middle far from its own corners, so the centre tie-break alone would hand it to a neighbour.
  const wide = {
    type: 'Feature',
    properties: { groupId: 'a' },
    geometry: { type: 'Polygon', coordinates: [[[113.26, 23.17], [113.262, 23.17], [113.262, 23.1709], [113.26, 23.1709], [113.26, 23.17]]] },
  };
  const inside = place('1', '院内地点', 113.2619, 23.17045);
  const outside = place('2', '墙外地点', 113.261, 23.17095);
  for (const order of [[inside, outside], [outside, inside]]) {
    const named = nameGroups([wide], order);
    assert.equal(named.get('a').name, '院内地点');
    assert.equal(named.get('a').inside, true);
    assert.equal(named.get('a').others, 1);
  }
});

const served = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
const good = { places: [place('1', '交委小区', 113.26045, 23.17045)] };

test('a served snapshot keeps only places with an id, a name and finite coordinates', async () => {
  const seen = [];
  const places = await loadAmapPlaces(async (url, init) => {
    seen.push([url, init.credentials, init.signal instanceof AbortSignal]);
    const body = { places: [good.places[0], { id: '2', name: '', at: [1, 2] }, { id: '3', name: '缺坐标' }, { id: '4', name: '非数字', at: ['x', 2] }] };
    return { ok: true, status: 200, json: async () => body };
  }, '/local/jingtai-amap-names.json');
  assert.deepEqual(places, good.places);
  assert.deepEqual(seen, [['/local/jingtai-amap-names.json', 'omit', true]]);
});

// The snapshot is dev-only, so every failure below has to end in null rather than a rejected promise: the card falls
// back to 相邻建筑群 and the rest of the page is unaffected.
test('a missing or broken snapshot degrades to null on every path', async () => {
  for (const fetcher of [
    served(good, false, 404),
    served(null),
    served({}),
    served({ places: [] }),
    served({ places: [{ id: '1', name: '无坐标' }] }),
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }),
  ]) {
    assert.equal(await loadAmapPlaces(fetcher, '/local/jingtai-amap-names.json'), null);
  }
});

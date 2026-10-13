import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TOWER_OSM_ID } from '../src/config.js';
import { loadSearchIndex, normalizeText, searchBuildings } from '../src/search.js';

const entry = (osmId, over = {}) => ({ osmId, name: '', nameEn: '', street: '', house: '', category: 'unknown', height: 10, heightSource: 'estimate', distance: 500, lat: 23.109, lng: 113.31913, ...over });
const response = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });

test('names and queries are squeezed to letters, digits and Han characters', () => {
  assert.equal(normalizeText('Xinghai  Concert-Hall'), 'xinghaiconcerthall');
  assert.equal(normalizeText('省博物馆（珠江新城）'), '省博物馆珠江新城');
  assert.equal(normalizeText('<img src=x onerror=alert(1)>'), 'imgsrcxonerroralert1');
  assert.equal(normalizeText(undefined), '');
});

test('one ASCII character is noise but one Chinese character is a real query', () => {
  const entries = [entry(1, { name: '广州塔' }), entry(2, { nameEn: 'gz tower' })];
  assert.deepEqual(searchBuildings(entries, '广'), [entries[0]]);
  assert.deepEqual(searchBuildings(entries, 'g'), []);
  assert.deepEqual(searchBuildings(entries, ''), []);
  assert.deepEqual(searchBuildings(entries, '   '), []);
});

test('a name prefix beats an English prefix, which beats a mention, which beats an address', () => {
  const entries = [
    entry(5, { street: '某某gz路', house: '3' }),
    entry(4, { street: 'gz路', house: '1' }),
    entry(3, { name: '某gz楼' }),
    entry(2, { nameEn: 'gz tower' }),
    entry(1, { name: 'gz广场' }),
    entry(6, { name: '某某', street: '某某路' }),
  ];
  assert.deepEqual(searchBuildings(entries, 'gz').map((item) => item.osmId), [1, 2, 3, 4, 5]);
});

test('results inside one tier are ordered by distance from the tower, then by OSM id', () => {
  const entries = [entry(5, { name: '同名楼', distance: 900 }), entry(3, { name: '同名楼', distance: 100 }), entry(9, { name: '同名楼', distance: 100 })];
  assert.deepEqual(searchBuildings(entries, '同名').map((item) => item.osmId), [3, 9, 5]);
});

test('the result list is capped', () => {
  const entries = Array.from({ length: 20 }, (_, index) => entry(index + 1, { name: `广州塔${index}`, distance: index }));
  assert.equal(searchBuildings(entries, '广州塔').length, 8);
  assert.equal(searchBuildings(entries, '广州塔', 3).length, 3);
});

test('the shipped index finds the tower, a named hotel and a bare door number', async () => {
  const { entries } = JSON.parse(await readFile(new URL('../public/data/canton-buildings-index.json', import.meta.url)));
  assert.equal(searchBuildings(entries, '广州塔')[0].osmId, TOWER_OSM_ID);
  assert.equal(searchBuildings(entries, '广州 塔')[0].osmId, TOWER_OSM_ID);
  assert.equal(searchBuildings(entries, '亚朵')[0].street, '滨江东路');
  assert.equal(searchBuildings(entries, '795')[0].house, '795号');
  assert.deepEqual(searchBuildings(entries, '不存在的楼名XYZ'), []);
});

test('the index is fetched without credentials', async () => {
  let seen;
  const entries = await loadSearchIndex(async (url, init) => { seen = [url, init]; return { ok: true, status: 200, json: async () => ({ entries: [entry(1)] }) }; }, '/data/index.json');
  assert.deepEqual(seen[0], '/data/index.json');
  assert.equal(seen[1].credentials, 'omit');
  assert.equal(seen[1].signal instanceof AbortSignal, true);
  assert.equal(entries.length, 1);
});

test('a download failure, an HTTP error, a timeout and a broken body each get their own Chinese message', async () => {
  await assert.rejects(loadSearchIndex(async () => { throw new TypeError('Failed to fetch'); }, '/i.json'), /暂时无法下载检索索引/);
  // AbortSignal.timeout arms an unref'd timer, so the fake fetcher holds a ref'd one beside it or the run ends first.
  const timedOut = async (url, init) => Promise.race([
    new Promise((resolve) => setTimeout(resolve, 50, 'never aborted')),
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  ]);
  await assert.rejects(loadSearchIndex(timedOut, '/i.json', 1), /检索索引下载超时/);
  await assert.rejects(loadSearchIndex(response(null, false, 503), '/i.json'), /检索索引暂时不可用（HTTP 503）/);
  await assert.rejects(loadSearchIndex(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }), '/i.json'), /检索索引不完整/);
  await assert.rejects(loadSearchIndex(response({ ok: true }), '/i.json'), /检索索引不完整/);
});

function mixedIdTies(search) {
  const expected = [2, 10, 4778776, 'relation/10', 'relation/2', 'relation/4778776'];
  const entries = expected.map(id => entry(id, { name: '同名楼', distance: 100 }));
  for (let start = 0; start < entries.length; start++) {
    const rotated = [...entries.slice(start), ...entries.slice(0, start)];
    for (const input of [rotated, [...rotated].reverse()]) {
      const before = [...input];
      assert.deepEqual(search(input, '同名').map(item => item.osmId), expected);
      assert.deepEqual(search(input, '同名', 4).map(item => item.osmId), expected.slice(0, 4));
      assert.deepEqual(input, before, 'sorting does not mutate the index');
    }
  }
  // Identity only breaks exact ties; neither the namespace nor the ID can outrank name tier or distance.
  const ranked = [
    entry(1, { name: '别处同名楼', distance: 0 }),
    entry('relation/1', { name: '同名楼', distance: 900 }),
    entry(2, { name: '同名楼', distance: 500 }),
    entry('relation/2', { name: '同名楼', distance: 100 }),
  ];
  assert.deepEqual(search(ranked, '同名').map(item => item.osmId), ['relation/2', 2, 'relation/1', 1]);
}

test('mixed ID ties are input-independent, with numeric ways followed by lexical relation IDs', () => mixedIdTies(searchBuildings));

test('the shipped school index finds named relations and preserves their IDs when downloaded', async () => {
  const index = JSON.parse(await readFile(new URL('../public/data/jingtai-buildings-index.json', import.meta.url)));
  const entries = await loadSearchIndex(response(index), '/data/jingtai-buildings-index.json');
  for (const [name, id] of [
    ['白云区少年宫', 'relation/4779478'],
    ['万达广场C区1号写字楼', 'relation/5748957'],
    ['万达广场C区3号写字楼', 'relation/5748958'],
    ['广州体育馆', 'relation/10224102'],
    ['云璟汇', 'relation/14113388'],
  ]) assert.equal(searchBuildings(entries, name)[0].osmId, id, name);
});

test('in-memory tie-sort defects are caught by the mixed-ID assertions', async (t) => {
  const source = await readFile(new URL('../src/search.js', import.meta.url), 'utf8');
  for (const [name, from, to] of [
    ['old subtraction yields NaN for relations', 'compareIds(a[1].osmId, b[1].osmId)', 'a[1].osmId - b[1].osmId'],
    ['numeric ways are sorted lexically', "if (typeof a === 'number' && typeof b === 'number') return a - b;", ''],
    ['relation order is reversed', 'left < right ? -1 : left > right ? 1 : 0', 'left < right ? 1 : left > right ? -1 : 0'],
  ]) await t.test(name, async () => {
    assert.equal(source.split(from).length, 2);
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString('base64')}`);
    assert.throws(() => mixedIdTies(mutant.searchBuildings), { code: 'ERR_ASSERTION' });
  });
});

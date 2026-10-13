import { test, expect } from '@playwright/test';

test.use({ launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, viewport: { width: 1440, height: 960 } });
const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const rangeBounds = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const { radiusPolygon } = await import('/src/geo.js');
  const points = radiusPolygon({lat:23.109,lng:113.31913},3000).geometry.coordinates[0].map(p=>neighborhood.map.project(p));
  return { left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y)) };
});
const state = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  return { pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom(), tower: !!map.getLayer('canton-tower'), buildings: map.queryRenderedFeatures({ layers: ['neighborhood-buildings', 'neighborhood-buildings-overview'] }).length, pois: map.queryRenderedFeatures({ layers: ['poi-markers'] }).length, categories: [...new Set(map.queryRenderedFeatures({layers:['neighborhood-buildings']}).map(f=>f.properties.category))], error: document.getElementById('map-error').hidden ? null : document.getElementById('map-error-text').textContent };
});
const settled = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  if (neighborhood.map.loaded() && !neighborhood.map.isMoving()) return;
  await new Promise(resolve => neighborhood.map.once('idle', resolve));
});
const openMap = async (page) => {
  await page.goto(appUrl);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await expect.poll(async () => (await state(page)).buildings, { timeout: 30000 }).toBeGreaterThan(0);
  await settled(page);
};

 test('fixed tower, real building colors, full radius, orbit and mobile', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  let queries = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if(r.url().includes('/api/interpreter')) queries++; });
  await openMap(page);
  const initial = await state(page);
  expect(initial.pitch).toBeCloseTo(62, 0);
  expect(initial.tower).toBe(true);
  expect(initial.error).toBeNull();
  expect(initial.categories.sort()).toEqual(['commercial', 'public', 'residential', 'unknown']);
  expect(queries).toBe(0);
  await expect(page.locator('#poi-panel')).toBeHidden();
  await expect(page.locator('#coordinate-input, [data-preset], #back-button')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/canton-tower-desktop.png' });
  const coords = await page.locator('#coordinates').textContent();
  await page.locator('#map').click({ position: { x: 1100, y: 650 } });
  await expect(page.locator('#coordinates')).toHaveText(coords);
  await expect(page.locator('#poi-panel')).toBeHidden();
  await page.locator('#overview-button').click();
  await settled(page);
  expect((await state(page)).zoom).toBeLessThan(14);
  const visible = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { radiusPolygon } = await import('/src/geo.js');
    const ring = radiusPolygon({lat:23.109,lng:113.31913},3000).geometry.coordinates[0];
    return ring.every(p=> { const s=neighborhood.map.project(p);return s.x>=0&&s.x<=innerWidth&&s.y>=0&&s.y<=innerHeight; });
  });
  expect(visible).toBe(true);
  await page.screenshot({ path: '/tmp/canton-tower-overview.png' });
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.locator('#orbit-button').click();
  const bearing = (await state(page)).bearing;
  await expect.poll(async () => Math.abs((await state(page)).bearing-bearing), {timeout:5000}).toBeGreaterThan(2);
  await page.locator('#map').hover({position:{x:850,y:600}});
  await page.mouse.wheel(0, -100);
  await expect(page.locator('#explore-button')).toHaveAttribute('aria-pressed', 'true');
  // ⌥/Alt + left drag is the trackpad-safe rotate gesture: ~20° per 100px, center and pitch untouched.
  const camera = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const c = neighborhood.map.getCenter();
    return { bearing: neighborhood.map.getBearing(), pitch: neighborhood.map.getPitch(), lng: +c.lng.toFixed(5), lat: +c.lat.toFixed(5) };
  });
  const turned = (a, b) => ((b.bearing - a.bearing + 540) % 360) - 180;
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.waitForTimeout(500);
  const beforeAlt = await camera();
  await page.keyboard.down('Alt');
  await page.mouse.move(600, 700); await page.mouse.down();
  await page.mouse.move(900, 700, { steps: 15 }); await page.mouse.up();
  await page.keyboard.up('Alt');
  await settled(page);
  const afterAlt = await camera();
  const degreesPer100px = Math.abs(turned(beforeAlt, afterAlt)) / 3;
  expect(degreesPer100px).toBeGreaterThan(15);
  expect(degreesPer100px).toBeLessThan(30);
  expect([afterAlt.lng, afterAlt.lat]).toEqual([beforeAlt.lng, beforeAlt.lat]);
  expect(Math.abs(afterAlt.pitch - beforeAlt.pitch)).toBeLessThan(1);
  await page.screenshot({ path: '/tmp/canton-tower-alt-rotate.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.screenshot({ path: '/tmp/canton-tower-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#orbit-button')).toBeVisible();
  await page.locator('#overview-button').click();
  await settled(page);
  const mobileBounds = await rangeBounds(page);
  expect(mobileBounds.left).toBeGreaterThanOrEqual(25);
  expect(mobileBounds.right).toBeLessThanOrEqual(365);
  expect(mobileBounds.right - mobileBounds.left).toBeGreaterThan(280);
  expect(mobileBounds.top).toBeGreaterThanOrEqual(255);
  expect(mobileBounds.bottom).toBeLessThanOrEqual(674);
  await page.screenshot({ path: '/tmp/canton-tower-mobile-overview.png' });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({initial, queries, errors}));
});

// Whether a card's own rectangle sits on the block it describes, plus what that card is. The block is the one named by
// the card's own OSM link, and queryRenderedFeatures only answers for the rendered frame, so this is the same test the
// seating scores candidates with. The box is inset because a tail tip grazing the block's edge is the card pointing at
// its subject, not hiding it.
const cardSeat = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const node = document.querySelector('.maplibregl-popup .building-card');
  const card = node?.closest('.maplibregl-popup-content')?.getBoundingClientRect();
  const osmId = Number(node?.querySelector('.osm-link')?.href.split('/').pop());
  if (!card || !osmId) return null;
  const layers = ['canton-tower-hit', 'neighborhood-buildings', 'neighborhood-buildings-overview'];
  const pad = 8;
  const box = [[card.left + pad, card.top + pad], [card.right - pad, card.bottom - pad]];
  const hidden = Number(neighborhood.map.queryRenderedFeatures(box, { layers }).some(f => Number(f.properties.osmId) === osmId));
  return { hidden, label: `${node.querySelector('h3').textContent} ${document.querySelector('.maplibregl-popup').className.match(/anchor-(\w+)/)?.[1] ?? 'auto'}` };
});

test('clicking a block names it, marks the volume and clears when closed', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openMap(page);
  const picks = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const middle = (geometry) => {
      const p = geometry.coordinates[0].map(([lng, lat]) => map.project([lng, lat]));
      return [Math.round(p.reduce((s, q) => s + q.x, 0) / p.length), Math.round(p.reduce((s, q) => s + q.y, 0) / p.length)];
    };
    const onScreen = ([x, y]) => x > 340 && x < innerWidth - 340 && y > 300 && y < innerHeight - 330;
    const unique = [...new Map(map.queryRenderedFeatures({ layers: ['neighborhood-buildings'] }).map(f => [f.properties.osmId, f])).values()];
    const take = (keep) => unique.filter(keep).map(f => ({ osmId: f.properties.osmId, name: f.properties.name ?? null, at: middle(f.geometry) })).filter(c => onScreen(c.at)).slice(0, 4);
    const tower = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] })[0];
    return {
      named: take(f => f.properties.name && f.properties.area > 900),
      unnamed: take(f => !f.properties.name && f.properties.area > 1500),
      tower: tower ? middle(tower.geometry) : null,
    };
  });
  expect(picks.named.length).toBeGreaterThan(0);
  expect(picks.unnamed.length).toBeGreaterThan(0);
  const selection = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).length;
  });
  const card = () => page.evaluate(() => {
    const node = document.querySelector('.maplibregl-popup .building-card');
    if (!node) return null;
    return {
      eyebrow: node.querySelector('.eyebrow').textContent,
      title: node.querySelector('h3').textContent,
      facts: [...node.querySelectorAll('.building-fact')].map(n => n.textContent),
      href: node.querySelector('.osm-link')?.href ?? null,
      rel: node.querySelector('.osm-link')?.getAttribute('rel') ?? null,
    };
  });
  // At 62° pitch a foreground block can hide the one behind it, so a pick counts once the card matches the clicked osmId.
  const clickBuilding = async (candidates, matches) => {
    for (const candidate of candidates) {
      await page.mouse.click(candidate.at[0], candidate.at[1]);
      await page.waitForTimeout(400);
      const shown = await card();
      if (shown && matches(shown, candidate)) return shown;
      await page.locator('[aria-label="关闭建筑卡片"]').click({ timeout: 3000 }).catch(() => {});
    }
    return null;
  };
  const named = await clickBuilding(picks.named, (shown, c) => shown.title === c.name && shown.href === `https://www.openstreetmap.org/way/${c.osmId}`);
  expect(named, 'no named block resolved its own card').toBeTruthy();
  expect(named.eyebrow).toMatch(/^(商业办公|住宅|公共设施|未分类) · 距广州塔 \d+ m$/);
  expect(named.facts.some(f => /高度/.test(f))).toBe(true);
  expect(named.facts.some(f => /占地约 [\d,]+ m²/.test(f))).toBe(true);
  expect(named.rel).toBe('noopener noreferrer');
  // The clicked volume is the thing the card is about, so no seat may hide it: the card's own osmId has to stay drawn
  // under the rectangle the card occupies.
  const namedSeat = await cardSeat(page);
  expect(namedSeat.hidden, `the card sits on top of ${namedSeat.label}`).toBe(0);
  const cardBox = await page.locator('.maplibregl-popup-content').boundingBox();
  const controlsBox = await page.locator('#view-controls').boundingBox();
  const pillYielded = await page.evaluate(() => document.body.dataset.cardPill === 'covered');
  expect(cardBox.y + cardBox.height < controlsBox.y || pillYielded, 'the card sits on the control pill without it stepping out').toBe(true);
  await expect.poll(selection, { timeout: 5000 }).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/canton-tower-building-card.png' });
  await page.locator('[aria-label="关闭建筑卡片"]').click();
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect.poll(selection, { timeout: 5000 }).toBe(0);
  const unnamed = await clickBuilding(picks.unnamed, (shown, c) => /（OSM 未标注名称）$/.test(shown.title) && shown.href === `https://www.openstreetmap.org/way/${c.osmId}`);
  expect(unnamed, 'no unnamed block fell back to its category').toBeTruthy();
  await page.locator('[aria-label="关闭建筑卡片"]').click();
  // The shaft is a parametric mesh, so the invisible outline volume has to catch clicks far above the footprint.
  await page.mouse.click(picks.tower[0], picks.tower[1] - 150);
  await page.waitForTimeout(400);
  const towerCard = await card();
  expect(towerCard?.title).toBe('广州塔');
  expect(towerCard?.facts[0]).toContain('参数化示意模型');
  expect(towerCard?.href).toBe('https://www.openstreetmap.org/way/584204634');
  await expect.poll(selection, { timeout: 5000 }).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/canton-tower-building-tower.png' });
  await page.locator('[aria-label="关闭建筑卡片"]').click();
  // The reported case, resolved by name rather than by a screen guess: a wide, low block has to draw a card that covers
  // nothing at all — not its own volume, not a control, and not even the pill that is allowed to step out of the way.
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { entries } = await (await fetch('/data/canton-buildings-index.json')).json();
    const entry = entries.find((item) => item.name === '广州图书馆');
    neighborhood.focusBuilding({ osmId: entry.osmId, lat: entry.lat, lng: entry.lng });
  });
  await expect(page.locator('.maplibregl-popup h3')).toHaveText('广州图书馆', { timeout: 20000 });
  await settled(page);
  const size = await page.locator('.maplibregl-popup-content').boundingBox();
  expect(size.width, `the card is ${size.width}px wide`).toBeLessThanOrEqual(255);
  expect(size.height, `the card is ${size.height}px tall`).toBeLessThanOrEqual(300);
  const librarySeat = await cardSeat(page);
  expect(librarySeat.hidden, `the card sits on top of ${librarySeat.label}`).toBe(0);
  await page.screenshot({ path: '/tmp/canton-tower-building-library.png' });
  expect(await cardClearance(page), 'a short block gets a seat that covers no control either').toMatchObject({ offscreen: 0, attribution: 0, clippedPct: 0, pillCovered: false });
  expect(errors).toEqual([]);
});

const cardClearance = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const card = document.querySelector('.maplibregl-popup-content')?.getBoundingClientRect();
  if (!card) return { noCard: true };
  const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
  const clip = (rect) => ({ left: Math.max(rect.left, 0), top: Math.max(rect.top, 0), right: Math.min(rect.right, innerWidth), bottom: Math.min(rect.bottom, innerHeight) });
  const cross = (a, b) => area(clip({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }));
  let worst = 0, attribution = 0;
  // A card that lands on the control pill is allowed only where the pill can step out of the way, so a faded pill is
  // not counted as clipping: the remaining controls and the credits always have to stay readable.
  const pill = document.querySelector('#view-controls').getBoundingClientRect();
  // "Covered" is measured the way the seating measures it: a share of the card rounded to a whole percent, so a one pixel
  // graze neither fades the pill in map.js nor counts as covered here.
  const pillCovered = cross(card, pill) / area(card) >= 0.005;
  const pillYielded = parseFloat(getComputedStyle(document.querySelector('#view-controls')).opacity) < 0.05;
  for (const selector of ['.maplibregl-ctrl-bottom-right', '.maplibregl-ctrl-bottom-left', '.maplibregl-ctrl-attrib']) {
    const node = document.querySelector(selector);
    const bar = node?.getBoundingClientRect();
    if (!bar?.width || !bar?.height) continue;
    const overlap = cross(card, bar);
    if (getComputedStyle(node).opacity === '0') continue;
    if (selector === '.maplibregl-ctrl-attrib') attribution += overlap;
    else worst = Math.max(worst, overlap);
  }
  const result = {
    offscreen: Math.round(area(card) - area(clip(card))),
    attribution: Math.round(attribution),
    clippedPct: +(worst / area(card) * 100).toFixed(1),
    pillCovered,
    pillYielded,
  };
  neighborhood.closeCard();
  return result;
});

const blockPicks = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  const box = (point, size) => [[point.x - size, point.y - size], [point.x + size, point.y + size]];
  const layers = ['canton-tower-hit', 'neighborhood-buildings', 'neighborhood-buildings-overview'];
  const seen = new Set();
  const picks = [];
  for (const feature of map.queryRenderedFeatures({ layers })) {
    const id = feature.properties.osmId;
    if (!id || seen.has(id)) continue;
    const near = feature.geometry.coordinates[0].map(([lng, lat]) => map.project([lng, lat])).reduce((a, p) => (p.y > a.y ? p : a));
    if (near.x < 20 || near.y < 120 || near.x > map.getCanvas().clientWidth - 20) continue;
    if (document.elementFromPoint(Math.round(near.x), Math.round(near.y))?.tagName !== 'CANVAS') continue;
    seen.add(id);
    picks.push({ x: Math.round(near.x), y: Math.round(near.y) });
  }
  picks.sort((a, b) => a.y - b.y);
  const buckets = new Map();
  for (const pick of picks) {
    const bucket = Math.floor(pick.y / 50) * 50;
    if (!buckets.has(bucket)) buckets.set(bucket, pick);
  }
  let block = null, empty = null;
  for (let y = 200; y <= 700 && (!block || !empty); y += 15) {
    for (let x = 200; x <= map.getCanvas().clientWidth - 40 && (!block || !empty); x += 15) {
      if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
      if (map.queryRenderedFeatures(box({ x, y }, 2), { layers }).length) block ??= { x, y };
      else empty ??= { x, y };
    }
  }
  return { picks: [...buckets.values()], block, empty };
});

test('blocks answer the pointer: hover cursor, Escape dismissal and clearance on small screens', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openMap(page);
  const desktop = await blockPicks(page);
  expect(desktop.picks.length).toBeGreaterThan(6);
  const cursor = () => page.evaluate(() => document.querySelector('#map canvas').style.cursor);
  await page.mouse.move(desktop.block.x, desktop.block.y);
  await page.waitForTimeout(250);
  expect(await cursor()).toBe('pointer');
  await page.mouse.move(desktop.empty.x, desktop.empty.y);
  await page.waitForTimeout(250);
  expect(await cursor()).toBe('grab');
  await page.mouse.click(desktop.block.x, desktop.block.y);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).length;
  }), { timeout: 5000 }).toBe(0);
  expect(await page.evaluate(() => document.body.dataset.card)).toBe('closed');
  // The cursor is scored against the frame that is on screen, so a camera move settling under a still pointer has to be
  // re-checked: panning clear of the snapshot leaves nothing clickable under that pixel any more.
  await page.mouse.move(desktop.block.x, desktop.block.y);
  await page.waitForTimeout(250);
  expect(await cursor()).toBe('pointer');
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.jumpTo({ center: [113.55, 23.25] });
  });
  await page.waitForTimeout(300);
  expect(await cursor(), 'the cursor kept a stale hit after the camera moved under a still pointer').toBe('grab');
  await page.locator('#recenter-button').click();
  await settled(page);
  expect((await state(page)).error, 'a map data error banner would sit on top of the layout being measured').toBeNull();

  for (const viewport of [{ width: 390, height: 844 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    // A resize repaints one camera frame later, and queryRenderedFeatures only sees the frame that is on screen, so
    // picks taken before that land on empty ground once the map catches up.
    await page.waitForTimeout(500);
    await settled(page);
    const picks = (await blockPicks(page)).picks;
    expect(picks.length).toBeGreaterThan(3);
    const measured = [];
    for (const pick of picks) {
      await page.mouse.click(pick.x, pick.y);
      await page.waitForTimeout(350);
      const seat = await cardSeat(page);
      measured.push({ y: pick.y, ...seat, ...(await cardClearance(page)) });
    }
    console.log(JSON.stringify({ viewport, measured }));
    expect(measured.every(m => !m.noCard), `${viewport.width}x${viewport.height}: a block opened no card`).toBe(true);
    const hiding = measured.filter(m => m.hidden !== 0).map(m => m.label);
    expect(hiding, `${viewport.width}x${viewport.height}: a card covered the block it describes`).toEqual([]);
    expect(measured.every(m => m.offscreen === 0), `${viewport.width}x${viewport.height}: a card left the viewport`).toBe(true);
    expect(measured.every(m => m.attribution === 0), `${viewport.width}x${viewport.height}: a card covered the attribution`).toBe(true);
    expect(measured.every(m => m.clippedPct <= 8), `${viewport.width}x${viewport.height}: a card sat on a control`).toBe(true);
    expect(measured.every(m => !m.pillCovered || m.pillYielded), `${viewport.width}x${viewport.height}: a card covered the control pill without it stepping out`).toBe(true);
    expect(measured.some(m => m.pillCovered), `${viewport.width}x${viewport.height}: nothing exercised the pill yielding`).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('live three kilometer POIs, source cards, filtering and cached reopening', async ({page}) => {
  test.setTimeout(150000);
  let queries = 0;
  const responses = [], errors = [];
  page.on('pageerror', e=>errors.push(e.message));
  page.on('request', r=> {if(r.url().includes('/api/interpreter')) { queries++; expect(new URLSearchParams(r.postData()).get('data')).toContain('around:3000,23.109000,113.319130'); }});
  page.on('response', async r=> {if(r.url().includes('/api/interpreter') && r.ok()) {try {responses.push(await r.json());} catch {}}});
  await openMap(page);
  await page.locator('#places-toggle').click();
  await expect(page.locator('#poi-list .poi-item').first()).toBeVisible({ timeout: 70000 });
  await expect.poll(async () => (await state(page)).pois).toBeGreaterThan(0);
  // Regression: icon collision used to drop most markers (1 of 40 visible at overview), so a loaded place could not be clicked.
  await page.locator('#overview-button').click();
  await settled(page);
  const coverage = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const loaded = new Set(map.querySourceFeatures('neighborhood-pois').map(f=>f.properties.id));
    const rendered = new Set(map.queryRenderedFeatures({layers:['poi-markers']}).map(f=>f.properties.id));
    return { loaded: loaded.size, rendered: [...rendered].filter(id=>loaded.has(id)).length };
  });
  expect(coverage.loaded).toBeGreaterThan(0);
  expect(coverage.rendered / coverage.loaded).toBeGreaterThanOrEqual(0.9);
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.locator('#poi-list .poi-item').first().click();
  await expect(page.locator('.poi-card')).toBeVisible();
  const href = await page.locator('.osm-link').getAttribute('href');
  const [type,id] = new URL(href).pathname.slice(1).split('/');
  const source = responses.flatMap(r=>r.elements).find(e=>e.type===type && e.id===Number(id));
  expect(source).toBeTruthy();
  await expect(page.locator('.osm-link')).toHaveAttribute('rel', 'noopener noreferrer');
  const name = source.tags['name:zh'] || source.tags.name || source.tags['name:en'];
  if(name) await expect(page.locator('.poi-card h3')).toHaveText(name);
  await settled(page);
  await page.screenshot({path:'/tmp/canton-tower-card.png'});
  await page.locator('[aria-label="关闭地点卡片"]').click();
  await page.locator('[data-category="food"]').click();
  const baseline = queries;
  await page.locator('#close-places').click();
  await expect(page.locator('#poi-panel')).toBeHidden();
  await expect.poll(async () => (await state(page)).pois).toBe(0);
  await page.locator('#places-toggle').click();
  await expect(page.locator('[data-category="food"]')).toHaveAttribute('aria-pressed','true');
  expect(queries).toBe(baseline);
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.scene-intro')).toBeHidden();
  await page.locator('[data-category="all"]').click();
  await page.locator('#poi-list .poi-item').first().click();
  await expect(page.locator('.poi-card')).toBeVisible();
  await settled(page);
  const card = await page.locator('.maplibregl-popup-content').boundingBox();
  const header = await page.locator('.topbar').boundingBox();
  const controls = await page.locator('#view-controls').boundingBox();
  expect(card.y).toBeGreaterThan(header.y + header.height);
  expect(card.y + card.height).toBeLessThan(controls.y);
  await page.screenshot({path:'/tmp/canton-tower-mobile-card.png'});
  await page.keyboard.press('Escape');
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect(page.locator('#poi-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#poi-panel')).toBeHidden();
  await expect(page.locator('.scene-intro')).toBeVisible();
  await expect(page.locator('#places-toggle')).toBeFocused();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({queries,sourceCard:{type,id},errors}));
});

test('rate limits, loading filters, retry and empty state do not block the map', async ({page}) => {
  test.setTimeout(90000);
  let mode='failure', queries=0;
  await page.route('**/api/interpreter**', async route=> {queries++; await route.fulfill(mode==='failure'?{status:429,body:'Rate limited'}:{json:{elements:[]}});});
  await openMap(page);
  await page.locator('#places-toggle').click();
  await expect(page.locator('#retry-pois')).toBeVisible();
  await expect(page.locator('#poi-status')).toContainText('查询较频繁');
  await page.locator('[data-category="food"]').click();
  await expect(page.locator('#poi-status')).toContainText('查询较频繁');
  expect(queries).toBe(1);
  mode='empty';
  await page.locator('#retry-pois').click();
  await expect(page.locator('#poi-status')).toContainText('未查到');
  await expect(page.locator('#poi-count')).toHaveText('0 处');
  await expect(page.locator('#retry-pois')).toBeHidden();
  await page.locator('#close-places').click();
  await page.locator('#places-toggle').click();
  expect(queries).toBe(2);
  expect((await state(page)).tower).toBe(true);
});

test('short mobile screens keep long POI cards clear of navigation', async ({page}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/interpreter**', route => route.fulfill({ json: { elements: [{
    type: 'node', id: 1, lat: 23.109, lon: 113.31913,
    tags: { name: '小屏布局测试地点', amenity: 'cafe', 'addr:street': '阅江西路', 'addr:housenumber': '222', opening_hours: 'Mo-Fr 09:00-22:00; Sa-Su 10:00-23:00' },
  }] } }));
  await openMap(page);
  await page.locator('#places-toggle').click();
  await page.locator('#poi-list .poi-item').click();
  await settled(page);
  const popup = page.locator('.maplibregl-popup-content');
  const bounds = await popup.boundingBox();
  const header = await page.locator('.topbar').boundingBox();
  const controls = await page.locator('#view-controls').boundingBox();
  const clearsHeader = top => expect(top).toBeGreaterThan(header.y + header.height);
  clearsHeader(bounds.y);
  expect(bounds.y + bounds.height).toBeLessThan(controls.y);
  expect(await popup.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  try {
    await popup.evaluate(node => node.style.maxHeight = 'calc(31dvh - 37px)');
    const covered = await popup.boundingBox();
    expect(() => clearsHeader(covered.y)).toThrow();
  } finally {
    await popup.evaluate(node => node.style.removeProperty('max-height'));
  }
  clearsHeader((await popup.boundingBox()).y);
  await page.locator('.osm-link').scrollIntoViewIfNeeded();
  expect(await page.locator('.osm-link').evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  // Escape dismisses the topmost layer first: the open card, then the place drawer behind it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect(page.locator('#poi-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.scene-intro')).toBeVisible();
  await expect(page.locator('#poi-panel')).toBeHidden();
  await expect(page.locator('#places-toggle')).toBeFocused();
});

test('mobile attribution remains reachable above the place drawer', async ({page}) => {
  test.setTimeout(90000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/interpreter**', route => route.fulfill({ json: { elements: [
    { type: 'node', id: 1, lat: 23.109, lon: 113.31913, tags: { name: '署名布局测试地点', amenity: 'cafe' } },
  ] } }));
  await openMap(page);
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.locator('#recenter-button').click();
    await page.locator('#places-toggle').click();
    await page.locator('#poi-list .poi-item').click();
    await settled(page);
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    const toggle = page.locator('.maplibregl-ctrl-attrib-button');
    if (!await attribution.evaluate(node => node.classList.contains('maplibregl-compact-show'))) await toggle.click();
    for (const link of await page.locator('.maplibregl-ctrl-attrib-inner a').all()) await link.click({ trial: true });
    const credits = await attribution.boundingBox();
    const panel = await page.locator('#poi-panel').boundingBox();
    const controls = await page.locator('#view-controls').boundingBox();
    expect(credits.y + credits.height).toBeLessThan(panel.y);
    expect(credits.y).toBeGreaterThan(controls.y + controls.height);
    await page.screenshot({ path: `/tmp/canton-tower-attribution-${viewport.width}.png` });
    await toggle.click();
    await page.locator('#orbit-button').click();
    await page.locator('.maplibregl-ctrl-zoom-in').click();
    await expect(page.locator('#explore-button')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#places-toggle')).toBeFocused();
  }
});

test('landscape phones keep the tower, place list and camera controls usable', async ({page}) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/interpreter**', route => route.fulfill({ json: { elements: Array.from({ length: 12 }, (_, index) => ({
    type: 'node', id: index + 1, lat: 23.109, lon: 113.31913 + index * 0.00001,
    tags: { name: `横屏布局测试地点 ${index + 1}`, amenity: 'cafe', opening_hours: 'Mo-Su 09:00-22:00' },
  })) } }));
  await openMap(page);
  for (const viewport of [{ width: 844, height: 390 }, { width: 667, height: 375 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => (await state(page)).zoom).toBeLessThanOrEqual(14.4);
    await page.locator('#recenter-button').click();
    await settled(page);
    await page.screenshot({ path: `/tmp/canton-tower-landscape-${viewport.width}.png` });
    await page.locator('#overview-button').click();
    await settled(page);
    const bounds = await rangeBounds(page);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(viewport.width);
    expect(bounds.top).toBeGreaterThanOrEqual(60);
    expect(bounds.bottom).toBeLessThanOrEqual(viewport.height - 70);
    await page.locator('#recenter-button').click();
    await page.locator('#places-toggle').click();
    const list = page.locator('#poi-list');
    expect((await list.boundingBox()).height).toBeGreaterThan(80);
    // The loading/error strip stacks above the drawer, so it has to dock beside it instead of covering the filter row.
    await page.evaluate(() => {
      document.getElementById('map-error-text').textContent = '部分地图数据未能加载。若地图缺块，请检查网络后重新加载。';
      document.getElementById('map-error').hidden = false;
    });
    const banner = await page.locator('#map-error').boundingBox();
    expect(banner.x + banner.width, `${viewport.width}x${viewport.height}: the error strip covers the place drawer`).toBeLessThanOrEqual((await page.locator('#poi-panel').boundingBox()).x);
    await page.evaluate(() => { document.getElementById('map-error').hidden = true; });
    await list.locator('.poi-item').last().click();
    await settled(page);
    await expect(page.locator('.poi-card h3')).toHaveText('横屏布局测试地点 12');
    await expect(page.locator('.scene-intro')).toBeHidden();
    const card = await page.locator('.maplibregl-popup-content').boundingBox();
    const header = await page.locator('.topbar').boundingBox();
    const controls = await page.locator('#view-controls').boundingBox();
    const panel = await page.locator('#poi-panel').boundingBox();
    expect(card.y).toBeGreaterThan(header.y + header.height);
    expect(card.y + card.height).toBeLessThan(controls.y);
    expect(card.x + card.width).toBeLessThan(panel.x);
    await page.locator('.osm-link').scrollIntoViewIfNeeded();
    await page.locator('.osm-link').click({ trial: true });
    const attribution = page.locator('.maplibregl-ctrl-attrib');
    const toggle = page.locator('.maplibregl-ctrl-attrib-button');
    if (!await attribution.evaluate(node => node.classList.contains('maplibregl-compact-show'))) await toggle.click();
    for (const link of await page.locator('.maplibregl-ctrl-attrib-inner a').all()) await link.click({ trial: true });
    await page.screenshot({ path: `/tmp/canton-tower-landscape-card-${viewport.width}.png` });
    await toggle.click();
    await page.locator('#recenter-button').click();
    await expect(page.locator('.poi-card')).toHaveCount(0);
    await page.locator('#orbit-button').click();
    expect((await state(page)).zoom).toBeLessThanOrEqual(14.4);
    await page.locator('#explore-button').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.scene-intro')).toBeVisible();
  }
  expect(errors).toEqual([]);
});

const hashOf = (page) => page.evaluate(() => location.hash);
// A goto whose URL differs only by the hash is a same-document navigation, and only a fresh load reads a shared link.
const visit = async (page, fragment) => {
  await page.goto(`${appUrl}${fragment}`);
  await page.reload();
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await expect.poll(async () => (await state(page)).buildings, { timeout: 30000 }).toBeGreaterThan(0);
};
const cameraOf = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const center = neighborhood.map.getCenter();
  return { zoom: neighborhood.map.getZoom(), lng: center.lng, lat: center.lat, bearing: neighborhood.map.getBearing(), pitch: neighborhood.map.getPitch() };
});

const searchView = (page) => page.evaluate(() => ({
  status: document.getElementById('search-status').textContent,
  rows: [...document.getElementById('search-results').children].map(node => node.textContent),
  chosen: [...document.getElementById('search-results').children].filter(node => node.hasAttribute('chosen')).length,
  active: document.getElementById('search-input').getAttribute('aria-activedescendant'),
  expanded: document.getElementById('search-input').getAttribute('aria-expanded'),
}));

// The search sheet is the one overlay that can be open beside the place drawer, the control pill and the zoom stack at
// once. What matters is that the row list still has height, that nothing it overlaps is still visible, and that the
// credits — which are the attribution rather than a control — never have to step out.
const searchClearance = (page) => page.evaluate(async () => {
  const panel = document.getElementById('search-panel').getBoundingClientRect();
  const list = document.getElementById('search-results');
  const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
  const cross = (a, b) => area({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  let covered = 0;
  for (const selector of ['#view-controls', '.maplibregl-ctrl-group', '.maplibregl-ctrl-scale']) {
    const node = document.querySelector(selector);
    const rect = node?.getBoundingClientRect();
    if (!rect?.width || !rect?.height || getComputedStyle(node).opacity === '0') continue;
    covered += cross(panel, rect);
  }
  const credits = document.querySelector('.maplibregl-ctrl-attrib')?.getBoundingClientRect();
  return {
    listHeight: list.clientHeight,
    rows: list.children.length,
    covered: Math.round(covered),
    credits: credits ? { visible: getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib')).opacity !== '0', overlap: Math.round(cross(panel, credits)) } : null,
    offscreen: Math.round(area(panel) - area({ left: Math.max(panel.left, 0), top: Math.max(panel.top, 0), right: Math.min(panel.right, innerWidth), bottom: Math.min(panel.bottom, innerHeight) })),
  };
});

test('searching a name or an address flies to the block and opens its card', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  let queries = 0, indexes = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/interpreter')) queries++;
    if (request.url().includes('canton-buildings-index.json')) indexes++;
  });
  await openMap(page);
  await expect(page.locator('#search-toggle')).toBeEnabled();
  await page.locator('#search-toggle').click();
  await expect(page.locator('#search-panel')).toBeVisible();
  await expect(page.locator('#search-input')).toBeFocused();
  expect((await searchView(page)).rows).toEqual([]);
  // One lazy request for the whole snapshot index, and the tower's own result line has to say the tower mesh is a
  // model rather than print an OSM height it does not have.
  await page.locator('#search-input').fill('广州塔');
  await expect.poll(async () => (await searchView(page)).rows.length, { timeout: 20000 }).toBeGreaterThan(0);
  expect(indexes).toBe(1);
  expect(queries, 'a search must not touch Overpass').toBe(0);
  const first = (await searchView(page)).rows[0];
  expect(first).toContain('三维示意塔身');
  expect(first).toContain('距广州塔 0 m');
  expect(first).not.toMatch(/高 \d+ m/);
  await page.locator('#search-input').press('ArrowDown');
  expect((await searchView(page)).active).toBe('search-option-0');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('.maplibregl-popup h3')).toHaveText('广州塔', { timeout: 15000 });
  expect((await searchView(page)).chosen).toBe(1);
  // The highlight volume is the picked block's own geometry, and the tower is drawn at the mesh height of 450 m, so
  // volume plus title together prove the anchor landed on the block the result row named.
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).map(f => f.properties.height);
  })).toEqual([450]);
  expect(await hashOf(page)).toContain('&b=584204634@');
  await page.screenshot({ path: '/tmp/canton-tower-search.png' });
  // The index stays cached behind a second query, and a door number is matched from the address fields.
  await page.locator('#search-input').fill('795');
  await expect.poll(async () => (await searchView(page)).rows.length).toBeGreaterThan(0);
  expect(indexes, 'the index must stay in memory between queries').toBe(1);
  expect((await searchView(page)).rows[0], 'a housenumber that carries its own suffix must not gain a second one').toContain('滨江东路 795号');
  expect((await searchView(page)).rows[0]).toMatch(/高(约)? \d+ m|高度未标注/);
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('.maplibregl-popup h3')).toContainText('亚朵', { timeout: 15000 });
  await page.locator('.maplibregl-popup-close-button').click();
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await page.locator('#search-input').fill('不存在的楼名XYZ');
  expect((await searchView(page))).toMatchObject({ rows: [], active: null, expanded: 'false' });
  expect((await searchView(page)).status).toContain('没有匹配');
  await page.keyboard.press('Escape');
  expect((await searchView(page)).status).toBe('');
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-panel')).toBeHidden();
  await expect(page.locator('#search-toggle')).toBeFocused();
  expect((await state(page)).error).toBeNull();

  for (const viewport of [{ width: 390, height: 844 }, { width: 568, height: 320 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(400);
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('赤岗');
    await expect.poll(async () => (await searchView(page)).rows.length).toBeGreaterThan(0);
    for (const drawer of [false, true]) {
      if (drawer) {
        await page.locator('#places-toggle').click();
        await expect(page.locator('#poi-list .poi-item').first()).toBeVisible({ timeout: 70000 });
        await page.locator('#search-input').fill('赤岗');
      }
      await page.waitForTimeout(400);
      const where = `${viewport.width}x${viewport.height} drawer=${drawer}`;
      const clearance = await searchClearance(page);
      console.log(JSON.stringify({ where, ...clearance }));
      expect(clearance.rows, `${where}: the result list rendered no rows`).toBeGreaterThan(0);
      expect(clearance.listHeight, `${where}: the result list collapsed`).toBeGreaterThan(28);
      expect(clearance.covered, `${where}: the sheet sits on a control that is still visible`).toBe(0);
      expect(clearance.offscreen, `${where}: the sheet left the viewport`).toBe(0);
      expect(clearance.credits.visible, `${where}: the credits were faded away`).toBe(true);
      expect(clearance.credits.overlap, `${where}: the sheet covered the credits`).toBe(0);
    }
    await page.locator('#places-toggle').click();
    await page.locator('#search-toggle').click();
  }
  expect(errors).toEqual([]);
});

test('the address bar carries the camera and the selected block to the next visitor', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__hashWrites = 0;
    const write = history.replaceState.bind(history);
    history.replaceState = (...args) => { window.__hashWrites++; return write(...args); };
  });
  await openMap(page);
  await page.locator('#explore-button').click();
  await settled(page);
  expect(await hashOf(page)).toMatch(/^#map=(-?\d+(\.\d+)?)\/(-?\d+(\.\d+)?)\/(-?\d+(\.\d+)?)\/(-?\d+(\.\d+)?)\/(-?\d+(\.\d+)?)$/);
  const shared = await hashOf(page);
  const written = Number(await page.evaluate(() => window.__hashWrites));
  // Orbit rewrites the camera every frame and replaceState is rate limited, so the bar only follows a camera that
  // stopped somewhere: entering the orbit re-seats it once, which is one write, and nothing is written while it spins.
  await page.locator('#orbit-button').click();
  await page.waitForTimeout(300);
  const seated = await hashOf(page);
  expect(seated).not.toBe(shared);
  await page.waitForTimeout(3000);
  expect(Number(await page.evaluate(() => window.__hashWrites)) - written, 'orbit hammered the address bar').toBeLessThan(4);
  expect(await hashOf(page), 'the address bar chased the spinning camera').toBe(seated);
  await page.locator('#explore-button').click();
  await settled(page);
  const orbited = await hashOf(page);
  expect(orbited).not.toBe(seated);
  expect(Math.abs(Number(orbited.split('/')[3]))).toBeLessThanOrEqual(180);

  const picks = await blockPicks(page);
  expect(picks.block, 'no block was clickable at the orbit-rested camera').toBeTruthy();
  await page.mouse.click(picks.block.x, picks.block.y);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(1);
  const title = await page.locator('.maplibregl-popup h3').textContent();
  const link = await hashOf(page);
  expect(link).toMatch(/^#map=.+&b=\d+@-?\d+\.\d+,-?\d+\.\d+$/);
  await visit(page, link);
  await expect(page.locator('.maplibregl-popup h3'), 'the shared block opened no card on the second visit').toHaveText(title, { timeout: 20000 });
  const restored = await cameraOf(page);
  const [zoom, lat, lng, bearing, pitch] = link.replace(/^#map=/, '').split('&')[0].split('/').map(Number);
  const selected = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).length;
  });
  expect(selected, 'the second visit highlighted nothing').toBe(1);
  expect(restored.zoom).toBeCloseTo(zoom, 1);
  expect(restored.lat).toBeCloseTo(lat, 3);
  expect(restored.lng).toBeCloseTo(lng, 3);
  expect(Math.abs(((restored.bearing - bearing + 540) % 360) - 180)).toBeLessThan(1);
  expect(Math.abs(restored.pitch - pitch)).toBeLessThan(1);
  // Loading a link normalizes the bar before the delayed pick lands, so this is the proof that a visitor who copies the
  // address bar again still gets the block, not just the camera.
  await expect.poll(async () => hashOf(page), { timeout: 20000 }).toContain(`&b=${link.split('&b=')[1]}`);
  await page.screenshot({ path: '/tmp/canton-tower-shared-camera.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  expect(await hashOf(page)).not.toContain('&b=');
  expect(await hashOf(page)).toContain('#map=');

  // A hand-written link that names the tower is the one a person would actually send, so it has to restore the same card
  // a click opens rather than only the camera.
  await visit(page, '#map=15.5/23.109/113.31913/-25/62&b=584204634@23.109013,113.319146');
  await expect(page.locator('.maplibregl-popup h3'), 'a hand-written tower link opened no card').toHaveText('广州塔', { timeout: 20000 });
  expect(await hashOf(page)).toContain('&b=584204634@');
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).map(f => f.properties.height);
  })).toEqual([450]);
  await page.screenshot({ path: '/tmp/canton-tower-shared-link.png' });

  // A link from another city is ignored rather than clamped, so it still lands on the tower.
  await visit(page, '#map=16/52.52/13.405&b=1@52.52,13.405');
  await settled(page);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  const hero = await cameraOf(page);
  expect(Math.abs(hero.lat - 23.109) < 0.01 && Math.abs(hero.lng - 113.31913) < 0.01).toBe(true);
  expect(await hashOf(page)).not.toContain('52.52');
  // A block that is not in the snapshot ends the retry loop quietly: no card, no highlight, no banner. The bar is
  // normalized the moment the map loads, so the retry loop itself is what has to be watched here.
  await visit(page, '#map=16/23.109/113.31913&b=999999999@23.109,113.31913');
  await expect.poll(async () => (await state(page)).buildings, { timeout: 30000 }).toBeGreaterThan(0);
  await page.waitForTimeout(10000);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  expect(await hashOf(page)).not.toContain('999999999');
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

test('atmosphere presets change the scene without losing the camera, search or selection', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  page.on('request', request => { if (/\/data\/|\/styles\/liberty|\/api\/interpreter/.test(request.url())) requests.push(request.url()); });
  await openMap(page);
  const palette = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const water = map.getStyle().layers.find(layer => layer.type === 'fill' && layer['source-layer'] === 'water');
    return { water: map.getPaintProperty(water.id, 'fill-color'), sky: map.getSky()['sky-color'], light: map.getLight().color,
      pedestrianPattern: map.getPaintProperty('road_area_pattern', 'fill-pattern') ?? null,
      buildings: map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color'),
      overview: map.getPaintProperty('neighborhood-buildings-overview', 'fill-extrusion-color'),
      legend: getComputedStyle(document.querySelector('#building-legend .commercial')).backgroundColor };
  });
  const day = await palette();
  await page.screenshot({ path: '/tmp/canton-atmosphere-day.png' });
  await page.locator('[data-atmosphere-option="sunset"]').click();
  await settled(page);
  expect(await palette()).toMatchObject({ water: '#a98c9c', sky: '#a099b6', light: '#ffd2a2', legend: 'rgb(206, 152, 126)' });
  await page.screenshot({ path: '/tmp/canton-atmosphere-sunset.png' });
  await page.locator('[data-atmosphere-option="night"]').click();
  await settled(page);
  const night = await palette();
  expect(night).toMatchObject({ water: '#102d46', sky: '#0b162c', light: '#c3d8fc', legend: 'rgb(96, 122, 151)', pedestrianPattern: null });
  expect(night.buildings).toEqual(night.overview);
  expect(night.buildings).not.toEqual(day.buildings);
  await page.screenshot({ path: '/tmp/canton-atmosphere-night.png' });
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('广州图书馆');
  await expect(page.locator('#search-results li').first()).toContainText('广州图书馆');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('.building-card h3')).toHaveText('广州图书馆');
  await settled(page);
  const selection = await page.locator('.building-card').textContent();
  const hash = await page.evaluate(() => location.hash);
  const camera = await state(page);
  const count = requests.length;
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.atmosphereSource = neighborhood.map.getSource('canton-buildings');
  });
  for (const id of ['day', 'sunset', 'night', 'sunset', 'day']) {
    await page.locator(`[data-atmosphere-option="${id}"]`).click();
    await settled(page);
    await expect(page.locator('body')).toHaveAttribute('data-atmosphere', id);
    await expect(page.locator('#atmosphere-controls [aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator(`[data-atmosphere-option="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.building-card').textContent()).toBe(selection);
    expect(await page.evaluate(() => location.hash)).toBe(hash);
    await expect(page.locator('#search-input')).toHaveValue('广州图书馆');
    expect(await state(page)).toEqual(camera);
  }
  expect(await palette()).toEqual(day);
  expect(requests.length).toBe(count);
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.getSource('canton-buildings') === window.atmosphereSource;
  })).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-atmosphere-option="night"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('body')).toHaveAttribute('data-atmosphere', 'night');
  expect((await palette()).water).toBe('#102d46');
  const contrast = await page.evaluate(() => {
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const card = document.querySelector('.maplibregl-popup-content');
    const bg = luminance(getComputedStyle(card).backgroundColor);
    return [...card.querySelectorAll('h3, p, small, a')].map(node => { const fg = luminance(getComputedStyle(node).color); return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05); });
  });
  expect(Math.min(...contrast), 'night card text remains readable').toBeGreaterThanOrEqual(4.5);
  expect(errors).toEqual([]);
});

test('atmosphere controls remain reachable with both panels on narrow screens', async ({ page }) => {
  test.setTimeout(120000);
  await page.route('**/api/interpreter**', route => route.fulfill({ json: { elements: [] } }));
  await openMap(page);
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    if (await page.locator('#search-panel').isVisible()) await page.locator('#search-toggle').click();
    if (await page.locator('#poi-panel').isVisible()) await page.locator('#close-places').click();
    await page.locator('#recenter-button').click();
    await settled(page);
    await page.locator('[data-atmosphere-option="night"]').click();
    await settled(page);
    await page.screenshot({ path: `/tmp/canton-atmosphere-night-${viewport.width}.png` });
    await page.locator('#places-toggle').click();
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('广州');
    await expect(page.locator('#search-results li').first()).toBeVisible();
    for (const id of ['day', 'sunset', 'night']) {
      await page.locator(`[data-atmosphere-option="${id}"]`).click();
      await expect(page.locator('body')).toHaveAttribute('data-atmosphere', id);
    }
    const layout = await page.evaluate(() => {
      const box = document.querySelector('#atmosphere-controls').getBoundingClientRect();
      const overlap = rect => Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left)) * Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
      return {
        offscreen: box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight,
        overlaps: ['.brand', '.topbar-actions', '#search-panel', '#poi-panel', '.maplibregl-ctrl-attrib'].map(selector => overlap(document.querySelector(selector).getBoundingClientRect())),
        scroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(layout, `${viewport.width}x${viewport.height}`).toEqual({ offscreen: false, overlaps: [0, 0, 0, 0, 0], scroll: false });
  }
});

const tourCamera = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), moving: map.isMoving() };
});
const tourStops = [
  ['广州塔', [113.31913, 23.109], -25],
  ['海心桥', [113.314334, 23.1110888], 35],
  ['花城广场', [113.319181, 23.122579], 180],
  ['广州图书馆', [113.3206608, 23.1189093], 35],
];
async function atTourStop(page, index) {
  await expect(page.locator('#tour-title')).toHaveText(tourStops[index][0], { timeout: 12000 });
  await expect.poll(async () => (await tourCamera(page)).moving).toBe(false);
  const camera = await tourCamera(page);
  camera.center.forEach((coordinate, axis) => expect(coordinate).toBeCloseTo(tourStops[index][1][axis], 5));
  expect(Math.abs(((camera.bearing - tourStops[index][2] + 540) % 360) - 180)).toBeLessThan(0.01);
  await expect(page.locator('#tour-route [aria-current="step"]')).toHaveText(tourStops[index][0]);
}

test('guided tour plays four real stops and finishes without a reset or extra data queries', async ({ page }) => {
  test.setTimeout(100000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openMap(page);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.tourBuildingSource = neighborhood.map.getSource('canton-buildings');
  });
  page.on('request', request => { if (/\/data\/|\/styles\/liberty|\/api\/interpreter/.test(request.url())) requests.push(request.url()); });
  await page.locator('#tour-start').click();
  await expect(page.locator('#tour-play')).toBeFocused();
  for (const selector of ['.scene-intro', '.scene-key', '#view-controls', '.topbar-actions', '.gesture-hint']) await expect(page.locator(selector)).toBeHidden();
  await expect(page.locator('#tour-route li')).toHaveCount(4);
  for (let index = 0; index < 4; index++) {
    await atTourStop(page, index);
    await settled(page);
    await expect(page.locator('.tour-marker')).toHaveCount(1);
    await expect(page.locator('.tour-marker')).toContainText(tourStops[index][0]);
    await page.screenshot({ path: `/tmp/canton-tour-stop-${index}.png` });
  }
  await expect(page.locator('#tour-player')).toBeHidden({ timeout: 10000 });
  const last = await tourCamera(page);
  expect(last.center[0]).toBeCloseTo(tourStops[3][1][0], 5);
  expect(last.center[1]).toBeCloseTo(tourStops[3][1][1], 5);
  await expect(page.locator('#tour-start')).toBeFocused();
  await expect(page.locator('#view-controls')).toBeVisible();
  await expect(page.locator('.tour-marker')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return window.tourBuildingSource === neighborhood.map.getSource('canton-buildings');
  })).toBe(true);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('guided tour pauses in flight and yields to Escape, gestures, keyboard and the background', async ({ page }) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openMap(page);
  await page.locator('#orbit-button').click();
  await page.locator('#tour-start').click();
  await expect.poll(async () => (await tourCamera(page)).moving).toBe(true);
  await page.locator('#tour-play').click();
  await expect(page.locator('#tour-play')).toHaveText('继续');
  const paused = await tourCamera(page);
  expect(paused.moving).toBe(false);
  await page.waitForTimeout(7500);
  expect(await tourCamera(page)).toEqual(paused);
  await expect(page.locator('#tour-title')).toHaveText('广州塔');
  await page.locator('#tour-play').click();
  await atTourStop(page, 0);
  await page.locator('#tour-next').click();
  await atTourStop(page, 1);
  await page.locator('#tour-play').click();
  await page.locator('[data-atmosphere-option="night"]').click();
  await expect(page.locator('#tour-title')).toHaveText('海心桥');
  await expect(page.locator('#tour-status')).toHaveText('已暂停');
  await page.keyboard.press('Escape');
  await expect(page.locator('#tour-player')).toBeHidden();
  await expect(page.locator('#view-controls')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-atmosphere', 'night');
  for (const gesture of ['drag', 'wheel', 'keyboard', 'background']) {
    await page.locator('#tour-start').click();
    await expect(page.locator('#tour-player')).toBeVisible();
    if (gesture === 'drag') {
      await page.mouse.move(400, 350); await page.mouse.down();
      await page.mouse.move(510, 390, { steps: 8 }); await page.mouse.up();
    } else if (gesture === 'wheel') {
      await page.mouse.move(400, 350); await page.mouse.wheel(0, 80);
    } else if (gesture === 'keyboard') {
      await page.locator('.maplibregl-canvas').focus();
      await page.keyboard.press('ArrowRight');
    } else {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.hidden;
      });
    }
    await expect(page.locator('#tour-player')).toBeHidden();
    await expect(page.locator('.tour-marker')).toHaveCount(0);
  }
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('广州图书馆');
  await page.locator('#search-results li').first().click();
  await expect(page.locator('.building-card h3')).toHaveText('广州图书馆', { timeout: 15000 });
  await page.locator('#search-input').press('Escape');
  await page.locator('#search-input').press('Escape');
  await page.locator('#tour-start').click();
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash.includes('&b='))).toBe(false);
  await page.locator('#tour-exit').click();
  expect(errors).toEqual([]);
});

test('guided tour keeps all stops clear on narrow screens and defaults to manual with reduced motion', async ({ page }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  for (const [width, height] of [[320, 568], [390, 844], [568, 320], [844, 390], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#tour-start').click();
    await expect(page.locator('#tour-play')).toHaveText('继续');
    await expect(page.locator('#tour-previous')).toBeDisabled();
    for (let index = 0; index < 4; index++) {
      await atTourStop(page, index);
      await settled(page);
      const layout = await page.evaluate(() => {
        const player = document.querySelector('#tour-player').getBoundingClientRect();
        const marker = document.querySelector('.tour-marker').getBoundingClientRect();
        const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const rects = [...document.querySelectorAll('.brand, #atmosphere-controls, .maplibregl-ctrl-attrib')].map(node => node.getBoundingClientRect());
        const outside = r => Math.max(0, -r.left, -r.top, r.right - innerWidth, r.bottom - innerHeight);
        return { overflow: document.documentElement.scrollWidth > innerWidth, outside: Math.max(outside(player), outside(marker)), covered: Math.max(...rects.map(r => overlap(player, r))), markerCovered: Math.max(...[...rects, player].map(r => overlap(marker, r))), playerHeight: player.height };
      });
      expect(layout.overflow).toBe(false);
      expect(layout.outside, `${width}x${height} stop ${index}`).toBe(0);
      expect(layout.covered, `${width}x${height} stop ${index}`).toBe(0);
      expect(layout.markerCovered, `${width}x${height} stop ${index}`).toBe(0);
      if (width === 320) expect(layout.playerHeight).toBeLessThan(180);
      if (index === 0) await page.screenshot({ path: `/tmp/canton-tour-mobile-${width}.png` });
      if (index < 3) await page.locator('#tour-next').click();
    }
    await page.locator('#tour-previous').click();
    await atTourStop(page, 2);
    await page.locator('#tour-next').click();
    await atTourStop(page, 3);
    await expect(page.locator('#tour-next')).toHaveText('完成导览');
    await page.locator('#tour-next').click();
    await expect(page.locator('#tour-player')).toBeHidden();
    await expect(page.locator('.scene-intro')).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#tour-start').click();
  await page.locator('#tour-next').click();
  await atTourStop(page, 1);
  const portrait = await tourCamera(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await atTourStop(page, 1);
  await expect(page.locator('#tour-play')).toHaveText('继续');
  await expect.poll(async () => (await tourCamera(page)).zoom).not.toBeCloseTo(portrait.zoom, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await atTourStop(page, 1);
  await expect.poll(async () => (await tourCamera(page)).zoom).toBeCloseTo(portrait.zoom, 3);
  await page.locator('#tour-exit').click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#tour-start').click();
  await atTourStop(page, 0);
  const playingPortrait = await tourCamera(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await expect.poll(async () => (await tourCamera(page)).zoom).not.toBeCloseTo(playingPortrait.zoom, 1);
  await atTourStop(page, 0);
  await expect(page.locator('#tour-play')).toHaveText('暂停');
  await page.locator('#tour-exit').click();
});

test('five minutes of repeated tower camera and layer interactions', async ({page}) => {
  test.setTimeout(400000);
  const errors=[];
  let queries=0;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=> {if(r.url().includes('/api/interpreter')) queries++;});
  await page.route('**/api/interpreter**',route=>route.fulfill({json:{elements:[{type:'node',id:1,lat:23.109,lon:113.31913,tags:{name:'测试地点',amenity:'cafe'}}]}}));
  await openMap(page);
  await page.locator('#places-toggle').click();
  await expect(page.locator('#poi-list .poi-item')).toBeVisible();
  const baseline=queries;
  const report=await page.evaluate(async()=> {
    const {neighborhood}=await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const samples=[];let last,raf,actions=0;
    const frame=t=>{if(last!==undefined)samples.push(t-last);last=t;raf=requestAnimationFrame(frame);};
    raf=requestAnimationFrame(frame);
    const start=performance.now(),startHeap=performance.memory?.usedJSHeapSize;
    const operation=()=>{
      const step=actions++%6;
      if(step===0)document.getElementById('orbit-button').click();
      if(step===1){document.getElementById('explore-button').click();neighborhood.map.easeTo({zoom:16.1,pitch:65,duration:700});}
      if(step===2)document.querySelector('[data-category="visit"]').click();
      if(step===3){document.querySelector('[data-category="all"]').click();document.getElementById('overview-button').click();}
      if(step===4)document.getElementById('places-toggle').click();
      if(step===5)document.getElementById('recenter-button').click();
    };
    operation();
    await new Promise(resolve=>{const timer=setInterval(()=>{if(performance.now()-start>=300000){clearInterval(timer);resolve();}else operation();},10000);});
    neighborhood.stopOrbit();cancelAnimationFrame(raf);samples.sort((a,b)=>a-b);
    return {elapsedMs:performance.now()-start,actions,frames:samples.length,frameP95Ms:samples[Math.floor(samples.length*.95)],frameP99Ms:samples[Math.floor(samples.length*.99)],longestFrameMs:samples.at(-1),startHeap,endHeap:performance.memory?.usedJSHeapSize};
  });
  expect(report.elapsedMs).toBeGreaterThanOrEqual(300000);
  expect(report.actions).toBeGreaterThanOrEqual(29);
  expect(report.frameP95Ms).toBeLessThan(100);
  expect(queries).toBe(baseline);
  expect(errors).toEqual([]);
  expect((await state(page)).buildings).toBeGreaterThan(0);
  await page.screenshot({path:'/tmp/canton-tower-soak.png'});
  console.log(JSON.stringify({...report,queriesDuringSoak:queries-baseline,errors}));
});

const lensLayers = ['neighborhood-buildings', 'neighborhood-buildings-overview', 'height-estimates', 'height-unknown'];
const lensHeightColor = ['case', ['==', ['get', 'heightSource'], 'estimate'], '#9fa9ad',
  ['step', ['get', 'height'], '#94c9c4', 20, '#529fac', 60, '#477aaf', 100, '#6965a6', 200, '#985d91']];
const lensFrame = (page) => page.evaluate(async (ids) => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  const layers = Object.fromEntries(ids.map(id => {
    const layer = map.getStyle().layers.find(layer => layer.id === id);
    const features = [...new Map(map.queryRenderedFeatures({ layers: [id] }).map(f => [f.properties.osmId, {
      osmId: f.properties.osmId, category: f.properties.category, source: f.properties.heightSource,
      height: f.properties.height, base: f.properties.base,
    }])).values()].sort((a, b) => a.osmId - b.osmId);
    return [id, { type: layer.type, visibility: layer.layout?.visibility ?? 'visible', paint: layer.paint, features }];
  }));
  return { lens: neighborhood.lens, layers, context: map.getLayoutProperty('context-buildings', 'visibility') ?? 'visible' };
}, lensLayers);

// Fixed published-snapshot expectations: never call heightSummary to derive the chart's own oracle.
async function expectLensChart(page, summary, sources, bins) {
  await expect(page.locator('#lens-summary')).toHaveText(summary);
  await expect(page.locator('#height-sources button span')).toHaveText(sources.map(n => n.toLocaleString('zh-CN')));
  await expect(page.locator('#height-chart .height-count')).toHaveText(bins.map(([height, levels]) => String(height + levels)));
  const labels = ['0–20', '20–60', '60–100', '100–200', '200+'];
  await expect(page.locator('#height-chart .height-label')).toHaveText(labels);
  expect(await page.locator('#height-chart li').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label'))))
    .toEqual(bins.map(([height, levels], i) => `${labels[i]} 米：OSM 标注 ${height}，按层数估算 ${levels}`));
}

async function expectLensFeatures(page, category = 'all', source = 'all') {
  await settled(page);
  const frame = await lensFrame(page);
  const groups = [
    ['height', [...frame.layers['neighborhood-buildings'].features, ...frame.layers['neighborhood-buildings-overview'].features]],
    ['levels', frame.layers['height-estimates'].features],
    ['estimate', frame.layers['height-unknown'].features],
  ];
  for (const [provenance, features] of groups) {
    if (source !== 'all' && source !== provenance) expect(features, `excluded ${provenance} still rendered`).toEqual([]);
    else {
      expect(features.length, `${category}/${provenance} rendered nothing`).toBeGreaterThan(0);
      expect([...new Set(features.map(f => f.source))]).toEqual([provenance]);
      if (category !== 'all') expect([...new Set(features.map(f => f.category))]).toEqual([category]);
    }
  }
  return frame;
}

async function expectUseLens(page) {
  await settled(page);
  await expect(page.locator('body')).toHaveAttribute('data-lens', 'use');
  await expect(page.locator('[data-lens-mode="use"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-lens-mode="height"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#height-panel')).toBeHidden();
  await expect(page.locator('#building-legend [aria-pressed="true"], #height-sources [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#lens-reset')).toBeDisabled();
  await expect(page.locator('#lens-summary')).toHaveText('全部用途 · 3,990 个要素');
  const frame = await lensFrame(page);
  expect(frame.lens).toEqual({ mode: 'use', category: 'all', source: 'all' });
  expect(frame.context).toBe('visible');
  for (const id of ['height-estimates', 'height-unknown']) {
    expect(frame.layers[id].visibility).toBe('none');
    expect(frame.layers[id].features).toEqual([]);
  }
  expect(frame.layers['neighborhood-buildings'].features.length + frame.layers['neighborhood-buildings-overview'].features.length).toBeGreaterThan(0);
  expect(frame.layers['neighborhood-buildings'].paint['fill-extrusion-color']).not.toEqual(lensHeightColor);
}

test('city lens: category toggles, full-snapshot bins and source intersections', async ({ page }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expectUseLens(page);
  for (const [category, label, count] of [['commercial', '商业办公', '282'], ['residential', '住宅', '1,415'], ['public', '公共设施', '236'], ['unknown', '未分类', '2,057']]) {
    const button = page.locator(`[data-building-category="${category}"]`);
    await button.click();
    await settled(page);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#building-legend [aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('#lens-summary')).toHaveText(`${label} · ${count} 个要素`);
    const frame = await lensFrame(page);
    const features = [...frame.layers['neighborhood-buildings'].features, ...frame.layers['neighborhood-buildings-overview'].features];
    expect(features.length).toBeGreaterThan(0);
    expect([...new Set(features.map(f => f.category))]).toEqual([category]);
    expect(frame.context).toBe('none');
    await button.click();
    await expectUseLens(page);
  }
  await page.locator('[data-building-category="residential"]').click();
  await page.locator('#lens-reset').click();
  await expectUseLens(page);
  await page.locator('[data-lens-mode="height"]').click();
  await expect(page.locator('#height-panel')).toBeVisible();
  await expect(page.locator('[data-lens-mode="height"]')).toHaveAttribute('aria-pressed', 'true');
  const allBins = [[1, 295], [7, 400], [5, 208], [22, 112], [19, 1]];
  await expectLensChart(page, '全部用途 · 3,990 个要素', [54, 1016, 2920], allBins);
  await expectLensFeatures(page);
  // A closer camera renders only part of the city, but the chart must still count the entire snapshot.
  await page.locator('#recenter-button').click();
  await settled(page);
  await expectLensChart(page, '全部用途 · 3,990 个要素', [54, 1016, 2920], allBins);
  await page.locator('#overview-button').click();
  await settled(page);
  await page.locator('[data-building-category="commercial"]').click();
  await page.locator('[data-height-source="height"]').click();
  await expectLensChart(page, '商业办公 · 23 个要素', [23, 139, 120], [[0, 0], [3, 0], [3, 0], [4, 0], [13, 0]]);
  await expectLensFeatures(page, 'commercial', 'height');
  await page.locator('[data-height-source="levels"]').click();
  await expect(page.locator('#height-sources [aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('[data-height-source="levels"]')).toHaveAttribute('aria-pressed', 'true');
  await expectLensChart(page, '商业办公 · 139 个要素', [23, 139, 120], [[0, 54], [0, 25], [0, 39], [0, 20], [0, 1]]);
  await expectLensFeatures(page, 'commercial', 'levels');
  await page.locator('[data-height-source="levels"]').click();
  await expect(page.locator('#height-sources [aria-pressed="true"]')).toHaveCount(0);
  await expectLensChart(page, '商业办公 · 282 个要素', [23, 139, 120], [[0, 54], [3, 25], [3, 39], [4, 20], [13, 1]]);
  await expectLensFeatures(page, 'commercial');
  await page.locator('[data-height-source="estimate"]').click();
  await expectLensChart(page, '商业办公 · 120 个要素', [23, 139, 120], Array.from({ length: 5 }, () => [0, 0]));
  await expectLensFeatures(page, 'commercial', 'estimate');
  await page.locator('#lens-reset').click();
  await expect(page.locator('body')).toHaveAttribute('data-lens', 'height');
  await expect(page.locator('#lens-reset')).toBeDisabled();
  await expect(page.locator('#building-legend [aria-pressed="true"], #height-sources [aria-pressed="true"]')).toHaveCount(0);
  await expectLensChart(page, '全部用途 · 3,990 个要素', [54, 1016, 2920], allBins);
  await expectLensFeatures(page);
});

test('city lens: height layers survive atmosphere and unknown footprints answer hover and click', async ({ page }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await page.locator('[data-lens-mode="height"]').click();
  const before = await expectLensFeatures(page);
  expect(before.context).toBe('none');
  for (const id of lensLayers.slice(0, 3)) {
    expect(before.layers[id].type).toBe('fill-extrusion');
    expect(before.layers[id].paint).toMatchObject({
      'fill-extrusion-color': lensHeightColor, 'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': id === 'height-estimates' ? 0.55 : 1,
    });
  }
  expect(before.layers['height-unknown']).toMatchObject({ type: 'fill', visibility: 'visible', paint: {
    'fill-color': '#9fa9ad', 'fill-opacity': 0.65, 'fill-outline-color': '#66777c',
  } });
  for (const atmosphere of ['sunset', 'night', 'day']) {
    await page.locator(`[data-atmosphere-option="${atmosphere}"]`).click();
    await expect(page.locator('body')).toHaveAttribute('data-atmosphere', atmosphere);
    await settled(page);
    const after = await lensFrame(page);
    expect(after.lens).toEqual(before.lens);
    for (const id of lensLayers) {
      expect(after.layers[id].features, `${atmosphere}: changed rendered heights`).toEqual(before.layers[id].features);
      for (const [property, value] of Object.entries(before.layers[id].paint)) expect(after.layers[id].paint[property], `${atmosphere}: ${id}/${property}`).toEqual(value);
    }
  }
  await page.locator('[data-height-source="estimate"]').click();
  await expectLensChart(page, '全部用途 · 2,920 个要素', [54, 1016, 2920], Array.from({ length: 5 }, () => [0, 0]));
  await expectLensFeatures(page, 'all', 'estimate');
  // Choose from this rendered frame, not a hard-coded coordinate or a direct selectFeature/setLens call.
  const picks = await page.evaluate(async (ids) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    let block = null, empty = null;
    for (let y = 200; y < innerHeight - 150 && (!block || !empty); y += 8) {
      for (let x = 380; x < innerWidth - 100 && (!block || !empty); x += 8) {
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        const hits = map.queryRenderedFeatures([[x - 2, y - 2], [x + 2, y + 2]], { layers: ['canton-tower-hit', ...ids] });
        if (!hits.length) empty ??= { x, y };
        else if (hits.every(f => f.layer.id === 'height-unknown')) block ??= { x, y, osmId: hits[0].properties.osmId };
      }
    }
    return { block, empty };
  }, lensLayers);
  expect(picks.block, 'no rendered unknown footprint was clickable').toBeTruthy();
  expect(picks.empty).toBeTruthy();
  await page.mouse.move(picks.empty.x, picks.empty.y);
  await expect(page.locator('#map canvas')).toHaveCSS('cursor', 'grab');
  await page.mouse.move(picks.block.x, picks.block.y);
  await expect(page.locator('#map canvas')).toHaveCSS('cursor', 'pointer');
  await page.mouse.click(picks.block.x, picks.block.y);
  await expect(page.locator('.building-card .osm-link')).toHaveAttribute('href', `https://www.openstreetmap.org/way/${picks.block.osmId}`);
  await expect(page.locator('.building-card')).toContainText('高度未知，此视图仅显示平面轮廓');
  await expect(page.locator('.building-card')).not.toContainText('默认 9.6 m');
  const flatSelection = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    return { type: map.getLayer('building-selection-flat').type, opacity: map.getPaintProperty('building-selection-flat', 'fill-opacity'),
      features: map.queryRenderedFeatures({ layers: ['building-selection-flat'] }).map(f => ({ height: f.properties.height, base: f.properties.base })) };
  });
  await expect.poll(flatSelection).toEqual({ type: 'fill', opacity: 0.5, features: [{ height: 0, base: 0 }] });
  await page.keyboard.press('Escape');
  await expect(page.locator('.building-card')).toHaveCount(0);
  await expect.poll(async () => (await flatSelection()).features).toEqual([]);
});

test('city lens: search and tour restore all uses without replacing or refetching the snapshot', async ({ page }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const snapshots = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/data/canton-buildings.geojson')) snapshots.push(request.url()); });
  await openMap(page);
  expect(snapshots).toHaveLength(1);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.lensBuildingSource = neighborhood.map.getSource('canton-buildings');
  });
  const expectCachedSource = async () => {
    expect(await page.evaluate(async () => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      return neighborhood.map.getSource('canton-buildings') === window.lensBuildingSource;
    }), 'lens interactions replaced the GeoJSON source object').toBe(true);
    expect(snapshots, 'lens interactions fetched the snapshot again').toHaveLength(1);
  };
  await page.locator('[data-lens-mode="height"]').click();
  await page.locator('[data-building-category="commercial"]').click();
  await page.locator('[data-height-source="height"]').click();
  await expectLensFeatures(page, 'commercial', 'height');
  await page.locator('[data-atmosphere-option="night"]').click();
  await expectCachedSource();
  // The snapshot records the library as unknown/levels, so both filters exclude it before the result is chosen.
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('广州图书馆');
  await expect(page.locator('#search-results li').first()).toContainText('广州图书馆');
  await page.locator('#search-results li').first().click();
  await expectUseLens(page);
  await expect(page.locator('.building-card h3')).toHaveText('广州图书馆', { timeout: 15000 });
  await expect(page.locator('.building-card .osm-link')).toHaveAttribute('href', 'https://www.openstreetmap.org/way/240896441');
  expect((await lensFrame(page)).layers['neighborhood-buildings'].features).toContainEqual(expect.objectContaining({
    osmId: 240896441, category: 'unknown', source: 'levels',
  }));
  await expectCachedSource();
  await page.locator('[aria-label="关闭建筑卡片"]').click();
  await page.locator('#search-toggle').click();
  await page.locator('[data-lens-mode="height"]').click();
  await page.locator('[data-building-category="residential"]').click();
  await page.locator('[data-height-source="estimate"]').click();
  await expectLensFeatures(page, 'residential', 'estimate');
  await page.locator('#tour-start').click();
  await expect(page.locator('#tour-player')).toBeVisible();
  await expect(page.locator('#tour-title')).toHaveText('广州塔');
  await expectUseLens(page);
  await expectCachedSource();
  await page.locator('#tour-exit').click();
  await expect(page.locator('#tour-player')).toBeHidden();
  await expectUseLens(page);
  await expectCachedSource();
});

test('city lens: panel and full radius stay clear across narrow screens', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await page.locator('[data-lens-mode="height"]').click();
  const measure = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { radiusPolygon } = await import('/src/geo.js');
    const rect = node => node.getBoundingClientRect();
    const panel = rect(document.querySelector('.scene-key'));
    const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const controls = [...document.querySelectorAll('.topbar button,.intro-actions button,.view-controls button,.maplibregl-ctrl-group button,.maplibregl-ctrl-attrib')].map(rect).filter(r => r.width && r.height);
    const points = radiusPolygon({ lat: 23.109, lng: 113.31913 }, 3000).geometry.coordinates[0].map(p => neighborhood.map.project(p));
    const ring = { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
    return { viewport: [innerWidth, innerHeight], panel: panel.toJSON(), ring, note: rect(document.querySelector('#building-note')).toJSON(), scrollWidth: document.documentElement.scrollWidth, overlaps: controls.map(c => overlap(panel, c)), ringPanel: overlap(panel, ring) };
  });
  function assertLayout(m) {
    const [w, h] = m.viewport;
    expect(m.scrollWidth).toBeLessThanOrEqual(w);
    expect(m.panel.left).toBeGreaterThanOrEqual(0);
    expect(m.panel.right).toBeLessThanOrEqual(w);
    expect(m.panel.top).toBeGreaterThanOrEqual(0);
    expect(m.panel.bottom).toBeLessThanOrEqual(h);
    expect(Math.max(...m.overlaps)).toBeLessThan(1);
    expect(m.ring.left).toBeGreaterThanOrEqual(0);
    expect(m.ring.right).toBeLessThanOrEqual(w);
    expect(m.ring.top).toBeGreaterThanOrEqual(100);
    expect(m.ring.bottom).toBeLessThanOrEqual(h);
    expect(m.ringPanel).toBeLessThan(1);
    expect(m.note.top).toBeGreaterThanOrEqual(m.panel.top);
    expect(m.note.bottom).toBeLessThanOrEqual(m.panel.bottom);
  }
  for (const [width, height] of [[1440, 960], [320, 568], [390, 844], [568, 320], [667, 375], [844, 390], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await page.locator('.scene-key').evaluate(node => node.scrollTop = 0);
    await page.locator('#overview-button').click();
    await settled(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assertLayout(await measure());
    await page.screenshot({ path: `/tmp/canton-lens-height-${width}.png` });
    for (const source of ['height', 'levels', 'estimate']) {
      await page.locator(`[data-height-source="${source}"]`).click();
      await expect(page.locator(`[data-height-source="${source}"]`)).toHaveAttribute('aria-pressed', 'true');
    }
    await page.locator('#lens-reset').click();
    if (width === 568) {
      await page.locator('.height-label').last().scrollIntoViewIfNeeded();
      await expect(page.locator('.height-label').last()).toBeInViewport();
      await page.locator('.maplibregl-ctrl-attrib a').last().click({ trial: true });
      await page.screenshot({ path: '/tmp/canton-lens-height-568-scrolled.png' });
    }
  }
  for (const css of [
    '.scene-key {top:20px !important;left:20px !important;bottom:auto !important;}',
    '.scene-key {left:-100px !important;}',
    '#building-note {transform:translateY(500px) !important;}',
  ]) {
    const style = await page.addStyleTag({ content: css });
    const bad = await measure();
    expect(() => assertLayout(bad)).toThrow();
    await style.evaluate(node => node.remove());
  }
  expect(errors).toEqual([]);
});

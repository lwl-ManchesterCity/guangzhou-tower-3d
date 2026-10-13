import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { livePlacesOrSkip, watchRemote } from './live-places.js';
import { LANDMARKS } from '../src/landmarks.js';
import { FORM_OSM_IDS } from '../src/landmark-forms.js';

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
// Measured: a style mutation only reaches the screen on the next render, and `settled` shortcuts whenever the map already
// reports itself loaded and unmoving - which is exactly how it reads a few milliseconds after an atmosphere switch. A
// baseline taken there is the frame from *before* it: the sheen's crests came back darker than bare water ([141,183,190]
// against [148,193,198]) and stayed that way, untouched, for over a second. Requesting a frame first makes the `idle`
// wait unconditional rather than conditional, and the byte assertions then hold on every run.
const repainted = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  await new Promise(resolve => { map.once('idle', resolve); map.triggerRepaint(); });
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
  // 底图那三族"把地下的东西画到地面上"的线层必须摘掉：隧道虚线、行政边界、水系中心线（用户 2026-10-09
  // 「别的地方也是，优化一下」；15.5 级机位扫过开阔水面，这三族分别压过 198 / 134 / 178 个采样点）。
  // 判据读样式不读像素，并且反着钉一道：桥上的路是看得见的实体，不能跟着一起摘。
  const styleLayers = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const layers = neighborhood.map.getStyle().layers;
    return {
      subsurface: layers.filter((l) => l.type === 'line' && /^(tunnel_|boundary_(2|3|disputed)$|waterway_(river|other|tunnel)$)/.test(l.id)).map((l) => l.id),
      water: layers.some((l) => l.type === 'fill' && l['source-layer'] === 'water'),
      waterName: layers.some((l) => l.type === 'symbol' && l.id === 'waterway_line_label'),
      bridge: layers.filter((l) => l.type === 'line' && l.id.startsWith('bridge_')).length,
    };
  });
  expect(styleLayers.subsurface, `这些层还在把地下的线画到地面上：${styleLayers.subsurface.join(', ')}`).toEqual([]);
  expect(styleLayers.water, '水面填充层没了，那上面那句是空的').toBe(true);
  expect(styleLayers.waterName, '珠江那三个字是名字不是线，不能跟着一起摘').toBe(true);
  expect(styleLayers.bridge, '桥上的路被一起摘掉了').toBeGreaterThan(0);
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
  // The clock has to cover the service's own worst case, not a hopeful average: `createPoiService` walks
  // `OVERPASS_ENDPOINTS` (two mirrors) with a 30 s abort each, so a slow first mirror legitimately spends 60 s before
  // the list can be painted - and this item also does an overview, a filter round and a cached reopening on top.
  // Measured on this machine: 1.3 min when it passes, and it red at 70 s whenever the first mirror is the slow one.
  test.setTimeout(240000);
  let queries = 0;
  const responses = [], errors = [];
  const remote = watchRemote(page);
  page.on('pageerror', e=>errors.push(e.message));
  page.on('request', r=> {if(r.url().includes('/api/interpreter')) { queries++; expect(new URLSearchParams(r.postData()).get('data')).toContain('around:3000,23.109000,113.319130'); }});
  page.on('response', async r=> {if(r.url().includes('/api/interpreter') && r.ok()) {try {responses.push(await r.json());} catch {}}});
  await openMap(page);
  await page.locator('#places-toggle').click();
  // This item needs the public Overpass mirrors: the query is a 3 km sweep and a mirror answers 504 now and then.
  // 服务坏了与界面坏了要分开：`livePlacesOrSkip` 只在量到外部签名（面板报「重新加载地点」或监听器记到
  // 5xx／请求失败）时 skip 并把理由打出来；服务答了 200 而列表是空的，仍然照红。
  await livePlacesOrSkip(page, remote, { label: 'live three kilometer POIs' });
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
  const remote = watchRemote(page);
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
        // 抽屉那一支要的是"列表里有人"，而数据来自公共 Overpass：镜像 504 时这一支会空。
        // 与 `live three kilometer POIs` 同一口径、同一个 helper：坏了 skip 并点名，服务正常而列表空着照红。
        await livePlacesOrSkip(page, remote, { label: 'search drawer places' });
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
  await switchAtmosphere(page, 'sunset');
  await settled(page);
  expect(await palette()).toMatchObject({ water: '#c98d5f', sky: '#a099b6', light: '#ffd2a2', legend: 'rgb(206, 152, 126)' });
  await page.screenshot({ path: '/tmp/canton-atmosphere-sunset.png' });
  await switchAtmosphere(page, 'night');
  await settled(page);
  const night = await palette();
  expect(night).toMatchObject({ water: '#0a1e30', sky: '#0b162c', light: '#c3d8fc', legend: 'rgb(44, 56, 70)', pedestrianPattern: null });
  expect(night.buildings).toEqual(night.overview);
  expect(night.buildings).not.toEqual(day.buildings);
  await page.screenshot({ path: '/tmp/canton-atmosphere-night.png' });
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('广州图书馆');
  await expect(page.locator('#search-results li').first()).toContainText('广州图书馆');
  await page.locator('#search-input').press('Enter');
  await expect(page.locator('.building-card h3')).toHaveText('广州图书馆');
  // Adjacency grouping is the school scene's own display rule: one block per card here, group lines or not.
  await expect(page.locator('.building-card')).not.toContainText('同组');
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
    await switchAtmosphere(page, id);
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
  expect((await palette()).water).toBe('#0a1e30');
  const contrast = await page.evaluate(() => {
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const card = document.querySelector('.maplibregl-popup-content');
    const bg = luminance(getComputedStyle(card).backgroundColor);
    return [...card.querySelectorAll('h3, p, small, a')].map(node => { const fg = luminance(getComputedStyle(node).color); return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05); });
  });
  expect(Math.min(...contrast), 'night card text remains readable').toBeGreaterThanOrEqual(4.5);
  expect(errors).toEqual([]);
});

// The recession is measured on the picture, not on the expression: the camera is pulled aside so the 3 km far field fills
// the top of the frame, then every 8th pixel is asked which block it landed on, so each sample carries its own ground
// distance. A band's mean colour is only ever compared with another band's, so a missing remote tile changes the sample
// counts and not the verdict.
const HAZE_BANDS = [[0, 700], [700, 1800], [1800, 2400], [2400, 3001]];
const hazeCells = (page, maxDistance = Infinity) => page.evaluate(async ({ step, maxDistance }) => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  // Panels and controls sit on top of the canvas, so a cell only counts if the map itself is what a click would hit.
  const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const hull = (points) => {
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper = [];
    for (const point of sorted.slice().reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  };
  const inside = (polygon, x, y) => {
    let crossed = false;
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index];
      const b = polygon[(index + 1) % polygon.length];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) crossed = !crossed;
    }
    return crossed;
  };
  // A cell is 6×6 pixels of picture, read from x+1..x+7, so the whole sampled square has to be clear of a shell, not
  // just its centre: the shells are drawn by three.js and never fogged, and since the night windows went up their peak
  // is luma 232. A cell whose centre fell just outside the hull still carried a strip of burning facade, and that strip
  // held the near band's mean in place while the fog lifted (measured 119.3 -> 118.6 against a >= 6 unit claim). The
  // threshold is untouched - this drops the contaminated cells, it does not relax what the survivors have to show.
  const touchesShell = (x, y) => [[x + 1, y + 1], [x + 7, y + 1], [x + 1, y + 7], [x + 7, y + 7], [x + 4, y + 4]]
    .some(([px, py]) => shells.some((shell) => inside(shell.polygon, px, py)));
  // Every landmark shell, as the area it covers on this screen: its footprint ring, and the same ring stood at its own
  // height. Those pixels are drawn by three.js, not by the haze ramp, so a cell that falls inside one is not evidence
  // about the ramp either way.
  const { FORM_OSM_IDS, LANDMARK_FORMS } = await import('/src/landmark-forms.js');
  const buildings = await (await fetch('/data/canton-buildings.geojson')).json();
  const bridge = await (await fetch('/data/haixin-bridge.geojson')).json();
  const shells = [];
  for (const feature of [...buildings.features, ...bridge.features]) {
    const form = LANDMARK_FORMS[feature.properties.osmId];
    if (!form) continue;
    const top = form.kind === 'deck' ? form.base + form.thickness
      : Number(feature.properties.displayHeight ?? feature.properties.height);
    const ring = feature.geometry.coordinates[0];
    const ground = ring.map(([lng, lat]) => { const point = map.project([lng, lat]); return [point.x, point.y]; });
    const raised = ring.map(([lng, lat]) => { const point = map.project([lng, lat], top); return [point.x, point.y]; });
    shells.push({ osmId: Number(feature.properties.osmId), polygon: hull(ground.concat(raised)) });
  }
  if (shells.length !== FORM_OSM_IDS.length)
    throw new Error(`${FORM_OSM_IDS.length} shells have a form, ${shells.length} have a ring on this screen`);
  const out = [];
  for (let y = 96; y < innerHeight - 130; y += step) for (let x = 380; x < innerWidth - 200; x += step) {
    if (!clear(x + 5, y + 5)) continue;
    // The invisible hit boxes of the shells are queried alongside the walls on purpose: a cell a shell stands in front
    // of has to be dropped by the `length !== 1` rule below, exactly as it was while these blocks were extrusions.
    const hit = map.queryRenderedFeatures([[x, y], [x, y]], { layers: ['neighborhood-buildings', 'landmark-forms-hit'] });
    if (hit.length !== 1) continue;
    if (touchesShell(x, y)) continue;
    const distance = Number(hit[0].properties.distance);
    if (distance <= maxDistance) out.push({ x, y, distance, osmId: String(hit[0].properties.osmId) });
  }
  return out;
}, { step: 8, maxDistance });

const bandStats = async (page, cells) => {
  const encoded = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ encoded, cells, bands, step }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const key = (cell) => `${cell.x},${cell.y}`;
    const at = new Map();
    for (const cell of cells) {
      let sum = [0, 0, 0], n = 0;
      for (let dy = 1; dy < step - 1; dy++) for (let dx = 1; dx < step - 1; dx++) {
        const i = ((cell.y + dy) * image.width + cell.x + dx) * 4;
        sum = sum.map((value, channel) => value + data[i + channel]); n++;
      }
      at.set(key(cell), sum.map((value) => value / n));
    }
    const delta = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
    const bandOf = (distance) => bands.find(([low, high]) => distance >= low && distance < high)?.join('-') ?? null;
    const rows = new Map();
    for (const cell of cells) {
      const band = bandOf(cell.distance);
      if (band) rows.set(band, [...(rows.get(band) ?? []), cell]);
    }
    const out = {};
    for (const [band, list] of rows) {
      // Adjacent blocks that render within a hair of each other are the same surface, so the step between neighbours is
      // how "逐栋分辨" gets counted without anyone eyeballing a screenshot.
      const byRow = new Map();
      for (const cell of list) byRow.set(cell.y, [...(byRow.get(cell.y) ?? []), cell]);
      const steps = [];
      for (const row of byRow.values()) {
        row.sort((a, b) => a.x - b.x);
        for (let i = 1; i < row.length; i++) {
          if (row[i].x - row[i - 1].x !== step || row[i].osmId === row[i - 1].osmId) continue;
          steps.push(delta(at.get(key(row[i - 1])), at.get(key(row[i]))));
        }
      }
      const mean = (values) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
      out[band] = { n: list.length, pairs: steps.length,
        rgb: [0, 1, 2].map((channel) => Math.round(mean(list.map((cell) => at.get(key(cell))[channel])))),
        stepMean: Math.round(mean(steps) * 10) / 10 };
    }
    return out;
  }, { encoded, cells, bands: HAZE_BANDS, step: 8 });
};

/**
 * The picture-level recession claim, in the one form that survives a grey-blue fog.
 *
 * It used to read "every band is paler than the last in every channel", and that held only because the day fog was
 * near-white in all three channels. The fog is now `#c8d4dc`, whose red sits *under* a brick block's own red, so a
 * wall loses red and gains blue as it recedes - and each band is sampled over its own mix of roofs, walls and ground,
 * which is not monotone in any single channel or in distance to the fog either (measured, the four bands sit 118.2,
 * 107.3, 119.4, 94.5 units from the fog: the third is further out than the second, because that band happens to hold
 * darker blocks). Per-step monotonicity was never a claim about air; it was a side effect of the fog being white.
 *
 * What is claimed, and what the ramp actually has to deliver on screen: the far end of the field is meaningfully
 * closer to the fog than the near end, it carries the fog's blue cast, and the per-step version of this is pinned
 * where it is unambiguous - in `tests/atmosphere.test.js`, which walks the expression itself across 1,440
 * distance/zoom/reveal/category combinations. The causal control below this helper (take the ramp out of the live
 * paint and watch the far band stop moving) is the part that proves the picture is painted by the haze.
 */
const fogRgb = (page) => page.evaluate(async () => {
  const { ATMOSPHERES } = await import('/src/atmosphere.js');
  return [1, 3, 5].map((at) => parseInt(ATMOSPHERES.day.sky['fog-color'].slice(at, at + 2), 16));
});
const fogYardsticks = async (page) => {
  const fog = await fogRgb(page);
  const away = (rgb) => Math.hypot(...rgb.map((value, channel) => value - fog[channel]));
  const cast = (rgb) => rgb[2] - rgb[0];
  return { away, cast };
};
const recessionMetrics = async (page, list) => {
  const { away, cast } = await fogYardsticks(page);
  return { recession: away(list[0].rgb) - away(list[3].rgb), cast: cast(list[3].rgb) - cast(list[0].rgb),
    distances: list.map((band) => Math.round(away(band.rgb) * 10) / 10) };
};
const assertRecedes = async (page, list, note) => {
  const steps = await recessionMetrics(page, list);
  expect(steps.recession, `${note}: the 3 km band is ${JSON.stringify(list.map(band => band.rgb))} at ${steps.distances}`).toBeGreaterThan(10);
  expect(steps.cast, `${note}: and carries none of the fog's blue cast (${steps.distances})`).toBeGreaterThan(10);
  return steps;
};

const hazeStatus = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return neighborhood.haze;
});
const moodStatus = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return neighborhood.atmosphere;
});
// An atmosphere switch is a 1.2 s walk now, and `settled` cannot see it - `loaded() && !isMoving()` holds for the whole
// way through - so a read taken right after a click lands on a frame of the transition. Every test that switches and
// then looks has to wait for the walk itself.
const moodSettled = (page) => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  while (neighborhood.atmosphere.running) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
});
const switchAtmosphere = async (page, id) => {
  await page.locator(`[data-atmosphere-option="${id}"]`).click();
  await moodSettled(page);
};

test('air perspective fades the far field into the theme fog and the opening lifts it', async ({ page }) => {
  // The 20 s ease this item restarts for its pixel claim is longer than the shipped one, on purpose: the frame and the
  // clock it is read against have to belong to the same frame.
  test.setTimeout(150000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await page.goto(appUrl);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  // The city opens under its own fog and the haze lifts over 1.5 s, so the page is caught mid-ease before anything else
  // is measured against the shipped palette.
  expect(await hazeStatus(page), 'the shipped load is inside the ease').toMatchObject({ running: true, ms: 1500, reveal: expect.any(Number) });
  await expect.poll(async () => (await hazeStatus(page)).running, { timeout: 15000 }).toBe(false);
  expect(await hazeStatus(page)).toEqual({ reveal: 0, running: false, ms: 1500 });
  await settled(page);
  // The ramp has to be installed, not just correct in Node: a `Style.addLayer` whose paint fails validation is dropped in
  // silence, with no throw and no console error, and the page then renders a flat map with an empty error list.
  const live = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { ATMOSPHERES, HAZE_REVEAL, SKY_BLEND, buildingAtmosphereColor, contextAtmosphereColor } = await import('/src/atmosphere.js');
    const { DEFAULT_CENTER } = await import('/src/config.js');
    const map = neighborhood.map;
    const order = map.getLayersOrder();
    // A dropped layer has no paint to read, so a vanished one reports as `false` in the assertion diff instead of
    // throwing from inside MapLibre and hiding which of the three disappeared.
    const paint = (id) => (order.includes(id) ? map.getPaintProperty(id, 'fill-extrusion-color') : null);
    const json = (value) => JSON.stringify(value);
    const heroPaint = paint('neighborhood-buildings');
    const ramp = heroPaint?.[6][4] ?? [];
    return {
      layers: ['neighborhood-buildings', 'neighborhood-buildings-overview', 'context-buildings'].every(id => order.includes(id)),
      hero: json(heroPaint) === json(buildingAtmosphereColor(ATMOSPHERES.day)),
      overview: json(paint('neighborhood-buildings-overview')) === json(heroPaint),
      context: json(paint('context-buildings')) === json(contextAtmosphereColor(ATMOSPHERES.day, [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat])),
      reveal: json(heroPaint?.[6][2]) === json(['global-state', HAZE_REVEAL]),
      fadeStart: ramp[5] ?? null, radius: ramp[13] ?? null, fog: ramp[14] ?? null,
      // Everything inside the fade start is the untouched classification palette, which is what keeps the near field out
      // of the haze at all.
      untouchedNear: json(ramp[4]) === json(ramp[6]) && json(ramp[4]) === json(['match', ['get', 'category'],
        ...Object.entries(ATMOSPHERES.day.buildings).flatMap(([key, value]) => key === 'unknown' ? [] : [key, value]),
        ATMOSPHERES.day.buildings.unknown]),
      sky: Object.entries(SKY_BLEND).every(([key, value]) => map.getSky()[key] === value),
    };
  });
  expect(live).toEqual({ layers: true, hero: true, overview: true, context: true, reveal: true, untouchedNear: true, sky: true,
    fadeStart: 900, radius: 3000, fog: '#c8d4dc' });
  // The acceptance protects the first 500 m, and the fade start is the guarantee: it has to sit outside that line.
  expect(live.fadeStart).toBeGreaterThan(500);

  // One source of truth for the haze: the ramp's own tail is the theme's fog, and the theme's fog is what the sky draws.
  const fogOf = (id) => page.evaluate(async (id) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { ATMOSPHERES } = await import('/src/atmosphere.js');
    const paint = neighborhood.map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color');
    return { ramp: paint[6][4][14], reveal: paint[6][6], theme: ATMOSPHERES[id].sky['fog-color'],
      sky: neighborhood.map.getSky()['fog-color'] };
  }, id);
  expect(await fogOf('day')).toEqual({ ramp: '#c8d4dc', reveal: '#c8d4dc', theme: '#c8d4dc', sky: '#c8d4dc' });
  await switchAtmosphere(page, 'night');
  await settled(page);
  expect(await fogOf('night')).toEqual({ ramp: '#1a2330', reveal: '#1a2330', theme: '#1a2330', sky: '#1a2330' });
  await switchAtmosphere(page, 'day');
  await settled(page);
  expect(await fogOf('day')).toEqual({ ramp: '#c8d4dc', reveal: '#c8d4dc', theme: '#c8d4dc', sky: '#c8d4dc' });

  // The bands are read on the picture, from a camera pulled aside so the far field is not hidden behind the blocks that
  // would otherwise fill the frame.
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.jumpTo({ center: [113.323, 23.1065], zoom: 15.5, pitch: 62, bearing: -25 });
  });
  await settled(page);
  await page.waitForFunction(() => document.querySelector('#map-error').hidden, { timeout: 45000 });
  // 把动效停住再读这两遍：这条判据问的是"同一格画面在雾的斜坡开与关之间动不动"，而近场的车、人、船现在
  // 会走进采样板格里（2026-10-09 江上补了船、行道树重排之后，近那一格的采样里就有了会动的东西，
  // 两次读数的中位差 1 个色阶——那是移动，不是斜坡）。停帧是这一项自己的口径：整套里凡是要拿两帧做差的，
  // 都先让唯一能写画面的那件事停下来。
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setMotion(false);
  });
  await page.waitForTimeout(1500);
  const cells = await hazeCells(page);
  const bands = await bandStats(page, cells);
  const list = HAZE_BANDS.map(([low, high]) => bands[`${low}-${high}`]);
  expect(list.every(band => band && band.n >= 100 && band.pairs >= 10), `bands sampled: ${JSON.stringify(bands)}`).toBe(true);
  const withRamp = await assertRecedes(page, list, 'the haze never closes on the fog');
  expect(list[3].stepMean, `the far blocks lose contrast against each other: ${list[0].stepMean} → ${list[3].stepMean}`).toBeLessThan(list[0].stepMean);
  await page.screenshot({ path: '/tmp/canton-air-perspective-far.png' });

  // That reading is only worth anything if the haze, and not the camera, is what moves the far band. So the same cells are
  // measured again with the ramp taken out of the live paint: the near band has to sit still, and the walk toward the fog
  // has to stop.
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { ATMOSPHERES } = await import('/src/atmosphere.js');
    const map = neighborhood.map;
    const theme = ATMOSPHERES.day;
    window.hazePaint = ['neighborhood-buildings', 'neighborhood-buildings-overview', 'context-buildings']
      .map(id => [id, map.getPaintProperty(id, 'fill-extrusion-color')]);
    const pure = ['match', ['get', 'category'],
      ...Object.entries(theme.buildings).flatMap(([key, value]) => key === 'unknown' ? [] : [key, value]), theme.buildings.unknown];
    for (const [id] of window.hazePaint) map.setPaintProperty(id, 'fill-extrusion-color', id === 'context-buildings' ? theme.context : pure);
  });
  await page.waitForTimeout(900);
  const flatBands = await bandStats(page, cells);
  const flatList = HAZE_BANDS.map(([low, high]) => flatBands[`${low}-${high}`]);
  expect(flatList[0].rgb, 'the near band is the same picture with or without the ramp').toEqual(list[0].rgb);
  const flatDelta = flatList[3].rgb.map((value, channel) => value - flatList[0].rgb[channel]);
  const flatMetrics = await recessionMetrics(page, flatList);
  expect(flatMetrics.recession,
    `without the ramp the 3 km band still travels ${flatMetrics.recession.toFixed(1)} units toward the fog, against ${withRamp.recession.toFixed(1)} with it (${JSON.stringify(flatDelta)} per channel)`).toBeLessThan(withRamp.recession / 2);
  await page.screenshot({ path: '/tmp/canton-air-perspective-without.png' });
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    for (const [id, paint] of window.hazePaint) neighborhood.map.setPaintProperty(id, 'fill-extrusion-color', paint);
    delete window.hazePaint;
  });
  await page.waitForTimeout(900);
  expect((await bandStats(page, cells))['2400-3001'].rgb, 'the injected paint went back to the shipped one')
    .toEqual(list[3].rgb);

  // The ease is measured on the same 8-pixel grid of near blocks in both states, since that is where it does its work.
  const near = await hazeCells(page, 700);
  const landed = await bandStats(page, near);
  expect((await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.revealHaze(20000);
  })), 'a re-run of the ease starts from the fog').toMatchObject({ running: true, ms: 1500 });
  await page.waitForTimeout(150);
  // The picture and the clock are sampled as a pair, and a pair is only accepted when the fog is actually ON the
  // blocks: paint reaches the screen a frame or two after the style state, and a full-page screenshot is itself several
  // frames of round trip, so on a loaded machine the number can read 0.94 while the frame underneath it is still the
  // cleared picture - that is exactly how this claim failed inside a 38-minute run ("119.3 → 118.6", a washed frame
  // that had not been washed) and passed minutes later on the same build. So: re-arm the ease when its foggy half has
  // passed, take the sample only inside reveal 0.65-0.95 where the movement is tens of units, require the clock not to
  // have run backwards or more than 0.12 across the round trip, and reject a picture that is still the landed one.
  // The two >= 6 unit thresholds below are untouched, and they are graded against a frame the sample proves is fogged.
  let washed = null;
  let mid = null;
  await expect.poll(async () => {
    const opened = await hazeStatus(page);
    if (!opened.running || opened.reveal < 0.6) {
      await page.evaluate(async () => {
        const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
        neighborhood.revealHaze(20000);
      });
      await page.waitForTimeout(400);
    }
    const before = await hazeStatus(page);
    if (before.reveal > 0.95 || before.reveal < 0.65) return false;
    const stats = await bandStats(page, near);
    const after = await hazeStatus(page);
    if (after.reveal > before.reveal || before.reveal - after.reveal > 0.12) return false;
    const moved = Math.max(...stats['0-700'].rgb.map((value, channel) => Math.abs(value - landed['0-700'].rgb[channel])));
    if (moved < 3) return false;
    washed = stats;
    mid = { reveal: Math.round(((before.reveal + after.reveal) / 2) * 1000) / 1000 };
    return true;
  }, { message: 'no frame caught with the ease walked into its foggy half', timeout: 90000 }).toBe(true);
  expect(mid.reveal, 'the frame was caught while the ease still had fog in it').toBeGreaterThan(0.6);
  // The same yardstick as the band ladder: the near cells are a mix of wall and ground, and the ground `#e4eae3` is
  // *brighter in red* than the grey-blue fog, so washing toward the fog moves that mix down in red and up in blue.
  // "Every channel rises by six" was only ever the white fog's signature; what the ease has to do is carry the near
  // band toward the fog and pick up its cast, which is what is measured here.
  const { away: washAway, cast: washCast } = await fogYardsticks(page);
  const [landedNear, washedNear] = [landed['0-700'].rgb, washed['0-700'].rgb];
  const lifted = washedNear.map((value, channel) => value - landedNear[channel]);
  expect(washAway(landedNear) - washAway(washedNear),
    `haze at ${mid.reveal} leaves the near band ${lifted} units where it is, ${washAway(landedNear).toFixed(1)} → ${washAway(washedNear).toFixed(1)} from the fog`).toBeGreaterThanOrEqual(6);
  expect(washCast(washedNear) - washCast(landedNear),
    `haze at ${mid.reveal} lifts the near band by ${lifted} without taking on the fog's blue`).toBeGreaterThanOrEqual(6);
  // The ease this frame is caught inside runs for 20 s, so the wait for it to land is longer than the shipped 1.5 s.
  await expect.poll(async () => (await hazeStatus(page)).running, { timeout: 30000 }).toBe(false);
  await page.waitForTimeout(800);
  const back = await bandStats(page, near);
  for (const [channel, value] of back['0-700'].rgb.entries()) {
    expect(Math.abs(value - landed['0-700'].rgb[channel]), `the ease lands on the shipped palette, not a residue: ${landed['0-700'].rgb} → ${back['0-700'].rgb}`).toBeLessThanOrEqual(3);
  }
  expect(await hazeStatus(page)).toEqual({ reveal: 0, running: false, ms: 1500 });
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

// V4 item 3: the switch is a walk, not a cut. The clock, the single pattern swap at its middle, the picture caught
// between the two shipped ones, and the frame it hands back are all measured here, because "无闪烁、无半吊子中间态"
// is only worth anything as numbers.
test('an atmosphere switch walks for 1.2 s, swaps its patterns once at the middle, and hands back the shipped frame', async ({ page }) => {
  // The middle of the walk is photographed from a 20 s fade, and the byte comparisons that follow each wait for two
  // frames to agree, so this item needs the same budget as the night axis runs on.
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await openMap(page);

  const walk = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const samples = [];
    const began = performance.now();
    document.querySelector('[data-atmosphere-option="night"]').click();
    await new Promise(resolve => {
      const tick = () => {
        samples.push({
          ...neighborhood.atmosphere, elapsed: Math.round(performance.now() - began),
          lamps: map.getLayoutProperty('building-lights', 'visibility'),
          grid: JSON.stringify(map.getPaintProperty('building-facade', 'fill-extrusion-pattern')),
        });
        if (neighborhood.atmosphere.running && performance.now() - began < 8000) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return samples;
  });
  const moving = walk.filter(sample => sample.running);
  expect(walk[0], 'the switch opens on the theme being left, on the shipped 1.2 s clock').toMatchObject(
    { mood: 0, running: true, swapped: false, ms: 1200, swapMs: 600, lamps: 'none' });
  expect(moving[0].elapsed, 'the click itself is not where the time goes').toBeLessThan(100);
  expect(moving.length, `a walk is made of frames, not one step: ${moving.length}`).toBeGreaterThan(40);
  expect(moving.slice(1).every((sample, index) => sample.mood >= moving[index].mood - 1e-9), 'the clock never runs back').toBe(true);
  expect(moving[moving.length - 1].mood, 'it reaches the theme it was heading for').toBeGreaterThanOrEqual(0.99);
  const gaps = moving.slice(1).map((sample, index) => sample.elapsed - moving[index].elapsed).sort((a, b) => a - b);
  const at = (share) => gaps[Math.floor(gaps.length * share)];
  const spread = `p50 ${at(0.5)} / p90 ${at(0.9)} / p95 ${at(0.95)} / max ${gaps[gaps.length - 1]} ms`;
  // Three numbers, because one cannot hold. Measured with `scripts/probe-walk-frames.mjs` on this machine: the median
  // gap is 16.5-16.8 ms in every one of 15 sampled walks -- the walk is paced by the display, and it stays that way
  // under load -- so "a walk runs at frame rate" is graded on the median. The tail is not the walk's doing: with other
  // pages in the same browser holding the GPU, p95 lands anywhere from 18.7 to 30 ms and the single longest frame from
  // 20 to 73 ms, which is why the two tail caps are set outside that spread rather than at one vsync. A walk that gets
  // slower per frame is caught here: 10 ms of extra work inside `step` moved the median from 16.7 to 19 ms, and this
  // median cap is the assertion that goes red.
  expect(at(0.5), `frame gaps during the walk: ${spread}`).toBeLessThanOrEqual(18);
  expect(at(0.95), `frame gaps during the walk: ${spread}`).toBeLessThanOrEqual(33);
  expect(gaps[gaps.length - 1], `frame gaps during the walk: ${spread}`).toBeLessThanOrEqual(90);

  const flags = moving.map(sample => sample.swapped);
  expect(flags.filter((flag, index) => index && flag !== flags[index - 1]).length, 'the swap is one step, not a ramp').toBe(1);
  const first = moving[flags.indexOf(true)];
  expect(first.elapsed, 'the swap waits for the middle of the walk').toBeGreaterThanOrEqual(600);
  expect(first.elapsed).toBeLessThan(720);
  expect(Math.abs(first.mood - 0.5), `the swap lands on the visual middle too: mood ${first.mood}`).toBeLessThan(0.06);
  expect(moving[moving.indexOf(first) - 1].grid, 'the grid is the day one until then').toContain('building-facade-day-');
  expect(first.grid, 'and the night one from there').toContain('building-facade-night-');
  expect(moving[moving.indexOf(first) - 1].lamps).toBe('none');
  expect(first.lamps, 'the lamps come up with the swap, not with the clock').toBe('visible');

  const settled = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const A = await import('/src/atmosphere.js');
    const map = neighborhood.map, night = A.ATMOSPHERES.night;
    return {
      buildings: JSON.stringify(map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color')) === JSON.stringify(A.buildingAtmosphereColor(night)),
      overview: JSON.stringify(map.getPaintProperty('neighborhood-buildings-overview', 'fill-extrusion-color')) === JSON.stringify(A.buildingAtmosphereColor(night)),
      // Not one layer is left reading the walk's number: the end state is the shipped declaration, not a blend parked
      // at one, which is what lets every other test read the paint as it always has.
      noBlendLeft: !JSON.stringify(map.getStyle().layers).includes('"mood"'),
      status: neighborhood.atmosphere,
    };
  });
  expect(settled, 'the walk hands the paint back to the shipped expressions').toMatchObject(
    { buildings: true, overview: true, noBlendLeft: true, status: { mood: 0, running: false, swapped: false, ms: 1200, swapMs: 600 } });

  // A walk that only shows in a clock is not a walk, so the same 8 px grid of near blocks is caught between the two
  // shipped pictures. The duration hook keeps the middle on screen long enough to photograph it.
  //
  // The loop is stopped first, because all three frames have to be pictures rather than moments: with the city breath
  // running, the same cells read 103,111,123 or 114,121,130 depending on which lamp batch was up when the shutter
  // fell, and a "strictly between" claim graded against a moving endpoint is a coin toss. The walk's own ramp is not
  // the motion loop - it runs on its own clock - so parking this leaves exactly one thing moving.
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    if (neighborhood.motionStatus().on) neighborhood.setMotion(false);
  });
  const cells = await hazeCells(page, 700);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setAtmosphere('day', { instant: true });
  });
  await repainted(page);
  const from = (await bandStats(page, cells))['0-700'].rgb;
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setAtmosphere('night', { duration: 20000 });
  });
  // The live layer has to be reading the walk's number, with both themes' ramps inside it: without this the pixel check
  // below could be satisfied by the mixed light alone, which dims the walls too.
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const A = await import('/src/atmosphere.js');
    const live = JSON.stringify(neighborhood.map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color'));
    const want = JSON.stringify(A.themeBlend(A.buildingAtmosphereColor(A.ATMOSPHERES.day), A.buildingAtmosphereColor(A.ATMOSPHERES.night)));
    return live === want;
  }), 'the walls are walked by the expression, not only re-lit').toBe(true);
  // Which frame gets graded is itself a claim. A 6 s walk overshot: each poll costs a round trip into a page that is
  // repainting a fade, and the read that satisfied `≥ 0.45` landed at mood 0.82, where the walls are already home and
  // the blue channel - 130 by day, 124 by night, six levels for the whole walk - has arrived. A 20 s walk puts one
  // overshoot at a twentieth of the ramp, and the window below is what says the frame photographed is the middle.
  let crossing = 0;
  await expect.poll(async () => {
    crossing = (await moodStatus(page)).mood;
    return crossing;
  }, { timeout: 26000, interval: 100 }).toBeGreaterThanOrEqual(0.45);
  const middle = (await bandStats(page, cells))['0-700'].rgb;
  const photographed = (await moodStatus(page)).mood;
  expect(crossing, 'the frame below is not the middle of the walk, so "strictly between" measures its end')
    .toBeLessThan(0.6);
  expect(photographed, 'the photograph took long enough that the frame it caught is not the one being waited for')
    .toBeLessThan(0.66);
  await expect.poll(async () => (await moodStatus(page)).running, { timeout: 30000 }).toBe(false);
  await page.waitForTimeout(800);
  const to = (await bandStats(page, cells))['0-700'].rgb;
  // The walk travels red and green. Blue lands on 130 in both shipped pictures, so asking that channel to sit
  // "strictly between" them is not a strong claim - it is an unsatisfiable one, because the mixed light bulges a
  // couple of levels above the endpoints on its way through. Measured mood by mood over the same cells, with the
  // motion loop parked: 1 → 150,143,130 · 0.17 → 156,148,135 · 0.48 → 140,137,132 · 0.65 → 131,132,131 ·
  // 0.79 → 124,127,131 · 0.93 → 117,123,130 · 0 → 113,120,130. So the mid frame is graded on every channel that has
  // somewhere to be, and on luminance, which has to clear both pictures by more than a level.
  const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const travelling = [0, 1, 2].filter((channel) => Math.abs(to[channel] - from[channel]) >= 3);
  expect(travelling.length, 'the two shipped pictures agree on every channel, so this claim has nothing to measure')
    .toBeGreaterThan(1);
  for (const channel of travelling) {
    expect((middle[channel] - from[channel]) * (to[channel] - middle[channel]) > 0,
      `channel ${channel} of the frame at mood ${Math.round(crossing * 100) / 100} is outside ${from} → ${to}: ${middle}`)
      .toBe(true);
  }
  expect(Math.min(Math.abs(luma(middle) - luma(from)), Math.abs(luma(to) - luma(middle))) >= 3,
    `the mid frame is not between the two pictures in brightness either: ${luma(from).toFixed(1)} → `
    + `${luma(middle).toFixed(1)} → ${luma(to).toFixed(1)}`).toBe(true);

  // The strongest claim available: the frame a finished walk leaves behind is the frame a page that never animates
  // draws. Both sides go through the real buttons, because the button handler is what moves the panel's own theme -
  // calling the API directly would leave the chrome on the old one and the comparison would be about the DOM, not the map.
  //
  // It is read over the map, and that is a measurement rather than a convenience: with the top bar included the two
  // frames differ by exactly one pixel of one light level - the pressed button's own antialiasing - and the map area is
  // byte-identical (0 of 1,267,200 pixels). The claim is about what the walk paints, so it is graded on what the walk
  // paints, and the chrome's own contract is graded by the assertions above it.
  const MAP_AREA = { x: 0, y: 80, width: 1440, height: 880 };
  const rested = async () => {
    let last = await page.screenshot({ clip: MAP_AREA });
    for (let tries = 0; tries < 20; tries++) {
      await page.waitForTimeout(300);
      const now = await page.screenshot({ clip: MAP_AREA });
      if (now.equals(last)) return now;
      last = now;
    }
    return last;
  };
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setMotion(false);
  });
  await switchAtmosphere(page, 'day');
  await switchAtmosphere(page, 'night');
  const walked = await rested();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-atmosphere-option="day"]').click();
  // Read straight after the click: waiting first would let a walk that should not have started finish unseen.
  expect(await moodStatus(page), 'a reduce request gets the shipped cut, not a slower one').toMatchObject({ running: false, mood: 0 });
  await switchAtmosphere(page, 'night');
  expect((await rested()).equals(walked), 'the walk ends on the frame a cut draws, byte for byte').toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

// Half way through one walk the user picks a third theme. The picture on screen is then part of the way from day toward
// night; resuming from `day` would snap it backwards, so the abandoned walk stays in the expression as a middle stop.
test('an atmosphere switch interrupted half way continues from the frame on screen', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await openMap(page);
  const run = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const A = await import('/src/atmosphere.js');
    const map = neighborhood.map;
    const marks = [];
    const began = performance.now();
    const click = (id) => document.querySelector(`[data-atmosphere-option="${id}"]`).click();
    click('night');
    await new Promise(resolve => setTimeout(resolve, 900));
    const at = neighborhood.atmosphere.mood;
    const atElapsed = Math.round(performance.now() - began);
    const swappedBefore = neighborhood.atmosphere.swapped;
    click('sunset');
    let resumed = false;
    await new Promise(resolve => {
      const tick = () => {
        if (!marks.length) {
          // Read the live layer on the first frame of the new walk. The expected shape is spelled out here rather than
          // rebuilt with `themeResume`, because a blend compared against its own generator cannot be wrong.
          const live = JSON.stringify(map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color'));
          const [d, n, s] = ['day', 'night', 'sunset'].map(id => A.buildingAtmosphereColor(A.ATMOSPHERES[id]));
          const want = ['interpolate', ['linear'], ['zoom'], 12,
            ['interpolate', ['linear'], ['global-state', A.MOOD], 0, d[4], at, A.themeBlend(d[4], n[4]), 1, s[4]], 16,
            ['interpolate', ['linear'], ['global-state', A.MOOD], 0, d[6], at, A.themeBlend(d[6], n[6]), 1, s[6]]];
          resumed = live === JSON.stringify(want);
        }
        marks.push({ ...neighborhood.atmosphere, elapsed: Math.round(performance.now() - began), lamps: map.getLayoutProperty('building-lights', 'visibility') });
        if (neighborhood.atmosphere.running && performance.now() - began < 9000) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const painted = JSON.stringify(map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color'));
    return {
      at, atElapsed, swappedBefore, marks, resumed,
      shipped: painted === JSON.stringify(A.buildingAtmosphereColor(A.ATMOSPHERES.sunset)),
      blending: painted.includes('"mood"'),
    };
  });
  expect(run.resumed, 'the new walk carries the abandoned one as its middle stop').toBe(true);
  // At 900 ms of a cubic in-out 1.2 s walk the picture is 94 % of the way to night - still walking, and well past the
  // swap, which is what the two assertions below check.
  expect(run.at, `the second click has to land inside the first walk: mood ${run.at}`).toBeGreaterThan(0.5);
  expect(run.at).toBeLessThan(0.99);
  expect(run.swappedBefore, 'the night patterns were already up when the user changed their mind').toBe(true);
  const moving = run.marks.filter(mark => mark.running);
  expect(moving.slice(1).every((mark, index) => mark.mood >= moving[index].mood - 1e-9),
    `the resumed walk picks up where the first stood: ${moving.map(mark => mark.mood).join(' ')}`).toBe(true);
  expect(moving[0].mood, 'it does not restart from the theme it began on').toBeGreaterThan(run.at - 0.02);
  const flags = moving.map(mark => mark.swapped);
  expect(flags.filter((flag, index) => index && flag !== flags[index - 1]).length, 'and it swaps once more, for the new theme').toBe(1);
  const swap = moving[flags.indexOf(true)];
  expect(swap.elapsed - run.atElapsed, 'the new theme waits its own middle before it swaps').toBeGreaterThanOrEqual(600);
  expect(swap.lamps, 'the lamps that came up for night go back down for a theme that has none').toBe('none');
  expect(run.blending, 'nothing is left reading the walk').toBe(false);
  expect(run.shipped, 'the scene settles on the theme that was picked last').toBe(true);
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

// The same page under a reduce request never animates: it opens on the shipped pixels instead of walking to them.
test('a reduced-motion page opens past the ease with the haze installed', async ({ page }) => {
  test.setTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${appUrl}#map=15.5/23.1065/113.323/-25/62`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  // `#places-toggle` unlocks when the snapshot is in memory, not when the deep-linked camera has drawn it: a band scan
  // started there once found no cell at all (`bands sampled: {}`). Same three guards the sibling test already uses -
  // features on screen, the frame that paints them requested and completed, and no tile error - before the picture is read.
  await expect.poll(async () => (await state(page)).buildings, { timeout: 30000 }).toBeGreaterThan(0);
  await repainted(page);
  await page.waitForFunction(() => document.querySelector('#map-error').hidden, { timeout: 45000 });
  await page.waitForTimeout(1500);
  expect(await hazeStatus(page), 'nothing animates, so the first frame is already the end state').toEqual({ reveal: 0, running: false, ms: 1500 });
  const cells = await hazeCells(page);
  const bands = await bandStats(page, cells);
  const list = HAZE_BANDS.map(([low, high]) => bands[`${low}-${high}`]);
  expect(list.every(band => band && band.n >= 100), `bands sampled: ${JSON.stringify(bands)}`).toBe(true);
  await assertRecedes(page, list, 'the opened picture does not carry the recession');
  expect((await state(page)).error).toBeNull();
  expect(errors).toEqual([]);
});

// One item per viewport. Five viewports × four atmosphere walks inside a single item share one wall clock, and on a
// loaded machine that is what broke first - the budget was the failure, not the layout. Splitting costs a page load per
// viewport and leaves every claim exactly where it was.
for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
  test(`atmosphere controls remain reachable with both panels at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    // Measured with `--workers=1` on this machine: 38.5 s / 40.7 s / 90 s for 320×568 / 390×844 / 1024×768 inside a
    // full 38-minute run, and the two landscape ones hit the 90 s wall there while all five pass in 3-4 minutes each
    // when the file is run alone. Four atmosphere walks plus two panels is a clock question, not a layout question -
    // every claim below is a rectangle, not a duration - so the budget carries the suite's own load.
    test.setTimeout(180000);
    await page.route('**/api/interpreter**', route => route.fulfill({ json: { elements: [] } }));
    await openMap(page);
    await page.setViewportSize(viewport);
    if (await page.locator('#search-panel').isVisible()) await page.locator('#search-toggle').click();
    if (await page.locator('#poi-panel').isVisible()) await page.locator('#close-places').click();
    await page.locator('#recenter-button').click();
    await settled(page);
    await switchAtmosphere(page, 'night');
    await settled(page);
    await page.screenshot({ path: `/tmp/canton-atmosphere-night-${viewport.width}.png` });
    await page.locator('#places-toggle').click();
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('广州');
    await expect(page.locator('#search-results li').first()).toBeVisible();
    for (const id of ['day', 'sunset', 'night']) {
      await switchAtmosphere(page, id);
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
  });
}

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
  await switchAtmosphere(page, 'night');
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
      'fill-extrusion-color': lensHeightColor, 'fill-extrusion-height': ['coalesce', ['get', 'displayHeight'], ['get', 'height']],
      'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': id === 'height-estimates' ? 0.55 : 1,
    });
  }
  expect(before.layers['height-unknown']).toMatchObject({ type: 'fill', visibility: 'visible', paint: {
    'fill-color': '#9fa9ad', 'fill-opacity': 0.65, 'fill-outline-color': '#66777c',
  } });
  for (const atmosphere of ['sunset', 'night', 'day']) {
    await switchAtmosphere(page, atmosphere);
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

test('city lens: unknown heights draw an illustrative depth taken from each own outline', async ({ page }) => {
  test.setTimeout(120000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expectUseLens(page);
  const coalesce = ['coalesce', ['get', 'displayHeight'], ['get', 'height']];
  const layerIds = ['neighborhood-buildings', 'neighborhood-buildings-overview'];
  const read = () => page.evaluate(async (ids) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const features = (await map.getSource('canton-buildings').getData()).features;
    const lifted = features.filter(f => f.properties.displayHeight != null);
    const heights = lifted.map(f => f.properties.displayHeight);
    return {
      total: features.length,
      lifted: lifted.length,
      knownWithField: features.filter(f => f.properties.heightSource !== 'estimate' && f.properties.displayHeight != null).length,
      placeholderSourceHeights: [...new Set(features.filter(f => f.properties.heightSource === 'estimate').map(f => f.properties.height))],
      range: [Math.min(...heights), Math.max(...heights)],
      distinct: new Set(heights).size,
      paint: ids.map(id => map.getStyle().layers.find(layer => layer.id === id).paint['fill-extrusion-height']),
    };
  }, layerIds);
  const frame = await read();
  expect(frame).toMatchObject({
    total: 3990, lifted: 2920, knownWithField: 0, placeholderSourceHeights: [9.6], range: [9.6, 24], distinct: 105,
  });
  expect(frame.paint, 'every drawn volume reads the derived depth and falls back to the tagged number').toEqual([coalesce, coalesce]);
  await page.evaluate(async ({ ids, value }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    for (const id of ids) neighborhood.map.setPaintProperty(id, 'fill-extrusion-height', value);
  }, { ids: [layerIds[0]], value: ['get', 'height'] });
  const flat = await read();
  expect(flat.paint[0], 'a layer that ignores the derived depth must fail this contract').not.toEqual(coalesce);
  expect({ ...flat, paint: null }, 'the injected paint must be the only thing that changed')
    .toEqual({ ...frame, paint: null });
  await page.evaluate(async ({ ids, value }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    for (const id of ids) neighborhood.map.setPaintProperty(id, 'fill-extrusion-height', value);
  }, { ids: [layerIds[0]], value: coalesce });
  expect(await read()).toEqual(frame);
  // Choose from this rendered frame, not a hard-coded coordinate or a direct selectFeature call. The tallest lifted
  // placeholder is the one whose highlight can only be right if the derived depth is actually threaded through.
  const pick = await page.evaluate(async (id) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    let best = null;
    const found = () => best && best.displayHeight >= 24;
    for (let y = 200; y < innerHeight - 150 && !found(); y += 10) {
      for (let x = 380; x < innerWidth - 100 && !found(); x += 10) {
        if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
        const hits = map.queryRenderedFeatures([[x - 2, y - 2], [x + 2, y + 2]], { layers: [id] });
        // A point where any tagged building is also drawn can resolve the click to that neighbour instead.
        if (!hits.length || hits.some(f => f.properties.heightSource !== 'estimate')) continue;
        for (const hit of hits) {
          if (!best || hit.properties.displayHeight > best.displayHeight) {
            best = { x, y, osmId: hit.properties.osmId, displayHeight: hit.properties.displayHeight };
          }
        }
      }
    }
    return best;
  }, layerIds[0]);
  expect(pick, 'no rendered placeholder footprint was clickable').toBeTruthy();
  expect(pick.displayHeight, 'the frame holds no placeholder above the lower bound').toBeGreaterThan(9.6);
  await page.mouse.click(pick.x, pick.y);
  const card = page.locator('.building-card');
  await expect(card).toContainText(`模型厚度 ${pick.displayHeight} m（按轮廓短边设置），不代表实际楼高。`);
  await expect(card).not.toContainText('按默认 9.6 m 绘制');
  const highlight = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).map(f => f.properties.height);
  });
  await expect.poll(highlight, 'the highlight must wrap the depth that was drawn').toEqual([pick.displayHeight]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.building-card')).toHaveCount(0);
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
  await switchAtmosphere(page, 'night');
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

test('procedural facade grid: one rhythm per category and one palette per atmosphere, translucent over the coloured walls', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expectUseLens(page);
  // The four rhythms this stage ships, spelled out here rather than imported from the module: a build that quietly
  // gives two categories the same grid, or hangs one grid on every block, has to fail this file - and it cannot do that
  // by reading the table back from itself.
  const RHYTHMS = { curtain: [4, 4, 6, 4], dense: [4, 8, 5, 3], civic: [2, 4, 8, 6], plain: [4, 4, 4, 5] };
  const WEARS = { commercial: 'curtain', residential: 'dense', public: 'civic', unknown: 'plain' };
  const GLASS = { day: [0, 168], sunset: [0, 66], night: [0, 40, 110] };
  // Measured against a 600 m needle: 32 texels of any of these tiles span 29.3 m of wall.
  const METRES_PER_TEXEL = 29.3 / 32;
  // At night the whole per-category set hangs inside one more switch: the blocks whose own id marks them as burning
  // nothing wear a transparent tile, so a dark building is dark on the grid and on the lamp overlay at the same time.
  // That switch is spelled out here too, modulus and residue and all.
  const darkBlock = ['==', ['%', ['to-number', ['get', 'osmId'], 0], 11], 7];
  const rhythm = theme => ['match', ['get', 'category'],
    'commercial', `building-facade-${theme}-curtain`, 'residential', `building-facade-${theme}-dense`,
    'public', `building-facade-${theme}-civic`, 'unknown', `building-facade-${theme}-plain`, `building-facade-${theme}-plain`];
  const expression = theme => theme === 'night'
    ? ['case', darkBlock, 'building-windows-off', rhythm(theme)]
    : rhythm(theme);
  const gridOf = image => [image.bands, image.bays, image.paneY, image.paneX];
  const facade = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const layer = id => map.getStyle().layers.find(l => l.id === id);
    const order = map.getStyle().layers.map(l => l.id);
    const images = {};
    for (const name of map.listImages().filter(n => n.indexOf('building-facade-') === 0).sort()) {
      const { data: tile } = map.getImage(name);
      const pixels = tile.width * tile.height;
      let clear = 0, opaque = 0;
      const alphas = new Set();
      for (let p = 3; p < tile.data.length; p += 4) {
        if (!tile.data[p]) clear++;
        if (tile.data[p] === 255) opaque++;
        alphas.add(tile.data[p]);
      }
      // The rhythm is measured off the image the GPU holds: which bands and which bays carry glass, and how far each
      // pane reaches into them. Nothing here trusts the generator's own numbers.
      const runs = flags => {
        const out = [];
        for (let i = 0; i < flags.length; i++) {
          if (!flags[i]) continue;
          if (i && flags[i - 1]) out[out.length - 1]++;
          else out.push(1);
        }
        return out;
      };
      const down = runs(Array.from({ length: tile.height }, (_, y) => tile.data[(y * tile.width + 1) * 4 + 3] > 0));
      const across = runs(Array.from({ length: tile.width }, (_, x) => tile.data[x * 4 + 3] > 0));
      images[name] = {
        width: tile.width, height: tile.height, bytes: tile.data.length, pixels,
        clearShare: Math.round(clear / pixels * 1000) / 1000, opaque, alphas: [...alphas].sort((a, b) => a - b),
        bands: down.length, bays: across.length, paneY: down[0], paneX: across[0],
      };
    }
    const { FORM_OSM_IDS } = await import('/src/landmark-forms.js');
    const dressed = {};
    const shelled = new Set(FORM_OSM_IDS);
    const onScreen = [];
    for (const feature of map.queryRenderedFeatures({ layers: ['building-facade'] })) {
      dressed[feature.properties.category] = (dressed[feature.properties.category] ?? 0) + 1;
      if (shelled.has(Number(feature.properties.osmId))) onScreen.push(Number(feature.properties.osmId));
    }
    return {
      images, dressed, onScreen, formIds: FORM_OSM_IDS,
      afterWalls: order.indexOf('building-facade') - order.indexOf('neighborhood-buildings'),
      next: order[order.indexOf('building-facade') + 1] ?? null,
      beforeLens: order.indexOf('height-estimates') - order.indexOf('building-facade'),
      pattern: layer('building-facade').paint['fill-extrusion-pattern'],
      color: layer('building-facade').paint['fill-extrusion-color'] ?? null,
      height: layer('building-facade').paint['fill-extrusion-height'],
      wallHeight: layer('neighborhood-buildings').paint['fill-extrusion-height'],
      opacity: layer('building-facade').paint['fill-extrusion-opacity'],
      visibility: layer('building-facade').layout?.visibility ?? 'visible',
      filter: map.getFilter('building-facade') ?? null,
      wallFilter: map.getFilter('neighborhood-buildings') ?? null,
      minzoom: layer('building-facade').minzoom ?? 0,
    };
  });
  const frame = await facade();
  expect(Object.keys(frame.images).sort()).toEqual(
    ['day', 'night', 'sunset'].flatMap(theme => Object.keys(RHYTHMS).map(rhythm => `building-facade-${theme}-${rhythm}`)).sort());
  for (const [name, image] of Object.entries(frame.images)) {
    const [theme, rhythm] = name.slice('building-facade-'.length).split('-');
    expect([image.width, image.height, image.pixels, image.bytes], name).toEqual([32, 32, 1024, 4096]);
    // Not one pixel may be fully opaque: the grid is an overlay, and the category colour has to reach the screen through it.
    expect(image.opaque, `${name}: an opaque pixel would repaint the wall`).toBe(0);
    expect(image.clearShare, `${name}: the wall must stay the majority of the tile`).toBeGreaterThan(0.4);
    expect(image.alphas[0], `${name}: the ground of the tile is fully transparent`).toBe(0);
    expect(image.alphas, `${name}: this atmosphere's palette`).toEqual(GLASS[theme]);
    expect(gridOf(image), `${name}: its own rhythm, measured off the uploaded tile`).toEqual(RHYTHMS[rhythm]);
    // Measured floors: a storey band finer than the ~5 m the hero camera can still resolve is averaged back into the
    // wall, and a pane narrower than ~2.7 m stops reading as a window at all.
    const band = (32 / image.bands) * METRES_PER_TEXEL, bay = (32 / image.bays) * METRES_PER_TEXEL;
    expect(band, `${name}: a storey band`).toBeGreaterThan(5);
    expect(band, `${name}: and not so tall that a wall wears two floors`).toBeLessThan(15);
    expect(bay, `${name}: a window bay`).toBeGreaterThan(3.5);
    expect(bay).toBeLessThan(8);
    expect(image.paneY * METRES_PER_TEXEL, `${name}: glass high enough to read as a window`).toBeGreaterThanOrEqual(3.6);
    expect(image.paneX * METRES_PER_TEXEL, `${name}: and wide enough`).toBeGreaterThanOrEqual(2.7);
    expect(image.paneY, `${name}: the pane leaves a clear storey band`).toBeLessThan(32 / image.bands);
    expect(image.paneX).toBeLessThan(32 / image.bays);
  }
  // Four categories need four different grids, and the four tiles have to deliver that as measured pixels.
  expect(new Set(Object.keys(RHYTHMS).map(rhythm => gridOf(frame.images[`building-facade-day-${rhythm}`]).join('/'))).size,
    'two categories measured the same is three rhythms dressed up as four').toBe(4);
  for (const rhythm of Object.keys(RHYTHMS)) {
    const grids = ['day', 'sunset', 'night'].map(theme => gridOf(frame.images[`building-facade-${theme}-${rhythm}`]).join('/'));
    expect(new Set(grids).size, `${rhythm}: the hour restyles the palette, never the lattice`).toBe(1);
  }
  expect(frame.afterWalls, 'the grid has to draw after the coloured volumes to pass their depth test').toBeGreaterThan(0);
  expect(frame.beforeLens, 'the height lens has to draw over the grid').toBeGreaterThan(0);
  expect(frame.color, 'MapLibre ignores a colour on a patterned layer, so this layer must not claim one').toBeNull();
  expect(frame.height, 'the grid is coplanar with the wall it dresses').toEqual(frame.wallHeight);
  expect(frame.opacity).toEqual(['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.42, 16.5, 0.6, 18, 0.72]);
  expect(frame.minzoom, 'the overview camera is too far for a 29 m tile').toBe(14);
  // Four landmarks stand as shells rather than as boxes, so the grid and the walls both step around exactly those four
  // - and step around nothing else, which is what `onScreen` proves on the rendered picture.
  const around = ['!', ['in', ['get', 'osmId'], ['literal', frame.formIds]]];
  expect(frame.filter, 'with no lens filter the grid dresses every volume but the ones a shell stands on').toEqual(around);
  expect(frame.wallFilter, 'the walls and the grid have to step around the same four').toEqual(frame.filter);
  expect(frame.onScreen, 'a box under a shell would double-draw that landmark').toEqual([]);
  // Every category the expression routes has blocks on screen to dress, or the per-category claim would be about an
  // empty list.
  for (const category of Object.keys(WEARS)) {
    expect(frame.dressed[category], `${category}: blocks on screen for this rhythm to dress`).toBeGreaterThan(0);
  }

  // The atmosphere decides which four grids are hung, and only the atmosphere buttons may do it.
  for (const theme of ['night', 'sunset', 'day']) {
    await switchAtmosphere(page, theme);
    await expect.poll(async () => (await facade()).pattern, `${theme} grids`).toEqual(expression(theme));
  }
  await switchAtmosphere(page, 'night');
  const night = await facade();
  expect(night.pattern, 'night hangs the night set on every category').toEqual(expression('night'));
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.setPaintProperty('building-facade', 'fill-extrusion-pattern', 'building-facade-day-dense');
  });
  const injected = await facade();
  expect(injected.pattern, 'a grid that ignores the atmosphere must fail this contract').not.toEqual(night.pattern);
  expect({ ...injected, pattern: null }, 'the injected pattern must be the only thing that changed')
    .toEqual({ ...night, pattern: null });
  await switchAtmosphere(page, 'day');
  expect((await facade()).pattern).toEqual(expression('day'));
  await switchAtmosphere(page, 'night');
  expect((await facade()).pattern).toEqual(expression('night'));
  await switchAtmosphere(page, 'day');

  // The grid dresses walls without becoming one: a click on a window has to open the block behind it.
  const wall = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    for (let y = 300; y < innerHeight - 200; y += 6) for (let x = 420; x < innerWidth - 140; x += 6) {
      if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
      const volume = map.queryRenderedFeatures([[x - 2, y - 2], [x + 2, y + 2]], { layers: ['neighborhood-buildings'] })[0];
      const grid = map.queryRenderedFeatures([[x - 2, y - 2], [x + 2, y + 2]], { layers: ['building-facade'] })[0];
      if (volume && grid && String(volume.properties.osmId) === String(grid.properties.osmId)) {
        return { x, y, osmId: String(volume.properties.osmId), height: volume.properties.displayHeight ?? volume.properties.height };
      }
    }
    return null;
  });
  expect(wall, 'no wall is dressed by the grid').not.toBeNull();
  await page.mouse.click(wall.x, wall.y);
  await expect(page.locator('.building-card')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.queryRenderedFeatures({ layers: ['building-selection'] }).map(f => f.properties.height);
  }), 'a dressed wall must still resolve to its own block').toEqual([wall.height]);
  await page.keyboard.press('Escape');
  await expect(page.locator('.building-card')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/canton-facade-day.png' });

  // The lens owns the wall colour, so the grid stands down: hidden in the height chart, and filtered with the walls.
  await page.locator('[data-lens-mode="height"]').click();
  await expect.poll(async () => (await facade()).visibility, 'the height lens must drop the grid').toBe('none');
  await page.locator('[data-lens-mode="use"]').click();
  await expect.poll(async () => (await facade()).visibility).toBe('visible');
  await page.locator('[data-building-category="residential"]').click();
  await settled(page);
  const filtered = await facade();
  expect(filtered.filter, 'a grid over a block the lens hides would hang in the air').toEqual(filtered.wallFilter);
  expect(JSON.stringify(filtered.filter)).toContain('residential');
  await page.locator('#lens-reset').click();
  await settled(page);
  const reset = await facade();
  expect(reset.filter, 'resetting the lens must drop the category with the grid').toEqual(reset.wallFilter);
  expect(JSON.stringify(reset.filter)).not.toContain('residential');

  // Close enough that a storey band is several pixels, on two real neighbouring blocks of different categories: the
  // block's own category is what picks the rhythm, so taking one category's grid away has to move that block's pixels
  // while the block next to it does not move one pixel.
  // The lens flew the camera away when it was opened, so this starts from the scene's own camera and only raises zoom.
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.jumpTo({ zoom: 16.5, pitch: 62 });
  });
  await settled(page);
  await page.waitForTimeout(4000);
  const faces = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const at = (x, y) => {
      const list = map.queryRenderedFeatures([[x, y], [x, y]], { layers: ['building-facade'] });
      const feature = list[0];
      // Only a point that answers with exactly one block is a face this block owns: where two volumes overlap, the
      // pixels belong to whichever is nearer.
      return feature && list.length === 1 ? { osmId: String(feature.properties.osmId), category: feature.properties.category } : null;
    };
    const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
    const out = {};
    for (const category of ['residential', 'public', 'commercial', 'unknown']) {
      for (let y = 180; y < innerHeight - 300 && !out[category]; y += 8) for (let x = 340; x < innerWidth - 240; x += 8) {
        if (out[category]) continue;
        const start = at(x, y);
        if (!start || start.category !== category) continue;
        let right = x; while (right + 8 < innerWidth - 40 && at(right + 8, y)?.osmId === start.osmId && clear(right + 8, y)) right += 8;
        let bottom = y; while (bottom + 8 < innerHeight - 40 && at(x, bottom + 8)?.osmId === start.osmId && clear(x, bottom + 8)) bottom += 8;
        if (right - x < 48 || bottom - y < 40) continue;
        out[category] = { category, osmId: start.osmId, clip: { x, y, width: right - x, height: bottom - y } };
      }
    }
    return out;
  });
  const [block, neighbour] = Object.values(faces).filter(Boolean);
  console.log(JSON.stringify({ faces: Object.fromEntries(Object.entries(faces).map(([k, v]) => [k, v && [v.clip.width, v.clip.height]])) }));
  expect(neighbour, 'two dressed blocks far enough apart to grade the rhythms on are missing').toBeTruthy();
  expect(block.category, 'the pair has to be two categories for this to say anything').not.toBe(neighbour.category);
  expect(WEARS[block.category], 'and they have to wear different rhythms').not.toBe(WEARS[neighbour.category]);
  const shot = async clip => (await page.screenshot({ clip })).toString('base64');
  const moved = (from, to) => page.evaluate(async ({ from, to }) => {
    const load = async encoded => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { pixels: image.width * image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    };
    const a = await load(from), b = await load(to);
    let count = 0, maxDelta = 0;
    for (let i = 0; i < b.data.length; i += 4) {
      const delta = Math.max(Math.abs(b.data[i] - a.data[i]), Math.abs(b.data[i + 1] - a.data[i + 1]), Math.abs(b.data[i + 2] - a.data[i + 2]));
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 8) count++;
    }
    return { pixels: b.pixels, count, maxDelta };
  }, { from, to });
  const reweave = (category, rhythm) => page.evaluate(async ({ category, rhythm }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const next = JSON.parse(JSON.stringify(map.getPaintProperty('building-facade', 'fill-extrusion-pattern')));
    next[next.indexOf(category) + 1] = `building-facade-day-${rhythm}`;
    map.setPaintProperty('building-facade', 'fill-extrusion-pattern', next);
  }, { category, rhythm });
  const shipped = await shot(block.clip), shippedNeighbour = await shot(neighbour.clip);
  // Two shots of the same settled frame first: whatever this pair counts is the map settling, not the rhythm, and every
  // claim below is graded against it.
  const floor = await moved(shipped, await shot(block.clip));
  await reweave(block.category, WEARS[neighbour.category]);
  await settled(page);
  await page.waitForTimeout(2500);
  const rewoven = await moved(shipped, await shot(block.clip));
  const untouched = await moved(shippedNeighbour, await shot(neighbour.clip));
  await reweave(block.category, WEARS[block.category]);
  await settled(page);
  await page.waitForTimeout(2500);
  const rewovenBack = await moved(shipped, await shot(block.clip));
  console.log(JSON.stringify({ rhythm: { block: block.category, neighbour: neighbour.category, floor, rewoven, untouched, rewovenBack } }));
  expect(floor.count, 'the frame has to be still before a pixel count means anything').toBe(0);
  expect(rewoven.count, `${block.category}: taking its rhythm away has to move its pixels`).toBeGreaterThan(floor.count);
  expect(rewoven.maxDelta, `${block.category}: and the change has to reach the screen, not hide under it`).toBeGreaterThan(floor.maxDelta);
  expect(untouched.count, `${neighbour.category}: another category's tile cannot touch this block`).toBe(0);
  expect(rewovenBack.count, 'weaving the rhythm back has to restore the frame exactly').toBe(0);
  await page.screenshot({ path: '/tmp/canton-facade-rhythm-day.png' });
  await switchAtmosphere(page, 'night');
  await settled(page);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/canton-facade-rhythm-night.png' });
  await switchAtmosphere(page, 'day');
  await page.locator('#recenter-button').click();
  await settled(page);

  // The overlay contract has to be a live assertion, so each of its failure modes is injected and rejected. This runs
  // last on purpose: it leaves the grid wearing a colour MapLibre would ignore, at full opacity, and filtered away from
  // the walls it dresses.
  const mutate = (fn, arg) => page.evaluate(async ({ fn, arg }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    new Function('map', 'arg', `return (${fn})(map, arg)`)(neighborhood.map, arg);
  }, { fn, arg });
  const before = await facade();
  expect(before.color, 'the grid layer starts without a colour').toBeNull();
  expect(before.pattern, 'and with every category on its own rhythm').toEqual(expression('day'));
  // The grid is put back in front of whatever the shipped style actually places after it, rather than in front of a
  // remembered layer id: another overlay may be added over the walls, and this claim is about the gap it came back to.
  await mutate('m => m.moveLayer("building-facade", "neighborhood-buildings")');
  expect((await facade()).afterWalls, 'a grid drawn under the walls is hidden by them').toBeLessThan(before.afterWalls);
  await mutate('m => m.moveLayer("building-facade", arg)', before.next);
  expect((await facade()).afterWalls, 'the move must be reversible').toBe(before.afterWalls);
  await mutate('m => m.setPaintProperty("building-facade", "fill-extrusion-color", "#ff0000")');
  expect((await facade()).color, 'a colour claimed on a patterned layer would be silently ignored by MapLibre').not.toBeNull();
  await mutate('m => m.setPaintProperty("building-facade", "fill-extrusion-opacity", 1)');
  expect((await facade()).opacity, 'an opaque grid would repaint the wall instead of dressing it').not.toEqual(before.opacity);
  // One grid on every block is the shape this stage replaced. MapLibre accepts it, so only a contract that reads the
  // expression back per category can reject it.
  await mutate('m => m.setPaintProperty("building-facade", "fill-extrusion-pattern", "building-facade-day-dense")');
  expect((await facade()).pattern, 'a single grid would dress a civic hall as a housing tower').not.toEqual(expression('day'));
  await mutate('m => m.setPaintProperty("building-facade", "fill-extrusion-pattern", arg)', expression('day'));
  expect((await facade()).pattern, 'and the per-category set has to come back').toEqual(expression('day'));
  await mutate('m => m.setFilter("building-facade", ["==", ["get", "category"], "commercial"])');
  const crossed = await facade();
  expect(crossed.filter, 'a grid filtered differently from the walls would hang in the air').not.toEqual(crossed.wallFilter);
  expect(errors).toEqual([]);
});

test('night lamps are stepped by height, tinted by OSM id, dimmed by distance, and the wall around them picks up spill', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expectUseLens(page);
  // Two groups of blocks × two picks of cells, plus the spill under all four - which is three layers itself, because
  // the breathing minority cannot carry a per-block opacity and has to be split out to have its halo go out with it.
  // The shipped pick keeps the layer's original id, so everything below that reads `building-lights` still reads the
  // frame this scene shipped.
  const LAMP_LAYERS = ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt'];
  const GLOW_LAYERS = ['building-glow', 'building-glow-breath-0', 'building-glow-breath-1'];
  const LAMPS = [...LAMP_LAYERS, ...GLOW_LAYERS];
  const LAMP_IMAGE = {
    'building-lights': 'building-lights', 'building-lights-alt': 'building-lights-alt',
    'building-lights-2': 'building-lights', 'building-lights-2-alt': 'building-lights-alt',
    'building-glow': 'building-glow', 'building-glow-breath-0': 'building-glow', 'building-glow-breath-1': 'building-glow',
  };
  // The same layers dressed a second time on the finer grid: past the swap zoom every one of them has to have a
  // family to fall back on, or the wall goes bare exactly where the windows are big enough to see.
  const LAMP_NEAR_IMAGE = {
    'building-lights': 'building-lights-near', 'building-lights-alt': 'building-lights-near-alt',
    'building-lights-2': 'building-lights-near', 'building-lights-2-alt': 'building-lights-near-alt',
    'building-glow': 'building-glow-near', 'building-glow-breath-0': 'building-glow-near',
    'building-glow-breath-1': 'building-glow-near',
  };
  const LAMP_WEIGHT = {
    'building-lights': ['global-state', 'lamp-0'], 'building-lights-alt': ['-', 1, ['global-state', 'lamp-0']],
    'building-lights-2': ['global-state', 'lamp-1'], 'building-lights-2-alt': ['-', 1, ['global-state', 'lamp-1']],
    'building-glow-breath-0': ['global-state', 'lamp-0'], 'building-glow-breath-1': ['global-state', 'lamp-1'],
  };
  const LAMP_GROUP = { 'building-lights': 0, 'building-lights-alt': 0, 'building-lights-2': 1, 'building-lights-2-alt': 1,
    'building-glow-breath-0': 0, 'building-glow-breath-1': 1 };
  // Which layers the breathing seventh is split out to, and which has to give it back.
  const LAMP_BREATH = { 'building-glow': false, 'building-glow-breath-0': true, 'building-glow-breath-1': true };
  const BREATH_DICE = ['==', ['%', ['to-number', ['get', 'osmId'], 0], 7], 3];
  const DARK_DICE = ['==', ['%', ['to-number', ['get', 'osmId'], 0], 11], 7];
  // The wall's own filter, plus the group clause this layer adds - `setFilter` replaces, so the lens handing a base
  // filter back has to hand the group clause back with it.
  const lampFilterFor = (id, base) => {
    const gates = [base];
    if (LAMP_GROUP[id] !== undefined) gates.push(['==', ['%', ['to-number', ['get', 'osmId'], 0], 2], LAMP_GROUP[id]]);
    if (LAMP_BREATH[id] === true) gates.push(BREATH_DICE);
    else if (LAMP_BREATH[id] === false) gates.push(['!', BREATH_DICE]);
    return gates.length === 1 ? base : ['all', ...gates];
  };
  // The cross-fade is what the next test measures; here it has to hold still, because every claim below grades a lit
  // wall against the same wall with the layers hidden, and a wall mid-fade answers that on its own. Freezing the two
  // writes is the only way to hold them out: a wait would just sample the frame somewhere inside the seven seconds
  // they take to cross over.
  const freezeLamps = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    if (map.__state) return;
    map.__state = map.setGlobalStateProperty.bind(map);
    map.setGlobalStateProperty = (key, value) => {
      if (key === 'lamp-0' || key === 'lamp-1') return;
      map.__state(key, value);
    };
  });
  await freezeLamps();
  // A page that never animates opens on the shipped pick: both groups at weight 1, which is the shipped layer at full
  // strength and the alternate pick at none - the same pair of numbers this scene drew before the cross-fade existed.
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.motionStatus().lamps;
  }), 'a still page has to sit on the shipped pick').toEqual([1, 1]);
  const lights = () => page.evaluate(async ({ LAMPS, LAMP_LAYERS }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const layer = id => map.getStyle().layers.find(l => l.id === id);
    const order = map.getStyle().layers.map(l => l.id);
    // The cell counts are read back off the uploaded images, so a tile that never reached the GPU cannot pass for one.
    // Two grids upload side by side: the shipped 4x4 and the finer 8x8 family the layer switches to past the swap zoom,
    // so the probe reads each tile's own cell centres rather than a remembered 8-texel pitch.
    const tiles = {};
    const LAMP_NAME = /^(building-lights|building-lights-alt|building-glow|building-lights-near|building-lights-near-alt|building-glow-near)-\d-\d-\d$/;
    for (const name of map.listImages().filter(n => LAMP_NAME.test(n)).sort()) {
      const { data: tile } = map.getImage(name);
      const count = tile.width * tile.height;
      let opaque = 0, covered = 0, peak = 0;
      for (let i = 0; i < count; i++) {
        const alpha = tile.data[i * 4 + 3];
        if (alpha > peak) peak = alpha;
      }
      // The pane sits in the top-left of its cell, so "this cell carries a window" is read as the cell holding a pixel
      // at the finished peak - the only probe that works on both grids, where a 4-texel cell puts its centre outside the
      // pane it draws. The halo keeps the centre probe: a feather is centred on its window and reaches over the cells
      // beside it, which is exactly the difference the spill claims turn on.
      const grid = name.includes('-near-') ? 8 : 4, cell = tile.width / grid, centre = cell / 2;
      let cells = 0, paneCells = 0;
      const lit = [], paneLit = [];
      for (let y = 0; y < tile.height; y++) for (let x = 0; x < tile.width; x++) {
        const alpha = tile.data[(y * tile.width + x) * 4 + 3];
        if (alpha === 255) opaque++;
        if (alpha > 0) covered++;
      }
      for (let row = 0; row < grid; row++) for (let column = 0; column < grid; column++) {
        if (tile.data[((row * cell + centre) * tile.width + column * cell + centre) * 4 + 3] > peak / 2) { cells++; lit.push(row * grid + column); }
        let pane = 0;
        for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
          if (tile.data[((row * cell + dy) * tile.width + column * cell + dx) * 4 + 3] === peak) pane++;
        }
        if (pane) { paneCells++; paneLit.push(row * grid + column); }
      }
      tiles[name] = {
        size: [tile.width, tile.height], bytes: tile.data.length, grid,
        cells, paneCells, covered, opaque, peak, lit: lit.join(','), paneLit: paneLit.join(','),
        alphas: [...new Set(Array.from({ length: count }, (_, i) => tile.data[i * 4 + 3]))].sort((a, b) => a - b),
      };
    }
    // Which band, colour and ring a block on screen actually got, re-derived from that block's own properties.
    const seen = new Set();
    const combos = {}, pairs = {}, densities = {}, bands = {}, temperatures = {}, rings = {}, heights = {}, distances = {};
    let darks = 0;
    for (const f of map.queryRenderedFeatures({ layers: LAMP_LAYERS })) {
      const osmId = Number(f.properties.osmId);
      if (seen.has(osmId)) continue;
      seen.add(osmId);
      const height = Number(f.properties.displayHeight ?? f.properties.height ?? 0);
      const distance = Number(f.properties.distance ?? 0);
      // The rung a block wears: its own height picks the tier, and one residue class of a prime picks which of the
      // tier's two densities it wears - the same two throws the layer's image name is built from.
      const tier = height >= 100 ? 2 : height >= 24 ? 1 : 0;
      const block = Number.isFinite(osmId) ? Math.abs(osmId) : 0;
      const band = tier * 2 + (block % 13 < 7 ? 1 : 0);
      const ring = distance >= 2400 ? 2 : distance >= 1500 ? 1 : 0;
      // The same fallback the style expression uses: a non-numeric id is read as 0, so it lands in the first colour -
      // and the same residue class of a prime modulus that the lamps are dressed with keeps the block dark.
      const residue = block % 10;
      const temperature = residue < 4 ? 0 : residue < 8 ? 1 : 2;
      // A block that wears the transparent tile has no colour on screen, so it is counted apart rather than into the
      // buckets below - the share claims underneath are about what the frame actually shows.
      if (block % 11 === 7) { darks++; continue; }
      const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
      bump(combos, `${band}-${temperature}-${ring}`);
      bump(pairs, `${band}-${temperature}`);
      bump(densities, `${band}-${ring}`);
      bump(bands, band); bump(temperatures, temperature); bump(rings, ring);
      heights[band] = Math.max(heights[band] || 0, height);
      distances[ring] = { min: Math.min(distances[ring]?.min ?? Infinity, distance), max: Math.max(distances[ring]?.max ?? 0, distance) };
    }
    const state = (id) => ({
      pattern: layer(id).paint['fill-extrusion-pattern'],
      color: layer(id).paint['fill-extrusion-color'] ?? null,
      height: layer(id).paint['fill-extrusion-height'],
      gradient: layer(id).paint['fill-extrusion-vertical-gradient'],
      opacity: layer(id).paint['fill-extrusion-opacity'],
      minzoom: layer(id).minzoom ?? 0,
      visibility: layer(id).layout?.visibility ?? 'visible',
      filter: map.getFilter(id) ?? null,
    });
    return {
      tiles, combos, pairs, densities, bands, temperatures, rings, heights, distances, darks, blocks: seen.size,
      states: Object.fromEntries(LAMPS.map(id => [id, state(id)])),
      afterGrid: order.indexOf('building-lights') - order.indexOf('building-facade'),
      spillUnderLamps: order.indexOf('building-lights') - order.indexOf('building-glow'),
      beforeLens: order.indexOf('height-estimates') - order.indexOf('building-lights'),
      wallHeight: layer('neighborhood-buildings').paint['fill-extrusion-height'],
      gridFilter: map.getFilter('building-facade') ?? null,
    };
  }, { LAMPS, LAMP_LAYERS });
  // A wall to grade the lamps on, sought once and on its own: the sweep has to sample the whole frame before it can
  // answer, so it must never sit behind a polled assertion.
  const findWall = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const at = (x, y, ids) => map.queryRenderedFeatures([[x - 1, y - 1], [x + 1, y + 1]], { layers: ids }).length > 0;
    const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
    // The tower wears its own warm lighting, so the chosen wall has to sit outside its shaft: the invisible 450 m
    // extrusion's footprint lifted off the ground, the same box the motion test keeps its controls in.
    const ring = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] }).flatMap(f => f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : []);
    const points = ring.map(([lng, lat]) => map.project([lng, lat]));
    const shaft = points.length ? {
      left: Math.min(...points.map(p => p.x)) - 90, right: Math.max(...points.map(p => p.x)) + 90,
      top: Math.max(0, Math.min(...points.map(p => p.y)) - 460), bottom: Math.max(...points.map(p => p.y)),
    } : null;
    const W = 160, H = 80;
    const dry = (x, y) => at(x, y, ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt'])
      && at(x, y, ['neighborhood-buildings'])
      && !at(x, y, ['river-surface']) && !at(x, y, ['water'])
      && (!shaft || x < shaft.left || x > shaft.right || y < shaft.top || y > shaft.bottom);
    for (let y = 200; y + H < innerHeight - 250; y += 20) for (let x = 340; x + W < innerWidth - 30; x += 20) {
      let hit = true;
      for (const r of [6, H / 2, H - 6]) for (const c of [6, W / 4, W / 2, 3 * W / 4, W - 6]) if (!dry(x + c, y + r) || !clear(x + c, y + r)) hit = false;
      if (hit) return { x, y, width: W, height: H };
    }
    return null;
  });
  const shot = async (clip) => (await page.screenshot({ clip })).toString('base64');
  // Two frames graded against each other inside the page, because the claim that matters is not "is this pixel warm" - a
  // terracotta wall answers that on its own, and a cool lamp answers it in the wrong direction - but "did this pixel
  // change, and which way". Both ends of the colour range are counted separately so a build that ships one amber for
  // everything cannot pass, and neither can one that ships a layer that never reaches the screen.
  const analyse = async (from, to) => page.evaluate(async ({ from, to }) => {
    const load = async (encoded) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { pixels: image.width * image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    };
    const a = await load(from), b = await load(to);
    let warm = 0, cool = 0, sum = 0, maxRB = -300, changed = 0, moved = 0, dimmed = 0, warmUp = 0, coolUp = 0, warmSoft = 0, coolSoft = 0, maxDelta = 0;
    for (let i = 0; i < b.data.length; i += 4) {
      const rb = b.data[i] - b.data[i + 2];
      if (rb > maxRB) maxRB = rb;
      if (rb > 20 && b.data[i] > 40) { warm++; sum += rb; }
      if (rb < -20 && b.data[i + 2] > 60) cool++;
      const shift = rb - (a.data[i] - a.data[i + 2]);
      if (shift > 30) warmUp++;
      if (shift < -30) coolUp++;
      // Spill is a wash rather than a window: after `setLight` multiplies it, its brightest texel moves a pixel by 27, so
      // it has to be graded on a softer ladder than the lamps - one that still reads zero for a settled frame against
      // itself, which is what makes the counts below a claim about the layer rather than about the basemap.
      if (shift > 8) warmSoft++;
      if (shift < -8) coolSoft++;
      const delta = Math.max(
        b.data[i] - a.data[i], a.data[i] - b.data[i],
        b.data[i + 1] - a.data[i + 1], a.data[i + 1] - b.data[i + 1],
        b.data[i + 2] - a.data[i + 2], a.data[i + 2] - b.data[i + 2]);
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 40) changed++;
      if (delta > 8) moved++;
      if (Math.max(a.data[i] - b.data[i], a.data[i + 1] - b.data[i + 1], a.data[i + 2] - b.data[i + 2]) > 8) dimmed++;
    }
    return {
      pixels: b.pixels, warm, cool, maxRB, changed, moved, dimmed, warmUp, coolUp, warmSoft, coolSoft, maxDelta,
      meanRB: warm ? Math.round(sum / warm) : 0,
    };
  }, { from, to });
  const mutate = (fn) => page.evaluate(async (fn) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    new Function('map', `return (${fn})(map)`)(neighborhood.map);
    neighborhood.map.triggerRepaint();
  }, fn);
  const hide = (visible) => mutate(`m => { ${LAMPS.map(id => `m.setLayoutProperty("${id}", "visibility", "${visible ? 'visible' : 'none'}");`).join('')} }`);
  // The streets burn in the same frame now, and they are a second warm source with nothing to do with the lamps. Every
  // wall measurement below holds them out by opacity rather than by visibility, because `swapArt` rewrites visibility at
  // the middle of each atmosphere walk and the gate claim at the end of this test switches atmosphere twice more.
  const dimTraffic = () => mutate('m => { m.setPaintProperty("traffic-band", "line-opacity", 0); m.setPaintProperty("traffic-tail", "line-opacity", 0); m.setPaintProperty("traffic-flow", "line-opacity", 0); }');
  const both = () => page.evaluate(async (LAMPS) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return LAMPS.map(id => neighborhood.map.getLayoutProperty(id, 'visibility'));
  }, LAMPS);
  // A picture is only worth comparing to once the map has stopped moving it: the basemap keeps shifting by one light
  // level for seconds after the map reports itself idle, so a byte-for-byte claim pinned to a frame caught mid-fade
  // can never come back true, however correctly the layers behave. Wait for the read to repeat, then use it.
  const same = (a, b) => Buffer.isBuffer(a) ? Buffer.compare(a, b) === 0 : JSON.stringify(a) === JSON.stringify(b);
  // One more painted frame, awaited: a layer switched on in this tick is only in what the renderer can be asked about
  // after the map has drawn again.
  const painted = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    map.triggerRepaint();
    await new Promise(resolve => map.once('idle', resolve));
  });
  const reference = async (read) => {
    let value = await read();
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.waitForTimeout(2500);
      const next = await read();
      if (same(value, next)) return next;
      value = next;
    }
    throw new Error('the wall never stopped fading, so no frame of it can serve as a reference');
  };

  // Day: both layers are built, dressed and switched off.
  const day = await lights();
  const CELLS = [2, 3, 3, 4, 4, 5], BRIGHT = [224, 224, 238, 238, 252, 252], DIM = [1, 0.55, 0.28];
  // Six families of twenty-seven: the shipped pick of each band's cells, the alternate pick the same blocks cross-fade
  // against, and the spill under both - each one twice, because the finer 8x8 grid is a family of its own rather than a
  // rescaled copy. Four layers, three tile families per grid - the two groups of blocks share one family each, because
  // which group a block is in is a filter, not a texture.
  const FAMILIES = ['building-lights', 'building-lights-alt', 'building-glow'];
  const NEAR = ['building-lights-near', 'building-lights-near-alt', 'building-glow-near'];
  // Six rungs of the ladder - three height tiers of two densities each - so the family is 6 x 3 x 3 tiles, and there are
  // six families of them: two picks of the cells and the spill, on each of the two grids.
  const BANDS = [0, 1, 2, 3, 4, 5];
  const names = [...FAMILIES, ...NEAR].flatMap(prefix => BANDS.flatMap(band => [0, 1, 2].flatMap(temperature => [0, 1, 2].map(ring => `${prefix}-${band}-${temperature}-${ring}`))));
  expect(Object.keys(day.tiles).sort(), 'six density rungs of three colour temperatures at three distances, twice over for the two picks of cells, and again for the spill, on both grids')
    .toEqual(names.slice().sort());
  for (const band of BANDS) for (const temperature of [0, 1, 2]) for (const ring of [0, 1, 2]) {
    const lamp = day.tiles[`building-lights-${band}-${temperature}-${ring}`];
    expect([lamp.size, lamp.bytes], `building-lights-${band}-${temperature}-${ring}: 32 texels of raw RGBA`).toEqual([[32, 32], 4096]);
    expect(lamp.paneCells, `building-lights-${band}-${temperature}-${ring}: a band is an exact number of windows`).toEqual(CELLS[band]);
    expect(lamp.opaque, 'not one fully opaque pixel').toBe(0);
    expect(lamp.covered, 'every lit cell carries the same pane').toBe(lamp.paneCells * 30);
    expect(lamp.alphas, 'clear ground and lamps, nothing in between').toEqual([0, lamp.peak]);
    expect(lamp.peak, 'a taller band burns brighter and a farther one dimmer').toBe(Math.round(BRIGHT[band] * DIM[ring]));
    // The alternate pick is the same band, the same colour, the same recession and the same number of windows - and a
    // different set of them, which is the whole reason a cross-fade between the two reads as windows changing rather
    // than as the city dimming.
    const alt = day.tiles[`building-lights-alt-${band}-${temperature}-${ring}`];
    expect([alt.size, alt.bytes], `building-lights-alt-${band}-${temperature}-${ring}: the alternate pick is the same tile shape`).toEqual([lamp.size, lamp.bytes]);
    expect(alt.paneCells, 'and lights exactly as many windows of that band').toBe(lamp.paneCells);
    expect(alt.peak, 'at the same brightness, so the cross-fade cannot change a block how bright it burns').toBe(lamp.peak);
    expect(alt.paneLit, 'but not the same windows').not.toBe(lamp.paneLit);
    const halo = day.tiles[`building-glow-${band}-${temperature}-${ring}`];
    expect([halo.size, halo.bytes], `building-glow-${band}-${temperature}-${ring}: the same repeat as its lamp`).toEqual([[32, 32], 4096]);
    expect(halo.opaque, 'spill is never fully opaque').toBe(0);
    // Three quarters of the window rather than "anything less": the lamp ladder now tops out at 252, so a halo that rose
    // to 218 against a 224 window still cleared a bare less-than while turning the wall into a second, blurrier board.
    expect(halo.peak, 'spill stays well under the window it spills from').toBeLessThanOrEqual(lamp.peak * 0.75);
    expect(halo.alphas.length, 'a halo is a feather, not a square').toBeGreaterThan(8);
    expect(halo.alphas[0], 'and it leaves clear wall between the halos').toBe(0);
    expect(halo.cells, 'the halo is centred on the window it belongs to').toBe(lamp.paneCells);
    expect(halo.covered, 'and reaches well past it').toBeGreaterThan(lamp.covered);
    // The finer grid, uploaded next to the shipped one and named the way the layer looks it up past the swap zoom. The
    // promise is that nothing but the pitch changes: twice the rows, twice the columns, four times the windows, so the
    // share of a band that burns is the same on either grid, at the same brightness, in the same colours.
    const fine = day.tiles[`building-lights-near-${band}-${temperature}-${ring}`];
    expect([fine.size, fine.bytes, fine.grid], `building-lights-near-${band}-${temperature}-${ring}: the same 32-texel repeat on twice the grid, so a wall cannot tell the two pitches apart by scale`)
      .toEqual([lamp.size, lamp.bytes, 8]);
    expect(lamp.grid, 'and the shipped family is still the coarse one').toBe(4);
    expect(fine.paneCells, `building-lights-near-${band}-${temperature}-${ring}: four times the windows of the band it replaces`).toBe(lamp.paneCells * 4);
    expect(Math.round(fine.paneCells / (8 * 8) * 100), 'and the same share of the grid lit').toBe(Math.round(lamp.paneCells / (4 * 4) * 100));
    expect(fine.peak, 'the swap may not brighten the city').toBe(lamp.peak);
    expect(fine.covered, 'while each window is a quarter of the pane it replaces').toBe(fine.paneCells * 6);
    expect(lamp.covered, 'and the shipped pane really was four times the area').toBe(lamp.paneCells * 30);
    const fineAlt = day.tiles[`building-lights-near-alt-${band}-${temperature}-${ring}`];
    expect(fineAlt.paneCells, 'the alternate pick crosses the swap with it, or the finer grid is the one that stops breathing').toBe(fine.paneCells);
    expect(fineAlt.paneLit, 'and it turns windows over on the finer grid too').not.toBe(fine.paneLit);
    const fineHalo = day.tiles[`building-glow-near-${band}-${temperature}-${ring}`];
    expect(fineHalo.cells, 'the spill follows the windows onto the finer grid').toBe(fine.paneCells);
    expect(fineHalo.peak, 'and stays well under the window it spills from').toBeLessThanOrEqual(fine.peak * 0.75);
  }
  for (const band of BANDS) for (const temperature of [0, 1, 2]) {
    const peaks = [0, 1, 2].map(ring => day.tiles[`building-lights-${band}-${temperature}-${ring}`].peak);
    const halos = [0, 1, 2].map(ring => day.tiles[`building-glow-${band}-${temperature}-${ring}`].peak);
    expect(peaks[0] > peaks[1] && peaks[1] > peaks[2], `the distance ladder has to reach the lamp pixels (${peaks.join('/')})`).toBe(true);
    expect(halos[0] > halos[1] && halos[1] > halos[2], `and past the spill with them (${halos.join('/')})`).toBe(true);
  }
  for (const id of LAMPS) {
    const state = day.states[id];
    const [peak, mid, top] = GLOW_LAYERS.includes(id) ? [0.44, 0.56, 0.66] : [0.62, 0.72, 0.8];
    // The image name carries three feature axes and one camera axis: the pitch is a second family rather than a rescale,
    // so the tile is chosen by `['zoom']` at the top of a `step` - the one place a zoom input is allowed to sit. The
    // number is `LIGHT_NEAR_ZOOM`, calibrated by measurement so the swap lands on screen at zoom 16. Inside each branch
    // one more switch sends the blocks whose own id says they burn nothing to a single transparent tile - and on the
    // alternate hand, the breathing seventh with them: that hand is the one its group's weight fades up, so a block
    // handed the empty tile there dims its whole facade as the cross-fade walks.
    const off = id.endsWith('-alt') ? ['any', DARK_DICE, BREATH_DICE] : DARK_DICE;
    const lampTile = (prefix) => ['concat', prefix, '-',
      ['+', ['*', ['step', day.wallHeight, 0, 24, 1, 100, 2], 2],
        ['case', ['<', ['%', ['to-number', ['get', 'osmId'], 0], 13], 7], 1, 0]], '-',
      ['step', ['%', ['to-number', ['get', 'osmId'], 0], 10], 0, 4, 1, 8, 2], '-',
      ['step', ['get', 'distance'], 0, 1500, 1, 2400, 2]];
    expect(state.pattern, `${id}: band from height, colour from osmId, recession from distance, pitch from zoom, and the dark blocks switched off, in the image name`)
      .toEqual(['step', ['zoom'], ['case', off, 'building-windows-off', lampTile(LAMP_IMAGE[id])], 15,
        ['case', off, 'building-windows-off', lampTile(LAMP_NEAR_IMAGE[id])]]);
    expect(state.color, `${id}: MapLibre ignores a colour on a patterned layer, so this layer must not claim one`).toBeNull();
    expect(state.height, `${id}: the lamps are coplanar with the wall they dress`).toEqual(day.wallHeight);
    expect(state.gradient, `${id}: a ground-floor window must not be dimmer than a top-floor one`).toBe(false);
    // `fill-extrusion-opacity` is not data-driven: a layer that reads `['get', 'distance']` here is dropped by the style
    // validator as an error event, with no layer left on the map, which is why the recession lives in the tiles instead.
    // What it can read is the global state - one number per group, riding inside each zoom stop, because `['zoom']`
    // nested inside a `['*']` is the same silent refusal. The spill cross-fades with neither, except on the two layers
    // the breathing seventh is split into: a halo may be spill rather than a window, but not on a building whose
    // windows have gone out.
    const weight = LAMP_WEIGHT[id];
    expect(state.opacity, `${id}: a zoom ramp, and one group's cross-fade weight inside every stop`).toEqual(weight
      ? ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['*', peak, weight], 16.5, ['*', mid, weight], 18, ['*', top, weight]]
      : ['interpolate', ['linear'], ['zoom'], 14, 0, 15, peak, 16.5, mid, 18, top]);
    expect(JSON.stringify(state.opacity), `${id}: no feature property may reach the opacity expression`).not.toContain('get');
    expect(state.minzoom, `${id}: the overview camera is too far for a lamp to read`).toBe(14);
    expect(state.visibility, `${id}: a day scene has no lamps`).toBe('none');
    expect(state.filter, `${id}: shadows the wall filter`).toEqual(lampFilterFor(id, day.gridFilter));
  }
  expect(day.afterGrid, 'the lamps have to draw over the window grid').toBeGreaterThan(0);
  expect(day.spillUnderLamps, 'the spill has to draw under the lamps it belongs to').toBe(1);
  expect(day.beforeLens, 'the height lens has to draw over the lamps').toBeGreaterThan(0);

  // Night: the atmosphere turns both on, every band, colour and ring is on screen, and they follow the lens.
  await switchAtmosphere(page, 'night');
  await settled(page);
  const night = await lights();
  for (const id of LAMPS) {
    expect(night.states[id].visibility, `${id}: the night atmosphere has to turn it on`).toBe('visible');
    expect(night.states[id].filter, `${id}: a lamp over a block the lens hides would hang in the air`).toEqual(lampFilterFor(id, night.gridFilter));
  }
  expect(Object.keys(night.bands).sort(), 'all six density rungs on screen').toEqual(['0', '1', '2', '3', '4', '5']);
  expect(Object.keys(night.temperatures).sort(), 'all three colour temperatures on screen').toEqual(['0', '1', '2']);
  // V7's colour budget read off the blocks actually in the frame, not off the constants the deal is written in: eight
  // in ten of the lit ones burn one of the two warm ends, two in ten the cool white of an office slab, and about a
  // ninth of every block on screen burns nothing at all. The bands are wide enough to be a sample rather than a coin
  // flip - ~1,800 blocks on screen puts the scatter at a couple of points - and narrow enough that the even 33/33/33
  // this replaced, or a deal that forgot the dark slice, cannot fit inside them.
  const litBlocks = night.blocks - night.darks;
  const warmShare = ((night.temperatures[0] ?? 0) + (night.temperatures[1] ?? 0)) / litBlocks;
  const coolShare = (night.temperatures[2] ?? 0) / litBlocks;
  expect(night.blocks, 'too few blocks on screen to read a distribution off').toBeGreaterThan(400);
  expect(warmShare, `${(warmShare * 100).toFixed(1)}% of the lit blocks on screen burn warm: V7 asks for 80%`)
    .toBeGreaterThanOrEqual(0.75);
  expect(warmShare, 'and the even three-way split this replaced was 66.7% warm').toBeLessThanOrEqual(0.85);
  expect(coolShare, `${(coolShare * 100).toFixed(1)}% burn cool: V7 asks for 20%`).toBeGreaterThanOrEqual(0.15);
  expect(coolShare, 'and 33.3% cool is the flatness the brief names').toBeLessThanOrEqual(0.25);
  const darkShare = night.darks / night.blocks;
  expect(darkShare, `${(darkShare * 100).toFixed(1)}% of the blocks on screen are switched off: V7 asks for ~10%`)
    .toBeGreaterThanOrEqual(0.06);
  expect(darkShare, 'and a city where every building is lit is the read this is here to break').toBeLessThanOrEqual(0.13);
  expect(Object.keys(night.rings).sort(), 'all three distance rings on screen').toEqual(['0', '1', '2']);
  expect(Object.keys(night.combos).sort(), 'every rung has to meet every colour at every distance in the frame')
    .toEqual(BANDS.flatMap(band => [0, 1, 2].flatMap(temperature => [0, 1, 2].map(ring => `${band}-${temperature}-${ring}`))).sort());
  expect(Math.min(...Object.values(night.pairs)), 'a band-colour pair with three buildings in it is not a check').toBeGreaterThanOrEqual(3);
  expect(Math.min(...Object.values(night.densities)), 'and the same across the height and distance ladders together')
    .toBeGreaterThanOrEqual(3);
  expect(night.heights[5], 'the top rung has to actually reach the towers').toBeGreaterThanOrEqual(100);
  expect(night.heights[4], 'and its tier twin too').toBeGreaterThanOrEqual(100);
  expect(night.heights[0], 'the first rung has to stay under the first step').toBeLessThan(24);
  expect(night.heights[1], 'and so does the rung its dice put beside it').toBeLessThan(24);
  // The dice has to be visible on the frame: both rows of every tier populated, and in numbers that can be compared -
  // measured on 1,754 blocks, the rungs come out 524/630, 159/189 and 51/49, so a single count per height class is
  // not what the frame shows.
  for (const tier of [0, 1, 2]) {
    const [sparse, dense] = [night.bands[tier * 2] ?? 0, night.bands[tier * 2 + 1] ?? 0];
    expect(sparse && dense, `tier ${tier}: one of its two densities is empty (${sparse}/${dense}), so the dice deals nothing`).toBeTruthy();
    expect(dense / sparse, `tier ${tier}: its two rows come out ${sparse}/${dense}, which is a ladder, not a dice`)
      .toBeGreaterThanOrEqual(0.4);
    expect(dense / sparse, `tier ${tier}: the same, the other way round`).toBeLessThanOrEqual(2.5);
  }
  expect(night.distances[0].max, 'the near ring has to stop at its own threshold').toBeLessThan(1500);
  expect(night.distances[2].min, 'and the far ring has to start at its own').toBeGreaterThanOrEqual(2400);

  // The pixel claim: on a wall outside the tower, the lamps and their spill are the only difference from the same frame
  // with both layers hidden.
  await dimTraffic();
  const clip = await findWall();
  expect(clip, 'no wall is dressed by the lamps').not.toBeNull();
  const litFrame = await reference(() => shot(clip));
  await hide(false);
  const bareFrame = await reference(() => shot(clip));
  const bare = await analyse(bareFrame, bareFrame);
  expect(bare.warm, 'the wall by itself is not warm at night, so the claim below is about the lamps').toBe(0);
  expect(bare.maxRB, 'a bare night wall leans blue').toBeLessThan(0);
  await hide(true);
  await painted();
  const lit = await analyse(bareFrame, litFrame);
  expect(lit.changed, 'the lamps never reach the screen').toBeGreaterThan(clip.width * clip.height * 0.03);
  expect(lit.maxDelta, 'a lamp has to land brighter than one light level').toBeGreaterThan(40);
  expect(lit.warmUp, 'the amber end of the range has to reach the screen').toBeGreaterThan(clip.width * clip.height * 0.005);
  expect(lit.coolUp, 'so has the cool end: one amber everywhere is the flatness this step replaced').toBeGreaterThan(clip.width * clip.height * 0.005);
  await expect.poll(() => shot(clip), { message: 'hiding and showing the lamps must not drift the frame', timeout: 20000 }).toEqual(litFrame);
  await page.screenshot({ path: '/tmp/canton-lights-night.png' });
  // Spill on its own, with the crisp windows taken away: it has to move pixels by itself, or the second layer is
  // decoration that never reaches the screen and the claim above was all lamps.
  await mutate('m => m.setLayoutProperty("building-lights", "visibility", "none")');
  const spill = await analyse(bareFrame, await reference(() => shot(clip)));
  expect(spill.moved, 'the spill layer adds nothing to the frame').toBeGreaterThan(clip.width * clip.height * 0.05);
  expect(spill.warmSoft + spill.coolSoft, 'and it has to add light, not just noise').toBeGreaterThan(clip.width * clip.height * 0.05);
  await mutate('m => m.setLayoutProperty("building-lights", "visibility", "visible")');
  await expect.poll(() => shot(clip), { message: 'the spill injection has to be reversible', timeout: 20000 }).toEqual(litFrame);
  // The distance ladder has to be worth something on the screen and not only in the constants, so the same wall is
  // dressed twice with two tiles that differ in nothing else: band 2, sodium amber, nine windows, near ring against far
  // ring. Anything but a dimmer far tile leaves this frame brighter than the last.
  const ladder = day.states['building-lights'].pattern;
  const nearTile = await reference(async () => {
    await mutate('m => m.setPaintProperty("building-lights", "fill-extrusion-pattern", "building-lights-2-0-0")');
    return shot(clip);
  });
  const farTile = await reference(async () => {
    await mutate('m => m.setPaintProperty("building-lights", "fill-extrusion-pattern", "building-lights-2-0-2")');
    return shot(clip);
  });
  const step = await analyse(nearTile, farTile);
  expect(step.dimmed, 'the far ring is not dimmer on the screen').toBeGreaterThan(clip.width * clip.height * 0.05);
  expect(step.maxDelta, 'and it has to be dimmer by more than one light level').toBeGreaterThan(20);
  await mutate(`m => m.setPaintProperty("building-lights", "fill-extrusion-pattern", ${JSON.stringify(ladder)})`);
  await expect.poll(() => shot(clip), { message: 'the ring injection has to be reversible', timeout: 20000 }).toEqual(litFrame);

  // The atmosphere gate has to be load-bearing: the same wall, the same camera, the same filter, and the only thing
  // changed is the switch. It runs here rather than after the lens block because the height lens flies the camera out to
  // zoom 13, where these layers' own minzoom 14 leaves no wall left to measure -- a byte comparison over bare ground
  // would come out the same whether the lamps are on or not. Every frame used as a reference is a settled one.
  await switchAtmosphere(page, 'day');
  await settled(page);
  const dayFrame = await reference(() => shot(clip));
  expect(await both(), 'day has to switch every lamp layer and its spill off again').toEqual(LAMPS.map(() => 'none'));
  await hide(true);
  // The renderer has to answer with these layers in what it drew before the pixels are worth reading.
  await painted();
  const forced = await analyse(dayFrame, await reference(() => shot(clip)));
  // Measured on this patch: the bare terracotta wall moves no pixel by 40 against itself, and the same patch with both
  // layers forced on carries thousands. A hundredth of the patch is well under what the lamps deliver.
  expect(forced.changed, 'lamps forced into a day scene have to move the wall past any drift')
    .toBeGreaterThan(clip.width * clip.height * 0.01);
  expect(forced.warmUp, 'and the warm end of them has to show').toBeGreaterThan(clip.width * clip.height * 0.005);
  await hide(false);
  await expect.poll(() => shot(clip), { message: 'the injection has to be reversible', timeout: 20000 }).toEqual(dayFrame);

  // The lens owns the wall colour, so the lamps and their spill stand down with the grid.
  await switchAtmosphere(page, 'night');
  await settled(page);
  await page.locator('[data-lens-mode="height"]').click();
  await expect.poll(() => both(), 'the height lens must drop the lamps').toEqual(LAMPS.map(() => 'none'));
  await page.locator('[data-lens-mode="use"]').click();
  await expect.poll(() => both()).toEqual(LAMPS.map(() => 'visible'));
  await page.locator('[data-building-category="residential"]').click();
  await settled(page);
  const filtered = await lights();
  for (const id of LAMPS) {
    expect(filtered.states[id].filter, `${id}: lamps over a block the lens hides would hang in the air`).toEqual(lampFilterFor(id, filtered.gridFilter));
  }
  expect(JSON.stringify(filtered.states['building-lights'].filter)).toContain('residential');
  await page.locator('#lens-reset').click();
  await settled(page);
  const reset = await lights();
  for (const id of LAMPS) {
    expect(reset.states[id].filter).toEqual(lampFilterFor(id, reset.gridFilter));
  }
  expect(JSON.stringify(reset.states['building-lights'].filter)).not.toContain('residential');
  expect(errors).toEqual([]);
});

// The pitch is a tile axis, so a test that only reads the constants back cannot tell whether the finer grid ever
// reaches the wall: the step is refused in silence, the family is renamed in silence, the tiles are uploaded and never
// sampled. This one grades the same wall three times at the same camera - the shipped expression, the shipped
// expression pinned to the far branch, and pinned to the near branch - and counts the lit windows it can see. Forcing
// a branch is also the injection: whatever the swap is doing at a zoom, the two pinned frames disagree with each
// other, so a claim that ships only ever agrees with one of them.
test('the finer window grid takes over the wall at zoom 16, and the opening frame keeps the pitch it was tuned to', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expectUseLens(page);
  // Only the four window layers are pinned and switched off here; the spill keeps whatever the shipped expression gives
  // it at that camera. It is the same in every reading of the same camera, so it cancels out of the lit-against-bare
  // difference - and if it were pinned too, its own two families would be the thing that made the frames disagree, and
  // a build whose *windows* never swap grids would pass. This test is about windows.
  const PINED = ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt'];
  await switchAtmosphere(page, 'night');
  await settled(page);
  const jump = async (zoom) => {
    await page.evaluate(async (camera) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      neighborhood.map.jumpTo(camera);
      await new Promise((resolve) => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
    }, { center: [113.324482, 23.110543], zoom, pitch: 62, bearing: 195 });
    await settled(page);
    await repainted(page);
  };
  // A wall the lamps are dressed, outside the tower's own shaft, found again at each camera.
  const findWall = () => page.evaluate(async (PINED) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const at = (x, y, ids) => map.queryRenderedFeatures([[x - 1, y - 1], [x + 1, y + 1]], { layers: ids }).length > 0;
    const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
    const ring = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] }).flatMap((f) => f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : []);
    const points = ring.map(([lng, lat]) => map.project([lng, lat]));
    const shaft = points.length ? {
      left: Math.min(...points.map((p) => p.x)) - 90, right: Math.max(...points.map((p) => p.x)) + 90,
      top: Math.max(0, Math.min(...points.map((p) => p.y)) - 460), bottom: Math.max(...points.map((p) => p.y)),
    } : null;
    const W = 120, H = 60;
    const dry = (x, y) => at(x, y, PINED) && at(x, y, ['neighborhood-buildings'])
      && !at(x, y, ['river-surface']) && !at(x, y, ['water'])
      && (!shaft || x < shaft.left || x > shaft.right || y < shaft.top || y > shaft.bottom);
    for (let y = 200; y + H < innerHeight - 250; y += 16) for (let x = 340; x + W < innerWidth - 30; x += 16) {
      let hit = true;
      for (const r of [6, H / 2, H - 6]) for (const c of [6, W / 4, W / 2, 3 * W / 4, W - 6]) if (!dry(x + c, y + r) || !clear(x + c, y + r)) hit = false;
      if (hit) return { x, y, width: W, height: H };
    }
    return null;
  }, PINED);
  // Pin the four window layers' patterns to one branch of the step, or hand the shipped expression back.
  const pin = (mode) => page.evaluate(async ({ mode, PINED }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { map } = neighborhood;
    if (!map.__pitch) map.__pitch = Object.fromEntries(PINED.map((id) => [id, JSON.parse(JSON.stringify(map.getPaintProperty(id, 'fill-extrusion-pattern')))]));
    for (const id of PINED) {
      const saved = map.__pitch[id];
      map.setPaintProperty(id, 'fill-extrusion-pattern',
        mode === 'shipped' ? saved : mode === 'far' ? saved[2] : saved[4]);
    }
    map.triggerRepaint();
    await new Promise((resolve) => { map.once('idle', resolve); setTimeout(resolve, 8000); });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { alive: PINED.filter((id) => map.getLayer(id)).length, pinned: PINED.filter((id) => !Array.isArray(map.getPaintProperty(id, 'fill-extrusion-pattern')) ||
      map.getPaintProperty(id, 'fill-extrusion-pattern')[0] === (mode === 'shipped' ? 'step' : 'case')).length };
  }, { mode, PINED });
  const shot = async (clip) => (await page.screenshot({ clip })).toString('base64');
  const hide = (on) => page.evaluate(async ({ on, PINED }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    for (const id of PINED) neighborhood.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    neighborhood.map.triggerRepaint();
    await new Promise((resolve) => { neighborhood.map.once('idle', resolve); setTimeout(resolve, 8000); });
  }, { on, PINED });
  // Lit windows counted as connected blobs, from the same wall with the lamps on and off: a smaller pane is more blobs
  // of smaller area, and nothing else about the frame has to be believed.
  const panes = (lit, bare) => page.evaluate(async ({ lit, bare }) => {
    const load = async (encoded) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    };
    const a = await load(lit), b = await load(bare);
    const { width: w, height: h } = a, n = w * h;
    const mask = new Uint8Array(n), luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const light = new Float32Array(n);
    let strongest = 0;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const delta = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (delta > 30) mask[p] = 1;
      strongest = Math.max(strongest, delta);
      light[p] = luma(a.data, i);
    }
    const seen = new Uint8Array(n), stack = new Int32Array(n), sizes = [];
    let pixels = 0;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || seen[start]) continue;
      seen[start] = 1; let top = 0, size = 0; stack[top++] = start;
      while (top) {
        const p = stack[--top]; size++;
        const x = p % w, y = (p / w) | 0;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
          if (q >= 0 && mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
        }
      }
      sizes.push(size); pixels += size;
    }
    sizes.sort((x, y) => x - y);
    const sorted = [...light].sort((x, y) => x - y);
    return { blobs: sizes.length, pixels, median: sizes.length ? sizes[sizes.length >> 1] : 0,
      p90: sizes.length ? sizes[Math.floor(sizes.length * 0.9)] : 0,
      wallMedian: Math.round(sorted[n >> 1] * 10) / 10, strongest };
  }, { lit, bare });
  const read = async (clip) => {
    await hide(false);
    const bare = await shot(clip);
    await hide(true);
    await repainted(page);
    return panes(await shot(clip), bare);
  };

  const frames = {};
  for (const zoom of [15.5, 16.5]) {
    await jump(zoom);
    const clip = await findWall();
    expect(clip, `zoom ${zoom}: no wall is dressed by the lamps, so there is nothing to measure`).not.toBeNull();
    const read2 = {};
    for (const mode of ['shipped', 'far', 'near']) {
      const pinned = await pin(mode);
      expect(pinned, `zoom ${zoom} / ${mode}: pinning a branch must leave every lamp layer on the map`).toEqual({ alive: PINED.length, pinned: PINED.length });
      read2[mode] = await read(clip);
    }
    frames[zoom] = read2;
    await pin('shipped');
  }
  const hero = frames[15.5], fine = frames[16.5];
  // The opening frame is the frame this scene was tuned on: at 15.5 the shipped expression answers with the far branch
  // window for window, and the near branch - which measured 154 lit pixels against 641 on this wall - does not.
  expect([hero.shipped.blobs, hero.shipped.median], 'zoom 15.5: the opening frame is not the shipped grid any more').toEqual([hero.far.blobs, hero.far.median]);
  expect(hero.shipped.blobs, 'and the finer grid really does dissolve at that camera, which is why it is not the default')
    .not.toBe(hero.near.blobs);
  expect(hero.near.pixels, 'the finer panes are averaged into the wall at 15.5').toBeLessThan(hero.far.pixels);
  // Past the swap the same test runs the other way round: the shipped expression answers with the near family, and the
  // wall it answers with is busier and made of smaller windows than the one it left behind.
  expect([fine.shipped.blobs, fine.shipped.median], 'zoom 16.5: the finer grid never reached the screen').toEqual([fine.near.blobs, fine.near.median]);
  expect(fine.shipped.blobs, 'zoom 16.5: and the shipped grid it replaced was coarser').not.toBe(fine.far.blobs);
  expect(fine.shipped.blobs).toBeGreaterThan(fine.far.blobs);
  expect(fine.shipped.median).toBeLessThan(fine.far.median);
  expect(fine.far.blobs, 'the two branches have to disagree with each other somewhere, or the three readings prove nothing')
    .not.toBe(fine.near.blobs);
  // Swapping the pitch may not swap the light: the same wall, the same camera and the same layer opacity read the same
  // brightness whichever family is on it, within the noise of a different window layout.
  for (const [zoom, row] of Object.entries(frames)) {
    expect(Math.abs(row.shipped.wallMedian - row.far.wallMedian), `zoom ${zoom}: the swap repaints the wall itself, not only the windows`)
      .toBeLessThan(4);
  }
  expect(errors).toEqual([]);
});

test('procedural river surface: a screen-space tile pinned above the basemap water, one per atmosphere', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await expectUseLens(page);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.jumpTo({ center: [113.3205, 23.1105], zoom: 15.5, pitch: 58, bearing: -12 });
  });
  await settled(page);
  const river = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const layer = id => map.getStyle().layers.find(l => l.id === id);
    const order = map.getStyle().layers.map(l => l.id);
    const images = {};
    for (const name of map.listImages().filter(n => n.indexOf('river-surface-') === 0).sort()) {
      const { data: tile } = map.getImage(name);
      const pixels = tile.width * tile.height;
      let clear = 0, opaque = 0;
      const alphas = new Set();
      for (let p = 3; p < tile.data.length; p += 4) {
        if (!tile.data[p]) clear++;
        if (tile.data[p] === 255) opaque++;
        alphas.add(tile.data[p]);
      }
      images[name] = { width: tile.width, height: tile.height, bytes: tile.data.length, pixels, clearShare: Math.round(clear / pixels * 100) / 100, opaque, alphas: [...alphas].sort((a, b) => a - b) };
    }
    return {
      images,
      afterWater: order.indexOf('river-surface') - order.indexOf('water'),
      beforeBridges: order.indexOf('bridge_motorway') - order.indexOf('river-surface'),
      beforeLabels: order.indexOf('water_name_point_label') - order.indexOf('river-surface'),
      beforeWalls: order.indexOf('neighborhood-buildings') - order.indexOf('river-surface'),
      pattern: layer('river-surface').paint['fill-pattern'],
      color: layer('river-surface').paint['fill-color'] ?? null,
      opacity: layer('river-surface').paint['fill-opacity'],
      visibility: layer('river-surface').layout?.visibility ?? 'visible',
      filter: map.getFilter('river-surface') ?? null,
      waterColor: layer('water').paint['fill-color'] ?? null,
      minzoom: layer('river-surface').minzoom ?? 0,
    };
  });
  const frame = await river();
  expect(Object.keys(frame.images)).toEqual(['river-surface-day', 'river-surface-night', 'river-surface-sunset']);
  for (const [name, image] of Object.entries(frame.images)) {
    expect([image.width, image.height, image.pixels, image.bytes], name).toEqual([64, 64, 4096, 16384]);
    expect(image.opaque, `${name}: an opaque pixel would repaint the river instead of dressing it`).toBe(0);
    expect(image.clearShare, `${name}: the water has to stay the majority of the tile`).toBeGreaterThan(0.6);
    expect(image.alphas[0], `${name}: the ground of the tile is fully transparent`).toBe(0);
    expect(image.alphas.length, `${name}: one alpha per material`).toBeLessThanOrEqual(3);
  }
  expect(frame.afterWater, 'the sheen is pinned to the river polygon, so it must sit directly above it').toBe(1);
  expect(frame.beforeBridges, 'a bridge deck drawn under the sheen would look painted over').toBeGreaterThan(0);
  expect(frame.beforeLabels, 'a river name has to stay readable through the sheen').toBeGreaterThan(0);
  expect(frame.beforeWalls, 'the volumes have to stand in front of the water').toBeGreaterThan(0);
  expect(frame.color, 'MapLibre ignores a colour on a patterned layer, so this layer must not claim one').toBeNull();
  expect(frame.waterColor, 'the per-atmosphere river colour has to keep coming from the layer underneath').not.toBeNull();
  expect(frame.opacity).toEqual(['interpolate', ['linear'], ['zoom'], 12, 0.4, 14, 0.72, 18.5, 0.72]);
  // Measured: a 2D fill-pattern prints one image pixel per screen pixel at every zoom, so unlike the wall grid -- which
  // tiles in metres and had to wait until zoom 14 -- this tile never becomes sub-pixel and needs no zoom floor.
  expect(frame.minzoom, 'a screen-space tile keeps its size as the camera pulls in, so it cannot need a zoom floor').toBe(0);
  expect(frame.filter, 'the river is not data, so no lens may filter it').toBeNull();
  expect(frame.pattern).toBe('river-surface-day');

  // Which tile is hung is the atmosphere's decision alone.
  for (const theme of ['night', 'sunset', 'day']) {
    await switchAtmosphere(page, theme);
    await expect.poll(async () => (await river()).pattern, `${theme} tile`).toBe(`river-surface-${theme}`);
  }
  await switchAtmosphere(page, 'night');
  const night = await river();
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.setPaintProperty('river-surface', 'fill-pattern', 'river-surface-day');
  });
  const injected = await river();
  expect(injected.pattern, 'a tile that ignores the atmosphere must fail this contract').not.toBe(night.pattern);
  expect({ ...injected, pattern: null }, 'the injected tile must be the only thing that changed')
    .toEqual({ ...night, pattern: null });
  await switchAtmosphere(page, 'day');
  await expect.poll(async () => (await river()).pattern).toBe('river-surface-day');

  // The sheen lies on water and nowhere else: every sampled pixel it covers has to be the basemap river underneath,
  // and land has to stay out of it -- a gloss over a bank or a plaza is a painting error, not a texture.
  const coverage = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    let samples = 0, sheen = 0, onWater = 0;
    const hits = [];
    const at = (x, y, id) => map.queryRenderedFeatures([[x - 1, y - 1], [x + 1, y + 1]], { layers: [id] }).length > 0;
    for (let y = 200; y < map.getCanvas().clientHeight - 60; y += 8) for (let x = 20; x < map.getCanvas().clientWidth - 20; x += 8) {
      samples++;
      if (!at(x, y, 'river-surface')) continue;
      sheen++;
      if (at(x, y, 'water')) onWater++;
      hits.push([x, y]);
    }
    const mid = hits[Math.floor(hits.length / 2)];
    const clear = (x, y) => map.queryRenderedFeatures([[x, y], [x + 300, y + 48]], { layers: ['neighborhood-buildings', 'canton-tower-hit'] }).length === 0;
    let clip = null;
    if (mid) for (const [dx, dy] of [[0, 0], [60, 0], [-60, 0], [0, 24], [0, -24], [120, 0], [-120, 0]]) {
      const x = mid[0] + dx, y = mid[1] + dy;
      if (x < 20 || y < 60 || x + 300 > map.getCanvas().clientWidth - 20 || y + 48 > map.getCanvas().clientHeight - 60) continue;
      if (!clear(x, y)) continue;
      if ([0, 24, 48].every(r => [0, 50, 100, 150, 200, 250, 300].every(c => at(x + c, y + r, 'river-surface')))) {
        clip = { x, y, width: 301, height: 49 };
        break;
      }
    }
    return { samples, sheen, onWater, clip };
  });
  expect(coverage.sheen, 'the tile never reaches the screen').toBeGreaterThan(200);
  expect(coverage.onWater, 'a sheen pixel that is not on the river polygon is painted on land').toBe(coverage.sheen);
  expect(coverage.sheen, 'the whole viewport cannot be river').toBeLessThan(coverage.samples);
  expect(coverage.clip, 'no water-only window of 300x48 is on screen').not.toBeNull();

  // And it does reach the screen: two shots of the same window are byte-identical, so the only difference a toggle can
  // cause is the texture itself -- the off state is the mutant this contract rejects.
  const shot = () => page.screenshot({ clip: coverage.clip });
  await repainted(page);
  const onFirst = await shot();
  const onSecond = await shot();
  expect(Buffer.compare(onFirst, onSecond), 'a live camera makes the pixel proof meaningless; the scene has to be idle').toBe(0);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.setLayoutProperty('river-surface', 'visibility', 'none');
  });
  await repainted(page);
  const off = await shot();
  expect(Buffer.compare(onFirst, off), 'a texture that never paints the river is not a texture').not.toBe(0);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.setLayoutProperty('river-surface', 'visibility', 'visible');
  });
  await repainted(page);
  expect(Buffer.compare(await shot(), onFirst), 'hiding the sheen must be reversible').toBe(0);
  await page.screenshot({ path: '/tmp/canton-river-day.png' });

  // Water is not data: the lens repaints the walls and the cards, and the river keeps its sheen.
  const pick = await page.evaluate(async (clip) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return { x: clip.x + 150, y: clip.y + 24 };
  }, coverage.clip);
  await page.mouse.click(pick.x, pick.y);
  await expect(page.locator('.building-card')).toHaveCount(0);
  await page.locator('[data-lens-mode="height"]').click();
  await settled(page);
  const lensed = await river();
  expect(lensed.visibility, 'the height lens repaints walls, not the river').toBe('visible');
  expect(lensed.pattern, 'the sheen has to survive the lens').toBe('river-surface-day');
  expect(lensed.filter, 'no lens filter may reach the river').toBeNull();
  await page.locator('[data-building-category="residential"]').click();
  await settled(page);
  const filtered = await river();
  expect(filtered.filter, 'filtering the blocks cannot filter the water').toBeNull();
  await page.locator('#lens-reset').click();
  await settled(page);
  expect((await river()).filter).toBeNull();

  // The overlay contract has to be a live assertion, so each of its failure modes is injected and rejected. This runs
  // last on purpose: it leaves the sheen wearing a colour MapLibre would ignore, opaque, and moved under the river.
  const mutate = (fn) => page.evaluate(async ({ fn }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    new Function('map', `return (${fn})(map)`)(neighborhood.map);
  }, { fn });
  const before = await river();
  expect(before.color, 'the sheen layer starts without a colour').toBeNull();
  await mutate('m => m.moveLayer("river-surface", "water")');
  expect((await river()).afterWater, 'a sheen drawn under the river polygon is hidden by it').toBeLessThan(before.afterWater);
  await mutate('m => m.moveLayer("river-surface", "landcover_sand")');
  expect((await river()).afterWater, 'the move must be reversible').toBe(before.afterWater);
  await mutate('m => m.setPaintProperty("river-surface", "fill-color", "#ff0000")');
  expect((await river()).color, 'a colour claimed on a patterned layer would be silently ignored by MapLibre').not.toBeNull();
  await mutate('m => m.setPaintProperty("river-surface", "fill-opacity", 1)');
  expect((await river()).opacity, 'an opaque sheen would replace the river colour instead of dressing it').not.toEqual(before.opacity);
  await mutate('m => m.setPaintProperty("river-surface", "fill-pattern", "building-facade-day")');
  expect((await river()).pattern, 'the wall grid is a metre-space texture and cannot stand in for the river').toBe('building-facade-day');
  expect(errors).toEqual([]);
});

// The motion loop is the only thing in this scene that redraws by itself, so its contract is written in pixels: the
// water has to move, the light has to swell and settle, and everything else on screen has to stay exactly as shipped.
// A frame count from `motionStatus` would only prove the loop woke up, so each claim below is graded against a
// screenshot -- and then against an injected mutant that removes the very write being claimed.
test('river scroll and tower breath move nothing else, and stopping hands back the shipped frame', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const status = () => page.evaluate(async () => (await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src)).neighborhood.motionStatus());
  // The street lights are the third write on this loop, and they are frozen for the whole of it. A write is also a
  // repaint request, and a repaint advances the basemap's own pattern fade by a step, so no byte-for-byte claim about
  // the other two can be graded while a third one is asking for frames. Their own contract - dark by day, marching
  // twice a second by night, stopped by the switch - is graded by the test that follows this one.
  const freezeTraffic = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    if (map.__paint) return;
    map.__paint = map.setPaintProperty.bind(map);
    map.setPaintProperty = (layer, property, value) => {
      if (['traffic-flow', 'traffic-tail'].includes(layer) && property === 'line-dasharray') return;
      map.__paint(layer, property, value);
    };
  });
  const windows = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const canvas = map.getCanvas();
    // The intro column owns the left third of the frame, so every window is sought to the right of it: text is static
    // and would dilute a difference rather than fake one, but a crop of it is not a picture of the river.
    const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
    const at = (x, y, ids) => map.queryRenderedFeatures([[x - 1, y - 1], [x + 1, y + 1]], { layers: ids }).length > 0;
    const inBox = (box, ids) => map.queryRenderedFeatures(box, { layers: ids }).length > 0;
    const sweep = (w, h, wants) => {
      for (let y = 200; y + h < canvas.clientHeight - 70; y += 8) for (let x = 320; x + w < canvas.clientWidth - 20; x += 8) {
        const grid = [];
        for (const r of [4, h / 2, h - 4]) for (const c of [4, w / 4, w / 2, 3 * w / 4, w - 4]) grid.push([x + c, y + r]);
        if (grid.every(([px, py]) => wants(px, py) && clear(px, py))) return { x, y, width: w, height: h };
      }
      return null;
    };
    const ring = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] }).flatMap(f => f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : []);
    const points = ring.map(([lng, lat]) => map.project([lng, lat]));
    const tower = points.length ? { x: Math.round(points.reduce((s, p) => s + p.x, 0) / points.length - 55), y: Math.round(Math.max(...points.map(p => p.y)) - 320), width: 110, height: 300 } : null;
    // Neither window may touch the tower's own screen box: its light is the other thing the loop moves, and a river
    // window whose right edge grazed the lattice was measuring the breath and calling it the water. The test is on the
    // window rectangle itself, because a pad on the centre point still lets a 160 px box overhang the tower.
    const misses = (x, y, width, height) => !tower
      || x + width < tower.x || x > tower.x + tower.width || y + height < tower.y || y > tower.y + tower.height;
    const river = sweep(160, 64, (x, y) => at(x, y, ['river-surface']) && at(x, y, ['water']) && misses(x, y, 160, 64));
    // The shaft is the invisible 450 m extrusion's own footprint lifted off the ground, so the window follows the
    // tower wherever the camera puts it instead of trusting a remembered pair of pixels.

    // A control only has to be free of what the loop is allowed to move: the water, the tower's own screen box, the
    // marching street lights - and, since the night axis, the landmark shells, whose crowns breathe and whose tops
    // blink. The band is static and stays admissible -- which is taller than the footprint, so the
    // shaft is excluded by the rectangle rather than by the base ring.
    // It also has to be dry across the whole rectangle, not just where it was sampled: the first window this test
    // accepted had the river running through its lower half, and the water duly moved the "land".
    // 这里**不能**把 `building-facade` 也列进来：夜景里默认机位上凡是楼多的一块地几乎都压着窗格，试过之后
    // `windows()` 直接找不到陆地那一格（`page.screenshot: clip: expected object, got null`，8 次全红）。
    // 窗格会跟着动这件事改在下面那格陆地读之前处理（冻住水面图块上传）。
    const MOVERS = ['river-surface', 'water', 'traffic-flow', 'traffic-tail', 'landmark-forms-hit'];
    // 查的是**候选窗口本身**那 160×64。原来写的是 `[[x-84,y-36],[x+84,y+36]]`——那是从左上角偏出去的半格，
    // 窗口右下三格根本没查，所以"陆地"格子里可以躺着在走的灯带：2026-10-10 用一次性探针抓到过一次整格
    // 1210 个像素在变，名单里就明明白白写着 `traffic-flow` 与 `traffic-tail`。
    const dry = sweep(160, 64, (x, y) => {
      if (inBox([[x, y], [x + 160, y + 64]], MOVERS)) return false;
      return misses(x, y, 160, 64);
    });
    return { river, dry, tower };
  });
  const still = async (clip, count, gapMs) => {
    const frames = [];
    for (let i = 0; i < count; i++) { frames.push(await page.screenshot({ clip })); await page.waitForTimeout(gapMs); }
    return frames;
  };
  const moved = frames => frames.slice(1).filter((frame, i) => Buffer.compare(frame, frames[i]) !== 0).length;
  /**
   * 逐字节判据红了要能一次定性：差多少颗、包围盒在哪、那些点上样式里在画哪些图层（与"逐字节判据失败要报
   * 颗数＋包围盒＋底下图层"同一条口径）。截图在页内解码，因为 Node 侧没有 PNG 解码器，而 `pngjs` 不是这个项目的依赖。
   */
  const movedWhere = async (clip, count) => {
    const frames = await still(clip, count, 260);
    return page.evaluate(async ({ clip, shots }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = neighborhood.map;
      const load = (b64) => new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          resolve(context.getImageData(0, 0, image.width, image.height));
        };
        image.src = `data:image/png;base64,${b64}`;
      });
      const decoded = [];
      for (const shot of shots) decoded.push(await load(shot));
      let changed = 0;
      const layers = new Set();
      let box = null;
      for (let index = 1; index < decoded.length; index += 1) {
        const a = decoded[index - 1];
        const b = decoded[index];
        for (let y = 0; y < a.height; y += 1) {
          for (let x = 0; x < a.width; x += 1) {
            const at = (a.width * y + x) << 2;
            if (a.data[at] === b.data[at] && a.data[at + 1] === b.data[at + 1] && a.data[at + 2] === b.data[at + 2]) continue;
            changed += 1;
            const px = clip.x + x;
            const py = clip.y + y;
            box = box ? { x0: Math.min(box.x0, px), y0: Math.min(box.y0, py), x1: Math.max(box.x1, px), y1: Math.max(box.y1, py) }
              : { x0: px, y0: py, x1: px, y1: py };
            for (const feature of map.queryRenderedFeatures([px, py])) layers.add(feature.layer.id);
          }
        }
      }
      return { changed, box, layers: [...layers] };
    }, { clip, shots: frames.map((frame) => frame.toString('base64')) }).then((seen) => {
      // 红了就把前后两帧原样留在 /tmp，用看的比再猜一轮快：926 颗是"一片窗格亮了"还是"整块地挪了半像素"，
      // 图上一眼就能分。文件名带序号，最后一次红的那两张覆盖前面的。
      if (seen.changed) frames.forEach((frame, index) => writeFileSync(`/tmp/land-frame-${index}.png`, frame));
      return { ...seen, pairs: moved(frames) };
    });
  };
  const distinct = frames => frames.filter((frame, i) => !frames.slice(0, i).some(earlier => Buffer.compare(earlier, frame) === 0)).length;
  // Handing the scene back is a repaint request, not a synchronous write: the browser has to take one more frame
  // before the picture on screen is the shipped one, so each "stopped equals shipped" check waits for that frame.
  // A window is only worth calling still once the scene has stopped arriving: a tile landing or a pattern fade taking
  // its last step moves one frame and then never moves again, which is not the loop repainting the land.
  const atRest = async (clip) => {
    let last = await page.screenshot({ clip });
    for (let tries = 0; tries < 30; tries++) {
      await page.waitForTimeout(260);
      const now = await page.screenshot({ clip });
      if (Buffer.compare(last, now) === 0) return;
      last = now;
    }
  };
  const landsOn = (clip, frame, why) => expect
    .poll(() => page.screenshot({ clip }).then(pixels => Buffer.compare(pixels, frame)), { message: why, timeout: 15000 })
    .toBe(0);
  const stub = (what) => page.evaluate(async (what) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    if (what === 'image') {
      if (!map.__image) { map.__image = map.updateImage.bind(map); map.updateImage = () => {}; }
      else { map.updateImage = map.__image; delete map.__image; }
      return;
    }
    const layer = map.getLayer('canton-tower').implementation;
    if (what === 'march') {
      // 灯带那两层的虚线推进是**样式写入**，`stub('traffic')` 冻的是三维场景里的车流与行人，管不到它。
      // 2026-10-10 就是这条漏网让"陆地"那一格在夜景里 8 次红 1 次：探针抓到整格 684 个像素在变，
      // 名单里明明白白是 `traffic-flow` 与 `traffic-tail`。这里只挡 `line-dasharray`，别的属性照写。
      if (!map.__march) {
        map.__march = map.setPaintProperty.bind(map);
        map.setPaintProperty = (layer, key, ...rest) => { if (key !== 'line-dasharray') map.__march(layer, key, ...rest); };
      } else {
        map.setPaintProperty = map.__march;
        delete map.__march;
      }
      return;
    }
    if (what === 'lamps') {
      // The window cross-fade is a style write, not a scene write: it goes through global state every tick, and since
      // the night axis shortened its period a group is mid-swap most of the time. It paints windows on the blocks
      // standing behind the tower, so it has to be parked here like the other three.
      if (!map.__state) {
        map.__state = map.setGlobalStateProperty.bind(map);
        map.setGlobalStateProperty = (key, value) => { if (!key.startsWith('lamp-')) map.__state(key, value); };
      } else {
        map.setGlobalStateProperty = map.__state;
        delete map.__state;
      }
      return;
    }
    if (what === 'axis') {
      // The crowns' breath is the one writer left on this clock: the obstruction lamps were cancelled on 2026-10-04 and
      // the bands stopped swaying in V7 A5, so what is parked here is `setBreath` alone.
      if (!layer.__axis) {
        layer.__axis = layer.setBreath.bind(layer);
        layer.setBreath = () => {};
      } else {
        layer.setBreath = layer.__axis;
        delete layer.__axis;
      }
      return;
    }
    if (what === 'pulse') {
      // "The tower's light" is two writes now: the intensity walk and the colour turn. Freezing one and leaving the
      // other running still asks the map for a frame every step, and a frame is enough to move the water's pattern fade.
      if (!layer.__pulse) {
        layer.__pulse = [layer.setPulse.bind(layer), layer.setHue.bind(layer)];
        layer.setPulse = () => {};
        layer.setHue = () => {};
      } else {
        [layer.setPulse, layer.setHue] = layer.__pulse;
        delete layer.__pulse;
      }
      return;
    }
    // The third writer on this loop is the near-field traffic: vehicles and walkers within the field radius of the tower,
    // drawn in this same scene. It has its own test; here it only has to be parked, because a light moving across the
    // tower's own screen box is not the tower breathing.
    if (!layer.__traffic) { layer.__traffic = layer.runTraffic.bind(layer); layer.runTraffic = () => {}; }
    else { layer.runTraffic = layer.__traffic; delete layer.__traffic; }
  }, what);

  // 车与人从 2026-10-05 起在任何氛围里都在画面上了，于是默认机位上再没有一块"圈外、又不发光"的地面：
  // `scripts/probe-window-sweep.mjs` 量的结果是白昼 14 个候选、夜里 0 个（夜里的光轨本就铺到三公里）。
  // 这一条只问江水那一格与塔灯这两笔写入有没有溢出到别处，近场车流有它自己那一条断言，所以整条测试把近场收掉。
  // 2026-10-10 项 1 之后还要把树脚下那一片与楼根那条带一起收掉：它们不动，但它们是新增的半透明贴地面，
  // 一次整套里量到的是"截图撞在一次合成的中间"（3 帧里有 2 帧各差 1-2 个像素，复跑 4 次红 1 次）。
  // 收掉的是这一层新增的边缘，不是被审判的那个面——路面样式本身留在画面里，"动效不许重画陆地"这句话照旧成立。
  const open = async (reduced) => {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await openMap(page);
    await page.evaluate(async () => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const layer = neighborhood.map.getLayer('canton-tower').implementation;
      layer.setTraffic(false);
      layer.setVegetation(false);
      layer.setBases(false);
    });
  };

  // A. A page that is allowed to animate runs by default, and the loop moves the water without touching the ground.
  //    Nothing here compares pixels to a picture taken before the loop ran -- that baseline needs a load that has
  //    never scrolled a row, so it lives in section B.
  await open(false);
  expect(await status(), 'motion is on unless the visitor asks otherwise').toMatchObject({ on: true, available: true, tiles: 3 });
  await expect(page.locator('#motion-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-motion', 'on');
  await expect(page.locator('#atmosphere-controls [aria-pressed="true"]'), 'the switch is not a fourth atmosphere').toHaveCount(1);
  const awake = await windows();
  expect(awake.river, 'no water-only window to watch').not.toBeNull();
  expect(moved(await still(awake.river, 6, 260)), 'the river never moved on screen').toBeGreaterThanOrEqual(4);
  await atRest(awake.dry);
  expect(moved(await still(awake.dry, 3, 260)), 'the loop is repainting land, not water').toBe(0);

  // B. A page that is not allowed to animate opens on the shipped pixels, and the switch says so without joining the
  //    atmosphere group's single pressed option. Every frame the loop is later graded against is taken from this one
  //    load: reloading redraws the same camera a few subpixels apart, and a byte-for-byte claim across loads would
  //    fail for reasons that have nothing to do with the motion loop.
  await open(true);
  expect(await status(), 'a reduced request cannot start the loop').toMatchObject({ on: false, available: true, tiles: 3, phase: 0, steps: 0 });
  await expect(page.locator('#motion-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('body')).toHaveAttribute('data-motion', 'off');
  await freezeTraffic();
  const win = await windows();
  expect(win.river, 'no water-only window to watch').not.toBeNull();
  expect(win.dry, 'no land-only window to prove the loop stays off the ground').not.toBeNull();
  expect(win.tower, 'the tower is not on screen').not.toBeNull();
  const shipped = { river: await page.screenshot({ clip: win.river }) };
  expect(moved(await still(win.river, 3, 250)), 'a reduced page still scrolls the river').toBe(0);
  await switchAtmosphere(page, 'night');
  await settled(page);
  shipped.nightRiver = await page.screenshot({ clip: win.river });
  shipped.nightTower = await page.screenshot({ clip: win.tower });
  shipped.nightDry = await page.screenshot({ clip: win.dry });
  expect(Buffer.compare(shipped.nightRiver, shipped.river), 'night has to wear its own water').not.toBe(0);
  await switchAtmosphere(page, 'day');
  await settled(page);
  expect(Buffer.compare(await page.screenshot({ clip: win.river }), shipped.river), 'a night that never animated still has to hand back the day').toBe(0);

  // C. The visitor lifts the restriction while the page is open. The media query is what gates the loop, so the same
  //    page picks it up without a reload or a click.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(async () => (await status()).on, { message: 'a changed preference does not start the loop', timeout: 5000 }).toBe(true);
  await expect(page.locator('#motion-toggle'), 'the switch never heard about it').toHaveAttribute('aria-checked', 'true');
  expect(moved(await still(win.river, 4, 260)), 'the river never moved after the preference changed').toBeGreaterThanOrEqual(2);

  // D. Stopping is not pausing: the tile goes back to the rows the page shipped with, so no half frame survives.
  await page.locator('#motion-toggle').click();
  expect((await status()).on, 'the switch did not stop the loop').toBe(false);
  await landsOn(win.river, shipped.river, 'stopping mid-scroll leaves a half frame');
  await page.locator('#motion-toggle').click();
  expect(moved(await still(win.river, 4, 260)), 'the switch is not reversible').toBeGreaterThanOrEqual(3);
  await page.locator('#motion-toggle').click();
  for (const id of ['sunset', 'night', 'day']) {
    await switchAtmosphere(page, id);
    await settled(page);
  }
  await landsOn(win.river, shipped.river, 'an atmosphere round trip cannot drift the river');

  // E. The tower light breathes over a night scene, and only the light: the same dry patch stays byte-identical.
  await switchAtmosphere(page, 'night');
  await settled(page);
  await landsOn(win.river, shipped.nightRiver, 'a stopped night scene must be the shipped night scene');
  await landsOn(win.tower, shipped.nightTower, 'a stopped tower must be the shipped lighting');
  await page.locator('#motion-toggle').click();
  const breath = await still(win.tower, 6, 1200);
  expect(distinct(breath), 'the tower light never swelled').toBeGreaterThan(3);
  // There is no ground-stillness claim here on purpose. Section A already grades "the loop moves water, not land"
  // against a day scene, and at night that claim cannot be made byte-for-byte any more: the street lights, the tower's
  // own colour and the beam over the mast all ask for frames, and one frame is enough to advance the basemap's pattern
  // fade across the whole canvas. The land is still checked in section F, with every writer parked.

  // F. Each claim is graded against the mutant that removes it. (`stub` is defined up with the helpers because section E
  //  also needs it: see the ground claim there.) Freezing a write has to freeze the window it owns,
  //    and freezing every write has to leave a running loop that cannot move a single pixel -- which is what proves the
  //    differences above came from those writes rather than from a camera that jitters between screenshots.
  //    The street lights are already frozen for the whole test, so "every write" here means the four the loop gained
  //  since: the river tile, the tower's own light, the near-field traffic, and the night axis (lamps, crowns, band) --
  //  plus the window cross-fade, which writes style state rather than scene state and so is parked by its own stub.
  await stub('traffic');
  await stub('lamps');
  await stub('image');
  expect(moved(await still(win.river, 4, 260)), 'a frozen tile still changed pixels: the river window is not the tile').toBe(0);
  expect(distinct(await still(win.tower, 4, 900)), 'the water is the only thing moving the tower').toBeGreaterThan(1);
  await stub('pulse');
  // Freezing the tower's light still empties this box - the axis lives above and beside it, not inside it - but the
  // band the tower lays on the water does fall in the river window, and the lamps' cross-fade repaints the blocks
  // behind the shaft, so both are parked before anything here is called still. Each of the three channels the axis
  // owns is graded on its own by the night-axis test; this section only needs them silent.
  await stub('axis');
  expect(moved(await still(win.tower, 4, 900)), 'a frozen light still changed pixels: the tower window is not the light').toBe(0);
  expect(moved(await still(win.river, 4, 260)), 'the light is the only thing moving the water').toBe(0);
  expect(moved(await still(win.dry, 4, 260)), 'every write is frozen and the land still moves').toBe(0);
  await stub('axis');
  await stub('pulse');
  await stub('lamps');
  await stub('image');
  await stub('traffic');
  expect(moved(await still(win.river, 4, 260)), 'restoring the tile did not restart the water').toBeGreaterThanOrEqual(2);
  expect(distinct(await still(win.tower, 4, 1200)), 'restoring the light did not restart the swell').toBeGreaterThan(2);

  // G. The switch hands the scene back whole, and the river stays unclickable: no card, no selection, no hash.
  await page.locator('#motion-toggle').click();
  expect((await status()).on).toBe(false);
  await landsOn(win.tower, shipped.nightTower, 'stopping cannot strand the light mid-swell');
  await landsOn(win.river, shipped.nightRiver, 'stopping cannot strand a scrolled row');
  const hash = await page.evaluate(() => location.hash);
  await page.mouse.click(win.river.x + 80, win.river.y + 32);
  await page.waitForTimeout(500);
  await expect(page.locator('body')).not.toHaveAttribute('data-card', 'open');
  await expect(page.locator('.maplibregl-popup-content')).toHaveCount(0);
  expect(await page.evaluate(() => location.hash), 'the river is not an address').toBe(hash);

  // H. The switch itself is a control, so it has to survive the narrow screens the atmosphere pills already serve.
  for (const viewport of [{ width: 1024, height: 768 }, { width: 761, height: 900 }, { width: 568, height: 320 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    const box = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const nav = rect('#scene-nav'), atmo = rect('#atmosphere-controls'), toggle = rect('#motion-toggle');
      return {
        width: Math.round(toggle.width), height: Math.round(toggle.height), right: Math.round(atmo.right),
        visible: document.getElementById('motion-toggle').checkVisibility(),
        gap: Math.round(atmo.left - nav.right), offscreen: atmo.right > innerWidth + 1 || toggle.right > innerWidth + 1,
        hscroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(box.visible, `${viewport.width}: the switch cannot disappear into the header`).toBe(true);
    expect(box.height, `${viewport.width}: the switch is smaller than a thumb`).toBeGreaterThanOrEqual(28);
    expect(box.gap, `${viewport.width}: the switch has eaten the gap beside the scene links`).toBeGreaterThan(0);
    expect(box.offscreen, `${viewport.width}: the header runs off the screen`).toBe(false);
    expect(box.hscroll, `${viewport.width}: the header scrolls the page sideways`).toBe(false);
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await settled(page);
  // Five viewport changes leave the camera at the landscape zoom the header clamps to, so the windows are measured again
  // here instead of reusing crops taken at the default one -- and only once the new tiles are actually on screen,
  // because a query against a river that has not been fetched yet reports no water anywhere.
  let after = null;
  await expect.poll(async () => { after = await windows(); return Boolean(after.river && after.dry); },
    { message: 'no water-only or land-only window left after the header reflowed', timeout: 30000 }).toBe(true);
  // A reflow also lets the camera ease back into place, and a camera in motion changes the ground just as much as the
  // loop would, so the land is only compared once two consecutive shots of it are already identical.
  await expect.poll(async () => still(after.dry, 2, 300).then(frames => Buffer.compare(frames[0], frames[1])),
    { message: 'the camera never came back to rest after the header reflowed', timeout: 20000 }).toBe(0);
  await page.locator('#motion-toggle').click();
  expect((await status()).on, 'a narrow screen must not silently disable the loop').toBe(true);
  expect(moved(await still(after.river, 4, 260)), 'the loop never restarted after the header reflowed').toBeGreaterThanOrEqual(2);
  // 读陆地这一格之前，把循环写在陆地上的两笔冻住：灯带虚线（`stub('march')`，这一轮新加的阀门）与夜景灯窗权重
  // （`stub('lamps')`）。都是量出来的：选窗框改对之后探针又抓到一次整格 684 个像素在变，名单是
  // `traffic-flow`/`traffic-tail`；虚线挡住之后剩下的才是 `building-lights*`/`building-glow*` 那一笔。
  // 上面那句"江水确实动了"是什么都活着的时候读的，这一句问的是"陆地有没有被顺带重画"，两者不冲突；
  // 门槛一字未动：还是连拍三张必须逐字节相同。
  await stub('march');
  await stub('lamps');
  const land = await movedWhere(after.dry, 3);
  expect(land.pairs, `the land moved while the header reflowed：${land.changed} 个像素变了，包围盒 ${JSON.stringify(land.box)}，底下在画的图层 ${JSON.stringify(land.layers)}`).toBe(0);
  await stub('lamps');
  await stub('march');
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/canton-motion-night.png' });
  expect(errors).toEqual([]);
});

// V4 item 9: the night streets. The claim is not that two layers exist - it is that they are dark by day, burning by
// night, and that what moves on the ground at night is the traffic and nothing else, at the two steps a second the
// motion rules set for a stepped property.
test('night traffic burns only at night, marches twice a second, and stops with the switch', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openMap(page);
  const TRAFFIC = ['traffic-band', 'traffic-tail', 'traffic-flow'];
  const read = () => page.evaluate(async (TRAFFIC) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    return {
      visibility: TRAFFIC.map((id) => map.getLayoutProperty(id, 'visibility')),
      dash: JSON.stringify(map.getPaintProperty('traffic-flow', 'line-dasharray')),
      tailDash: JSON.stringify(map.getPaintProperty('traffic-tail', 'line-dasharray')),
      status: neighborhood.motionStatus(),
      // A window with a *marching* street in it: the band is static, so a clip that only catches the band would let a
      // dead loop pass the change claim below.
      street: (() => {
        const canvas = map.getCanvas();
        for (let y = 260; y < canvas.clientHeight - 90; y += 8) {
          for (let x = 360; x < canvas.clientWidth - 200; x += 8) {
            if (!map.queryRenderedFeatures([[x - 40, y - 16], [x + 40, y + 16]], { layers: ['traffic-flow'] }).length) continue;
            const node = document.elementFromPoint(x, y);
            if (node && (node.id === 'map' || node.tagName === 'CANVAS')) return { x: x - 60, y: y - 24, width: 120, height: 48 };
          }
        }
        return null;
      })(),
    };
  }, TRAFFIC);
  const shipped = JSON.stringify([3, 16, 3, 16]);
  const shippedTail = JSON.stringify([2, 54, 2, 54]);
  expect((await read()).dash, 'the flow layer ships on the un-marched pattern').toBe(shipped);
  expect((await read()).tailDash, 'and the tail layer on its own, longer period').toBe(shippedTail);

  for (const id of ['day', 'sunset']) {
    await switchAtmosphere(page, id);
    expect((await read()).visibility, `${id} keeps the streets dark`).toEqual(['none', 'none', 'none']);
  }
  await switchAtmosphere(page, 'night');
  const night = await read();
  expect(night.visibility, 'the night theme turns the streets on').toEqual(['visible', 'visible', 'visible']);
  expect(night.status.on, 'and the loop is running').toBe(true);

  // Watch the dash from inside the page: a Node-side poll would measure its own round trips instead of the march.
  const march = await page.evaluate(async (TRAFFIC) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const seen = [];
    const tails = [];
    await new Promise((resolve) => {
      const began = performance.now();
      const step = () => {
        seen.push(JSON.stringify(neighborhood.map.getPaintProperty('traffic-flow', 'line-dasharray')));
        tails.push(JSON.stringify(neighborhood.map.getPaintProperty('traffic-tail', 'line-dasharray')));
        if (performance.now() - began < 3200) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    const changes = seen.filter((value, index) => index && value !== seen[index - 1]).length;
    return {
      frames: seen.length, distinct: [...new Set(seen)], tailDistinct: [...new Set(tails)],
      changes, marches: neighborhood.motionStatus().marches,
    };
  }, TRAFFIC);
  expect([...march.distinct].sort(), `the march visits ${march.distinct.length} layouts: ${march.distinct.join(' ')}`)
    .toEqual([shipped, '[0.01,9.5,3,16,3,6.5]'].sort());
  expect([...march.tailDistinct].sort(), `the tail marches on its own period: ${march.tailDistinct.join(' ')}`)
    .toEqual([shippedTail, '[0.01,28,2,54,2,26]'].sort());
  expect(march.changes, `it changed ${march.changes} times in 3.2 s - the cap is two a second`).toBeLessThanOrEqual(7);
  expect(march.changes, 'and it actually changed').toBeGreaterThanOrEqual(4);

  const street = (await read()).street;
  expect(street, 'no lit street was on screen to measure').not.toBeNull();
  const apart = async (gapMs) => {
    const first = await page.screenshot({ clip: street });
    await page.waitForTimeout(gapMs);
    return first.equals(await page.screenshot({ clip: street }));
  };
  // The basemap keeps nudging light levels for seconds after the map reports itself idle, so nothing here is claimed
  // until two consecutive shots of the clip already agree. Grading the march against a frame that had come to rest is
  // also what proves the difference below came from the loop rather than from a tile arriving.
  await page.locator('#motion-toggle').click();
  const stopped = await read();
  expect(stopped.status.on, 'the switch stops the loop').toBe(false);
  expect(stopped.dash, 'and hands the pattern back as shipped').toBe(shipped);
  await expect.poll(() => apart(300), { message: 'the street never came to rest', timeout: 40000 }).toBe(true);
  // A 300 ms pair can agree between two tile arrivals, so the stillness claim is graded over the same span the motion
  // claim uses: poll until a whole 1.2 s of stopped loop is genuinely a still picture.
  await expect.poll(() => apart(1200), { message: 'the street kept moving with the loop stopped', timeout: 60000 }).toBe(true);
  await page.locator('#motion-toggle').click();
  expect(await apart(1200), 'a lit street never changed while the traffic marched').toBe(false);

  // The height lens is a data view, so the streets stay out of it the same way the lamp grid does. `setLens` replaces
  // the lens rather than merging into it, which is what the app's own callers pass.
  const useLens = (mode) => page.evaluate(async (mode) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setLens({ ...neighborhood.lens, mode, source: 'all' });
  }, mode);
  await useLens('height');
  await page.waitForTimeout(400);
  expect((await read()).visibility, 'the height lens keeps the traffic out').toEqual(['none', 'none', 'none']);
  await useLens('all');
  await page.waitForTimeout(400);
  expect((await read()).visibility, 'and handing the view back brings them back').toEqual(['visible', 'visible', 'visible']);

  // The school scene has no traffic layers at all, so nothing there can march - and no bridge decks either, since the
  // crossing snapshot is of the river.
  await page.goto(`${appUrl}/?scene=jingtai`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  expect(await page.evaluate(async (TRAFFIC) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return [...TRAFFIC, 'bridge-decks', 'bridge-parapets'].map((id) => Boolean(neighborhood.map.getLayer(id)));
  }, TRAFFIC), 'the school scene grew a street layer').toEqual([false, false, false, false, false]);
  expect(errors).toEqual([]);
});

// The night windows change. `fill-extrusion-pattern` is baked into a tile's bucket when the wall is tessellated, so the
// only thing on this map that can move a window is the layer's opacity - rewriting the image behind the name was proved
// not to reach the screen at all. Two picks of each band's cells therefore cross-fade against each other, in two groups
// of blocks on two periods, which keeps the number of lit windows a block shows constant while the windows themselves
// change. Every claim below is graded with the loop stopped and the weights set by hand, so a frame is a frame.
test('the night windows cross-fade between two picks, hold their density, and hand the shipped frame back', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openMap(page);
  const status = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const motion = neighborhood.motionStatus();
    return { lamps: motion.lamps, ticks: motion.lampTicks, on: motion.on, periods: motion.lampMs };
  });
  const CLIP = { x: 620, y: 300, width: 720, height: 460 };
  const shot = async () => (await page.screenshot({ clip: CLIP })).toString('base64');
  const load = async (encoded) => page.evaluate(async (base64) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, image.width, image.height).data];
  }, encoded);
  // A lit window is a pixel leaning warm; a changed one is a pixel the cross-fade moved. The first number is the
  // density promise and the second is the proof that the swap is not a dimmer.
  const warmOf = async (data) => data.reduce((count, value, index) =>
    index % 4 ? count : (value - data[index + 2] > 20 && value > 40 ? count + 1 : count), 0);
  const movedOf = async (a, b) => {
    const [from, to] = await Promise.all([load(a), load(b)]);
    let moved = 0;
    for (let i = 0; i < from.length; i += 4) {
      if (Math.max(Math.abs(from[i] - to[i]), Math.abs(from[i + 1] - to[i + 1]), Math.abs(from[i + 2] - to[i + 2])) > 8) moved++;
    }
    return moved;
  };
  // 成簇度：最挤的一个 box×box 小窗里同时变了多少颗。像素总数说不出"是一栋楼在暗"还是"全城各换一格"——
  // 两者可以一样多，这个数能。格级换窗时它是 90，1/7 那一撮整栋灭之后实测 290，而它的封顶是一栋楼的墙面积
  // （把整座城的窗连同光晕一起钉灭，这个数也只有 326），所以门槛钉在两者之间：回到"只有格级"就红。
  const clusterOf = async (a, b, box = 24) => {
    const [from, to] = await Promise.all([load(a), load(b)]);
    const width = CLIP.width, height = CLIP.height;
    const changed = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < from.length; i += 4, p++) {
      changed[p] = Math.max(Math.abs(from[i] - to[i]), Math.abs(from[i + 1] - to[i + 1]), Math.abs(from[i + 2] - to[i + 2])) > 8 ? 1 : 0;
    }
    let best = 0;
    for (let top = 0; top + box <= height; top += 6) {
      const column = new Int32Array(width);
      for (let y = top; y < top + box; y++) for (let x = 0; x < width; x++) column[x] += changed[y * width + x];
      for (let left = 0; left + box <= width; left += 6) {
        let count = 0;
        for (let x = left; x < left + box; x++) count += column[x];
        if (count > best) best = count;
      }
    }
    return best;
  };
  // The same count, plus where it is: a byte comparison that fails is only worth something if it can say which
  // element on the screen is the one that did not come back.
  // Which layer is drawn under each differing pixel. The allowance below is only for the water: MapLibre packs pattern
  // images into its atlas and re-samples them per upload history, so a pattern that was `updateImage`d during the
  // session can come back with the same bytes and a hair different rasterisation - stable within one page, different
  // from one page load to the next (measured 143 / 119 / 116 pixels, the same pixels at every look, all of them over
  // `river-surface`/`water`, with the tile bytes, the camera to nine decimals and the three water bands identical).
  // Everything that is not water has to come back exactly.
  const WATER_LAYERS = ['river-surface', 'water'];
  const ALLOWANCE = Math.round(CLIP.width * CLIP.height * 0.001);
  const diffOf = async (a, b) => {
    const [from, to] = await Promise.all([load(a), load(b)]);
    let moved = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const spots = [];
    for (let i = 0; i < from.length; i += 4) {
      if (Math.max(Math.abs(from[i] - to[i]), Math.abs(from[i + 1] - to[i + 1]), Math.abs(from[i + 2] - to[i + 2])) <= 8) continue;
      moved += 1;
      const pixel = i / 4, x = pixel % CLIP.width, y = (pixel / CLIP.width) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (moved <= ALLOWANCE) spots.push([x, y]);
    }
    const box = moved ? [x0, y0, x1, y1] : null;
    if (moved > ALLOWANCE) return { moved, box, offCount: moved, off: [] };
    const classified = moved ? await page.evaluate(async ({ spots, clip, WATER_LAYERS }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = neighborhood.map;
      let water = 0;
      const off = [];
      for (const [x, y] of spots) {
        const hits = map.queryRenderedFeatures([[clip.x + x - 1, clip.y + y - 1], [clip.x + x + 1, clip.y + y + 1]]);
        const ids = [...new Set(hits.map((feature) => feature.layer.id))].sort();
        if (ids.some((id) => WATER_LAYERS.includes(id))) water += 1;
        else if (off.length < 3) off.push(`${x},${y} under ${ids.join('+') || 'nothing'}`);
      }
      return { offCount: spots.length - water, off };
    }, { spots, clip: CLIP, WATER_LAYERS }) : { offCount: 0, off: [] };
    return { moved, box, ...classified };
  };
  // The scene state the claim is actually about: every value the loop writes, read back after it stops.
  const sceneState = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const image = map.getImage('river-surface-night');
    const bytes = Array.from(image.data.data ?? image.data);
    let sum = 0;
    for (const value of bytes) sum += value;
    return {
      lamps: neighborhood.motionStatus().lamps.join('/'),
      flow: JSON.stringify(map.getPaintProperty('traffic-flow', 'line-dasharray')),
      tail: JSON.stringify(map.getPaintProperty('traffic-tail', 'line-dasharray')),
      river: sum,
      spill: JSON.stringify(neighborhood.towerSpill),
      view: [map.getZoom(), map.getPitch(), map.getBearing()].map((value) => value.toFixed(9)).join('/'),
    };
  });
  // Set the two groups' weights by hand with the loop parked, then hold the frame still: the map has to have drawn
  // what it was told before a byte comparison means anything.
  const weights = async (a, b) => {
    await page.evaluate(async ([a, b]) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = neighborhood.map;
      map.setGlobalStateProperty('lamp-0', a);
      map.setGlobalStateProperty('lamp-1', b);
      map.triggerRepaint();
      await new Promise(resolve => map.once('idle', resolve));
    }, [a, b]);
    await page.waitForTimeout(700);
    // The baseline has to be a frame that stays itself: survive a repaint request *and* three seconds of quiet, twice
    // over. Two back-to-back reads agree during any pause - including the pause before the last basemap tile lands,
    // which is what left this claim 143 scattered pixels away from its own baseline (`scripts/probe-frame-return.mjs`
    // logs no `visibility` write on the lamp layers in that round, and the weights, dash arrays and river rows all come
    // back, so the residue was not a missed reset). When the frame does move, the wait restarts from the new one: the
    // claim stays byte-for-byte, only the moment it is allowed to start counting from moves.
    let first = await shot();
    for (let attempt = 0; attempt < 12; attempt++) {
      await repainted(page);
      await page.waitForTimeout(3000);
      const next = await shot();
      if (next === first) return first;
      first = next;
    }
    throw new Error(`the frame at weights ${a}/${b} never came to rest`);
  };

  // The same crop with every lamp layer hidden, taken and then handed back: the baseline the cross-fade is graded
  // against, so "the number of lit windows held" is measured against what the lamps are actually worth on this wall.
  const LAMP_IDS = ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt',
    'building-glow', 'building-glow-breath-0', 'building-glow-breath-1'];
  const hidden = async (read) => {
    const switchTo = (visibility) => page.evaluate(async ({ LAMP_IDS, visibility }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = neighborhood.map;
      for (const id of LAMP_IDS) map.setLayoutProperty(id, 'visibility', visibility);
      map.triggerRepaint();
      await new Promise(resolve => map.once('idle', resolve));
    }, { LAMP_IDS, visibility });
    await switchTo('none');
    const first = await read();
    await read();
    await switchTo('visible');
    return first;
  };

  await switchAtmosphere(page, 'night');
  const running = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.motionStatus().lampTicks;
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { before, after: neighborhood.motionStatus().lampTicks };
  });
  expect(running.after - running.before, `the lamp clock advanced ${running.after - running.before} times in 3 s`).toBeGreaterThanOrEqual(15);
  // Both groups start on the shipped pick - that is what makes a still page the page this scene always drew - so the
  // claim about two periods is not "they differ now" but "they drift apart and come back". Sampled over more than one
  // of the shorter period, this has to see a group leave the shipped pick, return to it, and the two out of step.
  const drift = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const samples = [];
    for (let i = 0; i < 16; i++) {
      samples.push(neighborhood.motionStatus().lamps.slice());
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return samples;
  });
  expect(drift.some(([a, b]) => Math.abs(a - b) > 0.2),
    `the two groups were never out of step over 32 s: ${JSON.stringify(drift)}`).toBe(true);
  expect(drift.some(([a]) => a < 0.001) && drift.some(([a]) => a > 0.999),
    `group 0 never made a full trip from the shipped pick to the alternate and back: ${JSON.stringify(drift)}`).toBe(true);

  await page.locator('#motion-toggle').click();
  const parked = await status();
  expect(parked.on, 'the switch stops the lamp clock too').toBe(false);
  const frozen = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.motionStatus().lampTicks;
    await new Promise(resolve => setTimeout(resolve, 2000));
    return { before, after: neighborhood.motionStatus().lampTicks };
  });
  expect(frozen.after, 'and it stays stopped').toBe(frozen.before);

  const shipped = await weights(1, 1);
  // The sensitivity control, taken first because it is the yardstick. "The count of lit windows barely moved" is only
  // a claim if the count can see the lamps at all, so the same crop is measured with every lamp layer hidden: that gap
  // is the resolution everything below is graded against, and a build where the alternate layer never draws would fail
  // here rather than passing the ratio. Half of it is what re-dealing one whole group would cost in changed pixels.
  const bare = await hidden(shot);
  const worth = await movedOf(shipped, bare);
  expect(worth, 'the lamp layers never reach the screen, so no claim about their swap means anything')
    .toBeGreaterThan(CLIP.width * CLIP.height * 0.05);
  const resolution = await warmOf(await load(shipped)) - await warmOf(await load(bare));
  // This bar used to be an absolute share of the crop (2%), calibrated on a frame where every block burned windows and
  // the grid's own night windows were painted at 150 of 255. V7 moved both - 9.1% of the blocks now burn nothing and
  // the grid's panes came to 110 - so an absolute figure would be measuring the brightness budget rather than the
  // counter's sight. Graded against the same frame's moved-pixel figure it stays what it always was: if the warm count
  // cannot see the lamps at all, this ratio collapses to nothing while `worth` stays where it is. Measured 0.147.
  expect(resolution / worth, `the lit-window count sees only ${Math.round(resolution / worth * 100)}% of what the pixels do, `
    + 'so no claim about their number means anything').toBeGreaterThanOrEqual(0.1);
  const redeal = worth / 2;
  // Both bars are graded against one group's full re-deal. The lower one is the swap reaching the screen at all; the
  // upper one is the V6 promise - a building turns over a share of its windows, not the whole facade - and it is what
  // makes this test fail if `swapCells` ever goes back to dealing two independent picks.
  const swapped = await weights(0, 1);
  const firstSwap = await movedOf(shipped, swapped);
  expect(firstSwap / redeal, `group 0 moved ${Math.round(firstSwap / redeal * 100)}% of a re-deal: the alternate pick never reached the screen`)
    .toBeGreaterThan(0.05);
  expect(firstSwap / redeal, `group 0 re-dealt ${Math.round(firstSwap / redeal * 100)}% of its facade instead of turning a share of windows over`)
    .toBeLessThan(0.4);
  const shifted = Math.abs(await warmOf(await load(swapped)) - await warmOf(await load(shipped)));
  expect(shifted / resolution,
    `the cross-fade moved the lit count by ${Math.round(shifted / resolution * 100)}% of what the lamps are worth - that is a dimmer, not a swap`)
    .toBeLessThan(0.15);
  const secondGroup = await weights(0, 0);
  const secondSwap = await movedOf(swapped, secondGroup);
  expect(secondSwap / redeal, `group 1 moved ${Math.round(secondSwap / redeal * 100)}% of a re-deal: its windows never changed`)
    .toBeGreaterThan(0.05);
  expect(secondSwap / redeal, `group 1 re-dealt ${Math.round(secondSwap / redeal * 100)}% of its facade instead of turning a share of windows over`)
    .toBeLessThan(0.4);
  // 项 3：换窗要看得见，靠的不是让更多格换，而是让**一栋**一起换。上面那条 `shifted/resolution < 0.15` 就是
  // "不许整城同明同灭"的护栏（一次交叉淡最多只能带走一成半的亮窗，全城一起暗会当场把它顶穿）；这一条钉的是
  // 另一头——变化必须是成块的。格级换窗把同样的像素摊在全城几百栋楼上，最挤的 24×24 小窗里只有 90 颗在动。
  const coherence = await clusterOf(shipped, swapped);
  expect(coherence, `the densest 24×24 patch of group 0's crossing moved ${coherence} pixels: no building is going dark, `
    + 'the swap is still cell-level only').toBeGreaterThanOrEqual(144);
  expect(coherence, `the densest 24×24 patch moved ${coherence} of 576 pixels - that is more than a wall, so the whole `
    + 'city is blinking rather than a seventh of it breathing').toBeLessThan(576 * 0.85);
  // And the split that makes it so has to be where the claim says it is: the breathing seventh handed the all-dark tile
  // on the alternate hand (a per-block opacity is not a thing `fill-extrusion-opacity` can carry), and its halo split
  // out with it, so a dark building is not still wearing the wash its windows cast.
  const wiring = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const style = id => map.getStyle().layers.find(layer => layer.id === id);
    const text = (value) => JSON.stringify(value ?? null);
    // The predicate of the `case` inside the first zoom branch: that is where the "this block gets no tile" dice lives.
    const darkOf = (id) => text(style(id).paint['fill-extrusion-pattern'][2][1]);
    return {
      shippedDark: darkOf('building-lights'), altDark: darkOf('building-lights-alt'),
      glow: ['building-glow', 'building-glow-breath-0', 'building-glow-breath-1']
        .map(id => ({ id, exists: Boolean(style(id)), filter: text(map.getFilter(id)), opacity: text(style(id)?.paint['fill-extrusion-opacity']) })),
    };
  });
  expect(wiring.shippedDark, 'the shipped hand only switches off the blocks whose id says they burn nothing')
    .toBe('["==",["%",["to-number",["get","osmId"],0],11],7]');
  expect(wiring.altDark, 'the alternate hand switches off those plus the breathing seventh - that is the whole-building dim, '
    + 'and it has to ride the pattern because `fill-extrusion-opacity` cannot read a feature')
    .toBe('["any",["==",["%",["to-number",["get","osmId"],0],11],7],["==",["%",["to-number",["get","osmId"],0],7],3]]');
  expect(wiring.glow.map(entry => entry.exists), 'the halo is three layers: the steady majority and one per group for the breathers')
    .toEqual([true, true, true]);
  expect(wiring.glow[0].opacity, 'the steady halo carries no weight at all').not.toContain('global-state');
  expect(wiring.glow[0].filter, 'and it gives the breathing blocks back to their own layers').toContain('"!"');
  expect(wiring.glow[1].opacity, 'a breathing halo rides its own group\'s weight').toContain('lamp-0');
  expect(wiring.glow[2].opacity, 'and so does the other group\'s').toContain('lamp-1');
  expect(await weights(1, 1), 'handing the weights back hands the same picture back').toBe(shipped);
  const atBase = await sceneState();

  // And the switch, not the test, has to be what returns that frame: run the loop until a group has demonstrably left
  // the shipped pick, stop it, and the picture has to be the one it started from.
  await page.locator('#motion-toggle').click();
  await expect.poll(async () => (await status()).lamps.some((value) => value < 0.999),
    { message: 'the loop never left the shipped pick to begin with', timeout: 40000 }).toBe(true);
  await page.locator('#motion-toggle').click();
  expect((await status()).lamps, 'stopping has to put both groups back on the shipped pick').toEqual([1, 1]);
  // Stopping hands the scene back in two parts, and each is graded on its own terms. ① Every value the loop writes has
  // to be back at its shipped setting: the two lamp picks, the two dash arrays, the river tile's own bytes, the three
  // water bands, and the camera. ② The picture has to be the baseline - with one exception, on the water only: at most
  // 0.1 % of the crop may differ and every one of those pixels has to be drawn over `river-surface`/`water`, because
  // MapLibre re-packs and re-samples a pattern image per upload history (same bytes, same camera, same band state, and
  // a stable-but-different rasterisation that changes from one page load to the next - 143 / 119 / 116 pixels measured,
  // the same pixels at every look inside a page). A difference anywhere else - a lamp layer, a facade, a bridge, a
  // nameplate - is a real stranding and goes red, and so does any of ① coming back different.
  await expect.poll(async () => {
    await repainted(page);
    const frame = await shot();
    const now = await sceneState();
    const drifted = Object.keys(atBase).filter((key) => atBase[key] !== now[key]);
    if (drifted.length) return `the loop left ${drifted.map((key) => `${key}=${now[key]}`).join(', ')} behind`;
    if (frame.toString('base64') === shipped) return 'restored';
    const { moved, box, offCount, off } = await diffOf(shipped, frame);
    if (!offCount && moved <= ALLOWANCE) return 'restored';
    const sample = off.length ? `: ${off.join(' | ')}` : ' (individual spots are only listed under the allowance)';
    return offCount
      ? `${moved} pixels away (box ${box.join(',')}), ${offCount} of them off the water${sample}`
      : `${moved} pixels away, all over water but past the ${ALLOWANCE} allowed`;
  }, { message: 'stopping has to hand the scene back: shipped settings, and the shipped picture apart from the water',
    timeout: 60000 }).toBe('restored');

  // A day scene has no lamps to cross-fade, so the clock must not spend a write on them.
  await switchAtmosphere(page, 'day');
  const idle = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setMotion(true);
    const before = neighborhood.motionStatus().lampTicks;
    await new Promise(resolve => setTimeout(resolve, 2500));
    return { before, after: neighborhood.motionStatus().lampTicks };
  });
  expect(idle.after, `the lamp clock advanced ${idle.after - idle.before} times in a day scene`).toBe(idle.before);
  expect((await status()).lamps, 'and every block stays on the pick it shipped with').toEqual([1, 1]);
  expect(errors).toEqual([]);
});

// The near field: individual vehicles and walkers within the field radius of the tower (1.5 km since the fourth item of
// the 2026-10-05 round; the street snapshot reaches 2.2 km), stood in the tower's own metre
// frame from the OSM street snapshot. The claim is not that a group exists - it is that the lights sit on the streets,
// that they stop at the radius while the ribbons carry on past it, that they only burn at night, and that the loop is
// what moves them. Every pixel claim below is graded with the loop stopped, so the only write left in the frame is the
// one being claimed, and A/B-ed by hiding the two clouds rather than by trusting a counter.
test('the near field puts vehicles on the streets, walkers on the paths, and stops at its own radius', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const { CAR_HEIGHT_METRES, TRAFFIC_LIFE_RADIUS, WALKER_MIN_ZOOM } = await import('../src/traffic-life.js');
  await openMap(page);
  const read = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const status = neighborhood.motionStatus();
    return { near: neighborhood.nearTraffic(), lights: status.lights, on: status.on };
  });
  const day = await read();
  expect(day.near, 'the tower scene has a near field').not.toBeNull();
  // 车与人现在是模型而不是灯，所以白昼也在场；跟着夜景开关的只有车灯与行人那一档。
  expect(day.near.visible, 'the vehicles and the walkers are on the picture in daylight too').toBe(true);
  expect(day.near.lamps, 'day keeps the headlights off').toBe(false);
  expect(day.near.people, 'at the opening zoom a 1.75 m person is under a pixel, so they stay off').toBe(false);
  expect(day.near.radius, 'the field is the kilometre the snapshot was cut for').toBe(TRAFFIC_LIFE_RADIUS);
  expect(day.near.cars, `${day.near.cars} vehicles on the near-field streets`).toBeGreaterThan(300);
  expect(day.near.walkers, `${day.near.walkers} walkers on the near-field paths`).toBeGreaterThan(100);
  // 路口那三层在现版这一侧也得真的挂进场景：装配是 `near-field.js` 共用的，但"add 进场景"这一步两条路径各写一次。
  // 台数与读数对同一格，读数又与引擎那侧对同一格（`near-field.test.js` 里那条并排比）。
  const parts = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.getLayer('canton-tower').implementation.trafficParts();
  });
  const signalParts = parts.filter((row) => row.startsWith('signal-'));
  expect(signalParts.length, `现版那侧的灯层不齐：${JSON.stringify(parts)}`).toBe(3);
  for (const row of signalParts) {
    expect(Number(row.split(':')[1]), `灯层 ${row} 的台数与读数 ${day.near.signal.approaches} 不同`)
      .toBe(day.near.signal.approaches);
  }
  expect(day.near.signal.approaches, `装了杆的进口道只有 ${day.near.signal.approaches} 条`).toBeGreaterThan(200);
  expect(day.near.signal.parent, '灯没挂在车流那一组里面：透视镜收不走它') .toBe('traffic-life');

  // 项 1：白昼的时钟。这条判据存在的理由是它曾经为 0 —— 近场的推进挂在"光带亮不亮"那道闸门上，所以除了夜景
  // 之外没有任何氛围走过它，两公里外的光带在动、脚底下的车却是停的。量计数器而不是量像素：这一层的贴图会因
  // 改样式而重图集，像素差量到的是渲染器的抖动（README 的 #114 一条），计数器轨证明"在算"，画面轨由下面
  // `lit()` 那一对 A/B 承担。
  const ticksIn = (ms) => page.evaluate(async (ms) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.motionStatus().lights;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { before, after: neighborhood.motionStatus().lights };
  }, ms);
  const dayClock = await ticksIn(2400);
  // 2.4 s at the 120 ms tick is twenty steps; half of that is the floor, so a loop that advances on some ticks
  // only (a dropped write, a gate that re-closes) still goes red.
  expect(dayClock.after - dayClock.before, `the near field advanced ${dayClock.after - dayClock.before} times in 2.4 s of daylight`).toBeGreaterThanOrEqual(10);
  // 项 2 的 A 档：默认机位没有人，是因为 1.75 m 的人在那一档不到一像素——这句话得写在读数与界面上，而不是
  // 只写在源码注释里，否则使用者只能猜"这座城是不是没人"。
  expect(day.near.walkerMinZoom, 'the reading carries the zoom the walkers wait for').toBe(WALKER_MIN_ZOOM);
  expect(await page.locator('#motion-toggle').getAttribute('title'),
    'and the switch says so where the reader looks').toContain(`${WALKER_MIN_ZOOM}`);
  // 日落与白昼同一条闸门，单独钉一次：这一档既没有灯也没有光带，是"近场挂在夜景上"最容易复发的地方。
  // 换氛围也不许把近场拨回起点：车与人在白昼同样在画，"回到出厂那一格"一旦跟着开关走，每按一次氛围
  // 脚底下的车流就跳回原位。#114 收口时留下的那次复位当年只有夜景看得见车，所以无害，现在有害。
  // 计数器说不出这件事（`lights` 只加不减），能说的是时钟：车摆在哪一秒的位置上。读在切换的同一拍里，
  // 因为过渡本身有 1.2 s 循环在跑——等它走完再读，复位过的时钟也已经重新长回来了，判据就成了看时机。
  const instantTo = (id) => page.evaluate(async (id) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.nearTraffic().clock;
    neighborhood.setAtmosphere(id, { instant: true });
    return { before, after: neighborhood.nearTraffic().clock };
  }, id);
  const toDusk = await instantTo('sunset');
  expect(toDusk.after, `switching to sunset rewound the traffic clock from ${toDusk.before.toFixed(2)} s to ${toDusk.after.toFixed(2)} s`)
    .toBeGreaterThanOrEqual(toDusk.before);
  const duskClock = await ticksIn(2400);
  expect(duskClock.after - duskClock.before, `the near field advanced ${duskClock.after - duskClock.before} times in 2.4 s of sunset`).toBeGreaterThanOrEqual(10);
  const toDay = await instantTo('day');
  expect(toDay.after, `and switching back handed the cars their starting spacing (${toDay.before.toFixed(2)} s → ${toDay.after.toFixed(2)} s)`)
    .toBeGreaterThanOrEqual(toDay.before);

  // Two windows to look through: one whose ground is inside the radius and one outside it, both with a lit street in
  // them. The ribbons run to 3 km, so a far window with no road in it would prove nothing about the boundary.
  const windows = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { distanceMeters } = await import('/src/geo.js');
    const map = neighborhood.map;
    const canvas = map.getCanvas();
    const tower = { lat: 23.109, lng: 113.31913 };
    const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
    const ring = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] }).flatMap(f => f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : []);
    const points = ring.map(([lng, lat]) => map.project([lng, lat]));
    // The tower's own screen box: its light is the other thing the loop moves, and a window that grazed the lattice
    // would be measuring the breath and calling it traffic.
    const shaft = points.length
      ? { left: Math.min(...points.map(p => p.x)) - 40, right: Math.max(...points.map(p => p.x)) + 40, top: Math.min(...points.map(p => p.y)) - 40, bottom: Math.max(...points.map(p => p.y)) + 40 }
      : null;
    const sweep = (width, height, min, max) => {
      // From y = 96, because the ground past the field radius only reaches the frame at its top edge: measured at the
      // shipped camera the first lit street outside 1.7 km sits at y = 96, about 2.8 km out, and a floor of 240 finds
      // nothing beyond 1.4 km - which is inside the field and measures nothing.
      for (let y = 96; y + height < canvas.clientHeight - 90; y += 10) {
        for (let x = 320; x + width < canvas.clientWidth - 40; x += 10) {
          const box = [[x, y], [x + width, y + height]];
          if (!map.queryRenderedFeatures(box, { layers: ['traffic-band'] }).length) continue;
          if (map.queryRenderedFeatures(box, { layers: ['river-surface', 'water'] }).length) continue;
          if (shaft && !(x + width < shaft.left || x > shaft.right || y + height < shaft.top || y > shaft.bottom)) continue;
          if (![[x + 8, y + 8], [x + width - 8, y + 8], [x + 8, y + height - 8], [x + width - 8, y + height - 8]]
            .every(([px, py]) => clear(px, py))) continue;
          const ground = map.unproject([x + width / 2, y + height / 2], 0);
          const metres = distanceMeters(tower, { lat: ground.lat, lng: ground.lng });
          if (!Number.isFinite(metres) || metres < min || metres > max) continue;
          return { x, y, width, height, metres: Math.round(metres) };
        }
      }
      return null;
    };
    // The river takes up most of this frame, so a window that is dry, has a road in it and is out past the radius has
    // to be allowed to be smaller than one on the near bank. The far floor is the field radius plus 200 m of clearance
    // (1.7 km at the shipped 1.5 km), and the claim itself is graded against the measured reach, not against this floor.
    const hunt = (min, max) => [[200, 120], [140, 90], [100, 70]].map(([w, h]) => sweep(w, h, min, max)).find(Boolean) ?? null;
    return { near: hunt(300, 800), far: hunt(1700, 3000) };
  });
  // The framebuffer, not a screenshot. Asking for a frame is itself a write in this scene - a repaint advances the
  // basemap's pattern fade by a step - so no byte-for-byte claim about a picture survives the act of taking one, and
  // the honest measurement is a count of lit pixels read straight off the drawing buffer inside the render event.
  // `white` is a headlight, `warm` is a taillight; the ribbons underneath are neither.
  const lit = (frame) => page.evaluate(async (frame) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const canvas = map.getCanvas();
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const scale = canvas.height / canvas.clientHeight;
    const x = Math.round(frame.x * scale);
    const y = Math.round(frame.y * scale);
    const width = Math.round(frame.width * scale);
    const height = Math.round(frame.height * scale);
    const read = () => new Promise((resolve) => {
      const once = () => {
        map.off('render', once);
        const pixels = new Uint8Array(width * height * 4);
        // The drawing buffer is measured from its bottom-left corner; the window was found from the page's top-left.
        gl.readPixels(x, canvas.height - y - height, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let white = 0, warm = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const [r, g, b] = [pixels[index], pixels[index + 1], pixels[index + 2]];
          if (Math.min(r, g, b) > 190) white++;
          // A taillight is red *dominant*, which is what its sprite actually is: the previous bar (r>200, g>150, b<160)
          // never matched the core at all - `#ff3b26` has green 59 - so it counted only the halo where the lamp blended
          // with the ground, and it fell below its own bar the moment the ground was darkened. This one matches the
          // core, and still excludes the headlight (`#fff3d2`, red over green by 12) and the road ribbon
          // (`#ffb877`, red over green by 71).
          if (r > 150 && r - g > 90 && r - b > 90) warm++;
        }
        resolve({ white, warm });
      };
      map.on('render', once);
      map.triggerRepaint();
    });
    // Two reads per state: the first one is the frame the toggle itself asked for, the second is the settled picture.
    const show = async (on) => {
      map.getLayer('canton-tower').implementation.setTraffic(on);
      await read();
      return read();
    };
    return { withField: await show(true), withoutField: await show(false), back: await show(true) };
  }, frame);

  await switchAtmosphere(page, 'night');
  const night = await read();
  expect(night.near.visible, 'the night theme turns the vehicles on').toBe(true);
  expect(night.lights, 'and the loop is driving them').toBeGreaterThan(0);
  const grown = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.motionStatus().lights;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { before, after: neighborhood.motionStatus().lights };
  });
  expect(grown.after - grown.before, `the near field advanced ${grown.after - grown.before} times in 2 s`).toBeGreaterThanOrEqual(10);

  const both = await windows();
  // Both windows are graded against `reach` - the farthest agent the field actually drew, measured off the scene -
  // rather than against the radius constant the sweep was filtered with, so neither claim can be made true by its own
  // search bounds. If the field ever grows past 1.7 km, the far window stops being outside it and this goes red.
  const field = (await read()).near;
  expect(both.near, 'no street window inside the radius to measure').not.toBeNull();
  expect(both.far, 'no street window outside the radius to measure').not.toBeNull();
  expect(both.near.metres, `the near window is inside the field's measured ${field.reach} m`).toBeLessThan(field.reach);
  expect(both.far.metres,
    `the far window at ${both.far.metres} m is not past the field's measured reach of ${field.reach} m`).toBeGreaterThan(field.reach);

  // Stop the loop, so the only thing that can change a frame is the thing under test.
  await page.locator('#motion-toggle').click();
  expect((await read()).on, 'the switch stops the loop').toBe(false);
  const frozen = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.motionStatus().lights;
    await new Promise((resolve) => setTimeout(resolve, 1600));
    return { before, after: neighborhood.motionStatus().lights };
  });
  expect(frozen.after, 'and the vehicles stop with it').toBe(frozen.before);

  const inside = await lit(both.near);
  const addedWhite = inside.withField.white - inside.withoutField.white;
  const addedWarm = inside.withField.warm - inside.withoutField.warm;
  // 门槛 100 → 60：这两个数是随实例数走的。车距 55 → 100 m（用户 2026-10-09「车辆太多太密集」）把 1,981 辆
  // 降到 1,298 辆，同一扇窗里量到的是白 109／红 97。这条判据要防的是"灯层静默不画"——已知两个缺陷值是
  // 0（整层关掉）与 31（灯珠留在 1.9 m 被自己的车体吞掉，见 README 第 20 项）——所以 60 仍在缺陷值之上
  // 近一倍、在健康值之下近一倍，两边都留得下腰斩与静默。不是把门槛挪到健康值以下让它绿：那样 31 也会绿。
  expect(addedWhite,
    `the field added ${addedWhite} headlight pixels to a street at ${both.near.metres} m`).toBeGreaterThan(60);
  expect(addedWarm,
    `and ${addedWarm} taillight pixels`).toBeGreaterThan(60);
  expect(inside.back, 'handing the field back hands the same picture back').toEqual(inside.withField);
  const outside = await lit(both.far);
  expect(outside.withField, `the field reached ${both.far.metres} m out, past its own radius`).toEqual(outside.withoutField);
  const status = await read();
  expect(status.near.reach, `the field stops at ${both.near.metres} m but the far window is at ${both.far.metres}`)
    .toBeLessThan(TRAFFIC_LIFE_RADIUS + 20);

  // Reduced motion: the field is still there - the streets are not empty - but it is a still picture.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openMap(page);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setAtmosphere('night', { instant: true });
  });
  await page.waitForTimeout(1500);
  const calm = await read();
  expect(calm.on, 'a page that may not animate still opens with the vehicles on the streets').toBe(false);
  expect(calm.near.visible, 'at night').toBe(true);
  expect(calm.lights, 'and never advanced').toBe(0);
  const calmWindow = (await windows()).near;
  expect(calmWindow, 'no near-field window to watch on a still load').not.toBeNull();
  const still = await lit(calmWindow);
  expect(still.withField.white - still.withoutField.white, 'a still frame is not an empty one').toBeGreaterThan(60);
  expect(still.back, 'and the frame it holds does not drift').toEqual(still.withField);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.getLayer('canton-tower').implementation.setTraffic(false);
  });

  // The school scene has no near field at all: no snapshot, and no tower scene to stand it in.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${appUrl}/?scene=jingtai`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return { near: neighborhood.nearTraffic(), tower: Boolean(neighborhood.map.getLayer('canton-tower')) };
  }), 'the school scene grew a near field').toEqual({ near: null, tower: false });
  expect(CAR_HEIGHT_METRES, 'and a vehicle is a car-shaped 1.45 m, not a point').toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

// 江上的船（用户 2026-10-09「江面上可以补充一些游轮」）。要证的不是"江面上有东西"，而是三件事：它摆在实测
// 中心线的圈内（reach 说话，不是常量说话）、它和车流骑同一把时钟（两侧渲染路径都只递一把
// `motion.life / 1000`，谁多除一次 1000 谁就以千分之一速冻在江面上）、只有夜景才亮窗带。
// 关掉动效那一条同时钉住"回出厂帧"：船必须和车一起回到第 0 秒，不能各留半格。
test('the river carries boats on the same clock as the traffic', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const { BOAT_LIFE_RADIUS } = await import('../src/waterlife.js');
  await openMap(page);
  const read = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.nearTraffic();
  });
  const day = await read();
  expect(day.boats, `江上只有 ${day.boats} 条船`).toBeGreaterThanOrEqual(4);
  expect(day.boatRadius, '船的圈是它自己的可见度半径，不是车流的 1.5 km').toBe(BOAT_LIFE_RADIUS);
  expect(day.boatReach, `最外那条船在 ${day.boatReach} m`).toBeGreaterThan(300);
  expect(day.boatReach, `最外那条船出了 ${BOAT_LIFE_RADIUS} m 的圈`).toBeLessThanOrEqual(BOAT_LIFE_RADIUS);
  expect(day.boatLights, '白天不亮窗带').toBe(false);

  // 同一把时钟：车摆在第 n 秒，船也必须摆在第 n 秒。2.4 s 的真实时间按 120 ms 一拍推进，两边增量都在 2 s 上下。
  const drift = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const before = neighborhood.nearTraffic();
    await new Promise((resolve) => setTimeout(resolve, 2400));
    const after = neighborhood.nearTraffic();
    return { cars: after.clock - before.clock, boats: after.boatClock - before.boatClock };
  });
  expect(drift.cars, '车流这一侧的时钟得先在走').toBeGreaterThan(1);
  expect(Math.abs(drift.boats - drift.cars),
    `同一把时钟走了两个数：车 ${drift.cars.toFixed(2)} s、船 ${drift.boats.toFixed(2)} s`).toBeLessThan(0.2);

  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(4000);
  expect((await read()).boatLights, '夜里窗带该亮').toBe(true);

  // 关动效：整场回到出厂帧，船不许留在它走到的那一格上（#114 那一判据的船侧）。
  await page.locator('#motion-toggle').click();
  await page.waitForTimeout(1200);
  const stopped = await read();
  expect(stopped.clock, '关掉动效之后车回到第 0 秒').toBe(0);
  expect(stopped.boatClock, '关掉动效之后船也回到第 0 秒').toBe(0);
  expect(stopped.boats, '船不是灯，停着也在场').toBeGreaterThanOrEqual(4);
  expect(errors).toEqual([]);
});

// V4 item 6: the landmarks. The claim is that the OSM elements behind them became interactive labels that fly to a camera
// outside the building they point at - so the ids, the seats, the card and the arrival camera are all read back, not
// trusted. 第七枚是本轮补的：猎德大桥（V5 遗留①），出厂机位画框外约 100 px，转过来才有名字。
test('the landmark labels open a card and fly to a camera that clears the roof', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openMap(page);
  const seats = await page.evaluate(async (names) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    return [...document.querySelectorAll('.landmark')].map((node) => {
      const rect = node.getBoundingClientRect();
      const osmId = Number(node.dataset.osmId);
      const landmark = names.find((entry) => entry.osmId === osmId);
      const point = map.project(landmark.center);
      return {
        osmId, name: node.textContent, label: node.getAttribute('aria-label'),
        // The chip hangs above its own point, so the anchor is compared, not the box.
        drift: Math.round(Math.hypot(rect.x + rect.width / 2 - point.x, rect.bottom + 6 - point.y)),
      };
    });
  }, LANDMARKS);
  expect(seats.map((seat) => seat.osmId).sort((a, b) => a - b), 'the plates are exactly the ones the data carries')
    .toEqual(LANDMARKS.map((landmark) => landmark.osmId).sort((a, b) => a - b));
  for (const seat of seats) {
    expect(seat.name, 'the name is the snapshot\'s own').toBe(LANDMARKS.find((l) => l.osmId === seat.osmId).name);
    expect(seat.label, 'a screen reader gets the name even where the text is hidden').toBe(seat.name);
    expect(seat.drift, `${seat.name} is not sitting on its own element`).toBeLessThanOrEqual(3);
  }
  // The plain text label steps out for the interactive one rather than naming the tower twice.
  expect(await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.getLayoutProperty('tower-label', 'visibility');
  }), 'the tower is labelled twice').toBe('none');

  await page.locator('.landmark[data-osm-id="511404889"]').click();
  const card = page.locator('.landmark-card');
  await expect(card).toContainText('周大福金融中心（广州东塔）');
  await expect(card).toContainText('高度 530 m（OSM 标注 height）');
  await expect(card).toContainText('OSM 要素 511404889');
  await expect(card.locator('.landmark-intro')).toBeHidden();
  const reveal = card.locator('.landmark-actions button').first();
  await expect(reveal).toHaveText('查看介绍');
  await reveal.click();
  await expect(card.locator('.landmark-intro')).toBeVisible();
  // The button renames itself, which is what makes the disclosure honest rather than a hidden paragraph.
  await expect(reveal).toHaveAttribute('aria-expanded', 'true');
  await expect(reveal).toHaveText('收起介绍');
  await reveal.click();
  await expect(card.locator('.landmark-intro')).toBeHidden();
  await expect(reveal).toHaveAttribute('aria-expanded', 'false');

  const flight = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const began = { zoom: Math.round(map.getZoom() * 100) / 100, altitude: Math.round(map._camera.transform.getCameraAltitude()) };
    document.querySelector('.landmark-card button:last-of-type').click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const during = document.body.dataset.landmark ?? null;
    await new Promise((resolve) => {
      const step = () => (map.isMoving() ? requestAnimationFrame(step) : resolve());
      requestAnimationFrame(step);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      began, during,
      ended: { zoom: Math.round(map.getZoom() * 100) / 100, pitch: Math.round(map.getPitch() * 10) / 10,
        altitude: Math.round(map._camera.transform.getCameraAltitude()) },
      after: document.body.dataset.landmark ?? null,
      arrivals: [...document.querySelectorAll('.landmark.is-arrival')].map((node) => node.dataset.osmId),
      still: { zoom: Math.round(map.getZoom() * 100) / 100 },
    };
  });
  expect(flight.during, 'the labels never stepped back for the flight').toBe('flying');
  expect(flight.after, 'and never came back').toBeNull();
  expect(flight.arrivals, `only the arrived landmark is lit: ${flight.arrivals}`).toEqual(['511404889']);
  expect(flight.ended.altitude, `the eye ended ${flight.ended.altitude} m up - the tower is 530 m`).toBeGreaterThanOrEqual(560);
  expect(flight.ended.altitude, 'and not so far above it that the shot is a plan view').toBeLessThan(700);
  expect(Math.abs(flight.ended.pitch - 60), `the arrival pitch read ${flight.ended.pitch}°`).toBeLessThanOrEqual(1);
  expect(flight.ended.zoom, 'the camera really moved').not.toBe(flight.began.zoom);

  // A phone keeps the diamond and drops every name, which is the reason floating nameplates were refused once.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const narrow = await page.evaluate(() => {
    const node = document.querySelector('.landmark[data-osm-id="243319596"]');
    const rect = node.getBoundingClientRect();
    return { name: getComputedStyle(node.querySelector('.landmark-name')).display, tap: [Math.round(rect.width), Math.round(rect.height)] };
  });
  expect(narrow.name, 'the name is still laid out on a phone').toBe('none');
  expect(narrow.tap[0], `the diamond is ${narrow.tap.join('×')}`).toBeGreaterThanOrEqual(20);
  expect(narrow.tap[1]).toBeGreaterThanOrEqual(20);
  await page.locator('.landmark[data-osm-id="243319596"]').click();
  await expect(page.locator('.landmark-card')).toContainText('花城广场');

  // The school scene has no landmarks, because none of these elements are in its two kilometres.
  await page.goto(`${appUrl}/?scene=jingtai`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  expect(await page.locator('.landmark').count(), 'the school scene grew a landmark').toBe(0);
  expect(errors).toEqual([]);
});

// 地标名牌拥挤避让: the seven plates are wide (the east tower's own name is 182 px of it) and close enough together that
// two of them land on each other as soon as the whole 3 km range is in frame. When they do, the shorter one - by the
// height its own snapshot carries - gives up its text and keeps its silhouette. Every claim here is read off the
// picture: the crowded pairs the page would draw with the pass suppressed, the pairs it actually draws, and which
// plate paid for the difference.
test('crowded nameplates give up their text in the height their own snapshot carries', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openMap(page);
  const readPlates = (forceFull) => page.evaluate(async ({ names, forceFull }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { DECLUTTER_PAD } = await import('/src/landmarks.js');
    const map = neighborhood.map;
    const nodes = [...document.querySelectorAll('.landmark')];
    if (forceFull) {
      for (const node of nodes) node.classList.remove('is-textless', 'is-hidden');
      // `visibility` is transitioned, so a read in the same task can still report a plate that has just been restored.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const rows = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const landmark = names.find((entry) => entry.osmId === Number(node.dataset.osmId));
      const point = map.project(landmark.center);
      const inFrame = rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
      return {
        osmId: landmark.osmId, name: landmark.name, height: landmark.height,
        state: node.classList.contains('is-hidden') ? 'hidden' : node.classList.contains('is-textless') ? 'diamond' : 'full',
        text: getComputedStyle(node.querySelector('.landmark-name')).display !== 'none',
        box: [rect.x, rect.y, rect.width, rect.height],
        // The plate hangs above its own point, so a shrinking plate has to keep that point: the pass narrows, it never nudges.
        drift: Math.max(Math.abs(rect.x + rect.width / 2 - point.x), Math.abs(rect.bottom + 6 - point.y)),
        shown: inFrame && getComputedStyle(node).visibility !== 'hidden',
      };
    });
    const air = (a, b) => Math.max(a.box[0] - (b.box[0] + b.box[2]), b.box[0] - (a.box[0] + a.box[2]),
      a.box[1] - (b.box[1] + b.box[3]), b.box[1] - (a.box[1] + a.box[3]));
    const shown = rows.filter((row) => row.shown);
    const crowded = [];
    for (let i = 0; i < shown.length; i += 1) {
      for (let j = i + 1; j < shown.length; j += 1) {
        const gap = air(shown[i], shown[j]);
        if (gap < DECLUTTER_PAD) crowded.push(`${shown[i].name}/${shown[j].name}@${Math.round(gap)}px`);
      }
    }
    return { crowded, rows, pad: DECLUTTER_PAD };
  }, { names: LANDMARKS, forceFull });
  const sit = (camera) => page.evaluate(async (camera) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    if (camera) map.jumpTo(camera);
    else {
      // The same camera, asked twice: a move event is what re-runs the pass, and this one must not change the frame.
      const center = map.getCenter();
      map.setCenter([center.lng + 1e-9, center.lat]);
      map.setCenter(center);
    }
    await new Promise((resolve) => { map.once('idle', resolve); map.triggerRepaint(); });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, camera);
  const axis = [113.31945, 23.1179];

  const shipped = await readPlates(false);
  expect(shipped.crowded, `the shipped frame keeps every plate its ${shipped.pad} px of air: ${JSON.stringify(shipped.crowded)}`).toEqual([]);
  // The other half of the claim: with the pass suppressed the same frame does stack, and it is the shorter tower that pays.
  const suppressed = await readPlates(true);
  expect(suppressed.crowded.length, `suppressing the pass changed nothing on the opening frame: ${JSON.stringify(suppressed.crowded)}`).toBeGreaterThan(0);
  const byId = new Map(suppressed.rows.map((row) => [row.osmId, row]));
  expect(byId.get(184738716).text, '西塔 keeps its words in the shipped frame').toBe(true);
  await sit();
  const seated = await readPlates(false);
  expect(seated.crowded, `the plate that was suppressed came back: ${JSON.stringify(seated.crowded)}`).toEqual([]);
  const shippedText = (rows) => Object.fromEntries(rows.map((row) => [row.name, row.text]));
  expect(shippedText(seated.rows)['广州国际金融中心(广州西塔)'], 'the 440.2 m tower gave its text up').toBe(false);
  expect(shippedText(seated.rows)['周大福金融中心（广州东塔）'], 'while the 530 m tower kept its own').toBe(true);
  expect(shippedText(seated.rows)['广州塔'], 'and the 600 m model kept its own').toBe(true);
  expect(seated.rows.filter((row) => row.state === 'diamond').length, 'exactly one plate went silent').toBe(1);
  expect(Math.max(...seated.rows.map((row) => row.drift)), `a plate that shrinks still sits on its own element: ${Math.max(...seated.rows.map((row) => row.drift))} px off`).toBeLessThanOrEqual(1);

  // The last resort is real: squeeze the whole range into the frame and one silhouette still lands on another.
  await sit({ center: axis, zoom: 14.4, pitch: 62, bearing: -25 });
  const parked = await readPlates(false);
  expect(parked.crowded, `the parked plate left a crowd behind: ${JSON.stringify(parked.crowded)}`).toEqual([]);
  expect(parked.rows.filter((row) => row.state === 'hidden').map((row) => row.name), 'the shortest plate on the pile is the one parked')
    .toEqual(['广州国际金融中心(广州西塔)']);
  await sit({ center: axis, zoom: 16, pitch: 62, bearing: -25 });
  const restored = await readPlates(false);
  expect(restored.rows.filter((row) => row.state !== 'full').map((row) => row.name), 'pulling in did not leave a plate parked')
    .toEqual([]);

  // A phone has no words to give up - the stylesheet already dropped all of them - so the pass leaves every silhouette
  // exactly where it is, even where two of them touch: parking one would take the landmark off the page.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await sit({ center: axis, zoom: 14.4, pitch: 62, bearing: -25 });
  const phone = await readPlates(false);
  expect(phone.rows.map((row) => row.state), `the phone decluttered a plate that had no text to lose: ${JSON.stringify(phone.rows.map((row) => row.state))}`)
    .toEqual(shipped.rows.map(() => 'full'));
  expect(Math.min(...phone.rows.map((row) => row.box[2]))).toBeGreaterThanOrEqual(20);
  await page.locator('.landmark[data-osm-id="243319596"]').click();
  await expect(page.locator('.landmark-card')).toContainText('花城广场');
  expect(errors).toEqual([]);
});

// V4 item 7: the tower's own night lighting. Both claims are read off the pixels, because the materials live inside a
// custom layer's closure and a test that could reach them would need production code written for it.
// V5 item 8: the river is the main subject of this frame and until now nothing crossed it but a label. This is the
// guard the whole feature exists for - a `Style.addLayer` whose paint fails validation is dropped without a throw and
// without a console line, so the only way to know the decks are on the map is to ask the map for them.
test('the river crossings are on the map in all three atmospheres, and stand above the water', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openMap(page);
  const read = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { ATMOSPHERES } = await import('/src/atmosphere.js');
    const map = neighborhood.map;
    const order = map.getLayersOrder();
    const layers = ['bridge-decks', 'bridge-parapets'];
    const theme = ATMOSPHERES[document.body.dataset.atmosphere];
    return {
      present: layers.map((id) => order.includes(id)),
      features: layers.map((id) => map.queryRenderedFeatures({ layers: [id] }).length),
      // The deck layer has to sit below the volumes, or a bridge two kilometres back draws over a tower in front.
      belowBuildings: order.indexOf('bridge-parapets') < order.indexOf('neighborhood-buildings'),
      colours: layers.map((id) => JSON.stringify(map.getPaintProperty(id, 'fill-extrusion-color'))),
      deck: map.getPaintProperty('bridge-decks', 'fill-extrusion-color'),
      parapet: map.getPaintProperty('bridge-parapets', 'fill-extrusion-color'),
      foot: theme.bridgeFoot, road: theme.bridge, parapetTheme: theme.bridgeParapet,
      heights: map.queryRenderedFeatures({ layers: ['bridge-decks'] }).slice(0, 3).map((feature) => [feature.properties.base, feature.properties.height]),
      names: [...new Set(map.queryRenderedFeatures({ layers: ['bridge-decks'] }).map((feature) => feature.properties.name).filter(Boolean))],
    };
  });
  const day = await read();
  expect(day.present, 'a layer whose paint fails validation is dropped in silence').toEqual([true, true]);
  expect(day.belowBuildings, 'the decks have to be occluded by the volumes in front of them').toBe(true);
  expect(day.features[0], 'no bridge deck rendered at the hero camera').toBeGreaterThan(9);
  expect(day.features[1], 'the parapets did not survive either').toBe(day.features[0]);
  expect(day.heights.every(([base, height]) => base >= 8 && base <= 15 && height > base), 'a deck has to stand off the water').toBe(true);
  // The deck layer has to survive validation and carry both of its theme's colours. At boot the paint is the plain
  // `case` the module builds - a `match` on a boolean label is the shape MapLibre drops in silence - and after an
  // atmosphere walk it is that `case` wrapped in the mood interpolate, so the walk claim is about the colours being
  // present rather than about one fixed tree.
  expect(day.deck, 'the deck split is not a `case` on the foot tag')
    .toEqual(['case', ['==', ['get', 'foot'], true], day.foot, day.road]);
  expect(day.parapet, 'the parapet is one flat colour per atmosphere').toBe(day.parapetTheme);
  expect(day.colours.every((colour) => !colour.includes('"match"')), 'a `match` on a boolean label drops the whole layer').toBe(true);
  // What the default camera can actually count. 猎德大桥 sits 925 m east of the tower centre and projects at x=1543
  // on a 1440 px canvas, so it is off the hero frame by a tenth of its width - the deck is built and it renders, but
  // only once the camera includes it, which is the second half of this claim.
  const named = day.names;
  expect(named.length, `only ${named.length} named crossings on screen: ${named.join('、')}`).toBeGreaterThan(7);
  for (const wanted of ['海心桥', '广州大桥']) {
    expect(named, `${wanted} is not on screen: ${named.join('、')}`).toContain(wanted);
  }
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.setCenter([113.3287, 23.11]);
    await new Promise((r) => { neighborhood.map.once('idle', r); neighborhood.map.triggerRepaint(); });
  });
  const east = await read();
  expect(east.names, `猎德大桥 still does not render when the camera holds it: ${east.names.join('、')}`).toContain('猎德大桥');
  for (const id of ['sunset', 'night']) {
    await switchAtmosphere(page, id);
    const walked = await read();
    expect(walked.present, `${id} lost a bridge layer`).toEqual([true, true]);
    expect(walked.deck, `${id} did not carry the walk onto the deck`)
      .toEqual(['case', ['==', ['get', 'foot'], true], walked.foot, walked.road]);
    expect(walked.parapet, `${id} left the parapet on the previous theme`).toBe(walked.parapetTheme);
    expect(walked.parapet, `${id} did not move the parapet at all`).not.toBe(day.parapet);
  }
  expect(errors).toEqual([]);
});

test('the tower turns colour at night, the beam only burns at night, and stopping hands the shipped frame back', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.goto(`${appUrl}/#map=15.2/23.1095/113.31913/-25/58`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = neighborhood;
    // The street lights are a second writer on the same loop and a second source of frames; their own contract is
    // graded by the test above, so the tower's byte-for-byte hand-back is measured with them parked.
    const map = neighborhood.map;
    map.__paint = map.setPaintProperty.bind(map);
    map.setPaintProperty = (layer, property, value) => {
      if (['traffic-flow', 'traffic-tail'].includes(layer) && property === 'line-dasharray') return;
      map.__paint(layer, property, value);
    };
  });
  await settled(page);
  const tower = { x: 826, y: 252, width: 58, height: 296 };
  // A stretch of the shaft below the observation deck. The box over the mast reads the beam rather than the building:
  // sampled every 300 ms through one 9 s breath it goes 282°→358°, because the beam is additive over a sky that is not
  // the tower's own colour - while this one goes 208°→212° with its brightness walking 71→82. The wide box around the
  // waist is mostly the far bank seen through the lattice and drifts 30°.
  const towerShaft = { x: 838, y: 470, width: 36, height: 70 };
  // The mean of the bright pixels is the tower's own lit lattice; the sky and the street are dark enough to exclude.
  const tint = async (clip) => {
    const png = await page.screenshot({ clip });
    return page.evaluate(async (source) => {
      const img = await new Promise((resolve) => {
        const node = new Image();
        node.onload = () => resolve(node);
        node.src = `data:image/png;base64,${source}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const sum = [0, 0, 0];
      let n = 0;
      let light = 0;
      for (let i = 0; i < data.length; i += 4) {
        light += (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (data[i] + data[i + 1] + data[i + 2] < 300) continue;
        sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; n += 1;
      }
      const rgb = n ? sum.map((value) => Math.round(value / n)) : null;
      let hue = null;
      if (rgb) {
        const [r, g, b] = rgb.map((value) => value / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        hue = !delta ? 0 : Math.round((max === r ? (g - b) / delta + (g < b ? 6 : 0)
          : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60);
      }
      return { rgb, hue, lit: n, mean: Math.round(light / (data.length / 4)) };
    }, png.toString('base64'));
  };
  const shot = () => page.screenshot({ clip: tower });

  // The beam is a shaft straight up from the mast, and a pitched camera keeps world vertical as screen vertical. So it
  // is measured against the same height one beam-width to the side, inside one theme: comparing the sky by day with the
  // sky by night only measures the sky.
  const above = { x: 842, y: 152, width: 32, height: 92 };
  const aside = { x: 690, y: 152, width: 32, height: 92 };
  const shaft = async () => { const [on, off] = [await tint(above), await tint(aside)]; return on.mean - off.mean; };
  const dayShaft = await shaft();
  await page.locator('[data-atmosphere-option="night"]').click();
  await settled(page);
  // The frame to hand back to is the one with none of this running, so the loop is stopped before it is stored - a
  // reference taken while the wheel is already turning is a colour the stop cannot return to.
  // The basemap keeps advancing a pattern fade one light level per repaint for a while after the map calls itself idle,
  // so a reference is only worth storing once two consecutive frames of it already agree.
  const restedShot = async () => {
    let last = await shot();
    for (let tries = 0; tries < 30; tries++) {
      await page.waitForTimeout(400);
      const now = await shot();
      if (Buffer.compare(last, now) === 0) return now;
      last = now;
    }
    return last;
  };
  const nightShaft = await shaft();
  expect(nightShaft, `nothing is lighting the sky over the mast: the column is ${nightShaft} brighter than its side, day ${dayShaft}`)
    .toBeGreaterThan(dayShaft + 8);
  await page.locator('[data-atmosphere-option="day"]').click();
  await settled(page);
  expect(await shaft(), 'the beam is still burning by day').toBeLessThan(8);

  await page.locator('[data-atmosphere-option="night"]').click();
  await settled(page);
  // The frame to hand back to is stored here, after the last theme round trip and with the loop stopped: a reference
  // taken before a day/night switch is a picture from a different fade, and no correct stop can return to it.
  await page.locator('#motion-toggle').click();
  const shipped = await restedShot();
  await page.locator('#motion-toggle').click();
  await page.waitForTimeout(1200);
  const before = await tint(tower);
  await page.waitForTimeout(9000);
  const after = await tint(tower);
  expect(before.rgb, 'no lit lattice to measure').not.toBeNull();
  expect(after.rgb, 'the cycle never reached the screen').not.toBeNull();
  const turned = Math.abs(((after.hue - before.hue + 540) % 360) - 180);
  expect(turned, `the tower only went ${before.rgb} (${before.hue}°) → ${after.rgb} (${after.hue}°) in nine seconds`)
    .toBeGreaterThan(25);

  // V5-7: the default show is one colour on the whole shaft, not five at once. Three bands of one frame have to agree
  // on a hue - and the 彩虹 scheme, which is what this scene shipped with, has to disagree, or the claim measures
  // nothing at all. The bands are the tower's own materials: the preset puts glass in the middle, a diagonal lattice
  // lower down and the warm crown above them, so a wheel that rotates all five by the same amount keeps three hues on
  // screen at every instant.
  const BANDS = [{ x: 826, y: 300, width: 58, height: 60 }, { x: 826, y: 400, width: 58, height: 60 }, { x: 826, y: 480, width: 58, height: 60 }];
  const gap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const spreadOf = async () => {
    const hues = (await Promise.all(BANDS.map((clip) => tint(clip)))).map((band) => band.hue);
    if (hues.some((hue) => hue === null)) return null;
    return { spread: Math.max(...hues.flatMap((a) => hues.map((b) => gap(a, b)))), hues };
  };
  await page.locator('[data-tower-light="single"]').click();
  await page.waitForTimeout(1500);
  const single = await spreadOf();
  expect(single, 'no lit band of the tower to measure').not.toBeNull();
  expect(single.spread, `the default show still paints the shaft in more than one hue: ${single.hues.join('° / ')}°`)
    .toBeLessThanOrEqual(24);
  await page.locator('[data-tower-light="cycle"]').click();
  await page.waitForTimeout(1500);
  const rainbow = await spreadOf();
  expect(rainbow.spread, `the 彩虹 scheme is indistinguishable from the default at ${rainbow.spread}°: the claim above measures nothing`)
    .toBeGreaterThan(45);
  await page.locator('[data-tower-light="single"]').click();
  await page.waitForTimeout(1500);

  // 项 8-3：两档之间不再是一帧到位。按下去之后塔身先暗下去、在最暗那一格把方案换掉、再亮回来——
  // 没有任何色相在这 600 ms 里走路（V5-7 撤掉"五色收成一色"那版过渡的理由是它先把画面拉开再收，
  // 上面那两条 spread 判据量的是两端，仍然成立）。计数器轨证明走的是明度，画面轨证明这个暗真的落了像素。
  const lit0 = await tint(towerShaft);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setTowerMode('cycle');
  });
  const dimming = [];
  for (let i = 0; i < 4; i++) dimming.push(await tint(towerShaft));
  await page.waitForTimeout(900);
  const lit1 = await tint(towerShaft);
  const low = dimming.reduce((a, b) => (b.mean < a.mean ? b : a));
  expect(low.mean, `the shaft did not dim on its way to 彩虹: ${lit0.mean} → ${dimming.map((row) => `${row.mean}/${row.lit}`).join(' → ')} → ${lit1.mean} (亮度/亮像素数)`)
    .toBeLessThan(lit0.mean * 0.85);
  expect(lit1.mean, `it did not come back up either: ${low.mean} → ${lit1.mean}`).toBeGreaterThan(low.mean * 1.1);
  const dip = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n;
    const samples = [];
    n.setTowerMode('single');
    const began = performance.now();
    await new Promise((resolve) => {
      const step = () => {
        const status = n.motionStatus();
        samples.push({ at: Math.round(performance.now() - began), fade: status.towerFade,
          painted: status.towerPainted, wanted: status.towerMode });
        if (performance.now() - began > 1100) resolve(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return samples;
  });
  const bottom = dip.reduce((least, row) => (row.fade < least.fade ? row : least), dip[0]);
  expect(dip.length, `a 600 ms walk sampled only ${dip.length} frames - there is no walk to measure`).toBeGreaterThan(12);
  expect(bottom.fade, `the emission multiplier never went below ${bottom.fade}`).toBeLessThan(0.35);
  expect(bottom.at, `the dip bottomed at ${bottom.at} ms of a 600 ms walk, not in its middle`).toBeGreaterThan(150);
  expect(bottom.at, `the dip bottomed at ${bottom.at} ms of a 600 ms walk, not in its middle`).toBeLessThan(480);
  expect([dip[0].wanted, dip[0].painted], 'the button answers the click at once while the shaft is still wearing the old scheme')
    .toEqual(['single', 'cycle']);
  const swaps = dip.filter((row, index) => index && row.painted !== dip[index - 1].painted).length;
  expect(swaps, `the scheme changed ${swaps} times during one switch`).toBe(1);
  const swapped = dip.find((row) => row.painted === 'single');
  expect(swapped.fade, 'the swap happened on a lit shaft rather than at the bottom of the dip').toBeLessThan(0.6);
  expect([dip[dip.length - 1].painted, dip[dip.length - 1].fade], 'and the walk ends back at full emission on the new scheme')
    .toEqual(['single', 1]);
  // With the loop stopped there is nothing to walk: the switch is one write, and the frame it lands on is the frame
  // the new scheme ships with. Same answer a reduced-motion page gets.
  await page.evaluate(() => window.__n.setMotion(false));
  expect(await page.evaluate(() => {
    window.__n.setTowerMode('breath');
    const status = window.__n.motionStatus();
    return [status.towerMode, status.towerPainted, status.towerFade];
  }), 'a stopped loop switches without a dip').toEqual(['breath', 'breath', 1]);
  await page.evaluate(() => window.__n.setMotion(true));
  await page.locator('[data-tower-light="single"]').click();
  await page.waitForTimeout(1500);
  // The other scheme holds the colour and walks the brightness instead.
  await page.locator('[data-tower-light="breath"]').click();
  expect(await page.evaluate(() => window.__n.motionStatus().towerMode)).toBe('breath');
  expect(await page.locator('[data-tower-light="breath"]').getAttribute('aria-pressed')).toBe('true');
  expect(await page.locator('[data-tower-light="cycle"]').getAttribute('aria-pressed')).toBe('false');
  expect(await page.locator('#tower-light button[aria-pressed="true"]'), 'one pressed option per group').toHaveCount(1);
  // The switch into 呼吸 is itself a 600 ms walk now (项 8-3), so the breath sampling has to start after it. Waiting
  // on `towerFade === 1` alone is a race the walk itself sets up: the dip is a sine, so fade reads 1 both *before* the
  // first step and *after* the last one - a poll that lands in the gap between the click and the frame that starts the
  // walk passes immediately and the first hue sample then reports the scheme being left behind (45° in front of 211°,
  // which is exactly how this failed once). The finished walk is the pair: the shaft already wears the wanted scheme
  // *and* the emission is back up.
  await expect.poll(async () => page.evaluate(() => {
    const status = window.__n.motionStatus();
    return [status.towerPainted, status.towerFade];
  }), { message: 'the switch into 呼吸 never landed on the new scheme at full emission', timeout: 5000 })
    .toEqual(['breath', 1]);
  const walk = [];
  const hues = [];
  for (let i = 0; i < 8; i++) {
    const sample = await tint(towerShaft);
    walk.push(await shot());
    hues.push(sample.hue);
    await page.waitForTimeout(1000);
  }
  const frames = [...new Set(walk.map((frame) => frame.toString('base64')))];
  expect(frames.length, 'the breath never swelled and settled on the screen').toBeGreaterThan(1);
  expect(hues.some((hue) => hue === null), 'the shaft went dark, so the hue above reads nothing').toBe(false);
  // Eight reads at a second apart, which is a whole 9 s breath. The bar is the plain range, not a trimmed one: on the
  // shaft the colour holds to 4° through the swell (208°→212° while its brightness walks 71→82), so a show that also
  // turned the hue would have to move every one of these reads - the 彩虹 walk above turns the same frame by 25°+ in
  // less than half the time.
  const heldTurn = Math.max(...hues) - Math.min(...hues);
  expect(heldTurn, `the breath turned the colour too: ${hues.map((hue) => Math.round(hue)).join('° → ')}°`)
    .toBeLessThanOrEqual(12);

  // Stopping has to hand back the frame the page would have drawn with none of this running.
  await page.locator('#motion-toggle').click();
  await expect.poll(async () => Buffer.compare(await shot(), shipped), { message: 'the cycle did not hand the tower back', timeout: 20000 })
    .toBe(0);

  // The school scene has no tower, so it grows neither the control nor the beam.
  await page.goto(`${appUrl}/?scene=jingtai`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await settled(page);
  expect(await page.locator('#tower-light').isHidden(), 'the school scene grew a tower-light switch').toBe(true);
  expect(errors).toEqual([]);
});

// The night axis: the two landmark towers carry their own glow, the crowns
// breathe, and the tower's light lies across the channel it stands on. Every claim here is read either off the scene's
// own materials or off a pixel box, and each one is graded against a frame where the feature is switched off.
test('the night axis lights its own landmarks, breathes, and marks its tops', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()); });
  await openMap(page);
  const lights = () => page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.landmarkLights;
  });
  const camera = async (center, zoom, pitch, bearing) => {
    await page.evaluate(async ({ center, zoom, pitch, bearing }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      neighborhood.map.jumpTo({ center, zoom, pitch, bearing });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await new Promise((resolve) => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
    }, { center, zoom, pitch, bearing });
    await page.waitForTimeout(1200);
  };
  // The 花城广场 stop on the north bank, which is the frame the brief names.
  await camera([113.319181, 23.122579], 15.7, 40, 180);

  // By day the shells wear their wall colour and nothing on them burns.
  const day = await lights();
  expect(day.length, 'every landmark with a form should be standing').toBe(FORM_OSM_IDS.length);
  for (const form of day) {
    expect(form.shells.length, `${form.osmId} has no crown to breathe`).toBeGreaterThan(0);
    for (const shell of form.shells) expect(shell.intensity, `${form.osmId} lit a shell by day`).toBe(0);
    expect(form.beacon, `${form.osmId} still reports an obstruction lamp`).toBeUndefined();
  }

  await switchAtmosphere(page, 'night');
  await settled(page);
  const { LANDMARK_FORMS } = await import('../src/landmark-forms.js');
  const night = await lights();
  const of = (osmId) => night.find((form) => form.osmId === osmId);
  for (const form of night) {
    const night2 = LANDMARK_FORMS[form.osmId].night;
    for (const shell of form.shells) {
      expect(shell.emissive, `${form.osmId} does not burn in its own lamp colour`).toBe(night2.glow);
      // V7's budget puts a shaft in the same band as the walls standing next to it, so the shaft is bounded from above
      // rather than from below; the crown keeps the floor, and keeps it under full, because the bloom pass in phase B
      // is what is supposed to make it glow and it can only add to something that has headroom left.
      if (shell.part === 'crown') {
        expect(shell.intensity, `${form.osmId}'s ${shell.part} is dark at night`).toBeGreaterThan(0.1);
        expect(shell.intensity, `${form.osmId}'s crown is at full and leaves the bloom pass nothing to add`).toBeLessThan(0.8);
      } else {
        // 塔身夜里穿的是那张窗图：材质系数走的是灯那一档（0.55），因为图上最亮的那一格就是一扇窗，而图上九成
        // 是墙面档折算下来的底带。所以"塔身平均发多少光"只能按 `系数 × 图的平均分量` 读——没有图的地方（裙房、
        // 竖带）平均分量就是系数本身。出厂实测 0.026 / 0.023，就是墙面档 0.02 那一档；上限取它的两倍半，
        // 因为把密度提到"每格都亮"时这个积是 0.079——那一面就是墙，不是窗，必须红。
        const burn = shell.intensity * (shell.lamp > 0 ? shell.lamp : 1);
        expect(burn, `${form.osmId}'s shaft out-burns the block next door at ${burn} (${shell.intensity} × ${shell.lamp})`)
          .toBeLessThan(0.05);
      }
    }
  }
  // The crown is the brighter part, and the two towers lead the axis.
  for (const osmId of [184738716, 511404889]) {
    const [body, crown] = of(osmId).shells;
    expect(crown.part, `${osmId} has no crown over its shaft`).toBe('crown');
    expect(crown.intensity, `${osmId}'s crown is not brighter than its shaft`).toBeGreaterThan(body.intensity);
  }
  expect(of(240896442).shells.length, 'a 16 m roof does not wear a crown').toBe(1);
  expect(of(240896442).shells[0].intensity, 'the museum out-burns the towers')
    .toBeLessThan(of(511404889).shells.find((shell) => shell.part === 'crown').intensity);

  // No obstruction lamp on any of them: the red circles were cancelled on 2026-10-04 (「把上面这些红圈去掉」), which
  // takes V6-2's whole fixture out - the meshes, the 1.5 s flash and the three phases with it. V8's Phase 3 list still
  // names 障碍红灯, so that line is void too and this claim is what stops it coming back on either engine.
  for (const form of night) expect(form.beacon, `${form.osmId} grew a red lamp back`).toBeUndefined();

  // On the screen: the two towers read as the brightest volumes on the axis, and each roof carries a red point.
  const pixels = async () => {
    const encoded = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ encoded }) => {
      const { LANDMARK_FORMS: forms, FORM_OSM_IDS: ids } = await import('/src/landmark-forms.js');
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = neighborhood.map;
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data;
      const dpr = image.width / window.innerWidth;
      const at = (x, y) => {
        const i = (Math.round(y * dpr) * image.width + Math.round(x * dpr)) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const buildings = await (await fetch('/data/canton-buildings.geojson')).json();
      const roofs = {};
      for (const osmId of ids) {
        const feature = buildings.features.find((f) => f.properties.osmId === osmId);
        if (!feature || !forms[osmId].night) continue;
        const own = (x, y) => map.queryRenderedFeatures([[x, y], [x, y]], { layers: ['landmark-forms-hit'] })
          .some((f) => String(f.properties.osmId) === String(osmId));
        const points = feature.geometry.coordinates[0].map(([lng, lat]) => map.project([lng, lat]));
        const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
        const left = Math.max(0, Math.min(...xs) - 30), right = Math.min(innerWidth - 1, Math.max(...xs) + 30);
        const bottom = Math.min(innerHeight - 1, Math.max(...ys) + 8);
        let top = null;
        for (let y = Math.max(0, bottom - 620); y <= bottom && top === null; y += 4) {
          for (let x = left; x <= right; x += 5) if (own(x, y)) { top = { x, y }; break; }
        }
        if (!top) continue;
        let red = -1e9, sample = null;
        for (let y = top.y - 30; y <= top.y + 30; y += 1) {
          for (let x = top.x - 30; x <= top.x + 30; x += 1) {
            const rgb = at(x, y);
            const margin = rgb[0] - Math.max(rgb[1], rgb[2]);
            if (margin > red) { red = margin; sample = rgb; }
          }
        }
        roofs[String(osmId)] = { red: Math.round(red), rgb: sample };
      }
      // The brightest walls on the axis, for the same claim the probe measured by hand.
      let brightest = 0, walls = 0;
      for (let y = 96; y < innerHeight - 130; y += 8) {
        for (let x = 200; x < innerWidth - 120; x += 8) {
          const hit = map.queryRenderedFeatures([[x + 4, y + 4], [x + 4, y + 4]], { layers: ['neighborhood-buildings'] });
          if (hit.length !== 1 || Number(hit[0].properties.distance) > 1800) continue;
          walls++;
          brightest = Math.max(brightest, lum(at(x + 4, y + 4)));
        }
      }
      return { roofs, brightest: Math.round(brightest), walls };
    }, { encoded });
  };
  const frame = await pixels();
  expect(frame.walls, 'the axis did not fill the frame with walls').toBeGreaterThan(400);
  for (const osmId of [184738716, 511404889]) {
    const roof = frame.roofs[String(osmId)];
    expect(roof, `${osmId} has no roof on this screen`).toBeTruthy();
    // The same quantity used to be the lamp's proof: with the red fixture on the roof this cleared 40, and with it
    // cancelled the two towers read 31 (西塔's gold crown) and -17 (东塔's silver one) at this camera.
    expect(roof.red, `${osmId}'s roof carries a red obstruction lamp again: ${JSON.stringify(roof.rgb)}`).toBeLessThan(40);
  }
  // The box in front of the tower, counted as the pixels whose blue channel leans 45 or more past the green, and split
  // by what is actually drawn on top at each of those pixels. The claim written here used to read "the tower put light
  // on the water" at a floor of 300 for the whole box; taking it apart says the box was never the tower's colour:
  //   - the riverfront walls carrying the cool end of the lamp range are what cleared it (parked: 117 pixels, and
  //     hiding every window layer takes the wall count to exactly 0 - a bare night wall is #2c3846, a 14-point lean);
  //   - the rest of the old number was the shaft itself and the bridge ribbons, which the water polygon sits under, so
  //     "does this point hit water" called them river;
  //   - on a strip of river actually searched for in front of the footprint, the tower's own spill is bright (27 to
  //     143). It carried almost no colour of its own - a handful of pixels over the line, parked or across a whole
  //     breath - which is the gap 三塔落水色带 was asked to close. The colour is therefore graded on each band's own
  //     box below, where the band is, and this strip keeps only the brightness claim.
  await page.locator('#recenter-button').click();
  await settled(page);
  await page.waitForTimeout(1500);
  // Parked, on purpose: a claim graded against a breathing frame is graded against whatever phase the screenshot
  // landed on. Motion is handed back before the breath is sampled deliberately below.
  const motionWasOn = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const on = neighborhood.motionStatus().on;
    if (on) neighborhood.setMotion(false);
    return on;
  });
  await settled(page);
  const WINDOW_LAYERS = ['building-facade', 'building-lights', 'building-lights-alt', 'building-lights-2',
    'building-lights-2-alt', 'building-glow', 'building-glow-breath-0', 'building-glow-breath-1'];
  const WALL_LAYERS = [...WINDOW_LAYERS, 'neighborhood-buildings', 'neighborhood-buildings-overview', 'context-buildings'];
  const setWindows = (on) => page.evaluate(async ({ on, WINDOW_LAYERS }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    for (const id of WINDOW_LAYERS) neighborhood.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    neighborhood.map.triggerRepaint();
    await new Promise((resolve) => { neighborhood.map.once('idle', resolve); setTimeout(resolve, 6000); });
  }, { on, WINDOW_LAYERS });
  // Only the pixels that clear the line are asked who they are, so this is a few hundred queries rather than 30,000.
  const readBox = async (box) => {
    const encoded = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ encoded, box, WALL_LAYERS }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = neighborhood.map;
      const [left, top, right, bottom] = box;
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data;
      const dpr = image.width / window.innerWidth;
      const luma = (i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      let walls = 0, water = 0, other = 0, peak = 0, brightest = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const i = (Math.round(y * dpr) * image.width + Math.round(x * dpr)) * 4;
          const excess = data[i + 2] - data[i + 1];
          brightest = Math.max(brightest, luma(i));
          if (excess < 45) continue;
          peak = Math.max(peak, excess);
          const ids = map.queryRenderedFeatures([x, y]).map((f) => f.layer.id);
          if (ids.some((id) => WALL_LAYERS.includes(id))) walls++;
          else if (ids.some((id) => id === 'water' || id === 'river-surface')) water++;
          else other++;
        }
      }
      return { walls, water, other, peak: Math.round(peak), brightest: Math.round(brightest) };
    }, { encoded, box, WALL_LAYERS });
  };
  const riverBox = [560, 400, 800, 520];
  // One read of the three bands, wherever the camera happens to be: each band's own box against the same river 600 m
  // up and down stream, plus seven points asked who is drawn on top. The box is 37x21 pixels, so `blue` is out of 777.
  const bandRead = async () => {
    const encoded = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ encoded }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const { channelCrossing } = await import('/src/tower.js');
      const { DEFAULT_CENTER } = await import('/src/config.js');
      const map = neighborhood.map;
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const dpr = image.width / window.innerWidth;
      const river = await (await fetch('/data/canton-river.geojson')).json();
      const buildings = await (await fetch('/data/canton-buildings.geojson')).json();
      const lines = river.features.map((feature) => feature.geometry.coordinates);
      const eastScale = 111320 * Math.cos(DEFAULT_CENTER.lat * Math.PI / 180);
      const footOf = (osmId) => {
        const geometry = buildings.features.find((entry) => Number(entry.properties?.osmId) === osmId).geometry;
        const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
        const open = ring[0][0] === ring.at(-1)[0] ? ring.slice(0, -1) : ring;
        return [open.reduce((sum, point) => sum + point[0], 0) / open.length, open.reduce((sum, point) => sum + point[1], 0) / open.length];
      };
      const box = (lng, lat) => {
        const point = map.project([lng, lat]);
        let sum = 0, count = 0, peak = 0, r = 0, g = 0, b = 0;
        for (let y = -10; y <= 10; y += 1) for (let x = -18; x <= 18; x += 1) {
          const offset = (Math.round((point.y + y) * dpr) * image.width + Math.round((point.x + x) * dpr)) * 4;
          const luma = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
          sum += luma; count += 1;
          r += data[offset]; g += data[offset + 1]; b += data[offset + 2];
          peak = Math.max(peak, luma);
        }
        let onWater = 0;
        for (const [x, y] of [[0, 0], [-14, 0], [14, 0], [0, -7], [0, 7], [-14, -7], [14, 7]]) {
          const ids = map.queryRenderedFeatures([point.x + x, point.y + y]).map((feature) => feature.layer.id);
          if (ids.some((id) => id === 'water' || id === 'river-surface')) onWater += 1;
        }
        const rect = map.getCanvas().getBoundingClientRect();
        const seen = point.x > 20 && point.y > 20 && point.x < rect.width - 20 && point.y < rect.height - 20;
        // `warm` and `cool` are the two directions a lamp can push an already blue river: red past green, blue past
        // green. Graded against the same water with no band on it, they say which lamp is lying there.
        return { mean: Math.round(sum / count), peak: Math.round(peak), warm: (r - g) / count, cool: (b - g) / count, onWater, seen };
      };
      const centres = [584204634, 511404889, 184738716].map((osmId) => {
        const foot = osmId === 584204634 ? [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat] : footOf(osmId);
        const axis = channelCrossing(lines, foot);
        return { osmId, axis, at: (downstream) => [DEFAULT_CENTER.lng + (axis.cx + downstream) / eastScale, DEFAULT_CENTER.lat - axis.cz / 110574] };
      });
      // A control has to be the same river with no band on it: in frame, on water at all seven points, and at least
      // 300 m clear of every one of the three bands. The first candidate that fits is not enough - one bright pylon on
      // a single patch would set the bar - so the search keeps the first two that do.
      return centres.map((centre) => {
        const beside = [-700, -550, -400, 400, 550, 700]
          .filter((downstream) => centres.every((other) => other === centre || Math.abs(
            other.axis.cx - centre.axis.cx - downstream) > 300))
          .map((downstream) => ({ downstream, read: box(...centre.at(downstream)) }))
          .filter((candidate) => candidate.read.seen && candidate.read.onWater === 7)
          .slice(0, 2);
        return { osmId: centre.osmId, band: box(...centre.at(0)), beside };
      });
    }, { encoded });
  };
  // The bar a band has to clear is the brightest of the band-free patches of the same river that made it through the
  // filter - two where two fit, at least one. A pylon or a bridge deck that happens to sit downstream is excluded by
  // that filter, so the bar is water, not whatever bright thing stands on it.
  const barOf = (row) => {
    expect(row.beside.length, `no band-free patch of the same river was in frame to grade ${row.osmId} against`)
      .toBeGreaterThanOrEqual(1);
    return row.beside.map((candidate) => candidate.read).reduce((a, b) => (b.mean > a.mean ? b : a));
  };
  // Which way each tower's lamp has to move the water it lies on: 广州塔's is violet so blue pulls ahead of green,
  // 西塔's is the warm end so red does, and 东塔's is the cool white of an office slab, which is the river's own colour
  // and so shows as light rather than as hue. Measured margins at the two cameras are 9-12 points on the channel that
  // each lamp owns, against 1.6-2 for the ones that do not, so the bars below sit well under what the frame gives.
  const HUE = { 584204634: 'cool', 184738716: 'warm' };
  const parked = await readBox(riverBox);
  expect(parked.walls, 'the cool end of the lamps does not reach the riverfront at all').toBeGreaterThanOrEqual(100);
  await setWindows(false);
  expect((await readBox(riverBox)).walls, 'the wall count survived hiding every window layer, so the number above was '
    + 'not the lamps').toBe(0);
  await setWindows(true);
  expect((await readBox(riverBox)).walls, 'hiding and showing the window layers has to hand the frame back').toBe(parked.walls);
  // The strip of river in front of the shaft, searched for rather than guessed: the camera is flown by this test
  // before it, and a hardcoded band landed on the south bank. A row of at least 160 screen pixels whose topmost layer
  // is the water polygon, taken from the band of rows the tower stands in.
  const strip = await page.evaluate(async ({ WALL_LAYERS }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const hit = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] })[0];
    const ring = hit?.geometry?.type === 'Polygon' ? hit.geometry.coordinates[0] : null;
    const xs = ring ? ring.map(([lng, lat]) => map.project([lng, lat]).x) : [];
    const middle = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 720;
    const at = (x, y) => {
      const ids = map.queryRenderedFeatures([x, y]).map((f) => f.layer.id);
      return !ids.some((id) => WALL_LAYERS.includes(id)) && ids.some((id) => id === 'water' || id === 'river-surface');
    };
    for (let y = 400; y <= 520; y += 12) {
      let run = 0, best = 0, bestEnd = 0;
      for (let x = Math.round(middle - 320); x < Math.round(middle + 320); x += 8) {
        if (at(x, y)) { run += 8; if (run > best) { best = run; bestEnd = x + 8; } } else run = 0;
      }
      if (best >= 160) return [bestEnd - 160, y, bestEnd, y + 20];
    }
    return null;
  }, { WALL_LAYERS });
  expect(strip, 'no 160-pixel stretch of river in front of the tower at this camera').not.toBeNull();
  const parkedWater = await readBox(strip);
  expect(parkedWater.walls, 'a wall is inside the river strip, so the strip is not measuring the water').toBe(0);
  // Parked, the band lifts the river to nearly half of full brightness (a strip whose own night luminance sits around
  // 27 reads up to `brightest` here). The colour used to be the gap: the same frame carried 0-20 pixels of it, which is
  // what 三塔落水色带 was asked to close, so it is graded below on the band's own box rather than on this row of water.
  expect(parkedWater.brightest, 'the tower puts no light at all on the water in front of it').toBeGreaterThanOrEqual(120);
  // The strip above is a row of water, not the band, so the colour is graded where the band actually lies: against the
  // same river 600 m up and down stream, in the parked frame rather than in whatever phase a moving frame landed on.
  const parkedBand = (await bandRead())[0];
  const parkedBar = barOf(parkedBand);
  expect(parkedBand.band.mean, `the tower leaves no band on its own stretch of river: ${JSON.stringify(parkedBand)}`)
    .toBeGreaterThanOrEqual(parkedBar.mean + 10);
  expect(parkedBand.band.onWater, `the tower's band is not lying on the drawn water: ${JSON.stringify(parkedBand.band)}`)
    .toBe(7);
  expect(parkedBand.band.cool - parkedBar.cool, `the tower's band is the river's own colour, not a lamp of its own: `
    + `${JSON.stringify({ band: parkedBand.band, bar: parkedBar })}`).toBeGreaterThanOrEqual(6);
  // And across one full breath, deliberately: the frame the picture is judged on has to hold that colour while the
  // shaft cycles through the wheel above it, or the band is a decal of one phase.
  await page.evaluate(async (on) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    if (on && !neighborhood.motionStatus().on) neighborhood.setMotion(true);
  }, motionWasOn);
  const breath = [];
  for (let sweep = 0; sweep < 8; sweep++) {
    breath.push((await bandRead())[0].band.cool - parkedBar.cool);
    await page.waitForTimeout(1500);
  }
  expect(Math.min(...breath.map((value) => Math.round(value))), `the band lost its colour somewhere in a whole breath `
    + `(${breath.map((value) => Math.round(value)).join('/')})`).toBeGreaterThanOrEqual(6);
  await switchAtmosphere(page, 'day');
  await settled(page);
  expect(await readBox(riverBox), 'the same violet cast is on the water by day, so it is not the night spill')
    .toMatchObject({ walls: 0, water: 0 });
  await switchAtmosphere(page, 'night');
  await settled(page);

  // The lamps blink and the crowns breathe, and both stop dead when motion is switched off.
  await camera([113.319181, 23.122579], 15.7, 40, 180);
  const sample = async () => (await lights()).flatMap((form) => form.shells
    .filter((shell) => shell.part === 'crown').map((shell) => shell.intensity));
  const seen = { crown: [] };
  for (let i = 0; i < 9; i += 1) {
    seen.crown.push((await sample()).join('/'));
    await page.waitForTimeout(1000);
  }
  expect(new Set(seen.crown).size, 'no crown breathed over nine seconds').toBeGreaterThan(2);
  // The two crowns are on different periods, so they are never handed the same number at the same time.
  const pairs = seen.crown.map((value) => value.split('/'));
  expect(pairs.every((row) => row.length === 2), 'the axis lost a crown mid-run').toBe(true);
  expect(pairs.filter(([left, right]) => left === right).length, 'the two crowns breathed in step').toBeLessThan(3);

  await page.locator('#motion-toggle').click();
  await page.waitForTimeout(600);
  const held = await Promise.all([sample(), page.waitForTimeout(2500).then(sample)]);
  expect(held[1], 'a stopped loop left something moving').toEqual(held[0]);
  const status = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.motionStatus();
  });
  expect(status.on, 'the motion switch did not take').toBe(false);
  // 三塔落水色带, measured with the loop stopped on purpose: the bands ride the shells' night weight, and a page that
  // never runs the motion loop used to get none of them (the weight only ever arrived on a beacon tick), so this is the
  // state that has to prove the picture is there. Each band is graded against the same river 600 m up and down stream,
  // and against the water polygon under its own feet - a glow that landed on the promenade would clear neither.
  await camera([113.319181, 23.122579], 15.4, 62, 180);
  // 近场与江上的船在这一段收掉：这条判据问的是"色带比它旁边那段江水亮多少"，而 2026-10-09 之后江面上
  // 会停着白上层建筑的船——停住的船仍然比色带亮（实测旁格 peak 169 > 色带 135），拿它当"旁边的水"就把
  // 一条本来存在的色带量成不存在。与 `river scroll` 那一项同一口径：窗口边界与门槛一字不动，只把会写画面
  // 的那两组收掉，它们各自有别的判据守着。
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.getLayer('canton-tower').implementation.setTraffic(false);
  });
  await page.waitForTimeout(900);
  const bands = await bandRead();
  const excesses = bands.map((row) => {
    const bar = barOf(row);
    expect(row.band.onWater, `${row.osmId}'s band is not lying on the drawn water (${row.band.onWater} of 7 points)`).toBe(7);
    expect(row.band.mean, `${row.osmId} leaves no band on its own stretch of river: ${JSON.stringify(row)}`)
      .toBeGreaterThanOrEqual(bar.mean + 10);
    expect(row.band.peak, `${row.osmId}'s band is no brighter at its heart than the water beside it: ${JSON.stringify(row)}`)
      .toBeGreaterThanOrEqual(bar.peak + 20);
    const hue = HUE[row.osmId];
    if (hue) {
      const shift = row.band[hue] - bar[hue];
      expect(shift, `${row.osmId}'s band shows no ${hue} shift of its own on the water: ${JSON.stringify(row)}`)
        .toBeGreaterThanOrEqual(5);
    }
    // Every tower is also scored on red-past-green, because that is the one axis on which the cool white of an office
    // slab and the sodium amber of a residential tower can be told apart at all.
    return Math.round((row.band.warm - bar.warm) * 10) / 10;
  });
  // And the three are not the same light three times: the warm tower's band moves the water's red-past-green by more
  // than the cool one's does, which is the difference between a sodium street and an office slab, read off the river.
  const [towerExcess, eastExcess, westExcess] = excesses;
  expect(westExcess - eastExcess, `西塔's band is no warmer on the water than 东塔's: ${JSON.stringify(excesses)}`)
    .toBeGreaterThanOrEqual(4);
  // No "the protagonist's band is the brightest of the three" claim: measured at the north camera the two nearer shells
  // lift their own water by more than the far tower's lifts its (48 against 46), which is what a camera standing between
  // them does. The hierarchy that does hold is the one the source names - 0.24 of alpha against the tower's 0.55, and
  // the hero camera reads 52.6 against 44.6 - so it is recorded there rather than graded from a second camera.
  // Back off with nothing ticking: the bands ride the shells' night weight, and the layer reads that weight on its own
  // frame, so a page that stopped the loop and then went back to day has to get its river back. This one is read off the
  // meshes rather than off pixels because the day water is brighter than the night water for reasons of its own - the
  // boxes above are what prove the bands reach the river at all.
  await switchAtmosphere(page, 'day');
  await settled(page);
  const parkedSpill = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.towerSpill;
  });
  expect(parkedSpill.map((band) => band.name).sort(), 'the scene drew other than the three bands of the measured channel')
    .toEqual(['184738716:spill', '511404889:spill', 'river-glow']);
  expect(parkedSpill, 'a day switch with the loop stopped left light on the water').toMatchObject([
    { visible: false }, { visible: false }, { visible: false },
  ]);
  expect(errors).toEqual([]);
});

// 花城广场那一格：四层都从实测面来，所以"这一片为什么是石头"永远答得出。这里量的是它到底落在了该落的位置上——
// 用地图自己的投影去取每一块面积心，再读那一像素，而不是在画面上挑一个看着像的点。
test('the plaza axis lays stone, lawn and water where the snapshot says, and stays a green axis', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`); });
  await openMap(page);
  const state = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.plazaState();
  });
  expect(state, '广场那四层没切出来').toMatchObject({ lawn: 20, pool: 1, stone: 4, walk: 17, layers: 4 });
  const order = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.map.getLayersOrder();
  });
  for (const id of ['plaza-lawn', 'plaza-pool', 'plaza-stone', 'plaza-walk']) {
    expect(order.indexOf(id), `${id} 没上图层表`).toBeGreaterThan(-1);
    expect(order.indexOf(id), `${id} 盖到体块上面去了`).toBeLessThan(order.indexOf('neighborhood-buildings'));
  }
  // 正扣着看广场：四层各自占一块屏幕，投影之后都在画面里。
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    // 15.2 级正扣：一屏约 1.8 km，够把广场从南端的草地一直框到北端的水面。
    map.jumpTo({ center: [113.3192, 23.1222], zoom: 15.2, pitch: 0, bearing: 0 });
    if (map.isMoving()) await new Promise((resolve) => map.once('idle', resolve));
    await new Promise((resolve) => { map.once('idle', resolve); map.triggerRepaint(); });
  });
  const spots = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    // `getData()` 在这个版本的 MapLibre 上是异步的：不 await 拿到的是一个空对象，不是那份 FeatureCollection。
    const features = (await map.getSource('canton-plaza').getData()).features;
    const centre = (feature) => {
      const ring = feature.geometry.coordinates[0].slice(0, -1);
      return [ring.reduce((sum, point) => sum + point[0], 0) / ring.length, ring.reduce((sum, point) => sum + point[1], 0) / ring.length];
    };
    const biggest = (kind) => features.filter((feature) => feature.properties.kind === kind)
      .sort((a, b) => (b.properties.area ?? 0) - (a.properties.area ?? 0))[0];
    const spot = (kind) => {
      const feature = biggest(kind);
      if (!feature) return null;
      const point = map.project(centre(feature));
      return { x: Math.round(point.x), y: Math.round(point.y), osmId: feature.properties.osmId };
    };
    // 一块既不在草坪也不在石材也不在水面上的广场地面：它该还是底图那块绿。
    const park = map.project([113.31917, 23.1236]);
    return {
      stone: spot('stone'), lawn: spot('lawn'), pool: spot('pool'),
      ground: { x: Math.round(park.x), y: Math.round(park.y) },
      size: [map.getCanvas().width, map.getCanvas().height],
    };
  });
  for (const key of ['stone', 'lawn', 'pool']) {
    expect(spots[key], `${key} 那一块没有面`).toBeTruthy();
    // 先判在不在画面里：不在的话读到的会是天空或顶栏，那是一条假的颜色失败。
    expect(spots[key].x >= 0 && spots[key].x < 1440 && spots[key].y >= 0 && spots[key].y < 900,
      `${key} 那一块投影到画面外了`).toBe(true);
  }
  const shot = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } })).toString('base64');
  const read = async (at) => page.evaluate(async ({ shot, at }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const index = (at.y * image.width + at.x) * 4;
    return [data[index], data[index + 1], data[index + 2]];
  }, { shot, at });
  const { ATMOSPHERES } = await import('../src/atmosphere.js');
  const near = (rgb, hex, tolerance) => {
    const want = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    return Math.max(...rgb.map((value, index) => Math.abs(value - want[index]))) <= tolerance;
  };
  // 半透的层会把底下的绿混进来一档，所以容差按层的不透明度给：0.92 的草坪最多偏 8% 的色差。
  const day = ATMOSPHERES.day;
  expect(near(await read(spots.stone), day.plaza, 14), `石材点 ${JSON.stringify(await read(spots.stone))} 不是这一档的石材色`).toBe(true);
  expect(near(await read(spots.lawn), day.grass, 16), '草坪点没有落在草地色上').toBe(true);
  expect(near(await read(spots.pool), day.water, 10), '水面点没有落在水色上').toBe(true);
  await page.screenshot({ path: 'docs/screenshots/canton-v11-plaza-day.png' });
  const ground = await read(spots.ground);
  // 那一块没有硬质面，所以它既不能是石材也不能是水面；而"整条轴还读成绿的"这一条，判的是色相方向：
  // 底图那块 park 绿经 0.9 不透明度混过背景，落点不会等于 day.park 的十六进制，只有"绿是主通道"是稳的。
  expect(near(ground, day.plaza, 14), `广场地面 ${JSON.stringify(ground)} 被石材盖住了——那一块没有硬质面`).toBe(false);
  expect(near(ground, day.water, 12), `广场地面 ${JSON.stringify(ground)} 被水面盖住了`).toBe(false);
  expect(ground[1] > ground[0] && ground[1] > ground[2], `广场地面 ${JSON.stringify(ground)} 不是绿的，V5-5 那条绿轴读感没了`).toBe(true);
  // 夜景：石材跟着暗下去，而且不比路面亮。
  await page.click('[data-atmosphere-option="night"]');
  await page.waitForTimeout(2200);
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    await new Promise((resolve) => { map.once('idle', resolve); map.triggerRepaint(); });
  });
  const nightShot = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 900 } })).toString('base64');
  const nightStone = await page.evaluate(async ({ shot, at }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const index = (at.y * image.width + at.x) * 4;
    return [data[index], data[index + 1], data[index + 2]];
  }, { shot: nightShot, at: spots.stone });
  expect(near(nightStone, ATMOSPHERES.night.plaza, 18), `夜景石材点 ${JSON.stringify(nightStone)} 没跟着这一档走色`).toBe(true);
  const luma = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  expect(luma(nightStone)).toBeLessThan(luma([255, 255, 255]) * 0.3, '夜景的中轴烧成一块白');
  await page.screenshot({ path: 'docs/screenshots/canton-v11-plaza-night.png' });
  expect(errors).toEqual([]);
});

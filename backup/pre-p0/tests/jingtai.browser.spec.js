import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.use({ launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, viewport: { width: 1440, height: 960 } });
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const url = `${app}/?scene=jingtai`;
const inspect = (page, expression) => page.evaluate(async expression => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return Function('n', `return (${expression})`)(n);
}, expression);
const settle = page => inspect(page, '(async () => { if (!n.map.loaded() || n.map.isMoving()) await new Promise(resolve => n.map.once("idle", resolve)); return true; })()');
async function open(page) {
  await page.goto(url);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await settle(page);
}
const requests = page => {
  const data = [], errors = [];
  page.on('request', r => { if (r.url().includes('/data/') || r.url().includes('/api/interpreter')) data.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  return { data, errors };
};

function assertHero(s) {
  expect(s.center.lng).toBeCloseTo(113.26646, 5);
  expect(s.center.lat).toBeCloseTo(23.17107, 5);
  expect(s.pitch).toBeGreaterThanOrEqual(55);
  expect(s.pitch).toBeLessThanOrEqual(60);
  expect(s.bearing).toBe(0);
  expect(s.tower).toBe(false);
  expect(s.campus).toContain(1178149399);
  expect(s.targetPitches).toEqual([]);
  expect(s.buildings).toBeGreaterThan(0);
  expect(s.label).toBe('景泰小学（景泰校区）');
}
const hero = page => inspect(page, `({ center:n.map.getCenter(), pitch:n.map.getPitch(), bearing:n.map.getBearing(), tower:!!n.map.getLayer('canton-tower'),
  campus:[...new Set(n.map.queryRenderedFeatures({layers:['school-campus']}).map(f=>f.properties.osmId))],
  targetPitches:n.map.queryRenderedFeatures({layers:['school-pitches']}).filter(f=>f.properties.target).map(f=>f.properties.osmId),
  buildings:n.map.queryRenderedFeatures({layers:['neighborhood-buildings','neighborhood-buildings-overview']}).length,
  label:n.map.getLayoutProperty('tower-label','text-field') })`);

test('school hero uses the correct campus, explicit sports-data gap, north-facing camera and independent 2 km data', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await open(page);
  const s = await hero(page);
  assertHero(s);
  for (const bad of [{ ...s, center: { lat: 23.16768, lng: 113.27002 } }, { ...s, targetPitches: [999] }, { ...s, tower: true }]) expect(() => assertHero(bad)).toThrow();
  await expect(page.locator('.school-data-note')).toContainText('校园操场轮廓未收录');
  await expect(page.locator('.scene-range')).toContainText('2');
  await expect(page.locator('#poi-panel')).toBeHidden();
  expect(log.data.some(path => path.includes('canton-') || path.includes('/api/interpreter'))).toBe(false);
  for (const atmosphere of ['night', 'sunset', 'day']) {
    await page.locator(`[data-atmosphere-option="${atmosphere}"]`).click();
    expect(await inspect(page, `n.map.getPaintProperty('school-pitch-edge','line-color')`)).toBe('#b5493a');
    expect(await inspect(page, `n.map.getPaintProperty('school-pitches','fill-color')`)).toContain('#4a7c59');
  }
  await page.screenshot({ path: 'docs/screenshots/jingtai-desktop.png' });
  await page.locator('#overview-button').click();
  await settle(page);
  const bounds = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { radiusPolygon, distanceMeters } = await import('/src/geo.js');
    const ring = radiusPolygon({ lat: 23.17107, lng: 113.26646 }, 2000).geometry.coordinates[0];
    return { visible: ring.every(point => { const p=n.map.project(point); return p.x>=0&&p.x<=innerWidth&&p.y>=0&&p.y<=innerHeight; }),
      distance: distanceMeters({lat:23.17107,lng:113.26646},{lng:ring[0][0],lat:ring[0][1]}) };
  });
  expect(bounds.visible).toBe(true);
  expect(bounds.distance).toBeCloseTo(2000, 4);
  await page.screenshot({ path: 'docs/screenshots/jingtai-overview.png' });
  expect(log.errors).toEqual([]);
});

test('requested campus red-green sports hero awaits verified in-campus geometry', async ({ page }) => {
  test.fixme(true, '原始 OSM 快照未收录目标校园 pitch/track；保留未满足的视觉验收，不补画、不算通过。');
  await open(page);
  expect((await hero(page)).targetPitches.length).toBeGreaterThan(0);
});

test('requested walking distances await a verified campus-to-road connection', async ({ page }) => {
  test.fixme(true, '校园没有可核验的校门路网连接；直线距离不能替代步行距离。');
  await open(page);
  await page.locator('#places-toggle').click();
  await page.locator('[data-category="transit"]').click();
  for (const name of ['飞翔公园站', '大金钟路站', '中医药大学站']) await expect(page.locator('.poi-item').filter({ hasText: name })).toContainText('步行约');
});

test('school search and shared campus card retain the region and exclude campus from height statistics', async ({ page, context }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('云龙路38号');
  const result = page.locator('#search-results .search-option').filter({ hasText: '景泰小学（景泰校区）' });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator('.building-card h3')).toHaveText('景泰小学（景泰校区）');
  await expect(page.locator('.building-card')).toContainText('校园');
  await expect(page.locator('.building-card')).not.toContainText('9.6');
  expect(new URL(page.url()).searchParams.get('scene')).toBe('jingtai');
  expect(page.url()).toContain('b=1178149399@');
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator('.building-card h3')).toHaveText('景泰小学（景泰校区）', { timeout: 60000 });
  await shared.close();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('[data-lens-mode="height"]').click();
  await settle(page);
  const data = JSON.parse(await readFile(new URL('../public/data/jingtai-buildings.geojson', import.meta.url)));
  const summary = await inspect(page, 'n.buildingSummary()');
  expect(summary.total).toBe(data.features.length);
  expect(summary.sources.estimate).toBe(data.features.filter(f => f.properties.heightSource === 'estimate').length);
  expect(await inspect(page, `n.map.getLayer('height-unknown').type`)).toBe('fill');
  await expect(page.locator('#building-note')).not.toContainText('塔');
  await page.locator('#tour-start').click();
  expect(await inspect(page, 'n.lens')).toEqual({ mode: 'use', category: 'all', source: 'all' });
  await expect(page.locator('#tour-title')).toContainText('景泰');
  await page.keyboard.press('Escape');
  expect(log.data.filter(path => path.includes('jingtai-buildings-index.json'))).toHaveLength(1);
  expect(log.errors).toEqual([]);
});

test('relation building search, hole-safe selection and sharing use the same OSM identity', async ({ page, context }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await open(page);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('白云区少年宫');
  await page.locator('.search-option').filter({ hasText: '白云区少年宫' }).click();
  await expect(page.locator('.building-card h3')).toHaveText('白云区少年宫');
  await expect(page.locator('.building-card .osm-link')).toHaveAttribute('href', 'https://www.openstreetmap.org/relation/4779478');
  expect(page.url()).toContain('b=relation/4779478@');
  const { pointInGeometry } = await import('../src/jingtai-data.js');
  const buildings = JSON.parse(await readFile(new URL('../public/data/jingtai-buildings.geojson', import.meta.url)));
  const footprint = buildings.features.find(f => f.properties.osmId === 'relation/4779478').geometry;
  const [lat, lng] = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('b').split('@')[1].split(',').map(Number);
  expect(pointInGeometry(footprint, lng, lat)).toBe(true);
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator('.building-card h3')).toHaveText('白云区少年宫', { timeout: 60000 });
  expect(shared.url()).toContain('b=relation/4779478@');
  await shared.close();
  expect(log.errors).toEqual([]);
});

test('local life POIs retain parks, pitches and three metros, distinguish walking and straight distance, and cache reopening', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await open(page);
  await page.locator('#places-toggle').click();
  const snapshot = JSON.parse(await readFile(new URL('../public/data/jingtai-pois.json', import.meta.url)));
  await expect(page.locator('#poi-list .poi-item')).toHaveCount(snapshot.pois.length);
  await expect(page.locator('.poi-heading')).toContainText('生活配套');
  await expect(page.locator('#poi-status')).toContainText(`2 公里内收录 ${snapshot.total} 处`);
  for (const name of ['三泰公园东苑', '三泰公园西苑', '大金钟路', '飞翔公园', '中医药大学']) await expect(page.locator('#poi-list')).toContainText(name);
  await page.locator('[data-category="transit"]').click();
  const metros = snapshot.pois.filter(poi => poi.category === 'transit');
  await expect(page.locator('#poi-list .poi-item')).toHaveCount(metros.length);
  for (const poi of metros) {
    const row = page.locator('.poi-item').filter({ hasText: poi.name });
    await expect(row).toContainText(poi.walkingDistance ? '步行' : '直线');
    await row.click();
    await expect(page.locator('.poi-card h3')).toHaveText(poi.name);
    await expect(page.locator('.poi-card')).toContainText(poi.walkingDistance ? '路网' : '暂缺');
    await page.locator('[aria-label="关闭地点卡片"]').click();
  }
  await page.locator('#close-places').click();
  await settle(page);
  expect(await inspect(page, `n.map.getLayoutProperty('poi-markers','visibility')`)).toBe('none');
  expect(await inspect(page, `n.map.queryRenderedFeatures({layers:['poi-markers','walking-route']}).length`)).toBe(0);
  await page.locator('#places-toggle').click();
  expect(log.data.filter(path => path.includes('jingtai-pois.json'))).toHaveLength(1);
  expect(log.data.some(path => path.includes('/api/interpreter'))).toBe(false);
  expect(log.errors).toEqual([]);
});

test('school POI snapshot failures can retry without blocking the map', async ({ page }) => {
  test.setTimeout(90000);
  let calls = 0;
  await page.route('**/data/jingtai-pois.json', async route => {
    calls++;
    if (calls === 1) await route.fulfill({ status: 503, body: 'Unavailable' });
    else await route.continue();
  });
  await open(page);
  await page.locator('#places-toggle').click();
  await expect(page.locator('#retry-pois')).toBeVisible();
  await expect(page.locator('#poi-status')).toContainText('503');
  await page.locator('#retry-pois').click();
  await expect(page.locator('#poi-list .poi-item').first()).toBeVisible();
  expect(calls).toBe(2);
  await page.locator('#close-places').click();
  await page.locator('#recenter-button').click();
  await settle(page);
  assertHero(await hero(page));
});

test('school tour reaches all real stops, supports reduced-motion stepping, pause and exit', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const metadata = JSON.parse(await readFile(new URL('../public/data/jingtai-metadata.json', import.meta.url)));
  const stops = [
    { name: '景泰小学（景泰校区）', lng: 113.26646, lat: 23.17107 },
    ...['way/337541381', 'way/337541386', 'relation/8249243'].map(sourceId => metadata.report.tourAnchors.find(anchor => anchor.sourceId === sourceId)),
  ];
  const names = ['景泰小学（景泰校区）', '三泰公园东苑', '三泰公园西苑', '白云山林地边界'];
  async function atStop(index) {
    await expect(page.locator('#tour-title')).toHaveText(names[index], { timeout: 12000 });
    await expect.poll(() => inspect(page, 'n.map.isMoving()')).toBe(false);
    const camera = await inspect(page, 'n.map.getCenter()');
    expect(camera.lng).toBeCloseTo(stops[index].lng, 5);
    expect(camera.lat).toBeCloseTo(stops[index].lat, 5);
    await expect(page.locator('#tour-route [aria-current="step"]')).toHaveText(names[index]);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const before = log.data.length;
  for (const [width, height] of [[320, 568], [568, 320]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#tour-start').click();
    await expect(page.locator('#tour-play')).toHaveText('继续');
    for (let index = 0; index < 4; index++) {
      await atStop(index);
      await settle(page);
      for (const selector of ['#tour-next', '#tour-exit', '#scene-nav a[href="?scene=canton"]', '.maplibregl-ctrl-attrib-button']) await page.locator(selector).click({ trial: true });
      const clear = await page.evaluate(() => {
        const marker = document.querySelector('.tour-marker').getBoundingClientRect();
        const player = document.querySelector('#tour-player').getBoundingClientRect();
        const inside = r => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        const separate = (a, b) => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
        const controls = [...document.querySelectorAll('.brand, #scene-nav, #atmosphere-controls, .maplibregl-ctrl-attrib')].map(node => node.getBoundingClientRect());
        return inside(marker) && inside(player) && separate(marker, player) && controls.every(r => separate(player, r) && separate(marker, r));
      });
      expect(clear, `${width}x${height} stop ${index}`).toBe(true);
      if (index === 0) await page.screenshot({ path: `docs/screenshots/jingtai-tour-${width}.png` });
      if (index < 3) await page.locator('#tour-next').click();
    }
    await page.locator('#tour-previous').click();
    await atStop(2);
    await page.locator('#tour-next').click();
    await atStop(3);
    await page.locator('#tour-next').click();
    await expect(page.locator('#tour-player')).toBeHidden();
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#tour-start').click();
  await page.locator('#tour-play').click();
  await expect(page.locator('#tour-play')).toHaveText('继续');
  expect(await inspect(page, 'n.map.isMoving()')).toBe(false);
  await page.locator('#tour-play').click();
  for (let index = 0; index < 4; index++) await atStop(index);
  await expect(page.locator('#tour-player')).toBeHidden({ timeout: 10000 });
  await page.locator('#tour-start').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#tour-player')).toBeHidden();
  expect(log.data.length).toBe(before);
  expect(log.errors).toEqual([]);
});

test('school orbit submits at least fifty map frames per second without extra data requests', async ({ page }) => {
  test.setTimeout(90000);
  const log = requests(page);
  await open(page);
  const before = log.data.length;
  await page.locator('#orbit-button').click();
  const performance = await inspect(page, `(async () => {
    const times=[]; const render=()=>times.push(performance.now()); n.map.on('render',render);
    const start=performance.now(); await new Promise(resolve=>setTimeout(resolve,15000));
    n.map.off('render',render); const elapsed=performance.now()-start; n.stopOrbit();
    const gaps=times.slice(1).map((time,i)=>time-times[i]).sort((a,b)=>a-b);
    return {frames:times.length,elapsed,fps:times.length*1000/elapsed,p95:gaps[Math.floor(gaps.length*.95)]};
  })()`);
  expect(performance.fps).toBeGreaterThanOrEqual(50);
  expect(log.data.length).toBe(before);
  expect(log.errors).toEqual([]);
  console.log(JSON.stringify({schoolRendering:performance}));
});

test('scene links remain reachable on small screens and switching back keeps the tower separate', async ({ page }) => {
  test.setTimeout(180000);
  const log = requests(page);
  await open(page);
  for (const [width, height] of [[390,844],[320,568],[568,320],[667,375],[844,390],[1024,768]]) {
    await page.setViewportSize({width,height});
    await page.locator('#recenter-button').click();
    await settle(page);
    for (const selector of ['a[href="?scene=canton"]','#scene-nav a[href="?scene=jingtai"]','#places-toggle','#search-toggle','[data-atmosphere-option="night"]']) await page.locator(selector).click({trial:true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const point = await inspect(page, 'n.map.project([113.26646,23.17107])');
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(width);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(height);
    const campusClear = () => page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.classList.contains('maplibregl-canvas'), point);
    expect(await campusClear()).toBe(true);
    if (width === 320) {
      const original = await page.locator('.scene-key').getAttribute('style');
      try {
        await page.locator('.scene-key').evaluate((node, point) => node.style.cssText = `position:fixed;left:${point.x - 20}px;top:${point.y - 20}px;bottom:auto;width:40px;height:40px;z-index:100`, point);
        const covered = await campusClear();
        expect(() => expect(covered).toBe(true)).toThrow();
      } finally {
        await page.locator('.scene-key').evaluate((node, original) => original === null ? node.removeAttribute('style') : node.setAttribute('style', original), original);
      }
      expect(await campusClear()).toBe(true);
    }
    await page.screenshot({ path:`docs/screenshots/jingtai-${width}.png` });
    await page.locator('#places-toggle').click();
    await expect(page.locator('#poi-list .poi-item').first()).toBeVisible();
    await page.locator('[data-category="park"]').click();
    await expect(page.locator('#poi-list .poi-item').first()).toBeVisible();
    await page.locator('#search-toggle').click();
    await page.locator('#search-input').fill('景泰');
    await expect(page.locator('.search-option').first()).toBeVisible();
    for (const selector of ['#search-input', '#close-places', '.maplibregl-ctrl-attrib-button', '[data-atmosphere-option="night"]']) await page.locator(selector).click({ trial: true });
    const panels = await page.evaluate(() => ['#search-panel', '#poi-panel'].map(selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
    expect(panels.every(p => p.inside)).toBe(true);
    expect(Math.min(panels[0].right, panels[1].right) <= Math.max(panels[0].left, panels[1].left) || Math.min(panels[0].bottom, panels[1].bottom) <= Math.max(panels[0].top, panels[1].top)).toBe(true);
    await page.locator('#search-toggle').click();
    await page.locator('#close-places').click();
    await page.locator('#tour-start').click();
    await expect(page.locator('#tour-player')).toBeVisible();
    await expect(page.locator('#tour-title')).toContainText('景泰小学');
    await page.locator('a[href="?scene=canton"]').click({trial:true});
    await page.locator('#tour-exit').click();
  }
  await page.locator('a[href="?scene=canton"]').click();
  await expect(page.locator('#places-toggle')).toBeEnabled({timeout:60000});
  expect(await inspect(page, `!!n.map.getLayer('canton-tower')`)).toBe(true);
  expect(await inspect(page, `!!n.map.getSource('school-grounds')`)).toBe(false);
  await expect(page.locator('.scene-range')).toContainText('3');
  await page.locator('#scene-nav a[href="?scene=jingtai"]').click();
  await expect(page.locator('#places-toggle')).toBeEnabled({timeout:60000});
  await settle(page);
  assertHero(await hero(page));
  expect(log.errors).toEqual([]);
});

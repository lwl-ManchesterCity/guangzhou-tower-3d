import { test, expect } from '@playwright/test';
import { sceneReadyOrSkip, watchRemote } from './live-places.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test.use({ launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, viewport: { width: 1440, height: 960 } });
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const url = `${app}/?scene=jingtai`;
const blockScreenshot = (page, name) => page.screenshot({
  path: fileURLToPath(new URL(`../docs/screenshots/jingtai-camera-${name}.png`, import.meta.url)),
});
const inspect = (page, expression) => page.evaluate(async expression => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return Function('n', `return (${expression})`)(n);
}, expression);
const settle = page => inspect(page, '(async () => { if (!n.map.loaded() || n.map.isMoving()) await new Promise(resolve => n.map.once("idle", resolve)); return true; })()');
// The atmosphere switch is a 1.2 s walk and `settle` cannot see it - the map reports itself loaded and unmoving the whole
// way through - so anything read right after a click lands on a frame of the transition instead of on the theme.
const moodSettled = page => inspect(page, '(async () => { while (n.atmosphere.running) await new Promise(resolve => setTimeout(resolve, 50)); await new Promise(resolve => { n.map.once("idle", resolve); n.map.triggerRepaint(); }); return true; })()');
const switchAtmosphere = async (page, id) => {
  await page.locator(`[data-atmosphere-option="${id}"]`).click();
  await moodSettled(page);
};
async function open(page) {
  await page.goto(url);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await settle(page);
}
const requests = page => {
  const data = [], errors = [];
  page.on('request', r => { if (r.url().includes('/data/') || r.url().includes('/local/') || r.url().includes('/api/interpreter')) data.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  return { data, errors };
};
// The lattice scan a merged hull needs to be clickable: the projected bounding box is walked 4 px at a time and a point
// only counts when its centre and the four corners around it all still answer as that same group.
const hullPoint = (page, ring, id) => page.evaluate(async ({ ring, id }) => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const projected = ring.map(point => n.map.project(point));
  const left = Math.max(2, Math.min(...projected.map(p => p.x)));
  const right = Math.min(innerWidth - 2, Math.max(...projected.map(p => p.x)));
  const top = Math.max(2, Math.min(...projected.map(p => p.y)) - 30);
  const bottom = Math.min(innerHeight - 2, Math.max(...projected.map(p => p.y)));
  for (let y = Math.ceil(top); y <= bottom; y += 4) for (let x = Math.ceil(left); x <= right; x += 4) {
    if (!document.elementFromPoint(x, y)?.classList.contains('maplibregl-canvas')) continue;
    const inside = [[0,0], [-4,-4], [-4,4], [4,-4], [4,4]].every(([dx,dy]) =>
      { const hit = n.map.queryRenderedFeatures([[x+dx-2,y+dy-2],[x+dx+2,y+dy+2]], {layers:['school-campus','school-building-groups']})[0];
        return hit && String(hit.properties.groupId ?? hit.properties.osmId) === id; });
    if (inside) return {x,y};
  }
  return null;
}, { ring, id });
// Every snapshot expectation uses the same road/campus-aware inputs as the actual scene.
let sceneFixture;
async function formalScene() {
  if (!sceneFixture) {
    const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url)));
    const [data, roads, grounds] = await Promise.all([
      '../public/data/jingtai-buildings.geojson', '../public/data/jingtai-roads.geojson', '../public/data/jingtai-grounds.geojson',
    ].map(load));
    const { groupBuildings, groupDisplay } = await import('../src/groups.js');
    const options = { center: { lat: 23.17107, lng: 113.26646 }, roads: roads.features,
      campusGeometry: grounds.features.find(f => f.properties.target && f.properties.kind === 'campus').geometry };
    const grouping = groupBuildings(data.features, options);
    sceneFixture = { data, options, grouping, display: groupDisplay(grouping, 'all') };
  }
  return sceneFixture;
}
const selectedShapes = page => inspect(page, '(async () => (await n.map.getSource("building-selection").getData()).features)()');
const displayedShapes = page => inspect(page, '(async () => (await n.map.getSource("school-building-groups").getData()).features)()');
const assertSelectedGeometry = (features, shapes) => expect(features.map(f => f.geometry)).toEqual(shapes.map(f => f.geometry));
const assertModelSelection = (features, shapes) => {
  assertSelectedGeometry(features, shapes);
  expect(features.map(f => f.properties)).toEqual(shapes.map(f => ({ height: f.properties.displayHeight, base: f.properties.base })));
};
const modelThicknessText = ({ properties: p }) => `模型厚度 ${Number((p.displayHeight - p.base).toFixed(1))} m（按体块短边设置），不代表实际楼高。`;
const shareSelection = address => new URLSearchParams(new URL(address).hash.slice(1)).get('b');
const originalSelection = (feature, point) => `${feature.properties.osmId}@${Number(point[1].toFixed(6))},${Number(point[0].toFixed(6))}`;

// Expected titles use the formal display, never groupShape's intermediate convex hull.
let namesOfGroups = null;
async function inferredNames() {
  if (!namesOfGroups) {
    const { display } = await formalScene();
    const snapshot = JSON.parse(await readFile(new URL('../data/jingtai-amap-names.json', import.meta.url)));
    const { nameGroups } = await import('../src/names.js');
    const merged = display.features.filter(shape => shape.properties.aggregate);
    namesOfGroups = { merged, named: nameGroups(merged, snapshot.places), byMember: display.byMember };
  }
  return namesOfGroups;
}

function assertHero(s) {
  expect(s.center.lng).toBeCloseTo(113.26646, 5);
  expect(s.center.lat).toBeCloseTo(23.17107, 5);
  // MapLibre rebuilds the constructor camera through its own pitch maths, so 58 arrives as 58.00000000000001; 10 digits
  // still rejects any real camera difference (0.0000000001°).
  expect(s.pitch).toBeCloseTo(58, 10);
  expect(s.bearing).toBe(0);
  expect(s.tower).toBe(false);
  expect(s.campus).toContain(1178149399);
  expect(s.targetPitches).toEqual([]);
  expect(s.buildings).toBeGreaterThan(0);
  expect(s.originalVisibility).toEqual(['none', 'none']);
  expect(s.label).toBe('景泰小学（景泰校区）');
  // The window grid is a canton decision: the school scene stays a maquette and must not gain the overlay or its images.
  expect(s.facade).toEqual([false, 0]);
  // Same for the river sheen: it dresses the Pearl River, which is a canton feature, and its three tiles would be
  // uploaded into the school scene for nothing.
  expect(s.river).toEqual([false, 0]);
  // Neither do the night lamps or their spill: they are a canton skyline decision, and their twenty-seven tiles each
  // would be uploaded into the school scene for nothing.
  expect(s.lights).toEqual([false, 0]);
  expect(s.glow).toEqual([false, 0]);
}
const hero = page => inspect(page, `({ center:n.map.getCenter(), pitch:n.map.getPitch(), bearing:n.map.getBearing(), tower:!!n.map.getLayer('canton-tower'),
  campus:[...new Set(n.map.queryRenderedFeatures({layers:['school-campus']}).map(f=>f.properties.osmId))],
  targetPitches:n.map.queryRenderedFeatures({layers:['school-pitches']}).filter(f=>f.properties.target).map(f=>f.properties.osmId),
  buildings:n.map.queryRenderedFeatures({layers:['school-building-groups']}).length,
  originalVisibility:['neighborhood-buildings','neighborhood-buildings-overview'].map(id=>n.map.getLayoutProperty(id,'visibility')),
  facade:[!!n.map.getLayer('building-facade'), n.map.listImages().filter(x=>x.indexOf('building-facade')===0).length],
  lights:[!!n.map.getLayer('building-lights'), n.map.listImages().filter(x=>x.indexOf('building-lights')===0).length],
  glow:[!!n.map.getLayer('building-glow'), n.map.listImages().filter(x=>x.indexOf('building-glow')===0).length],
  river:[!!n.map.getLayer('river-surface'), n.map.listImages().filter(x=>x.indexOf('river-surface')===0).length],
  label:n.map.getLayoutProperty('tower-label','text-field') })`);

test('school hero uses the correct campus, explicit sports-data gap, north-facing camera and independent 2 km data', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await open(page);
  const s = await hero(page);
  assertHero(s);
  for (const bad of [{ ...s, center: { lat: 23.16768, lng: 113.27002 } }, { ...s, targetPitches: [999] }, { ...s, tower: true }, { ...s, pitch: 48 }, { ...s, facade: [true, 12] }, { ...s, river: [true, 3] }]) expect(() => assertHero(bad)).toThrow();
  await expect(page.locator('.school-data-note')).toContainText('校园操场轮廓未收录');
  await expect(page.locator('.scene-range')).toContainText('2');
  await expect(page.locator('#poi-panel')).toBeHidden();
  expect(log.data.some(path => path.includes('canton-') || path.includes('/api/interpreter'))).toBe(false);
  for (const atmosphere of ['night', 'sunset', 'day']) {
    await switchAtmosphere(page, atmosphere);
    expect(await inspect(page, `n.map.getPaintProperty('school-pitch-edge','line-color')`)).toBe('#b5493a');
    expect(await inspect(page, `n.map.getPaintProperty('school-pitches','fill-color')`)).toContain('#4a7c59');
  }
  await blockScreenshot(page, 'desktop');
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
  await blockScreenshot(page, 'overview');
  expect(log.errors).toEqual([]);
});

const composition = page => inspect(page, `(async () => {
  const campus = (await n.map.getSource('school-grounds').getData()).features.find(f => f.properties.kind === 'campus' && f.properties.target);
  const points = campus.geometry.coordinates[0].map(point => n.map.project(point));
  const box = { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
  const point = n.map.project([113.26646, 23.17107]);
  const size = n.map.getLayoutProperty('tower-label', 'text-size'), offset = n.map.getLayoutProperty('tower-label', 'text-offset');
  const halfWidth = n.map.getLayoutProperty('tower-label', 'text-field').length * size / 2 + 4;
  const label = { left: point.x - halfWidth, right: point.x + halfWidth, top: point.y + offset[1] * size - size - 3, bottom: point.y + offset[1] * size + 3 };
  const obstacles = [...document.querySelectorAll('.topbar, .scene-intro, .scene-key, .view-controls, .maplibregl-ctrl-group, .maplibregl-ctrl-attrib')].filter(node => {
    const style = getComputedStyle(node); return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
  }).map(node => ({ name: node.className, box: node.getBoundingClientRect().toJSON() }));
  return { box, label, obstacles, width: innerWidth, height: innerHeight, zoom: n.map.getZoom(), size, offset,
    anchor: n.map.getLayoutProperty('tower-label', 'text-anchor'), geometry: campus.geometry,
    labels: n.map.queryRenderedFeatures({layers:['tower-label']}).length };
})()`);
function assertComposition(s) {
  const landscape = s.width >= 568 && s.width <= 1000 && s.height <= 500;
  expect(s.zoom).toBe(landscape ? 16.45 : s.width <= 760 ? 16.7 : 16.65);
  expect(s.box.right - s.box.left).toBeGreaterThan(landscape ? 95 : 110);
  expect(s.box.bottom - s.box.top).toBeGreaterThan(landscape ? 60 : 70);
  expect(s.size).toBe(13);
  expect(s.offset).toEqual([0, -1.2]);
  expect(s.anchor).toBe('bottom');
  expect(s.labels).toBeGreaterThan(0);
  for (const [name, box] of [['campus', s.box], ['label', s.label]]) {
    expect(box.left, name).toBeGreaterThan(0);
    expect(box.right, name).toBeLessThan(s.width);
    expect(box.top, name).toBeGreaterThan(0);
    expect(box.bottom, name).toBeLessThan(s.height);
    for (const obstacle of s.obstacles) {
      const b = obstacle.box;
      expect(box.right + 4 <= b.left || box.left - 4 >= b.right || box.bottom + 4 <= b.top || box.top - 4 >= b.bottom, `${name} clear of ${obstacle.name}`).toBe(true);
    }
  }
}

test('campus framing keeps the full campus and label clear across themes and narrow screens', async ({ page }) => {
  test.setTimeout(180000);
  const log = requests(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const { options } = await formalScene();
  for (const [width, height] of [[1440,960],[390,844],[320,568],[568,320],[667,375],[844,390],[1024,768]]) {
    await page.setViewportSize({width,height});
    await expect.poll(() => inspect(page, '[n.map.getCanvas().width / devicePixelRatio, n.map.getCanvas().height / devicePixelRatio]')).toEqual([width, height]);
    await page.locator('#recenter-button').click();
    await settle(page);
    await expect.poll(() => inspect(page, 'n.map.queryRenderedFeatures({layers:["tower-label"]}).length')).toBeGreaterThan(0);
    const current = await composition(page);
    assertComposition(current);
    expect(current.geometry).toEqual(options.campusGeometry);
    console.log(`campus framing ${width}x${height}: ${JSON.stringify(current.box)}`);
    for (const bad of [
      { ...current, zoom: 15.8 }, { ...current, size: 12 }, { ...current, offset: [0, 2] }, { ...current, anchor: 'top' }, { ...current, labels: 0 },
      { ...current, box: { ...current.box, right: current.box.left + 79 } },
      { ...current, box: { ...current.box, bottom: current.box.top + 42 } },
      ...['box', 'label'].flatMap(key => [
        { ...current, [key]: { ...current[key], left: -1 } }, { ...current, [key]: { ...current[key], right: width + 1 } },
        { ...current, [key]: { ...current[key], top: -1 } }, { ...current, [key]: { ...current[key], bottom: height + 1 } },
        { ...current, obstacles: [{ name: 'injected obstruction', box: current[key] }] },
      ]),
    ]) expect(() => assertComposition(bad)).toThrow();
    const badGeometry = structuredClone(current.geometry);
    badGeometry.coordinates[0][0][0] += 0.001;
    expect(() => expect(badGeometry).toEqual(options.campusGeometry)).toThrow();
    if (width === 1440) {
      await inspect(page, 'n.map.jumpTo({zoom:15.8,pitch:57})');
      await settle(page);
      const distant = await composition(page);
      expect(() => assertComposition({ ...distant, zoom: current.zoom })).toThrow();
      await page.locator('#recenter-button').click();
      await settle(page);
    }
    if (width === 320 || width === 568) {
      const css = width === 320
        ? `body[data-scene='jingtai'] h1 {margin-bottom:12px} body[data-scene='jingtai'] .intro-actions .text-button {margin-top:13px} body[data-scene='jingtai'] .school-data-note {margin-top:12px}`
        : `body[data-scene='jingtai']:not([data-places='open']) .view-controls {bottom:62px}`;
      const mutant = await page.addStyleTag({ content: css });
      try { const obstructed = await composition(page); expect(() => assertComposition(obstructed)).toThrow(); }
      finally { await mutant.evaluate(node => node.remove()); }
      assertComposition(await composition(page));
    }
    for (const theme of width === 1440 ? ['day','sunset','night'] : ['day']) {
      await switchAtmosphere(page, theme);
      await settle(page);
      assertComposition(await composition(page));
      await blockScreenshot(page, `campus-${width}-${theme}`);
    }
  }
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
  const inferred = (await inferredNames()).byMember.get('relation/4779478');
  const named = (await inferredNames()).named.get(String(inferred.properties.groupId));
  expect(named.name).toBeTruthy();
  await expect(page.locator('.building-card h3')).toHaveText(named.name);
  await expect(page.locator('.building-card .name-inferred')).toContainText('属推断');
  await expect(page.locator('.building-card')).toContainText('名称来自高德地点搜索（仅本机开发）');
  await expect(page.locator('.building-card')).toContainText('定位成员：白云区少年宫');
  await expect(page.locator('.building-card')).toContainText('同组 12 栋');
  await expect(page.locator('.building-card .osm-link')).toHaveText('查看定位成员的 OSM 记录 ↗');
  await expect(page.locator('.building-card .osm-link')).toHaveAttribute('href', 'https://www.openstreetmap.org/relation/4779478');
  expect(page.url()).toContain('b=relation/4779478@');
  const { pointInGeometry } = await import('../src/jingtai-data.js');
  const buildings = JSON.parse(await readFile(new URL('../public/data/jingtai-buildings.geojson', import.meta.url)));
  const footprint = buildings.features.find(f => f.properties.osmId === 'relation/4779478').geometry;
  const [lat, lng] = new URLSearchParams(new URL(page.url()).hash.slice(1)).get('b').split('@')[1].split(',').map(Number);
  expect(pointInGeometry(footprint, lng, lat)).toBe(true);
  const shared = await context.newPage();
  await shared.goto(page.url());
  await expect(shared.locator('.building-card h3')).toHaveText(named.name, { timeout: 60000 });
  await expect(shared.locator('.building-card')).toContainText('定位成员：白云区少年宫');
  await expect(shared.locator('.building-card .osm-link')).toHaveAttribute('href', 'https://www.openstreetmap.org/relation/4779478');
  expect(shared.url()).toContain('b=relation/4779478@');
  await shared.close();
  expect(log.errors).toEqual([]);
});

test('a merged shape with no place near it keeps the plain group title', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const { merged, named } = await inferredNames();
  const unnamed = merged.filter(shape => !named.has(String(shape.properties.groupId)));
  expect(merged).toHaveLength(378);
  expect(named.size).toBe(247);
  expect(unnamed).toHaveLength(131);
  await open(page);
  expect(log.data.some(path => path.includes('/local/jingtai-amap-names.json'))).toBe(true);
  const { geometryPoint } = await import('../src/jingtai-data.js');
  const card = page.locator('.building-card');
  let clicked = null;
  for (const shape of unnamed.sort((a, b) => a.properties.distance - b.properties.distance).slice(0, 5)) {
    const [lng, lat] = geometryPoint(shape.geometry);
    await inspect(page, `n.map.jumpTo({center:[${lng},${lat}], zoom:16.8, pitch:55, padding:{top:0,bottom:0,left:0,right:0}})`);
    await settle(page);
    const point = await hullPoint(page, shape.geometry.coordinates[0], String(shape.properties.groupId));
    if (point) { await page.mouse.click(point.x, point.y); clicked = shape; break; }
  }
  expect(clicked, 'a merged shape near the school must be clickable').not.toBeNull();
  await expect(card).toContainText('建筑群 · 合并示意');
  await expect(card.locator('h3')).toHaveText('相邻建筑群');
  await expect(card.locator('.name-inferred')).toHaveCount(0);
  expect(log.errors).toEqual([]);
});

// The snapshot is served only by the dev middleware, so "no file" is the state every published build is in: the card
// has to fall back on its own, without a console error and without losing the group facts.
test('a missing name snapshot falls back to the plain group title', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const byMember = (await inferredNames()).byMember;
  const named = (await inferredNames()).named.get(String(byMember.get('relation/4779478').properties.groupId));
  expect(named.name).toBeTruthy();
  await page.route('**/local/jingtai-amap-names.json', route => route.fulfill({ status: 404, body: 'not found' }));
  await open(page);
  await expect(page.locator('.street-nameplates')).toHaveCount(0);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('白云区少年宫');
  await page.locator('.search-option').filter({ hasText: '白云区少年宫' }).click();
  const card = page.locator('.building-card');
  await expect(card.locator('h3')).toHaveText('相邻建筑群');
  await expect(card.locator('.name-inferred')).toHaveCount(0);
  await expect(card).toContainText('同组 12 栋');
  expect(existsSync(new URL('../data/jingtai-amap-names.json', import.meta.url))).toBe(true);
  expect(existsSync(new URL('../public/data/jingtai-amap-names.json', import.meta.url))).toBe(false);
  expect(log.errors).toEqual([]);
});

test('a loaded real name snapshot never adds street nameplate DOM at default or enlarged cameras', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const snapshotResponse = page.waitForResponse('**/local/jingtai-amap-names.json');
  await open(page);
  const response = await snapshotResponse;
  expect(response.ok()).toBe(true);
  expect((await response.json()).places.length).toBeGreaterThan(0);
  const nameplateCount = () => inspect(page, `document.querySelectorAll('.street-nameplates, .street-nameplate').length`);
  const assertNoNameplates = count => expect(count).toBe(0);
  for (const [width, height] of [[1440,960], [390,844], [568,320]]) {
    await page.setViewportSize({width, height});
    await expect(page.locator('.maplibregl-canvas')).toHaveCSS('width', `${width}px`);
    await page.locator('#recenter-button').click();
    await settle(page);
    assertNoNameplates(await nameplateCount());
    await inspect(page, 'n.map.jumpTo({zoom:17})');
    await settle(page);
    assertNoNameplates(await nameplateCount());
  }
  const injected = await page.evaluateHandle(() => {
    const node = document.createElement('div');
    node.className = 'street-nameplates street-nameplate';
    node.hidden = true;
    document.body.append(node);
    return node;
  });
  try {
    const bad = await nameplateCount();
    expect(() => assertNoNameplates(bad)).toThrow();
  } finally {
    await injected.evaluate(node => node.remove());
    await injected.dispose();
  }
  assertNoNameplates(await nameplateCount());
  expect(log.data.filter(path => path.includes('/local/jingtai-amap-names.json'))).toHaveLength(1);
  expect(log.errors).toEqual([]);
});

test('a group stays one solid shape at every zoom and its former gaps are clickable', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const { data, grouping, display } = await formalScene();
  const { geometryPoint, pointInGeometry } = await import('../src/jingtai-data.js');
  const group = grouping.groupOf('893906742');
  const shape = display.byMember.get('893906742');
  expect(group.id).toBe('893906739');
  expect(group.count).toBe(56);
  const clicked = group.features.find(feature => String(feature.properties.osmId) === '893906742');
  const [lng, lat] = geometryPoint(clicked.geometry);
  await page.goto(`${url}#map=16.8/${lat.toFixed(6)}/${lng.toFixed(6)}/0/55&b=893906742@${lat.toFixed(6)},${lng.toFixed(6)}`);
  const card = page.locator('.building-card');
  await expect(card).toContainText('同组 56 栋', { timeout: 60000 });
  await expect(card).toContainText('非真实小区边界');
  await expect(card).toContainText(modelThicknessText(shape));
  await expect(card).toContainText('邻接归组：间距 ≤ 45 m、跨度 ≤ 280 m，连接避开地面道路与校园');
  await expect(card).toContainText('规整体块会填补或收缩原轮廓');
  const selected = () => selectedShapes(page);
  expect((await selected()).map(feature => feature.geometry)).toEqual([shape.geometry]);
  expect(page.url()).toContain('b=893906742@');
  await settle(page);
  await blockScreenshot(page, 'group');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  expect(await selected()).toEqual([]);
  for (const zoom of [13, 18]) {
    await inspect(page, `n.map.jumpTo({zoom:${zoom}, pitch:0})`);
    await settle(page);
    const shown = await inspect(page, `({hits:n.map.queryRenderedFeatures({layers:['school-building-groups']}).filter(f=>f.properties.groupId==='${group.id}').length,
      original:['neighborhood-buildings','neighborhood-buildings-overview'].map(id=>n.map.getLayoutProperty(id,'visibility'))})`);
    expect(shown.hits).toBeGreaterThan(0);
    expect(shown.original).toEqual(['none', 'none']);
  }
  const ring = shape.geometry.coordinates[0];
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const gaps = [];
  for (let x = 1; x < 20; x++) for (let y = 1; y < 20; y++) {
    const point = [Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * x / 20,
      Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * y / 20];
    if (pointInGeometry(shape.geometry, ...point) && !data.features.some(feature => pointInGeometry(feature.geometry, ...point))) gaps.push(point);
  }
  expect(gaps.length).toBeGreaterThan(0);
  const hit = await page.evaluate(async ({ gaps, id }) => {
    const { neighborhood:n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    for (const point of gaps) {
      const p = n.map.project(point);
      if (!document.elementFromPoint(p.x, p.y)?.classList.contains('maplibregl-canvas')) continue;
      if (n.map.queryRenderedFeatures(p, {layers:['school-building-groups']})[0]?.properties.groupId === id) return p;
    }
    return null;
  }, { gaps, id: group.id });
  expect(hit).not.toBeNull();
  await page.mouse.click(hit.x, hit.y);
  await expect(card).toContainText('同组 56 栋');
  expect((await selected()).map(feature => feature.geometry)).toEqual([shape.geometry]);
  await page.keyboard.press('Escape');
  await page.locator('[data-lens-mode="height"]').click();
  await settle(page);
  expect(await inspect(page, `n.map.getLayoutProperty('school-building-groups','visibility')`)).toBe('none');
  const originals = await inspect(page, '(async () => (await n.map.getSource("canton-buildings").getData()).features)()');
  expect(originals).toEqual(data.features);
  await inspect(page, `n.map.jumpTo({center:[${lng},${lat}],zoom:18,pitch:0,padding:{top:0,bottom:0,left:0,right:0}})`);
  await settle(page);
  const p = await inspect(page, `n.map.project([${lng},${lat}])`);
  await page.mouse.click(p.x, p.y);
  await expect(card).toContainText('保留逐栋来源轮廓');
  expect(await selected()).toHaveLength(56);
  assertSelectedGeometry(await selected(), group.features);
  await page.keyboard.press('Escape');
  await page.locator('[data-lens-mode="use"]').click();
  await settle(page);
  expect(await inspect(page, `n.map.getLayoutProperty('school-building-groups','visibility')`)).toBe('visible');
  for (const [width, height] of [[390,844], [568,320]]) {
    await page.setViewportSize({width, height});
    await settle(page);
    await inspect(page, `n.map.jumpTo({center:${JSON.stringify(geometryPoint(shape.geometry))}, zoom:16.8, pitch:55, padding:{top:0,bottom:0,left:0,right:0}})`);
    await settle(page);
    const point = await hullPoint(page, shape.geometry.coordinates[0], group.id);
    expect(point, `${width}x${height}: the group must have a visible click target`).not.toBeNull();
    await page.mouse.click(point.x, point.y);
    await expect(card).toContainText('同组 56 栋');
    await settle(page);
    const bounds = await card.evaluate(node => node.closest('.maplibregl-popup').getBoundingClientRect().toJSON());
    const context = `${width}x${height}: ${JSON.stringify(bounds)}`;
    expect(bounds.left, context).toBeGreaterThanOrEqual(0);
    expect(bounds.top, context).toBeGreaterThanOrEqual(0);
    expect(bounds.right, context).toBeLessThanOrEqual(width);
    expect(bounds.bottom, context).toBeLessThanOrEqual(height);
    expect((await selected()).map(feature => feature.geometry)).toEqual([shape.geometry]);
    const navigation = page.locator('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-group');
    const credits = page.locator('.maplibregl-ctrl-attrib-button');
    const titleClear = () => card.locator('h3').evaluate(node => {
      const r = node.getBoundingClientRect();
      return [0.04, 0.15, 0.5, 0.9].every(x => [0.2, 0.5, 0.8].every(y =>
        node.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height * y))));
    });
    const popup = page.locator('.maplibregl-popup');
    await expect(popup).toHaveCSS('z-index', '2');
    expect(await titleClear(), `${width}x${height}: title must not be covered`).toBe(true);
    await expect(navigation).toHaveCSS('visibility', width === 568 ? 'hidden' : 'visible');
    await credits.click({ trial: true });
    if (width === 568) {
      // The new footprint seats the card elsewhere. Pan its title over a real control instead of relying on
      // the old hull's accidental overlap; the correct stacking must still keep the same title readable.
      const panTitleOver = async selector => {
        const center = await inspect(page, 'n.map.getCenter()');
        // Perspective makes one screen-space pan approximate; converge on the actual DOM rectangles.
        for (let step = 0; step < 3; step++) {
          await page.evaluate(async selector => {
            const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
            const title = document.querySelector('.building-card h3').getBoundingClientRect();
            const control = document.querySelector(selector).getBoundingClientRect();
            n.map.panBy([title.left + title.width / 2 - control.left - control.width / 2,
              title.top + title.height / 2 - control.top - control.height / 2], { duration: 0 });
          }, selector);
          await settle(page);
        }
        expect(await page.evaluate(selector => {
          const title = document.querySelector('.building-card h3').getBoundingClientRect();
          const control = document.querySelector(selector).getBoundingClientRect();
          const x = title.left + title.width / 2, y = title.top + title.height / 2;
          return x > control.left && x < control.right && y > control.top && y < control.bottom;
        }, selector), 'the injected camera must actually align a sampled title point with the control').toBe(true);
        expect(await titleClear(), 'the correctly stacked title is clear in the injected camera state').toBe(true);
        return center;
      };
      const beforeNavigation = await panTitleOver('.maplibregl-ctrl-zoom-in');
      try {
        await popup.evaluate(node => node.style.zIndex = 'auto');
        const stacking = await popup.evaluate(node => getComputedStyle(node).zIndex);
        expect(() => expect(stacking).toBe('2')).toThrow();
        await navigation.evaluate(node => node.style.visibility = 'visible');
        const visibility = await navigation.evaluate(node => getComputedStyle(node).visibility);
        expect(() => expect(visibility).toBe('hidden')).toThrow();
        const clear = await titleClear();
        expect(() => expect(clear).toBe(true)).toThrow();
      } finally {
        await navigation.evaluate(node => node.style.removeProperty('visibility'));
        await popup.evaluate(node => node.style.removeProperty('z-index'));
        await inspect(page, `n.map.jumpTo({center:${JSON.stringify(beforeNavigation)}})`);
        await settle(page);
      }
      expect(await titleClear()).toBe(true);
      await expect(navigation).toBeHidden();
      await page.setViewportSize({width: 390, height: 844});
      await expect(page.locator('.maplibregl-canvas')).toHaveCSS('width', '390px');
      await settle(page);
      await expect(navigation).toBeVisible();
      await page.setViewportSize({width, height});
      await expect(page.locator('.maplibregl-canvas')).toHaveCSS('width', `${width}px`);
      await settle(page);
      expect(await titleClear(), 'title stays clear after rotation').toBe(true);
      await expect(navigation).toBeHidden();
      await credits.click({ trial: true });
      const beforeOverview = await panTitleOver('#overview-button');
      try {
        await popup.evaluate(node => node.style.zIndex = 'auto');
        const clear = await titleClear();
        expect(() => expect(clear).toBe(true)).toThrow();
      } finally {
        await popup.evaluate(node => node.style.removeProperty('z-index'));
        await inspect(page, `n.map.jumpTo({center:${JSON.stringify(beforeOverview)}})`);
        await settle(page);
      }
      expect(await titleClear()).toBe(true);
    }
    await blockScreenshot(page, `group-${width}`);
    if (width === 568) await page.locator('.maplibregl-popup-close-button').click();
    else await page.keyboard.press('Escape');
    await expect(navigation).toBeVisible();
    const zoom = await inspect(page, 'n.map.getZoom()');
    await navigation.locator('.maplibregl-ctrl-zoom-in').click();
    await settle(page);
    expect(await inspect(page, 'n.map.getZoom()')).toBeGreaterThan(zoom);
  }
  expect(log.errors).toEqual([]);
});

test('filters rebuild the formal layout, regularize singletons and restore atmosphere colors', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await open(page);
  const { data, grouping, display } = await formalScene();
  const { groupDisplay, groupStats } = await import('../src/groups.js');
  const displayed = () => displayedShapes(page);
  const all = await displayed();
  expect(all).toEqual(display.features);
  expect(all).toHaveLength(472);
  expect(all.filter(f => f.properties.aggregate)).toHaveLength(378);
  expect(all.every(f => f.properties.schematic && Number.isFinite(f.properties.distance))).toBe(true);
  expect(grouping.rules).toEqual({ gapMeters: 45, maxSpanMeters: 280 });
  expect(grouping.groups.filter(g => g.distance <= 500)).toHaveLength(55);
  const assertMembers = mapping => {
    expect([...mapping.keys()].sort()).toEqual(data.features.map(f => String(f.properties.osmId)).sort());
    for (const group of grouping.groups) for (const id of group.members) {
      expect(mapping.get(id)).toBe(display.byMember.get(group.id));
    }
  };
  expect(display.byMember.size).toBe(5686);
  assertMembers(display.byMember);
  const missingMember = new Map(display.byMember);
  missingMember.delete('893906742');
  expect(() => assertMembers(missingMember)).toThrow();
  const wrongGroup = new Map(display.byMember);
  wrongGroup.set('893906742', display.byMember.get('893915147'));
  expect(() => assertMembers(wrongGroup)).toThrow();
  expect(grouping.groupOf('893915142')).toMatchObject({ id: '893915141', count: 33, area: 7905 });
  const residentialMembers = grouping.groupOf('893915142').features.filter(f => f.properties.category === 'residential');
  expect(groupStats(residentialMembers, { lat: 23.17107, lng: 113.26646 })).toMatchObject({ count: 32, area: 7599 });
  const expected = groupDisplay(grouping, 'residential').features;
  await page.locator('[data-building-category="residential"]').click();
  await settle(page);
  expect(await displayed()).toEqual(expected);
  expect(expected.find(f => f.properties.groupId === '893915141').properties.groupCount).toBe(32);
  await page.locator('[data-lens-mode="height"]').click();
  await switchAtmosphere(page, 'night');
  await page.locator('[data-lens-mode="use"]').click();
  await settle(page);
  expect(await displayed()).toEqual(expected);
  const { ATMOSPHERES, buildingAtmosphereColor } = await import('../src/atmosphere.js');
  // Node's config defaults to the 3 km Canton scene, so the school's own radius has to be passed in explicitly.
  const night = buildingAtmosphereColor(ATMOSPHERES.night, 450, 2000);
  expect(await inspect(page, `n.map.getPaintProperty('school-building-groups','fill-extrusion-color')`)).toEqual(night);
  await page.locator('[data-building-category="public"]').click();
  await settle(page);
  const publicShapes = await displayed();
  expect(publicShapes).toEqual(groupDisplay(grouping, 'public').features);
  const singleton = publicShapes.find(f => String(f.properties.osmId) === '893915147');
  const original = data.features.find(f => String(f.properties.osmId) === '893915147');
  const { displayHeight, ...sourceProperties } = singleton.properties;
  expect(sourceProperties).toEqual({ ...original.properties, schematic: true });
  expect(displayHeight).toBe(groupDisplay(grouping, 'public').byMember.get('893915147').properties.displayHeight);
  expect(singleton.geometry).not.toEqual(original.geometry);
  await page.locator('#lens-reset').click();
  await settle(page);
  expect(await displayed()).toEqual(all);
  await page.locator('#recenter-button').click();
  await settle(page);
  assertHero(await hero(page));
  await inspect(page, `n.map.setLayoutProperty('school-building-groups','visibility','none')`);
  await settle(page);
  const missing = await hero(page);
  expect(missing.buildings).toBe(0);
  expect(() => assertHero(missing)).toThrow();
  await inspect(page, `n.map.setLayoutProperty('school-building-groups','visibility','visible')`);
  await settle(page);
  assertHero(await hero(page));
  expect(log.errors).toEqual([]);
});

test('school maquette uses the formal block layout and survives themes and lens round trips without new data', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const { ATMOSPHERES, buildingAtmosphereColor } = await import('../src/atmosphere.js');
  const { groupDisplay } = await import('../src/groups.js');
  const { grouping, display } = await formalScene();
  const all = display.features;
  const screenshots = new URL('../docs/screenshots/', import.meta.url);
  expect(existsSync(screenshots), 'the screenshot parent must already exist').toBe(true);
  const screenshot = name => blockScreenshot(page, name);
  // Serialized style layers expose the actual paint/layout, not theme configuration or rendered tile fragments.
  const surface = () => inspect(page, `(async () => {
    const layers = n.map.getStyle().layers;
    return { contact: layers.find(layer => layer.id === 'school-building-contact'),
      group: layers.find(layer => layer.id === 'school-building-groups'),
      contactIndex: layers.findIndex(layer => layer.id === 'school-building-contact'),
      groupIndex: layers.findIndex(layer => layer.id === 'school-building-groups'),
      light: n.map.getLight(), lens: n.lens,
      features: (await n.map.getSource('school-building-groups').getData()).features,
      nameplates: document.querySelectorAll('.street-nameplates, .street-nameplate').length };
  })()`);
  function assertMaquette(s, id, mode, shapes) {
    const theme = ATMOSPHERES[id];
    const color = buildingAtmosphereColor(theme, 450, 2000);
    // Node's scene defaults to 3 km, so the school's 2 km radius is passed in; its 450 m fade start is the hero branch's
    // own distance ramp, one level under the reveal and the zoom term.
    expect(color[6][4][5]).toBe(450);
    expect(s.lens.mode).toBe(mode);
    expect(s.contact).toMatchObject({ type: 'line', source: 'school-building-groups', layout: { 'line-join': 'round' }, paint: {
      'line-color': theme.maquette.contact, 'line-blur': 1.4,
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.6, 16, 2, 18, 3.2],
      'line-opacity': ['interpolate', ['linear'], ['get', 'distance'], 0, 0.28, 450, 0.28, 2000, 0.05],
    } });
    expect(s.group).toMatchObject({ type: 'fill-extrusion', source: 'school-building-groups', paint: {
      'fill-extrusion-color': color, 'fill-extrusion-height': ['get', 'displayHeight'], 'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': true,
    } });
    expect(s.contactIndex).toBeGreaterThanOrEqual(0);
    expect(s.contactIndex).toBeLessThan(s.groupIndex);
    expect(s.contact.filter ?? null).toEqual(s.group.filter ?? null);
    for (const layer of [s.contact, s.group]) expect(layer.layout?.visibility ?? 'visible').toBe(mode === 'height' ? 'none' : 'visible');
    expect(s.light).toMatchObject(mode === 'use' ? theme.maquette.light : theme.light);
    // Full source equality covers all coordinates and every height/base, including singletons.
    expect(s.features).toEqual(shapes);
    expect(s.nameplates).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const initial = await surface();
  expect(initial.features).toHaveLength(472);
  expect(initial.features.filter(f => f.properties.aggregate)).toHaveLength(378);
  expect(initial.features.filter(f => f.properties.aggregate).every(f => f.properties.height === 9.6 && f.properties.base === 0)).toBe(true);
  // Source heights stay flat while the model thickness varies with block size; a known member keeps its own number.
  const modelled = initial.features.filter(f => f.properties.aggregate || f.properties.heightSource === 'estimate');
  const thickness = modelled.map(f => f.properties.displayHeight - f.properties.base);
  expect(modelled).toHaveLength(471);
  expect(Math.min(...thickness)).toBe(9.6);
  expect(Math.max(...thickness)).toBe(24);
  expect(new Set(thickness).size).toBe(105);
  for (const known of initial.features.filter(f => !f.properties.aggregate && ['height', 'levels'].includes(f.properties.heightSource)))
    expect(known.properties.displayHeight).toBe(known.properties.height);
  assertMaquette(initial, 'day', 'use', all);
  await expect(page.locator('#building-note')).toContainText('模型厚度 9.6–24 m，非实际楼高');
  await expect(page.locator('#building-note')).not.toContainText('合并体块高');
  await expect(page.locator('#building-note')).toContainText('模型厚度 9.6–24 m，非实际楼高');
  await expect(page.locator('#building-note')).not.toContainText('合并体块高 9.6 m');
  const before = [...log.data];
  expect(before.map(path => new URL(path).pathname).sort()).toEqual([
    '/data/jingtai-buildings.geojson', '/data/jingtai-grounds.geojson', '/data/jingtai-roads.geojson', '/local/jingtai-amap-names.json',
  ]);
  await screenshot('day');
  for (const id of ['sunset', 'night']) {
    await switchAtmosphere(page, id);
    await settle(page);
    assertMaquette(await surface(), id, 'use', all);
    await screenshot(id);
  }

  const good = await surface();
  const goodPaint = good.group.paint['fill-extrusion-color'];
  const contactLayer = layer => `(() => { n.map.removeLayer('school-building-contact'); n.map.addLayer(${JSON.stringify(layer)}, 'school-building-groups'); })()`;
  const paint = (key, value) => `n.map.setPaintProperty('school-building-groups', ${JSON.stringify(key)}, ${JSON.stringify(value)})`;
  const landed = (key) => (s) => JSON.stringify(s.group.paint[key]) !== JSON.stringify(good.group.paint[key]);
  const badRadius = structuredClone(goodPaint);
  // The hero branch's own distance ramp, one level under the zoom and reveal terms. Its outer stop has to be the school's
  // 2 km, and pushing it to the 3 km the Node defaults carry is a legal expression - moving the 450 m fade start outward
  // instead would sort the stops descending, which MapLibre refuses and then reports as "nothing changed".
  badRadius[6][4][13] = 3000;
  const mutateSource = change => `(async () => { const source=n.map.getSource('school-building-groups');
    const data=structuredClone(await source.getData()); ${change}; source.setData(data); })()`;
  const restoreSource = `n.map.getSource('school-building-groups').setData(${JSON.stringify({ type: 'FeatureCollection', features: all })})`;
  // Each defect is applied to the live map and read back through the same positive assertion.
  for (const [label, inject, restore, reached] of [
    ['wrong layout', mutateSource(`data.features[0].geometry.coordinates[0].forEach(point => point[0] += 0.001)`), restoreSource],
    ['lost members', mutateSource(`data.features.find(f => f.properties.aggregate).properties.groupCount -= 1`), restoreSource],
    ['singleton base', mutateSource(`data.features.find(f => !f.properties.aggregate).properties.base += 7`), restoreSource],
    ['nameplate', `(() => { const node=document.createElement('div'); node.className='street-nameplate'; document.body.append(node); })()`,
      `document.querySelector('.street-nameplate').remove()`],
    ['light', `n.map.setLight({color:'#ff0000'})`, `n.map.setLight(${JSON.stringify(good.light)})`],
    ['contact visibility', `n.map.setLayoutProperty('school-building-contact','visibility','none')`, contactLayer(good.contact)],
    ['contact source', contactLayer({ ...good.contact, source: 'canton-buildings' }), contactLayer(good.contact)],
    ['color fade', paint('fill-extrusion-color', badRadius), paint('fill-extrusion-color', goodPaint), landed('fill-extrusion-color')],
    ['height expression draws source heights', paint('fill-extrusion-height', ['get', 'height']),
      paint('fill-extrusion-height', good.group.paint['fill-extrusion-height']), landed('fill-extrusion-height')],
    ['flat model thickness', mutateSource('data.features.forEach(f => { f.properties.displayHeight = 9.6; })'), restoreSource],
    ['known height overwritten', mutateSource('data.features.forEach(f => { f.properties.height = f.properties.displayHeight; })'), restoreSource],
  ]) {
    try {
      await inspect(page, inject);
      const bad = await surface();
      // A paint MapLibre's validator refuses is dropped without a word, so an injection that never arrives would look
      // exactly like a defect the assertion is strong enough to catch.
      if (reached) expect(reached(bad), `${label} never reached the live map`).toBe(true);
      expect(() => assertMaquette(bad, 'night', 'use', all), label).toThrow();
    } finally {
      await inspect(page, restore);
    }
    assertMaquette(await surface(), 'night', 'use', all);
  }

  // One real filter is enough here; the existing filter spec covers public/singletons and reset details.
  await page.locator('[data-building-category="residential"]').click();
  await settle(page);
  const residential = groupDisplay(grouping, 'residential').features;
  assertMaquette(await surface(), 'night', 'use', residential);
  for (const id of ['night', 'day', 'sunset']) {
    await page.locator('[data-lens-mode="height"]').click();
    await switchAtmosphere(page, id);
    await settle(page);
    assertMaquette(await surface(), id, 'height', residential);
    await page.locator('[data-lens-mode="use"]').click();
    await settle(page);
    assertMaquette(await surface(), id, 'use', residential);
  }
  await page.locator('#lens-reset').click();
  await switchAtmosphere(page, 'day');
  await settle(page);
  assertMaquette(await surface(), 'day', 'use', all);
  for (const [width, height] of [[390, 844], [568, 320]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.maplibregl-canvas')).toHaveCSS('width', `${width}px`);
    await page.locator('#recenter-button').click();
    await settle(page);
    assertMaquette(await surface(), 'day', 'use', all);
    await screenshot(`day-${width}x${height}`);
  }
  expect(log.data).toEqual(before);
  expect(log.errors).toEqual([]);
});

test('an original member outside its schematic block still opens through search focusBuilding and sharing', async ({ page, context }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const { data, display } = await formalScene();
  const { geometryPoint, pointInGeometry } = await import('../src/jingtai-data.js');
  const index = JSON.parse(await readFile(new URL('../public/data/jingtai-buildings-index.json', import.meta.url)));
  const entry = index.entries.find(entry => {
    const shape = display.byMember.get(String(entry.osmId));
    return entry.name && shape?.properties.aggregate && String(entry.osmId) !== shape.properties.groupId
      && !pointInGeometry(shape.geometry, entry.lng, entry.lat);
  });
  expect(entry, 'a real indexed non-representative member must lie outside its display').toBeTruthy();
  const member = data.features.find(f => String(f.properties.osmId) === String(entry.osmId));
  const shape = display.byMember.get(String(entry.osmId));
  const point = geometryPoint(member.geometry);
  expect(pointInGeometry(member.geometry, entry.lng, entry.lat)).toBe(true);
  expect(pointInGeometry(member.geometry, ...point)).toBe(true);
  expect(pointInGeometry(shape.geometry, ...point)).toBe(false);
  const assertMemberShare = address => {
    expect(new URL(address).searchParams.get('scene')).toBe('jingtai');
    expect(shareSelection(address)).toBe(originalSelection(member, point));
    const [lat, lng] = shareSelection(address).split('@')[1].split(',').map(Number);
    expect(pointInGeometry(member.geometry, lng, lat)).toBe(true);
    expect(pointInGeometry(shape.geometry, lng, lat)).toBe(false);
  };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill(entry.name);
  await page.locator('.search-option').filter({ hasText: entry.name }).click();
  const title = (await inferredNames()).named.get(shape.properties.groupId)?.name ?? '相邻建筑群';
  const assertCard = async target => {
    await expect(target.locator('.building-card')).toHaveCount(1);
    await expect(target.locator('.building-card h3')).toHaveText(title);
    await expect(target.locator('.building-card')).toContainText(`定位成员：${entry.name}`);
    await expect(target.locator('.building-card')).toContainText(`同组 ${shape.properties.groupCount} 栋`);
    await expect(target.locator('.building-card .osm-link')).toHaveAttribute('href',
      `https://www.openstreetmap.org/${String(entry.osmId).startsWith('relation/') ? entry.osmId : `way/${entry.osmId}`}`);
    assertModelSelection(await selectedShapes(target), [shape]);
    assertMemberShare(target.url());
  };
  await assertCard(page);
  const address = page.url();
  const shared = await context.newPage();
  try {
    await shared.goto(address);
    await expect(shared.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
    await assertCard(shared);
  } finally {
    await shared.close();
  }
  // The same positive oracle rejects replacing the member by the representative or by a schematic centre.
  expect(() => assertMemberShare(address.replace(`b=${entry.osmId}@`, `b=${shape.properties.groupId}@`))).toThrow();
  const displayPoint = geometryPoint(shape.geometry);
  expect(() => assertMemberShare(address.replace(/&b=.*/, `&b=${originalSelection(member, displayPoint)}`))).toThrow();
  const good = await selectedShapes(page);
  for (const bad of [[...good, ...good], [{ ...good[0], geometry: member.geometry }]]) {
    try {
      await inspect(page, `n.map.getSource('building-selection').setData(${JSON.stringify({ type: 'FeatureCollection', features: bad })})`);
      const actual = await selectedShapes(page);
      expect(() => assertSelectedGeometry(actual, [shape])).toThrow();
    } finally {
      await inspect(page, `n.map.getSource('building-selection').setData(${JSON.stringify({ type: 'FeatureCollection', features: good })})`);
    }
    await assertCard(page);
  }
  expect(log.data.filter(path => path.includes('jingtai-buildings-index.json'))).toHaveLength(1);
  expect(log.errors).toEqual([]);
});

test('a singleton schematic highlight follows the display and height restores its original geometry', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  const { data, grouping } = await formalScene();
  const { groupDisplay } = await import('../src/groups.js');
  const { geometryPoint } = await import('../src/jingtai-data.js');
  const member = data.features.find(f => String(f.properties.osmId) === '893915147');
  const shape = groupDisplay(grouping, 'public').byMember.get('893915147');
  const { displayHeight, ...sourceShape } = shape.properties;
  expect(sourceShape).toEqual({ ...member.properties, schematic: true });
  expect(displayHeight).toEqual(groupDisplay(grouping, 'public').byMember.get('893915147').properties.displayHeight);
  expect(shape.geometry).not.toEqual(member.geometry);
  const originalPoint = geometryPoint(member.geometry);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const before = [...log.data];
  await page.locator('[data-building-category="public"]').click();
  const selectSchematic = async () => {
    await inspect(page, `n.map.jumpTo({center:${JSON.stringify(geometryPoint(shape.geometry))},zoom:18,pitch:0,padding:{top:0,bottom:0,left:0,right:0}})`);
    await settle(page);
    const point = await hullPoint(page, shape.geometry.coordinates[0], '893915147');
    expect(point, 'the filtered singleton has its own rendered click target').not.toBeNull();
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('.building-card')).toHaveCount(1);
    await expect(page.locator('.building-card')).toContainText('当前为规整示意轮廓');
    await expect(page.locator('.building-card')).not.toContainText('同组');
    const selected = await selectedShapes(page);
    assertModelSelection(selected, [shape]);
    expect(shareSelection(page.url())).toBe(originalSelection(member, originalPoint));
  };
  await selectSchematic();
  for (const id of ['night', 'sunset', 'day']) {
    await switchAtmosphere(page, id);
    assertSelectedGeometry(await selectedShapes(page), [shape]);
  }
  // Opening a card intentionally hides the lens controls; close it as a user would before switching modes.
  await page.keyboard.press('Escape');
  await page.locator('[data-lens-mode="height"]').click();
  await expect(page.locator('.building-card')).toHaveCount(0);
  expect(await selectedShapes(page)).toEqual([]);
  await inspect(page, `n.map.jumpTo({center:${JSON.stringify(originalPoint)},zoom:18,pitch:0,padding:{top:0,bottom:0,left:0,right:0}})`);
  await settle(page);
  const point = await inspect(page, `n.map.project(${JSON.stringify(originalPoint)})`);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.building-card .osm-link')).toHaveAttribute('href', 'https://www.openstreetmap.org/way/893915147');
  await expect(page.locator('.building-card')).not.toContainText('当前为规整示意轮廓');
  assertSelectedGeometry(await selectedShapes(page), [member]);
  expect(shareSelection(page.url())).toBe(originalSelection(member, originalPoint));
  expect(await inspect(page, '(async () => (await n.map.getSource("canton-buildings").getData()).features)()')).toEqual(data.features);
  await page.keyboard.press('Escape');
  await page.locator('[data-lens-mode="use"]').click();
  await selectSchematic();
  expect(log.data).toEqual(before);
  expect(log.errors).toEqual([]);
});

test('a missing road snapshot reports an explicit error instead of silently grouping without roads', async ({ page }) => {
  const log = requests(page);
  await page.route('**/data/jingtai-roads.geojson', route => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto(url);
  await expect(page.locator('#map-error')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#map-error-text')).toHaveText('道路隔断快照未能加载（HTTP 404），请重新加载。');
  await expect(page.locator('#reload-map')).toBeVisible();
  await expect(page.locator('#places-toggle')).toBeDisabled();
  expect(await inspect(page, 'n === undefined')).toBe(true);
  expect(log.data.filter(path => path.includes('jingtai-roads.geojson'))).toHaveLength(1);
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
      if (index === 0) await blockScreenshot(page, `tour-${width}`);
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
  const remote = watchRemote(page);
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
    await blockScreenshot(page, String(width));
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
  // V4-8 之后这条等待必须先等换页：`#places-toggle` 在旧页面已经是可用的，光等它就等于在景泰那侧读广州塔的图层，
  // 1,152 行会红成"塔不在这一页"（整套里实测就是这么红的）。
  await page.waitForURL(/\?scene=canton/, { timeout: 60000 });
  await sceneReadyOrSkip(page, remote, { label: '切回广州塔后控件点亮' });
  expect(await inspect(page, `!!n.map.getLayer('canton-tower')`)).toBe(true);
  expect(await inspect(page, `!!n.map.getSource('school-grounds')`)).toBe(false);
  expect(await inspect(page, `!!n.map.getSource('school-building-groups')`)).toBe(false);
  expect(await inspect(page, `!!n.map.getLayer('school-building-contact')`)).toBe(false);
  expect(await inspect(page, 'n.map.getLight()')).toMatchObject({ anchor: 'map', color: '#fff5e5', intensity: 0.58, position: [1.5, 210, 32] });
  await expect(page.locator('.street-nameplates')).toHaveCount(0);
  await expect(page.locator('.scene-range')).toContainText('3');
  await page.locator('#scene-nav a[href="?scene=jingtai"]').click();
  await page.waitForURL(/scene=jingtai/, { timeout: 60000 });
  await sceneReadyOrSkip(page, remote, { label: '切到景泰后控件点亮' });
  await settle(page);
  assertHero(await hero(page));
  expect(log.errors).toEqual([]);
});

// V4-8：换街区是一条链接，不是一次剪切板。文档要的是"同实例三段式飞行、禁止覆盖层黑屏"，这一版落的是两段接力
// （两份快照之间实测空着 3.7 km，同实例飞过去要把整个 app 改成可热换场景），所以这里量接力的三件事：
// 链接先把街区升成一枚圆盘才换页、切页那几帧不是黑屏、对面那页从同一格宽度降回自己的开屏机位。
// 方向取广州塔 → 景泰：塔那侧的中继画面是"底色 + 一枚圆盘"（实测 2.9 % 不是底色），画面对得上量出来的直径；
// 景泰那侧 12.4 级上底图自己的用地色还在画（同样起飞后还剩 27~33 %，而且两次跑差 6 个点），拿它当画面判据只会得到一条抖的线。
test('the scene link lifts the neighbourhood off and lets the other one land instead of cutting', async ({ page }) => {
  test.setTimeout(180000);
  const log = requests(page);
  await page.goto(`${app}/?scene=canton`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await settle(page);
  // 干净起点：上一次跑剩的交接记录会让开屏自己飞一次，那这一项量的就不是点击了。
  await page.evaluate(async () => {
    const { HANDOFF_KEY } = await import('/src/scene-flight.js');
    sessionStorage.removeItem(HANDOFF_KEY);
  });
  const coverage = async (label) => {
    const source = (await page.screenshot({ clip: { x: 240, y: 160, width: 960, height: 640 } })).toString('base64');
    return page.evaluate(async ({ source, label }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const buffer = new OffscreenCanvas(image.width, image.height);
      const context = buffer.getContext('2d');
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      // 底色是这张图里最多的一种色（4 bit 一档，把抗锯齿拆出来的相邻两档算作同一档），参照色取那一档里所有像素的
      // 均值 —— 直接拿档号当颜色比会把整张图都算成"不是底色"，第一版就这么红过一次。
      const bins = new Map();
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
        const bin = bins.get(key) ?? { count: 0, rgb: [0, 0, 0] };
        bin.count++;
        for (let channel = 0; channel < 3; channel++) bin.rgb[channel] += data[i + channel];
        bins.set(key, bin);
        sum += data[i] + data[i + 1] + data[i + 2];
      }
      const pixels = data.length / 4;
      const modal = [...bins.values()].sort((a, b) => b.count - a.count)[0];
      const base = modal.rgb.map((value) => value / modal.count);
      let off = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.abs(data[i] - base[0]) > 16 || Math.abs(data[i + 1] - base[1]) > 16 || Math.abs(data[i + 2] - base[2]) > 16) off++;
      }
      return { label, mean: Math.round(sum / pixels / 3), share: Math.round(off / pixels * 1000) / 10, distinct: bins.size };
    }, { source, label });
  };
  const grounded = await coverage('起飞前');
  expect(grounded.mean, `起飞前那一帧就快黑了（亮度 ${grounded.mean}）`).toBeGreaterThan(20);
  expect(grounded.share, `起飞前的画面只有 ${grounded.share} % 不是底色，3 km 街区本来就该占掉大半`).toBeGreaterThan(25);

  // 上半场：链接真正做的事是把街区升起来。中继那一格把 3 km 圈缩到 150 px（按 960×640 取样框算是 2.9 % 的画面），
  // 但"剩多少非底色像素"这一格不稳：11.8 级上底图瓦片刚换完一轮时实测能从 2.9 % 抖到 15.7 %，那是在量瓦片到没到，
  // 不是在量接力。所以画面只钉两件事：不能黑（文档明令），以及画面要比开屏那一帧简单得多——
  // 实测开屏 343~351 种色、起飞后 146~150 种，而"什么都没画"的空帧只有一两种。
  const lifted = await inspect(page, `(async () => {
    const [{ relayView, relayZoom, FLY_OUT_MS, HANDOFF_KEY }, { SCENES }] = await Promise.all([import('/src/scene-flight.js'), import('/src/scenes.js')]);
    sessionStorage.removeItem(HANDOFF_KEY);
    await n.liftOff(relayView(SCENES.canton), FLY_OUT_MS);
    return { zoom: n.map.getZoom(), pitch: n.map.getPitch(), bearing: n.map.getBearing(), relay: relayZoom(SCENES.canton) };
  })()`);
  expect(lifted.pitch, `起飞那一格还带着俯仰 ${lifted.pitch}，切页时那半圈会看得很清楚`).toBe(0);
  expect(Math.abs(lifted.zoom - lifted.relay), `起飞落在 ${lifted.zoom}，中继那一格该是 ${lifted.relay}`).toBeLessThan(0.15);
  const airborne = await coverage('起飞后');
  expect(airborne.mean, `起飞那一帧是黑屏（亮度 ${airborne.mean}）：文档明令禁止覆盖层黑屏`).toBeGreaterThan(20);
  expect(airborne.distinct, `起飞后画面里还有 ${airborne.distinct} 种色（开屏 ${grounded.distinct} 种），街区没缩成一枚圆盘`)
    .toBeLessThan(grounded.distinct * 0.6);
  expect(airborne.distinct, `起飞后画面只剩 ${airborne.distinct} 种色，那是空帧不是圆盘`).toBeGreaterThan(20);
  expect(airborne.share, `起飞后 ${airborne.share} % 与开屏 ${grounded.share} % 一样，镜头动了但画面没动`).toBeLessThan(grounded.share);

  // 下半场：点链接 → 换页 → 落地。三段各证一件事，而点击与换页之间只有 900 ms，从 Playwright 侧插进去读缩放必然
  // 和导航抢跑，所以让页面自己把最低那一格记进 sessionStorage —— 同源换页留着这一格，落地后再读。
  await inspect(page, '(n.recenter(), true)');
  await settle(page);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    sessionStorage.removeItem('probe.lowest');
    sessionStorage.removeItem('probe.prevented');
    // 链接那一条 `<a>` 的默认动作有没有被接走，是这一项唯一不吃时机的证据：Vite 的换页响应慢过 900 ms 的起飞，
    // 光看"换页之前最低飞到几级"时，不接管的版本也会先在旧页面里飞完（注入这条缺陷实测照样绿）。
    document.getElementById('scene-nav').addEventListener('click', (event) => {
      sessionStorage.setItem('probe.prevented', String(event.defaultPrevented));
    });
    window.setInterval(() => {
      const zoom = n.map?.getZoom?.();
      if (Number.isFinite(zoom) && zoom < Number(sessionStorage.getItem('probe.lowest') ?? 99)) sessionStorage.setItem('probe.lowest', String(zoom));
    }, 50);
  });
  await page.locator('#scene-nav a[href="?scene=jingtai"]').click();
  await page.waitForURL(/scene=jingtai/, { timeout: 60000 });
  const witnessed = await page.evaluate(() => ({
    prevented: sessionStorage.getItem('probe.prevented'), lowest: Number(sessionStorage.getItem('probe.lowest')),
  }));
  expect(witnessed.prevented, `链接的默认动作没有被接走（defaultPrevented=${witnessed.prevented}），点一下就还是硬切页`).toBe('true');
  // 起飞发生在换页之前：直接切页的那一种，这一格读到的还是广州塔那台的 15.5 级。
  expect(witnessed.lowest, `点击之后、换页之前最低只到 ${witnessed.lowest} 级，链接没有先把街区升起来`).toBeLessThan(13.2);
  const descent = await page.evaluate(async () => {
    const samples = [];
    const deadline = performance.now() + 12000;
    let n = null;
    while (performance.now() < deadline) {
      if (!n) {
        try {
          n = (await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src)).neighborhood;
        } catch { /* 模块还在下载 */ }
      }
      if (n?.map) samples.push({ zoom: Math.round(n.map.getZoom() * 100) / 100, pitch: Math.round(n.map.getPitch() * 10) / 10, moving: n.map.isMoving() });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return samples;
  });
  expect(descent.length, '落地那侧一个采样都没拿到，降落没发生或者页面根本没起来').toBeGreaterThan(5);
  // 页面自己开完屏的那一刻，镜头还得在飞：直接切页的那一种第一帧就已经是开屏机位、也不在动。
  expect(descent[0].moving, `开屏读完那一刻地图是静止的（${descent[0].zoom} 级），说明对面那页没有接着飞的那一段`).toBe(true);
  const widest = descent.reduce((best, row) => (row.zoom < best.zoom ? row : best), descent[0]);
  // 景泰那侧的中继格是 12.4 级。判据卡 14.5 而不是 12.6：能读到第一帧的时机取决于模块下载完的早晚，最坏那一格
  // 落在降落的中段，把线画死会让这一项变成时机竞态而不是在量接力。
  expect(widest.zoom, `落地那侧最宽只到 ${widest.zoom} 级，没有从中继那一格接着飞`).toBeLessThan(14.5);
  expect(await page.evaluate(async () => {
    const { HANDOFF_KEY } = await import('/src/scene-flight.js');
    const record = sessionStorage.getItem(HANDOFF_KEY);
    for (const key of ['probe.lowest', 'probe.prevented']) sessionStorage.removeItem(key);
    return record;
  }), '落地之后交接记录还在，刷新这一页会再飞一次').toBeNull();
  await settle(page);
  assertHero(await hero(page));
  expect(log.errors).toEqual([]);
});

// 减弱动效那一条路必须留在原地：接力的两段都是镜头自己在飞，系统说了"少动"就不该飞，链接退回它本来的换页。
test('under reduced motion the scene link cuts without writing a handoff', async ({ page }) => {
  test.setTimeout(180000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${app}/?scene=canton`);
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  await page.evaluate(() => {
    sessionStorage.removeItem('probe.prevented');
    document.getElementById('scene-nav').addEventListener('click', (event) => {
      sessionStorage.setItem('probe.prevented', String(event.defaultPrevented));
    });
  });
  await page.locator('#scene-nav a[href="?scene=jingtai"]').click();
  await page.waitForURL(/scene=jingtai/, { timeout: 60000 });
  await expect(page.locator('#places-toggle')).toBeEnabled({ timeout: 60000 });
  expect(await page.evaluate(async () => {
    const { HANDOFF_KEY } = await import('/src/scene-flight.js');
    return { prevented: sessionStorage.getItem('probe.prevented'), record: sessionStorage.getItem(HANDOFF_KEY) };
  }), '减弱动效下链接把默认动作接走了，或留下了一次不需要降落的交接').toEqual({ prevented: 'false', record: null });
  // 没有交接记录就没有降落那一段：开屏直接是自己的机位。
  await settle(page);
  assertHero(await hero(page));
});

// The motion loop is only worth running where it has something to redraw. The school scene has no river tile and no
// tower, so an idle requestAnimationFrame there would wake the tab sixty times a second for no picture at all: the
// switch has to be absent from the header and the loop has to refuse even when a visitor asks for it.
test('the school scene has nothing to animate, so it offers no motion switch and runs no loop', async ({ page }) => {
  test.setTimeout(120000);
  const log = requests(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  expect(await inspect(page, 'n.motionStatus()')).toMatchObject({ on: false, available: false, tiles: 0, steps: 0, pulses: 0 });
  await expect(page.locator('#motion-toggle')).toHaveCount(1);
  await expect(page.locator('#motion-toggle')).not.toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-motion', 'off');
  // Asking for motion out of a scene that cannot serve it has to be refused rather than started.
  expect(await inspect(page, 'n.setMotion(true)')).toMatchObject({ on: false });
  expect(await inspect(page, 'n.motionStatus()')).toMatchObject({ on: false, steps: 0, pulses: 0 });
  // The layers the canton loop writes into must not exist here at all.
  expect(await inspect(page, '!!n.map.getLayer("river-surface")')).toBe(false);
  expect(await inspect(page, '!!n.map.getLayer("canton-tower")')).toBe(false);
  await switchAtmosphere(page, 'night');
  await settle(page);
  expect(await inspect(page, 'n.motionStatus()')).toMatchObject({ on: false, phase: 0, steps: 0 });
  expect(log.errors).toEqual([]);
});

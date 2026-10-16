import { test, expect } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
test.use({ launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, viewport: { width: 1440, height: 900 } });
test.setTimeout(120000);

async function open(page, query = '') {
  await page.goto(`${appUrl}/${query}`);
  await expect(page.locator('#film-start')).toBeEnabled({ timeout: 60000 });
  await page.evaluate(async () => { window.filmApp = (await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src)).neighborhood; });
  await page.waitForFunction(() => filmApp.map.loaded() && !filmApp.map.isMoving());
}
const filmState = (page) => page.evaluate(() => filmApp.film.state);
const savedState = (page) => page.evaluate(() => {
  const map = filmApp.map;
  const round = (value) => Math.round(value * 1e8) / 1e8;
  return {
    center: map.getCenter().toArray().map(round), zoom: round(map.getZoom()), pitch: round(map.getPitch()), bearing: round(map.getBearing()),
    padding: map.getPadding(), lens: filmApp.lens, hash: location.hash, motion: filmApp.motionStatus().on,
    sky: map.getSky(), paint: map.getPaintProperty('neighborhood-buildings', 'fill-extrusion-color'),
    layers: map.getStyle().layers.filter((layer) => layer.type === 'symbol' || layer.id === 'radius-line')
      .map((layer) => [layer.id, map.getLayoutProperty(layer.id, 'visibility') ?? 'visible']),
  };
});
async function assertCleanFrame(page) {
  expect(await page.evaluate(() => ({
    hidden: ['.scene-intro', '.landmark', '.maplibregl-control-container'].every((selector) =>
      [...document.querySelectorAll(selector)].every((node) => getComputedStyle(node).visibility === 'hidden')),
    inert: document.querySelector('#map').inert,
    visibleSymbols: filmApp.map.getStyle().layers.filter((layer) => (layer.type === 'symbol' || layer.id === 'radius-line') && filmApp.map.getLayoutProperty(layer.id, 'visibility') !== 'none').map((layer) => layer.id),
    canvas: document.querySelector('#map canvas').getBoundingClientRect().width,
  }))).toEqual({ hidden: true, inert: true, visibleSymbols: [], canvas: page.viewportSize().width });
  await expect(page.locator('#film-player')).toBeVisible();
}
async function assertRestored(page, before) {
  await expect(page.locator('#film-player')).toBeHidden();
  expect(await savedState(page)).toEqual(before);
  expect(await page.locator('#map').evaluate((node) => node.inert)).toBe(false);
  await expect(page.locator('#film-start')).toBeFocused();
}

 test('film plays all six shots, pauses the camera and restores the previous map', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page);
  const before = await savedState(page);
  await page.locator('#film-start').click();
  await assertCleanFrame(page);
  await expect(page.locator('#film-play')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#film-exit')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#film-play')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#film-exit')).toBeFocused();
  await page.waitForFunction(() => filmApp.film.state.elapsed > 250);
  await page.locator('#film-play').click();
  const paused = await filmState(page), camera = await savedState(page);
  await page.waitForTimeout(350);
  expect(await filmState(page)).toEqual(paused);
  expect(await savedState(page)).toEqual(camera);
  await expect(page.locator('#film-play')).toHaveText('继续');
  await page.locator('#film-play').click();
  await page.waitForFunction((elapsed) => filmApp.film.state.elapsed > elapsed, paused.elapsed);
  expect((await filmState(page)).elapsed - paused.elapsed).toBeLessThan(1500);
  for (let index = 0; index < 6; index++) {
    await page.waitForFunction((i) => filmApp.film.active && Math.floor(filmApp.film.state.elapsed / 8000) === i && filmApp.film.state.elapsed % 8000 > 3700, index, { timeout: 20000 });
    await expect(page.locator('#film-chapter')).toContainText(`${String(index + 1).padStart(2, '0')} / 06`);
    expect(await page.evaluate(() => location.hash)).toBe(before.hash);
    await assertCleanFrame(page);
    await page.screenshot({ path: info.outputPath(`shot-${index + 1}.png`) });
  }
  await expect(page.locator('#film-player')).toBeHidden({ timeout: 15000 });
  await assertRestored(page, before);
  expect(errors).toEqual([]);
});

 test('all skip controls restore filters, atmosphere, hidden layers and camera; tour stays independent', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    filmApp.setAtmosphere('night', { instant: true });
    filmApp.setMotion(false);
    filmApp.setLens({ mode: 'height', category: 'residential', source: 'levels' });
    filmApp.map.jumpTo({ center: [113.318, 23.114], zoom: 15.2, bearing: 25, pitch: 55, padding: { top: 210, bottom: 120, left: 260, right: 70 } });
  });
  const before = await savedState(page);
  for (const key of ['Escape', 'Space', 'button']) {
    await page.locator('#film-start').click();
    await assertCleanFrame(page);
    expect(await page.evaluate(() => filmApp.lens)).toEqual({ mode: 'use', category: 'all', source: 'all' });
    if (key === 'button') await page.locator('#film-exit').click();
    else await page.keyboard.press(key);
    await assertRestored(page, before);
  }
  await page.locator('#tour-start').click();
  await expect(page.locator('#tour-player')).toBeVisible();
  await page.evaluate(() => filmApp.startFilm());
  await expect(page.locator('#tour-player')).toBeHidden();
  await expect(page.locator('#film-player')).toBeVisible();
  await page.evaluate(() => filmApp.startTour());
  await expect(page.locator('#film-player')).toBeHidden();
  await expect(page.locator('#tour-player')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#search-toggle').click();
  await expect(page.locator('#search-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-panel')).toBeHidden();
});

 test('film opt-in supports reduced motion, phone and short landscape with usable controls', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '?film=1');
  await assertCleanFrame(page);
  expect(await filmState(page)).toEqual({ active: true, playing: false, reduced: true, elapsed: 0 });
  await page.waitForTimeout(250);
  expect((await filmState(page)).elapsed).toBe(0);
  for (let index = 0; index < 6; index++) {
    await expect(page.locator('#film-chapter')).toContainText(`${String(index + 1).padStart(2, '0')} / 06`);
    const bounds = await page.locator('#film-exit').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize().width);
    await page.screenshot({ path: info.outputPath(`phone-${index + 1}.png`) });
    await page.locator('#film-play').click();
  }
  await expect(page.locator('#film-player')).toBeHidden();
  await page.locator('#film-start').click();
  await page.setViewportSize({ width: 667, height: 375 });
  await page.screenshot({ path: info.outputPath('landscape.png') });
  const elapsed = (await filmState(page)).elapsed;
  expect(elapsed).toBe(0);
  await page.locator('#film-exit').click();
  expect(await page.evaluate(async () => ({ actual: filmApp.map.getPadding(), expected: (await import('/src/padding.js')).viewportPadding() }))).toEqual({
    actual: { top: 180, left: 20, right: 20, bottom: 65 }, expected: { top: 180, left: 20, right: 20, bottom: 65 },
  });
  expect(await page.locator('#map').evaluate((node) => node.inert)).toBe(false);
});

 test('hidden tab pauses without auto-resume; changing reduced motion stops camera and caption animation', async ({ page }) => {
  await open(page);
  await page.locator('#film-start').click();
  await page.waitForFunction(() => filmApp.film.state.elapsed > 100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hidden = await filmState(page);
  expect(hidden.playing).toBe(false);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  expect(await filmState(page)).toEqual(hidden);
  await page.locator('#film-play').click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#film-play')).toHaveText('下一幕');
  expect(await page.evaluate(() => ({ playing: filmApp.film.state.playing, reduced: filmApp.film.state.reduced, running: filmApp.atmosphere.running, animations: document.querySelector('#film-caption').getAnimations().length }))).toEqual({ playing: false, reduced: true, running: false, animations: 0 });
  await page.locator('#film-play').click();
  expect((await filmState(page)).elapsed).toBe(8000);
  await page.keyboard.press('Escape');
  await expect(page.locator('#film-player')).toBeHidden();
});

 test('clean-frame and restoration checks reject injected defects', async ({ page }) => {
  await open(page);
  const before = await savedState(page);
  await page.locator('#film-start').click();
  await assertCleanFrame(page);
  await page.evaluate(() => filmApp.map.setLayoutProperty('radius-line', 'visibility', 'visible'));
  expect(await page.evaluate(() => filmApp.map.getLayoutProperty('radius-line', 'visibility'))).toBe('visible');
  await expect(assertCleanFrame(page)).rejects.toThrow();
  await page.locator('#film-exit').click();
  await assertRestored(page, before);
  await page.evaluate(() => filmApp.map.jumpTo({ bearing: filmApp.map.getBearing() + 15 }));
  expect((await savedState(page)).bearing).not.toBe(before.bearing);
  await expect(assertRestored(page, before)).rejects.toThrow();
});

test('film footer fits short desktops and tablets without clipping or overlapping its credit', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '?film=1');
  const footerMetrics = () => page.evaluate(() => {
    const rects = ['#film-time', '#film-help', '#film-play', '#film-exit', '.film-credit'].map((selector) => {
      const node = document.querySelector(selector);
      return { selector, ...node.getBoundingClientRect().toJSON() };
    }).filter((rect) => rect.width && rect.height);
    const clipped = rects.filter((rect) => rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight);
    const overlap = rects.flatMap((a, i) => rects.slice(i + 1).flatMap((b) =>
      Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) ? [[a.selector, b.selector]] : []));
    return { clipped, overlap };
  });
  const assertFooter = async () => expect(await footerMetrics()).toEqual({ clipped: [], overlap: [] });
  // setViewportSize can return before the window resize listener updates the paused film.
  const reframed = (bar) => page.waitForFunction((value) => document.querySelector('#film-player').style.getPropertyValue('--film-bar') === `${value}px`, bar);
  for (const [width, height, bar] of [[1440, 720, 84], [800, 1000, 84], [320, 568, 64], [390, 844, 64], [667, 375, 52]]) {
    await page.setViewportSize({ width, height });
    await reframed(bar);
    await assertFooter();
    await page.screenshot({ path: info.outputPath(`footer-${width}x${height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 720 });
  await reframed(84);
  await assertFooter();
  await page.locator('#film-player').evaluate((node) => node.style.setProperty('--film-bar', '52px'));
  expect((await page.locator('.film-footer').boundingBox()).height).toBe(52);
  expect((await footerMetrics()).clipped.length).toBeGreaterThan(0);
  await expect(assertFooter()).rejects.toThrow();
});

test('map removal cancels movie and atmosphere frames; cleanup checks reject missing cancellations', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const assertRemoved = async () => {
    expect(await filmState(page)).toMatchObject({ active: false, playing: false });
    await expect(page.locator('#film-player')).toBeHidden();
    expect(errors).toEqual([]);
  };
  for (const missing of [null, 'moodRun?.frame', 'hazeReveal']) {
    let injected = 0;
    if (missing) await page.route((url) => url.pathname === '/src/map.js', async (route) => {
      const response = await route.fetch();
      const source = await response.text(), statement = `cancelAnimationFrame(${missing});`;
      expect(source.split(statement).length - 1).toBe(1);
      injected++;
      await route.fulfill({ response, body: source.replace(statement, '') });
    });
    errors.length = 0;
    await open(page);
    await page.locator('#film-start').click();
    await page.waitForFunction(() => filmApp.film.state.elapsed >= 16000 && filmApp.atmosphere.running);
    const running = await page.evaluate(() => {
      filmApp.revealHaze(60000);
      const before = { film: filmApp.film.state.playing, mood: filmApp.atmosphere.running, haze: filmApp.haze.running };
      filmApp.map.remove();
      return before;
    });
    expect(running).toEqual({ film: true, mood: true, haze: true });
    await page.waitForTimeout(300);
    if (missing) {
      expect(injected).toBe(1);
      expect(errors.length).toBeGreaterThan(0);
      await expect(assertRemoved()).rejects.toThrow();
      await page.unrouteAll();
    } else await assertRemoved();
  }
});

 test('three-engine preview explicitly disables the film instead of throwing on opt-in', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${appUrl}/?engine=three&film=1`);
  await expect(page.locator('#recenter-button')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('#film-start')).toBeDisabled();
  await expect(page.locator('#film-start')).toHaveAttribute('title', /宣传片使用现版完整场景/);
  await expect(page.locator('#film-player')).toBeHidden();
  expect(errors).toEqual([]);
});

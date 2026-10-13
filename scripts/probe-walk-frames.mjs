// One-off diagnostic: how much headroom is there under the atmosphere walk's frame-time caps? Repeats the same
// day -> night walk N times through the real pills and reports every run's p50 / p95 / longest gap, plus the draw-call
// count per frame, so a cap can be argued from a spread instead of from one sample.
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const runs = Number(process.argv[2] || 8);
const hide = process.argv[3] || '';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('CONSOLE', m.text()); });
await page.goto(appUrl);
await page.waitForSelector('#places-toggle', { timeout: 60000 });
await page.waitForFunction(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return neighborhood.map.loaded() && !neighborhood.map.isMoving();
}, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(async ({ runs, hide }) => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  const layer = map.getLayer('canton-tower').implementation;
  const gl = map.getCanvas().getContext('webgl2');
  const real = gl.drawElements.bind(gl);
  let draws = 0;
  gl.drawElements = (...args) => { draws++; return real(...args); };
  const off = hide.split(',').filter(Boolean);
  if (off.includes('agents')) layer.setTraffic(false);
  if (off.includes('trees')) layer.setVegetation(false);
  if (off.includes('forms')) layer.showForms(false);
  const walk = (id) => new Promise((resolve) => {
    const gaps = [];
    const began = performance.now();
    let last = performance.now();
    const drawStart = draws;
    document.querySelector(`[data-atmosphere-option="${id}"]`).click();
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (neighborhood.atmosphere.running && now - began < 8000) requestAnimationFrame(tick);
      else resolve({ gaps, draws: Math.round((draws - drawStart) / gaps.length) });
    };
    requestAnimationFrame(tick);
  });
  const stats = [];
  for (let i = 0; i < runs; i++) {
    const { gaps, draws: per } = await walk(i % 2 ? 'day' : 'night');
    const sorted = gaps.slice(1).sort((a, b) => a - b);
    const pct = (p) => Math.round(sorted[Math.floor(sorted.length * p)] * 10) / 10;
    stats.push({
      to: i % 2 ? 'day' : 'night', frames: gaps.length, total: Math.round(gaps.reduce((s, g) => s + g, 0)),
      p50: pct(0.5), p95: pct(0.95), max: Math.round(sorted[sorted.length - 1]), draws: per,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  gl.drawElements = real;
  return stats;
}, { runs, hide });
console.table(out);
await browser.close();

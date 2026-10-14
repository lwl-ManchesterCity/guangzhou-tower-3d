// 一次性：同一串 hash 下，两引擎的**画面**到底错开多少（与 `screen()`/`project()` 的读数对不对得上是第二件事）。
// 做法：两页各拍一张整幅，然后拿引擎那张在现版那张上滑动找最佳相关偏移——像素级的答案，不靠肉眼读小图。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const VIEWS = [
  ['出厂 15.5/62°/−25°', '#map=15.5/23.1095/113.31913/-25/62'],
  ['量位移那一格 16/60°/0°', '#map=16/23.1095/113.3245/0/60'],
  ['正俯视 16/0°/0°', '#map=16/23.1095/113.3245/0/0'],
];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ANALYSE = `
window.__lum = async (b64) => {
  const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  return { lum, width, height };
};
// 只在地物上比：把两幅各自的"边缘图"（梯度模）拿来相关，水面/天空这种平的地方不参与。
window.__shift = async (a, b, range = 220) => {
  const x = await window.__lum(a), y = await window.__lum(b);
  const { width: W, height: H } = x;
  const edge = (image) => {
    const e = new Float64Array(image.lum.length);
    for (let row = 1; row < H - 1; row++) for (let col = 1; col < W - 1; col++) {
      const i = row * W + col;
      e[i] = Math.abs(image.lum[i + 1] - image.lum[i - 1]) + Math.abs(image.lum[i + W] - image.lum[i - W]);
    }
    return e;
  };
  const ex = edge(x), ey = edge(y);
  const value = (dx, dy) => {
    let num = 0;
    for (let row = 60; row < H - 60; row += 2) {
      const sr = row + dy;
      if (sr < 1 || sr >= H - 1) continue;
      for (let col = 60; col < W - 60; col += 2) {
        const sc = col + dx;
        if (sc < 1 || sc >= W - 1) continue;
        num += ex[row * W + col] * ey[sr * W + sc];
      }
    }
    return num;
  };
  let best = { dx: 0, dy: 0, v: -1 };
  for (let dy = -range; dy <= range; dy += 5) for (let dx = -range; dx <= range; dx += 5) {
    const v = value(dx, dy);
    if (v > best.v) best = { dx, dy, v };
  }
  for (let dy = best.dy - 4; dy <= best.dy + 4; dy++) for (let dx = best.dx - 4; dx <= best.dx + 4; dx++) {
    const v = value(dx, dy);
    if (v > best.v) best = { dx, dy, v };
  }
  const zero = value(0, 0);
  return { shift: [best.dx, best.dy], distance: Math.round(Math.hypot(best.dx, best.dy)), gain: Math.round(best.v / (zero || 1) * 100) / 100 };
};
`;
const out = [];
for (const [label, view] of VIEWS) {
  const shots = {};
  for (const engine of ['legacy', 'three']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
    await page.goto(`${app}/?scene=canton&motion=off${engine === 'three' ? '&engine=three' : ''}${view}`);
    if (engine === 'three') await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
    else await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
    await page.waitForTimeout(2500);
    await page.evaluate(async () => {
      const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      window.__probe = { n };
    });
    // 把会动的东西按住：车流/行人/波光都停在出厂那一格，只比地物。
    await page.evaluate((engine) => (engine === 'three' ? window.__probe.n.setMotion(false) : window.__probe.n.setMotion(false)), engine);
    await page.waitForTimeout(1200);
    shots[engine] = (await page.screenshot()).toString('base64');
    const readout = await page.evaluate((engine) => {
      const n = window.__probe.n;
      const points = [['广州塔', 113.3245, 23.1065], ['省博', 113.3265, 23.1095]];
      const spots = {};
      for (const [name, lng, lat] of points) {
        const spot = engine === 'three' ? n.screen({ lng, lat }) : n.map.project([lng, lat]);
        spots[name] = spot ? [Math.round(spot.x), Math.round(spot.y)] : null;
      }
      return { view: engine === 'three' ? (({ zoom, pitch, bearing, center }) => ({ zoom, pitch, bearing, center }))(n.view()) : { zoom: n.map.getZoom(), pitch: n.map.getPitch(), bearing: n.map.getBearing() }, spots };
    }, engine);
    shots[`${engine}Readout`] = readout;
    await page.evaluate(ANALYSE);
    shots[`${engine}Page`] = page;
  }
  const analysis = await shots.threePage.evaluate(async ({ a, b }) => window.__shift(a, b), { a: shots.three, b: shots.legacy });
  await shots.legacyPage.context().close();
  await shots.threePage.context().close();
  out.push({ label, pixel: analysis, legacySpots: shots.legacyReadout.spots, engineSpots: shots.threeReadout.spots });
}
console.log(JSON.stringify(out, null, 1));
await browser.close();

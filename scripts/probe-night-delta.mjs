// 夜景灯火开与关的整幅差异 + 落到墙上的证据：与窗纹那发同一套口径（全画布每 2 像素取样、Δ>6 记为变动），
// 再按屏幕坐标取 8 面高墙，量每一面在关掉两层之后暗了多少。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&engine=three#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
});
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(1500);

const targets = await page.evaluate(async () => {
  const { n } = window.__probe;
  const features = (await (await fetch('/data/canton-buildings.geojson')).json()).features;
  const centre = { x: innerWidth / 2, y: innerHeight / 2 };
  const rows = features.filter((feature) => Number(feature.properties?.height ?? 0) > 60).map((feature) => {
    const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0];
    const lng = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
    const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const height = Number(feature.properties.height);
    const point = n.screen({ lng, lat, altitude: height * 0.55 });
    return { osmId: feature.properties.osmId, height: Math.round(height), x: Math.round(point.x), y: Math.round(point.y),
      away: Math.round(Math.hypot(point.x - centre.x, point.y - centre.y)) };
  }).filter((row) => row.x > 260 && row.x < 1150 && row.y > 200 && row.y < 780);
  rows.sort((a, b) => a.away - b.away);
  return rows.slice(0, 8);
});

const set = (wanted) => page.evaluate((flag) => {
  let seen = 0;
  window.__probe.n.scene.traverse((object) => {
    if (/^building-(lamps|glow)-/.test(object.name ?? '')) { object.visible = flag; seen++; }
  });
  return seen;
}, wanted);

const shots = [];
for (const wanted of [true, false, true]) {
  const touched = await set(wanted);
  if (touched !== 8) console.log('!! 遍历到的灯火层数', touched);
  await page.waitForTimeout(400);
  shots.push((await page.screenshot()).toString('base64'));
}
const report = await page.evaluate(async ({ shots, targets }) => {
  const load = async (source) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  const on = await load(shots[0]), off = await load(shots[1]);
  const width = 1440;
  const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const delta = (x, y) => {
    const at = (y * width + x) * 4;
    return Math.abs(on[at] - off[at]) + Math.abs(on[at + 1] - off[at + 1]) + Math.abs(on[at + 2] - off[at + 2]);
  };
  let moved = 0, sum = 0, peak = 0, litPeak = 0, litSum = 0, litCount = 0;
  for (let y = 0; y < 960; y += 2) for (let x = 0; x < width; x += 2) {
    const d = delta(x, y);
    if (d > 6) { moved++; const at = (y * width + x) * 4; sum += luma(on, at); peak = Math.max(peak, d); }
    const at = (y * width + x) * 4;
    if (luma(on, at) > 120) { litPeak = Math.max(litPeak, d); litSum += luma(on, at); litCount++; }
  }
  const walls = targets.map((target) => {
    let total = 0, count = 0, bright = 0;
    for (let y = target.y - 16; y < target.y + 16; y++) for (let x = target.x - 48; x < target.x + 48; x++) {
      if (x < 0 || y < 0 || x >= width || y >= 960) continue;
      const d = delta(x, y);
      total += d; count++;
      const at = (y * width + x) * 4;
      if (luma(on, at) > 90) bright++;
    }
    return { osmId: target.osmId, height: target.height, meanDelta: Math.round(total / count), brightPx: bright };
  });
  return { movedShare: Math.round(moved / ((width / 2) * 480) * 1000) / 10,
    medianLuma: Math.round(sum / (moved || 1)), peakDelta: peak,
    brightShare: Math.round(litCount / ((width / 2) * 480) * 1000) / 10, brightPeakDelta: litPeak, walls };
}, { shots, targets });
console.log(JSON.stringify(report, null, 1));
await browser.close();

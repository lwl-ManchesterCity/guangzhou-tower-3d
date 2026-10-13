// 夜景亮窗到底是谁在画：逐层开关一次，看它贡献多少像素；再把权重钉到两端，看"换窗"这条通道通不通。
// 结论决定优化方案的写法——如果 `building-lights*` 四层贡献 0 颗像素，那用户看到的"灯"其实是立面图自己的
// 亮格（`FACADE_THEMES.night.lit`），换窗交叉淡就是一根断掉的线，而不是"做得太含蓄"。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&atmosphere=night${camera}`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3400);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
await page.evaluate(() => window.__n.setMotion(false));
await page.waitForTimeout(500);

const state = await page.evaluate(() => {
  const map = window.__n.map;
  const ids = ['building-facade', 'building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt',
    'building-glow', 'building-lights-near', 'building-lights-near-alt'];
  return ids.filter((id) => map.getLayer(id)).map((id) => ({
    id, visibility: map.getLayoutProperty(id, 'visibility'),
    pattern: JSON.stringify(map.getPaintProperty(id, 'fill-extrusion-pattern'))?.slice(0, 70),
    opacity: JSON.stringify(map.getPaintProperty(id, 'fill-extrusion-opacity'))?.slice(0, 190),
  }));
});
console.log('图层状态：');
for (const row of state) console.log(' ', row.id, '|', row.visibility, '|', row.pattern, '|', row.opacity);

const grab = async () => (await page.screenshot()).toString('base64');
const diff = async (pairs) => page.evaluate(async (list) => {
  const load = async (source) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  const out = [];
  for (const [a, b] of list) {
    const x = await load(a), y = await load(b);
    let moved = 0, peak = 0, sum = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
      if (d > 6) { moved++; peak = Math.max(peak, d); sum += d; }
    }
    out.push({ moved, meanDelta: moved ? Math.round(sum / moved) : 0, peak });
  }
  return out;
}, pairs);

const set = (ids, value) => page.evaluate(({ ids: list, to }) => {
  for (const id of list) if (window.__n.map.getLayer(id)) window.__n.map.setLayoutProperty(id, 'visibility', to);
}, { ids, value });

const rows = {};
const base = await grab();
for (const ids of [['building-facade'], ['building-lights', 'building-lights-alt'], ['building-lights-2', 'building-lights-2-alt'],
  ['building-glow'], ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt']]) {
  await set(ids, 'none');
  await page.waitForTimeout(500);
  const off = await grab();
  rows[ids.join('+')] = (await diff([[base, off]]))[0];
  await set(ids, 'visible');
  await page.waitForTimeout(500);
}
console.log('\n逐层关掉的代价（这颗数＝这一层真的在画东西）：');
for (const [key, value] of Object.entries(rows)) console.log(' ', key, JSON.stringify(value));

// 权重通道：把两组各钉到两端，看屏上有没有反应。
const forced = {};
for (const [key, values] of Object.entries({ 'lamp-0': [1, 0], 'lamp-1': [1, 0] })) {
  const shots = [];
  for (const value of values) {
    await page.evaluate(({ key: k, value: v }) => window.__n.map.setGlobalStateProperty(k, v), { key, value });
    await page.waitForTimeout(600);
    shots.push(await grab());
  }
  forced[key] = (await diff([[shots[0], shots[1]]]))[0];
}
console.log('\n换窗权重从 1 钉到 0 的屏幕反应：', JSON.stringify(forced));
await browser.close();

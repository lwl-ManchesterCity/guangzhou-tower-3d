// 新引擎那一侧的"钉权重值多少像素"：与 `probe-lamp-amplitude.mjs` 同一把尺（同一块 720×460、同一个 d>8 判定、
// 同一个 24×24 成簇窗口），只是钉的方式从 MapLibre 的 global-state 换成引擎的 `setLampWeights`。
// 用途：判据的门槛要落在实测上，而实测要能在不改测试代码的情况下重跑。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const CLIP = { x: 620, y: 300, width: 720, height: 460 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${app}/?scene=canton&engine=three&atmosphere=night#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const script = document.querySelector('script[type="module"][src*="/src/main.js"]');
  const mod = await import(script.src);
  window.__n = mod.neighborhood;
  window.__n.setMotion(false);
});
await page.waitForTimeout(900);
const shot = async (a, b) => {
  await page.evaluate(async ([x, y]) => {
    window.__n.setLampWeights(x, y);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, [a, b]);
  await page.waitForTimeout(900);
  return (await page.screenshot({ clip: CLIP })).toString('base64');
};
const grade = async (a, b) => page.evaluate(async ({ a, b }) => {
  const load = async (source) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const surface = new OffscreenCanvas(image.width, image.height);
    const context = surface.getContext('2d');
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
  };
  const x = await load(a), y = await load(b);
  const changed = new Uint8Array(x.width * x.height);
  let moved = 0;
  for (let i = 0, p = 0; i < x.data.length; i += 4, p++) {
    changed[p] = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2])) > 8 ? 1 : 0;
    if (changed[p]) moved++;
  }
  let cluster = 0;
  const box = 24;
  for (let top = 0; top + box < x.height; top += 6) {
    const column = new Int32Array(x.width);
    for (let py = top; py < top + box; py++) for (let px = 0; px < x.width; px++) column[px] += changed[py * x.width + px];
    for (let left = 0; left + box < x.width; left += 6) {
      let count = 0;
      for (let px = left; px < left + box; px++) count += column[px];
      cluster = Math.max(cluster, count);
    }
  }
  return { moved, cluster, share: Math.round(moved / (x.width * x.height) * 1000) / 10 };
}, { a, b });
const on = await shot(1, 1);
const g0 = await shot(0, 1);
const both = await shot(0, 0);
await page.evaluate(() => {
  const hidden = [];
  window.__n.scene.traverse((object) => { if (/^building-(lamps|glow)-/.test(object.name ?? '')) { hidden.push(object); object.visible = false; } });
  window.__hidden = hidden;
});
await page.waitForTimeout(900);
const bare = (await page.screenshot({ clip: CLIP })).toString('base64');
console.log('组0 换档 1/1→0/1 ', JSON.stringify(await grade(on, g0)));
console.log('两组都换 1/1→0/0 ', JSON.stringify(await grade(on, both)));
console.log('两层全藏 1/1→无  ', JSON.stringify(await grade(on, bare)));
console.log('放回 1/1 与出厂差 ', JSON.stringify(await grade(on, await shot(1, 1))));
console.log('报错', errors.length, errors.slice(0, 3));
await browser.close();

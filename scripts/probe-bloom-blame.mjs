// 一次性：泛光在地标进来之后把画面推到 250 以上那 575 颗像素，是谁家的。
// 夜景、动效按住、读数面板藏掉，每次只藏地标那一层里的一块，读两样：
// `blown`（开泛光多烧掉的颗数）与"这些烧掉的像素落在哪一块包围盒"。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const BLOCKS = ['tower-model', 'landmark-forms', 'beam', 'river-glow', '184738716:spill', '511404889:spill'];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`${app}/?engine=three#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
  n.setMotion(false);
  window.__node = (name) => { let node = null; n.scene.traverse((o) => { if (o.name === name) node = o; }); return node; };
  window.__lum = async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const lum = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    return { lum, width: bitmap.width };
  };
  window.__blown = async ({ off, on }) => {
    const A = await window.__lum(off), B = await window.__lum(on);
    const la = [], lb = [];
    let box = null;
    for (let i = 0; i < A.lum.length; i++) {
      la.push(A.lum[i]); lb.push(B.lum[i]);
      if (B.lum[i] >= 250 && A.lum[i] < 250) {
        const row = Math.floor(i / A.width), col = i % A.width;
        box = box ? { x0: Math.min(box.x0, col), x1: Math.max(box.x1, col), y0: Math.min(box.y0, row), y1: Math.max(box.y1, row) }
          : { x0: col, x1: col, y0: row, y1: row };
      }
    }
    const median = (values) => Float32Array.from(values).sort()[values.length >> 1];
    return { blown: lb.filter((v) => v >= 250).length - la.filter((v) => v >= 250).length,
      medianOff: +median(la).toFixed(1), medianOn: +median(lb).toFixed(1), box };
  };
});
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);

const pair = async () => {
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
  const out = {};
  for (const share of [0, 1]) {
    await page.evaluate(async (value) => {
      window.__probe.n.setBloom(value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, share);
    out[share] = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } })).toString('base64');
  }
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = ''; });
  return { off: out[0], on: out[1] };
};

// 光柱与三条带的 `visible` 每帧被 `sync()` 按夜景权重写回去，藏不住；把材质压到 0 才留得住这一格。
const dim = (name) => page.evaluate((block) => {
  const node = window.__node(block);
  const touched = [];
  node.traverse((object) => {
    for (const material of [].concat(object.material ?? [])) {
      if (!material) continue;
      touched.push([material, material.opacity]);
      material.opacity = 0;
    }
    object.visible = false;
  });
  window.__restore = window.__restore || {};
  window.__restore[block] = touched;
}, name);
const restore = (name) => page.evaluate((block) => {
  const node = window.__node(block);
  node.traverse((object) => { object.visible = true; });
  for (const [material, opacity] of window.__restore[block] ?? []) material.opacity = opacity;
}, name);

for (const name of BLOCKS) {
  await dim(name);
  await page.waitForTimeout(900);
  const shots = await pair();
  console.log(`藏掉 ${name}:`, JSON.stringify(await page.evaluate(async ({ shots }) => window.__blown(shots), { shots })));
  await restore(name);
  await page.waitForTimeout(600);
}
// 全部在位那一张，以及每块各自的"关泛光"底帧（用来反查烧掉的位置）
const all = await pair();
console.log('全在位：', JSON.stringify(await page.evaluate(async ({ shots }) => window.__blown(shots), { shots: all })));
writeFileSync('/tmp/landmarks-bloom-blown.png', Buffer.from(all.on, 'base64'));
writeFileSync('/tmp/landmarks-bloom-base.png', Buffer.from(all.off, 'base64'));
await browser.close();

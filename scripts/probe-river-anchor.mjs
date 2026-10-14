// 一次性：江面那层波光的格子到底"跟谁走"——跟地面转（MapLibre 的 fill-pattern 若绑在地图平面上，镜头一转波纹就斜）
// 还是跟画布转（镜头一转波纹仍然水平）。两页各在 bearing 0 与 bearing −30 拍开/关两张，只比**梯度方向**：
// 波光是横纹，梯度方向就垂直于纹，纹的走向由直方图的众数给出。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const CLIP = { x: 0, y: 0, width: 1440, height: 960 };
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
// 差值图上的梯度方向直方图（折到 0~180°，5° 一格）。
window.__crest = async (on, off) => {
  const a = await window.__lum(on), b = await window.__lum(off);
  const { width, height } = a;
  const d = new Float64Array(a.lum.length);
  for (let i = 0; i < d.length; i++) d[i] = a.lum[i] - b.lum[i];
  const bins = new Array(36).fill(0);
  let samples = 0;
  for (let row = 2; row < height - 2; row++) {
    for (let col = 2; col < width - 2; col++) {
      const here = d[row * width + col];
      if (Math.abs(here) < 2.5) continue;
      const gx = d[row * width + col + 1] - d[row * width + col - 1];
      const gy = d[(row + 1) * width + col] - d[(row - 1) * width + col];
      if (Math.abs(gx) + Math.abs(gy) < 3) continue;
      // 梯度方向垂直于纹；折到 [0,180) 之后再加 90° 就是纹本身的走向。
      let degrees = (Math.atan2(gy, gx) * 180) / Math.PI;
      degrees = ((degrees + 90) % 180 + 180) % 180;
      bins[Math.min(35, Math.floor(degrees / 5))]++;
      samples++;
    }
  }
  const ranked = bins.map((count, index) => [index * 5 + 2.5, Math.round(count / (samples || 1) * 1000) / 10])
    .sort((p, q) => q[1] - p[1]);
  return { samples, modes: ranked.slice(0, 3), flat: Math.round(bins.reduce((s, v) => s + v, 0) / 36 * 1000) / (samples || 1) / 10 };
};
`;

async function open(engine) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  await page.goto(`${app}/?scene=canton&motion=off${engine === 'three' ? '&engine=three' : ''}#map=15.5/23.1105/113.3205/0/58`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  }
  await page.waitForTimeout(1800);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });
  await page.evaluate(ANALYSE);
  return page;
}

async function pair(page, engine, bearing, visible) {
  await page.evaluate(async ({ b, v, engine }) => {
    const n = window.__probe.n;
    if (engine === 'three') {
      n.setView({ ...n.view(), bearing: b, pitch: 58, zoom: 15.5, center: { lat: 23.1105, lng: 113.3205 } });
      let mesh = null;
      n.scene.traverse((object) => { if (object.name === 'river-sheen-water') mesh = object; });
      mesh.visible = v;
      mesh.material.userData.shader.uniforms.riverScroll.value = 0;
      await new Promise((resolve) => setTimeout(resolve, 700));
    } else {
      n.map.jumpTo({ center: [113.3205, 23.1105], zoom: 15.5, pitch: 58, bearing: b });
      n.map.setLayoutProperty('river-surface', 'visibility', v ? 'visible' : 'none');
      await new Promise((resolve) => { n.map.once('idle', resolve); n.map.triggerRepaint(); });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, { b: bearing, v: visible, engine });
  return (await page.screenshot({ clip: CLIP })).toString('base64');
}

const out = {};
for (const engine of ['legacy', 'three']) {
  const page = await open(engine);
  out[engine] = {};
  for (const bearing of [0, -30]) {
    const on = await pair(page, engine, bearing, true);
    const off = await pair(page, engine, bearing, false);
    const again = await pair(page, engine, bearing, true);
    out[engine][`bearing${bearing}`] = await page.evaluate(async ({ on, off, again }) => ({
      crest: await window.__crest(on, off),
      // 同状态连拍两次当噪声底：这一格的众数不该比"开/关"那格的位移更响。
      noise: await window.__crest(again, off),
    }), { on, off, again });
  }
  const view = await page.evaluate(() => (window.__probe.n.view ? window.__probe.n.view() : { zoom: window.__probe.n.map.getZoom() }));
  out[engine].view = { zoom: view.zoom, bearing: view.bearing };
  await page.context().close();
}
console.log(JSON.stringify(out, null, 1));
await browser.close();

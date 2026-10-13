// 塔身两档之间那段走查的真实形状：在页面里以 60 ms 的间隔连拍塔身那一格，同时读 `motionStatus()` 的
// `towerFade` 与 `towerPainted`。像素用 readPixels 直接取，不走截图，所以采样间隔才可能比一次往返小。
// 目的只有一个：说清"暗"到底暗了多少——发射强度按 0.12 走了，落在屏幕上少掉的是哪一部分。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&atmosphere=night#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
await page.locator('[data-tower-light="single"]').click();
await page.waitForTimeout(1600);
const out = await page.evaluate(async () => {
  const n = window.__n;
  const map = n.map;
  const canvas = map.getCanvas();
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const scale = canvas.height / canvas.clientHeight;
  const box = [838, 470, 36, 70].map((value) => Math.round(value * scale));
  const [x, y, w, h] = [box[0], canvas.height - box[1] - box[3], box[2], box[3]];
  const pixels = new Uint8Array(w * h * 4);
  // 读必须在 render 事件里：MapLibre 的画布不保留绘制缓冲，帧外 readPixels 拿到的是被清过的底。
  const read = () => new Promise((resolve) => {
    const once = () => {
      map.off('render', once);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let sum = 0, lit = 0, litSum = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const v = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
        sum += v;
        if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 300) { lit++; litSum += v; }
      }
      resolve({ mean: Math.round(sum / (w * h) * 10) / 10, lit, litMean: lit ? Math.round(litSum / lit * 10) / 10 : 0 });
    };
    map.on('render', once);
    map.triggerRepaint();
  });
  const samples = [];
  n.setTowerMode('cycle');
  const began = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const status = n.motionStatus();
      read().then((pixels) => samples.push({ at: Math.round(performance.now() - began), fade: status.towerFade, painted: status.towerPainted, ...pixels }));
      if (performance.now() - began > 1000) setTimeout(resolve, 200); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  return samples;
});
console.log(out.filter((_, index) => index % 3 === 0).map((row) => `${row.at}ms fade${row.fade} ${row.painted} mean${row.mean} lit${row.lit} litMean${row.litMean}`).join('\n'));
await browser.close();

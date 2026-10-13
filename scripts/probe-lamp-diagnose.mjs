// 诊断"整栋慢灭到底有没有上屏"：把动效停住，钉两组权重，读两样东西——
// ① alt 那一层实际装着的 `fill-extrusion-pattern` 表达式（呼吸的那一撮有没有被换成全灭的图），
// ② 同一块画面里"亮着的窗"的颗数（灭掉的窗必须让这颗数掉下来，否则它只是换了张图而没上屏）。
// 只读不改产品代码。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const CLIP = { x: 620, y: 300, width: 720, height: 460 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${app}/?scene=canton&atmosphere=night${camera}`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3400);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
console.log('样式报错：', errors.length ? errors.slice(0, 4) : '无');
console.log('alt 层的图案表达式：', JSON.stringify(await page.evaluate(() =>
  window.__n.map.getPaintProperty('building-lights-alt', 'fill-extrusion-pattern'))).slice(0, 700));
const { LAMP_BREATHE_MODULUS, LAMP_BREATHE_RESIDUE } = await import('../src/facade.js');
console.log('画面里呼吸的那一撮占几栋：', await page.evaluate(async ({ mod, res }) => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const all = n.map.queryRenderedFeatures({ layers: ['building-lights'] });
  const ids = new Set(all.map((f) => Number(f.properties.osmId)));
  const breath = [...ids].filter((id) => id % mod === res);
  const dark = [...ids].filter((id) => id % 11 === 4);
  return { blocks: ids.size, breathers: breath.length, alreadyDark: dark.length,
    both: breath.filter((id) => id % 11 === 4).length };
}, { mod: LAMP_BREATHE_MODULUS, res: LAMP_BREATHE_RESIDUE }));

await page.evaluate(() => window.__n.setMotion(false));
await page.waitForTimeout(800);
const shot = async (a, b) => {
  await page.evaluate(async ([x, y]) => {
    window.__n.map.setGlobalStateProperty('lamp-0', x);
    window.__n.map.setGlobalStateProperty('lamp-1', y);
    window.__n.map.triggerRepaint();
    await new Promise((resolve) => window.__n.map.once('idle', resolve));
  }, [a, b]);
  await page.waitForTimeout(1000);
  return (await page.screenshot({ clip: CLIP })).toString('base64');
};
const lit = (source) => page.evaluate(async (source) => {
  const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
  const buffer = new OffscreenCanvas(image.width, image.height);
  const context = buffer.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  let bright = 0, sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, bl] = [data[i], data[i + 1], data[i + 2]];
    if (Math.min(r, g, bl) > 110) { bright++; sum += r + g + bl; }
  }
  return { bright, mean: bright ? Math.round(sum / bright / 3) : 0 };
}, source);
const on = await shot(1, 1);
const off = await shot(0, 0);
const g0 = await shot(0, 1);
console.log('亮窗颗数：出厂 1/1', JSON.stringify(await lit(on)),
  '/ 两组都换 0/0', JSON.stringify(await lit(off)),
  '/ 只换组0', JSON.stringify(await lit(g0)));
await browser.close();

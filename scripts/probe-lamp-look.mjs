// 把"换窗看得见吗"这个问题交给眼睛：动效停住，只钉两组权重（不是样式改动，不会触发重图集），
// 在同一个机位拍同一块裁剪画面的四张图——出厂 1/1 与两组都换到 0/0 各两次，中间把光晕层的
// opacity 归零，用来回答"整栋灭了还剩一层晕在墙上，到底是窗户在变还是光晕在骗人"。
// 每一步都在同一状态里拍两张，所以风格改动只发生在两组镜头之间，不在任何一对内部。
// 只写 /tmp 下的图，不改产品代码。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const CLIP = { x: 620, y: 300, width: 720, height: 460 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
await page.goto(`${app}/?scene=canton&atmosphere=night${camera}`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3400);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
await page.evaluate(() => window.__n.setMotion(false));
await page.waitForTimeout(900);
const settle = async (a, b, name) => {
  await page.evaluate(async ([x, y]) => {
    window.__n.map.setGlobalStateProperty('lamp-0', x);
    window.__n.map.setGlobalStateProperty('lamp-1', y);
    window.__n.map.triggerRepaint();
    await new Promise((resolve) => window.__n.map.once('idle', resolve));
  }, [a, b]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `/tmp/lamp-${name}.png`, clip: CLIP });
  await page.screenshot({ path: `/tmp/lamp-${name}-wall.png`, clip: { x: 620, y: 500, width: 380, height: 220 } });
};
for (const glow of ['with', 'without']) {
  if (glow === 'without') await page.evaluate(() => window.__n.map.setPaintProperty('building-glow', 'fill-extrusion-opacity', 0));
  await page.waitForTimeout(1200);
  await settle(1, 1, `${glow}-glow-on`);
  await settle(0, 0, `${glow}-glow-off`);
}
await browser.close();
console.log('wrote /tmp/lamp-{with,without}-glow-{on,off}.png');

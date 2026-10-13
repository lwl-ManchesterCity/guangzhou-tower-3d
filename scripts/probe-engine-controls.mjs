// 一次性：新引擎那一侧补的缩放按钮与边界说明。三件事各量一次：按钮能用（层级 +1 / −1 并受限幅）、
// 灰着的控件各带一句理由、那一行边界说明在窄屏上不横向撑页也不压住控制条。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`${app}/?engine=three#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.waitForTimeout(4000);
const controls = await page.evaluate(() => ({
  buttons: [...document.querySelectorAll('#view-controls button')].map((b) => ({
    id: b.id || b.className, label: b.getAttribute('aria-label') ?? b.textContent.trim().slice(0, 12), disabled: b.disabled,
    title: b.title || null,
  })),
  hint: document.getElementById('gesture-hint')?.textContent.replace(/\s+/g, ' '),
  note: document.querySelector('.engine-note')?.textContent ?? null,
  hscroll: document.documentElement.scrollWidth > innerWidth,
}));
console.log(JSON.stringify(controls, null, 1));
const zoomOf = () => page.evaluate(() => Number(location.hash.split('/')[0].replace('#map=', '')));
const before = await zoomOf();
await page.locator('.zoom-step', { hasText: '＋' }).click();
await page.waitForTimeout(1600);
const up = await zoomOf();
await page.locator('.zoom-step', { hasText: '－' }).click();
await page.locator('.zoom-step', { hasText: '－' }).click();
await page.waitForTimeout(1800);
const down = await zoomOf();
console.log(`层级：点前 ${before} → ＋一次 ${up} → －两次 ${down}`);
// 限幅：连点 12 次 ＋ 不该越过 `VIEW_LIMITS.maxZoom`。
for (let i = 0; i < 12; i++) await page.locator('.zoom-step', { hasText: '＋' }).click();
await page.waitForTimeout(2500);
console.log('连点 12 次 ＋ 之后：', await zoomOf(), await page.evaluate(() => (window.__limits ?? null)));
const boxes = await page.evaluate(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { controls: rect('#view-controls'), hint: rect('#gesture-hint'), note: rect('.engine-note'), panel: rect('.engine-stats') };
});
console.log('版面：', JSON.stringify(boxes));
for (const width of [720, 430, 375]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(900);
  console.log(`${width} px：横向溢出 ${await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)}，`
    + JSON.stringify(await page.evaluate(() => {
      const note = document.querySelector('.engine-note')?.getBoundingClientRect();
      const bar = document.querySelector('#view-controls')?.getBoundingClientRect();
      return { note: note && { y: Math.round(note.y), h: Math.round(note.height) }, bar: bar && { y: Math.round(bar.y), hidden: getComputedStyle(document.querySelector('#view-controls')).opacity } };
    })));
}
await browser.close();

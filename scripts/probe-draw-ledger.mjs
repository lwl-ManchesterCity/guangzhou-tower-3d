// 一次性：把引擎那几条"藏一组读一次发数"的原始读数打出来（项 7 之后 [-6,-6,5] 这一格要定性）。
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto('http://127.0.0.1:5174/?scene=canton&engine=three#map=15.5/23.1095/113.31913/-25/62');
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
const out = {};
for (const mode of ['day', 'sunset', 'night']) {
  await page.evaluate(async (id) => {
    window.__n.setMode(id);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, mode);
  await page.waitForTimeout(800);
  out[mode] = await page.evaluate(async () => {
    const two = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const read = () => window.__n.counts().drawCalls;
    const hide = (test2) => { const list = []; window.__n.scene.traverse((o) => { if (test2(o)) { o.visible = false; list.push(o); } }); return list; };
    const show = (list) => list.forEach((o) => { o.visible = true; });
    const rows = { all: read() };
    let hidden = hide((o) => o.name === 'traffic-signals');
    await two(); rows.noSignals = read(); rows.signalLayers = hidden.length; show(hidden); await two();
    hidden = hide((o) => o.name === 'traffic-life');
    await two(); rows.noTraffic = read(); show(hidden); await two();
    hidden = hide((o) => o.name === 'traffic-life');
    const boats = hide((o) => o.name === 'water-life');
    await two(); rows.bothHidden = read();
    show(boats); await two(); rows.boatsBack = read();
    const lamps = hide((o) => /^building-(lamps|glow)-/.test(o.name ?? ''));
    await two(); rows.lampsOff = read(); rows.lampLayers = lamps.length; show(lamps); await two();
    show(hidden); await two();
    rows.back = read();
    rows.bloom = window.__n.counts().bloom;
    return rows;
  });
}
console.log(JSON.stringify(out, null, 1));
await browser.close();

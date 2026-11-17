// #220 的量尺：白昼开图时灯格家族一张都不造，第一次进夜才补 324 张。
//
//   node scripts/probe-lamp-lazy.mjs
//
// 三遍开图取中位：开图耗时（navigationStart → 地图 idle）、白昼图数、灯族图数；
// 再瞬切夜景，量登记那一下的耗时与切后图数。基线见 DEVELOPMENT.md A3 那节（608 张 / 开图 2.5 s）。
import { chromium } from 'playwright';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LAMP_NAME = /^(building-lights|building-lights-alt|building-glow|building-lights-near|building-lights-near-alt|building-glow-near)-\d-\d-\d$/;

const browser = await chromium.launch({ executablePath });
const runs = [];
for (let run = 0; run < 3; run++) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(appUrl, { waitUntil: 'load' });
  const day = await page.evaluate(async (lampSource) => {
    const LAMP_NAME = new RegExp(lampSource);
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    await new Promise((resolve) => { map.once('idle', resolve); map.triggerRepaint(); });
    const names = map.listImages();
    return { ms: Math.round(performance.now()), total: names.length, lamps: names.filter((n) => LAMP_NAME.test(n)).length };
  }, LAMP_NAME.source);
  const night = await page.evaluate(async (lampSource) => {
    const LAMP_NAME = new RegExp(lampSource);
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const start = performance.now();
    neighborhood.setAtmosphere('night', { instant: true });
    const callMs = Math.round(performance.now() - start);
    await new Promise((resolve) => { map.once('idle', resolve); map.triggerRepaint(); });
    const names = map.listImages();
    return { callMs, switchMs: Math.round(performance.now() - start), total: names.length, lamps: names.filter((n) => LAMP_NAME.test(n)).length };
  }, LAMP_NAME.source);
  runs.push({ day, night });
  await page.close();
}
await browser.close();
const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];
console.log(JSON.stringify({
  runs,
  median: {
    openMs: median(runs.map((r) => r.day.ms)),
    dayImages: median(runs.map((r) => r.day.total)),
    dayLamps: median(runs.map((r) => r.day.lamps)),
    nightSwitchMs: median(runs.map((r) => r.night.switchMs)),
    nightCallMs: median(runs.map((r) => r.night.callMs)),
    nightImages: median(runs.map((r) => r.night.total)),
    nightLamps: median(runs.map((r) => r.night.lamps)),
  },
}, null, 2));
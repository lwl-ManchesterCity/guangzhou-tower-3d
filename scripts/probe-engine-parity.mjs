// 项 5 的并排量尺：同一机位、同一秒，两引擎的近场读数与两组交叉淡权重是否给的是同一批数。
// 现版那侧走 `?engine=` 缺省，新引擎那侧走 `?engine=three`；两边都读 `nearTraffic()` 与 `motionStatus()`，
// 因为这两条读数是共用的定义（同一份路网、同一个 `lampWeight`、同一对周期），对不上就是接错了。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${app}/?scene=canton&atmosphere=night${query}${camera}`);
  await page.waitForSelector('[data-atmosphere-option="night"]:not([disabled])', { timeout: 180000 });
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(4000);
  const read = () => page.evaluate(() => {
    const n = window.__n;
    const status = n.motionStatus();
    return { near: n.nearTraffic(), lights: status.lights, lampTicks: status.lampTicks, lamps: status.lamps, on: status.on };
  });
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n;
  });
  const first = await read();
  await page.waitForTimeout(2400);
  const second = await read();
  const shot = (await page.screenshot({ clip: { x: 620, y: 300, width: 720, height: 460 } })).toString('base64');
  await page.screenshot({ path: `/tmp/engine-parity-${query.includes('three') ? 'three' : 'legacy'}.png`, clip: { x: 0, y: 0, width: 1440, height: 960 } });
  return { first, second, shot, errors };
};
const legacy = await open('');
const three = await open('&engine=three');
const show = (label, row) => console.log(`${label}: 近场拍 ${row.second.lights - row.first.lights} / 灯窗拍 ${row.second.lampTicks - row.first.lampTicks} / `
  + `权重 ${JSON.stringify(row.second.lamps.map((v) => Math.round(v * 1000) / 1000))} / `
  + `车 ${row.second.near?.cars} 人 ${row.second.near?.walkers} reach ${row.second.near?.reach} 行人档 ${row.second.near?.walkerMinZoom} clock ${row.second.near?.clock?.toFixed(2)}`);
show('现版  ', legacy);
show('新引擎', three);
console.log('现版报错', legacy.errors.length, legacy.errors.slice(0, 3));
console.log('新引擎报错', three.errors.length, three.errors.slice(0, 3));
await browser.close();

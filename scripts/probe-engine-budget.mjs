// 项 7 的复测：新引擎接完车流、行人与交叉淡之后，把面板那一行与 counts() 的账并排打出来（白昼／夜景各一次）。
// 门槛沿用既有的两条：fps ≥50、最长帧 ≤ 上一轮记的 16.8 ms 那一档；这里只报数，不改判据。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&atmosphere=day&engine=three${camera}`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
// 面板那两格（fps／最长帧）前两秒量的是首帧成本与图集上传，等它跑起来再读。
await page.waitForTimeout(4000);
const read = () => page.evaluate(() => ({
  panel: document.querySelector('.engine-stats').textContent.replace(/\s+/g, ' '),
  counts: window.__n.counts(), near: window.__n.nearTraffic(), motion: window.__n.motionStatus(),
}));
const day = await read();
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(2500);
const night = await read();
for (const [label, row] of [['白昼', day], ['夜景', night]]) {
  console.log(`${label}  ${row.panel}`);
  console.log(`     counts=${JSON.stringify(row.counts)}`);
  console.log(`     近场 车 ${row.near?.cars} 人 ${row.near?.walkers} reach ${row.near?.reach} 灯 ${row.near?.lamps} 人形 ${row.near?.people} clock ${row.near?.clock?.toFixed(2)}`);
  console.log(`     动效 on=${row.motion.on} step=${row.motion.stepMs}ms 拍 ${row.motion.lights} 灯窗 ${row.motion.lampTicks} 权重 ${JSON.stringify(row.motion.lamps.map((v) => Math.round(v * 1000) / 1000))}`);
}
// fps 与最长帧只在面板那一行里（`counts()` 报的是几何与提交数），所以上面那两行就是这一项的全部读数；
// 连续操作段由浏览器整套那项压力判据负责，这里不重演。
await browser.close();

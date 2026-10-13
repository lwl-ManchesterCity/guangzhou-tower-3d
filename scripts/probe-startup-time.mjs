// 一次性：量开页到"#places-toggle 可用"的时间，以及近场几层各自建了多久。
// 浏览器整套里 11 发卡在 `openMap` 的 60 s 门槛上，这一发要回答的是"页面真的变慢了，还是那一次机器在忙"。
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
for (let pass = 1; pass <= 3; pass += 1) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const started = Date.now();
  await page.goto('http://127.0.0.1:5174/#map=15.4/23.109/113.31913/-25/58', { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 120000 });
  const ready = Date.now() - started;
  await page.waitForTimeout(4000);
  const build = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const near = neighborhood.nearTraffic();
    return { zoom: +neighborhood.map.getZoom().toFixed(2), cars: near?.cars, buses: near?.buses ?? null, walkers: near?.walkers, boats: near?.boats };
  });
  console.log(`第 ${pass} 次：可用前 ${ready} ms`, JSON.stringify(build));
  await page.close();
}
await browser.close();

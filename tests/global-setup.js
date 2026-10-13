// 启动哨兵。整套里几十项的第一句都是"等页面把控件点亮"，所以一个 import 期的漏（例如 `map.js` 用了没引进来的
// 常量）会把 35 分钟拖成一片红，而真原因只写在页面那块错误面板里。这里先开一次页面：起不来就在几十秒内退出，
// 并把面板原文带出来。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const thrown = [];
    page.on('pageerror', (error) => thrown.push(error.message));
    try {
      await page.goto(appUrl, { timeout: 60000 });
    } catch (error) {
      throw new Error(`启动哨兵：打不开 ${appUrl}（dev 服务器起了吗？npm run dev 要用 127.0.0.1:5174）：${error.message}`);
    }
    await page.waitForFunction(() => {
      const toggle = document.querySelector('#places-toggle');
      const panel = document.querySelector('#map-error');
      return Boolean(toggle && !toggle.disabled) || Boolean(panel && !panel.hidden);
    }, null, { timeout: 60000 }).catch(() => {});
    const state = await page.evaluate(() => ({
      booted: Boolean(document.querySelector('#places-toggle:not([disabled])')),
      panel: document.querySelector('#map-error')?.hidden === false
        ? document.querySelector('#map-error-text')?.textContent ?? '' : '',
    }));
    if (!state.booted || state.panel || thrown.length) {
      throw new Error([
        '启动哨兵：页面没有正常起来，后面的整套结果都是它的连带，先修这一条。',
        state.panel ? `  错误面板：${state.panel}` : null,
        thrown.length ? `  页面异常：${thrown.slice(0, 3).join(' | ')}` : null,
        !state.booted ? '  控件在 60 秒内没有点亮。' : null,
      ].filter(Boolean).join('\n'));
    }
  } finally {
    await browser.close();
  }
};

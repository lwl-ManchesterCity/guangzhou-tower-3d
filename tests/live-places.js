// 公共 Overpass 两个镜像与底图样式主机是这个项目唯一的外部依赖：它们会 504、会超时。
// 这一格把"服务坏了"与"界面坏了"分开：只有量到外部签名（监听器记下的 5xx／请求失败，或页面自己报出的
// 「重新加载地点」／「地图连接超时」）才 skip，并把当时记到的数写进 skip 理由，让人能复核。
// 服务答了 200 而列表是空的、控件在时限内没点亮又没有任何故障记录——这两种仍然照红，那是我们的代码。
import { test, expect } from '@playwright/test';

const REMOTE = /(overpass-api\.de|maps\.mail\.ru|tiles\.openfreemap\.org)/;

/** 在页面上装外部故障监听器，返回一个会不断追加的数组（断言那边读同一个引用）。必须在 `openMap` 之前装。 */
export function watchRemote(page, log = []) {
  page.on('response', (response) => {
    if (REMOTE.test(response.url()) && response.status() >= 500) {
      log.push(`HTTP ${response.status()} ${new URL(response.url()).host}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (!REMOTE.test(request.url())) return;
    // `ERR_ABORTED` 不是宕机签名：换页会把上一页在飞的请求整批掐掉，这条判据第一次就是这么被
    // 误判成"外部不可用"的（实测切页之后记下四条 tiles.openfreemap.org net::ERR_ABORTED）。
    // 真超时/DNS/连不上仍然记，那才是服务坏了。
    const reason = request.failure()?.errorText ?? '';
    if (reason.includes('ERR_ABORTED')) return;
    log.push(`请求失败 ${new URL(request.url()).host} ${reason}`.trim());
  });
  return log;
}

/** 地点面板要等到真的有人。外部坏了 skip 并点名；服务没报错却拿不到地点，照红。 */
export async function livePlacesOrSkip(page, remote = [], { timeout = 90000, label = 'live places' } = {}) {
  const deadline = Date.now() + timeout;
  let last = 'waiting';
  for (;;) {
    if (await page.locator('#poi-list .poi-item').count()) return;
    const count = (await page.locator('#poi-count').textContent().catch(() => '?'))?.trim();
    if (await page.locator('#retry-pois').isVisible().catch(() => false)) {
      last = `面板报「重新加载地点」（${count}）`;
      test.skip(true, `${label}：外部服务不可用——${last}。两个公共 Overpass 镜像 504 时应用走的就是这条降级路径，不是布局缺陷。`);
    }
    if (remote.length) {
      test.skip(true, `${label}：外部服务不可用——${remote.join('、')}。`);
    }
    last = `等待中（${count}）`;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(1500);
  }
  expect.fail(`${label} 等满 ${Math.round(timeout / 1000)} s 仍只有「${last}」，且没有任何外部故障记录——这是代码问题，不 skip`);
}

/** 场景开完要等控件点亮。只有页面报了连接超时、或监听器记到外部故障才 skip。 */
export async function sceneReadyOrSkip(page, remote = [], { timeout = 60000, label = 'scene ready' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.locator('#places-toggle:not([disabled])').count()) return;
    const error = (await page.locator('#map-error-text').textContent().catch(() => ''))?.trim() ?? '';
    if (error.includes('超时')) {
      test.skip(true, `${label}：外部服务不可用——页面报「${error}」，底图样式或快照拉不回来。`);
    }
    if (remote.length) test.skip(true, `${label}：外部服务不可用——${remote.join('、')}。`);
    await page.waitForTimeout(1500);
  }
  expect(await page.locator('#places-toggle').first(),
    `${label}：控件在 ${Math.round(timeout / 1000)} s 内没点亮，且没有任何外部故障记录`).toBeEnabled({ timeout: 2000 });
}

// 一次性：在新引擎里找那一圈湿线到底进没进场景、在不在画、投影落在屏幕哪儿。
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('console', (message) => { if (message.type() === 'error') console.log('console error:', message.text()); });
await page.goto('http://127.0.0.1:5174/?engine=three#map=17.6/23.11026/113.31951/0/50', { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(12000);
const seen = await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  if (!n?.scene) return { error: `拿不到 scene：${Object.keys(n ?? {}).join(',')}` };
  const found = [];
  n.scene.traverse((object) => {
    if (/shore|wet/.test(object.name ?? '')) {
      const geometry = object.geometry;
      let box = null;
      if (geometry?.attributes?.position) {
        geometry.computeBoundingBox();
        const b = geometry.boundingBox;
        box = [b.min.x.toFixed(0), b.min.y.toFixed(2), b.min.z.toFixed(0), b.max.x.toFixed(0), b.max.y.toFixed(2), b.max.z.toFixed(0)];
      }
      found.push({
        name: object.name, type: object.type, visible: object.visible, parentVisible: object.parent?.visible,
        vertices: geometry?.attributes?.position?.count ?? null,
        opacity: object.material?.opacity ?? null, transparent: object.material?.transparent ?? null,
        depthWrite: object.material?.depthWrite ?? null, side: object.material?.side ?? null,
        map: object.material?.map ? `${object.material.map.image?.width}x${object.material.map.image?.height}` : null,
        box,
      });
    }
  });
  const groups = [];
  n.scene.traverse((object) => { if (object.type === 'Group') groups.push(`${object.name}:${object.children.length}:${object.visible}`); });
  return { found, groups, counts: n.counts?.() ?? null };
});
console.log(JSON.stringify(seen, null, 2));
await browser.close();

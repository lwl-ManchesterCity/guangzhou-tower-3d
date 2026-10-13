// 一次性：浏览器里路口数比 Node 多 8 根杆（268 对 260），先定位差在哪一笔。
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto('http://127.0.0.1:5174/?engine=three#map=18.4/23.10466/113.31992/0/52', { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(12000);
const out = await page.evaluate(async () => {
  const [{ neighborhood }, { DEFAULT_CENTER }, { TRAFFIC_LIFE_RADIUS, createTrafficLife, trafficAgents },
    { deriveJunctions, assignSignals }] = await Promise.all([
    import(document.querySelector('script[type="module"][src*="/src/main.js"]').src),
    import('/src/config.js'),
    import('/src/traffic-life.js'),
    import('/src/junctions.js'),
  ]);
  const fresh = (await (await fetch('/data/canton-streets.geojson')).json()).features;
  const origin = neighborhood.sceneCenter?.() ?? DEFAULT_CENTER;
  const tally = (features, label) => {
    const junctions = deriveJunctions({ features, origin, radius: TRAFFIC_LIFE_RADIUS });
    const traffic = createTrafficLife({ features, origin, junctions });
    return { label, junctions: junctions.length, lit: junctions.reduce((s, j) => s + j.approaches.filter((a) => a.lit).length, 0),
      poles: traffic.signals?.approaches ?? 0, cars: traffic.counts.cars,
      agents: trafficAgents(features, origin, TRAFFIC_LIFE_RADIUS).cars.length };
  };
  const inScene = [];
  neighborhood.scene.traverse((object) => { if (object.name === 'traffic-signals') inScene.push(object.children.map((c) => `${c.name}:${c.count}`).join(',')); });
  return {
    origin: JSON.stringify(origin) === JSON.stringify(DEFAULT_CENTER) ? 'DEFAULT_CENTER' : JSON.stringify(origin),
    fresh: tally(fresh, '页面自己再取一遍'),
    inScene,
    featureCount: fresh.length,
    readout: neighborhood.nearTraffic?.()?.signal ?? null,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();

// 一次性：把某一格画面里"有这个网格 / 没有这个网格"两张图逐像素比，用来回答"这层到底画没画出来"。
// 引擎是按需出帧的，所以每次改完可见性要自己 render 一帧；实例网格的几何只是模板，包围盒要按每台实例的位置算。
// 用法 `node scripts/probe-layer-pixels.mjs <镜头> <网格名>`。
import { chromium } from '@playwright/test';

const view = process.argv[2] || '17.6/23.11026/113.31951/0/50';
const target = process.argv[3] || 'shore-wet-line';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`http://127.0.0.1:5174/?engine=three#map=${view}`, { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(12000);

const box = await page.evaluate(async ({ wanted, width, height }) => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  n.setMotion?.(false);
  let mesh = null;
  n.scene.traverse((object) => { if (object.name === wanted) mesh = object; });
  if (!mesh) return { error: `场景里没有 ${wanted}` };
  const points = [];
  if (mesh.isInstancedMesh) {
    const matrix = new mesh.matrixWorld.constructor();
    const at = new mesh.position.constructor();
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, matrix);
      points.push(at.setFromMatrixPosition(matrix).clone());
    }
  } else {
    const position = mesh.geometry.getAttribute('position');
    const at = new mesh.position.constructor();
    for (let i = 0; i < position.count; i += 1) points.push(at.set(position.getX(i), position.getY(i), position.getZ(i)).clone());
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let inside = 0;
  for (const point of points) {
    point.project(n.camera);
    if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
    const x = (point.x + 1) / 2 * width;
    const y = (1 - point.y) / 2 * height;
    inside += 1;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { points: points.length, inside, visible: mesh.visible, box: [minX, minY, maxX, maxY].map(Math.round) };
}, { wanted: target, width: 1440, height: 960 });
console.log('投影：', JSON.stringify(box));
if (box.error || !box.inside) { await browser.close(); process.exit(1); }

const margin = 8;
const clip = {
  x: Math.max(0, box.box[0] - margin),
  y: Math.max(0, box.box[1] - margin),
  width: Math.min(1440, box.box[2] + margin) - Math.max(0, box.box[0] - margin),
  height: Math.min(960, box.box[3] + margin) - Math.max(0, box.box[1] - margin),
};
const grab = async (on) => {
  await page.evaluate(async ({ wanted, show }) => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    n.scene.traverse((object) => { if (object.name === wanted) object.visible = show; });
    n.renderer.render(n.scene, n.camera);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    n.renderer.render(n.scene, n.camera);
  }, { wanted: target, show: on });
  return (await page.screenshot({ clip })).toString('base64');
};
const withLayer = await grab(true);
const without = await grab(false);
const report = await page.evaluate(async ([a, b]) => {
  const decode = (base64) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, image.width, image.height));
    };
    image.src = `data:image/png;base64,${base64}`;
  });
  const [A, B] = await Promise.all([decode(a), decode(b)]);
  const lum = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  let changed = 0;
  let sum = 0;
  let darkest = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const delta = lum(B.data, i) - lum(A.data, i);
    if (Math.abs(delta) <= 2) continue;
    changed += 1;
    sum += delta;
    darkest = Math.max(darkest, delta);
  }
  return { pixels: A.width * A.height, changed, meanDarkening: changed ? (sum / changed).toFixed(1) : '0', darkestDelta: darkest.toFixed(1) };
}, [withLayer, without]);
console.log('开/关比对：', JSON.stringify(report));
await browser.close();

// 一次性：出厂快照里有多少外环是顺时针的（`ringBand` 的翻面规则就靠这一格说清代价）。
import { readFileSync } from 'node:fs';
import { DEFAULT_CENTER } from '../src/config.js';
import { plane } from '../src/geo.js';

const sense = (ring) => {
  let area = 0;
  const points = ring.map(([lng, lat]) => plane(DEFAULT_CENTER, { lng, lat }));
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    area += a.dx * b.dy - b.dx * a.dy;
  }
  return area >= 0 ? 1 : -1;
};
const rings = (feature) => (feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
  : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : []);
for (const file of ['canton-buildings.geojson', 'canton-water.geojson']) {
  const features = JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url), 'utf8')).features;
  let outer = 0;
  let clockwise = 0;
  let holes = 0;
  let holeCounter = 0;
  for (const feature of features) {
    for (const polygon of rings(feature)) {
      if (polygon.length < 1) continue;
      outer += 1;
      if (sense(polygon[0]) < 0) clockwise += 1;
      for (const hole of polygon.slice(1)) {
        holes += 1;
        if (sense(hole) > 0) holeCounter += 1;
      }
    }
  }
  console.log(`${file}: 外环 ${outer} 条，其中顺时针 ${clockwise} 条；洞 ${holes} 个，其中逆时针 ${holeCounter} 个`);
}

// 一次性：看两条带子的法线朝哪边。
import { DEFAULT_CENTER } from '../src/config.js';
import { baseBandGeometry, wetBandGeometry, WET_BAND_WIDTH_METRES } from '../src/shadow-pads.js';

const pointAt = (east, north) => [
  DEFAULT_CENTER.lng + east / (Math.cos(DEFAULT_CENTER.lat * Math.PI / 180) * 111320),
  DEFAULT_CENTER.lat + north / 110570,
];
const box = (edge, clockwise) => {
  const corners = [[-edge, -edge], [edge, -edge], [edge, edge], [-edge, edge]];
  const points = [];
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    points.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  const list = clockwise ? points.reverse() : points;
  return [...list.map(([x, y]) => pointAt(x, y)), pointAt(list[0][0], list[0][1])];
};
const feature = (ring) => ({ type: 'Feature', properties: { osmId: 1 }, geometry: { type: 'Polygon', coordinates: [ring] } });

for (const clockwise of [false, true]) {
  const ring = box(200, clockwise);
  const base = baseBandGeometry({ features: [feature(ring)], origin: DEFAULT_CENTER });
  const wet = wetBandGeometry({ features: [feature(ring)], origin: DEFAULT_CENTER });
  const report = (label, geometry) => {
    const n = geometry.getAttribute('normal');
    let up = 0;
    let down = 0;
    for (let i = 0; i < n.count; i += 1) (n.getY(i) > 0.9 ? up += 1 : down += 1);
    console.log(`  ${label}: 法线朝上 ${up}、朝下 ${down}`);
  };
  console.log(`${clockwise ? '顺' : '逆'}时针`);
  report('楼根带', base.geometry);
  report('湿线  ', wet.geometry);
}

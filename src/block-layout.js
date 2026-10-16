import { METERS_PER_DEGREE } from './geo.js';

export const schematicThickness = shortSide => Math.round(Math.min(24, Math.max(9.6, shortSide * 0.24)) * 10) / 10;

// 这一侧每栋轮廓各自画自己，没有街坊包络可量，所以同一份示意厚度改从每栋自己的外接框上取。
// 只有 9.6 m 那一档占位符拿到 displayHeight：带标注高度或按层数现算的楼保留来源那个数、根本不写
// displayHeight，于是渲染表达式落回真相而不是落回第二个编出来的数。
export function schematicDisplayHeights(features, { center }) {
  const metersX = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
  return features.map(feature => {
    const properties = feature.properties;
    if (properties.heightSource !== 'estimate') return feature;
    const box = feature.geometry.coordinates[0].slice(0, -1)
      .map(([lng, lat]) => [(lng - center.lng) * metersX, (lat - center.lat) * METERS_PER_DEGREE])
      .reduce(([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)],
        [Infinity, Infinity, -Infinity, -Infinity]);
    const side = Math.min(box[2] - box[0], box[3] - box[1]);
    return { ...feature, properties: { ...properties, displayHeight: properties.base + schematicThickness(side) } };
  });
}

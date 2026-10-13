export const HEIGHT_BINS = [
  { label: '0–20', min: 0, max: 20, color: '#94c9c4' },
  { label: '20–60', min: 20, max: 60, color: '#529fac' },
  { label: '60–100', min: 60, max: 100, color: '#477aaf' },
  { label: '100–200', min: 100, max: 200, color: '#6965a6' },
  { label: '200+', min: 200, max: Infinity, color: '#985d91' },
];
export const UNKNOWN_HEIGHT_COLOR = '#9fa9ad';

export function heightSummary(features, category = 'all') {
  const summary = { total: 0, sources: { height: 0, levels: 0, estimate: 0 }, bins: HEIGHT_BINS.map(() => ({ height: 0, levels: 0 })) };
  for (const { properties: p } of features) {
    if (p.tower || (category !== 'all' && p.category !== category)) continue;
    summary.total++;
    summary.sources[p.heightSource]++;
    if (p.heightSource === 'estimate') continue;
    const index = HEIGHT_BINS.findIndex(bin => p.height >= bin.min && p.height < bin.max);
    summary.bins[index][p.heightSource]++;
  }
  return summary;
}

export function lensFilter(category = 'all', source = 'all') {
  return ['all', category === 'all' ? true : ['==', ['get', 'category'], category], source === 'all' ? true : ['==', ['get', 'heightSource'], source]];
}

export function heightColor() {
  return ['case', ['==', ['get', 'heightSource'], 'estimate'], UNKNOWN_HEIGHT_COLOR,
    ['step', ['get', 'height'], HEIGHT_BINS[0].color, ...HEIGHT_BINS.slice(1).flatMap(bin => [bin.min, bin.color])]];
}

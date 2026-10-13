export function addGrounds(map, data) {
  map.addSource('school-grounds', { type: 'geojson', data, attribution: '© OpenStreetMap contributors · 校园与绿地 / ODbL' });
  const underRoads = map.getStyle().layers.find(layer => layer['source-layer'] === 'transportation')?.id;
  map.addLayer({ id: 'school-mountain', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'mountain'], paint: { 'fill-color': '#5e7865', 'fill-opacity': 0.8 } }, underRoads);
  map.addLayer({ id: 'school-parks', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'park'], paint: { 'fill-color': '#abc594', 'fill-opacity': 0.8 } }, underRoads);
  map.addLayer({ id: 'school-campus', type: 'fill', source: 'school-grounds', filter: ['all', ['==', ['get', 'kind'], 'campus'], ['==', ['get', 'target'], true]], paint: { 'fill-color': '#72b7b0', 'fill-opacity': 0.9 } });
  map.addLayer({ id: 'school-boundary', type: 'line', source: 'school-grounds', filter: ['all', ['==', ['get', 'kind'], 'campus'], ['==', ['get', 'target'], true]], paint: { 'line-color': '#276d69', 'line-width': 2.5 } });
  map.addLayer({ id: 'school-tracks', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'track'], paint: { 'fill-color': ['case', ['==', ['get', 'target'], true], '#b5493a', '#8ca387'], 'fill-opacity': 1 } });
  map.addLayer({ id: 'school-pitches', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'pitch'], paint: { 'fill-color': ['case', ['==', ['get', 'target'], true], '#4a7c59', '#91b18c'], 'fill-opacity': 1 } });
  map.addLayer({ id: 'school-pitch-edge', type: 'line', source: 'school-grounds', filter: ['all', ['==', ['get', 'kind'], 'pitch'], ['==', ['get', 'target'], true]], paint: { 'line-color': '#b5493a', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 7, 19, 11] } });
}

// The grounds the school scene paints for itself, as `layer -> [property, colour]`, so the map can either write them in
// one step or walk a theme pair through them like any other atmosphere paint.
export function groundColors(id) {
  const [mountain, parks, campus] = id === 'night' ? ['#29463e', '#537558', '#669f98'] : id === 'sunset' ? ['#68735b', '#aaa77e', '#83b6a4'] : ['#5e7865', '#abc594', '#72b7b0'];
  return {
    'school-mountain': ['fill-color', mountain],
    'school-parks': ['fill-color', parks],
    'school-campus': ['fill-color', campus],
    'school-boundary': ['line-color', id === 'night' ? '#b4e2d6' : id === 'sunset' ? '#346c5c' : '#276d69'],
  };
}

export function styleGrounds(map, id) {
  for (const [layer, [property, value]] of Object.entries(groundColors(id))) map.setPaintProperty(layer, property, value);
}


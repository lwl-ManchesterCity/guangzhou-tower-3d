export function addGrounds(map, data) {
  map.addSource('school-grounds', { type: 'geojson', data, attribution: '© OpenStreetMap contributors · 校园与绿地 / ODbL' });
  const underRoads = map.getStyle().layers.find(layer => layer['source-layer'] === 'transportation')?.id;
  map.addLayer({ id: 'school-mountain', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'mountain'], paint: { 'fill-color': '#5e7865', 'fill-opacity': 0.8 } }, underRoads);
  map.addLayer({ id: 'school-parks', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'park'], paint: { 'fill-color': '#abc594', 'fill-opacity': 0.8 } }, underRoads);
  map.addLayer({ id: 'school-campus', type: 'fill', source: 'school-grounds', filter: ['all', ['==', ['get', 'kind'], 'campus'], ['==', ['get', 'target'], true]], paint: { 'fill-color': '#eadba1', 'fill-opacity': 0.5 } });
  map.addLayer({ id: 'school-boundary', type: 'line', source: 'school-grounds', filter: ['all', ['==', ['get', 'kind'], 'campus'], ['==', ['get', 'target'], true]], paint: { 'line-color': '#c1a052', 'line-width': 2.5 } });
  map.addLayer({ id: 'school-tracks', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'track'], paint: { 'fill-color': ['case', ['==', ['get', 'target'], true], '#b5493a', '#8ca387'], 'fill-opacity': 1 } });
  map.addLayer({ id: 'school-pitches', type: 'fill', source: 'school-grounds', filter: ['==', ['get', 'kind'], 'pitch'], paint: { 'fill-color': ['case', ['==', ['get', 'target'], true], '#4a7c59', '#91b18c'], 'fill-opacity': 1 } });
  map.addLayer({ id: 'school-pitch-edge', type: 'line', source: 'school-grounds', filter: ['all', ['==', ['get', 'kind'], 'pitch'], ['==', ['get', 'target'], true]], paint: { 'line-color': '#b5493a', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 7, 19, 11] } });
}

export function styleGrounds(map, id) {
  const colors = id === 'night' ? ['#29463e', '#537558', '#b9a578'] : id === 'sunset' ? ['#68735b', '#aaa77e', '#dfbe84'] : ['#5e7865', '#abc594', '#eadba1'];
  for (const [index, layer] of ['school-mountain', 'school-parks', 'school-campus'].entries()) map.setPaintProperty(layer, 'fill-color', colors[index]);
}

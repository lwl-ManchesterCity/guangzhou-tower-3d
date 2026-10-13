import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { DEFAULT_BUILDING_HEIGHT, DEFAULT_CENTER, MAP_STYLE_URL, POI_CATEGORIES, RADIUS_METERS, SCENE, TOWER_OSM_ID, VIEW_LIMITS } from './config.js';
import { ATMOSPHERES, baseAtmospherePaint, buildingAtmosphereColor } from './atmosphere.js';
import { featureCollection, radiusPolygon } from './geo.js';
import { insideRing, interiorPoint } from './buildings.js';
import { formatView, parseView } from './link.js';
import { mapIcon } from './icons.js';
import { poisGeoJSON } from './pois.js';
import { createTowerLayer } from './tower.js';
import { createTour, TOUR_STOPS } from './tour.js';
import { heightColor, heightSummary, lensFilter, UNKNOWN_HEIGHT_COLOR } from './lens.js';
import { addGrounds, styleGrounds } from './grounds.js';

maplibregl.setWorkerUrl(workerUrl);
const school = SCENE.id === 'jingtai';
const center = [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat];
const distance = ['distance', { type: 'Point', coordinates: center }];
const buildingId = (id) => String(id).startsWith('relation/') ? id : Number(id);

// Polygon-only subset of jingtai-data.geometryPoint: keep data preparation and walking graphs out of the client.
// The current building snapshots are all Polygons; holes must participate even for unnamed, unindexed relations.
function geometryPoint(geometry) {
  const polygon = geometry.coordinates;
  const contains = (point) => insideRing(polygon[0], ...point) && !polygon.slice(1).some((ring) => insideRing(ring, ...point));
  const point = interiorPoint(polygon[0]);
  if (polygon.length === 1 || contains(point)) return point;
  const lats = polygon[0].map((p) => p[1]);
  const min = Math.min(...lats), max = Math.max(...lats);
  for (let row = 1; row < 32; row++) {
    const y = min + (max - min) * row / 32;
    const xs = [];
    for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const candidate = [(xs[i - 1] + xs[i]) / 2, y];
      if (contains(candidate)) return candidate;
    }
  }
  throw new Error('no interior building point');
}

function neighborhoodStyle(style) {
  style.projection = { type: 'mercator' };
  style.layers = style.layers.filter((layer) => layer.type !== 'fill-extrusion' && !['poi', 'housenumber'].includes(layer['source-layer']) && !layer.id.includes('shield'));
  for (const layer of style.layers) {
    const source = layer['source-layer'];
    if (layer.type === 'fill' && source === 'building') {
      delete layer.maxzoom;
      layer.paint = {};
    }
    layer.paint = { ...layer.paint, ...baseAtmospherePaint(layer, ATMOSPHERES.day) };
    if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      layer.layout['text-field'] = ['coalesce', ['get', 'name:zh'], ['get', 'name:en'], ['get', 'name']];
      if (['transportation_name', 'place'].includes(source)) layer.minzoom = Math.max(layer.minzoom ?? 0, source === 'place' ? 16 : 16.5);
    }
  }
  return style;
}

export async function createNeighborhoodMap({ onPoiClick, onBuildingClick, onInteraction, onTourChange, onLensChange, onError }) {
  const [response, buildingsResponse, groundsResponse] = await Promise.all([
    fetch(MAP_STYLE_URL, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/${SCENE.buildings}`, { signal: AbortSignal.timeout(25000) }),
    school ? fetch(`${import.meta.env.BASE_URL}data/${SCENE.grounds}`, { signal: AbortSignal.timeout(25000) }) : null,
  ]);
  if (!response.ok) throw new Error(`底图服务不可用（HTTP ${response.status}），请检查网络后重试。`);
  if (!buildingsResponse.ok) throw new Error(`建筑快照未能加载（HTTP ${buildingsResponse.status}），请重新加载。`);
  if (groundsResponse && !groundsResponse.ok) throw new Error(`校园与绿地未能加载（HTTP ${groundsResponse.status}），请重新加载。`);
  const buildings = await buildingsResponse.json();
  const grounds = groundsResponse ? await groundsResponse.json() : null;
  const style = neighborhoodStyle(await response.json());
  const mobile = () => window.innerWidth <= 760;
  const landscape = () => window.matchMedia('(min-width: 568px) and (max-width: 1000px) and (max-height: 500px)').matches;
  let panelOpen = false;
  const padding = () => landscape()
    ? { top: 180, left: 20, right: panelOpen ? 330 : 20, bottom: 65 }
    : mobile() ? { top: school && innerHeight <= 600 && !panelOpen ? 105 : 255, left: 15, right: 15, bottom: panelOpen ? Math.round(innerHeight * 0.38 + 129) : 110 } : { top: 200, left: 280, right: panelOpen ? 360 : 0, bottom: 60 };
  function lensPadding() {
    const box = document.querySelector('.scene-key').getBoundingClientRect();
    if (!box.height) return padding();
    const top = Math.max(...[...document.querySelector('.topbar').children, document.querySelector('.intro-actions')].map(node => node.getBoundingClientRect().bottom)) + 16;
    return landscape() ? { top, left: 20, right: innerWidth - box.left + 48, bottom: 36 }
      : mobile() ? { top, left: 20, right: 50, bottom: innerHeight - box.top + 20 }
        : { top: 110, left: box.right + 24, right: panelOpen ? 370 : 60, bottom: 110 };
  }
  const heroCamera = () => ({ center, zoom: landscape() ? SCENE.camera.landscapeZoom : mobile() ? SCENE.camera.mobileZoom : SCENE.camera.zoom, pitch: SCENE.camera.pitch, bearing: SCENE.camera.bearing, padding: padding() });
  // Shared cameras use the map's pan limits; selectable buildings come only from the local snapshot.
  const shared = parseView(window.location.hash);
  const map = new maplibregl.Map({
    container: 'map', style, ...(shared.camera ? { ...shared.camera, padding: padding() } : heroCamera()),
    maxPitch: VIEW_LIMITS.maxPitch, minZoom: VIEW_LIMITS.minZoom, maxZoom: VIEW_LIMITS.maxZoom,
    maxBounds: [[DEFAULT_CENTER.lng - VIEW_LIMITS.span, DEFAULT_CENTER.lat - VIEW_LIMITS.span], [DEFAULT_CENTER.lng + VIEW_LIMITS.span, DEFAULT_CENTER.lat + VIEW_LIMITS.span]],
    maxTileCacheSize: 100, attributionControl: { compact: true }, canvasContextAttributes: { antialias: true },
  });
  map.setPadding(padding());
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 80, unit: 'metric' }), 'bottom-left');
  map.on('error', onError);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { map.remove(); reject(new Error('地图加载超时，请检查网络后重新加载。')); }, 40000);
    map.once('load', () => { clearTimeout(timeout); resolve(); });
  });
  let frame, previousTime, popup, selectedPoiId, cardBlock;
  let orbiting = false, poiFeatures = [], activeFilter = 'all';
  let lens = { mode: 'use', category: 'all', source: 'all' }, atmosphereId = 'day';
  let selection; // the block an open card describes, so the address bar can point back at it
  let focus; // a block waiting for the camera and its tiles to settle before it can be picked
  let lastHash = window.location.hash;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // replaceState is rate limited by the browser and orbit rewrites it every frame, so the address bar only follows a
  // camera that actually stopped somewhere.
  function writeHash() {
    if (orbiting) return;
    const hash = formatView({ zoom: map.getZoom(), center: map.getCenter(), bearing: map.getBearing(), pitch: map.getPitch() }, selection);
    if (hash === lastHash) return;
    lastHash = hash;
    window.history.replaceState(null, '', hash);
  }
  if (grounds) addGrounds(map, grounds);
  const circle = radiusPolygon(DEFAULT_CENTER, RADIUS_METERS);
  map.addSource('neighborhood-radius', { type: 'geojson', data: circle });
  map.addLayer({ id: 'radius-line', type: 'line', source: 'neighborhood-radius', paint: { 'line-color': '#52838a', 'line-width': 1.2, 'line-dasharray': [4, 4], 'line-opacity': 0.65 } });
  map.addLayer({
    id: 'context-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    filter: ['all', ['!=', ['get', 'hide_3d'], true], ['>', distance, RADIUS_METERS]],
    paint: { 'fill-extrusion-color': '#ccd3ce', 'fill-extrusion-height': ['to-number', ['get', 'render_height'], DEFAULT_BUILDING_HEIGHT], 'fill-extrusion-base': ['to-number', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.4, 'fill-extrusion-vertical-gradient': true },
  });
  map.addSource('canton-buildings', { type: 'geojson', data: buildings, maxzoom: 16, tolerance: 0.4, attribution: '© OpenStreetMap contributors · 建筑快照 / ODbL' });
  map.addLayer({ id: 'height-unknown', type: 'fill', source: 'canton-buildings', layout: { visibility: 'none' }, filter: lensFilter('all', 'estimate'), paint: { 'fill-color': UNKNOWN_HEIGHT_COLOR, 'fill-opacity': 0.65, 'fill-outline-color': '#66777c' } });
  const paint = {
    'fill-extrusion-color': buildingAtmosphereColor(ATMOSPHERES.day),
    'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'base'],
    'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': true,
  };
  const overviewFilter = school ? true : ['any', ['>=', ['get', 'height'], 25], ['>=', ['get', 'area'], 1200]];
  map.addLayer({ id: 'neighborhood-buildings-overview', type: 'fill-extrusion', source: 'canton-buildings', maxzoom: 14, filter: ['all', overviewFilter], paint });
  map.addLayer({ id: 'neighborhood-buildings', type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14, paint });
  map.addLayer({ id: 'height-estimates', type: 'fill-extrusion', source: 'canton-buildings', layout: { visibility: 'none' }, filter: lensFilter('all', 'levels'), paint: { ...paint, 'fill-extrusion-color': heightColor(), 'fill-extrusion-opacity': 0.55 } });
  map.setLight(ATMOSPHERES.day.light);
  map.setSky({ ...ATMOSPHERES.day.sky, 'fog-ground-blend': 0.25, 'horizon-fog-blend': 0.7, 'sky-horizon-blend': 0.8 });
  const towerLayer = school ? null : createTowerLayer();
  const towerHeight = 450;
  if (towerLayer) {
    map.addLayer(towerLayer);
    map.addSource('canton-tower', { type: 'geojson', data: `${import.meta.env.BASE_URL}data/canton-tower.geojson` });
    map.addLayer({ id: 'canton-tower-hit', type: 'fill-extrusion', source: 'canton-tower', paint: { 'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': towerHeight, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0 } });
  }
  map.addSource('building-selection', { type: 'geojson', data: featureCollection() });
  map.addLayer({
    id: 'building-selection', type: 'fill-extrusion', source: 'building-selection',
    paint: { 'fill-extrusion-color': '#1f4e5f', 'fill-extrusion-height': ['to-number', ['get', 'height'], 0], 'fill-extrusion-base': ['to-number', ['get', 'base'], 0], 'fill-extrusion-opacity': 0.35 },
  });
  map.addLayer({ id: 'building-selection-flat', type: 'fill', source: 'building-selection', filter: ['==', ['get', 'height'], 0], paint: { 'fill-color': ATMOSPHERES.day.selection, 'fill-opacity': 0.5 } });
  map.addSource('tower-label', { type: 'geojson', data: featureCollection([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: center } }]) });
  map.addLayer({ id: 'tower-label', type: 'symbol', source: 'tower-label', layout: { 'text-field': SCENE.name, 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': school ? [0, 2] : [2, 0], 'text-anchor': school ? 'top' : 'left', 'text-allow-overlap': true }, paint: { 'text-color': '#365f66', 'text-halo-color': '#f5f8f2', 'text-halo-width': 2 } });
  if (school) {
    map.addSource('walking-route', { type: 'geojson', data: featureCollection() });
    map.addLayer({ id: 'walking-route', type: 'line', source: 'walking-route', paint: { 'line-color': '#487586', 'line-width': 3, 'line-dasharray': [2, 1] } });
  }
  for (const [key, category] of Object.entries(POI_CATEGORIES)) map.addImage(`poi-${key}`, await mapIcon(category), { pixelRatio: 2 });
  map.addSource('neighborhood-pois', { type: 'geojson', data: featureCollection() });
  map.addLayer({
    id: 'poi-markers', type: 'symbol', source: 'neighborhood-pois',
    layout: { 'icon-image': ['concat', 'poi-', ['get', 'category']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 14, 0.7, 16, 0.9], 'icon-allow-overlap': true, 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-max-width': 10, 'text-optional': true, 'text-padding': 10, 'icon-padding': 6 },
    paint: { 'text-color': '#304c50', 'text-halo-color': '#fbfcf8', 'text-halo-width': 2 },
  });

  function applyLens() {
    const heights = lens.mode === 'height';
    const filter = lensFilter(lens.category, heights ? lens.source : 'all');
    const tagged = ['all', filter, ['==', ['get', 'heightSource'], 'height']];
    map.setFilter('neighborhood-buildings', heights ? tagged : filter);
    map.setFilter('neighborhood-buildings-overview', heights ? tagged : ['all', filter, overviewFilter]);
    for (const [layer, source] of [['height-estimates', 'levels'], ['height-unknown', 'estimate']]) {
      map.setFilter(layer, ['all', filter, ['==', ['get', 'heightSource'], source]]);
      map.setLayoutProperty(layer, 'visibility', heights ? 'visible' : 'none');
    }
    for (const layer of ['neighborhood-buildings', 'neighborhood-buildings-overview']) map.setPaintProperty(layer, 'fill-extrusion-color', heights ? heightColor() : buildingAtmosphereColor(ATMOSPHERES[atmosphereId]));
    map.setLayoutProperty('context-buildings', 'visibility', heights || lens.category !== 'all' ? 'none' : 'visible');
    onLensChange(lens, heightSummary(buildings.features, lens.category));
    if (hoverPoint) hoverFrame ??= requestAnimationFrame(hoverCursor);
  }
  function resetLens() {
    if (lens.mode === 'use' && lens.category === 'all') return;
    lens = { mode: 'use', category: 'all', source: 'all' };
    applyLens();
  }
  function setLens(next) {
    manualInteraction(); cancelFocus(); popup?.remove();
    lens = { ...next };
    applyLens();
  }
  function setAtmosphere(id) {
    atmosphereId = id;
    const theme = ATMOSPHERES[id];
    const paintColor = (layer, property, value) => {
      map.setPaintProperty(layer, `${property}-transition`, { duration: 0 });
      map.setPaintProperty(layer, property, value);
    };
    for (const layer of style.layers) {
      const paint = { ...layer.paint, ...baseAtmospherePaint(layer, theme) };
      for (const property of ['background-color', 'fill-color', 'fill-pattern', 'line-color', 'text-color', 'text-halo-color']) {
        if (paint[property] !== undefined) paintColor(layer.id, property, paint[property]);
      }
    }
    for (const layer of ['neighborhood-buildings', 'neighborhood-buildings-overview']) paintColor(layer, 'fill-extrusion-color', lens.mode === 'height' ? heightColor() : buildingAtmosphereColor(theme));
    paintColor('context-buildings', 'fill-extrusion-color', theme.context);
    paintColor('building-selection', 'fill-extrusion-color', theme.selection);
    paintColor('building-selection-flat', 'fill-color', theme.selection);
    paintColor('radius-line', 'line-color', theme.radius);
    paintColor('tower-label', 'text-color', theme.towerText);
    paintColor('tower-label', 'text-halo-color', theme.towerHalo);
    paintColor('poi-markers', 'text-color', theme.poiText);
    paintColor('poi-markers', 'text-halo-color', theme.poiHalo);
    map.setLight({ ...theme.light, 'color-transition': { duration: 0 }, 'intensity-transition': { duration: 0 }, 'position-transition': { duration: 0 } });
    map.setSky({ ...theme.sky, 'sky-color-transition': { duration: 0 }, 'horizon-color-transition': { duration: 0 }, 'fog-color-transition': { duration: 0 } });
    towerLayer?.setAtmosphere(theme.tower);
    if (school) {
      styleGrounds(map, id);
      paintColor('walking-route', 'line-color', theme.radius);
    }
  }

  let tourMarker;
  const tour = createTour(map, {
    camera(stop) {
      const player = document.getElementById('tour-player').getBoundingClientRect();
      const top = Math.max(...[...document.querySelector('.topbar').children].map(node => node.getBoundingClientRect().bottom)) + 24;
      const bottom = landscape() ? innerHeight - 40 : player.top - 20;
      const height = Math.max(100, bottom - top);
      const tower = stop.osmId === TOWER_OSM_ID;
      return {
        center: stop.center, bearing: stop.bearing, pitch: stop.pitch,
        zoom: stop.zoom + Math.min(0, Math.log2(height / 430)),
        padding: { top: top + height * (tower ? 0.6 : 0), bottom: innerHeight - bottom, left: 20, right: landscape() ? innerWidth - player.left + 20 : 20 },
        duration: reducedMotion.matches ? 0 : 2200,
      };
    },
    onChange(state) {
      onTourChange(state);
      if (state.index < 0) { tourMarker?.remove(); tourMarker = undefined; return; }
      const stop = TOUR_STOPS[state.index];
      if (!tourMarker) {
        const node = document.createElement('div');
        node.className = 'tour-marker';
        node.setAttribute('aria-hidden', 'true');
        tourMarker = new maplibregl.Marker({ element: node, anchor: 'top', offset: [0, 12] });
      }
      tourMarker.getElement().textContent = `${String(state.index + 1).padStart(2, '0')} · ${stop.name}`;
      tourMarker.setLngLat(stop.center).addTo(map);
    },
  });

  function stopOrbit() { orbiting = false; cancelAnimationFrame(frame); previousTime = undefined; writeHash(); }
  function setOutline(feature) { map.getSource('building-selection')?.setData(featureCollection(feature ? [feature] : [])); }
  const rectOf = (selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect?.width && rect?.height ? rect : null;
  };
  // MapLibre's own placement only knows the canvas edges, so the control bar, zoom stack, credits, header chips and the
  // two drawers the user can have open are counted as occlusion too. Scored as [off-screen, controls, own block, control
  // pill]: text clipped by the viewport is unreadable, a control the card has actually knocked out beats any placement
  // that hides the building (the credits carry a licence that has to stay on screen), a card over its own building
  // defeats the click, and the pill comes last because it can fade out instead of moving. A control counts by how much of
  // *itself* disappears, and only past a quarter of it, so a card clipping the corner of the MapLibre logo does not
  // outrank one that buries the block it is describing.
  const occluders = ['.maplibregl-ctrl-bottom-right', '.maplibregl-ctrl-bottom-left', '.maplibregl-ctrl-attrib', '.topbar > *', '.search-panel', '.poi-panel'];
  const rectsOf = (selector) => [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width && rect.height);
  function occlusion(node) {
    const card = node.querySelector('.maplibregl-popup-content')?.getBoundingClientRect();
    if (!card) return [0, 0, 0, 0];
    const area = (rect) => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
    const percent = (px) => Math.round(px / area(card) * 100);
    const clip = (rect) => ({ left: Math.max(rect.left, 0), top: Math.max(rect.top, 0), right: Math.min(rect.right, innerWidth), bottom: Math.min(rect.bottom, innerHeight) });
    const over = (rect) => rect ? area(clip({ left: Math.max(card.left, rect.left), top: Math.max(card.top, rect.top), right: Math.min(card.right, rect.right), bottom: Math.min(card.bottom, rect.bottom) })) : 0;
    const hurt = (rect) => {
      const visible = area(clip(rect));
      return visible ? Math.max(0, Math.round(over(rect) / visible * 100) - 25) : 0;
    };
    // An extrusion is drawn upward from its base ring, so a card hung below the near corner or above the roof leaves the
    // volume on screen while one hung above that corner covers it. queryRenderedFeatures only sees the rendered frame,
    // which makes it an exact test for "is this block still visible under this card".
    const hidesBlock = cardBlock === undefined ? 0 : Number(map.queryRenderedFeatures([[card.left, card.top], [card.right, card.bottom]], { layers: extrusions })
      .some((feature) => String(feature.properties.osmId) === String(cardBlock)));
    return [
      percent(area(card) - area(clip(card))),
      Math.max(0, ...occluders.flatMap((selector) => rectsOf(selector)).map(hurt)),
      hidesBlock,
      percent(over(rectOf('#view-controls'))),
    ];
  }
  const lighter = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
  function attach(lngLat, content, closeLabel, anchor, blockId) {
    popup?.remove();
    popup = new maplibregl.Popup({ offset: 20, maxWidth: '250px', closeButton: true, focusAfterOpen: true, anchor })
      .setLngLat(lngLat).setDOMContent(content).addTo(map);
    const element = popup.getElement();
    element.querySelector('.maplibregl-popup-close-button').setAttribute('aria-label', closeLabel);
    cardBlock = blockId;
    popup.on('close', () => { popup = undefined; cardBlock = undefined; document.body.dataset.card = 'closed'; document.body.dataset.cardPill = null; setOutline(null); map.getSource('walking-route')?.setData(featureCollection()); if (selection) { selection = null; writeHash(); } });
    document.body.dataset.card = 'open';
    return popup;
  }
  // A card whose point sits near a viewport edge gets clipped there, so the point is slid along the ground by exactly the
  // amount that pulls the card back inside. The slide runs across the ground for the seats that hang above or below the
  // block and down it for the seats that stand beside it, because sliding a side seat sideways is what pushes it back on
  // top of the block. Only worth doing for cards the camera does not move under, since the shift is computed for the
  // frame being measured.
  function slideIntoView(axis) {
    const rect = popup.getElement().getBoundingClientRect();
    const shift = axis === 'x'
      ? (rect.left < 8 ? 8 - rect.left : 0) + (rect.right > innerWidth - 8 ? innerWidth - 8 - rect.right : 0)
      : (rect.top < 8 ? 8 - rect.top : 0) + (rect.bottom > innerHeight - 8 ? innerHeight - 8 - rect.bottom : 0);
    if (!shift) return;
    const pos = map.project(popup.getLngLat());
    popup.setLngLat(map.unproject(axis === 'x' ? [pos.x + shift, pos.y] : [pos.x, pos.y + shift]));
  }
  // The pill flag is scored against the frame being measured, but a place card is opened before showPoi eases the
  // camera under it, so the verdict goes stale. Recomputing it on every settled move keeps the pill faded only while a
  // card really covers it.
  function syncPill() {
    if (popup) document.body.dataset.cardPill = occlusion(popup.getElement())[3] ? 'covered' : null;
  }
  function openPopup(seats, content, { outline = null, closeLabel, blockId }) {
    // A card that can be re-seated is attached at every seat and measured, and the first that hides nothing wins. A POI
    // card has a single seat because showPoi eases the camera under it right afterwards, and only MapLibre's own auto
    // anchor is recomputed on every move.
    const reseat = seats.length > 1;
    let best, bestScore, attached;
    for (const seat of seats) {
      attach(seat.lngLat, content, closeLabel, seat.anchor, blockId);
      attached = seat;
      if (reseat) slideIntoView(seat.axis);
      const measured = occlusion(popup.getElement());
      if (!bestScore || lighter(measured, bestScore) < 0) { bestScore = measured; best = seat; }
      if (!measured.some((score) => score)) break;
    }
    if (attached !== best) { attach(best.lngLat, content, closeLabel, best.anchor, blockId); if (reseat) slideIntoView(best.axis); }
    syncPill();
    setOutline(outline);
  }
  function animate(time) {
    if (!orbiting) return;
    if (previousTime !== undefined) map.rotateTo(map.getBearing() + Math.min(time - previousTime, 100) * 0.003, { duration: 0 });
    previousTime = time;
    frame = requestAnimationFrame(animate);
  }
  function manualInteraction() { stopOrbit(); tour.exit(); onInteraction(); }
  function visibilityChange() { if (document.hidden) manualInteraction(); }
  let wasLandscape = landscape();
  function resize() {
    const isLandscape = landscape();
    if (tour.active) tour.reframe();
    else if (lens.mode === 'height') map.setPadding(lensPadding());
    else {
      map.setPadding(padding());
      if (isLandscape && !wasLandscape) map.setZoom(Math.min(map.getZoom(), SCENE.camera.landscapeZoom));
    }
    wasLandscape = isLandscape;
  }
  map.getCanvas().addEventListener('wheel', manualInteraction, { passive: true });
  map.getCanvas().addEventListener('pointerdown', manualInteraction, { passive: true });

  // macOS turns ⌃/two-finger click into a right-button press that cannot be held while dragging, so ⌥ + left drag rotates.
  // 20° per 100px and 25° per 100px of pitch: MapLibre's own drag-rotate (0.8°/px) spins past the target building, and its
  // around-center maths yields 0° for a horizontal drag on the center row, which reads as "rotation is broken" on a trackpad.
  const canvas = map.getCanvas();
  let altDrag;
  function altRotateDown(event) {
    if (event.button !== 0 || !event.altKey || event.ctrlKey || event.metaKey) return;
    event.stopPropagation();
    event.preventDefault();
    altDrag = { x: event.clientX, y: event.clientY };
    window.addEventListener('mousemove', altRotateMove);
    window.addEventListener('mouseup', altRotateUp);
  }
  function altRotateMove(event) {
    const dx = event.clientX - altDrag.x, dy = event.clientY - altDrag.y;
    altDrag = { x: event.clientX, y: event.clientY };
    map.setBearing(map.getBearing() + dx * 0.2);
    map.setPitch(Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() - dy * 0.25)));
  }
  function altRotateUp() {
    altDrag = undefined;
    window.removeEventListener('mousemove', altRotateMove);
    window.removeEventListener('mouseup', altRotateUp);
  }
  canvas.addEventListener('mousedown', altRotateDown, { capture: true });

  // Trackpad pointers land a few pixels off a ~20 px icon, so hit-test a small box instead of one point.
  const box = (point, size) => [[point.x - size, point.y - size], [point.x + size, point.y + size]];
  const poiAt = (point) => map.queryRenderedFeatures(box(point, 6), { layers: ['poi-markers'] });
  const extrusions = [school ? 'school-campus' : 'canton-tower-hit', 'neighborhood-buildings', 'neighborhood-buildings-overview', 'height-estimates', 'height-unknown'];
  const buildingAt = (point) => {
    const hits = map.queryRenderedFeatures(box(point, 2), { layers: extrusions });
    return hits.find((hit) => hit.properties.tower) ?? hits[0] ?? null;
  };
  // The card's point is the block's lowest projected base corner; which side it hangs on is left to openPopup(), which
  // measures every seat instead of guessing from how much canvas happens to be below that corner.
  const anchorPoint = (geometry) => {
    const points = geometry.coordinates[0].map(([lng, lat]) => map.project([lng, lat]));
    const near = points.reduce((a, b) => (b.y > a.y ? b : a));
    return { lngLat: map.unproject([near.x, near.y]) };
  };
  // An extrusion is drawn upward from its base ring, so a card can stand clear of the block it describes from either
  // side: below that corner, or above the roof line. The roof is found by walking up the screen until the block stops
  // answering hit-tests, which stays correct at any pitch, zoom or height. A column only reaches the roof edge above the
  // point it was walked from, so the two tallest ones are walked and the higher answer wins. A block taller than both of
  // those gaps still has room beside its silhouette, which is the only direction a short landscape screen has to give.
  // MapLibre's own placement is offered last as the fallback when every measured seat is crowded out.
  function buildingSeats(geometry, lngLat, blockId) {
    const ring = geometry.coordinates[0];
    const points = ring.map(([lng, lat]) => map.project([lng, lat]));
    const high = points.reduce((a, b) => (b.y < a.y ? b : a), points[0]);
    const near = points.reduce((a, b) => (b.y > a.y ? b : a), points[0]);
    const west = points.reduce((a, b) => (b.x < a.x ? b : a), points[0]);
    const east = points.reduce((a, b) => (b.x > a.x ? b : a), points[0]);
    const inside = map.project(geometryPoint(geometry));
    const drawn = (x, y) => y >= 0 && map.queryRenderedFeatures(box([x, y], 2), { layers: extrusions })
      .some((feature) => String(feature.properties.osmId) === String(blockId));
    const roofTop = ({ x, y }) => {
      let top = y;
      for (let dy = 20; dy <= 720 && drawn(x, y - dy); dy += 20) top = y - dy;
      return top;
    };
    const roof = Math.min(roofTop(inside), roofTop(high));
    const midY = (roof + near.y) / 2;
    // Offered roomiest-side first, and the scorecard, not this guess, decides which one is actually used.
    const sides = [
      { lngLat: map.unproject([east.x + 8, midY]), anchor: 'left', axis: 'y', room: innerWidth - east.x },
      { lngLat: map.unproject([west.x - 8, midY]), anchor: 'right', axis: 'y', room: west.x },
    ].sort((a, b) => b.room - a.room);
    return [
      { lngLat, anchor: 'top', axis: 'x' },
      { lngLat: map.unproject([inside.x, Math.max(roof - 40, 0)]), anchor: 'bottom', axis: 'x' },
      ...sides,
      { lngLat, axis: 'x' },
    ];
  }
  // Everything that opens a building card goes through here, so a click, a search result and a shared link produce the
  // same card, the same highlight and the same address bar.
  function selectFeature(feature) {
    const { properties } = feature;
    // Rendered features can be tile-clipped and lose holes; use the complete snapshot for the outline and share point.
    const geometry = buildings.features.find((building) => String(building.properties.osmId) === String(properties.osmId))?.geometry ?? feature.geometry;
    const flat = properties.campus || (lens.mode === 'height' && properties.heightSource === 'estimate');
    onBuildingClick({
      properties,
      outline: { type: 'Feature', properties: { height: properties.tower ? towerHeight : flat ? 0 : properties.height, base: flat ? 0 : properties.base }, geometry },
      ...anchorPoint(geometry),
    });
    const [lng, lat] = geometryPoint(geometry);
    selection = { osmId: buildingId(properties.osmId), lat, lng };
    writeHash();
  }
  map.on('click', (event) => {
    if (event.originalEvent.target.closest('.maplibregl-popup')) return;
    const pois = poiAt(event.point);
    if (pois.length) return onPoiClick(pois[0].properties.id);
    const building = buildingAt(event.point);
    if (building) selectFeature(building);
  });
  // A link or a search result has no pointer to pick with, so the block's stored interior point is projected into the
  // settled frame and picked the way a click picks it. Re-tiling after a long camera jump lands a frame or two after
  // moveend, so a miss is retried. Tiles that are still arriving do not spend the retry budget: on a cold load they can
  // take longer than the whole budget, and a block is only declared absent once picks have failed on a ready map.
  function focusPick() {
    const { osmId, lng, lat } = focus;
    const point = map.project([lng, lat]);
    const canvas = map.getCanvas();
    if (point.x < 0 || point.y < 0 || point.x > canvas.clientWidth || point.y > canvas.clientHeight) return null;
    return map.queryRenderedFeatures(box(point, 2), { layers: extrusions }).find((candidate) => String(candidate.properties.osmId) === String(osmId)) ?? null;
  }
  function focusStep() {
    if (!focus) return;
    clearTimeout(focus.timer);
    const ready = !map.isMoving() && map.isSourceLoaded('canton-buildings');
    if (ready) {
      const hit = focusPick();
      if (hit) { focus = null; selectFeature(hit); return; }
      if (++focus.tries > 24) { focus = null; writeHash(); return; }
    }
    focus.timer = setTimeout(focusStep, 250);
  }
  const cancelFocus = () => { clearTimeout(focus?.timer); focus = null; };
  function focusBuilding(block) {
    cancelFocus();
    manualInteraction();
    resetLens();
    focus = { ...block, tries: 0 };
    // An instant easeTo can complete selection synchronously in moveend.
    focus.timer = setTimeout(focusStep, 900);
    map.easeTo({ center: [block.lng, block.lat], zoom: Math.max(map.getZoom(), 15.4), padding: padding(), duration: reducedMotion.matches ? 0 : 800 });
  }
  // One hit-test per animation frame rather than per mousemove: the three extrusion layers cost 0.73 ms on average and
  // 2.5 ms worst case, but a trackpad fires far more moves per second than frames, so the queue is collapsed here.
  let hoverPoint, hoverFrame;
  function hoverCursor() {
    hoverFrame = undefined;
    map.getCanvas().style.cursor = poiAt(hoverPoint).length || buildingAt(hoverPoint) ? 'pointer' : 'grab';
  }
  map.on('mousemove', (event) => {
    if (map.isMoving()) return;
    hoverPoint = event.point;
    hoverFrame ??= requestAnimationFrame(hoverCursor);
  });
  // Both verdicts below were measured against the frame they were computed in: after the camera settles under a
  // stationary pointer, or re-sits an open card, they have to be taken again.
  map.on('moveend', () => {
    syncPill();
    writeHash();
    if (focus) focusStep();
    if (hoverPoint) hoverFrame ??= requestAnimationFrame(hoverCursor);
  });
  for (const event of ['movestart', 'dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) map.on(event, (data) => { if (data.originalEvent) manualInteraction(); });
  document.addEventListener('visibilitychange', visibilityChange);
  reducedMotion.addEventListener('change', manualInteraction);
  window.addEventListener('resize', resize);
  map.on('remove', () => {
    tour.exit();
    stopOrbit();
    cancelAnimationFrame(hoverFrame);
    clearTimeout(focus?.timer);
    document.removeEventListener('visibilitychange', visibilityChange);
    reducedMotion.removeEventListener('change', manualInteraction);
    window.removeEventListener('resize', resize);
    map.getCanvas().removeEventListener('wheel', manualInteraction);
    map.getCanvas().removeEventListener('pointerdown', manualInteraction);
    canvas.removeEventListener('mousedown', altRotateDown, { capture: true });
    altRotateUp();
  });
  // The constructor ignores a camera outside the scene, but the address bar keeps whatever was typed, so a rejected
  // link would survive there and be copied onward by the next person to share the page. One write makes the bar
  // describe the camera actually on screen; a link's own block is re-added below once it is picked.
  writeHash();
  // A shared link's card is opened the same way a click would open it, once the tiles under the shared camera are in.
  if (shared.selection) {
    focus = { ...shared.selection, tries: 0 };
    focusStep();
  }
  return {
    map,
    setAtmosphere,
    setLens,
    get lens() { return { ...lens }; },
    buildingSummary: (category = 'all') => heightSummary(buildings.features, category),
    tour,
    startTour() { stopOrbit(); cancelFocus(); popup?.remove(); resetLens(); tour.start(!reducedMotion.matches); },
    setPanelOpen(open) { panelOpen = open; popup?.remove(); manualInteraction(); map.setLayoutProperty('poi-markers', 'visibility', open ? 'visible' : 'none'); map.easeTo({ padding: padding(), duration: reducedMotion.matches ? 0 : 400 }); },
    setPois(pois, category = 'all') {
      poiFeatures = pois; activeFilter = category;
      if (popup && !pois.some((poi) => poi.id === selectedPoiId && (category === 'all' || poi.category === category))) popup.remove();
      map.getSource('neighborhood-pois').setData(poisGeoJSON(pois));
      map.setFilter('poi-markers', category === 'all' ? null : ['==', ['get', 'category'], category]);
    },
    showPoi(poi, content) {
      if (!poiFeatures.some((item) => item.id === poi.id) || (activeFilter !== 'all' && activeFilter !== poi.category)) return;
      manualInteraction(); selectedPoiId = poi.id;
      openPopup([{ lngLat: [poi.lng, poi.lat], anchor: undefined }], content, { closeLabel: '关闭地点卡片' });
      if (school) map.getSource('walking-route').setData(featureCollection(poi.walkingRoute ? [{ type: 'Feature', properties: {}, geometry: poi.walkingRoute }] : []));
      map.easeTo({ center: [poi.lng, poi.lat], padding: padding(), duration: reducedMotion.matches ? 0 : 700 });
    },
    showBuilding(building, content) {
      manualInteraction();
      const blockId = buildingId(building.properties.osmId) || undefined;
      openPopup(buildingSeats(building.outline.geometry, building.lngLat, blockId), content, {
        outline: building.outline,
        closeLabel: '关闭建筑卡片',
        blockId,
      });
    },
    focusBuilding,
    startOrbit() {
      tour.exit(); stopOrbit(); popup?.remove(); map.stop(); cancelFocus();
      map.jumpTo({ center, zoom: school ? (landscape() ? SCENE.camera.landscapeZoom : SCENE.camera.mobileZoom) : landscape() ? Math.max(14, Math.min(map.getZoom(), 14.4)) : Math.max(14.6, Math.min(map.getZoom(), 15.7)), pitch: 58, padding: padding() });
      orbiting = true; frame = requestAnimationFrame(animate);
    },
    stopOrbit,
    hasCard: () => Boolean(popup),
    closeCard() { popup?.remove(); },
    recenter() { tour.exit(); stopOrbit(); cancelFocus(); popup?.remove(); map.flyTo({ ...heroCamera(), duration: reducedMotion.matches ? 0 : 1200 }); },
    overview() {
      tour.exit(); stopOrbit(); cancelFocus(); popup?.remove();
      const points = circle.geometry.coordinates[0];
      const bounds = points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
      // fitBounds adds its own padding to the current transform padding.
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      const overviewPadding = lens.mode === 'height' ? lensPadding() : landscape()
        ? { top: 75, bottom: 90, left: panelOpen ? 20 : 230, right: panelOpen ? 330 : 25 }
        : mobile() ? { top: 265, bottom: panelOpen ? Math.round(innerHeight * 0.38 + 70) : 180, left: 35, right: 35 } : { top: 110, bottom: 135, left: 310, right: panelOpen ? 370 : 100 };
      map.fitBounds(bounds, { padding: overviewPadding, pitch: 0, bearing: 0, duration: reducedMotion.matches ? 0 : 1400 });
    },
  };
}

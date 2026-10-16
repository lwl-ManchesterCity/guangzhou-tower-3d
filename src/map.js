import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { DEFAULT_BUILDING_HEIGHT, DEFAULT_CENTER, MAP_STYLE_URL, POI_CATEGORIES, RADIUS_METERS, SCENE, TOWER_OSM_ID, VIEW_LIMITS } from './config.js';
import { ATMOSPHERES, ATMOSPHERE_MS, HAZE_REVEAL, MOOD, PATTERN_SWAP_MS, SKY_BLEND, baseAtmospherePaint, buildingAtmosphereColor, contextAtmosphereColor, mixPreset, themeBlend, themeResume } from './atmosphere.js';
import { featureCollection, radiusPolygon } from './geo.js';
import { insideRing, interiorPoint } from './buildings.js';
import { formatView, parseView } from './link.js';
import { isLandscapeViewport, isMobileViewport, viewportPadding } from './padding.js';
import { mapIcon } from './icons.js';
import { poisGeoJSON } from './pois.js';
import { TOWER_MODES, createTowerLayer, towerBreath, towerHue } from './tower.js';
import { createTour, TOUR_STOPS } from './tour.js';
import { heightColor, heightSummary, lensFilter, UNKNOWN_HEIGHT_COLOR } from './lens.js';
import { schematicDisplayHeights } from './block-layout.js';
import { FACADE_SHAPES, FACADE_THEMES, GLOW_IMAGE_PREFIX, GLOW_NEAR_IMAGE_PREFIX, LAMP_ALT_IMAGE_PREFIX, LAMP_NEAR_ALT_IMAGE_PREFIX, LAMP_GROUPS, LAMP_KEYS, LAMP_PERIODS_MS, LIGHT_BANDS, LIGHT_FADES, LIGHT_IMAGE_PREFIX, LIGHT_NEAR_IMAGE_PREFIX, LIGHT_NEAR_ZOOM, LIGHT_TEMPERATURES, WINDOWS_OFF_IMAGE, facadeImage, facadeOptions, facadePattern, facadeTexture, glowTexture, lampBreather, lampDarkness, lampTemperatureDeal, lampWeight, lightTexture, lampBandExpression, windowsOffTile } from './facade.js';
import { WATER_IMAGE_PREFIX, WATER_THEMES, riverOpacityExpression, scrollWater, waterTexture } from './water.js';
import { BRIDGE_DECK, BRIDGE_PARAPET, BRIDGE_SOURCE, bridgeLayers } from './bridges.js';
import { MARCH_PHASES, TRAFFIC_BAND, TRAFFIC_FLOW, TRAFFIC_STEP_MS, TRAFFIC_TAIL, marchPair, trafficLayers } from './traffic.js';
import { deckHeights, trafficSprite } from './traffic-life.js';
import { createNearField } from './near-field.js';
import { createBaseBands } from './shadow-pads.js';
import { TREE_MIN_ZOOM, VEGETATION_RADIUS, createVegetation } from './vegetation.js';
import { PLAZA_LAWN, PLAZA_POOL, PLAZA_SOURCE, PLAZA_STONE, PLAZA_WALK, carvePlaza, plazaLayers, stoneRings } from './plaza.js';
import { plazaSurface, plazaSurfaceMesh } from './plaza-surface.js';
import { LANDMARKS, approachCamera, declutter, landmarkFacts } from './landmarks.js';
import { GLYPH_BOX, LANDMARK_GLYPHS } from './landmark-glyphs.js';
import { FORM_OSM_IDS, createLandmarkForms } from './landmark-forms.js';

maplibregl.setWorkerUrl(workerUrl);
const center = [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat];
const distance = ['distance', { type: 'Point', coordinates: center }];
// Plain OSM way ids stay numbers; a namespaced id (relation/…) is only meaningful as text, and the card seat hit-test
// compares it with String(), so keeping the string is what lets a relation avoid covering itself.
const buildingId = (id) => (id === undefined || id === null ? id : /^\d+$/.test(String(id)) ? Number(id) : String(id));

// 只认 Polygon 的取点：数据准备与可步行图留在 Node 那侧，不进客户端这一份。
// 眼下的建筑快照全是 Polygon，而空洞必须参与—— unnamed、没进索引的 relation 也一样要把点落在肉上。
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

// 底图里这三族线图层在三维视角下是"画在面上的东西"：隧道线（路/铁在地下，虚线却压在草坪与江面上）、
// 行政边界（现实里没有线，跨江那一段在画面里就是一道划痕）、水系中心线（我们自己画了水面，中心线叠上去
// 像江上裂了几条缝）。用户 2026-10-09 说「别的地方也是，优化一下」，量到的正是这三族：机位 15.5 级扫一遍，
// 压在开阔水面上的采样点里 `tunnel_transit_rail_hatching` 198 次、`waterway_river` 178 次、`boundary_3` 134 次。
// 水系的名字留着（`waterway_line_label` 那一层是"珠江"三个字，不是线）。
const SUBSURFACE_LINES = /^(tunnel_|boundary_(2|3|disputed)$|waterway_(river|other|tunnel)$)/;

function neighborhoodStyle(style) {
  style.projection = { type: 'mercator' };
  style.layers = style.layers.filter((layer) => layer.type !== 'fill-extrusion' && !['poi', 'housenumber'].includes(layer['source-layer']) && !layer.id.includes('shield')
    && !(layer.type === 'line' && SUBSURFACE_LINES.test(layer.id)));
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

export async function createNeighborhoodMap({ onPoiClick, onBuildingClick, onInteraction, onTourChange, onLensChange, onMotionChange, onError }) {
  const [response, buildingsResponse, bridgeResponse, crossingsResponse, riverResponse, streetsResponse, greensResponse, blocksResponse, waterResponse] = await Promise.all([
    fetch(MAP_STYLE_URL, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/${SCENE.buildings}`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/haixin-bridge.geojson`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/canton-bridges.geojson`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/canton-river.geojson`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/canton-streets.geojson`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/canton-greens.geojson`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/canton-blocks.geojson`, { signal: AbortSignal.timeout(25000) }),
    fetch(`${import.meta.env.BASE_URL}data/canton-water.geojson`, { signal: AbortSignal.timeout(25000) }),
  ]);
  if (!response.ok) throw new Error(`底图服务不可用（HTTP ${response.status}），请检查网络后重试。`);
  if (!buildingsResponse.ok) throw new Error(`建筑快照未能加载（HTTP ${buildingsResponse.status}），请重新加载。`);
  if (!bridgeResponse.ok) throw new Error(`海心桥轮廓未能加载（HTTP ${bridgeResponse.status}），请重新加载。`);
  if (!crossingsResponse.ok) throw new Error(`跨江桥面快照未能加载（HTTP ${crossingsResponse.status}），请重新加载。`);
  if (!riverResponse.ok) throw new Error(`珠江中心线快照未能加载（HTTP ${riverResponse.status}），请重新加载。`);
  if (!streetsResponse.ok) throw new Error(`近场路网快照未能加载（HTTP ${streetsResponse.status}），请重新加载。`);
  if (!greensResponse.ok) throw new Error(`近场绿地快照未能加载（HTTP ${greensResponse.status}），请重新加载。`);
  if (!blocksResponse.ok) throw new Error(`近场街坊面快照未能加载（HTTP ${blocksResponse.status}），请重新加载。`);
  if (!waterResponse.ok) throw new Error(`近场水面快照未能加载（HTTP ${waterResponse.status}），请重新加载。`);
  const buildings = await buildingsResponse.json();
  const bridge = (await bridgeResponse.json()).features;
  const crossings = await crossingsResponse.json();
  const river = (await riverResponse.json()).features;
  const streets = (await streetsResponse.json()).features;
  const greens = (await greensResponse.json()).features;
  const blocks = (await blocksResponse.json()).features;
  const waterFaces = (await waterResponse.json()).features;
  const style = neighborhoodStyle(await response.json());
  const mobile = isMobileViewport;
  const landscape = isLandscapeViewport;
  let panelOpen = false;
  const padding = () => viewportPadding(panelOpen);
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
  // The clock of an atmosphere walk in progress: which theme the picture on screen came from, which one it was heading
  // for, how far it had got, and whether the patterns had been swapped yet.
  let moodRun;
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
  const circle = radiusPolygon(DEFAULT_CENTER, RADIUS_METERS);
  map.addSource('neighborhood-radius', { type: 'geojson', data: circle });
  map.addLayer({ id: 'radius-line', type: 'line', source: 'neighborhood-radius', paint: { 'line-color': '#52838a', 'line-width': 1.2, 'line-dasharray': [4, 4], 'line-opacity': 0.65 } });
  map.addLayer({
    id: 'context-buildings', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    filter: ['all', ['!=', ['get', 'hide_3d'], true], ['>', distance, RADIUS_METERS]],
    paint: { 'fill-extrusion-color': contextAtmosphereColor(ATMOSPHERES.day, center), 'fill-extrusion-height': ['to-number', ['get', 'render_height'], DEFAULT_BUILDING_HEIGHT], 'fill-extrusion-base': ['to-number', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.4, 'fill-extrusion-vertical-gradient': true },
  });
  // 这一侧大部分轮廓根本没有高度，全画成同一块 9.6 m 平板就读不出街区的形状，所以按自己那条短边补一层示意厚度。
  // 带标注的与按层数现算的高度一字不动。
  buildings.features = schematicDisplayHeights(buildings.features, { center: DEFAULT_CENTER });
  map.addSource('canton-buildings', {
    type: 'geojson', data: buildings, maxzoom: 16, tolerance: 0.4,
    attribution: '© OpenStreetMap contributors · 建筑与跨江桥快照 / ODbL',
  });
  map.addLayer({ id: 'height-unknown', type: 'fill', source: 'canton-buildings', layout: { visibility: 'none' }, filter: lensFilter('all', 'estimate'), paint: { 'fill-color': UNKNOWN_HEIGHT_COLOR, 'fill-opacity': 0.65, 'fill-outline-color': '#66777c' } });
  const paint = {
    'fill-extrusion-color': buildingAtmosphereColor(ATMOSPHERES.day),
    // Only the height-less placeholders carry a display height, so a missing field falls back to the source number
    // rather than to a second copy of an invented one.
    'fill-extrusion-height': ['coalesce', ['get', 'displayHeight'], ['get', 'height']], 'fill-extrusion-base': ['get', 'base'],
    'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': true,
  };
  const overviewFilter = ['any', ['>=', ['get', 'height'], 25], ['>=', ['get', 'area'], 1200]];
  // Two of the landmarks are tall enough that a box on their footprint reads as the wrong building, so they are lifted
  // out of every extrusion this scene draws and stood as shells in the tower's own layer instead. Negating `in` with
  // `!` rather than spelling it `!in`: the expression form is what the validator knows, and a filter it does not
  // recognise drops the whole layer as an `error` event - no throw, nothing in the console.
  const formFilter = ['!', ['in', ['get', 'osmId'], ['literal', FORM_OSM_IDS]]];
  // The night lamps are four layers rather than one: two groups of blocks, split by their own OSM id, each cross-fading
  // between two picks of the same band's cells. The shipped pick keeps the layer this scene has always had - same id,
  // same tile family - so everything that reads `building-lights` still reads it. See LAMP_GROUPS in facade.js for why
  // a cross-fade on opacity is the only motion this layer can make at all.
  const lampLayers = [
    { id: 'building-lights', group: 0, pick: 0 },
    { id: 'building-lights-alt', group: 0, pick: 1 },
    { id: 'building-lights-2', group: 1, pick: 0 },
    { id: 'building-lights-2-alt', group: 1, pick: 1 },
  ];
  const lampGroup = (group) => ['==', ['%', ['to-number', ['get', 'osmId'], 0], LAMP_GROUPS], group];
  const lampBreath = lampBreather();
  // `setFilter` replaces rather than merges, so every time the lens hands a base filter back the group clause has to
  // ride along with it - otherwise half the city's lamps end up drawn over the other half's group. The spill has no
  // group of its own except on the two layers that carry the breathing minority, whose halo has to go out with the
  // windows it spills from.
  const lampFilter = (layer, base) => {
    const gates = [base];
    if (layer.group !== null) gates.push(lampGroup(layer.group));
    if (layer.breath === true) gates.push(lampBreath);
    else if (layer.breath === false) gates.push(['!', lampBreath]);
    return ['all', ...gates];
  };
  const glowLayers = [
    { id: 'building-glow', group: null, breath: false },
    { id: 'building-glow-breath-0', group: 0, breath: true },
    { id: 'building-glow-breath-1', group: 1, breath: true },
  ];
  const lampGates = [...lampLayers, ...glowLayers];
  map.addLayer({ id: 'neighborhood-buildings-overview', type: 'fill-extrusion', source: 'canton-buildings', maxzoom: 14, filter: ['all', overviewFilter, formFilter], paint });
  map.addLayer({ id: 'neighborhood-buildings', type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14, filter: formFilter, paint });
  map.addLayer({ id: 'height-estimates', type: 'fill-extrusion', source: 'canton-buildings', layout: { visibility: 'none' }, filter: lensFilter('all', 'levels'), paint: { ...paint, 'fill-extrusion-color': heightColor(), 'fill-extrusion-opacity': 0.55 } });
  // The river is one flat fill from the basemap, so its surface gets the same treatment as the walls: a translucent
  // overlay that carries only alpha, since `fill-pattern` also ignores `fill-color` on a fill layer and the per-atmosphere
  // water colour has to keep coming from the layer underneath. It is pinned directly above that fill and below whatever
  // the style draws next, because a sheen laid over a bridge deck or a bank label is a painting error, not a texture.
  // The pristine tiles are kept because motion redraws the live one: every frame is scrolled from these pixels, never
  // from whatever the image currently holds, so a long-running loop cannot walk the crests out of their bands.
  // 广场那四层与水面那几层要一起进氛围切换，所以先占住这两个名字，真正的值在下面才建出来。
  let plaza = null;
  // 广场地面那张不重复的米数贴图铺出来的网格，与广场同进同退。
  let plazaGround = null;
  let plazaSurfaceState = null;
  const riverTiles = {};
  for (const [id, options] of Object.entries(WATER_THEMES)) {
    riverTiles[id] = waterTexture(options);
    map.addImage(`${WATER_IMAGE_PREFIX}-${id}`, riverTiles[id]);
  }
  const water = style.layers.findIndex((layer) => layer.type === 'fill' && layer['source-layer'] === 'water');
  map.addLayer({
    id: 'river-surface', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
    paint: {
      'fill-pattern': `${WATER_IMAGE_PREFIX}-day`,
      'fill-opacity': riverOpacityExpression(),
    },
  }, water < 0 ? undefined : style.layers[water + 1]?.id);
  // Traffic light sits above every road the basemap draws and below the volumes, so a ribbon runs along the street
  // rather than across the roofs. Both layers ship dark: the night theme is what turns them on.
  const road = style.layers.reduce((last, layer, index) => (layer.type === 'line' && layer['source-layer'] === 'transportation' ? index : last), -1);
  for (const layer of trafficLayers()) map.addLayer(layer, road < 0 ? undefined : style.layers[road + 1]?.id);
  // The river crossings, as decks. They go in above the traffic ribbons and below the volumes, so a bridge carries
  // the road it is the road over, and an office tower two hundred metres nearer still stands in front of it.
  // No attribution of its own: the credit is OSM and ODbL, which the buildings source line already carries, and a
  // second clause there pushed the collapsed credits tall enough to sit under the phone sheet.
  map.addSource(BRIDGE_SOURCE, { type: 'geojson', data: crossings, maxzoom: 16, tolerance: 0.4 });
  for (const layer of bridgeLayers(ATMOSPHERES.day)) map.addLayer(layer, 'neighborhood-buildings');
  // 花城广场的中轴。四层都从实测面来（草坪、水面、`pedestrian` 硬质面），只有步行带是沿实测线扫出来的，
  // 宽度是画的常数。它排在桥面之后、体块之前：广场是地面，桥跨在它北边的水上，楼站在它上面。
  plaza = carvePlaza({ greens, water: waterFaces, blocks, streets });
  map.addSource(PLAZA_SOURCE, { type: 'geojson', data: featureCollection(plaza.features), maxzoom: 17, tolerance: 0.25 });
  for (const layer of plazaLayers(ATMOSPHERES.day)) map.addLayer(layer, 'neighborhood-buildings');
  // 四层是颜色，这一格是"建出来的边"：石材的分格缝、草坪与石板之间那道收边、快绿湖的水线，全按广场自己的米数
  // 画在一张不重复的乘性贴图上，乘在四层之上。它站在塔的米制坐标里，所以走的是同一块 three.js 场景。
  if (plaza.ring) {
    const surface = plazaSurface({ ring: plaza.ring, features: plaza.features, origin: DEFAULT_CENTER });
    plazaGround = plazaSurfaceMesh(surface);
    plazaSurfaceState = { wide: surface.wide, tall: surface.tall, counts: surface.counts, metres: surface.metres };
  }
  // The pattern shader ignores `fill-extrusion-color`, so the window grid is a coplanar translucent overlay rather than a
  // paint on the coloured volumes: it passes the depth test those walls already write, and the category colour and the
  // distance fade keep coming from the layer underneath. It shadows `neighborhood-buildings` filter for filter so a grid
  // never hangs in the air over a block the current lens hides, and it stays off in the height lens, where the colour is
  // the data. The grid is procedural and no band is finer than the ~7 m the hero camera can still resolve, so it reads as
  // facade rhythm, never as real floors; which rhythm a block wears is read from its own `category`.
  // One transparent tile for the blocks the id dice left dark, shared by both window layers and by the night grid as
  // well: a building that burns nothing cannot keep the grid's own 16 % of lit panes either.
  map.addImage(WINDOWS_OFF_IMAGE, windowsOffTile());
  for (const atmosphere of Object.keys(FACADE_THEMES)) for (const shape of Object.keys(FACADE_SHAPES)) {
    map.addImage(facadeImage(atmosphere, shape), facadeTexture(facadeOptions(atmosphere, shape)));
  }
  map.addLayer({
    id: 'building-facade', type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14, filter: formFilter,
    paint: {
      'fill-extrusion-pattern': facadePattern('day'),
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.42, 16.5, 0.6, 18, 0.72],
      'fill-extrusion-height': ['coalesce', ['get', 'displayHeight'], ['get', 'height']],
      'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-vertical-gradient': true,
    },
  }, 'height-estimates');
  // Night lamps are coplanar overlays rather than a brighter colour in the grid above: an overlay can be almost opaque
  // where a window is and still leave the rest of the wall transparent, so the category colour and the distance fade of
  // the layer underneath keep coming through. How many windows a block lights is read from its own displayed height,
  // what colour they burn from its own OSM id and how brightly from its own distance, so no lamp is hand-placed and a
  // reload cannot reshuffle the skyline.
  // `fill-extrusion-vertical-gradient` stays off so a ground-floor window is not darker than a top-floor one, and the
  // pattern necessarily paints the top face too, so a low block shows lamps on its roof as well - accepted rather than
  // hidden, since masking the roof would mean drawing a second geometry. Turned on by the night atmosphere only, and it
  // shadows `building-facade`'s filter so a lamp never hangs in the air over a block the current lens hides.
  const wallHeight = ['coalesce', ['get', 'displayHeight'], ['get', 'height']];
  // The band is stepped on the same expression the extrusion height uses, so a block can never be drawn at one height
  // and dressed for another. Band x temperature x ring names one tile, i.e. twenty-seven per family.
  const lampBand = lampBandExpression(wallHeight);
  // Distance is a tile axis rather than an opacity one because `fill-extrusion-opacity` is not data-driven: the moment
  // MapLibre's style validator sees `['get', ...]` in it, the whole layer is dropped - as an `error` event, not a
  // throw, so the map simply renders without lamps. Without the ring a block 2.9 km away burns as brightly as one 300 m
  // off, and 1,441 of the 1,816 blocks on screen at the hero camera are past 1.5 km, which is most of what made the
  // first night frame read as an even sprinkle instead of a skyline with depth.
  const lampRing = ['step', ['get', 'distance'], 0, ...LIGHT_FADES.slice(0, -1).flatMap((ring, index) => [ring.below, index + 1])];
  // The colour temperature is dealt out by the block's own id too, but no longer three ways: `osmId % 3` gave a third
  // of the city the blue-white of an office slab, which is the "全白" the brief is about. Ten buckets, four amber, four
  // warm white, two cool - 80% warm, 20% cool - and the dark slice below is dealt from a *different* modulus, so
  // switching buildings off cannot thin the colour distribution with it.
  const lampTemperature = lampTemperatureDeal();
  const lampDark = lampDarkness();
  const lampTile = (prefix) => ['concat', prefix, '-', lampBand, '-', lampTemperature, '-', lampRing];    // The pane pitch is a tile axis as well: the shipped grid is 7.3 m per cell because that is the finest pitch the
  // hero camera (zoom 15.5 / pitch 62, ~1.6 m per screen pixel on a wall face) still resolves as a window, and V7
  // asks for half of it. Halving it everywhere put the hero camera's windows below that floor - measured 154 lit
  // pixels against 641 on the same wall - so the 3.7 m grid is a second family that takes over where it resolves.
  // `['zoom']` stays the outermost input of the top-level step: nested, the whole property is silently refused.
  // `dark` is the set of blocks that gets no tile at all: the 1/11 that burns nothing, plus - on the alternate pick
  // only - the 1/17 that breathes a whole facade instead of a cell or two.
  const lampImage = (prefix, nearPrefix, dark = lampDark) => ['step', ['zoom'],
    ['case', dark, WINDOWS_OFF_IMAGE, lampTile(prefix)], LIGHT_NEAR_ZOOM,
    ['case', dark, WINDOWS_OFF_IMAGE, lampTile(nearPrefix)]];
  // 本组那一枚出厂档的表达式写法（注意它与 `src/facade.js` 那个算数值的 `lampWeight` 同名不同物，这里叫
  // `lampState`）。`['zoom']` has to stay
  // the input of the outermost interpolate - nested inside a `['*']` the whole property is silently refused - so the
  // global state rides inside each stop, which is also how the day/sunset/night blend walks these same numbers.
  const lampState = (group) => ['global-state', LAMP_KEYS[group]];
  const lampAlpha = (layer) => layer.pick === 0
    ? lampState(layer.group) : ['-', 1, lampState(layer.group)];
  const lampOpacity = (layer) => ['interpolate', ['linear'], ['zoom'],
    14, 0, 15, ['*', 0.62, lampAlpha(layer)], 16.5, ['*', 0.72, lampAlpha(layer)], 18, ['*', 0.8, lampAlpha(layer)]];
  // The spill's own ramp. `weight` is null for the majority, whose halo is spill and not a window and so never moves;
  // the breathing minority gets its group's weight, so the wash on its wall goes out with the windows that made it
  // instead of floating on a dark building. At weight 1 the multiplier is exactly 1 - the shipped frame is unchanged.
  const glowOpacity = (weight) => ['interpolate', ['linear'], ['zoom'], 14, 0,
    15, weight ? ['*', 0.44, weight] : 0.44,
    16.5, weight ? ['*', 0.56, weight] : 0.56,
    18, weight ? ['*', 0.66, weight] : 0.66];
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    for (let temperature = 0; temperature < LIGHT_TEMPERATURES.length; temperature++) {
      for (let ring = 0; ring < LIGHT_FADES.length; ring++) {
        map.addImage(`${LIGHT_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring));
        map.addImage(`${LAMP_ALT_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring, 1));
        map.addImage(`${GLOW_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, glowTexture(band, temperature, ring));
        map.addImage(`${LIGHT_NEAR_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring, 0, true));
        map.addImage(`${LAMP_NEAR_ALT_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring, 1, true));
        map.addImage(`${GLOW_NEAR_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, glowTexture(band, temperature, ring, true));
      }
    }
  }
  for (const layer of lampLayers) {
    map.addLayer({
      id: layer.id, type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14, filter: lampFilter(layer, formFilter),
      layout: { visibility: 'none' },
      paint: {
        // On the alternate hand, the breathing minority is handed the all-dark tile: as its group's weight walks from
        // 1 to 0 the whole facade goes out with it, while every other block just turns a cell or two over. Opacity
        // cannot carry that per-block rule - `['get']` in `fill-extrusion-opacity` drops the layer - so the dice is
        // read here, where a data-driven pattern is what the layer already runs on.
        'fill-extrusion-pattern': lampImage(layer.pick ? LAMP_ALT_IMAGE_PREFIX : LIGHT_IMAGE_PREFIX,
          layer.pick ? LAMP_NEAR_ALT_IMAGE_PREFIX : LIGHT_NEAR_IMAGE_PREFIX,
          layer.pick ? ['any', lampDark, lampBreath] : lampDark),
        'fill-extrusion-opacity': lampOpacity(layer),
        'fill-extrusion-height': wallHeight,
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-vertical-gradient': false,
      },
    }, 'height-estimates');
  }
  // Spill goes under the lamps it belongs to: the hard-edged tile draws over its own halo, so a window keeps an edge
  // while the wall around it picks up the light. Same geometry, same band, same gates - and it has to be inserted by
  // id, since the lamps already exist at this point. It stays on the shipped pick: a halo is spill, not a window, and
  // the two picks' halos differ only in which cells they smear. The breathing minority is the exception, and it is
  // its own two layers rather than a per-block opacity (which `fill-extrusion-opacity` cannot carry): a building
  // whose windows are going out cannot keep the wash they cast.
  let under = lampLayers[0].id;
  for (const layer of glowLayers) {
    map.addLayer({
      id: layer.id, type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14,
      filter: lampFilter(layer, formFilter),
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-pattern': lampImage(GLOW_IMAGE_PREFIX, GLOW_NEAR_IMAGE_PREFIX),
        'fill-extrusion-opacity': glowOpacity(layer.group === null ? null : lampState(layer.group)),
        'fill-extrusion-height': wallHeight,
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-vertical-gradient': false,
      },
    }, under);
    under = layer.id;
  }
  applyLight();
  map.setSky({ ...ATMOSPHERES.day.sky, ...SKY_BLEND });
  // `setGlobalState` reads the stylesheet form (`{ key: { default } }`); the single-key setter is the one that takes a
  // value, and it early-returns when nothing changed, so a rAF loop can call it every frame for free.
  map.setGlobalStateProperty(HAZE_REVEAL, 1);
  // The walk's number has to exist before any expression reads it: an undeclared global state resolves to null, and
  // MapLibre then falls every colour back to `rgba(0,0,0,1)` for that frame - a black flash, which is the one thing a
  // transition is supposed to remove.
  map.setGlobalStateProperty(MOOD, 0);
  // The two lamp groups' cross-fade weights ride the same channel, and both start where the scene shipped: each group's
  // shipped pick full and its alternate pick at none - the same pair of numbers a page with no motion at all draws.
  map.setGlobalStateProperty(LAMP_KEYS[0], 1);
  map.setGlobalStateProperty(LAMP_KEYS[1], 1);
  const landmarkForms = createLandmarkForms({ features: [...buildings.features, ...bridge], origin: DEFAULT_CENTER });
  // The near-field traffic needs the street snapshot before the scene can be dressed, and it joins the tower's scene
  // rather than the style: a car sits at a height in metres above a road in metres, which is the frame this layer owns
  // and not the one a paint property can reach.
  // 车的高度还有一项来自桥：`crossings` 里那些 `part === 'deck'` 的件就是上面那两层挤出体的顶，
  // 挂在同一条 way 上的车要站到它上面去，否则画面里就是"桥在江上、车在江里"。
  // 江上的船与车流是同一类客人，所以和引擎那侧共用 `createNearField` 一份装配：这里只交代"哪几份快照喂进来的"。
  const nearField = createNearField({
    streets, river, shore: waterFaces, origin: DEFAULT_CENTER,
    sprite: trafficSprite(), decks: deckHeights(crossings.features),
  });
  // 树站在车流旁边：同一份路网、同一个一公里、同一套米制坐标，所以它也跟着塔那层一起画。
  // 石材面（含扫出来的步行带）是"这里不该有树"的名单——一棵榕树长在石板中轴上是错的。
  // 水面与楼块是同一张名单的第二批：用户 2026-10-09 的截图里树在江里成排、在屋顶上冒尖，就是这两格没让位。
  const greenery = createVegetation({
    streets, greens, origin: DEFAULT_CENTER, radius: VEGETATION_RADIUS,
    avoid: stoneRings(plaza), water: waterFaces, buildings: buildings.features,
  });
  // 楼根那一圈接地带：轮廓是实测的（OSM 那份晋升后的快照），宽度与深浅是画的。
  // 它跟着楼走：透视镜一开、或按类别筛的时候一起没——合并成一份几何就没有"逐栋筛"这一说，
  // 这是这一块的边界，写在 `shadow-pads.js` 的注释里，也记在 README。
  const bases = createBaseBands({ features: buildings.features, origin: DEFAULT_CENTER });
  const towerLayer = createTowerLayer(landmarkForms, nearField, river, greenery, plazaGround, bases);
  const towerHeight = 450;
  map.addLayer(towerLayer);
  map.addSource('canton-tower', { type: 'geojson', data: `${import.meta.env.BASE_URL}data/canton-tower.geojson` });
  map.addLayer({ id: 'canton-tower-hit', type: 'fill-extrusion', source: 'canton-tower', paint: { 'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': towerHeight, 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0 } });
  // The two shells are not clickable - a custom layer has no features to hit - and their extrusions are filtered out
  // wherever a shell stands, so the footprint goes back in as an invisible box at the same measured height. It is the
  // snapshot's own feature, properties and all, which is what keeps the card, the deep link and the 600 m claim
  // reading from the same record the box used to.
  map.addSource('landmark-forms-hit', { type: 'geojson', data: featureCollection(landmarkForms.forms.filter((form) => form.hit).map((form) => form.feature)) });
  map.addLayer({
    id: 'landmark-forms-hit', type: 'fill-extrusion', source: 'landmark-forms-hit',
    paint: {
      'fill-extrusion-color': '#ffffff', 'fill-extrusion-height': ['coalesce', ['get', 'displayHeight'], ['get', 'height']],
      'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-opacity': 0,
    },
  });
  map.addSource('building-selection', { type: 'geojson', data: featureCollection() });
  map.addLayer({
    id: 'building-selection', type: 'fill-extrusion', source: 'building-selection',
    paint: { 'fill-extrusion-color': '#1f4e5f', 'fill-extrusion-height': ['to-number', ['get', 'height'], 0], 'fill-extrusion-base': ['to-number', ['get', 'base'], 0], 'fill-extrusion-opacity': 0.35 },
  });
  map.addLayer({ id: 'building-selection-flat', type: 'fill', source: 'building-selection', filter: ['==', ['get', 'height'], 0], paint: { 'fill-color': ATMOSPHERES.day.selection, 'fill-opacity': 0.5 } });
  map.addSource('tower-label', { type: 'geojson', data: featureCollection([{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: center } }]) });
  map.addLayer({ id: 'tower-label', type: 'symbol', source: 'tower-label', layout: { 'text-field': SCENE.name, 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [2, 0], 'text-anchor': 'left', 'text-allow-overlap': true }, paint: { 'text-color': '#365f66', 'text-halo-color': '#f5f8f2', 'text-halo-width': 2 } });
  for (const [key, category] of Object.entries(POI_CATEGORIES)) map.addImage(`poi-${key}`, await mapIcon(category), { pixelRatio: 2 });
  map.addSource('neighborhood-pois', { type: 'geojson', data: featureCollection() });
  map.addLayer({
    id: 'poi-markers', type: 'symbol', source: 'neighborhood-pois',
    layout: { 'icon-image': ['concat', 'poi-', ['get', 'category']], 'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 14, 0.7, 16, 0.9], 'icon-allow-overlap': true, 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-max-width': 10, 'text-optional': true, 'text-padding': 10, 'icon-padding': 6 },
    paint: { 'text-color': '#304c50', 'text-halo-color': '#fbfcf8', 'text-halo-width': 2 },
  });

  function applyLens() {
    // Changing the lens mid-walk would paint over one of the blends the walk owns; the honest answer is to finish the
    // transition first, so the lens is applied to a scene that has already reached the theme it was heading for.
    if (moodRun) settleAtmosphere();
    const heights = lens.mode === 'height';
    const filter = lensFilter(lens.category, heights ? lens.source : 'all');
    const tagged = ['all', filter, ['==', ['get', 'heightSource'], 'height']];
    // Where a shell stands, the box steps out - except in the height lens, which reads a number off the wall and gets
    // the plain extrusion back.
    const shown = heights ? filter : ['all', filter, formFilter];
    map.setFilter('neighborhood-buildings', heights ? tagged : shown);
    map.setFilter('neighborhood-buildings-overview', heights ? tagged : ['all', shown, overviewFilter]);
    towerLayer?.showForms(!heights);
    map.setFilter('building-facade', heights ? tagged : shown);
    map.setLayoutProperty('building-facade', 'visibility', heights ? 'none' : 'visible');
    // The lamps and their spill follow the same filter, and they only burn at night.
    for (const layer of lampGates) {
      map.setFilter(layer.id, lampFilter(layer, heights ? tagged : shown));
      map.setLayoutProperty(layer.id, 'visibility', heights || atmosphereId !== 'night' ? 'none' : 'visible');
    }
    // The traffic follows the same rule as the lamps, and has to be re-decided here too: an atmosphere switch
    // re-runs this through `swapArt`, but moving to the height lens does not, and a lens change is the one case
    // where the theme stays put while the view it is drawn in changes.
    lightTraffic(!heights && atmosphereId === 'night');
    towerLayer?.setTraffic(!heights);
    towerLayer?.setVegetation(!heights);
    towerLayer?.setGround(!heights);
    // 楼根那圈接地带是楼的附属物：透视镜把它连同拉伸体一起收走。按类别筛的时候也必须一起没——
    // 它是一份合并几何，没有"逐栋跟着筛"这一说，留着就会变成"只剩一类楼，可每栋底下都有一片影"。
    towerLayer?.setBases(!heights && lens.category === 'all');
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
  // Every colour the atmosphere owns, as `layer/property` -> declaration, for one theme id. Patterns and visibility are
  // deliberately missing: nothing can interpolate a `resolvedImage`, so they belong to the swap below.
  function atmospherePaint(id) {
    const theme = ATMOSPHERES[id];
    const paint = new Map();
    const put = (layer, property, value) => { if (value !== undefined) paint.set(`${layer}/${property}`, value); };
    for (const layer of style.layers) {
      const merged = { ...layer.paint, ...baseAtmospherePaint(layer, theme) };
      for (const property of ['background-color', 'fill-color', 'line-color', 'text-color', 'text-halo-color'])
        put(layer.id, property, merged[property]);
    }
    const heights = lens.mode === 'height';
    for (const layer of ['neighborhood-buildings', 'neighborhood-buildings-overview'])
      put(layer, 'fill-extrusion-color', heights ? heightColor() : buildingAtmosphereColor(theme));
    put('context-buildings', 'fill-extrusion-color', contextAtmosphereColor(theme, center));
    // The decks carry a `match` on their own `foot` tag, so the pedestrian crossing stays the warmer one through the
    // whole walk, and the walk still gets to move both ends of it.
    for (const layer of bridgeLayers(theme)) put(layer.id, 'fill-extrusion-color', layer.paint['fill-extrusion-color']);
    put('building-selection', 'fill-extrusion-color', theme.selection);
    put('building-selection-flat', 'fill-color', theme.selection);
    put('radius-line', 'line-color', theme.radius);
    put('tower-label', 'text-color', theme.towerText);
    put('tower-label', 'text-halo-color', theme.towerHalo);
    put('poi-markers', 'text-color', theme.poiText);
    put('poi-markers', 'text-halo-color', theme.poiHalo);
    return paint;
  }
  // What no expression can walk: the facade grid, the river tile, which texture the basemap's patterned fills use, and
  // whether the lamps are burning. One step, at the middle of the colour transition.
  let trafficVisible = false;
  // The streets burn with the windows, and the height lens is a data view rather than a night view, so it keeps the
  // traffic out the same way it keeps the lamp grid out. `trafficVisible` is what the march reads, so the loop can
  // never spend a step on a layer nobody can see.
  // The two marching layers are always written together: they are one traffic light seen two ways, and a frame where
  // only one of them moved is a frame where the lattice is regular again.
  function marchLights(step) {
    const [headlights, taillights] = marchPair(step);
    map.setPaintProperty(TRAFFIC_FLOW, 'line-dasharray', headlights);
    map.setPaintProperty(TRAFFIC_TAIL, 'line-dasharray', taillights);
  }
  function lightTraffic(lit) {
    trafficVisible = lit;
    for (const layer of [TRAFFIC_BAND, TRAFFIC_TAIL, TRAFFIC_FLOW]) map.setLayoutProperty(layer, 'visibility', lit ? 'visible' : 'none');
    // The lamps burn with the ribbons; the cars and the walkers themselves stay on the picture by day too, and the
    // only thing that takes them off is the height lens, which is decided where the lens is applied.
    towerLayer?.setTrafficLamps(lit);
    if (lit) return;
    marchLights(0);
    motion.march = 0;
    // The near field is deliberately not snapped here. The ribbons are night-only, so resetting them on the way out is
    // invisible; the cars and the walkers burn by day as well, and a reset on the way out was a jump the observer
    // could see. They go back to the spacing their own ways give them in one place only: when the loop is switched off.
  }
  function swapArt(id) {
    const theme = ATMOSPHERES[id];
    for (const layer of style.layers) {
      const pattern = { ...layer.paint, ...baseAtmospherePaint(layer, theme) }['fill-pattern'];
      if (pattern !== undefined) map.setPaintProperty(layer.id, 'fill-pattern', pattern);
    }
    map.setPaintProperty('building-facade', 'fill-extrusion-pattern', facadePattern(id));
    // 广场那四层跟着氛围走色：草坪与水面用它们自己的档，石材用 `plaza`/`plazaWalk`。
    if (plaza) for (const layer of plazaLayers(theme)) map.setPaintProperty(layer.id, 'fill-color', layer.paint['fill-color']);
    // Lamps only burn at night, and the height lens keeps its colour-as-data wall to itself.
    for (const layer of lampGates) {
      map.setLayoutProperty(layer.id, 'visibility', id === 'night' && lens.mode !== 'height' ? 'visible' : 'none');
    }
    // The streets light up with the windows and go dark with them, and the height lens keeps them out.
    lightTraffic(id === 'night' && lens.mode !== 'height');
    // The beam over the mast belongs to the night only. It is the one thing on this map with no OSM element behind it,
    // which is why the landmark card for the tower says out loud that it is 示意.
    towerLayer?.setBeam(id === 'night');
    towerLayer?.setForms({ from: ATMOSPHERES[id], reveal: hazeStatus().reveal });
    map.setPaintProperty('river-surface', 'fill-pattern', `${WATER_IMAGE_PREFIX}-${id}`);
    // The loop writes into whichever tile the atmosphere currently points at, so all three are put back on their
    // shipped rows and the scroll restarts from row zero on the new one.
    if (Object.keys(riverTiles).length) {
      for (const [tileId, tile] of Object.entries(riverTiles)) map.updateImage(`${WATER_IMAGE_PREFIX}-${tileId}`, scrollWater(tile, 0));
      motion.phase = 0;
      motion.river = 0;
    }
  }
  function atmosphereLight(id) {
    return ATMOSPHERES[id].light;
  }
  function applyLight(override) {
    const light = override ?? atmosphereLight(atmosphereId);
    map.setLight({ ...light, 'color-transition': { duration: 0 }, 'intensity-transition': { duration: 0 }, 'position-transition': { duration: 0 } });
  }
  function applySky(colors) {
    map.setSky({ ...colors ?? ATMOSPHERES[atmosphereId].sky, ...SKY_BLEND,
      'sky-color-transition': { duration: 0 }, 'horizon-color-transition': { duration: 0 }, 'fog-color-transition': { duration: 0 } });
  }
  function installPaint(paint) {
    for (const [key, value] of paint) {
      const [layer, property] = key.split('/');
      map.setPaintProperty(layer, `${property}-transition`, { duration: 0 });
      map.setPaintProperty(layer, property, value);
    }
  }
  // Stop the clock without touching what it was painting. Returns where the walk stood, for a walk that resumes from it.
  function stopMood() {
    if (!moodRun) return null;
    // The state is what the picture is painted from, so it is what the next walk resumes from - not the number the
    // clock last computed, which is rounded on the way in.
    const stood = { fromId: moodRun.fromId, toId: moodRun.toId, at: map.getGlobalState()[MOOD] ?? 0 };
    cancelAnimationFrame(moodRun.frame);
    moodRun = undefined;
    return stood;
  }
  // The end of a walk, and the whole of a switch that must not animate: every surface on the theme it was heading for,
  // written as the shipped declaration rather than as a blend, so the frame a finished transition leaves behind is
  // byte-for-byte the frame a page without this feature would have drawn.
  function settleAtmosphere() {
    stopMood();
    const theme = ATMOSPHERES[atmosphereId];
    installPaint(atmospherePaint(atmosphereId));
    swapArt(atmosphereId);
    // The shells have no expression to hold a middle stop in, so their arrival is written here rather than inside
    // `swapArt`: that also runs at the pattern swap mid-walk, and a share of 1 there would light a landmark in one
    // frame instead of on the curve its neighbours are walking.
    towerLayer?.setForms({ share: 1 });
    map.setGlobalStateProperty(MOOD, 0);
    applyLight();
    applySky();
    towerLayer?.setAtmosphere(theme.tower);
  }
  function setAtmosphere(id, { instant = false, duration = ATMOSPHERE_MS } = {}) {
    const previous = stopMood();
    const fromId = atmosphereId;
    if (id === fromId && !previous) return;
    atmosphereId = id;
    // A reduce request gets the shipped cut: the same end frame, no 1.2 s of frames to spend.
    if (instant || reducedMotion.matches) return settleAtmosphere();
    const from = atmospherePaint(previous ? previous.fromId : fromId);
    const abandoned = previous ? atmospherePaint(previous.toId) : from;
    const target = atmospherePaint(id);
    const at = previous ? previous.at : 0;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const [key, value] of target) {
      const a = from.get(key), b = abandoned.get(key);
      // Untouched by this switch - and, unless a walk is being abandoned, nothing to undo either.
      if (same(a, value) && (at === 0 || same(b, value))) continue;
      const [layer, property] = key.split('/');
      map.setPaintProperty(layer, `${property}-transition`, { duration: 0 });
      map.setPaintProperty(layer, property, at ? themeResume(a, b, value, at) : themeBlend(a, value));
    }
    const lightFrom = previous ? mixPreset(atmosphereLight(previous.fromId), atmosphereLight(previous.toId), at) : atmosphereLight(fromId);
    const skyFrom = previous ? mixPreset(ATMOSPHERES[previous.fromId].sky, ATMOSPHERES[previous.toId].sky, at) : ATMOSPHERES[fromId].sky;
    const towerFrom = previous ? mixPreset(ATMOSPHERES[previous.fromId].tower, ATMOSPHERES[previous.toId].tower, at) : ATMOSPHERES[fromId].tower;
    const themeFrom = ATMOSPHERES[previous ? previous.fromId : fromId];
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // The same cubic in-out MapLibre applies to its own colour transitions, so the light, the sky and the tower -
      // which are not paint at all and so cannot read the global state - walk on the same curve as the walls.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      moodRun.value = at + (1 - at) * eased;
      map.setGlobalStateProperty(MOOD, Math.round(moodRun.value * 1000) / 1000);
      const share = (moodRun.value - at) / (1 - at);
      applyLight(mixPreset(lightFrom, atmosphereLight(id), share));
      applySky(mixPreset(skyFrom, ATMOSPHERES[id].sky, share));
      towerLayer?.setAtmosphere(mixPreset(towerFrom, ATMOSPHERES[id].tower, share));
      // The shells walk with the walls, and their night lamps come up on the same eased share rather than in one frame.
      towerLayer?.setForms({ from: themeFrom, to: ATMOSPHERES[id], share, resume: Boolean(previous),
        reveal: hazeStatus().reveal });
      if (!moodRun.swapped && now - start >= PATTERN_SWAP_MS) { moodRun.swapped = true; swapArt(id); }
      if (t < 1) moodRun.frame = requestAnimationFrame(step);
      else settleAtmosphere();
    };
    moodRun = { fromId: previous ? previous.fromId : fromId, toId: id, value: at, swapped: false, frame: undefined, duration };
    moodRun.frame = requestAnimationFrame(step);
  }
  function moodStatus() {
    return {
      mood: map.getGlobalState()[MOOD] ?? 0,
      running: moodRun !== undefined,
      swapped: Boolean(moodRun?.swapped),
      ms: moodRun?.duration ?? ATMOSPHERE_MS,
      swapMs: PATTERN_SWAP_MS,
    };
  }

  // Six landmarks, each one an OSM element the shipped snapshots already carry. A marker is a button, so the keyboard
  // reaches it and the card it opens is themed like every other card on this map. The tower's plain text label steps
  // out here: the interactive marker carries the same name, and two labels for one building is a mistake twice over.
  // Each nameplate is drawn with its own silhouette - see `landmark-glyphs.js` for where those shapes come from.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function landmarkGlyph(osmId) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'landmark-gem');
    svg.setAttribute('viewBox', GLYPH_BOX);
    svg.setAttribute('aria-hidden', 'true');
    for (const d of LANDMARK_GLYPHS[osmId] ?? ['M4,21 L12,3 L20,21 Z']) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  const landmarkElements = new Map();
  map.setLayoutProperty('tower-label', 'visibility', 'none');
  for (const landmark of LANDMARKS) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'landmark';
    node.dataset.osmId = String(landmark.osmId);
    node.setAttribute('aria-label', landmark.name);
    const gem = landmarkGlyph(landmark.osmId);
    const name = document.createElement('span');
    name.className = 'landmark-name';
    name.textContent = landmark.name;
    node.append(gem, name);
    // The click has to stop here: a nameplate is inside the canvas container, and without this the same press also
    // reaches the map's own click handler, which closes the card that was just opened.
    node.addEventListener('click', (event) => { event.stopPropagation(); openLandmark(landmark); });
    landmarkElements.set(landmark.osmId, node);
    // `interactive` is not optional: a MapLibre marker sets `pointer-events: none` on its element without it, and the
    // button then swallows nothing and answers nothing.
    new maplibregl.Marker({ element: node, anchor: 'bottom', offset: [0, -6], interactive: true })
      .setLngLat(landmark.center).addTo(map);
  }
  // Two plates that touch read as one garbled line, and the six landmarks sit close enough together for that well
  // before the camera reaches the tower. The sizes are measured once per layout rather than per pass: reading
  // `offsetWidth` after every class write would force the page to lay out the whole marker container on each frame of
  // a drag. The silhouette size is taken from the same element with its name off, in the same frame, so nothing is
  // painted between the two states.
  let plateSizes;
  let plateFrame;
  function measurePlates() {
    const nodes = [...landmarkElements.values()];
    for (const node of nodes) node.classList.remove('is-textless', 'is-hidden');
    const full = nodes.map((node) => ({ w: node.offsetWidth, h: node.offsetHeight }));
    for (const node of nodes) node.classList.add('is-textless');
    const silhouettes = nodes.map((node) => ({ w: node.offsetWidth, h: node.offsetHeight }));
    for (const node of nodes) node.classList.remove('is-textless');
    plateSizes = new Map(nodes.map((node, i) => [Number(node.dataset.osmId), {
      full: full[i], diamond: silhouettes[i],
      // Whether this plate has any words on the screen at all. On a narrow screen the six names are already dropped by
      // the stylesheet, so a plate there has nothing left to give up - and its two boxes would look different anyway.
      spoken: getComputedStyle(node.querySelector('.landmark-name')).display !== 'none',
    }]));
  }
  function seatLandmarks() {
    if (!plateSizes) return;
    const entries = LANDMARKS.filter((landmark) => plateSizes.get(landmark.osmId).spoken).map((landmark) => {
      const size = plateSizes.get(landmark.osmId);
      // `anchor: 'bottom'` with `offset: [0, -6]` hangs the plate above its own point, so the box is built from that
      // point rather than read off the element - and a plate that drops its name keeps its bottom centre where it was.
      const point = map.project(landmark.center);
      const hung = ({ w, h }) => ({ x: point.x - w / 2, y: point.y - 6 - h, w, h });
      return { osmId: landmark.osmId, height: landmark.height, box: hung(size.full), diamond: hung(size.diamond) };
    });
    // A plate with no words on the screen has nothing to give up: on a narrow screen the six names are already dropped,
    // and parking a silhouette there would take the landmark off the page entirely.
    const states = new Map(LANDMARKS.map(({ osmId }) => [osmId, 'full']));
    for (const { osmId, state } of declutter(entries)) states.set(osmId, state);
    for (const [osmId, state] of states) {
      const node = landmarkElements.get(osmId);
      node.classList.toggle('is-textless', state !== 'full');
      node.classList.toggle('is-hidden', state === 'hidden');
    }
  }
  const repaintPlates = () => {
    plateFrame ??= requestAnimationFrame(() => { plateFrame = undefined; seatLandmarks(); });
  };
  measurePlates();
  seatLandmarks();
  map.on('move', repaintPlates);
  map.on('resize', () => { measurePlates(); seatLandmarks(); });
  function landmarkCard(landmark) {
    const card = document.createElement('div');
    card.className = 'building-card landmark-card';
    const title = document.createElement('h2');
    title.textContent = landmark.name;
    const latin = document.createElement('p');
    latin.className = 'building-name-en';
    latin.textContent = landmark.latin;
    const facts = document.createElement('ul');
    for (const line of landmarkFacts(landmark, landmarkForms?.forms ?? [])) {
      const item = document.createElement('li');
      item.className = 'building-fact';
      item.textContent = line;
      facts.append(item);
    }
    const intro = document.createElement('p');
    intro.className = 'landmark-intro';
    intro.textContent = landmark.intro;
    intro.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'landmark-actions';
    const read = document.createElement('button');
    read.type = 'button';
    read.className = 'text-button';
    read.textContent = '查看介绍';
    read.setAttribute('aria-expanded', 'false');
    read.addEventListener('click', () => {
      intro.hidden = !intro.hidden;
      read.setAttribute('aria-expanded', String(!intro.hidden));
      read.textContent = intro.hidden ? '查看介绍' : '收起介绍';
    });
    const fly = document.createElement('button');
    fly.type = 'button';
    fly.className = 'text-button';
    fly.textContent = '飞过去';
    fly.addEventListener('click', () => flyToLandmark(landmark));
    actions.append(read, fly);
    card.append(title, latin, facts, intro, actions);
    return card;
  }
  function openLandmark(landmark) {
    stopOrbit(); tour.exit(); cancelFocus();
    openPopup([{ lngLat: landmark.center }], landmarkCard(landmark), { closeLabel: '关闭地标卡片' });
  }
  // The labels step back while the camera travels and the one it flew to stays lit: a nameplate that keeps floating in
  // front of a building being flown past is the thing that makes a fly-to look like a slideshow.
  function flyToLandmark(landmark) {
    const camera = approachCamera(landmark, map.getCanvas().clientHeight);
    document.body.dataset.landmark = 'flying';
    map.once('moveend', () => {
      delete document.body.dataset.landmark;
      for (const [osmId, node] of landmarkElements) node.classList.toggle('is-arrival', osmId === landmark.osmId);
    });
    map.flyTo({ ...camera, duration: reducedMotion.matches ? 0 : camera.duration });
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
  function setOutline(features) {
    const list = features ? (Array.isArray(features) ? features : [features]) : [];
    map.getSource('building-selection')?.setData(featureCollection(list));
  }
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
    document.body.dataset.card = 'open';
    // MapLibre's own focus-on-open calls focus() without preventScroll, and the browser then scrolls the overflow:hidden
    // map container to reveal the button — by 45 px on a landscape phone, where a merged card is taller than the screen.
    // The seat loop measures in the frame that scroll creates, and the container is back at 0 by the time the click is
    // over, so a seat that measured flush with the bottom edge lands 45 px past it. The focus happens below instead: the
    // keyboard still lands inside the card, and the map does not move under the measurement.
    popup = new maplibregl.Popup({ offset: 20, maxWidth: '250px', closeButton: true, focusAfterOpen: false, anchor })
      .setLngLat(lngLat).setDOMContent(content).addTo(map);
    const close = popup.getElement().querySelector('.maplibregl-popup-close-button');
    close.setAttribute('aria-label', closeLabel);
    close.focus({ preventScroll: true });
    cardBlock = blockId;
    popup.on('close', () => { popup = undefined; cardBlock = undefined; document.body.dataset.card = 'closed'; document.body.dataset.cardPill = null; setOutline(null); if (selection) { selection = null; writeHash(); } });
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
  // One loop dresses all three moving surfaces. The river advances one row of the tile per step, the tower's glow walks
  // between its floor and the atmosphere's own baseline, and the traffic marches half a dash period at a time; all
  // phases wrap, and every frame is derived from the pristine pixels rather than from the last drawn ones, so a long
  // session cannot accumulate a drift the tile never had.
  const MOTION_STEP_MS = 120, MOTION_BREATH_MS = 9000, HAZE_REVEAL_MS = 1500, TOWER_CYCLE_MS = 40000;
  // 塔身灯光两档之间的那一段走查（V5 遗留③）。切换原来是一帧到位，按一下塔身就当众换了根管子。
  // 这里走的不是"五色各自收成一色"——V5-7 量过那条路：预设五色横跨 0.68 个色相环，任何"各走最短路再汇合"
  // 都会先把画面拉开再收（离散度实测 0.37→0.48→0），所以那一版把过渡整个撤了。这一版不让任何色相走路：
  // 动的只有明度，先暗到一成、在最暗那一格换方案、再亮回来，0.6 s。
  const TOWER_SWITCH_MS = 600, TOWER_FADE_DEPTH = 0.88;
  const motion = { on: false, frame: undefined, previous: undefined, river: 0, breath: 0, traffic: 0, hue: 0, life: 0, lamp: 0, phase: 0, march: 0, steps: 0, pulses: 0, marches: 0, lights: 0, lampTicks: 0, pulse: 1 };
  // Two night lighting schemes for the tower, and only one of them runs at a time: the colour cycle
  // turns the five emissive colours round the wheel over 40 s, the breath walks their intensity. `single` is the
  // default because V5-7 found a five-hue shaft reads as a toy.
  // `towerMode` is what the shaft is painted with; `towerWanted` is what the buttons say. They only disagree for the
  // 600 ms of a switch, which is the whole point: the control answers the click at once, the picture walks to it.
  let towerMode = 'single';
  let towerWanted = 'single';
  let towerSwitch;
  let towerFade = 1;
  // The scheme the shaft is actually painted with. Resetting the two clocks here is what makes a switch land on the
  // frame the new scheme ships with rather than on wherever the old one had got to.
  function commitTowerMode(next) {
    towerMode = next;
    motion.hue = 0;
    motion.breath = 0;
    motion.pulse = 1;
    towerLayer?.setHue(0);
  }
  /** Walks the shaft down, swaps the scheme at the bottom, walks it back up. Returns whether it wrote this frame. */
  function stepTowerSwitch(time) {
    if (towerSwitch === undefined) return false;
    const at = (time - towerSwitch.at) / TOWER_SWITCH_MS;
    if (at >= 0.5 && towerMode !== towerSwitch.to) commitTowerMode(towerSwitch.to);
    if (at >= 1) {
      towerSwitch = undefined;
      towerFade = 1;
    } else {
      towerFade = 1 - TOWER_FADE_DEPTH * Math.sin(Math.max(0, Math.min(1, at)) * Math.PI);
    }
    towerLayer?.setPulse(motion.pulse, towerFade);
    return true;
  }
  let hazeReveal;
  // The opening is a reveal rather than a cut: the city starts under its own fog colour and the haze lifts over 1.5 s.
  // `global-state` carries it because a data-driven colour follows that number without the style being re-validated
  // forty times. Under a reduce request the page opens on the shipped pixels, which is the same end state.
  function revealHaze(duration = HAZE_REVEAL_MS) {
    if (hazeReveal !== undefined) return hazeStatus();
    if (reducedMotion.matches) {
      map.setGlobalStateProperty(HAZE_REVEAL, 0);
      return hazeStatus();
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const reveal = Math.round((1 - t) ** 2 * 1000) / 1000;
      map.setGlobalStateProperty(HAZE_REVEAL, reveal);
      // The shells read the same number the ramp reads; without this the city lifts out of the fog and three landmark
      // towers stay behind it, still wearing the opening frame.
      towerLayer?.setForms({ reveal });
      if (t < 1) hazeReveal = requestAnimationFrame(step);
      else {
        hazeReveal = undefined;
        map.setGlobalStateProperty(HAZE_REVEAL, 0);
        towerLayer?.setForms({ reveal: 0 });
      }
    };
    hazeReveal = requestAnimationFrame(step);
    return hazeStatus();
  }
  function hazeStatus() {
    return { reveal: map.getGlobalState()[HAZE_REVEAL] ?? 0, running: hazeReveal !== undefined, ms: HAZE_REVEAL_MS };
  }
  function motionFrame(time) {
    if (!motion.on) return;
    // A background tab stops rAF, so the first frame back carries the whole gap; without the clamp the river jumps.
    const delta = motion.previous === undefined ? 0 : Math.min(time - motion.previous, 4 * MOTION_STEP_MS);
    motion.previous = time;
    motion.river += delta;
    motion.breath += delta;
    // A tower-scheme switch is the one thing here that wants the frame rather than the 120 ms tick: it is a material
    // write with no style behind it, and five steps over 600 ms would read as a stutter. It only runs while a switch
    // is in flight, so a page that never presses the button pays nothing.
    stepTowerSwitch(time);
    if (motion.river >= MOTION_STEP_MS) {
      const steps = Math.floor(motion.river / MOTION_STEP_MS);
      motion.river -= steps * MOTION_STEP_MS;
      if (scrollRiver(steps)) motion.steps += steps;
      if (towerLayer) {
        if (towerMode === 'breath') {
          motion.pulse = towerBreath((motion.breath % MOTION_BREATH_MS) / MOTION_BREATH_MS);
        } else {
          motion.hue += steps * MOTION_STEP_MS;
          towerLayer.setHue(towerHue((motion.hue % TOWER_CYCLE_MS) / TOWER_CYCLE_MS), towerMode);
          motion.pulse = 1;
        }
        // The switch's dip rides the same channel the breath does, so it multiplies rather than replacing it.
        towerLayer.setPulse(motion.pulse, towerFade);
        motion.pulses++;
        // The crowns ride the same elapsed clock on their own 7 s and 8 s, so no two of the three towers share a beat.
        towerLayer.setBreath(motion.breath);
        // The near field rides this tick rather than the frame. The river has already dirtied the style on this step, so
        // an advance costs no extra repaint, and 120 ms at the fastest speed on the table is 1.7 m - under the pixel the
        // hero camera resolves. A continuous march is what this layer is for: `line-dasharray` could not do it at all,
        // which is why the ribbons two kilometres out are still stepped.
        // The gate is the lens, not the night. Cars and walkers are models rather than lamps, so they are on the picture
        // in daylight too, and a clock gated on `trafficVisible` left the whole near field frozen outside night - which is
        // the same traffic two kilometres further out doing nothing at noon.
        if (lens.mode !== 'height') {
          motion.life += steps * MOTION_STEP_MS;
          towerLayer.runTraffic(motion.life / 1000, map.getZoom());
          motion.lights += steps;
        }
        // The lamps cross-fade on the same tick, and they cost two numbers. Their weight is read by the layer's own
        // opacity every frame, which is the only channel this scene can animate a wall through: the pattern a
        // `fill-extrusion` shows is baked into its bucket when the tile is tessellated, and rewriting the image behind
        // the name was proved not to reach the screen. The two groups start at cycle 0 together - the shipped frame -
        // and their periods share no factor, so they drift apart from the first minute and never realign.
        if (atmosphereId === 'night' && lens.mode !== 'height') {
          motion.lamp += steps * MOTION_STEP_MS;
          for (const group of [0, 1]) {
            map.setGlobalStateProperty(LAMP_KEYS[group], lampWeight((motion.lamp / LAMP_PERIODS_MS[group]) % 1));
          }
          motion.lampTicks += steps;
        }
      }
    }
    motion.traffic += delta;
    if (motion.traffic >= TRAFFIC_STEP_MS) {
      const steps = Math.floor(motion.traffic / TRAFFIC_STEP_MS);
      motion.traffic -= steps * TRAFFIC_STEP_MS;
      // Two layouts, alternating: the dash array is a stepped property, and the motion rules hold a step to twice a
      // second. Writing it once per frame would re-tessellate every road in view sixty times a second for nothing.
      // And it is only written when the streets are actually on screen: a day scene has nothing to march, and a
      // `setPaintProperty` on a hidden layer still dirties the style and costs a repaint.
      if (trafficVisible) {
        motion.march = (motion.march + steps) % MARCH_PHASES.length;
        marchLights(motion.march);
        motion.marches += steps;
      }
    }
    motion.frame = requestAnimationFrame(motionFrame);
  }
  function scrollRiver(steps) {
    const tile = riverTiles[atmosphereId];
    if (!tile) return false;
    motion.phase = (motion.phase + steps) % tile.height;
    map.updateImage(`${WATER_IMAGE_PREFIX}-${atmosphereId}`, scrollWater(tile, motion.phase));
    return true;
  }
  // Turning motion off is not pausing: the tiles go back to the rows they shipped on and the tower to the intensities
  // the atmosphere set for it, so the frame left on screen is one a page without this feature would have drawn.
  // A scene with neither a river tile nor a tower has nothing for the loop to redraw, so it must not run at all:
  // an idle requestAnimationFrame still wakes the tab sixty times a second and drains a phone for no picture.
  function motionAvailable() { return Object.keys(riverTiles).length > 0 || Boolean(towerLayer); }
  function setMotion(next) {
    const on = Boolean(next) && motionAvailable();
    if (on !== motion.on) {
      motion.on = on;
      if (on) {
        motion.previous = undefined;
        motion.frame = requestAnimationFrame(motionFrame);
      } else {
        cancelAnimationFrame(motion.frame);
        Object.assign(motion, { frame: undefined, previous: undefined, river: 0, breath: 0, traffic: 0, hue: 0, phase: 0, march: 0, life: 0, lamp: 0, pulse: 1 });
        // A switch that was mid-dip finishes here rather than being left half walked: the painted scheme becomes the
        // one the buttons already show, and the shaft comes back up to the preset's own emission.
        if (towerSwitch !== undefined) { towerSwitch = undefined; towerFade = 1; towerMode = towerWanted; }
        for (const [id, tile] of Object.entries(riverTiles)) map.updateImage(`${WATER_IMAGE_PREFIX}-${id}`, scrollWater(tile, 0));
        marchLights(0);
        // Handing back means the frame a page without any of this would have drawn: the shipped dash, the preset's own
        // emission, the preset's own colour rather than wherever the wheel had got to, the vehicles back on the spacing
        // their own ways give them, and every block on its shipped pick of windows rather than wherever the evening's
        // cross-fade had drifted.
        for (const key of LAMP_KEYS) map.setGlobalStateProperty(key, 1);
        towerLayer?.setPulse(1);
        towerLayer?.setHue(0);
        towerLayer?.setBreath(0);
        towerLayer?.runTraffic(0, map.getZoom());
      }
    }
    onMotionChange?.(motionStatus());
    return motionStatus();
  }
  function motionStatus() {
    const state = map.getGlobalState();
    return { on: motion.on, available: motionAvailable(), stepMs: MOTION_STEP_MS, breathMs: MOTION_BREATH_MS, marchMs: TRAFFIC_STEP_MS, cycleMs: TOWER_CYCLE_MS, lampMs: LAMP_PERIODS_MS, towerMode: towerWanted, towerPainted: towerMode, towerSwitchMs: TOWER_SWITCH_MS,
      towerFade: Math.round(towerFade * 1000) / 1000, phase: motion.phase, steps: motion.steps, pulses: motion.pulses, march: motion.march, marches: motion.marches, lights: motion.lights, lamps: LAMP_KEYS.map((key) => state[key] ?? 1), lampTicks: motion.lampTicks, tiles: Object.keys(riverTiles).length };
  }
  // What the near field is made of, for the panel and for the acceptance test: how many lights the snapshot's own ways
  // carry, how far out they stop, and whether the night theme currently has them burning. 形状由 `src/near-field.js`
  // 一个人定义，引擎那侧读的是同一个 `readout()`，所以两边判据对的是同一份键。
  function nearTraffic() {
    return nearField?.readout() ?? null;
  }
  // 广场那四层的读数：每层几块、切没切出来。没切出广场时这一格就是 null。
  function plazaState() {
    if (!plaza) return null;
    return { ...plaza.report, layers: [PLAZA_LAWN, PLAZA_POOL, PLAZA_STONE, PLAZA_WALK].filter((id) => map.getLayer(id)).length,
      // 地面那张图：尺寸与各类像素数在初始化时就定了，`visible` 是镜头这一帧读出来的。
      surface: plazaSurfaceState, ground: plazaGround ? plazaGround.visible === true : false };
  }
  // 树的那一份读数：多少个、分成哪两类、这一帧在不在图上。
  function nearTrees() {
    if (!greenery) return null;
    return { ...greenery.report, visible: greenery.group.visible, minZoom: TREE_MIN_ZOOM, zoom: map.getZoom() };
  }
  function motionPreference() { setMotion(!reducedMotion.matches); }
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
  const extrusions = ['canton-tower-hit', 'landmark-forms-hit',
    'neighborhood-buildings', 'neighborhood-buildings-overview', 'height-estimates', 'height-unknown'];
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
    const snapshot = buildings.features.find((building) => String(building.properties.osmId) === String(feature.properties.osmId));
    const properties = snapshot?.properties ?? feature.properties;
    const geometry = snapshot?.geometry ?? feature.geometry;
    const flat = lens.mode === 'height' && properties.heightSource === 'estimate';
    onBuildingClick({
      properties,
      outline: { type: 'Feature', properties: { height: properties.tower ? towerHeight : flat ? 0 : properties.displayHeight ?? properties.height, base: flat ? 0 : properties.base }, geometry },
      ...anchorPoint(geometry),
    });
    const [lng, lat] = geometryPoint(geometry);
    selection = { osmId: buildingId(properties.osmId), lat, lng };
    writeHash();
  }
  // 高度透视镜里"高度未知"只画平面，所以卡片那一圈轮廓也得跟着压平，不然高亮会比图上多出一截体块。
  const selectionOutline = ({ properties, geometry }) => {
    const flat = lens.mode === 'height' && properties.heightSource === 'estimate';
    return {
      type: 'Feature',
      properties: { height: properties.tower ? towerHeight : flat ? 0 : properties.displayHeight ?? properties.height, base: flat ? 0 : properties.base },
      geometry,
    };
  };
  map.on('click', (event) => {
    if (event.originalEvent.target.closest('.maplibregl-popup')) return;
    const pois = poiAt(event.point);
    if (pois.length) return onPoiClick(pois[0].properties.id);
    const building = buildingAt(event.point);
    if (building) selectFeature(building);
  });
  function focusPick() {
    const { osmId, lng, lat } = focus;
    const point = map.project([lng, lat]);
    const canvas = map.getCanvas();
    if (point.x < 0 || point.y < 0 || point.x > canvas.clientWidth || point.y > canvas.clientHeight) return null;
    return map.queryRenderedFeatures(box(point, 2), { layers: extrusions })
      .find((candidate) => String(candidate.properties.osmId) === String(osmId)) ?? null;
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
  reducedMotion.addEventListener('change', motionPreference);
  window.addEventListener('resize', resize);
  map.on('remove', () => {
    tour.exit();
    stopOrbit();
    motion.on = false;
    cancelAnimationFrame(motion.frame);
    cancelAnimationFrame(hoverFrame);
    cancelAnimationFrame(plateFrame);
    clearTimeout(focus?.timer);
    document.removeEventListener('visibilitychange', visibilityChange);
    reducedMotion.removeEventListener('change', manualInteraction);
    reducedMotion.removeEventListener('change', motionPreference);
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
  // Motion obeys the same preference the camera eases and the tour already obey: under a reduce request the page opens
  // on the shipped pixels and lighting rather than on a loop that is one frame into its first cycle.
  setMotion(!reducedMotion.matches);
  revealHaze();
  return {
    map,
    revealHaze,
    get haze() { return hazeStatus(); },
    setAtmosphere,
    get atmosphere() { return moodStatus(); },
    settleAtmosphere,
    setMotion,
    // What the landmark shells and their lamps are showing on this frame. The night's whole point is that these are
    // moving, and a screenshot cannot tell a slow breath from a still one - so the acceptance reads the materials.
    get landmarkLights() {
      if (!landmarkForms) return null;
      return landmarkForms.forms.map((form) => ({
        osmId: form.osmId,
        shells: form.shells.map((shell) => ({
          part: shell.part,
          emissive: `#${shell.material.emissive.getHexString()}`,
          intensity: Math.round(shell.material.emissiveIntensity * 1000) / 1000,
          // 塔身夜里穿的是那张窗图，材质系数只是图上最亮那一格的倍率，所以"平均发多少"要连图一起读。
          lamp: Math.round((shell.material.emissiveMap?.userData?.mean ?? 0) * 1000) / 1000,
        })),
      }));
    },
    // The same reasoning for the water: the bands are three quads whose visibility is decided on the frame, and a
    // still page has to be able to say whether they are on it.
    get towerSpill() {
      return towerLayer?.spillState() ?? null;
    },
    setTowerMode(next) {
      const mode = TOWER_MODES.includes(next) ? next : TOWER_MODES[0];
      towerWanted = mode;
      // Pressing the same button again while a switch is walking does not restart the dip - it retargets it, so the
      // shaft never climbs partway and falls again. With the loop stopped there is nothing to walk: the preset's own
      // frame is one write away, and that is also what a reduced-motion page gets.
      if (towerSwitch !== undefined) towerSwitch.to = mode;
      else if (!motion.on) commitTowerMode(mode);
      else towerSwitch = { to: mode, at: performance.now() };
      onMotionChange?.(motionStatus());
      return motionStatus();
    },
    motionStatus,
    nearTraffic,
    nearTrees,
    plazaState,
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
      map.easeTo({ center: [poi.lng, poi.lat], padding: padding(), duration: reducedMotion.matches ? 0 : 700 });
    },
    showBuilding(building, content) {
      manualInteraction();
      const blockId = buildingId(building.properties.osmId) || undefined;
      openPopup(buildingSeats(building.outline.geometry, building.lngLat, blockId), content, {
        outline: selectionOutline(building.outline),
        closeLabel: '关闭建筑卡片',
        blockId,
      });
    },
    focusBuilding,
    startOrbit() {
      tour.exit(); stopOrbit(); popup?.remove(); map.stop(); cancelFocus();
      map.jumpTo({ center, zoom: landscape() ? Math.max(14, Math.min(map.getZoom(), 14.4)) : Math.max(14.6, Math.min(map.getZoom(), 15.7)), pitch: 58, padding: padding() });
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

import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { DEFAULT_BUILDING_HEIGHT, DEFAULT_CENTER, MAP_STYLE_URL, POI_CATEGORIES, RADIUS_METERS, SCENE, TOWER_OSM_ID, VIEW_LIMITS } from './config.js';
import { ATMOSPHERES, HAZE_REVEAL, MOOD, SKY_BLEND, buildingAtmosphereColor, contextAtmosphereColor } from './atmosphere.js';
import { featureCollection, radiusPolygon } from './geo.js';
import { formatView, parseView } from './link.js';
import { isLandscapeViewport, isMobileViewport, viewportPadding } from './padding.js';
import { mapIcon } from './icons.js';
import { poisGeoJSON } from './pois.js';
import { createTowerLayer } from './tower.js';
import { createTour, TOUR_STOPS } from './tour.js';
import { createFilm, filmFrame } from './film.js';
import { heightColor, heightSummary, lensFilter, UNKNOWN_HEIGHT_COLOR } from './lens.js';
import { schematicDisplayHeights } from './block-layout.js';
import { FACADE_SHAPES, FACADE_THEMES, LAMP_KEYS, WINDOWS_OFF_IMAGE, facadeImage, facadeOptions, facadePattern, facadeTexture, windowsOffTile } from './facade.js';
import { WATER_IMAGE_PREFIX, WATER_THEMES, riverOpacityExpression, waterTexture } from './water.js';
import { BRIDGE_SOURCE, bridgeLayers } from './bridges.js';
import { trafficLayers } from './traffic.js';
import { deckHeights, trafficSprite } from './traffic-life.js';
import { createNearField } from './near-field.js';
import { createBaseBands } from './shadow-pads.js';
import { TREE_MIN_ZOOM, VEGETATION_RADIUS, createVegetation } from './vegetation.js';
import { PLAZA_LAWN, PLAZA_POOL, PLAZA_SOURCE, PLAZA_STONE, PLAZA_WALK, carvePlaza, plazaLayers, stoneRings } from './plaza.js';
import { plazaSurface, plazaSurfaceMesh } from './plaza-surface.js';
import { FORM_OSM_IDS, createLandmarkForms } from './landmark-forms.js';
// #219 拆分：纯函数、夜灯七层、昼夜氛围、动效循环、地标名牌、卡片挂点各自成册（src/map/），
// 这里只剩编排——取数、建源建层、透视镜、导览/宣传片接线、命中与深链、手势、teardown 与对外 API。
import { buildingId, geometryPoint, neighborhoodStyle } from './map/helpers.js';
import { createLamps } from './map/lamps.js';
import { createAtmosphere } from './map/atmosphere.js';
import { createMotion } from './map/motion.js';
import { createPlates } from './map/plates.js';
import { createCards } from './map/cards.js';

maplibregl.setWorkerUrl(workerUrl);
const center = [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat];
const distance = ['distance', { type: 'Point', coordinates: center }];

export async function createNeighborhoodMap({ onPoiClick, onBuildingClick, onInteraction, onTourChange, onFilmChange, onLensChange, onMotionChange, onError }) {
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
  let frame, previousTime, selectedPoiId;
  let orbiting = false, poiFeatures = [], activeFilter = 'all';
  let film, filmSaved, filmShot = -1;
  let lens = { mode: 'use', category: 'all', source: 'all' };
  let selection; // the block an open card describes, so the address bar can point back at it
  let focus; // a block waiting for the camera and its tiles to settle before it can be picked
  let lastHash = window.location.hash;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // replaceState is rate limited by the browser and orbit rewrites it every frame, so the address bar only follows a
  // camera that actually stopped somewhere.
  function writeHash() {
    if (orbiting || film?.active) return;
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
  for (const theme of Object.keys(FACADE_THEMES)) for (const shape of Object.keys(FACADE_SHAPES)) {
    map.addImage(facadeImage(theme, shape), facadeTexture(facadeOptions(theme, shape)));
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
  const lamps = createLamps(map, formFilter);
  // 动效时钟是氛围与循环共用的那一份：换图要归零江面相位、熄灯要归零步进，所以它谁也不私有。
  const motion = { on: false, frame: undefined, previous: undefined, river: 0, breath: 0, traffic: 0, hue: 0, life: 0, lamp: 0, phase: 0, march: 0, steps: 0, pulses: 0, marches: 0, lights: 0, lampTicks: 0, pulse: 1 };
  // 塔层、广场与雾的读数在这两份工厂构造之后才建出来／才会变，所以一律走取值函数；`motionApi` 先声明，
  // 氛围那份拿着它的雾读数闭包，构造完马上补上——两边真正调用都在构造之后。
  let motionApi;
  const atmosphere = createAtmosphere({ map, style, center, getLens: () => lens, tower: () => towerLayer, plaza: () => plaza, riverTiles, motion, reducedMotion, lamps, hazeStatus: () => motionApi.hazeStatus() });
  motionApi = createMotion({ map, riverTiles, tower: () => towerLayer, motion, atmosphere, getLens: () => lens, reducedMotion, onMotionChange });
  atmosphere.applyLight();
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
  // 这是这一块的边界，写在 `shadow-pads.js` 的注释里，也记在 DEVELOPMENT.md。
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
    if (atmosphere.running) atmosphere.settle();
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
    for (const layer of lamps.lampGates) {
      map.setFilter(layer.id, lamps.lampFilter(layer, heights ? tagged : shown));
      const visible = !heights && atmosphere.id === 'night';
      // 走路去夜里的途中 `atmosphereId` 已是 night 而中点还没到，这里先开门就必须先有图。
      if (visible) lamps.ensureLampImages();
      map.setLayoutProperty(layer.id, 'visibility', visible ? 'visible' : 'none');
    }
    // The traffic follows the same rule as the lamps, and has to be re-decided here too: an atmosphere switch
    // re-runs this through `swapArt`, but moving to the height lens does not, and a lens change is the one case
    // where the theme stays put while the view it is drawn in changes.
    atmosphere.lightTraffic(!heights && atmosphere.id === 'night');
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
    for (const layer of ['neighborhood-buildings', 'neighborhood-buildings-overview']) map.setPaintProperty(layer, 'fill-extrusion-color', heights ? heightColor() : buildingAtmosphereColor(ATMOSPHERES[atmosphere.id]));
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
    manualInteraction(); cancelFocus(); cards.close();
    lens = { ...next };
    applyLens();
  }
  // 命中测试认的那几层：卡片挂点要拿它判"本体还露不露"，所以先于卡片工厂建出来。
  const extrusions = ['canton-tower-hit', 'landmark-forms-hit',
    'neighborhood-buildings', 'neighborhood-buildings-overview', 'height-estimates', 'height-unknown'];
  const cards = createCards({ map, extrusions, onClosed: () => { if (selection) { selection = null; writeHash(); } } });
  const plates = createPlates({ map, landmarkForms, reducedMotion, interrupt: () => { stopOrbit(); tour.exit(); cancelFocus(); }, openPopup: cards.openPopup });

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
  function animate(time) {
    if (!orbiting) return;
    if (previousTime !== undefined) map.rotateTo(map.getBearing() + Math.min(time - previousTime, 100) * 0.003, { duration: 0 });
    previousTime = time;
    frame = requestAnimationFrame(animate);
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
  function motionPreference() { motionApi.setMotion(!reducedMotion.matches); }
  film = createFilm({
    draw(elapsed) {
      const view = filmFrame(elapsed, { width: innerWidth, height: innerHeight });
      if (filmShot !== view.index) {
        atmosphere.set(view.shot.mood, { instant: reducedMotion.matches || filmShot < 0, duration: 3200 });
        filmShot = view.index;
      }
      map.jumpTo(view.camera);
    },
    onChange: (state) => onFilmChange?.(state),
    onExit() {
      if (!filmSaved) return;
      const saved = filmSaved;
      filmSaved = undefined;
      atmosphere.set(saved.mood, { instant: true });
      // setSky only compares supplied keys, so omitted transition keys need an explicit reset.
      map.setSky({ 'sky-color-transition': undefined, 'horizon-color-transition': undefined, 'fog-color-transition': undefined, ...saved.sky });
      lens = saved.lens;
      applyLens();
      for (const [id, visibility] of saved.layers) map.setLayoutProperty(id, 'visibility', visibility);
      if (saved.width !== innerWidth || saved.height !== innerHeight) {
        saved.camera.padding = lens.mode === 'height' ? lensPadding() : padding();
        if (landscape()) saved.camera.zoom = Math.min(saved.camera.zoom, SCENE.camera.landscapeZoom);
      }
      map.jumpTo(saved.camera);
    },
  });
  function startFilm() {
    if (film.active) return;
    tour.exit(); stopOrbit(); cancelFocus(); cards.close(); map.stop();
    filmSaved = {
      camera: { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: map.getPadding() },
      width: innerWidth, height: innerHeight,
      lens: { ...lens }, mood: atmosphere.id, sky: map.getSky(),
      layers: map.getStyle().layers.filter((layer) => layer.type === 'symbol' || layer.id === 'radius-line')
        .map((layer) => [layer.id, map.getLayoutProperty(layer.id, 'visibility') ?? 'visible']),
    };
    resetLens();
    for (const [id] of filmSaved.layers) map.setLayoutProperty(id, 'visibility', 'none');
    filmShot = -1;
    film.start(reducedMotion.matches);
  }
  function manualInteraction() { stopOrbit(); tour.exit(); film.exit(); onInteraction(); }
  function visibilityChange() {
    if (!document.hidden) return;
    if (film.active) film.pause();
    else manualInteraction();
  }
  function preferenceInteraction() {
    stopOrbit(); tour.exit();
    if (reducedMotion.matches && film.active) { film.reduce(); atmosphere.settle(); }
    onInteraction();
  }
  let wasLandscape = landscape();
  function resize() {
    const isLandscape = landscape();
    if (film.active) film.reframe();
    else if (tour.active) tour.reframe();
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
    cards.syncPill();
    writeHash();
    if (focus) focusStep();
    if (hoverPoint) hoverFrame ??= requestAnimationFrame(hoverCursor);
  });
  for (const event of ['movestart', 'dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) map.on(event, (data) => { if (data.originalEvent) manualInteraction(); });
  document.addEventListener('visibilitychange', visibilityChange);
  reducedMotion.addEventListener('change', preferenceInteraction);
  reducedMotion.addEventListener('change', motionPreference);
  window.addEventListener('resize', resize);
  map.on('remove', () => {
    filmSaved = undefined;
    film.exit();
    tour.exit();
    stopOrbit();
    motionApi.cancel();
    atmosphere.cancel();
    cancelAnimationFrame(hoverFrame);
    plates.cancel();
    clearTimeout(focus?.timer);
    document.removeEventListener('visibilitychange', visibilityChange);
    reducedMotion.removeEventListener('change', preferenceInteraction);
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
  motionApi.setMotion(!reducedMotion.matches);
  motionApi.revealHaze();
  return {
    map,
    revealHaze: motionApi.revealHaze,
    get haze() { return motionApi.hazeStatus(); },
    setAtmosphere: atmosphere.set,
    get atmosphere() { return atmosphere.status(); },
    settleAtmosphere: atmosphere.settle,
    setMotion: motionApi.setMotion,
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
    setTowerMode: motionApi.setTowerMode,
    motionStatus: motionApi.motionStatus,
    nearTraffic,
    nearTrees,
    plazaState,
    setLens,
    get lens() { return { ...lens }; },
    buildingSummary: (category = 'all') => heightSummary(buildings.features, category),
    tour,
    film,
    startFilm,
    startTour() { film.exit(); stopOrbit(); cancelFocus(); cards.close(); resetLens(); tour.start(!reducedMotion.matches); },
    setPanelOpen(open) { panelOpen = open; cards.close(); manualInteraction(); map.setLayoutProperty('poi-markers', 'visibility', open ? 'visible' : 'none'); map.easeTo({ padding: padding(), duration: reducedMotion.matches ? 0 : 400 }); },
    setPois(pois, category = 'all') {
      poiFeatures = pois; activeFilter = category;
      if (cards.hasCard() && !pois.some((poi) => poi.id === selectedPoiId && (category === 'all' || poi.category === category))) cards.close();
      map.getSource('neighborhood-pois').setData(poisGeoJSON(pois));
      map.setFilter('poi-markers', category === 'all' ? null : ['==', ['get', 'category'], category]);
    },
    showPoi(poi, content) {
      if (!poiFeatures.some((item) => item.id === poi.id) || (activeFilter !== 'all' && activeFilter !== poi.category)) return;
      manualInteraction(); selectedPoiId = poi.id;
      cards.openPopup([{ lngLat: [poi.lng, poi.lat], anchor: undefined }], content, { closeLabel: '关闭地点卡片' });
      map.easeTo({ center: [poi.lng, poi.lat], padding: padding(), duration: reducedMotion.matches ? 0 : 700 });
    },
    showBuilding(building, content) {
      manualInteraction();
      const blockId = buildingId(building.properties.osmId) || undefined;
      cards.openPopup(buildingSeats(building.outline.geometry, building.lngLat, blockId), content, {
        outline: selectionOutline(building.outline),
        closeLabel: '关闭建筑卡片',
        blockId,
      });
    },
    focusBuilding,
    startOrbit() {
      film.exit(); tour.exit(); stopOrbit(); cards.close(); map.stop(); cancelFocus();
      map.jumpTo({ center, zoom: landscape() ? Math.max(14, Math.min(map.getZoom(), 14.4)) : Math.max(14.6, Math.min(map.getZoom(), 15.7)), pitch: 58, padding: padding() });
      orbiting = true; frame = requestAnimationFrame(animate);
    },
    stopOrbit,
    hasCard: cards.hasCard,
    closeCard: cards.close,
    recenter() { film.exit(); tour.exit(); stopOrbit(); cancelFocus(); cards.close(); map.flyTo({ ...heroCamera(), duration: reducedMotion.matches ? 0 : 1200 }); },
    overview() {
      film.exit(); tour.exit(); stopOrbit(); cancelFocus(); cards.close();
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
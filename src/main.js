import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { buildingLabel, categoryLabels, formatAddress, placeLabel } from './buildings.js';
import { DEFAULT_CENTER, POI_CATEGORIES, SCENE } from './config.js';
import { ATMOSPHERES } from './atmosphere.js';
import { formatCoordinates } from './geo.js';
import { iconSvg } from './icons.js';
import { createNeighborhoodMap } from './map.js';
import { createPoiService } from './pois.js';
import { loadSearchIndex, searchBuildings } from './search.js';
import { TOUR_STOPS } from './tour.js';
import { HEIGHT_BINS } from './lens.js';

const $ = (id) => document.getElementById(id);
// V8 的渲染层开关：不带参数就是现版 MapLibre 路径，逐字节不变；`?engine=three` 挂新引擎。
const ENGINE = new URLSearchParams(globalThis.location?.search ?? '').get('engine') === 'three' ? 'three' : 'maplibre';
const centerName = SCENE.name;
const radiusKm = SCENE.radius / 1000;
const service = createPoiService();
document.body.dataset.scene = SCENE.id;
document.title = `街区切片 · ${SCENE.title}`;
$('tour-route').setAttribute('aria-label', `${TOUR_STOPS.length} 站镜头路线`);
for (const [category, color] of Object.entries(ATMOSPHERES[document.body.dataset.atmosphere].buildings)) document.querySelector(`#building-legend .${category}`).style.backgroundColor = color;
$('coordinates').textContent = `${formatCoordinates(DEFAULT_CENTER)} / WGS 84`;
let pois = [], totalPois = 0, filter = 'all', poiState = 'idle', placesOpen = false;
export let neighborhood;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLens(lens, summary) {
  const heights = lens.mode === 'height';
  document.body.dataset.lens = lens.mode;
  $('height-panel').hidden = !heights;
  for (const button of $('lens-modes').children) button.setAttribute('aria-pressed', String(button.dataset.lensMode === lens.mode));
  for (const button of $('building-legend').children) button.setAttribute('aria-pressed', String(button.dataset.buildingCategory === lens.category));
  for (const button of $('height-sources').children) {
    const source = button.dataset.heightSource;
    button.setAttribute('aria-pressed', String(source === lens.source));
    button.querySelector('span').textContent = summary.sources[source].toLocaleString('zh-CN');
  }
  const count = lens.source === 'all' ? summary.total : summary.sources[lens.source];
  $('lens-summary').textContent = `${categoryLabels[lens.category] ?? '全部用途'} · ${count.toLocaleString('zh-CN')} 个要素`;
  $('lens-reset').disabled = lens.category === 'all' && lens.source === 'all';
  const bins = summary.bins.map(bin => ({ height: ['all', 'height'].includes(lens.source) ? bin.height : 0, levels: ['all', 'levels'].includes(lens.source) ? bin.levels : 0 }));
  const max = Math.max(1, ...bins.map(bin => bin.height + bin.levels));
  const chart = document.createDocumentFragment();
  for (const [index, bin] of bins.entries()) {
    const spec = HEIGHT_BINS[index];
    const item = element('li');
    item.style.setProperty('--bin-color', spec.color);
    item.setAttribute('aria-label', `${spec.label} 米：OSM 标注 ${bin.height}，按层数估算 ${bin.levels}`);
    const bars = element('div', 'height-bars');
    bars.setAttribute('aria-hidden', 'true');
    for (const source of ['levels', 'height']) {
      const bar = element('i', `height-bar ${source}`);
      bar.style.height = `${bin[source] / max * 100}%`;
      bars.append(bar);
    }
    item.append(element('span', 'height-count', String(bin.height + bin.levels)), bars, element('span', 'height-label', spec.label));
    chart.append(item);
  }
  $('height-chart').replaceChildren(chart);
  $('building-note').textContent = heights ? '标注≠实测 · 估算按层数×3.2m\n未知只画轮廓 · 示意塔身不计入统计'
    : '点击用途筛选 · 高度含估算\n统计建筑/部件，不含塔身与圈外背景';
}

function setExploreMode() {
  $('explore-button').setAttribute('aria-pressed', 'true');
  $('orbit-button').setAttribute('aria-pressed', 'false');
}

for (const stop of TOUR_STOPS) $('tour-route').append(element('li', '', stop.name));
function renderTour({ index, playing, travelling }) {
  const restoreFocus = $('tour-player').contains(document.activeElement);
  const active = index >= 0;
  document.body.dataset.tour = active ? 'open' : 'closed';
  $('tour-player').hidden = !active;
  if (!active) {
    setExploreMode();
    if (restoreFocus) $('tour-start').focus({ preventScroll: true });
    return;
  }
  const stop = TOUR_STOPS[index];
  $('tour-title').textContent = stop.name;
  $('tour-position').textContent = `${stop.bank} / ${String(index + 1).padStart(2, '0')}`;
  $('tour-description').textContent = stop.description;
  $('tour-previous').disabled = index === 0;
  $('tour-play').textContent = playing ? '暂停' : '继续';
  $('tour-play').setAttribute('aria-label', playing ? '暂停导览' : '继续导览');
  $('tour-next').textContent = index === TOUR_STOPS.length - 1 ? '完成导览' : '下一站 →';
  $('tour-status').textContent = !playing ? '已暂停' : travelling ? '前往这一站' : '自动播放';
  [...$('tour-route').children].forEach((node, position) => {
    if (position === index) node.setAttribute('aria-current', 'step');
    else node.removeAttribute('aria-current');
  });
}

function distanceLabel(distance) {
  return distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`;
}

function showPoi(id) {
  const poi = pois.find((item) => item.id === id);
  if (!poi) return;
  const card = element('article', 'poi-card');
  card.append(element('span', 'eyebrow', `${poi.label} · 距${centerName} ${poi.distance} m`), element('h3', '', poi.name));
  if (poi.address) card.append(element('p', 'poi-address', poi.address));
  if (poi.openingHours) card.append(element('p', 'poi-hours', `营业时间（OSM）：${poi.openingHours}`));
  const link = element('a', 'osm-link', '在 OpenStreetMap 查看 ↗');
  link.href = poi.osmUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  card.append(link, element('small', 'poi-source', '信息来自开放地图，开放时间以现场为准。'));
  neighborhood.showPoi(poi, card);
  for (const item of $('poi-list').children) item.classList.toggle('selected', item.dataset.id === id);
}

function meters(value) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}`;
}

function buildingFacts(props, display) {
  const type = props.type ? buildingLabel(props.type) ?? props.type : '';
  const place = props.place ? placeLabel(props.place) ?? props.place : '';
  if (props.tower) return ['通信观光塔 · 三维塔身为参数化示意模型',
    ...(props.street ? [`地址：${props.street}`] : []),
    ...(props.built ? [`建成：${props.built}`] : [])];
  // The category is already the card's eyebrow, so this line only adds what the category does not say.
  const what = [type, place].filter(Boolean).join(' · ');
  const facts = what ? [what] : [];
  facts.push(props.heightSource === 'height' ? `高度 ${meters(props.height)} m（OSM 标注）`
    : props.heightSource === 'levels' ? `高度约 ${meters(props.height)} m（按 ${props.levels} 层估算）`
    : neighborhood.lens.mode === 'height' ? '高度未知，此视图仅显示平面轮廓'
      : display ? `高度未标注；模型厚度 ${meters(display.displayHeight - display.base)} m（按体块短边设置），不代表实际楼高。`
        : props.displayHeight != null ? `高度未标注；模型厚度 ${meters(props.displayHeight - props.base)} m（按轮廓短边设置），不代表实际楼高。`
          : '高度未标注，按默认 9.6 m 绘制');
  if (props.base > 0) facts.push(`底部起算高度 ${meters(props.base)} m`);
  facts.push(`占地约 ${Number(props.area).toLocaleString('zh-CN')} m²`);
  if (props.street) facts.push(`地址：${formatAddress(props.street, props.house)}`);
  if (props.built) facts.push(`建成：${props.built}`);
  return facts;
}

function showBuilding(target) {
  const props = target.properties;
  const unnamed = props.type ? buildingLabel(props.type) ?? props.type : categoryLabels[props.category] ?? '建筑';
  const card = element('article', 'poi-card building-card');
  card.append(element('span', 'eyebrow', props.tower ? `${centerName} · 场景中心` : `${categoryLabels[props.category] ?? categoryLabels.unknown} · 距${centerName} ${props.distance} m`));
  card.append(element('h3', '', props.name ?? `${unnamed}（OSM 未标注名称）`));
  if (props.nameEn) card.append(element('p', 'building-name-en', props.nameEn));
  if (target.displayOutline?.properties.schematic) card.append(element('p', 'building-fact', '当前为规整示意轮廓；高度视图可查看来源轮廓。'));
  for (const fact of buildingFacts(props, target.displayOutline?.properties)) card.append(element('p', 'building-fact', fact));
  const identity = String(props.osmId);
  const osmId = Number(identity.replace(/^relation\//, ''));
  if (/^(?:relation\/)?\d+$/.test(identity) && Number.isSafeInteger(osmId) && osmId > 0) {
    const link = element('a', 'osm-link', '在 OpenStreetMap 查看 ↗');
    link.href = `https://www.openstreetmap.org/${identity.startsWith('relation/') ? 'relation' : 'way'}/${osmId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    card.append(link);
  }
  card.append(element('small', 'poi-source', props.tower ? '轮廓来自 OpenStreetMap（ODbL），塔身为示意重建。'
    : '数据来自 OpenStreetMap 建筑快照（ODbL），高度含估算值。'));
  neighborhood.showBuilding(target, card);
}

function renderPois() {
  const filtered = pois.filter((poi) => filter === 'all' || poi.category === filter);
  $('poi-count').textContent = poiState === 'loading' ? '正在查找' : poiState === 'error' ? '尚未加载' : `${filtered.length} 处`;
  const fragment = document.createDocumentFragment();
  for (const poi of filtered) {
    const button = element('button', 'poi-item');
    button.dataset.id = poi.id;
    const icon = element('span', `poi-icon ${poi.category}`);
    icon.innerHTML = iconSvg(POI_CATEGORIES[poi.category].icon);
    const text = element('span', 'poi-text');
    text.append(element('strong', '', poi.name), element('small', '', poi.label));
    button.append(icon, text, element('span', 'poi-distance', distanceLabel(poi.distance)));
    button.addEventListener('click', () => showPoi(poi.id));
    fragment.append(button);
  }
  $('poi-list').replaceChildren(fragment);
  neighborhood?.setPois(placesOpen ? pois : [], filter);
  for (const button of $('category-filters').children) button.setAttribute('aria-pressed', String(button.dataset.category === filter));
  if (poiState !== 'ready') return;
  $('poi-status').classList.remove('is-error');
  $('poi-status').textContent = !pois.length ? '3 公里内未查到这些类别的地点，开放地图可能尚未收录。' : !filtered.length ? '当前结果中没有这一类地点，试试其他类别。' : totalPois > pois.length ? `3 公里内收录 ${totalPois} 处，显示最近的 ${pois.length} 处。` : '广州塔周边 3 公里 · 已加载，重复打开无需查询。';
}

async function loadPois() {
  // Successful results stay in memory; failed requests remain retryable.
  if (poiState === 'loading' || poiState === 'ready') return;
  poiState = 'loading';
  renderPois();
  $('poi-status').textContent = `正在查询 ${radiusKm} 公里内的地点；地图可继续浏览。`;
  $('poi-status').classList.remove('is-error');
  $('retry-pois').hidden = true;
  try {
    const result = await service.load(DEFAULT_CENTER);
    pois = result.pois;
    totalPois = result.total;
    poiState = 'ready';
    renderPois();
  } catch (error) {
    poiState = 'error';
    renderPois();
    $('poi-status').textContent = error.message;
    $('poi-status').classList.add('is-error');
    $('retry-pois').hidden = false;
  }
}

function togglePlaces(open) {
  placesOpen = open;
  document.body.dataset.places = open ? 'open' : 'closed';
  $('poi-panel').hidden = !open;
  $('places-toggle').setAttribute('aria-expanded', String(open));
  neighborhood.setPanelOpen(open);
  renderPois();
  if (open && poiState === 'idle') loadPois();
  if (!open) $('places-toggle').focus({ preventScroll: true });
}

const SEARCH_LIMIT = 8;
let searchEntries = null, searchLoading = null, searchResults = [], searchActive = -1;
const searchOpen = () => !$('search-panel').hidden;

function searchStatus(text, error = false) {
  $('search-status').textContent = text;
  $('search-status').classList.toggle('is-error', error);
}

function resultNote(entry) {
  const where = formatAddress(entry.street, entry.house) || (categoryLabels[entry.category] ?? categoryLabels.unknown);
  const size = entry.tower ? '三维示意塔身'
    : entry.heightSource === 'height' ? `高 ${entry.height} m`
    : entry.heightSource === 'levels' ? `高约 ${entry.height} m`
    : '高度未标注';
  return `${where} · ${size} · 距${centerName} ${entry.distance} m`;
}

function setResults(matches) {
  searchResults = matches;
  searchActive = -1;
  const fragment = document.createDocumentFragment();
  for (const [index, entry] of matches.entries()) {
    const option = element('li', 'search-option');
    option.id = `search-option-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.append(element('strong', '', entry.name || '未命名楼块'), element('small', '', resultNote(entry)));
    option.addEventListener('click', () => chooseEntry(entry, option));
    fragment.append(option);
  }
  $('search-results').replaceChildren(fragment);
  $('search-input').setAttribute('aria-expanded', String(Boolean(matches.length)));
  $('search-input').removeAttribute('aria-activedescendant');
}

function chooseEntry(entry, option) {
  for (const item of $('search-results').children) item.toggleAttribute('chosen', item === option);
  // The card itself is opened by the map once the camera has settled on the block's own footprint point.
  neighborhood.focusBuilding({ osmId: entry.osmId, lat: entry.lat, lng: entry.lng });
}

function moveActive(step) {
  const options = [...$('search-results').children];
  if (!options.length) return;
  searchActive = (searchActive + step + options.length) % options.length;
  options.forEach((option, index) => option.setAttribute('aria-selected', String(index === searchActive)));
  $('search-input').setAttribute('aria-activedescendant', options[searchActive].id);
  options[searchActive].scrollIntoView({ block: 'nearest' });
}

async function runSearch() {
  if (!$('search-input').value.trim()) { setResults([]); searchStatus(''); return; }
  if (!searchEntries) {
    searchStatus('正在载入楼名与地址索引…');
    searchLoading ??= loadSearchIndex(globalThis.fetch, `${import.meta.env.BASE_URL}data/${SCENE.index}`);
    try {
      searchEntries = await searchLoading;
    } catch (error) {
      searchLoading = null;
      setResults([]);
      searchStatus(error.message, true);
      return;
    }
  }
  const query = $('search-input').value;
  const matches = searchBuildings(searchEntries, query, SEARCH_LIMIT);
  setResults(matches);
  searchStatus(matches.length
    ? `${matches.length === SEARCH_LIMIT ? `前 ${SEARCH_LIMIT} 个匹配` : `${matches.length} 个匹配`} · 方向键选择，回车定位`
    : '索引里没有匹配的楼名或地址，换一个关键字试试。');
}

function toggleSearch(open) {
  document.body.dataset.search = open ? 'open' : 'closed';
  $('search-panel').hidden = !open;
  $('search-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('search-input').focus();
    if (searchEntries) runSearch();
    else searchStatus('输入楼名、路名或门牌开始查找。');
    return;
  }
  $('search-input').value = '';
  setResults([]);
  searchStatus('');
  $('search-toggle').focus({ preventScroll: true });
}

for (const [category, label] of [['all', '全部'], ...Object.entries(POI_CATEGORIES).map(([key, value]) => [key, value.label])]) {
  const button = element('button', '', label);
  button.dataset.category = category;
  button.setAttribute('aria-pressed', String(category === filter));
  button.addEventListener('click', () => { filter = category; renderPois(); });
  $('category-filters').append(button);
}
$('places-toggle').addEventListener('click', () => togglePlaces(!placesOpen));
$('close-places').addEventListener('click', () => togglePlaces(false));
$('search-toggle').addEventListener('click', () => toggleSearch(!searchOpen()));
$('search-input').addEventListener('input', runSearch);
$('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
  if (event.key === 'Enter') {
    event.preventDefault();
    const index = searchActive < 0 ? 0 : searchActive;
    const entry = searchResults[index];
    if (entry) chooseEntry(entry, $('search-results').children[index]);
    return;
  }
  if (event.key !== 'Escape') return;
  // Esc steps out of the search one layer at a time: results first, then the panel, and only then the card below.
  event.stopPropagation();
  event.preventDefault();
  if (searchResults.length || $('search-input').value) {
    $('search-input').value = '';
    setResults([]);
    searchStatus('');
  } else toggleSearch(false);
});
$('retry-pois').addEventListener('click', loadPois);
$('reload-map').addEventListener('click', () => location.reload());
for (const button of $('building-legend').children) button.addEventListener('click', () => {
  const lens = neighborhood.lens;
  neighborhood.setLens({ ...lens, category: lens.category === button.dataset.buildingCategory ? 'all' : button.dataset.buildingCategory });
});
for (const button of $('lens-modes').children) button.addEventListener('click', () => {
  if (neighborhood.lens.mode === button.dataset.lensMode) return;
  neighborhood.setLens({ ...neighborhood.lens, mode: button.dataset.lensMode, source: 'all' });
  if (button.dataset.lensMode === 'height') neighborhood.overview();
});
for (const button of $('height-sources').children) button.addEventListener('click', () => {
  const lens = neighborhood.lens;
  neighborhood.setLens({ ...lens, source: lens.source === button.dataset.heightSource ? 'all' : button.dataset.heightSource });
});
$('lens-reset').addEventListener('click', () => neighborhood.setLens({ ...neighborhood.lens, category: 'all', source: 'all' }));
for (const button of $('atmosphere-controls').querySelectorAll('button[data-atmosphere-option]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.atmosphereOption;
    if (document.body.dataset.atmosphere === id) return;
    neighborhood.setAtmosphere(id);
    document.body.dataset.atmosphere = id;
    for (const option of $('atmosphere-controls').querySelectorAll('button[data-atmosphere-option]')) option.setAttribute('aria-pressed', String(option === button));
    for (const [category, color] of Object.entries(ATMOSPHERES[id].buildings)) document.querySelector(`#building-legend .${category}`).style.backgroundColor = color;
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--page').trim();
  });
}
// The motion switch is a `role="switch"`, so it reports through aria-checked and never joins the atmosphere group's
// single pressed option. The map owns the state, because a reduced-motion preference can turn it off before any click.
function renderMotion(status) {
  $('motion-toggle').setAttribute('aria-checked', String(status.on));
  document.body.dataset.motion = status.on ? 'on' : 'off';
  // The tower has two night lighting schemes and only the scene with a tower in it can choose between them.
  const group = $('tower-light');
  group.hidden = !status.available;
  for (const button of group.children) button.setAttribute('aria-pressed', String(button.dataset.towerLight === status.towerMode));
}
$('motion-toggle').addEventListener('click', () => neighborhood.setMotion(!neighborhood.motionStatus().on));
for (const button of $('tower-light').children) {
  button.addEventListener('click', () => renderMotion(neighborhood.setTowerMode(button.dataset.towerLight)));
}
$('tour-start').addEventListener('click', () => {
  if (placesOpen) togglePlaces(false);
  if (searchOpen()) toggleSearch(false);
  setExploreMode();
  neighborhood.startTour();
  $('tour-play').focus({ preventScroll: true });
});
$('tour-previous').addEventListener('click', () => neighborhood.tour.step(-1));
$('tour-next').addEventListener('click', () => neighborhood.tour.step(1));
$('tour-play').addEventListener('click', () => neighborhood.tour.toggle());
$('tour-exit').addEventListener('click', () => neighborhood.tour.exit());
$('explore-button').addEventListener('click', () => { neighborhood.tour.exit(); neighborhood.stopOrbit(); setExploreMode(); });
$('orbit-button').addEventListener('click', () => { neighborhood.startOrbit(); $('explore-button').setAttribute('aria-pressed', 'false'); $('orbit-button').setAttribute('aria-pressed', 'true'); });
$('recenter-button').addEventListener('click', () => { neighborhood.recenter(); setExploreMode(); });
$('overview-button').addEventListener('click', () => { neighborhood.overview(); setExploreMode(); });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (neighborhood?.tour.active) return neighborhood.tour.exit();
  if (neighborhood?.hasCard()) return neighborhood.closeCard();
  if (placesOpen) togglePlaces(false);
  else if (searchOpen()) toggleSearch(false);
});

try {
  if (ENGINE === 'three') {
    // Phase 0 只换渲染层的心脏：相机、光照、FPS 面板、hash，Phase 1 把地面四层与全量 3,990 栋体块接上了。
    // 业务功能按文档要到 Phase 4 才回迁，所以除氛围与两个镜头按钮之外的控件保持禁用 —— 点亮一个会抛 TypeError 的
    // 按钮比留着灰的更糟。
    const { bootThreeEngine } = await import('./engine/boot.js');
    neighborhood = await bootThreeEngine({
      container: $('map'), mode: document.body.dataset.atmosphere ?? 'day',
    });
    $('map-message').hidden = true;
    // The motion switch answers too since 项 5: the engine drives the same near field and the same cross-fade clock
    // off the same 120 ms tick. What it still cannot answer is the tower's three lighting schemes - there is no tower
    // model in that scene yet - so `#tower-light` stays hidden and every button in it stays disabled.
    for (const button of document.querySelectorAll('#atmosphere-controls button[data-atmosphere-option], #recenter-button, #overview-button, #motion-toggle')) button.disabled = false;
    // 这一侧还缺什么，写在界面上而不是只写在源码注释里（用户 2026-10-10 那句"灰着但不给理由"）。
    // 三件事：灰掉的按钮各带一句原因；手势那一行改成这一侧真的会做的事（"点击楼块查看"在这里是不成立的）；
    // 再加一行点名缺的整块。缩放这一格原来根本没有——MapLibre 那对 ＋－ 是它自带的控件，这一侧没有 MapLibre。
    for (const [id, reason] of [
      ['places-toggle', '地点清单还没接进这一侧'],
      ['search-toggle', '楼名与地址检索还没接进这一侧'],
      ['tour-start', '导览走的是逐栋飞镜头，这一侧还没有可点的楼块'],
      ['explore-button', '这一侧的视角由拖动直接控制，没有探索/环绕两档'],
      ['orbit-button', '这一侧的视角由拖动直接控制，没有探索/环绕两档'],
    ]) {
      const control = $(id);
      if (control) control.title = `新引擎预览：${reason}`;
    }
    for (const key of document.querySelectorAll('.scene-key button')) key.title = '新引擎预览：高度透视镜还没接进这一侧';
    $('gesture-hint').replaceChildren('拖动平移 ', element('span', '', '·'), ' ⌥ 或 右键拖动旋转 ', element('span', '', '·'),
      ' 滚轮或 ＋－ 缩放');
    const engineNote = element('p', 'engine-note', '新引擎预览：已接 地面、楼块、近场车流、三塔壳体与桥；还缺 树、广场地面、点击出卡片、检索与导览。');
    $('gesture-hint').after(engineNote);
    const stepZoom = (delta) => {
      const view = neighborhood.view();
      // 限幅在相机自己手里（`clampZoom` 读 `VIEW_LIMITS`），这里只负责交一个层级差。
      neighborhood.setView({ ...view, zoom: view.zoom + delta });
    };
    const zoomGroup = element('span', 'zoom-controls');
    zoomGroup.setAttribute('role', 'group');
    zoomGroup.setAttribute('aria-label', '缩放');
    for (const [glyph, label, delta] of [['＋', '放大一级', 1], ['－', '缩小一级', -1]]) {
      const button = element('button', 'zoom-step', glyph);
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', () => stepZoom(delta));
      zoomGroup.append(button);
    }
    $('view-controls').append(element('span', 'control-divider'), zoomGroup);
    const engineMotion = neighborhood.motionStatus();
    $('motion-toggle').setAttribute('aria-checked', String(engineMotion.on));
    document.body.dataset.motion = engineMotion.on ? 'on' : 'off';
    for (const option of $('atmosphere-controls').querySelectorAll('button[data-atmosphere-option]')) {
      option.setAttribute('aria-pressed', String(option.dataset.atmosphereOption === (document.body.dataset.atmosphere ?? 'day')));
    }
  } else {
    neighborhood = await createNeighborhoodMap({
      onPoiClick: showPoi,
      onBuildingClick: showBuilding,
      onInteraction: setExploreMode,
      onTourChange: renderTour,
      onLensChange: renderLens,
      onMotionChange: renderMotion,
      onError: () => {
        $('map-error-text').textContent = '部分地图数据未能加载。若地图缺块，请检查网络后重新加载。';
        $('map-error').hidden = false;
      },
    });
    $('map-message').hidden = true;
    for (const button of document.querySelectorAll('#places-toggle, #search-toggle, #overview-button, #tour-start, #view-controls button, #atmosphere-controls button, #tower-light button, .scene-key button')) button.disabled = false;
    renderLens(neighborhood.lens, neighborhood.buildingSummary());
  }
} catch (error) {
  $('map-message').hidden = true;
  $('map-error-text').textContent = error.name === 'TimeoutError' ? '地图连接超时，请检查网络后重新加载。' : error.message;
  $('map-error').hidden = false;
}

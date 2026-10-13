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
const isSchool = SCENE.id === 'jingtai';
const centerName = isSchool ? '景泰小学' : SCENE.name;
const radiusKm = SCENE.radius / 1000;
const service = isSchool ? null : createPoiService();
document.body.dataset.scene = SCENE.id;
document.title = `街区切片 · ${SCENE.title}`;
for (const link of $('scene-nav').querySelectorAll('a')) {
  if (link.dataset.sceneLink === SCENE.id) link.setAttribute('aria-current', 'page');
  else link.removeAttribute('aria-current');
}
if (isSchool) {
  document.querySelector('meta[name="description"]').content = `${SCENE.name}，云龙路38号。探索白云山脚下周边${radiusKm}公里的真实地图快照。`;
  $('map').setAttribute('aria-label', `${SCENE.name}周边${radiusKm}公里三维地图，可拖动、旋转和缩放`);
  document.querySelector('.brand').href = '?scene=jingtai';
  document.querySelector('.edition').textContent = '广州 · 景泰小学 / 三维街区观察';
  document.querySelector('.scene-intro .eyebrow').textContent = 'GUANGZHOU · JINGTAI SCHOOL';
  document.querySelector('h1').textContent = '山脚下的小学';
  document.querySelector('.intro-copy').textContent = '云龙路38号，白云山脚下的街区。';
  const coverage = element('p', 'school-data-note', '校园操场轮廓未收录；山地仅显示范围。');
  document.querySelector('.scene-intro').append(coverage);
  document.querySelector('.scene-range > span:last-child').replaceChildren('景泰小学周边 ', element('strong', '', String(radiusKm)), ' 公里');
  $('tour-start').firstChild.textContent = '山脚下的小学导览 ';
  $('tour-player').setAttribute('aria-label', '山脚下的小学主题导览');
  document.querySelector('.poi-heading .eyebrow').textContent = '街区尺度的生活配套';
  document.querySelector('.panel-note').textContent = '距景泰小学直线距离 · 校门路网缺失，步行暂缺';
  document.querySelector('.search-label').textContent = '校名、楼名或街道地址';
  $('search-panel').setAttribute('aria-label', '校名、楼名与地址检索');
  $('search-toggle').setAttribute('aria-label', '搜索校名与地址');
  $('search-toggle').querySelector('span').textContent = '搜索校名';
  $('search-input').placeholder = '例：景泰小学（景泰校区）、云龙路38号';
  $('map-message').replaceChildren(element('span', 'loading-dot'), '正在展开景泰街区…');
  document.querySelector('.lens-heading small').textContent = `${radiusKm} km`;
  $('building-note').textContent = '未知高度默认 9.6 m，仅作示意；高度模式只画轮廓。';
  $('recenter-button').textContent = '回到景泰小学';
}
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
  $('building-note').textContent = isSchool
    ? heights ? '标注≠实测 · 估算按层数×3.2m\n未知只画轮廓 · 校园用地不计入建筑统计'
      : '未知高度默认 9.6 m，仅作示意\n统计建筑/部件，不含校园用地与圈外背景'
    : heights ? '标注≠实测 · 估算按层数×3.2m\n未知只画轮廓 · 示意塔身不计入统计'
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

function walkingLabel(poi) {
  return Number.isFinite(poi.walkingDistance) && poi.walkingDistance >= 0
    ? `步行约 ${distanceLabel(poi.walkingDistance)}` : '步行距离暂缺';
}

function showPoi(id) {
  const poi = pois.find((item) => item.id === id);
  if (!poi) return;
  const card = element('article', 'poi-card');
  card.append(element('span', 'eyebrow', `${poi.label} · 距${centerName}${isSchool ? '直线' : ''} ${poi.distance} m`), element('h3', '', poi.name));
  if (isSchool && poi.category === 'transit') {
    card.append(element('p', 'building-fact', walkingLabel(poi)), element('small', 'poi-source walking-note', poi.walkingUnavailable || 'OSM可步行路网估算，非实时导航，通行以现场为准'));
  }
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

function buildingFacts(props) {
  const type = props.type ? buildingLabel(props.type) ?? props.type : '';
  const place = props.place ? placeLabel(props.place) ?? props.place : '';
  if (props.campus) return ['校园用地 · 轮廓来自 OpenStreetMap',
    `地址：${formatAddress(props.street, props.house) || '云龙路38号'}`,
    '暖黄标示校园用地；OSM 未收录校内操场轮廓，未补画。'];
  if (props.tower) return ['通信观光塔 · 三维塔身为参数化示意模型',
    ...(props.street ? [`地址：${props.street}`] : []),
    ...(props.built ? [`建成：${props.built}`] : [])];
  // The category is already the card's eyebrow, so this line only adds what the category does not say.
  const what = [type, place].filter(Boolean).join(' · ');
  const facts = what ? [what] : [];
  facts.push(props.heightSource === 'height' ? `高度 ${meters(props.height)} m（OSM 标注）`
    : props.heightSource === 'levels' ? `高度约 ${meters(props.height)} m（按 ${props.levels} 层估算）`
    : neighborhood.lens.mode === 'height' ? '高度未知，此视图仅显示平面轮廓' : `高度未标注，按默认 9.6 m 绘制${isSchool ? '，仅作示意' : ''}`);
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
  card.append(element('span', 'eyebrow', props.campus || props.tower ? `${centerName} · 场景中心` : `${categoryLabels[props.category] ?? categoryLabels.unknown} · 距${centerName}${isSchool ? '直线' : ''} ${props.distance} m`));
  card.append(element('h3', '', props.name ?? `${unnamed}（OSM 未标注名称）`));
  if (props.nameEn) card.append(element('p', 'building-name-en', props.nameEn));
  for (const fact of buildingFacts(props)) card.append(element('p', 'building-fact', fact));
  const identity = String(props.osmId);
  const osmId = Number(identity.replace(/^relation\//, ''));
  if (/^(?:relation\/)?\d+$/.test(identity) && Number.isSafeInteger(osmId) && osmId > 0) {
    const link = element('a', 'osm-link', '在 OpenStreetMap 查看 ↗');
    link.href = `https://www.openstreetmap.org/${identity.startsWith('relation/') ? 'relation' : 'way'}/${osmId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    card.append(link);
  }
  card.append(element('small', 'poi-source', props.campus ? '数据来自 OpenStreetMap 校园用地快照（ODbL）。' : props.tower ? '轮廓来自 OpenStreetMap（ODbL），塔身为示意重建。' : '数据来自 OpenStreetMap 建筑快照（ODbL），高度含估算值。'));
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
    const label = isSchool && poi.category === 'transit' ? `${poi.label} · 直线 ${distanceLabel(poi.distance)}` : poi.label;
    text.append(element('strong', '', poi.name), element('small', '', label));
    const distance = isSchool ? poi.category === 'transit' ? walkingLabel(poi) : `直线 ${distanceLabel(poi.distance)}` : distanceLabel(poi.distance);
    button.append(icon, text, element('span', 'poi-distance', distance));
    button.addEventListener('click', () => showPoi(poi.id));
    fragment.append(button);
  }
  $('poi-list').replaceChildren(fragment);
  neighborhood?.setPois(placesOpen ? pois : [], filter);
  for (const button of $('category-filters').children) button.setAttribute('aria-pressed', String(button.dataset.category === filter));
  if (poiState !== 'ready') return;
  $('poi-status').classList.remove('is-error');
  $('poi-status').textContent = isSchool
    ? `${radiusKm} 公里内收录 ${totalPois} 处 · ${!pois.length ? '开放地图暂未收录' : !filtered.length ? '此分类暂无地点' : '已全部加载'}`
    : !pois.length ? '3 公里内未查到这些类别的地点，开放地图可能尚未收录。' : !filtered.length ? '当前结果中没有这一类地点，试试其他类别。' : totalPois > pois.length ? `3 公里内收录 ${totalPois} 处，显示最近的 ${pois.length} 处。` : '广州塔周边 3 公里 · 已加载，重复打开无需查询。';
}

async function loadSchoolPois() {
  let response;
  try {
    response = await fetch(`${import.meta.env.BASE_URL}data/${SCENE.pois}`, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? '街区地点加载超时，请重新加载地点。' : '暂时无法加载街区地点，请检查网络后重试。');
  }
  if (!response.ok) throw new Error(`街区地点暂时不可用（HTTP ${response.status}），请重试。`);
  const result = await response.json().catch(() => null);
  if (!Array.isArray(result?.pois) || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('街区地点数据不完整，请重新加载地点。');
  return result;
}

async function loadPois() {
  // Successful results stay in memory; failed requests remain retryable.
  if (poiState === 'loading' || poiState === 'ready') return;
  poiState = 'loading';
  renderPois();
  $('poi-status').textContent = `正在${isSchool ? '加载' : '查询'} ${radiusKm} 公里内的地点；地图可继续浏览。`;
  $('poi-status').classList.remove('is-error');
  $('retry-pois').hidden = true;
  try {
    const result = isSchool ? await loadSchoolPois() : await service.load(DEFAULT_CENTER);
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
  const size = entry.campus ? '校园轮廓（非建筑高度）' : entry.tower ? '三维示意塔身'
    : entry.heightSource === 'height' ? `高 ${entry.height} m`
    : entry.heightSource === 'levels' ? `高约 ${entry.height} m`
    : '高度未标注';
  return `${where} · ${size} · 距${centerName}${isSchool ? '直线' : ''} ${entry.distance} m`;
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
    searchStatus(isSchool ? '正在载入校名、楼名与地址索引…' : '正在载入楼名与地址索引…');
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
  // Numeric house fields omit the written 号 suffix; accept the full school address without changing the index.
  const query = isSchool ? $('search-input').value.replace(/(\d)\s*号\s*$/, '$1') : $('search-input').value;
  const matches = searchBuildings(searchEntries, query, SEARCH_LIMIT);
  setResults(matches);
  searchStatus(matches.length
    ? `${matches.length === SEARCH_LIMIT ? `前 ${SEARCH_LIMIT} 个匹配` : `${matches.length} 个匹配`} · 方向键选择，回车定位`
    : `索引里没有匹配的${isSchool ? '校名、楼名' : '楼名'}或地址，换一个关键字试试。`);
}

function toggleSearch(open) {
  document.body.dataset.search = open ? 'open' : 'closed';
  $('search-panel').hidden = !open;
  $('search-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    $('search-input').focus();
    if (searchEntries) runSearch();
    else searchStatus(`输入${isSchool ? '校名、' : ''}楼名、路名或门牌开始查找。`);
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
for (const button of $('atmosphere-controls').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    const id = button.dataset.atmosphereOption;
    if (document.body.dataset.atmosphere === id) return;
    neighborhood.setAtmosphere(id);
    document.body.dataset.atmosphere = id;
    for (const option of $('atmosphere-controls').querySelectorAll('button')) option.setAttribute('aria-pressed', String(option === button));
    for (const [category, color] of Object.entries(ATMOSPHERES[id].buildings)) document.querySelector(`#building-legend .${category}`).style.backgroundColor = color;
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--page').trim();
  });
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
  neighborhood = await createNeighborhoodMap({
    onPoiClick: showPoi,
    onBuildingClick: showBuilding,
    onInteraction: setExploreMode,
    onTourChange: renderTour,
    onLensChange: renderLens,
    onError: () => {
      $('map-error-text').textContent = '部分地图数据未能加载。若地图缺块，请检查网络后重新加载。';
      $('map-error').hidden = false;
    },
  });
  $('map-message').hidden = true;
  for (const button of document.querySelectorAll('#places-toggle, #search-toggle, #overview-button, #tour-start, #view-controls button, #atmosphere-controls button, .scene-key button')) button.disabled = false;
  renderLens(neighborhood.lens, neighborhood.buildingSummary());
} catch (error) {
  $('map-message').hidden = true;
  $('map-error-text').textContent = error.name === 'TimeoutError' ? '地图连接超时，请检查网络后重新加载。' : error.message;
  $('map-error').hidden = false;
}

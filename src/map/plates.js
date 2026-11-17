// 六枚地标名牌（#219 从 map.js 拆出）：剪影按钮、拥挤避让、地标卡片与"飞过去"。
// 开卡片要打断的那几件事（环绕/导览/深链等待）与挂点测量都由 map.js 交进来，这里不认识它们。
import * as maplibregl from 'maplibre-gl';
import { LANDMARKS, approachCamera, declutter, landmarkFacts } from '../landmarks.js';
import { GLYPH_BOX, LANDMARK_GLYPHS } from '../landmark-glyphs.js';

export function createPlates({ map, landmarkForms, reducedMotion, interrupt, openPopup }) {
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
    interrupt();
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
  return { cancel() { cancelAnimationFrame(plateFrame); } };
}
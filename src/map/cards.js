// 卡片挂点那一整段（#219 从 map.js 拆出）：四个候选挂点逐个实测"出屏/压控件/遮本体/压控制条"，
// 第一个全零者胜。popup 与它描述的楼块 id 收在这里私有；关卡片时地址栏那一段由 map.js 的回调接手。
import * as maplibregl from 'maplibre-gl';
import { featureCollection } from '../geo.js';

export function createCards({ map, extrusions, onClosed }) {
  let popup, cardBlock;
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
    popup.on('close', () => { popup = undefined; cardBlock = undefined; document.body.dataset.card = 'closed'; document.body.dataset.cardPill = null; setOutline(null); onClosed(); });
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
  return { openPopup, syncPill, hasCard: () => Boolean(popup), close() { popup?.remove(); } };
}
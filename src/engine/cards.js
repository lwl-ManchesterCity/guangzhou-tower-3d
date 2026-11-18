// #218 卡片：引擎这一侧的建筑卡。现版那侧是 MapLibre popup ＋ 四席位评分（靠 queryRenderedFeatures 量"本体还露不露"），
// 这一侧没有那个查询接口，所以做的是已定的简版：一张 DOM 卡跟着 `screen()` 逐帧落在楼旁，选中体块按现版
// `building-selection` 那层同一个颜色与透明度（#1f4e5f / 0.35）罩在楼上。
// 席位规则取现版评分里最稳的那一条：站在轮廓东西两端里更宽的那一侧、竖直夹在画面里——不压住本楼优先。
// 选中体块是**懒建**的：第一张卡打开之前场景里没有它，teardown 台账因此只在开过卡的那一页多这一份几何。
import * as THREE from 'three';
import { DEFAULT_HEIGHT, buildingGeometry, ringOf } from './buildings.js';

export const SELECTION_COLOR = '#1f4e5f';
export const SELECTION_OPACITY = 0.35;

/**
 * @param {{container: HTMLElement, scene: THREE.Scene, screen: Function, project: Function, onClosed?: Function}} input
 */
export function createEngineCards({ container, scene, screen, project, onClosed }) {
  let seat = null, target = null, volume = null, material = null, size = { w: 0, h: 0 }, volumeHeight = null;
  function measure() { if (seat) size = { w: seat.offsetWidth, h: seat.offsetHeight }; }
  function dropVolume() {
    if (!volume) return;
    scene.remove(volume);
    volume.geometry.dispose();
    volume = null;
  }
  function open(next, content) {
    seat?.remove();
    dropVolume();
    target = next;
    seat = document.createElement('div');
    seat.className = 'engine-card-seat';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'engine-card-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭建筑卡片');
    close.addEventListener('click', () => api.close());
    seat.append(content, close);
    container.append(seat);
    document.body.dataset.card = 'open';
    measure();
    // 体块高度读的是这一侧真画的那个数：塔 450 m（现版同数），未标注楼块按默认 9.6 m——
    // 现版那层对未标注楼画平面，这一侧画的是 9.6 m 的体，高亮跟着画走才不撒谎。
    const ring = ringOf({ geometry: next.outline.geometry });
    const height = Number(next.outline.properties.height) || (next.properties.tower ? 450 : DEFAULT_HEIGHT);
    material ??= new THREE.MeshBasicMaterial({ color: SELECTION_COLOR, transparent: true, opacity: SELECTION_OPACITY,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    volume = new THREE.Mesh(buildingGeometry(ring, { height, base: Number(next.outline.properties.base) || 0, project }), material);
    volumeHeight = height;
    volume.name = 'building-selection';
    // 与墙共面，靠 polygonOffset 压前一点；排在灯火（3）之后，夜景亮窗不被这层半透明色吃掉。
    volume.renderOrder = 4;
    scene.add(volume);
    place();
  }
  function place() {
    if (!seat || !target) return;
    const ring = ringOf({ geometry: target.outline.geometry });
    const points = ring.map(([lng, lat]) => screen({ lng, lat }));
    const near = points.reduce((a, b) => (b.y > a.y ? b : a));
    if (!near.onScreen) { seat.style.visibility = 'hidden'; return; }
    seat.style.visibility = '';
    const high = points.reduce((a, b) => (b.y < a.y ? b : a));
    const west = points.reduce((a, b) => (b.x < a.x ? b : a));
    const east = points.reduce((a, b) => (b.x > a.x ? b : a));
    const width = container.clientWidth || globalThis.innerWidth;
    const height = container.clientHeight || globalThis.innerHeight;
    const roomRight = width - east.x, roomLeft = west.x;
    let x = roomRight >= roomLeft ? east.x + 8 : west.x - 8 - size.w;
    x = Math.min(Math.max(8, x), Math.max(8, width - size.w - 8));
    const y = Math.min(Math.max(8, (high.y + near.y) / 2 - size.h / 2), Math.max(8, height - size.h - 8));
    seat.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  const api = {
    open,
    place,
    measure,
    hasCard: () => Boolean(seat),
    cardState: () => (target ? { osmId: target.properties.osmId, volume: Boolean(volume), height: volumeHeight } : null),
    close: () => {
      if (!seat) return;
      seat.remove();
      seat = null;
      target = null;
      dropVolume();
      document.body.dataset.card = 'closed';
      onClosed?.();
    },
    dispose: () => {
      seat?.remove();
      seat = null;
      target = null;
      dropVolume();
      material?.dispose();
      material = null;
    },
  };
  return api;
}
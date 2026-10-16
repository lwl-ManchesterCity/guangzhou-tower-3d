import { LANDMARKS } from './landmarks.js';

const at = (id) => LANDMARKS.find((place) => place.osmId === id).center;
const tower = at(584204634), west = at(184738716), east = at(511404889);
const midpoint = (a, b) => a.map((value, i) => (value + b[i]) / 2);
const twins = midpoint(west, east), river = midpoint(tower, twins);

export const FILM_SHOTS = [
  { title: '江城初见', caption: '一条珠江，展开广州的日与夜。', mood: 'day', center: river, anchor: 0.57,
    from: [14.35, 58, -38], to: [14.95, 68, -20] },
  { title: '双塔入云', caption: '东西双塔隔着花城广场，写下城市的天际线。', mood: 'day', center: twins, anchor: 0.76,
    from: [15.5, 67, -48], to: [15.65, 69, -12] },
  { title: '花城中轴', caption: '沿着绿意向南，城市的中轴与江水相遇。', mood: 'sunset', center: at(243319596), anchor: 0.64,
    from: [15.1, 56, 164], to: [15.45, 62, 184] },
  { title: '步过珠江', caption: '海心桥的一道弧，把两岸的日常轻轻连起。', mood: 'sunset', center: at(1313608038), anchor: 0.58,
    from: [16.15, 56, 12], to: [16.4, 61, 48] },
  { title: '小蛮腰亮起', caption: '暮色落下，广州塔把光留在江面。', mood: 'night', center: tower, anchor: 0.78,
    from: [15.25, 68, -65], to: [15.5, 69, -25] },
  { title: '一江两岸', caption: '灯火有了回响，广州的故事还在继续。', mood: 'night', center: river, anchor: 0.49,
    from: [14.9, 67, -25], to: [14.6, 69, -12] },
];
export const FILM_SHOT_MS = 8000;
export const FILM_DURATION = FILM_SHOTS.length * FILM_SHOT_MS;

export function filmFrame(elapsed, { width, height }) {
  const time = Math.max(0, Math.min(FILM_DURATION, elapsed));
  const index = Math.min(FILM_SHOTS.length - 1, Math.floor(time / FILM_SHOT_MS));
  const shot = FILM_SHOTS[index];
  const progress = (time - index * FILM_SHOT_MS) / FILM_SHOT_MS;
  const mix = progress * progress * (3 - 2 * progress);
  const [zoom, pitch, bearing] = shot.from.map((value, i) => value + (shot.to[i] - value) * mix);
  const bar = Math.max(width <= 700 || height <= 500 ? 52 : 84, width < height ? 64 : (height - width / 2.2) / 2);
  const aperture = Math.max(100, height - bar * 2);
  const shift = 2 * aperture * (shot.anchor - 0.5);
  return { index, time, progress, shot, bar,
    camera: { center: [...shot.center], zoom: zoom + Math.log2(Math.min(1, width / 1100, aperture / 620)), pitch, bearing,
      padding: { top: Math.max(0, shift), bottom: Math.max(0, -shift), left: 0, right: 0 } },
  };
}

export function createFilm({ draw, onChange, onExit, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }) {
  let active = false, playing = false, reduced = false, elapsed = 0, previous, frame;
  const state = () => ({ active, playing, reduced, elapsed });
  const publish = () => onChange(state());
  function render() { draw(elapsed); publish(); }
  function stopClock() { cancelFrame(frame); frame = undefined; previous = undefined; }
  function exit() {
    if (!active) return;
    stopClock();
    active = playing = false;
    publish();
    onExit();
  }
  function tick(now) {
    if (!active || !playing) return;
    if (previous !== undefined) elapsed += now - previous;
    previous = now;
    if (elapsed >= FILM_DURATION) { exit(); return; }
    render();
    frame = requestFrame(tick);
  }
  return {
    get active() { return active; },
    get state() { return state(); },
    start(still = false) {
      if (active) return;
      active = true;
      reduced = still;
      playing = !still;
      elapsed = 0;
      previous = undefined;
      render();
      if (playing) frame = requestFrame(tick);
    },
    exit,
    pause() {
      if (!active || !playing) return;
      playing = false;
      stopClock();
      publish();
    },
    toggle() {
      if (!active) return;
      if (reduced) {
        elapsed = (Math.floor(elapsed / FILM_SHOT_MS) + 1) * FILM_SHOT_MS;
        if (elapsed >= FILM_DURATION) exit();
        else render();
      } else if (playing) this.pause();
      else { playing = true; previous = undefined; publish(); frame = requestFrame(tick); }
    },
    reframe() { if (active) render(); },
    reduce() {
      if (!active) return;
      reduced = true;
      this.pause();
      publish();
    },
  };
}

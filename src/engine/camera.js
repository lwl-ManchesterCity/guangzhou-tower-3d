// V8 Phase 0：相机。现版的地镜头是 MapLibre 的，它的透视写在 `src/geo.js` 里 —— 36.87° 竖直视场、512 px 瓦片，
// 而 `cameraFromPlacement()` 已经用这对常数把"眼睛在哪"换算成 `#map=zoom/lat/lng/bearing/pitch`。
// 新引擎不另起一套相机语义：这里的正反向就是那个函数的逆，所以一条老链接在两个引擎里落在同一格画面上。
//
// 角度约定照抄 geo.js 已验证的那份：`pitch` 从正下方起算（0 = 俯视，越大越平），`bearing` 是**视线**的罗盘方位。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CAMERA_FOV, CAMERA_TILE, EARTH_RADIUS } from '../geo.js';
import { VIEW_LIMITS } from '../config.js';

const radians = (degrees) => degrees * Math.PI / 180;
const degrees = (angle) => angle * 180 / Math.PI;
const worldAtEquator = 2 * Math.PI * EARTH_RADIUS;

// MapLibre's own `cameraToCenterDistance`, expressed for a canvas of `height` CSS pixels.
export const cameraToCentre = (height) => 0.5 / Math.tan(radians(CAMERA_FOV) / 2) * height;

/** The line of sight that puts `latitude`'s ground at MapLibre's `zoom`, for a canvas `height` pixels tall. */
export const distanceForZoom = ({ zoom, height, latitude }) =>
  cameraToCentre(height) * worldAtEquator * Math.cos(radians(latitude)) / (CAMERA_TILE * 2 ** zoom);

/**
 * MapLibre 那一格屏幕（一个 CSS 像素）在这一纬度这一级缩放下占多少米。
 * 江面的波光要用它把"米"换回"屏幕像素"：贴图在屏幕上必须正好一格 64 个 CSS 像素，
 * 而它铺的位置要跟着地面走，所以铺得开的距离按米读、格子的大小按这一格换。
 */
export const metresPerPixel = ({ zoom, latitude }) =>
  worldAtEquator * Math.cos(radians(latitude)) / (CAMERA_TILE * 2 ** zoom);

/** The inverse, so a dragged camera can be written back into the hash. */
export const zoomForDistance = ({ distance, height, latitude }) =>
  Math.log2(cameraToCentre(height) * worldAtEquator * Math.cos(radians(latitude)) / (distance * CAMERA_TILE));

// The hash and MapLibre both carry bearing in [-180, 180); `cameraFromPlacement` hands back [0, 360).
export const wrapBearing = (bearing) => ((bearing + 180) % 360 + 360) % 360 - 180;

/**
 * Where the eye sits, in the local metre frame, for one view state.
 *
 * @param {{center: {lat: number, lng: number}, zoom: number, bearing: number, pitch: number, height: number, origin: {lat: number, lng: number}, project: Function}} view
 * @returns {{x: number, y: number, z: number, target: {x: number, z: number}, distance: number}}
 */
export function eyeFromView(view) {
  const { center, zoom, bearing, pitch, height, project } = view;
  const distance = distanceForZoom({ zoom, height, latitude: center.lat });
  const ground = distance * Math.sin(radians(pitch));
  const altitude = distance * Math.cos(radians(pitch));
  const target = project(center);
  // The eye sits behind the target along the look vector: with `bearing` the compass direction of the look,
  // target→eye runs on `bearing + 180`, which in (east, south) is (-sin, +cos) of the look.
  const east = -ground * Math.sin(radians(bearing));
  const south = ground * Math.cos(radians(bearing));
  return { x: target.x + east, y: altitude, z: target.z + south, target, distance };
}

/**
 * The view state a placed camera describes - the inverse of `eyeFromView`, and the only way a dragged camera can
 * turn back into a hash.
 */
export function viewFromEye({ position, target, height, project }) {
  const east = position.x - target.x, up = position.y, south = position.z - target.z;
  const distance = Math.hypot(east, up, south);
  const ground = Math.hypot(east, south);
  const center = project.toLngLat({ x: target.x, z: target.z });
  return {
    center,
    zoom: zoomForDistance({ distance, height, latitude: center.lat }),
    pitch: degrees(Math.atan2(ground, up)),
    bearing: wrapBearing(degrees(Math.atan2(-east, south))),
    distance,
  };
}

/**
 * 一段飞行的插值，纯函数所以能在 Node 里钉。
 *
 * 方位角走的是"两点之间那一段"（−350° 到 10° 应当转 +20°，不是绕远路的 −340°），其余三样线性：缩放这个量纲
 * 本身就是对数（一级是两倍的视线距离），所以在"级"上线性等于在距离上等比，与 MapLibre 的 `flyTo` 同一读法。
 */
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export function flightStep(from, to, amount) {
  const k = easeInOutQuad(Math.min(1, Math.max(0, amount)));
  return {
    zoom: from.zoom + (to.zoom - from.zoom) * k,
    pitch: from.pitch + (to.pitch - from.pitch) * k,
    bearing: from.bearing + wrapBearing(to.bearing - from.bearing) * k,
    center: {
      lng: from.center.lng + (to.center.lng - from.center.lng) * k,
      lat: from.center.lat + (to.center.lat - from.center.lat) * k,
    },
  };
}

/**
 * The rig: an OrbitControls input layer over the shipped view semantics.
 *
 * OrbitControls owns the camera position and a ground target; every frame the view state is read back out of it in
 * the hash's own units, and the limits come from `VIEW_LIMITS` rather than the round numbers the brief names, because
 * a camera that cannot reach `#map=10/...` is a link the old engine wrote and the new one silently refuses.
 *
 * @param {{canvas: HTMLCanvasElement, project: Function, initial: object, limits?: object, onChange?: Function}} options
 */
export function createRig({ canvas, project, initial, limits = VIEW_LIMITS, onChange }) {
  const height = () => canvas.clientHeight || 1;
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 1, 20000);
  camera.up = new THREE.Vector3(0, 1, 0);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // The brief's own number, and the one the shipped map's inertia is closest to.
  controls.dampingFactor = 0.1;
  controls.screenSpacePanning = false;
  // The three rates below are not the defaults: they are the ratio the old engine measures at the opening camera,
  // from the same drags - a 100 px pan moves 176.1 m there against 155.6 m at panSpeed 1 (so 1.13 lands 175.1 m),
  // and one wheel notch of -100 deltaY is 0.15 zoom levels there against 0.12 at 1.9, 0.17 at 2.15. Zooming toward the cursor is MapLibre's behaviour too,
  // and without it the map centre holds while the old engine slides it ~25 m.
  controls.panSpeed = 1.13;
  controls.zoomSpeed = 1.9;
  controls.zoomToCursor = true;
  controls.maxPolarAngle = radians(limits.maxPitch);
  controls.minPolarAngle = 0;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: null };
  // RIGHT gets no action here, not ROTATE: the rotate entries (right drag, ⌥/⌃+left) all go through the one calibrated
  // handler in gestures.js, so a right drag turns at the same 20°/100 px as ⌥ and the same way in both halves of the
  // screen. OrbitControls keeps its own context-menu guard, which is what makes the right press usable at all.
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

  const apply = (view) => {
    const eye = eyeFromView({ ...view, height: height(), project });
    controls.target.set(eye.target.x, 0, eye.target.z);
    camera.position.set(eye.x, eye.y, eye.z);
    // Near and far follow the line of sight: a fixed 1 m near plane at a 100 km overview is a depth buffer with no
    // bits left, and the 3 km scene at zoom 18 needs the near plane close.
    camera.near = Math.max(0.5, eye.distance / 2000);
    camera.far = eye.distance * 4 + 12000;
    camera.aspect = (canvas.clientWidth || 1) / height();
    camera.updateProjectionMatrix();
    controls.update();
  };
  const clampZoom = (zoom) => Math.min(limits.maxZoom, Math.max(limits.minZoom, zoom));
  const state = { ...initial, zoom: clampZoom(initial.zoom ?? 15.5) };
  apply(state);

  let last = null;
  const read = () => {
    const view = viewFromEye({ position: camera.position, target: controls.target, height: height(), project });
    return { ...view, zoom: clampZoom(view.zoom) };
  };
  const same = (a, b) => Boolean(a && b) && Math.abs(a.zoom - b.zoom) < 1e-4 && Math.abs(a.pitch - b.pitch) < 0.05
    && Math.abs(wrapBearing(a.bearing - b.bearing)) < 0.05
    && Math.abs(a.center.lat - b.center.lat) < 1e-7 && Math.abs(a.center.lng - b.center.lng) < 1e-7;

  // 一段飞行：`flyTo` 只登记目标，真正推进的是每帧一次的 `update(now)`，所以相机只有一个写入者。
  // 手上有任何输入就立刻作废——MapLibre 也是这个行为，用户一碰镜头，程序化的那一段就让位。
  let flight = null;
  const stopFlight = () => {
    if (!flight) return;
    const { resolve } = flight;
    flight = null;
    resolve?.(read());
  };
  const flyTo = (view, duration = 0) => {
    const to = {
      zoom: clampZoom(view.zoom), pitch: Math.min(limits.maxPitch, Math.max(0, view.pitch)),
      bearing: view.bearing, center: view.center,
    };
    if (!duration) {
      flight = null;
      Object.assign(state, to);
      apply(state);
      return Promise.resolve(read());
    }
    return new Promise((resolve) => { flight = { from: read(), to, started: 0, duration, resolve }; });
  };
  canvas.addEventListener('pointerdown', stopFlight);
  canvas.addEventListener('wheel', stopFlight, { passive: true });

  return {
    camera,
    controls,
    view: read,
    flyTo,
    cancelFlight: stopFlight,
    setView: (next) => {
      stopFlight();
      state.zoom = clampZoom(next.zoom);
      state.bearing = next.bearing;
      state.pitch = Math.min(limits.maxPitch, Math.max(0, next.pitch));
      state.center = next.center;
      apply(state);
      return read();
    },
    // Called every frame. Reports the view back only when it actually moved, which is what lets the hash writer and
    // the UI skip the work on a still page.
    update: (now = 0) => {
      if (flight) {
        if (!flight.started) flight.started = now;
        const step = (now - flight.started) / flight.duration;
        const next = flightStep(flight.from, flight.to, step);
        Object.assign(state, next);
        apply(state);
        if (step >= 1) {
          const { resolve } = flight;
          flight = null;
          resolve?.(read());
        }
      }
      controls.update();
      const view = read();
      const moved = !same(view, last);
      if (moved) {
        last = view;
        onChange?.(view);
      }
      return view;
    },
    resize: (width, pixels) => {
      camera.aspect = width / (pixels || 1);
      camera.updateProjectionMatrix();
    },
    dispose: () => {
      canvas.removeEventListener('pointerdown', stopFlight);
      canvas.removeEventListener('wheel', stopFlight);
      controls.dispose();
    },
  };
}

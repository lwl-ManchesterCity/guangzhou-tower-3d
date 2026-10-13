// V8 Phase 0：旋转手势。现版这条手势是量出来的，不是抄来的：macOS 把 ⌃/双指点按转成右键按下，而右键按住没法
// 持续拖，所以 MapLibre 自带的旋转入口在触控板上用不了；早期版本按 0.5°/像素做过一次，100 像素就转 50°，被判太灵，
// 定下来的数是**方位角 20°/100 像素、俯仰 25°/100 像素**。新引擎沿用同一组数，手感验收（V8-0d）就是拿这两条
// 跟现版并排量出来的，所以这里不做"更顺手的"改动。
//
// 现版的右键拖拽没有照搬，是刻意的。2026-10-04 在同一机位（#map=15.5/…/-25/62）右键横拖 100 像素量过 5 个抓取行：
//   抓取行 y   120     300     480     660    840        （画面中心 y=480）
//   现版转过的  −12.8°  −20.3°  −83.8°  +33.2°  +25°
//   迁移前转的   37.4°   37.4°   35.8°   37.4°   35.8°
// 现版那一路是库的 around-center 模型：只有抓取点落在中心行 ±100 像素内才按 0.8°/像素转，越远越小，且跨过中心行方向
// 就反过来。同一动作在画面上半屏和下半屏转向相反，这条既没法验收也没法解释，而 0.8°/像素本身就是被否掉的"太灵"档
// 的 1.6 倍。所以右键拖拽在两个引擎里都接到同一套已定数的旋转语义上（⌥/⌃+左键同一条），抓取行不再改变快慢与方向。
import { wrapBearing } from './camera.js';

export const ROTATE_DEGREES_PER_100PX = 20;
export const PITCH_DEGREES_PER_100PX = 25;

/**
 * Which presses start a rotation. The three entries are the ones the shipped map answers to: ⌥+left (the gesture the
 * old engine added because a held right button is unreachable on a trackpad), ⌃+left (MapLibre's own rotate test),
 * and a plain right drag (the same test with the button the trackpad hands out). ⌘ and right+ctrl stay out - the
 * second one is the library's roll entry, which this map does not enable.
 */
export function isRotateTrigger({ button, altKey = false, ctrlKey = false, metaKey = false }) {
  if (metaKey) return false;
  if (button === 2) return !altKey && !ctrlKey;
  return button === 0 && (altKey || ctrlKey);
}

/**
 * @param {{canvas: HTMLElement, rig: {view: Function, setView: Function}, limits?: {maxPitch: number}}} options
 * @returns {{dispose: Function}}
 */
export function attachRotate({ canvas, rig, limits = { maxPitch: 70 } }) {
  let drag;
  const move = (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    const view = rig.view();
    rig.setView({
      ...view,
      // Dragging right turns the view left, and dragging down lifts the camera toward the horizon - the same signs
      // the shipped handler uses.
      // Measured against the shipped map at the opening camera: dragging right turns the bearing up (+20° per 100 px)
      // and dragging down lays the camera flatter (-25° per 100 px, 62° to 37°).
      bearing: wrapBearing(view.bearing + (dx * ROTATE_DEGREES_PER_100PX) / 100),
      pitch: Math.min(limits.maxPitch, Math.max(0, view.pitch - (dy * PITCH_DEGREES_PER_100PX) / 100)),
    });
  };
  const up = () => {
    drag = undefined;
    if (rig.controls) rig.controls.enabled = true;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  const down = (event) => {
    if (!isRotateTrigger(event)) return;
    event.preventDefault();
    // OrbitControls' own left button is a pan, and it starts on the same mousedown. `preventDefault` alone does not
    // stop it, so the gesture takes the input away for the length of the drag - otherwise an ⌥ turn also slides the
    // map sideways, which the old engine never did. A right press needs nothing of the sort: the rig gives RIGHT no
    // action at all, and leaving the controls enabled is what keeps their own context-menu guard alive.
    if (event.button === 0 && rig.controls) rig.controls.enabled = false;
    drag = { x: event.clientX, y: event.clientY };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  // Capture phase, so the drag never also starts a pan - the old engine needed the same trick.
  canvas.addEventListener('mousedown', down, { capture: true });
  return {
    dispose: () => {
      canvas.removeEventListener('mousedown', down, { capture: true });
      up();
    },
  };
}

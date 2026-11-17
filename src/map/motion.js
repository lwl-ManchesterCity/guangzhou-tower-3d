// 动效主循环与塔身灯光两档（#219 从 map.js 拆出）：江面滚动、塔身色相/呼吸、近场车流、夜灯交叉淡、
// 开场雾散，以及"关掉动效＝交还出厂帧"的那一整段。`motion` 时钟由 map.js 建出来交给这里与氛围模块
// 共用——换图要归零江面相位，熄灯要归零步进，所以它不能收进任何一侧私有。
import { HAZE_REVEAL } from '../atmosphere.js';
import { TOWER_MODES, towerBreath, towerHue } from '../tower.js';
import { LAMP_KEYS, LAMP_PERIODS_MS, lampWeight } from '../facade.js';
import { WATER_IMAGE_PREFIX, scrollWater } from '../water.js';
import { MARCH_PHASES, TRAFFIC_STEP_MS } from '../traffic.js';

export function createMotion({ map, riverTiles, tower, motion, atmosphere, getLens, reducedMotion, onMotionChange }) {
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
    tower()?.setHue(0);
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
    tower()?.setPulse(motion.pulse, towerFade);
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
      tower()?.setForms({ reveal });
      if (t < 1) hazeReveal = requestAnimationFrame(step);
      else {
        hazeReveal = undefined;
        map.setGlobalStateProperty(HAZE_REVEAL, 0);
        tower()?.setForms({ reveal: 0 });
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
      const towerLayer = tower();
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
        if (getLens().mode !== 'height') {
          motion.life += steps * MOTION_STEP_MS;
          towerLayer.runTraffic(motion.life / 1000, map.getZoom());
          motion.lights += steps;
        }
        // The lamps cross-fade on the same tick, and they cost two numbers. Their weight is read by the layer's own
        // opacity every frame, which is the only channel this scene can animate a wall through: the pattern a
        // `fill-extrusion` shows is baked into its bucket when the tile is tessellated, and rewriting the image behind
        // the name was proved not to reach the screen. The two groups start at cycle 0 together - the shipped frame -
        // and their periods share no factor, so they drift apart from the first minute and never realign.
        if (atmosphere.id === 'night' && getLens().mode !== 'height') {
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
      if (atmosphere.trafficVisible) {
        motion.march = (motion.march + steps) % MARCH_PHASES.length;
        atmosphere.marchLights(motion.march);
        motion.marches += steps;
      }
    }
    motion.frame = requestAnimationFrame(motionFrame);
  }
  function scrollRiver(steps) {
    const tile = riverTiles[atmosphere.id];
    if (!tile) return false;
    motion.phase = (motion.phase + steps) % tile.height;
    map.updateImage(`${WATER_IMAGE_PREFIX}-${atmosphere.id}`, scrollWater(tile, motion.phase));
    return true;
  }
  // Turning motion off is not pausing: the tiles go back to the rows they shipped on and the tower to the intensities
  // the atmosphere set for it, so the frame left on screen is one a page without this feature would have drawn.
  // A scene with neither a river tile nor a tower has nothing for the loop to redraw, so it must not run at all:
  // an idle requestAnimationFrame still wakes the tab sixty times a second and drains a phone for no picture.
  function motionAvailable() { return Object.keys(riverTiles).length > 0 || Boolean(tower()); }
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
        atmosphere.marchLights(0);
        // Handing back means the frame a page without any of this would have drawn: the shipped dash, the preset's own
        // emission, the preset's own colour rather than wherever the wheel had got to, the vehicles back on the spacing
        // their own ways give them, and every block on its shipped pick of windows rather than wherever the evening's
        // cross-fade had drifted.
        for (const key of LAMP_KEYS) map.setGlobalStateProperty(key, 1);
        const towerLayer = tower();
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
  function setTowerMode(next) {
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
  }
  // teardown 那一份：停循环、撤雾散的 rAF。不做"交还出厂帧"——地图整个都要没了。
  function cancel() {
    motion.on = false;
    cancelAnimationFrame(motion.frame);
    cancelAnimationFrame(hazeReveal);
    hazeReveal = undefined;
  }
  return { setMotion, motionStatus, revealHaze, hazeStatus, setTowerMode, cancel };
}
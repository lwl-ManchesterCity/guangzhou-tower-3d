// 昼夜氛围那一整段（#219 从 map.js 拆出）：颜色走查、中点换图、灯光与天色、夜车灯带的开关。
// 它自己持有 `atmosphereId`/`moodRun`/`trafficVisible` 三个状态；共享的只有 map.js 交进来的那份 `motion`
// 时钟（换图要把江面相位归零、熄灯要把步进归零）与懒登记的灯图。塔层、广场、透视镜与雾的读数都走
// 取值函数，因为它们在这份工厂构造之后才建出来／才会变。
import { ATMOSPHERES, ATMOSPHERE_MS, MOOD, PATTERN_SWAP_MS, SKY_BLEND, baseAtmospherePaint, buildingAtmosphereColor, contextAtmosphereColor, mixPreset, themeBlend, themeResume } from '../atmosphere.js';
import { heightColor } from '../lens.js';
import { bridgeLayers } from '../bridges.js';
import { plazaLayers } from '../plaza.js';
import { facadePattern } from '../facade.js';
import { WATER_IMAGE_PREFIX, scrollWater } from '../water.js';
import { TRAFFIC_BAND, TRAFFIC_FLOW, TRAFFIC_TAIL, marchPair } from '../traffic.js';

export function createAtmosphere({ map, style, center, getLens, tower, plaza, riverTiles, motion, reducedMotion, lamps, hazeStatus }) {
  let atmosphereId = 'day';
  // The clock of an atmosphere walk in progress: which theme the picture on screen came from, which one it was heading
  // for, how far it had got, and whether the patterns had been swapped yet.
  let moodRun;
  // Every colour the atmosphere owns, as `layer/property` -> declaration, for one theme id. Patterns and visibility are
  // deliberately missing: nothing can interpolate a `resolvedImage`, so they belong to the swap below.
  function atmospherePaint(id) {
    const theme = ATMOSPHERES[id];
    const paint = new Map();
    const put = (layer, property, value) => { if (value !== undefined) paint.set(`${layer}/${property}`, value); };
    for (const layer of style.layers) {
      const merged = { ...layer.paint, ...baseAtmospherePaint(layer, theme) };
      for (const property of ['background-color', 'fill-color', 'line-color', 'text-color', 'text-halo-color'])
        put(layer.id, property, merged[property]);
    }
    const heights = getLens().mode === 'height';
    for (const layer of ['neighborhood-buildings', 'neighborhood-buildings-overview'])
      put(layer, 'fill-extrusion-color', heights ? heightColor() : buildingAtmosphereColor(theme));
    put('context-buildings', 'fill-extrusion-color', contextAtmosphereColor(theme, center));
    // The decks carry a `match` on their own `foot` tag, so the pedestrian crossing stays the warmer one through the
    // whole walk, and the walk still gets to move both ends of it.
    for (const layer of bridgeLayers(theme)) put(layer.id, 'fill-extrusion-color', layer.paint['fill-extrusion-color']);
    put('building-selection', 'fill-extrusion-color', theme.selection);
    put('building-selection-flat', 'fill-color', theme.selection);
    put('radius-line', 'line-color', theme.radius);
    put('tower-label', 'text-color', theme.towerText);
    put('tower-label', 'text-halo-color', theme.towerHalo);
    put('poi-markers', 'text-color', theme.poiText);
    put('poi-markers', 'text-halo-color', theme.poiHalo);
    return paint;
  }
  // What no expression can walk: the facade grid, the river tile, which texture the basemap's patterned fills use, and
  // whether the lamps are burning. One step, at the middle of the colour transition.
  let trafficVisible = false;
  // The streets burn with the windows, and the height lens is a data view rather than a night view, so it keeps the
  // traffic out the same way it keeps the lamp grid out. `trafficVisible` is what the march reads, so the loop can
  // never spend a step on a layer nobody can see.
  // The two marching layers are always written together: they are one traffic light seen two ways, and a frame where
  // only one of them moved is a frame where the lattice is regular again.
  function marchLights(step) {
    const [headlights, taillights] = marchPair(step);
    map.setPaintProperty(TRAFFIC_FLOW, 'line-dasharray', headlights);
    map.setPaintProperty(TRAFFIC_TAIL, 'line-dasharray', taillights);
  }
  function lightTraffic(lit) {
    trafficVisible = lit;
    for (const layer of [TRAFFIC_BAND, TRAFFIC_TAIL, TRAFFIC_FLOW]) map.setLayoutProperty(layer, 'visibility', lit ? 'visible' : 'none');
    // The lamps burn with the ribbons; the cars and the walkers themselves stay on the picture by day too, and the
    // only thing that takes them off is the height lens, which is decided where the lens is applied.
    tower()?.setTrafficLamps(lit);
    if (lit) return;
    marchLights(0);
    motion.march = 0;
    // The near field is deliberately not snapped here. The ribbons are night-only, so resetting them on the way out is
    // invisible; the cars and the walkers burn by day as well, and a reset on the way out was a jump the observer
    // could see. They go back to the spacing their own ways give them in one place only: when the loop is switched off.
  }
  function swapArt(id) {
    const theme = ATMOSPHERES[id];
    for (const layer of style.layers) {
      const pattern = { ...layer.paint, ...baseAtmospherePaint(layer, theme) }['fill-pattern'];
      if (pattern !== undefined) map.setPaintProperty(layer.id, 'fill-pattern', pattern);
    }
    map.setPaintProperty('building-facade', 'fill-extrusion-pattern', facadePattern(id));
    // 广场那四层跟着氛围走色：草坪与水面用它们自己的档，石材用 `plaza`/`plazaWalk`。
    const ground = plaza();
    if (ground) for (const layer of plazaLayers(theme)) map.setPaintProperty(layer.id, 'fill-color', layer.paint['fill-color']);
    // Lamps only burn at night, and the height lens keeps its colour-as-data wall to itself.
    // 灯门要开之前先把那 324 张图补上：这是唯一的登记点，瞬切（settle 也走这里）与走路中点都经过它。
    if (id === 'night') lamps.ensureLampImages();
    for (const layer of lamps.lampGates) {
      map.setLayoutProperty(layer.id, 'visibility', id === 'night' && getLens().mode !== 'height' ? 'visible' : 'none');
    }
    // The streets light up with the windows and go dark with them, and the height lens keeps them out.
    lightTraffic(id === 'night' && getLens().mode !== 'height');
    // The beam over the mast belongs to the night only. It is the one thing on this map with no OSM element behind it,
    // which is why the landmark card for the tower says out loud that it is 示意.
    tower()?.setBeam(id === 'night');
    tower()?.setForms({ from: ATMOSPHERES[id], reveal: hazeStatus().reveal });
    map.setPaintProperty('river-surface', 'fill-pattern', `${WATER_IMAGE_PREFIX}-${id}`);
    // The loop writes into whichever tile the atmosphere currently points at, so all three are put back on their
    // shipped rows and the scroll restarts from row zero on the new one.
    if (Object.keys(riverTiles).length) {
      for (const [tileId, tile] of Object.entries(riverTiles)) map.updateImage(`${WATER_IMAGE_PREFIX}-${tileId}`, scrollWater(tile, 0));
      motion.phase = 0;
      motion.river = 0;
    }
  }
  function atmosphereLight(id) {
    return ATMOSPHERES[id].light;
  }
  function applyLight(override) {
    const light = override ?? atmosphereLight(atmosphereId);
    map.setLight({ ...light, 'color-transition': { duration: 0 }, 'intensity-transition': { duration: 0 }, 'position-transition': { duration: 0 } });
  }
  function applySky(colors) {
    map.setSky({ ...colors ?? ATMOSPHERES[atmosphereId].sky, ...SKY_BLEND,
      'sky-color-transition': { duration: 0 }, 'horizon-color-transition': { duration: 0 }, 'fog-color-transition': { duration: 0 } });
  }
  function installPaint(paint) {
    for (const [key, value] of paint) {
      const [layer, property] = key.split('/');
      map.setPaintProperty(layer, `${property}-transition`, { duration: 0 });
      map.setPaintProperty(layer, property, value);
    }
  }
  // Stop the clock without touching what it was painting. Returns where the walk stood, for a walk that resumes from it.
  function stopMood() {
    if (!moodRun) return null;
    // The state is what the picture is painted from, so it is what the next walk resumes from - not the number the
    // clock last computed, which is rounded on the way in.
    const stood = { fromId: moodRun.fromId, toId: moodRun.toId, at: map.getGlobalState()[MOOD] ?? 0 };
    cancelMood();
    return stood;
  }
  // map.remove() fires after the style is gone, so the teardown path must cancel the frame without reading state.
  function cancelMood() {
    cancelAnimationFrame(moodRun?.frame);
    moodRun = undefined;
  }
  // The end of a walk, and the whole of a switch that must not animate: every surface on the theme it was heading for,
  // written as the shipped declaration rather than as a blend, so the frame a finished transition leaves behind is
  // byte-for-byte the frame a page without this feature would have drawn.
  function settleAtmosphere() {
    stopMood();
    const theme = ATMOSPHERES[atmosphereId];
    installPaint(atmospherePaint(atmosphereId));
    swapArt(atmosphereId);
    // The shells have no expression to hold a middle stop in, so their arrival is written here rather than inside
    // `swapArt`: that also runs at the pattern swap mid-walk, and a share of 1 there would light a landmark in one
    // frame instead of on the curve its neighbours are walking.
    tower()?.setForms({ share: 1 });
    map.setGlobalStateProperty(MOOD, 0);
    applyLight();
    applySky();
    tower()?.setAtmosphere(theme.tower);
  }
  function setAtmosphere(id, { instant = false, duration = ATMOSPHERE_MS } = {}) {
    const previous = stopMood();
    const fromId = atmosphereId;
    if (id === fromId && !previous) return;
    atmosphereId = id;
    // A reduce request gets the shipped cut: the same end frame, no 1.2 s of frames to spend.
    if (instant || reducedMotion.matches) return settleAtmosphere();
    const from = atmospherePaint(previous ? previous.fromId : fromId);
    const abandoned = previous ? atmospherePaint(previous.toId) : from;
    const target = atmospherePaint(id);
    const at = previous ? previous.at : 0;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const [key, value] of target) {
      const a = from.get(key), b = abandoned.get(key);
      // Untouched by this switch - and, unless a walk is being abandoned, nothing to undo either.
      if (same(a, value) && (at === 0 || same(b, value))) continue;
      const [layer, property] = key.split('/');
      map.setPaintProperty(layer, `${property}-transition`, { duration: 0 });
      map.setPaintProperty(layer, property, at ? themeResume(a, b, value, at) : themeBlend(a, value));
    }
    const lightFrom = previous ? mixPreset(atmosphereLight(previous.fromId), atmosphereLight(previous.toId), at) : atmosphereLight(fromId);
    const skyFrom = previous ? mixPreset(ATMOSPHERES[previous.fromId].sky, ATMOSPHERES[previous.toId].sky, at) : ATMOSPHERES[fromId].sky;
    const towerFrom = previous ? mixPreset(ATMOSPHERES[previous.fromId].tower, ATMOSPHERES[previous.toId].tower, at) : ATMOSPHERES[fromId].tower;
    const themeFrom = ATMOSPHERES[previous ? previous.fromId : fromId];
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      // The same cubic in-out MapLibre applies to its own colour transitions, so the light, the sky and the tower -
      // which are not paint at all and so cannot read the global state - walk on the same curve as the walls.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      moodRun.value = at + (1 - at) * eased;
      map.setGlobalStateProperty(MOOD, Math.round(moodRun.value * 1000) / 1000);
      const share = (moodRun.value - at) / (1 - at);
      applyLight(mixPreset(lightFrom, atmosphereLight(id), share));
      applySky(mixPreset(skyFrom, ATMOSPHERES[id].sky, share));
      tower()?.setAtmosphere(mixPreset(towerFrom, ATMOSPHERES[id].tower, share));
      // The shells walk with the walls, and their night lamps come up on the same eased share rather than in one frame.
      tower()?.setForms({ from: themeFrom, to: ATMOSPHERES[id], share, resume: Boolean(previous),
        reveal: hazeStatus().reveal });
      if (!moodRun.swapped && now - start >= PATTERN_SWAP_MS) { moodRun.swapped = true; swapArt(id); }
      if (t < 1) moodRun.frame = requestAnimationFrame(step);
      else settleAtmosphere();
    };
    moodRun = { fromId: previous ? previous.fromId : fromId, toId: id, value: at, swapped: false, frame: undefined, duration };
    moodRun.frame = requestAnimationFrame(step);
  }
  function moodStatus() {
    return {
      mood: map.getGlobalState()[MOOD] ?? 0,
      running: moodRun !== undefined,
      swapped: Boolean(moodRun?.swapped),
      ms: moodRun?.duration ?? ATMOSPHERE_MS,
      swapMs: PATTERN_SWAP_MS,
    };
  }
  return {
    get id() { return atmosphereId; },
    get running() { return moodRun !== undefined; },
    get trafficVisible() { return trafficVisible; },
    marchLights,
    lightTraffic,
    applyLight,
    set: setAtmosphere,
    settle: settleAtmosphere,
    stop: stopMood,
    cancel: cancelMood,
    status: moodStatus,
  };
}
// Night traffic on the streets. Two layers, both drawn from the basemap's own `transportation` features, so every
// ribbon of light lies on a road the map already draws and there is no placed prop that has to be justified.
//
// The wide dim one is the long-exposure read - the street band itself. The narrow bright one is dashed and marches,
// which is the traffic. The band carries the look on its own, so the march is allowed to be slow: `line-dasharray` is
// a stepped property, and the motion rules cap a step at twice a second.

export const TRAFFIC_SOURCE = 'openmaptiles';
export const TRAFFIC_LAYER = 'transportation';
export const TRAFFIC_BAND = 'traffic-band';
export const TRAFFIC_FLOW = 'traffic-flow';
export const TRAFFIC_TAIL = 'traffic-tail';
// Motorway and trunk are the elevated expressways, primary and secondary the avenues, tertiary and minor the streets
// between them. Around the tower itself every road in view is tertiary or minor, so an arterials-only filter leaves the
// default camera with nothing to light. Tunnels are excluded: a ribbon across a park where the road runs underground
// is a painting error.
export const TRAFFIC_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'street', 'street_limited'];
export const TRAFFIC_ARTERIALS = ['motorway', 'trunk', 'primary', 'secondary'];
export const TRAFFIC_STEP_MS = 500;
// One comet every 19 line-widths: 3 units of lit road, 16 of dark. The gap is the number that decides whether a street
// reads as a band with traffic on it or as a string of lights, and at 10 it was the latter however small and dim each
// individual light was made.
export const TRAFFIC_DASH = 3;
export const TRAFFIC_GAP = 16;
// The tail-light layer, whose period is deliberately *not* a multiple of the headlight one: 56 against 19, so the two
// comets drift past each other along the same road instead of marching in one regular lattice, which is what breaks the
// even spacing the brief is about. 56 to 19 also lands the visible count at just under one red for every three white.
export const TRAFFIC_TAIL_DASH = 2;
export const TRAFFIC_TAIL_GAP = 54;
// Headlight white and tail-light red, the same two materials the near-field cars are drawn with. The pink this
// replaced was not chosen: it is what an orange dash at 0.92 over a blue-black ground composites to.
// Band 5 of the night budget: the ribbons sit *under* the lit windows they run past. Measured before this, a glow band
// at 0.15 of `#ffb877` over the dark ground reached luma 66 against 43 for the windows, and under the squint test it
// was the third most visible thing in the frame - which is the "没人对整幅画面负责" the brief names. The animation is
// untouched: these are the three alpha ladders only, and the traffic layers exist in the night atmosphere alone.
export const TRAFFIC_HEADLIGHT = '#ffe8c0';
export const TRAFFIC_TAILLIGHT = '#ff5a3c';
// The band is the road and the dots are only what happens to be driving on it, so the band carries the look at an
// alpha the dots do not have to fight. It used to sit at 0.55, which made every street in three kilometres a lit
// ribbon and the whole frame compete with the tower.
export const TRAFFIC_BAND_GLOW = '#ffb877';
export const TRAFFIC_BAND_ALPHA = [0.06, 0.09, 0.09];
export const TRAFFIC_DOT_ALPHA = [0.19, 0.26, 0.26];
export const TRAFFIC_TAIL_ALPHA = [0.19, 0.23, 0.23];
// Measured off the shipped widths at the hero camera: 0.65 the size they were, which is the 30-40 % reduction the
// brief asks for. Round caps turn a dash of these into a dot, so the width *is* the dot size.
const HEADLIGHT_WIDTH = [0.65, 1.6, 3.1, 5.3];
const HEADLIGHT_WIDTH_SLOW = [0.4, 0.9, 1.7, 2.9];

// `['zoom']` may only be the input of the top-level interpolate, so the class split lives in the stop values rather
// than the other way round; a zoom ramp nested inside a `match` is refused by the validator without any error.
const byClass = (fast, slow) => ['match', ['get', 'class'], TRAFFIC_ARTERIALS, fast, slow];
const width = (fast, slow) => ['interpolate', ['exponential', 1.2], ['zoom'],
  12, byClass(fast[0], slow[0]), 14, byClass(fast[1], slow[1]), 16, byClass(fast[2], slow[2]), 18, byClass(fast[3], slow[3])];
const alpha = (stops) => ['interpolate', ['linear'], ['zoom'], 12, stops[0], 14.5, stops[1], 18, stops[2]];

// `arteries` narrows the list to the roads that carry through traffic. The marching layer uses it and the band does
// not: a dash array is re-tessellated across every feature the layer draws each time it is rewritten, so keeping the
// side streets out of the stepped layer is what makes two steps a second affordable over a whole city.
export const trafficFilter = (arteries = false) => ['all',
  ['match', ['get', 'class'], arteries ? TRAFFIC_ARTERIALS : TRAFFIC_CLASSES, true, false],
  // `!=` is not `not(==)` here: a road with no `brunnel` key at all fails `['!=', ['get','brunnel'], 'tunnel']` and the
  // whole street grid disappears, leaving only the elevated interchanges lit. `match` with a fallback is the shape the
  // basemap's own road filters use, and it keeps an absent key.
  ['match', ['get', 'brunnel'], 'tunnel', false, true],
];

export const trafficLayers = () => [
  {
    id: TRAFFIC_BAND, type: 'line', source: TRAFFIC_SOURCE, 'source-layer': TRAFFIC_LAYER,
    filter: trafficFilter(), layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': TRAFFIC_BAND_GLOW, 'line-width': width([1.7, 4.4, 9, 15.3], [1, 2.4, 4.6, 7.8]),
      'line-opacity': alpha(TRAFFIC_BAND_ALPHA),
    },
  },
  {
    id: TRAFFIC_TAIL, type: 'line', source: TRAFFIC_SOURCE, 'source-layer': TRAFFIC_LAYER,
    filter: trafficFilter(true), layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': TRAFFIC_TAILLIGHT, 'line-width': width(HEADLIGHT_WIDTH, HEADLIGHT_WIDTH_SLOW),
      'line-dasharray': marchDash(0, TRAFFIC_TAIL_DASH, TRAFFIC_TAIL_GAP), 'line-opacity': alpha(TRAFFIC_TAIL_ALPHA),
    },
  },
  {
    id: TRAFFIC_FLOW, type: 'line', source: TRAFFIC_SOURCE, 'source-layer': TRAFFIC_LAYER,
    filter: trafficFilter(true), layout: { 'line-cap': 'butt', 'line-join': 'round', visibility: 'none' },
    paint: {
      'line-color': TRAFFIC_HEADLIGHT, 'line-width': width(HEADLIGHT_WIDTH, HEADLIGHT_WIDTH_SLOW),
      'line-dasharray': marchDash(0), 'line-opacity': alpha(TRAFFIC_DOT_ALPHA),
    },
  },
];

/**
 * The `[dash, gap]` pattern read from `shift` units into its own period.
 *
 * MapLibre has no dash offset, so a march is written as the same pattern starting mid-period: a dash that is already
 * part-spent, or a gap that has to be finished before the first light appears.
 *
 * @param {number} shift units of line width, taken modulo the period
 * @param {number} [dash] lit length in units of line width
 * @param {number} [gap] dark length in units of line width
 * @returns {number[]} an even-length dash array, always starting on a lit segment
 */
export function marchDash(shift, dash = TRAFFIC_DASH, gap = TRAFFIC_GAP) {
  const period = dash + gap;
  const at = ((shift % period) + period) % period;
  const round = (value) => Math.round(value * 100) / 100;
  if (at < dash) return [round(dash - at), gap, dash, gap];
  // A zero-length dash renders nothing, so the leading gap is bought with the smallest lit sliver the pattern can hide.
  return [0.01, round(period - at), dash, gap, dash, round(at - dash)];
}

// Two frames per cycle, each jumping half a period: at two steps a second this is the fastest march the motion rules
// allow a stepped property, and half a period is the largest displacement that still reads as the same lights moved.
export const MARCH_PHASES = [0, (TRAFFIC_DASH + TRAFFIC_GAP) / 2];
export const TAIL_PHASES = [0, (TRAFFIC_TAIL_DASH + TRAFFIC_TAIL_GAP) / 2];

/**
 * The two stepped layers' dash arrays for one step of the march, headlights first.
 *
 * They ride the same counter on purpose and their own periods on purpose too: the tail drifts through the headlight
 * lattice rather than sitting in it, which is what breaks the single regular spacing the brief calls a decoration.
 *
 * @param {number} step the march counter
 * @returns {Array<number[]>} one dash array per marching layer, in `TRAFFIC_FLOW` then `TRAFFIC_TAIL` order
 */
export const marchPair = (step) => [
  marchDash(MARCH_PHASES[step % MARCH_PHASES.length]),
  marchDash(TAIL_PHASES[step % TAIL_PHASES.length], TRAFFIC_TAIL_DASH, TRAFFIC_TAIL_GAP),
];

import { BUILDING_COLORS, RADIUS_METERS } from './config.js';

export const ATMOSPHERES = {
  day: {
    label: '白昼', background: '#e9eeeb', water: '#94c1c6', park: '#9ab88a', grass: '#8fae83', wood: '#758f6a', land: '#e4eae3', footprint: '#d5d8d0',
    // 花城广场那条中轴是石头的：比 `land` 暖、比路浅，读起来是铺装而不是另一条马路。
    plaza: '#d8d2c4', plazaWalk: '#e3ded1',
    road: '#f6f7f2', casing: '#c9d1c9', roadGap: '#c5ceca', text: '#6f807d', waterText: '#537f8c', halo: '#eef3ef',
    buildings: BUILDING_COLORS, context: '#ccd3ce', selection: '#1f4e5f', radius: '#52838a',
    bridge: '#dfe2dd', bridgeFoot: '#f0dfc0', bridgeParapet: '#f7f8f3',
    towerText: '#365f66', towerHalo: '#f5f8f2', poiText: '#304c50', poiHalo: '#fbfcf8',
    // Two levers, both from the shader rather than from taste. `fill_extrusion.vertex.glsl` remaps the per-face diffuse
    // term to `[1 - intensity, 1]`, so the floor of the whole side-face range *is* `1 - intensity`: at 0.45 every wall
    // landed between 0.55 and 1.0 and the blocks had no volume. And `position`'s third number is the angle off the
    // zenith, which sets how much of the light reaches the sides at all - 38° left the top face at cos 38 ≈ 0.79 of a
    // side face's 1.0, i.e. the roof and the lit wall were nearly the same brightness. 0.58 at 32° puts the top at 0.91,
    // the lit side at 0.73 and the shaded side at 0.42, which is the three-tone block the brief asks for.
    sky: { 'sky-color': '#c3d3dd', 'horizon-color': '#d7e2e4', 'fog-color': '#c8d4dc' },
    light: { anchor: 'map', color: '#fff5e5', intensity: 0.58, position: [1.5, 210, 32] },
    maquette: { contact: '#465755', light: { anchor: 'map', color: '#f6f4ee', intensity: 0.58, position: [1.5, 225, 52] } },
    tower: {
      colors: { silver: '#d4dfe0', pale: '#e7ece9', diagonal: '#8da5ad', glass: '#72949c', warm: '#d9a669' },
      emission: { silver: ['#000000', 0], pale: ['#000000', 0], diagonal: ['#000000', 0], glass: ['#000000', 0], warm: ['#000000', 0] },
      hemisphere: ['#f5fbff', '#84918c', 2.4], directional: ['#fff4df', 2.7], position: [-300, 600, 400],
    },
  },
  sunset: {
    // `#c98d5f` is the lit channel. The sunset river used to be `#a98c9c`, a violet-grey picked off the land palette,
    // and no light in any of the three atmospheres produces that ordering of channels; the ban this round is on blue
    // leading green anywhere in the water, and the other stop of the pair - `#8a6a58`, the water in the bank's shade -
    // lives in `WATER_THEMES.sunset.trough`, because a fill layer's `fill-pattern` ignores `fill-color` and the sheen
    // overlay is the only second colour the surface can carry.
    label: '日落', background: '#d9b6a0', water: '#c98d5f', park: '#a39a62', grass: '#9c9258', wood: '#736f45', land: '#d2b19a', footprint: '#baa092',
    plaza: '#d9bda4', plazaWalk: '#e6ceba',
    road: '#efd0ac', casing: '#b29487', roadGap: '#aa8d82', text: '#765966', waterText: '#5e4034', halo: '#e9c4a8',
    otherFill: '#d2b19a', otherLine: '#b59591',
    buildings: { commercial: '#ce987e', residential: '#dfc39d', public: '#a59ab4', unknown: '#b9a5a1' },
    context: '#b89b98', selection: '#864b66', radius: '#896078',
    bridge: '#e8cfae', bridgeFoot: '#f6d9ae', bridgeParapet: '#f8e6cc',
    towerText: '#724452', towerHalo: '#f6d2af', poiText: '#664452', poiHalo: '#f3d2b7',
    sky: { 'sky-color': '#a099b6', 'horizon-color': '#f6bc90', 'fog-color': '#d7aca8' },
    light: { anchor: 'map', color: '#ffd2a2', intensity: 0.75, position: [1.5, 255, 78] },
    maquette: { contact: '#68505b', light: { anchor: 'map', color: '#ffddb5', intensity: 0.52, position: [1.5, 255, 65] } },
    tower: {
      colors: { silver: '#ecd0aa', pale: '#ffe2b5', diagonal: '#b58e96', glass: '#877a96', warm: '#f1b478' },
      emission: { silver: ['#ad6952', 0.05], pale: ['#ffc88c', 0.1], diagonal: ['#000000', 0], glass: ['#725a88', 0.08], warm: ['#ffb46e', 0.18] },
      hemisphere: ['#e4c4d8', '#77657e', 1.7], directional: ['#ffc189', 3.1], position: [-650, 180, 200],
    },
  },
  night: {
    // V7 put the whole night frame on one ten-band budget, and the ground bands are where it was failing: measured at
    // the opening camera the water sat at luma 40.6 and the greens at 36.4 against 31.5 for the walls, i.e. the river and
    // the lawns were *brighter* than the city they run under, and the roads at 50 were brighter than the lit windows.
    // A flat `fill` gets no directional light, so its hex is what reaches the screen - unlike an extruded wall, which
    // MapLibre presses down by `1 - light.intensity`. These four are the hexes that land under the wall band once that
    // difference is accounted for; `land`, `footprint` and the text colours are not part of the budget and did not move.
    label: '夜景', background: '#151f2e', water: '#0a1e30', park: '#111c16', grass: '#101a14', wood: '#0e1712', land: '#182534', footprint: '#1e2733',
    // 夜景的石材压在路面档以下：V7 的预算表里道路是 38~52，一条比路还亮的广场会把中轴烧成一块白。
    plaza: '#1b2430', plazaWalk: '#212c39',
    road: '#2b3a45', casing: '#21374c', roadGap: '#2b4058', text: '#a1b5c9', waterText: '#85b6ce', halo: '#172b42',
    otherFill: '#182534', otherLine: '#3b5066',
    // Night is the one atmosphere where the mass has to lose to the windows. The first night palette carried the day
    // hues at half brightness and the frame read as "daytime, dimmed": the walls were the brightest thing in the shot
    // and the lamps, which are the entire point of a night city, disappeared into them. So all four categories now sit
    // within a few units of one deep blue-grey and differ only in cast - offices a touch bluer, civic a touch greener,
    // untagged the darkest - which is also what lets `category` stay readable without competing with the lights.
    buildings: { commercial: '#2c3846', residential: '#2a3341', public: '#27343c', unknown: '#242c38' },
    context: '#232c38', selection: '#b1dbe1', radius: '#688ca7',
    // Band 6 is a lit *arc*, not a lit bridge: measured, the extruded deck was the brightest large area in the night
    // frame (86.6 against 42.7 for the windows it crosses) because V5-8 gave the whole volume the edge colour. The deck
    // body now sits in the wall band and only the parapet keeps the bright edge, which is what the crossing actually
    // reads as from the plaza - and V5-8's "桥体可见" still holds, because visibility at night is the parapet's job.
    bridge: '#1e2a33', bridgeFoot: '#8a7357', bridgeParapet: '#74899c',
    towerText: '#dcebf4', towerHalo: '#172b42', poiText: '#e0eaf0', poiHalo: '#172b42',
    // The horizon used to be the brightest band in the night sky, so the far skyline dissolved upward into a glow and
    // the recession read as over-exposure rather than as distance. It now sits just above the fog it blends into.
    sky: { 'sky-color': '#0b162c', 'horizon-color': '#1f2c3d', 'fog-color': '#1a2330' },
    light: { anchor: 'map', color: '#c3d8fc', intensity: 0.38, position: [1.5, 210, 28] },
    maquette: { contact: '#0b1a2a', light: { anchor: 'map', color: '#c9dded', intensity: 0.44, position: [1.5, 225, 45] } },
    tower: {
      colors: { silver: '#859dc4', pale: '#d7bbec', diagonal: '#566e91', glass: '#273f60', warm: '#edbf82' },
      // V7's budget puts the lattice in band 2 - below the crowns, above the windows - and asks for its colour to stop
      // shouting: each emission is the same hue and lightness at 75% of its own saturation. The green that came with the
      // first night palette was the whole of the "玩具" read at 46% saturation, and cutting the brightness instead would
      // have put the tower below the band the brief gives it.
      emission: { silver: ['#80b5c1', 0.7], pale: ['#af88d3', 0.95], diagonal: ['#4c6084', 0.3], glass: ['#44648a', 0.25], warm: ['#f0c797', 0.9] },
      hemisphere: ['#a2badf', '#283851', 0.85], directional: ['#adcafa', 1.2], position: [-300, 600, 400],
    },
  },
};

// Where the green has to sit for the axis to read as a green axis. The basemap's own 0.3/0.4 is what made 花城广场
// invisible; 0.9 leaves a tenth of the ground showing so a lawn still sits *in* the map rather than on top of it.
export const LANDCOVER_OPACITY = 0.9;

export function baseAtmospherePaint(layer, theme) {
  const source = layer['source-layer'];
  const paint = {};
  if (layer.type === 'background') paint['background-color'] = theme.background;
  if (layer.type === 'fill') {
    if (theme.otherFill && layer.paint?.['fill-color']) paint['fill-color'] = theme.otherFill;
    if (layer.paint?.['fill-pattern']) Object.assign(paint, { 'fill-pattern': theme.otherFill ? null : layer.paint['fill-pattern'], 'fill-color': theme.land });
    if (source === 'water') paint['fill-color'] = theme.water;
    // The green the brief asks for was in the frame all along, at 30 % opacity: the basemap paints `landcover_grass` at
    // `fill-opacity: 0.3` and `landcover_wood` at 0.4 over a near-white ground, so even the most saturated lawn in the
    // table arrived as a grey smudge. The opacity is the defect, not the hue. It is one constant across the three
    // atmospheres on purpose - `atmospherePaint` walks colours only, so a theme-varying opacity would be baked at boot
    // on day and then never move again.
    if (source === 'park') Object.assign(paint, { 'fill-color': theme.park, 'fill-opacity': LANDCOVER_OPACITY });
    if (source === 'landcover') Object.assign(paint, {
      // Trees and lawn are two different things and the frame has both: 40 `wood`/`forest` polygons against 178 `grass`
      // ones, including the whole 花城广场 axis. The basemap separates them by opacity alone, which at this camera is
      // not a separation at all, so the hierarchy moves into the colour.
      'fill-color': ['match', ['get', 'class'], 'wood', theme.wood, 'grass', theme.park, theme.land],
      'fill-opacity': LANDCOVER_OPACITY,
    });
    if (source === 'landuse') paint['fill-color'] = ['match', ['get', 'class'], ['park', 'recreation_ground', 'grass', 'cemetery'], theme.grass, theme.land];
    if (source === 'building') Object.assign(paint, { 'fill-color': theme.footprint, 'fill-opacity': 0.5 });
  }
  if (layer.type === 'line') {
    if (theme.otherLine && layer.paint?.['line-color']) paint['line-color'] = theme.otherLine;
    if (source === 'waterway') paint['line-color'] = theme.water;
    if (source === 'transportation') paint['line-color'] = layer.paint?.['line-gap-width'] ? theme.roadGap : layer.id.includes('casing') ? theme.casing : theme.road;
  }
  if (layer.type === 'symbol' && layer.layout?.['text-field']) Object.assign(paint, {
    'text-color': source === 'water_name' ? theme.waterText : theme.text,
    'text-halo-color': theme.halo, 'text-halo-width': 1.4,
  });
  return paint;
}

// Air perspective has to be painted by the buildings themselves. `setFog` no longer exists in MapLibre 6.10, and the
// seven `setSky` entries only reach the terrain program (`u_fog_*`) and the globe atmosphere: with every sky entry set
// to magenta, 0 of 1,382,400 pixels moved at 15.5/62, 14.6/60 and 12.5/58. So the recession is a colour ramp on
// `fill-extrusion-color`, which is data-driven, and its target is the theme's own fog colour - that is what makes the
// haze change with day, dusk and night rather than a second palette nobody reads.
// Alpha is not a lever: measured alpha floors of 1, 0.45 and 0.15 rendered byte-identical walls, and driving alpha to
// exactly 0 turned the far field dark instead of pale.
const HAZE_CURVE = [[1 / 3, 0.3], [0.62, 0.65], [0.86, 0.9]];
// A `Style.addLayer` whose paint fails validation is dropped in silence - no throw, no console error, and the whole
// layer vanishes from `getLayersOrder()`. That is why every blend is computed here as a hex: the validator only accepts
// literal numbers as an `interpolate` input, so an inner interpolate over a `['literal', share]` reads its colour
// argument as a stop and kills the layer.
export const mixHex = (from, to, share) => {
  const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
  const part = (at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * share).toString(16).padStart(2, '0');
  return `#${part(1)}${part(3)}${part(5)}`;
};
// The one input a data-driven colour can follow every frame without re-validating the style: the opening ease writes a
// number here instead of rebuilding this expression forty times.
export const HAZE_REVEAL = 'haze';
// The same channel carries the day/dusk/night walk. MapLibre cannot transition a data-driven paint by itself - in
// `style/properties.ts`: "Transitions to data-driven properties are not supported. We snap immediately to the
// data-driven value" - and the shipped building colour is data-driven, so the walk is one number every expression reads.
export const MOOD = 'mood';
export const ATMOSPHERE_MS = 1200;
// What no expression can interpolate: `resolvedImage` tiles and layer visibility change once, at this offset.
export const PATTERN_SWAP_MS = 600;

// Geometry, not palette, so it is written once and spread at every `setSky` call - the atmosphere switch used to drop
// these three and leave the horizon blends on MapLibre's defaults.
export const SKY_BLEND = { 'fog-ground-blend': 0.25, 'horizon-fog-blend': 0.7, 'sky-horizon-blend': 0.8 };

export function buildingAtmosphereColor(theme, fadeStart = 900, radius = RADIUS_METERS) {
  const haze = theme.sky['fog-color'];
  // `unknown` is the `match` fallback rather than a fifth case, so a block with no tag still recedes.
  const colors = (share) => ['match', ['get', 'category'],
    ...Object.entries(theme.buildings).flatMap(([key, value]) => key === 'unknown' ? [] : [key, mixHex(value, haze, share)]),
    mixHex(theme.buildings.unknown, haze, share)];
  const ramp = (start) => ['interpolate', ['linear'], ['get', 'distance'],
    0, colors(0), start, colors(0),
    ...HAZE_CURVE.flatMap(([t, share]) => [Math.round(start + (radius - start) * t), colors(share)]),
    radius, haze];
  // Seen from far up the same city recedes earlier, which is the only way to get the overview's air without touching
  // geometry. `['zoom']` has to be the outermost input - nested one level deep the validator rejects the whole property
  // with `"zoom" expression may only be used as input to a top-level "step" or "interpolate" expression` - so the reveal
  // rides inside each branch instead of wrapping them.
  const reveal = (start) => ['interpolate', ['linear'], ['global-state', HAZE_REVEAL], 0, ramp(start), 1, haze];
  return ['interpolate', ['linear'], ['zoom'], 12, reveal(Math.round(fadeStart * 0.4)), 16, reveal(fadeStart)];
}

// The blocks outside the ring come from the basemap and carry no `distance` property, but MapLibre 6.10 ships a
// `['distance', geojson]` expression, so the far field recedes on the same ramp instead of sitting behind the faded
// skyline as a harder, darker band.
export function contextAtmosphereColor(theme, center, radius = RADIUS_METERS) {
  return ['interpolate', ['linear'], ['distance', { type: 'Point', coordinates: center }],
    radius, theme.context, radius + 3500, theme.sky['fog-color']];
}

const isZoomRamp = (value) => Array.isArray(value) && value[0] === 'interpolate' && Array.isArray(value[2]) && value[2][0] === 'zoom';

/**
 * The colour one block of this category recedes to at this distance, as a number rather than an expression.
 *
 * `buildingAtmosphereColor` is what the extrusion layers paint with; a three.js shell cannot read a paint expression,
 * so it reads this instead. Both are derived from the same curve, the same fade start and the same theme fog, and the
 * zoom branch is reproduced the way the expression applies it: the two fade starts are each resolved to a colour and
 * then mixed, because that is what a linear `['zoom']` interpolate between two colours does.
 */
export function recedeColor(theme, category, distance, { reveal = 0, zoom = 16, fadeStart = 900, radius = RADIUS_METERS } = {}) {
  const haze = theme.sky['fog-color'];
  const base = theme.buildings[category] ?? theme.buildings.unknown;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  // MapLibre mixes the literal colours at the stops it is given, and each of those is already a rounded hex. Mixing the
  // share instead and blending once lands a unit off, which is exactly the kind of difference a pixel test reports.
  const ladder = (stops, value) => {
    if (value <= stops[0][0]) return stops[0][1];
    if (value >= stops.at(-1)[0]) return stops.at(-1)[1];
    const at = stops.findIndex(([_stop, _colour], index) => index > 0 && value <= stops[index][0]);
    const [low, lowColour] = stops[at - 1];
    const [high, highColour] = stops[at];
    return mixHex(lowColour, highColour, high === low ? 1 : (value - low) / (high - low));
  };
  const colour = (share) => mixHex(base, haze, share);
  const ramp = (start) => ladder([[0, colour(0)], [start, colour(0)],
    ...HAZE_CURVE.map(([t, share]) => [Math.round(start + (radius - start) * t), colour(share)]),
    [radius, haze]], clamp(distance, 0, radius));
  const lifted = (start) => ladder([[0, ramp(start)], [1, haze]], clamp(reveal, 0, 1));
  return ladder([[12, lifted(Math.round(fadeStart * 0.4))], [16, lifted(fadeStart)]], clamp(zoom, 12, 16));
}
const moodStops = (stops) => ['interpolate', ['linear'], ['global-state', MOOD], ...stops];

// Two declarations the same layer owns under two themes, joined so one number can walk between them.
//
// A `['zoom']` ramp keeps its own top level and is merged branch by branch: nested one level down, `['zoom']` makes the
// validator refuse the whole property and the layer goes on painting what it painted before, with no throw and no
// console error. Measured on the live page: wrapping the shipped building ramp left `getPaintProperty` byte-identical
// to it, while merging branch by branch took and walked. A theme that colours a layer with a flat value is applied at
// every branch of the other side's ramp, which is also what it paints between them.
//
// Three trees arrive when a walk is interrupted: the picture on screen is then `from`→`abandoned` part way along, and
// that expression is kept as the middle stop so the new walk continues from the frame the user is looking at instead of
// snapping back to `from`.
function blendTrees(trees, at) {
  const ramps = trees.filter(isZoomRamp);
  if (ramps.length) {
    const stops = [];
    for (let i = 3; i < ramps[0].length; i += 2) {
      for (const ramp of ramps) {
        if (ramp[i] !== ramps[0][i]) throw new Error(`themes do not share the zoom stop ${ramps[0][i]}: ${JSON.stringify(ramp)}`);
      }
      stops.push(ramps[0][i], blendTrees(trees.map((value) => isZoomRamp(value) ? value[i + 1] : value), at));
    }
    return ['interpolate', ramps[0][1], ramps[0][2], ...stops];
  }
  if (trees.length === 2 || !at) return moodStops([0, trees[0], 1, trees[trees.length - 1]]);
  return moodStops([0, trees[0], at, moodStops([0, trees[0], 1, trees[1]]), 1, trees[2]]);
}

export const themeBlend = (from, to) => blendTrees([from, to], 0);
export const themeResume = (from, abandoned, to, at) => blendTrees([from, abandoned, to], at);

// The tower, the light and the sky are three.js and style sections rather than paint, so they cannot read the map's
// global state: their preset is mixed here instead, and a share of exactly 0 or 1 returns the shipped object's own
// values, which is what hands the frame back to the breath loop untouched.
export function mixPreset(from, to, share) {
  if (Array.isArray(from)) return from.map((value, index) => mixPreset(value, to[index], share));
  if (typeof from === 'string') return from.startsWith('#') ? mixHex(from, to, share) : from;
  if (from !== null && typeof from === 'object') {
    const mixed = {};
    for (const [key, value] of Object.entries(from)) mixed[key] = mixPreset(value, to[key], share);
    return mixed;
  }
  return Math.round((from + (to - from) * share) * 1000) / 1000;
}


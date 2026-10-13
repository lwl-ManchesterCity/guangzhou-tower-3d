import test from 'node:test';
import assert from 'node:assert/strict';
import { ATMOSPHERES, ATMOSPHERE_MS, HAZE_REVEAL, LANDCOVER_OPACITY, MOOD, PATTERN_SWAP_MS, SKY_BLEND, baseAtmospherePaint, buildingAtmosphereColor, contextAtmosphereColor, mixPreset, recedeColor, themeBlend, themeResume } from '../src/atmosphere.js';

const layer = (type, source, paint = {}) => ({ id: source, type, 'source-layer': source, paint });


// The expression's own two helpers, kept local so the comparison above cannot be satisfied by the code under test
// agreeing with itself about something else.
const hex = (channel) => channel.toString(16).padStart(2, '0');
const mixHex = (from, to, share) => {
  const read = (value, at) => Number.parseInt(value.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => hex(Math.round(read(from, at) + (read(to, at) - read(from, at)) * share))).join('')}`;
};
const rgbOf = (value) => [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16));


test('atmospheres keep water, land, roads and labels in separate palettes', () => {
  const fixtures = [
    [layer('background'), 'background-color', ['#e9eeeb', '#d9b6a0', '#151f2e']],
    [layer('fill', 'water'), 'fill-color', ['#94c1c6', '#c98d5f', '#0a1e30']],
    [layer('line', 'waterway'), 'line-color', ['#94c1c6', '#c98d5f', '#0a1e30']],
    [layer('fill', 'park'), 'fill-color', ['#9ab88a', '#a39a62', '#111c16']],
    [layer('fill', 'landcover', { 'fill-color': '#b1c9af' }), 'fill-color', [
      ['match', ['get', 'class'], 'wood', '#758f6a', 'grass', '#9ab88a', '#e4eae3'],
      ['match', ['get', 'class'], 'wood', '#736f45', 'grass', '#a39a62', '#d2b19a'],
      ['match', ['get', 'class'], 'wood', '#0e1712', 'grass', '#111c16', '#182534'],
    ]],
    [layer('fill', 'landcover', { 'fill-color': '#b1c9af' }), 'fill-opacity', [0.9, 0.9, 0.9]],
    [layer('fill', 'park'), 'fill-opacity', [0.9, 0.9, 0.9]],
    [layer('fill', 'transportation', { 'fill-pattern': 'pedestrian_polygon' }), 'fill-pattern', ['pedestrian_polygon', null, null]],
    [layer('fill', 'transportation', { 'fill-pattern': 'pedestrian_polygon' }), 'fill-color', ['#e4eae3', '#d2b19a', '#182534']],
    [layer('line', 'transportation'), 'line-color', ['#f6f7f2', '#efd0ac', '#2b3a45']],
    [layer('line', 'transportation', { 'line-gap-width': 2 }), 'line-color', ['#c5ceca', '#aa8d82', '#2b4058']],
    [{ ...layer('symbol', 'water_name'), layout: { 'text-field': '珠江' } }, 'text-color', ['#537f8c', '#5e4034', '#85b6ce']],
  ];
  for (const [input, property, expected] of fixtures) {
    assert.deepEqual(Object.values(ATMOSPHERES).map(theme => baseAtmospherePaint(input, theme)[property]), expected);
  }
});

test('building atmosphere colors preserve classification and fade at the 3 km boundary', () => {
  const expression = buildingAtmosphereColor(ATMOSPHERES.night);
  const pure = ['match', ['get', 'category'], 'commercial', '#2c3846', 'residential', '#2a3341', 'public', '#27343c', '#242c38'];
  assert.deepEqual(expression[6][4].slice(3, 7), [0, pure, 900, pure]);
  assert.equal(expression[6][4][14], '#1a2330');
  // Hand-computed 30 % of the way from each night facade colour to the night fog colour.
  assert.deepEqual(expression[6][4][8], ['match', ['get', 'category'], 'commercial', '#27323f', 'residential', '#252e3c', 'public', '#232f38', '#212936']);
  for (const theme of Object.values(ATMOSPHERES)) {
    const ramp = buildingAtmosphereColor(theme)[6][4];
    assert.deepEqual(ramp.slice(-2), [3000, theme.sky['fog-color']]);
    assert.deepEqual(ramp[4], ['match', ['get', 'category'], 'commercial', theme.buildings.commercial,
      'residential', theme.buildings.residential, 'public', theme.buildings.public, theme.buildings.unknown]);
  }
});

test('every haze blend moves each category toward the fog without overshooting', () => {
  const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const blendOf = (matchNode, key) => {
    const at = matchNode.indexOf(key);
    return at > 0 ? matchNode[at + 1] : matchNode[matchNode.length - 1];
  };
  // The three interior stops sit at a third, 62 % and 86 % of the fade span, and carry 30 %, 65 % and 90 % of the fog.
  const curve = [[8, 1600, 0.3], [10, 2202, 0.65], [12, 2706, 0.9]];
  for (const theme of Object.values(ATMOSPHERES)) {
    const ramp = buildingAtmosphereColor(theme)[6][4];
    const haze = channels(theme.sky['fog-color']);
    for (const [stop, position, share] of curve) {
      assert.equal(ramp[stop - 1], position, `${theme.label}: stop ${position} m`);
      for (const [key, color] of Object.entries(theme.buildings)) {
        const from = channels(color);
        const to = channels(blendOf(ramp[stop], key));
        from.forEach((value, channel) => {
          assert.equal(to[channel], Math.round(value + (haze[channel] - value) * share), `${theme.label} ${key} channel ${channel} at ${share}`);
        });
      }
    }
    // The hero camera's near field is the shipped palette, byte for byte.
    assert.deepEqual(ramp[4], ['match', ['get', 'category'], 'commercial', theme.buildings.commercial,
      'residential', theme.buildings.residential, 'public', theme.buildings.public, theme.buildings.unknown]);
  }
});

test('an explicit fade start and radius move every stop without mutating the theme', () => {
  const positions = (ramp) => ramp.filter((_, index) => index >= 3 && index % 2 === 1);
  const assertStops = (expression, hero, overview) => {
    assert.deepEqual(positions(expression[6][4]), hero, 'hero camera ramp');
    assert.deepEqual(positions(expression[4][4]), overview, 'overview ramp');
  };
  const original = structuredClone(ATMOSPHERES);
  const cases = [
    [450, 3000, [0, 450, 1300, 2031, 2643, 3000], [0, 180, 1120, 1928, 2605, 3000]],
    [900, 3000, [0, 900, 1600, 2202, 2706, 3000], [0, 360, 1240, 1997, 2630, 3000]],
    [900, 2000, [0, 900, 1267, 1582, 1846, 2000], [0, 360, 907, 1377, 1770, 2000]],
  ];
  for (const theme of Object.values(ATMOSPHERES)) {
    const input = structuredClone(theme);
    for (const [fadeStart, radius, hero, overview] of cases) {
      const expression = buildingAtmosphereColor(input, fadeStart, radius);
      assertStops(expression, hero, overview);
      for (const [mutate, note] of [
        [(e) => { e[6][4][5] = hero[1] + 1; }, 'the hero fade start'],
        [(e) => { e[6][4][13] = hero[5] - 1; }, 'the outer radius'],
        [(e) => { e[4][4][5] = overview[1] + 1; }, 'the overview fade start'],
        [(e) => { e[4][4][7] = hero[2]; }, 'copying a hero stop into the overview'],
      ]) {
        const bad = structuredClone(expression);
        mutate(bad);
        assert.throws(() => assertStops(bad, hero, overview), assert.AssertionError, note);
      }
      assert.deepEqual(input, theme);
    }
    assert.deepEqual(buildingAtmosphereColor(input, undefined), buildingAtmosphereColor(input, 900));
    assert.deepEqual(buildingAtmosphereColor(input, 900, undefined), buildingAtmosphereColor(input, 900, 3000));
    assert.deepEqual(input, theme);
  }
  assert.deepEqual(ATMOSPHERES, original);
});

test('the opening reveal rides global state inside each zoom branch', () => {
  const theme = ATMOSPHERES.day;
  const expression = buildingAtmosphereColor(theme);
  assert.equal(HAZE_REVEAL, 'haze');
  // `["zoom"]` may only be the input of the outermost interpolate, so the reveal has to sit inside the branches.
  assert.deepEqual(expression.slice(0, 4), ['interpolate', ['linear'], ['zoom'], 12]);
  assert.deepEqual(expression.slice(5, 6), [16]);
  for (const branch of [expression[4], expression[6]]) {
    assert.deepEqual(branch.slice(0, 4), ['interpolate', ['linear'], ['global-state', HAZE_REVEAL], 0]);
    assert.deepEqual(branch.slice(5), [1, theme.sky['fog-color']]);
  }
  const assertReveal = (value) => {
    assert.deepEqual(value.slice(0, 4), ['interpolate', ['linear'], ['global-state', HAZE_REVEAL], 0]);
    assert.deepEqual(value.slice(5), [1, theme.sky['fog-color']]);
  };
  for (const mutate of [(b) => { b[2] = ['global-state', 'other']; }, (b) => { b[3] = 0.5; }, (b) => { b[6] = theme.background; }]) {
    const bad = structuredClone(expression[6]);
    mutate(bad);
    assert.throws(() => assertReveal(bad), assert.AssertionError);
  }
});

// A layer whose paint fails validation is dropped in silence: no throw, no console error, and the id simply disappears
// from `getLayersOrder()`. These are the rules that keep a built expression out of that pile.
const assertValidatorSafe = (node, top = true) => {
  if (!Array.isArray(node)) return;
  if (node[0] === 'interpolate') {
    const [, interpolation, input, ...stops] = node;
    assert.deepEqual(interpolation, ['linear']);
    assert.equal(stops.length % 2, 0, 'interpolate needs input/output pairs');
    assert.ok(stops.length >= 4, 'interpolate needs two pairs');
    if (!top) assert.notEqual(input[0], 'zoom', 'zoom may not nest');
    let previous = -Infinity;
    for (let index = 0; index < stops.length; index += 2) {
      assert.equal(typeof stops[index], 'number', 'stops must be literal numbers');
      assert.ok(stops[index] > previous, 'stops must ascend');
      previous = stops[index];
      assertValidatorSafe(stops[index + 1], false);
    }
    assertValidatorSafe(input, false);
    return;
  }
  node.slice(1).forEach((child) => assertValidatorSafe(child, false));
};

test('every shipped atmosphere expression is validator-safe, and the guard is not vacuous', () => {
  for (const theme of Object.values(ATMOSPHERES)) {
    for (const [fadeStart, radius] of [[450, 3000], [900, 3000], [900, 2000]]) {
      assertValidatorSafe(buildingAtmosphereColor(theme, fadeStart, radius));
    }
    assertValidatorSafe(contextAtmosphereColor(theme, [113.323, 23.1065]));
  }
  const ramp = buildingAtmosphereColor(ATMOSPHERES.day)[6][4];
  const mutants = {
    // The real defect this guard was written for: pairs left nested instead of flat-mapped into the argument list.
    nestedPairs: ['interpolate', ['linear'], ['get', 'distance'], 0, ramp[4], [900, ramp[6]], [1600, ramp[8]], 3000, '#ffffff'],
    oddPairs: ['interpolate', ['linear'], ['get', 'distance'], 0, ramp[4], 900],
    descending: ['interpolate', ['linear'], ['get', 'distance'], 3000, ramp[4], 900, ramp[6], 1600, '#ffffff'],
    nestedZoom: ['interpolate', ['linear'], ['global-state', HAZE_REVEAL], 0, ramp, 1, ['interpolate', ['linear'], ['zoom'], 12, '#ffffff', 16, '#000000']],
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    assert.throws(() => assertValidatorSafe(mutant), assert.AssertionError, name);
  }
});

test('night is a dark mass: every category sits in one deep blue-grey and nothing out-brightens the windows', () => {
  const night = ATMOSPHERES.night;
  const channels = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const lum = (value) => channels(value).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const day = ATMOSPHERES.day.buildings;
  for (const [key, value] of Object.entries(night.buildings)) {
    const [r, , b] = channels(value);
    assert.ok(b > r, `night ${key} is ${value}: a night wall has to be blue-grey, not a dimmed version of its day hue`);
    assert.ok(lum(value) < 56, `night ${key} is ${value} at ${lum(value).toFixed(0)}: the mass is the darkest thing in the frame except the sky`);
    assert.ok(lum(value) < lum(day[key]) * 0.55, `night ${key} has to fall well below its own day colour ${day[key]}`);
  }
  // Weak separation, not a colour chart: the four categories still differ, but by a fraction of the day spread.
  const spread = (buildings) => {
    const values = Object.values(buildings).map(lum);
    return Math.max(...values) - Math.min(...values);
  };
  assert.ok(spread(night.buildings) > 0 && spread(night.buildings) < spread(day) * 0.45,
    `night separates by ${spread(night.buildings).toFixed(0)} against day's ${spread(day).toFixed(0)}`);
  // The recession goes down into the distance. With the fog above the mass the far skyline would brighten as it receded,
  // which is what turned the first night frame into a horizon glow instead of a city falling away.
  assert.ok(lum(night.sky['fog-color']) < lum(night.buildings.unknown), 'the fog is darker than the darkest block');
  assert.ok(lum(night.sky['horizon-color']) < lum(night.buildings.commercial), 'and so is the horizon band');
  assert.ok(lum(night.sky['sky-color']) < lum(night.sky['fog-color']), 'the zenith is the darkest thing in the sky');
  // The ground the blocks stand on is not allowed to out-shine them either.
  for (const key of ['background', 'water', 'land', 'footprint', 'context', 'park', 'grass', 'wood']) {
    assert.ok(lum(night[key]) <= lum(night.buildings.unknown), `${key} at ${night[key]} is brighter than a night block`);
  }
  // The guard is not vacuous: this is the mass this scene shipped with, and it is the defect the ceiling was written
  // for. Every one of its four categories is brighter than the night wall is now allowed to be.
  const previous = { commercial: '#607a97', residential: '#485b73', public: '#638d9d', unknown: '#3b4e64' };
  for (const [key, value] of Object.entries(previous)) {
    assert.ok(!(lum(value) < 56), `night ${key} at the previous ${value} measures ${lum(value).toFixed(0)} and would pass`);
  }
  assert.ok(!(spread(previous) < spread(night.buildings) * 0.45), 'the previous separation was a colour chart next to this one');
});

// `fill_extrusion.vertex.glsl` in three lines: the per-face diffuse term is `clamp(dot(normal, light))`, it is then
// remapped onto `[1 - intensity, max(1 - colourLuminance + intensity, 1)]`, and the third number of `position` is the
// angle off the zenith, which decides how much of the light a face can get at all. Reproduced here so the day `light`
// is a claim about the frame instead of a pair of numbers somebody tuned by eye once.
const channels = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
const colourLuminance = (value) => channels(value).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0) / 255;

test('the day light separates a roof, a lit wall and a shaded wall, and the fog is a colour rather than white', () => {
  const day = ATMOSPHERES.day;
  const [intensity, [radial, azimuth, polar]] = [day.light.intensity, day.light.position];
  assert.equal(radial, 1.5, 'the radius of the light vector is normalised away by the shader, so it is decoration');
  assert.ok(azimuth > 0 && azimuth < 360, 'the azimuth is the one number that says which way the sun sits');
  // The upper bound of the remap is 1 only while the block is bright, which every day category is. Without this the
  // tone maths below would be a model of a case the scene never renders.
  for (const [key, value] of Object.entries(day.buildings)) {
    assert.equal(Math.max(1 - colourLuminance(value) + intensity, 1), 1, `day ${key} at ${value} lifts the ceiling above 1`);
  }
  const tone = (dot) => (1 - intensity) + Math.max(0, Math.min(1, dot)) * intensity;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const [roof, lit, shaded] = [tone(Math.cos(radians(polar))), tone(Math.sin(radians(polar))), tone(0)];
  assert.ok(roof > lit && lit > shaded, `a block has to read as three faces: roof ${roof.toFixed(2)}, lit ${lit.toFixed(2)}, shaded ${shaded.toFixed(2)}`);
  assert.ok(roof - lit > 0.15, `the roof has to separate from the lit wall rather than sit on it: ${(roof - lit).toFixed(2)}`);
  assert.ok(lit - shaded > 0.25, `and the two walls from each other: ${(lit - shaded).toFixed(2)}`);
  // Not vacuous: this is the light the day frame shipped with, and it is exactly the flat, paper-thin block the brief
  // describes. Its roof and its lit wall land within eight hundredths of each other.
  const oldTone = (dot) => (1 - 0.45) + dot * 0.45;
  const [oldRoof, oldLit] = [oldTone(Math.cos(radians(38))), oldTone(Math.sin(radians(38)))];
  assert.ok(!(oldRoof - oldLit > 0.15), `the previous light separated roof from wall by ${(oldRoof - oldLit).toFixed(2)}, which is why this test exists`);
  // The haze target is the whole point of the far field going grey-blue: white fog read as over-exposure, and a fog
  // with no blue in it is not air.
  const [r, g, b] = channels(day.sky['fog-color']);
  assert.ok(b > g && g > r, `day fog ${day.sky['fog-color']} is not a cool grey-blue`);
  assert.ok(b - r >= 12, `day fog has ${b - r} of blue over red: under that it is white`);
  assert.ok(colourLuminance(day.sky['fog-color']) < 0.93, `day fog is ${(colourLuminance(day.sky['fog-color']) * 100).toFixed(0)}% bright`);
  const [oldR, , oldB] = channels('#e8f0f0');
  assert.ok(!(oldB - oldR >= 12), 'the previous white fog would pass this test');
});

test('the green the brief asks for is lifted off the ground it was buried in', () => {
  const greens = ['park', 'grass', 'wood'];
  const lum = (value) => channels(value).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const [id, theme] of Object.entries(ATMOSPHERES)) {
    for (const key of greens) {
      const [r, g, b] = channels(theme[key]);
      assert.ok(g > b, `${id} ${key} ${theme[key]}: vegetation never carries more blue than green`);
      if (id === 'sunset') assert.ok(r > g, `sunset ${key} ${theme[key]}: the brief asks the green to lean warm, and a warm green is red over green`);
      else assert.ok(g > r, `${id} ${key} ${theme[key]}: a green that leans red is a brown`);
    }
    // Trees, lawn and the softer recreation ground are three classes the frame actually carries, and they have to be
    // three tones. The basemap separated them by opacity alone, which at this camera is not a separation.
    assert.ok(lum(theme.wood) < lum(theme.grass) && lum(theme.grass) < lum(theme.park),
      `${id}: wood ${lum(theme.wood).toFixed(0)} / grass ${lum(theme.grass).toFixed(0)} / park ${lum(theme.park).toFixed(0)}`);
  }
  const [day, sunset, night] = [ATMOSPHERES.day, ATMOSPHERES.sunset, ATMOSPHERES.night];
  // The three-mode linkage the brief asks for: the same polygon goes warmer at dusk and darker at night.
  for (const key of greens) {
    assert.ok(lum(day[key]) > lum(sunset[key]) && lum(sunset[key]) > lum(night[key]),
      `${key} has to step day ${lum(day[key]).toFixed(0)} > sunset ${lum(sunset[key]).toFixed(0)} > night ${lum(night[key]).toFixed(0)}`);
  }
  // Soft against hard: the axis is a green band *and* a paved plaza, and the two have to be one glance apart. The
  // previous day lawn sat 38 luminance units under the ground it was painted on, which is the "看不到绿" complaint.
  assert.ok(lum(day.land) - lum(day.park) > 40,
    `lawn and plaza are ${(lum(day.land) - lum(day.park)).toFixed(0)} apart`);
  assert.ok(lum(day.land) - lum('#b1c9af') < 40, 'the previous day lawn would pass that one, which is why it is here');
  // And the lift itself. This is the number that actually moved the axis from invisible to visible: the basemap painted
  // `landcover_grass` at 0.3 and `landcover_wood` at 0.4 over a near-white ground.
  assert.ok(LANDCOVER_OPACITY >= 0.85 && LANDCOVER_OPACITY < 1,
    `landcover sits at ${LANDCOVER_OPACITY}: under 0.85 the lawn is a smudge again, at 1 it is a sticker`);
});

// The same shader, read for the hour that is supposed to look like one: `fill_extrusion.vertex.glsl` lights each face
// by `clamp(dot(normal, light))` and remaps it onto `[1 - intensity, 1]`, so a low sun raking across the city is what
// puts one warm face and one dark face on every block. The brief's suggested workaround - painting the west faces with
// an overlay - is not needed, and would be worse: it cannot know which face the camera is looking at.
test('the sunset sun is low, in the west, and rakes the blocks instead of flooding them', () => {
  const sunset = ATMOSPHERES.sunset.light;
  const day = ATMOSPHERES.day.light;
  const [radial, azimuth, polar] = sunset.position;
  assert.equal(radial, 1.5);
  assert.ok(azimuth >= 225 && azimuth <= 285, `the sunset sun sits at azimuth ${azimuth}: the brief's golden hour is a western one`);
  assert.ok(polar >= 70, `the sun is ${polar}° off the zenith; under 70 it is still mid-afternoon`);
  assert.ok(polar > day.position[2], `the sunset sun (${polar}°) has to be lower in the sky than the day sun (${day.position[2]}°)`);
  const tone = (dot) => (1 - sunset.intensity) + Math.max(0, Math.min(1, dot)) * sunset.intensity;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  // The span across the four compass faces is the direction, and it is the one reading that does not depend on which
  // way MapLibre turns its azimuth - a high sun lights all four about equally, a low one lights one.
  const faces = [0, 90, 180, 270].map((bearing) => tone(Math.sin(radians(polar)) * Math.cos(radians(azimuth - bearing))));
  const span = Math.max(...faces) / Math.min(...faces);
  assert.ok(span >= 3.2, `the four faces span ${span.toFixed(2)}x: under that the light has no direction to read`);
  const oldFaces = [0, 90, 180, 270].map((bearing) => (1 - 0.6) + Math.max(0, Math.sin(radians(72)) * Math.cos(radians(255 - bearing))) * 0.6);
  assert.ok(Math.max(...oldFaces) / Math.min(...oldFaces) < 3.2, 'the shipped sunset light would still pass this test');
  // And the roof loses to the lit wall, which is what a sun near the horizon does and what the day light deliberately
  // does not: at noon the roof is the brightest face in the frame.
  const roof = tone(Math.cos(radians(polar)));
  assert.ok(roof < Math.max(...faces), 'a low sun cannot light a roof better than the wall it grazes');
  const dayTone = (dot) => (1 - day.intensity) + Math.max(0, Math.min(1, dot)) * day.intensity;
  assert.ok(dayTone(Math.cos(radians(day.position[2]))) > Math.max(...[0, 90, 180, 270].map((bearing) => dayTone(Math.sin(radians(day.position[2])) * Math.cos(radians(day.position[1] - bearing))))),
    'the day sun is high enough that the roof stays the brightest face');
});

test('context blocks recede from their own colour into the same fog', () => {
  const center = [113.323, 23.1065];
  const assertContext = (expression, theme, radius) => assert.deepEqual(expression,
    ['interpolate', ['linear'], ['distance', { type: 'Point', coordinates: center }],
      radius, theme.context, radius + 3500, theme.sky['fog-color']]);
  const original = structuredClone(ATMOSPHERES);
  for (const theme of Object.values(ATMOSPHERES)) {
    const input = structuredClone(theme);
    assertContext(contextAtmosphereColor(input, center), input, 3000);
    assertContext(contextAtmosphereColor(input, center, 2000), input, 2000);
    for (const mutate of [(e) => { e[3] = 2500; }, (e) => { e[4] = input.sky['fog-color']; }, (e) => { e[5] = 7000; }, (e) => { e[2] = ['get', 'distance']; }]) {
      const bad = structuredClone(contextAtmosphereColor(input, center));
      mutate(bad);
      assert.throws(() => assertContext(bad, input, 3000), assert.AssertionError);
    }
    assert.deepEqual(input, theme);
  }
  assert.deepEqual(ATMOSPHERES, original);
});

test('sky geometry survives a palette switch without touching the palette', () => {
  assert.deepEqual(Object.keys(SKY_BLEND).sort(), ['fog-ground-blend', 'horizon-fog-blend', 'sky-horizon-blend']);
  const assertPayload = (payload, theme) => {
    for (const [key, value] of Object.entries(theme.sky)) assert.equal(payload[key], value, key);
    for (const [key, value] of Object.entries(SKY_BLEND)) assert.equal(payload[key], value, key);
    assert.equal(Object.keys(payload).length, 6);
  };
  for (const theme of Object.values(ATMOSPHERES)) {
    assertPayload({ ...theme.sky, ...SKY_BLEND }, theme);
    assert.throws(() => assertPayload({ ...theme.sky }, theme), assert.AssertionError);
    assert.throws(() => assertPayload({ ...SKY_BLEND, ...theme.sky, 'fog-color': theme.background }, theme), assert.AssertionError);
    for (const key of Object.keys(SKY_BLEND)) assert.ok(!Object.hasOwn(theme.sky, key), `${key} belongs to the geometry, not the palette`);
  }
});

test('maquette presets keep the exact school contact and light parameters without mutating inputs', () => {
  const expected = {
    day: { contact: '#465755', light: { anchor: 'map', color: '#f6f4ee', intensity: 0.58, position: [1.5, 225, 52] } },
    sunset: { contact: '#68505b', light: { anchor: 'map', color: '#ffddb5', intensity: 0.52, position: [1.5, 255, 65] } },
    night: { contact: '#0b1a2a', light: { anchor: 'map', color: '#c9dded', intensity: 0.44, position: [1.5, 225, 45] } },
  };
  const original = structuredClone(ATMOSPHERES);
  for (const [id, preset] of Object.entries(expected)) {
    const assertPreset = value => assert.deepEqual(value, preset);
    assertPreset(ATMOSPHERES[id].maquette);
    const badContact = structuredClone(preset);
    badContact.contact = '#ff0000';
    assert.throws(() => assertPreset(badContact), assert.AssertionError);
    for (const [key, value] of Object.entries({ anchor: 'viewport', color: '#ff0000', intensity: 0, position: [1.5, 210, 28] })) {
      const bad = structuredClone(preset);
      bad.light[key] = value;
      assert.throws(() => assertPreset(bad), assert.AssertionError);
    }
    assert.throws(() => assertPreset({ ...preset, light: ATMOSPHERES[id].light }), assert.AssertionError);
    const input = structuredClone(ATMOSPHERES[id]);
    const featureLayer = layer('fill', 'building', { 'fill-color': '#cccccc' });
    const before = structuredClone(featureLayer);
    buildingAtmosphereColor(input, 450);
    baseAtmospherePaint(featureLayer, input);
    assert.deepEqual(input, original[id]);
    assert.deepEqual(featureLayer, before);
  }
  assert.deepEqual(ATMOSPHERES, original);
});

test('atmosphere paints do not mutate geometry, filters or the original daytime palette', () => {
  const input = { ...layer('line', 'boundary', { 'line-color': '#999999', 'line-width': 2 }), filter: ['==', ['get', 'level'], 2] };
  const original = structuredClone(input);
  const theme = structuredClone(ATMOSPHERES.night);
  assert.deepEqual(baseAtmospherePaint(input, ATMOSPHERES.night), { 'line-color': '#3b5066' });
  assert.deepEqual(baseAtmospherePaint(input, ATMOSPHERES.day), {});
  assert.deepEqual(input, original);
  assert.deepEqual(ATMOSPHERES.night, theme);
});

// MapLibre will not transition a data-driven paint of its own accord - `style/properties.ts` snaps it to the new value -
// so the atmosphere walk is carried by one `['global-state','mood']` number that every theme pair is merged around.
// These are the rules that keep that merge out of the silent-rejection pile.
test('a theme pair merges inside the zoom branches instead of wrapping them', () => {
  assert.equal(MOOD, 'mood');
  assert.deepEqual([ATMOSPHERE_MS, PATTERN_SWAP_MS], [1200, 600], 'the swap belongs at the middle of the walk');
  const [day, night] = [ATMOSPHERES.day, ATMOSPHERES.night];
  const flat = themeBlend(day.background, night.background);
  assert.deepEqual(flat, ['interpolate', ['linear'], ['global-state', MOOD], 0, '#e9eeeb', 1, '#151f2e']);

  const [from, to] = [buildingAtmosphereColor(day), buildingAtmosphereColor(night)];
  const blend = themeBlend(from, to);
  const assertMerged = (e) => {
    assert.deepEqual(e.slice(0, 4), ['interpolate', ['linear'], ['zoom'], 12], 'the zoom ramp keeps its top level');
    for (const branch of [4, 6]) {
      assert.deepEqual(e[branch].slice(0, 4), ['interpolate', ['linear'], ['global-state', MOOD], 0]);
      assert.deepEqual(e[branch][4], from[branch], 'the walk starts on the theme being left');
      assert.equal(e[branch][5], 1);
      assert.deepEqual(e[branch][6], to[branch], 'and ends on the one being entered');
    }
  };
  assertMerged(blend);
  // A theme that colours a layer with a flat value rides every branch of the other side's ramp unchanged.
  assert.deepEqual(themeBlend(['interpolate', ['linear'], ['zoom'], 12, '#ffffff', 16, '#000000'], '#808080'),
    ['interpolate', ['linear'], ['zoom'], 12,
      ['interpolate', ['linear'], ['global-state', MOOD], 0, '#ffffff', 1, '#808080'], 16,
      ['interpolate', ['linear'], ['global-state', MOOD], 0, '#000000', 1, '#808080']]);
  assert.throws(() => themeBlend(['interpolate', ['linear'], ['zoom'], 12, '#fff', 16, '#000'],
    ['interpolate', ['linear'], ['zoom'], 12, '#fff', 18, '#000']), /do not share the zoom stop/);

  for (const a of Object.values(ATMOSPHERES)) {
    for (const b of Object.values(ATMOSPHERES)) {
      assertValidatorSafe(themeBlend(buildingAtmosphereColor(a), buildingAtmosphereColor(b)));
      assertValidatorSafe(themeBlend(buildingAtmosphereColor(a, 450), buildingAtmosphereColor(b, 450)));
      assertValidatorSafe(themeBlend(contextAtmosphereColor(a, [113.323, 23.1065]), contextAtmosphereColor(b, [113.323, 23.1065])));
      assertValidatorSafe(themeBlend(a.water, b.water));
    }
  }
  // The guard is not vacuous: this is the form that reads naturally, and MapLibre refuses it in silence.
  assert.throws(() => assertValidatorSafe(['interpolate', ['linear'], ['global-state', MOOD], 0, from, 1, to]),
    assert.AssertionError, 'a wrapped zoom ramp must not pass');
  for (const mutate of [
    (e) => { e[4] = ['interpolate', ['linear'], ['global-state', MOOD], 0, to[4], 1, from[4]]; },
    (e) => { e[4][6] = from[4]; },
    (e) => { e[6][2] = ['global-state', 'other']; },
    (e) => { e[6][2] = ['zoom']; },
  ]) {
    const bad = structuredClone(blend);
    mutate(bad);
    assert.throws(() => assertMerged(bad), assert.AssertionError, 'the merged shape is pinned');
  }
});

test('an interrupted walk resumes from the frame the user is looking at', () => {
  const [a, b, c] = ['day', 'night', 'sunset'].map(id => buildingAtmosphereColor(ATMOSPHERES[id]));
  const resumed = themeResume(a, b, c, 0.4);
  assert.deepEqual(resumed.slice(0, 4), ['interpolate', ['linear'], ['zoom'], 12]);
  for (const branch of [4, 6]) {
    const walked = resumed[branch];
    assert.deepEqual(walked.slice(0, 4), ['interpolate', ['linear'], ['global-state', MOOD], 0]);
    assert.equal(walked[5], 0.4, 'the abandoned walk is picked up where it stood');
    // The middle stop is the very expression the abandoned walk was painting, so the frame at mood 0.4 is continuous.
    assert.deepEqual(walked[6], themeBlend(a[branch], b[branch]));
    assert.equal(walked[7], 1);
    assert.deepEqual(walked[8], c[branch]);
  }
  assertValidatorSafe(resumed);
  assert.deepEqual(themeResume(a, b, c, 0), themeBlend(a, c), 'with nothing to resume, the walk is the plain pair');
  for (const mutate of [(e) => { e[4][6] = c[4]; }, (e) => { e[4].splice(5, 2); }, (e) => { e[4][3] = 0.6; }]) {
    const bad = structuredClone(resumed);
    mutate(bad);
    assert.throws(() => {
      for (const branch of [4, 6]) {
        assert.deepEqual(bad[branch][6], themeBlend(a[branch], b[branch]));
        assert.equal(bad[branch][5], 0.4);
        assert.equal(bad[branch][3], 0);
      }
    }, assert.AssertionError, 'the resume stop is pinned');
  }
});

test('mixed presets hand back the shipped values at both ends of the walk', () => {
  const original = structuredClone(ATMOSPHERES);
  for (const key of ['tower', 'light', 'sky', 'maquette']) {
    for (const from of Object.values(ATMOSPHERES)) {
      for (const to of Object.values(ATMOSPHERES)) {
        assert.deepEqual(mixPreset(from[key], to[key], 0), from[key], `${key} at the start`);
        assert.deepEqual(mixPreset(from[key], to[key], 1), to[key], `${key} at the end`);
      }
    }
  }
  // Hand-computed midpoint of the day and night key lights: each channel is the rounded mean, the anchor is not a colour.
  assert.deepEqual(mixPreset(ATMOSPHERES.day.light, ATMOSPHERES.night.light, 0.5),
    { anchor: 'map', color: '#e1e7f1', intensity: 0.48, position: [1.5, 210, 30] });
  const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  for (const [key, path] of [['tower', ['colors', 'silver']], ['tower', ['emission', 'warm', 0]], ['light', ['color']], ['sky', ['fog-color']]]) {
    const read = (theme) => path.reduce((value, step) => value[step], theme[key]);
    const [from, to] = [read(ATMOSPHERES.day), read(ATMOSPHERES.night)];
    if (typeof from !== 'string') continue;
    const mid = channels(mixPreset(from, to, 0.5));
    assert.ok(mid.every((value, channel) => (value - channels(from)[channel]) * (channels(to)[channel] - value) >= 0),
      `the walk moves ${key}.${path} from ${from} toward ${to} without overshooting: ${mid}`);
  }
  assert.deepEqual(ATMOSPHERES, original, 'mixing must not touch the shipped tables');
  for (const mutate of [(m) => { m.color = '#000000'; }, (m) => { m.intensity = 1; }, (m) => { m.anchor = 'viewport'; }]) {
    const bad = mixPreset(ATMOSPHERES.day.light, ATMOSPHERES.night.light, 0.5);
    mutate(bad);
    assert.notDeepEqual(bad, { anchor: 'map', color: '#e1e7f1', intensity: 0.48, position: [1.5, 210, 30] });
  }
});


// A three.js shell cannot read a paint expression, so `recedeColor` re-derives the same colour in JavaScript. Two
// tables that agree by luck are worse than one: this reads the shipped expression back and demands the same hex.
const evaluate = (expression, state) => {
  const [op] = expression;
  if (op === 'interpolate') {
    const input = expression[2];
    const value = input[0] === 'zoom' ? state.zoom : input[0] === 'global-state' ? state.reveal : state.distance;
    const stops = [];
    for (let index = 3; index < expression.length; index += 2) stops.push([expression[index], expression[index + 1]]);
    if (value <= stops[0][0]) return evaluate(stops[0][1], state);
    if (value >= stops.at(-1)[0]) return evaluate(stops.at(-1)[1], state);
    const at = stops.findIndex(([_stop, colour], index) => index > 0 && value <= stops[index][0]);
    const [low, lowColour] = stops[at - 1];
    const [high, highColour] = stops[at];
    return mixHex(evaluate(lowColour, state), evaluate(highColour, state), (value - low) / (high - low));
  }
  if (op === 'match') {
    const key = state.category;
    for (let index = 2; index < expression.length - 1; index += 2) if (expression[index] === key) return expression[index + 1];
    return expression.at(-1);
  }
  if (op === 'get') return undefined;
  return expression;
};

test('a shell recedes to exactly the hex the extrusion ramp paints at the same distance', () => {
  for (const id of Object.keys(ATMOSPHERES)) {
    const theme = ATMOSPHERES[id];
    const paint = buildingAtmosphereColor(theme);
    for (const zoom of [11.5, 12, 13.4, 16, 18]) for (const reveal of [0, 0.37, 1]) {
      for (const distance of [0, 200, 360, 900, 1200, 2200, 3000, 4000]) {
        for (const category of ['commercial', 'residential', 'public', 'unknown']) {
          const state = { zoom, reveal, distance, category };
          assert.equal(recedeColor(theme, category, distance, { zoom, reveal }), evaluate(paint, state),
        `${id} zoom ${zoom} reveal ${reveal} ${distance} m ${category}`);
        }
      }
    }
  }
});

test('the recession walks the way the ramp does: still at the foot, into the fog at the ring', () => {
  const theme = ATMOSPHERES.day;
  const fog = theme.sky['fog-color'];
  assert.equal(recedeColor(theme, 'commercial', 400, { zoom: 16 }), theme.buildings.commercial);
  assert.equal(recedeColor(theme, 'commercial', 900, { zoom: 16 }), theme.buildings.commercial);
  assert.equal(recedeColor(theme, 'commercial', 3000, { zoom: 16 }), fog);
  assert.equal(recedeColor(theme, 'commercial', 40, { zoom: 16, reveal: 1 }), fog);
  assert.equal(recedeColor(theme, 'commercial', 3000, { zoom: 12, reveal: 1 }), fog);
  // An untagged block is the match fallback, and it has to recede like every other category rather than stay flat.
  // "Recede" is measured as the distance to the fog closing, not as every channel climbing: the day fog is a grey-blue
  // whose red sits *under* an untagged block's own red, so a warm block loses red while it gains blue. The old form of
  // this claim only held because the fog it was written against was near-white in all three channels.
  const steps = [900, 1400, 1900, 2400, 2900].map((distance) => rgbOf(recedeColor(theme, 'unknown', distance, { zoom: 16 })));
  const fogRGB = rgbOf(fog);
  const away = (rgb) => Math.hypot(...rgb.map((value, channel) => value - fogRGB[channel]));
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(away(steps[index]) < away(steps[index - 1]),
      `the unknown ramp steps back: ${JSON.stringify(steps)} sits at ${steps.map(away).map((d) => d.toFixed(1))}`);
    assert.ok(steps[index][2] - steps[index][0] >= steps[index - 1][2] - steps[index - 1][0],
      `and picks up the fog's blue cast as it goes: ${JSON.stringify(steps)}`);
  }
  // The first step is the block's own colour, so the whole ladder is a walk away from it.
  assert.deepEqual(steps[0], rgbOf(theme.buildings.unknown));
});

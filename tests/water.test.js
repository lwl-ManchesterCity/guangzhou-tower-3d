import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WATER_IMAGE_PREFIX, WATER_THEMES, scrollWater, waterTexture } from '../src/water.js';
import { ATMOSPHERES } from '../src/atmosphere.js';

const alphaAt = (image, x, y) => image.data[(y * image.width + x) * 4 + 3];
const rgbaAt = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
};
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const waterSource = () => readFileSync(new URL('../src/water.js', import.meta.url), 'utf8');
// A flat fill-pattern covers one screen pixel per image pixel at any zoom, unlike the facade grid, which is measured in
// world metres. A metre constant here would be a number nobody can defend.
const assertNoMetreClaim = (source) => assert.equal(/METRES/.test(source), false, 'the module must not claim a metre scale for a screen-space tile');

// Everything the renderer depends on, checked on one image so a defect cannot hide in a looser test. `gen` is the
// generator that produced the image: the density check has to re-run that same generator, or a mutant would be graded
// against the shipped one and pass.
function assertTile(name, image, options, gen = waterTexture) {
  const { size, rows, crest, trough = null, density } = options;
  assert.equal(image.width, size, `${name}: width`);
  assert.equal(image.height, size, `${name}: height`);
  assert.ok(image.data instanceof Uint8Array, `${name}: addImage needs a Uint8Array`);
  assert.equal(image.data.length, size * size * 4, `${name}: RGBA only, no RGB rows`);
  assert.ok(size % rows === 0, `${name}: rows must divide the edge evenly`);
  const band = size / rows;
  assert.ok(band >= 4, `${name}: a band needs room for ink and for a clear gutter (${band})`);
  // The band's bottom rows stay clear, because MapLibre repeats the tile and a crest on the wrap row comes back as a
  // continuous stripe down the river. A crest walks down one row over its length and carries a shadow below it, so the
  // last row it can reach is `inkRows + 1`; everything past that is gutter.
  const inkRows = Math.min(2, Math.max(1, band - 2));
  const inkLast = inkRows + 1;
  let inked = 0;
  const alphas = new Set();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const pixel = rgbaAt(image, x, y);
    alphas.add(pixel[3]);
    if (!pixel[3]) continue;
    inked++;
    const row = Math.floor(y / band), offset = y - row * band;
    assert.ok(offset <= inkLast, `${name}: ink left the band at ${x},${y}`);
    if (trough && pixel[3] === trough[3]) {
      assert.deepEqual(pixel, trough, `${name}: a shadow pixel is exactly the trough colour at ${x},${y}`);
      assert.ok(offset >= 1, `${name}: a shadow cannot sit on the band's top row at ${x},${y}`);
    } else assert.deepEqual(pixel, crest, `${name}: a highlight pixel is exactly the crest colour at ${x},${y}`);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (y % band > inkLast) assert.equal(alphaAt(image, x, y), 0, `${name}: the band gutter is inked at ${x},${y}`);
  }
  const coverage = inked / (size * size);
  assert.ok(coverage > 0.02 && coverage < 0.35, `${name}: the water has to stay the majority of the tile (${coverage})`);
  // Density is not decoration in the contract: a calmer setting has to draw a calmer tile, or the theme numbers are inert.
  const thinner = gen({ ...options, density: Math.max(0.05, density / 3) });
  let calm = 0;
  for (let p = 3; p < thinner.data.length; p += 4) if (thinner.data[p]) calm++;
  assert.ok(calm < inked, `${name}: a lower density must draw fewer crests (${calm} vs ${inked})`);
  assert.deepEqual([...alphas].sort((a, b) => a - b), [...new Set([0, crest[3], ...(trough ? [trough[3]] : [])])].sort((a, b) => a - b),
    `${name}: exactly one alpha per material`);
  assert.ok(crest[3] > 0 && crest[3] < 255, `${name}: a translucent overlay, not a painted river`);
  if (trough) {
    assert.ok(luminance(crest) > luminance(trough) + 40, `${name}: a crest has to read as light over its shadow`);
    assert.ok(trough[3] > 0 && trough[3] < 255, `${name}: the shadow is translucent too`);
  }
  assert.ok(image.dashes > 0, `${name}: the tile has to report what it drew`);
  assert.ok(density > 0 && density < 1, `${name}: a scatter, not a flood (${density})`);
  return { coverage, inked };
}

// A scroll is a rotation of the pristine tile's rows: the same crests, one whole band edge lower or higher, and nothing
// in between. `scroll` is the module's own function, so a mutant is graded against the rule it is meant to break.
function assertScroll(name, tile, offset, scroll = scrollWater) {
  const size = tile.height;
  const step = ((offset % size) + size) % size;
  const scrolled = scroll(tile, offset);
  assert.equal(scrolled.width, tile.width, `${name}: a scroll cannot change the repeat`);
  assert.equal(scrolled.height, size, `${name}: a scroll cannot change the repeat`);
  assert.equal(scrolled.data.length, tile.data.length, `${name}: a scroll cannot add or drop a pixel`);
  assert.notEqual(scrolled.data, tile.data, `${name}: every frame needs a buffer of its own`);
  assert.equal(scrolled.dashes, tile.dashes, `${name}: a scroll draws no new crest, so it cannot report a different count`);
  const inked = (image) => { let count = 0; for (let p = 3; p < image.data.length; p += 4) if (image.data[p]) count++; return count; };
  assert.equal(inked(scrolled), inked(tile), `${name}: the crests have to move, not multiply (${inked(tile)} vs ${inked(scrolled)})`);
  // Every row at a spread of columns, and two rows in full: a rotation is a per-row rule, so one wrong column of a
  // wrong row would still fail here, while a whole-image scan of eight offsets would only cost the suite its patience.
  const columns = [0, 5, 17, 31, 48, tile.width - 1];
  for (let y = 0; y < size; y++) for (const x of columns) {
    assert.deepEqual(rgbaAt(scrolled, x, y), rgbaAt(tile, x, (y + step) % size),
      `${name}: row ${y} must carry the source row ${(y + step) % size} at x ${x}`);
  }
  for (const y of [0, Math.floor(size / 2)]) for (let x = 0; x < tile.width; x++) {
    assert.deepEqual(rgbaAt(scrolled, x, y), rgbaAt(tile, x, (y + step) % size),
      `${name}: row ${y} must be one whole source row at every column`);
  }
  return scrolled;
}

// Everything the animation loop depends on, on every atmosphere's own tile.
function assertAllScrolls(scroll) {
  for (const [id, options] of Object.entries(WATER_THEMES)) {
    const tile = waterTexture(options);
    const size = tile.height;
    for (const offset of [0, 1, 13, size - 1, size, size + 6, -1, -13]) assertScroll(`${id}/${offset}`, tile, offset, scroll);
    assert.deepEqual(scroll(scroll(tile, 3), 4).data, scroll(tile, 7).data,
      `${id}: re-scrolling a scroll must land on the same row, or a long session would drift`);
    const before = Buffer.from(tile.data).toString('base64');
    scroll(tile, 9);
    assert.equal(Buffer.from(tile.data).toString('base64'), before, `${id}: the pristine tile cannot be written into`);
    assert.throws(() => scroll(tile, 1.5), /whole number/, `${id}: a half pixel would resample the tile`);
    for (let k = 1; k < size; k++) {
      const shifted = scroll(tile, k).data;
      assert.ok(shifted.some((byte, p) => byte !== tile.data[p]), `${id}: offset ${k} must be a frame of its own, not the shipped tile`);
    }
  }
}

async function mutatedWater(from, to) {
  const url = new URL('../src/water.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must replace exactly one source fragment');
  const changed = source.replace(from, to).replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

test('every atmosphere has exactly one water texture, named the way the layer looks it up', () => {
  assert.deepEqual(Object.keys(WATER_THEMES).sort(), Object.keys(ATMOSPHERES).sort(),
    'a theme without a texture would point the layer at a missing image');
  for (const [id, options] of Object.entries(WATER_THEMES)) {
    assert.equal(`${WATER_IMAGE_PREFIX}-${id}`, `river-surface-${id}`);
    assertTile(id, waterTexture(options), options);
  }
});

test('the tile is a screen-space rhythm, so it may never be priced in metres', () => {
  assertNoMetreClaim(waterSource());
  for (const options of Object.values(WATER_THEMES)) {
    assert.ok(options.size >= 32 && options.size <= 96, `one repeat is ${options.size} px on screen`);
  }
});

test('a tile is bands of short crests, each with its shadow and a clear gutter below', () => {
  const { size, rows, crest, trough } = WATER_THEMES.day;
  const image = waterTexture(WATER_THEMES.day);
  const band = size / rows;
  let crests = 0, shadows = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = alphaAt(image, x, y);
    if (a === crest[3]) crests++;
    if (a === trough[3]) shadows++;
  }
  assert.ok(crests > 0 && shadows > 0, `both materials have to be on the tile (${crests} crest, ${shadows} shadow px)`);
  assert.ok(shadows < crests * 1.5, `the shadow follows the crest, it does not outdraw it (${shadows}/${crests})`);
  for (let x = 0; x < size; x++) assert.equal(alphaAt(image, x, band - 1), 0, 'the row above the wrap is clear');
});

test('the sunset river is warm at both stops, and no blue-violet survives in the pair', () => {
  const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const { crest, trough } = WATER_THEMES.sunset;
  // Both stops the brief names are present, one on the fill and one in the sheen's shadow row.
  assert.equal(ATMOSPHERES.sunset.water, '#c98d5f', 'the lit channel');
  assert.deepEqual(trough.slice(0, 3), hex('#8a6a58'), 'the water in the bank\'s shade');
  // A warm colour is red > green > blue. The violet this replaced had green *under* blue, which is the one ordering no
  // sunset light produces, and it is why no amount of warming the rest of the frame could make that river read.
  const stops = { channel: hex(ATMOSPHERES.sunset.water), sky: crest.slice(0, 3), shade: trough.slice(0, 3) };
  for (const [name, rgb] of Object.entries(stops)) {
    const [r, g, b] = rgb;
    assert.ok(r > g && g > b, `sunset ${name} is ${JSON.stringify(rgb)}: red over green over blue, or it is not a warm stop`);
  }
  // And the three are a ramp, not one colour written three times: sky in the water is the brightest thing on the
  // surface, the channel sits under it, and the bank's shade is the darkest.
  assert.ok(luminance(stops.sky) > luminance(stops.channel), 'the crest is the highlight');
  assert.ok(luminance(stops.channel) > luminance(stops.shade), 'and the shade is the shadow');
  assert.ok(luminance(stops.sky) - luminance(stops.shade) > 60,
    `the pair spans ${(luminance(stops.sky) - luminance(stops.shade)).toFixed(0)}: under that the band is not visible`);
  // Not vacuous: this is the fill and the shadow row this scene shipped with.
  for (const [name, value] of [['channel', '#a98c9c'], ['shade', [104, 46, 62]]]) {
    const [r, g, b] = typeof value === 'string' ? hex(value) : value;
    assert.ok(!(r > g && g > b), `the previous sunset ${name} ${JSON.stringify(value)} would pass this test`);
  }
});

test('the generator is deterministic and the seed and density decide the surface', () => {
  const night = WATER_THEMES.night;
  assert.deepEqual(waterTexture(night), waterTexture(night), 'the same options must produce the same image');
  const first = waterTexture(night);
  const second = waterTexture({ ...night, seed: 0x7c19 });
  assert.notDeepEqual(first.data, second.data, 'a different seed must move the crests');
  assert.notEqual(first.dashes, second.dashes, 'the draw is per band, so a reshuffle moves the count too');
  const sparse = waterTexture({ ...night, density: 0.15 });
  const busy = waterTexture({ ...night, density: 0.9 });
  assert.ok(sparse.dashes < busy.dashes, `density has to steer the count (${sparse.dashes} vs ${busy.dashes})`);
  assertTile('sparse', sparse, { ...night, density: 0.15 });
});

test('a tile that cannot divide evenly is refused instead of drawing a seam', () => {
  assert.throws(() => waterTexture({ size: 30, rows: 4 }), /divide evenly/, 'rows must divide the edge');
});

test('texture assertions kill guard/bleed/opacity/randomness/density/trough/count/metre mutants', async t => {
  const specs = [
    ['divisibility guard', 'if (size % rows) throw', 'if (false) throw', []],
    ['crest bleeds past the band', 'const inkRows = Math.min(2, Math.max(1, band - 2));', 'const inkRows = band;', ['day', 'sunset', 'night']],
    ['opaque crest hides the river', 'crest: [255, 255, 255, 72]', 'crest: [255, 255, 255, 255]', ['day']],
    ['seeded randomness', 'const next = seededRandom(seed);', 'const next = seededRandom((Math.random() * 1e9) >>> 0);', []],
    ['density ignored', 'if (next() < density) {', 'if (true) {', ['day', 'sunset', 'night']],
    ['shadow never drawn', 'if (trough) put(x + k, y + 1', 'if (false) put(x + k, y + 1', ['day', 'sunset', 'night']],
    ['reported dash count', '        dashes++;', '', ['day', 'sunset', 'night']],
    ['metre claim', 'export const WATER_IMAGE_PREFIX', 'export const WATER_METRES_PER_PIXEL = 3;\nexport const WATER_IMAGE_PREFIX', []],
  ];
  const correct = Object.fromEntries(Object.entries(WATER_THEMES).map(([id, options]) => [id, waterTexture(options)]));
  for (const [name, from, to, rejected] of specs) await t.test(name, async () => {
    const mutant = await mutatedWater(from, to);
    if (name === 'divisibility guard') {
      const uneven = { size: 30, rows: 4, crest: [255, 255, 255, 40], density: 0.5 };
      assert.doesNotThrow(() => mutant.waterTexture(uneven), 'the mutant must accept an uneven tile');
      assert.throws(() => assertTile('uneven', mutant.waterTexture(uneven), uneven), /divide the edge evenly/,
        'and the positive check must reject what the guard let through');
    } else if (name === 'seeded randomness') {
      assert.notDeepEqual(mutant.waterTexture(WATER_THEMES.night), mutant.waterTexture(WATER_THEMES.night), 'the mutant must wobble');
    } else if (name === 'metre claim') {
      assert.ok(/METRES/.test(waterSource().replace(from, to)), 'the mutant source must actually carry the claim');
      assert.throws(() => assertNoMetreClaim(waterSource().replace(from, to)), /metre scale/,
        'the honesty guard has to reject a module that prices the tile in metres');
      assertNoMetreClaim(waterSource());
    } else {
      for (const [id, options] of Object.entries(mutant.WATER_THEMES)) {
        const image = mutant.waterTexture(options);
        if (rejected.includes(id)) {
          assert.throws(() => assertTile(id, image, options, mutant.waterTexture),
            /divide the edge evenly|ink left the band|gutter is inked|majority of the tile|translucent overlay|one alpha per material|exactly the crest colour|exactly the trough colour|band's top row|has to report|crest has to read|must draw fewer crests/,
            `${id} must be rejected under the ${name} mutant`);
        } else assert.doesNotThrow(() => assertTile(id, image, options, mutant.waterTexture), `${id} is outside the ${name} mutant`);
      }
    }
    assert.deepEqual(Object.fromEntries(Object.entries(WATER_THEMES).map(([id, options]) => [id, waterTexture(options)])), correct,
      'the module under test must still produce the pinned images');
  });
});

test('a scroll is an exact rotation, so the river can drift for an hour and stay in its bands', () => {
  assertAllScrolls(scrollWater);
});

test('the frame the loop resets to is the frame the page shipped with', () => {
  for (const [id, options] of Object.entries(WATER_THEMES)) {
    const tile = waterTexture(options);
    assert.deepEqual(scrollWater(tile, 0), tile, `${id}: turning the river off cannot leave a shifted row behind`);
  }
});

const scrollRejects = /buffer of its own|different count|cannot change the repeat|cannot add or drop|not multiply|must carry the source row|whole number|same row|written into|frame of its own|every column|resample the tile/;

test('scroll assertions kill wrap/clamp/direction/alias/guard/count mutants', async (t) => {
  const specs = [
    ['wrap dropped', 'const step = ((offset % height) + height) % height;', 'const step = Math.abs(offset);'],
    ['clamped instead of wrapped', 'const step = ((offset % height) + height) % height;', 'const step = Math.min(Math.abs(offset), height - 1);'],
    ['rows slide the other way', 'const from = (((y + step) % height) * rowBytes);', 'const from = (((y - step + height) % height) * rowBytes);'],
    ['the pristine tile is written into', 'const data = new Uint8Array(source.length);', 'const data = source;'],
    ['half pixels accepted', 'if (!Number.isInteger(offset)) throw', 'if (false) throw'],
    ['reported dash count dropped', 'dashes: image.dashes ?? 0', 'dashes: 0'],
  ];
  const shipped = Object.fromEntries(Object.entries(WATER_THEMES).map(([id, options]) => [id, waterTexture(options)]));
  for (const [name, from, to] of specs) await t.test(name, async () => {
    const mutant = await mutatedWater(from, to);
    assert.throws(() => assertAllScrolls(mutant.scrollWater), scrollRejects, `${name} must be rejected`);
    if (name === 'half pixels accepted') {
      assert.doesNotThrow(() => mutant.scrollWater(waterTexture(WATER_THEMES.day), 1.5), 'the mutant must accept a half pixel');
      assert.throws(() => scrollWater(waterTexture(WATER_THEMES.day), 1.5), /whole number/, 'and the guard has to refuse one');
    }
    assert.doesNotThrow(() => assertAllScrolls(scrollWater), 'the shipped module must still pass');
    assert.deepEqual(Object.fromEntries(Object.entries(WATER_THEMES).map(([id, options]) => [id, waterTexture(options)])), shipped,
      'the module under test must still produce the pinned images');
  });
});

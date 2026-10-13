import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FACADE_CATEGORY_SHAPES, FACADE_FALLBACK_SHAPE, FACADE_IMAGE_PREFIX, FACADE_METRES_PER_PIXEL, FACADE_SHAPES, FACADE_THEMES, FACADE_TILE_SIZE, GLOW_IMAGE_PREFIX, LAMP_BREATHE_MODULUS, LAMP_BREATHE_RESIDUE, GLOW_NEAR_IMAGE_PREFIX, GLOW_PEAK, WINDOWS_OFF_IMAGE, LAMP_ALT_IMAGE_PREFIX, LAMP_NEAR_ALT_IMAGE_PREFIX, LAMP_DARK_MODULUS, LAMP_DARK_RESIDUE, LAMP_GROUPS, LAMP_KEYS, LAMP_PERIODS_MS, LAMP_SET_SEEDS, LAMP_SWAP_SHARE, LAMP_TRANSITION, LIGHT_BANDS, LIGHT_DENSITY_HALF, LIGHT_DENSITY_MODULUS, LIGHT_FADES, LIGHT_IMAGE_PREFIX, LIGHT_TIER_BELOW, LIGHT_TIER_ROWS, LIGHT_NEAR_IMAGE_PREFIX, LIGHT_NEAR_SCALE, LIGHT_NEAR_ZOOM, LIGHT_TEMPERATURE_MODULUS, LIGHT_TEMPERATURES, LIGHT_TEMPERATURE_WEIGHTS, LIGHT_TILE, facadeImage, facadeOptions, facadePattern, facadeTexture, glowTexture, isLampDark, lampBandExpression, lampBandOf, lampDarkness, lampDensityBit, lampTemperatureDeal, lampTemperatureOf, lampTierOf, lampWeight, lampBreather, isLampBreather, lightTexture, windowsOffTile } from '../src/facade.js';
import { ATMOSPHERES } from '../src/atmosphere.js';
import { categoryLabels } from '../src/buildings.js';


const alphaAt = (image, x, y) => image.data[(y * image.width + x) * 4 + 3];
const rgbaAt = (image, x, y) => {
  const offset = (y * image.width + x) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
};
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// How much of its own window's alpha a halo may take. A bare "less than" stopped being a guard once the lamp ladder ran
// to 252: a halo that came to 218 against the dimmest window at 224 still cleared it, and that much spill is a second,
// blurrier set of panes rather than the glow under a light. The share is stated against the window instead of as an alpha
// so the claim keeps its bite however the ladder moves.
const HALO_SHARE = 0.75;

// Everything the renderer depends on, checked on one image so a defect cannot hide in a looser test.
function assertTile(name, image, options) {
  const { size, rows, columns, glass, lit = null, litShare = 0, groundAlpha = null } = options;
  assert.equal(image.width, size, `${name}: width`);
  assert.equal(image.height, size, `${name}: height`);
  assert.ok(image.data instanceof Uint8Array, `${name}: addImage needs a Uint8Array`);
  assert.equal(image.data.length, size * size * 4, `${name}: RGBA only, no RGB rows`);
  assert.ok(size % rows === 0 && size % columns === 0, `${name}: rows and columns must divide the edge evenly`);
  const cellY = size / rows, cellX = size / columns;
  let glassPixels = 0, litPixels = 0, litCells = 0;
  const alphas = new Set();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const pixel = rgbaAt(image, x, y);
    alphas.add(pixel[3]);
    if (pixel[3] === 0) continue;
    if (lit && pixel[3] === lit[3]) { litPixels += 1; continue; }
    assert.deepEqual(pixel, glass, `${name}: a tinted pixel is exactly the glass colour at ${x},${y}`);
    glassPixels += 1;
  }
  // A cell is either bare or carries one pane, and every painted cell carries the same pane: that is what makes the tile
  // read as a facade rhythm instead of noise. Compared across cells rather than against cell (0,0), because a lamps-only
  // tile deliberately leaves most cells bare.
  let signature = null;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const covered = [];
    for (let dy = 0; dy < cellY; dy++) for (let dx = 0; dx < cellX; dx++) {
      if (alphaAt(image, column * cellX + dx, row * cellY + dy) > 0) covered.push(`${dx},${dy}`);
    }
    if (lit && alphaAt(image, column * cellX, row * cellY) === lit[3]) litCells += 1;
    if (!covered.length) continue;
    if (signature === null) signature = covered.join('|');
    else assert.equal(covered.join('|'), signature,
      `${name}: cell ${row}/${column} carries a different pane than the cell before it`);
  }
  // The last row and column stay clear: MapLibre repeats the tile, and a pane touching the edge comes back as a half
  // window on the neighbouring wall.
  for (let i = 0; i < size; i++) {
    assert.equal(alphaAt(image, size - 1, i), 0, `${name}: no pane on the wrapping column`);
    assert.equal(alphaAt(image, i, size - 1), 0, `${name}: no pane on the wrapping row`);
  }
  const coverage = (glassPixels + litPixels) / (size * size);
  if (groundAlpha === null) {
    assert.ok(coverage > 0.3 && coverage < 0.55, `${name}: the wall has to stay the majority of the tile (${coverage})`);
    // The transparent ground has to stay fully transparent: it is the only reason the category colour and the distance
    // fade on the layer underneath still reach the screen.
    assert.deepEqual([...alphas].sort((a, b) => a - b), [...new Set([0, glass[3], ...(lit ? [lit[3]] : [])])].sort((a, b) => a - b),
      `${name}: exactly one alpha per material`);
    assert.ok(glass[3] > 0 && glass[3] < 255, `${name}: a translucent overlay, not a painted wall`);
  } else {
    // A lamps-only tile is the one exception to "translucent glass": it is laid over the grid, so everything that is not
    // a lit window must be *fully* transparent, or the wall would be dimmed twice. Which means the tile has to leave the
    // clear majority of the wall unpainted all by itself.
    assert.deepEqual([...alphas].sort((a, b) => a - b), [...new Set([groundAlpha, lit[3]])].sort((a, b) => a - b),
      `${name}: only clear ground and lamps`);
    assert.equal(glass[3], 0, `${name}: an unlit window has to be clear, not tinted`);
    assert.ok(coverage < 0.3, `${name}: the densest tier may not paint most of the wall (${coverage})`);
  }
  assert.equal(image.litPanes, litCells, `${name}: the reported lit count matches the pixels`);
  if (lit) {
    assert.ok(litCells > 0 && litCells < rows * columns, `${name}: some windows are lit, not all (${litCells}/${rows * columns})`);
    if (options.litCells === undefined) assert.ok(litShare > 0 && litShare < 0.5, `${name}: a share of the grid, not a flood (${litShare})`);
    // A tier is a count, not a probability: an 11 % share over a small grid once came out with zero lit windows.
    else assert.equal(litCells, options.litCells, `${name}: the tile must land on its declared cell count`);
    assert.ok(luminance(lit) > luminance(glass) + 60, `${name}: a lit window has to read as light`);
  } else assert.equal(litPixels, 0, `${name}: no lighting in a daytime theme`);
  return { coverage, glassPixels, litPixels, litCells };
}

async function mutatedFacade(from, to) {
  const url = new URL('../src/facade.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(from).length, 2, 'mutation must replace exactly one source fragment');
  const changed = source.replace(from, to).replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

test('every atmosphere has its own tile for every category rhythm, named the way the layer looks it up', () => {
  assertFacadeContract({ FACADE_IMAGE_PREFIX, FACADE_THEMES, FACADE_SHAPES, FACADE_CATEGORY_SHAPES, FACADE_FALLBACK_SHAPE,
    FACADE_TILE_SIZE, FACADE_METRES_PER_PIXEL, WINDOWS_OFF_IMAGE, facadeImage, facadeOptions, facadePattern, facadeTexture, lampDarkness });
});

// The whole grid contract in one entry point, so a defect injection only has to break the module.
function assertFacadeContract(module) {
  const { FACADE_THEMES: themes, FACADE_SHAPES: shapes, FACADE_CATEGORY_SHAPES: mapping, FACADE_FALLBACK_SHAPE: fallback,
    FACADE_TILE_SIZE: size, FACADE_METRES_PER_PIXEL: metres, facadeImage: image, facadeOptions: options,
    facadePattern: pattern, facadeTexture: texture } = module;
  assert.deepEqual(Object.keys(themes).sort(), Object.keys(ATMOSPHERES).sort(),
    'a theme without a texture would point the layer at a missing image');
  assert.deepEqual(Object.keys(shapes).sort(), ['civic', 'curtain', 'dense', 'plain'],
    'four rhythms for four categories; a fifth tile nothing asks for is dead weight');
  // Every category the snapshot can carry has to be named here, or that block silently wears the fallback: the snapshot
  // splits 2,057 unknown / 1,415 residential / 282 commercial / 236 public, so an unmapped category is most of the city.
  assert.deepEqual(Object.keys(mapping).sort(), Object.keys(categoryLabels).sort(),
    'the mapping must cover exactly the categories the snapshot produces');
  for (const [category, shape] of Object.entries(mapping)) {
    assert.ok(shapes[shape], `category ${category} maps to ${shape}, which is not a rhythm`);
  }
  assert.equal(new Set(Object.values(mapping)).size, Object.keys(mapping).length,
    'two categories on one rhythm is three rhythms dressed up as four');
  assert.ok(Object.values(mapping).includes(fallback), 'the fallback has to be a rhythm some category also wears');

  const tiles = [];
  for (const atmosphere of Object.keys(themes)) {
    for (const shape of Object.keys(shapes)) {
      const name = image(atmosphere, shape);
      assert.equal(name, `building-facade-${atmosphere}-${shape}`, `${name}: the layer looks tiles up by this spelling`);
      const optionsOf = options(atmosphere, shape);
      assert.equal(optionsOf.size, size, `${name}: one tile edge for every rhythm`);
      const imageOf = texture(optionsOf);
      tiles.push({ atmosphere, shape, name, options: optionsOf, image: imageOf });
      assertTile(name, imageOf, optionsOf);
    }
  }
  // The day grid is the one that has to survive a sunlit wall, and it is the only one of the three that was ever tuned to
  // a whisper: at 54 it came in *under* the sunset pane, which is the reading the brief calls invisible. Its ceiling is
  // the `translucent overlay, not a painted wall` claim inside assertTile.
  const paneOf = (atmosphere) => themes[atmosphere].glass[3];
  assert.ok(paneOf('day') > Math.max(paneOf('sunset'), paneOf('night')),
    `the day pane is ${paneOf('day')} against ${paneOf('sunset')} at sunset and ${paneOf('night')} at night: the grid that has to read in full daylight cannot be the faintest of the three`);
  // V7's alpha cut on the grid's own night windows: 150 -> 110. These are a second set of windows painted under the
  // lamp overlay on the same wall, and at 150 they were bright enough to read as light themselves, which is what made
  // a night wall look like a pale board with a few brighter squares on it. It still has to clear the glass it sits in.
  assert.ok(themes.night.lit[3] >= 100 && themes.night.lit[3] <= 120,
    `the grid's own night window is ${themes.night.lit[3]} of 255: V7 asks for ~110, and under 100 it is gone entirely`);
  assert.ok(themes.night.lit[3] < themes.day.glass[3] + 60,
    'and it may never out-shine the day grid it is the night counterpart of');
  // An atmosphere restyles every rhythm, and a rhythm differs from its neighbours in something the screen can resolve.
  for (const shape of Object.keys(shapes)) {
    const byAtmosphere = tiles.filter((tile) => tile.shape === shape);
    assert.equal(byAtmosphere.length, Object.keys(themes).length, `${shape}: one tile per atmosphere`);
    for (let index = 1; index < byAtmosphere.length; index++) {
      assert.notDeepEqual(byAtmosphere[index].image.data, byAtmosphere[0].image.data,
        `${shape}: ${byAtmosphere[index].atmosphere} copies ${byAtmosphere[0].atmosphere}, so the hour does nothing`);
    }
  }
  const signatureOf = (tile) => {
    const { rows, columns, paneYShare, paneXShare } = tile.options;
    const cellY = size / rows, cellX = size / columns;
    return [rows, columns, Math.round(cellY * paneYShare), Math.round(cellX * paneXShare),
      Math.round(((Math.round(cellY * paneYShare) * Math.round(cellX * paneXShare)) / (cellY * cellX)) * 1000)].join('/');
  };
  const dayTiles = tiles.filter((tile) => tile.atmosphere === 'day');
  const signatures = new Map();
  for (const tile of dayTiles) {
    const signature = signatureOf(tile);
    assert.ok(!signatures.has(signature),
      `${tile.shape} and ${signatures.get(signature)} are the same rhythm (${signature}): one category would wear another's grid`);
    signatures.set(signature, tile.shape);
  }
  // Measured floor: a wall face is ~1.6 m per screen pixel at the hero camera, so a band under 5 m or a pane under
  // 2.7 m wide is averaged back into the wall and the rhythm is a claim the renderer cannot keep.
  for (const tile of dayTiles) {
    const { rows, columns, paneYShare, paneXShare } = tile.options;
    const band = (size / rows) * metres, bay = (size / columns) * metres;
    const paneY = Math.round(band * paneYShare), paneX = Math.round(bay * paneXShare);
    assert.ok(band > 5 && band < 15, `${tile.shape}: a storey band is ${band.toFixed(1)} m, outside 5-15 m it is either `
      + 'one real floor or a smear');
    assert.ok(bay > 3.5 && bay < 8, `${tile.shape}: a bay is ${bay.toFixed(1)} m`);
    assert.ok(paneY * metres >= 3.6 && paneX * metres >= 2.7,
      `${tile.shape}: a pane is ${(paneY * metres).toFixed(1)} x ${(paneX * metres).toFixed(1)} m, too small to read as a window`);
    assert.ok(band * metres > 0 && paneY * metres < band * metres, `${tile.shape}: the pane has to leave a clear band`);
  }
  const bands = Object.fromEntries(dayTiles.map((tile) => [tile.shape, (size / tile.options.rows) * metres]));
  assert.equal(new Set(Object.values(bands)).size, 2,
    `three tower rhythms share one band and civic doubles it (${Object.entries(bands).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')})`);
  // The expression is what hangs the tiles: a category missing from it silently wears the fallback, and a name it
  // invents is a layer with no pattern. At night the whole rhythm hangs inside one more switch: the blocks whose own id
  // says they burn nothing wear a transparent tile, so a dark building is dark on both window layers at once.
  for (const atmosphere of Object.keys(themes)) {
    const wrapped = pattern(atmosphere);
    const isNight = Boolean(themes[atmosphere].lit);
    assert.equal(wrapped[0], isNight ? 'case' : 'match', `${atmosphere}: only the night grid has windows of its own to switch off`);
    const expression = isNight ? wrapped[3] : wrapped;
    if (isNight) {
      assert.deepEqual(wrapped[1], module.lampDarkness(), `${atmosphere}: the switch reads the same id residue the lamps do`);
      assert.equal(wrapped[2], module.WINDOWS_OFF_IMAGE, `${atmosphere}: a dark block has to land on the transparent tile`);
    }
    assert.equal(expression[0], 'match', `${atmosphere}: the grid is chosen per block, not per layer`);
    assert.deepEqual(expression[1], ['get', 'category'], `${atmosphere}: it reads the block's own category`);
    const names = wrapped.flat(Infinity).filter((part) => typeof part === 'string');
    for (const tile of tiles.filter((tile) => tile.atmosphere === atmosphere)) {
      assert.ok(names.includes(tile.name), `${atmosphere}: ${tile.shape} is generated but never hung on the layer`);
    }
    if (isNight) assert.ok(names.includes(module.WINDOWS_OFF_IMAGE), `${atmosphere}: the dark blocks' tile is never hung on the layer`);
    const pairs = expression.slice(2, -1);
    assert.equal(pairs.length, Object.keys(mapping).length * 2, `${atmosphere}: one image per mapped category`);
    for (const [category, shape] of Object.entries(mapping)) {
      const index = pairs.indexOf(category);
      assert.ok(index >= 0, `${atmosphere}: ${category} is missing from the expression and would fall through`);
      assert.equal(pairs[index + 1], image(atmosphere, shape), `${atmosphere}: ${category} wears the wrong tile`);
    }
    assert.equal(expression.at(-1), image(atmosphere, fallback), `${atmosphere}: the fallback is not a registered tile`);
  }
  assert.throws(() => pattern('dusk'), /unknown atmosphere/);
  assert.throws(() => options('day', 'tower'), /unknown facade shape/);
  assert.throws(() => options('dusk', 'dense'), /unknown atmosphere/);
}

test('a tile is a periodic window lattice with a clear wrap edge', () => {
  for (const shape of Object.keys(FACADE_SHAPES)) {
    const options = facadeOptions('day', shape);
    const { size, rows, columns, paneYShare, paneXShare, glass } = options;
    const image = facadeTexture(options);
    const cellY = size / rows, cellX = size / columns;
    assert.ok(cellY >= 4 && cellX >= 3, `${shape}: a cell needs room for glass and for a clear-storey gap`);
    // A pane sits inside its cell with both a vertical and a horizontal gap, so the grid reads as windows and mullions.
    assert.deepEqual(rgbaAt(image, 0, 0), glass, `${shape}: the top-left of a cell is glass`);
    const paneX = Math.round(cellX * paneXShare), paneY = Math.round(cellY * paneYShare);
    assert.equal(alphaAt(image, paneX, 0), 0, `${shape}: past the pane is a mullion`);
    assert.equal(alphaAt(image, 0, paneY), 0, `${shape}: past the pane is a clear storey band`);
    assert.equal(alphaAt(image, cellX - 1, 0), 0, `${shape}: the right of a cell is a mullion`);
    assert.equal(alphaAt(image, 0, cellY - 1), 0, `${shape}: the bottom of a cell is a clear storey band`);
  }
});

test('the grid is measured in world metres, so a band can never be read as one floor', () => {
  for (const shape of Object.keys(FACADE_SHAPES)) {
    const { size, rows } = facadeOptions('day', shape);
    const band = (size / rows) * FACADE_METRES_PER_PIXEL;
    assert.ok(band > 5 && band < 15, `${shape}: one row is ${band.toFixed(1)} m: two storeys or four, never one`);
    assert.ok(size * FACADE_METRES_PER_PIXEL > 25 && size * FACADE_METRES_PER_PIXEL < 34,
      `${shape}: one repeat is ${(size * FACADE_METRES_PER_PIXEL).toFixed(1)} m of wall`);
  }
  // The civic band is exactly double the tower bands, which is the whole reason a hall reads differently from a tower.
  const bandOf = (shape) => (facadeOptions('day', shape).size / facadeOptions('day', shape).rows) * FACADE_METRES_PER_PIXEL;
  for (const shape of ['curtain', 'dense', 'plain']) assert.ok(Math.abs(bandOf(shape) - bandOf('civic') / 2) < 0.01,
    `${shape}: expected half the civic band, got ${bandOf(shape).toFixed(1)} m against ${(bandOf('civic') / 2).toFixed(1)} m`);
});

test('the generator is deterministic and the seed decides which windows light up', () => {
  for (const shape of Object.keys(FACADE_SHAPES)) {
    const night = facadeOptions('night', shape);
    assert.deepEqual(facadeTexture(night), facadeTexture(night), `${shape}: the same options must produce the same image`);
    const first = facadeTexture(night);
    const second = facadeTexture({ ...night, seed: 0x2b71 });
    assert.notDeepEqual(first.data, second.data, `${shape}: a different seed must move the lit windows`);
    assert.equal(second.litPanes, first.litPanes, `${shape}: a count is a count, whichever seed draws it`);
    assert.equal(first.litPanes, night.litCells, `${shape}: the tile lands on its declared lit count`);
    assert.ok(first.litPanes > 0 && second.litPanes > 0, `${shape}: both seeds have to leave some windows alight`);
    assert.notDeepEqual(facadeTexture({ ...night, litCells: night.litCells + 1 }).data, first.data,
      `${shape}: asking for one more lit window has to move the pixels`);
  }
});


test('a tile that cannot divide evenly is refused instead of drawing a seam', () => {
  assert.throws(() => facadeTexture({ size: 32, rows: 5, columns: 8 }), /divide evenly/, 'rows must divide the edge');
  assert.throws(() => facadeTexture({ size: 32, rows: 4, columns: 7 }), /divide evenly/, 'columns must divide the edge');
});

// Which cells a lamp sits in is read back from the pixels, so the test does not re-derive the generator's own shuffle.
function lampCells(image, { size, rows, columns, alpha }) {
  const cellY = size / rows, cellX = size / columns;
  const found = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    if (alphaAt(image, column * cellX, row * cellY) === alpha) found.push(row * columns + column);
  }
  return found;
}

// The whole contract of the night lamp family, in one entry point so a defect injection only has to break the module.
function assertLampGeometry(module) {
  const { LIGHT_BANDS, LIGHT_TEMPERATURES, LIGHT_FADES, LIGHT_TILE, GLOW_PEAK } = module;
  // The ladder's shape, which is the one thing a per-building dice cannot be allowed to blur: three height tiers of two
  // densities each, so a block's height decides how brightly it burns and its own id decides how busy it is.
  const rungRows = module.LIGHT_TIER_ROWS, tierCount = module.LIGHT_TIER_BELOW.length;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  assert.equal(LIGHT_BANDS.length, rungRows * tierCount,
    `the ladder is ${tierCount} height tiers of ${rungRows} densities; a row that goes missing changes what a whole class of building wears`);
  assert.deepEqual(LIGHT_BANDS.map((band) => band.cells), [2, 3, 3, 4, 4, 5],
    'the layer expression and the tiles must agree on how many bands exist and what each one lights');
  for (let tier = 0; tier < tierCount; tier++) {
    const pair = LIGHT_BANDS.slice(tier * rungRows, tier * rungRows + rungRows);
    assert.equal(new Set(pair.map((band) => band.alpha)).size, 1,
      `tier ${tier}: the two densities of one height have to burn at one brightness, or density and brightness are one knob`);
    assert.equal(new Set(pair.map((band) => band.below)).size, 1, `tier ${tier}: both rows have to answer to the same height`);
    assert.equal(pair[0].below, module.LIGHT_TIER_BELOW[tier],
      `tier ${tier}: the threshold the row carries and the one the tier list names have to be the same number`);
    assert.ok(pair[1].cells > pair[0].cells, `tier ${tier}: the second row lights no more windows than the first, so the dice decides nothing`);
  }
  for (let tier = 1; tier < tierCount; tier++) {
    assert.ok(LIGHT_BANDS[tier * rungRows].alpha > LIGHT_BANDS[tier * rungRows - 1].alpha,
      'a taller tier has to be brighter as well as busier, or the height hierarchy stops being visible');
    assert.ok(LIGHT_BANDS[tier * rungRows].cells >= LIGHT_BANDS[tier * rungRows - 1].cells,
      'and a tall block never lights fewer windows than a short one, whichever way its dice lands');
  }
  assert.equal(LIGHT_BANDS.at(-1).below, Infinity, 'the tallest band has to be open at the top');
  // V7's share, read off the counts rather than off the intent: eight to thirty per cent of the grid, per building.
  const shares = LIGHT_BANDS.map((band) => band.cells / (LIGHT_TILE.rows * LIGHT_TILE.columns));
  // A 4x4 grid deals windows in steps of 6.25 %, so the band V7 names cannot be hit exactly: the top rung is one
  // window over the 30 % ceiling and the bottom one is double the floor. Both are within a window of what was asked.
  assert.ok(Math.min(...shares) >= 0.08 && Math.max(...shares) <= 0.32,
    `the ladder spans ${(Math.min(...shares) * 100).toFixed(1)}% to ${(Math.max(...shares) * 100).toFixed(1)}% of a 4x4 grid: V7 asks for 8% to 30%, and a window is the finest it can deal`);
  assert.ok(new Set(shares).size >= 4, `${new Set(shares).size} distinct shares is a height ladder again, not a per-building density`);
  // The dice itself. A residue of a prime that nothing else in the layer is dealt from, so density cannot ride along
  // with the cross-fade group, the colour temperature or the buildings that are switched off.
  assert.equal(gcd(module.LIGHT_DENSITY_MODULUS, module.LAMP_GROUPS), 1,
    'density dealt from the group residue would make one breathing half of the city denser than the other');
  assert.equal(gcd(module.LIGHT_DENSITY_MODULUS, module.LIGHT_TEMPERATURE_MODULUS), 1, 'and the same against the colour deal');
  assert.equal(gcd(module.LIGHT_DENSITY_MODULUS, module.LAMP_DARK_MODULUS), 1, 'and against the blocks that burn nothing');
  const bits = Array.from({ length: module.LIGHT_DENSITY_MODULUS }, (_, id) => module.lampDensityBit(id));
  assert.equal(bits.filter((bit) => bit).length, module.LIGHT_DENSITY_HALF, `the dice splits the residues ${bits.filter((bit) => bit).length}/${bits.length}, not the share the constants name`);
  assert.equal(module.lampDensityBit(6), 1, 'a residue under the half wears the denser row');
  assert.equal(module.lampDensityBit(7), 0, 'and one at the half wears the sparser row');
  // The rule and the expression, one definition each - checked against each other so the tile the unit test builds and
  // the tile the layer asks for cannot drift apart.
  assert.equal(module.lampBandOf(18, 7), 0, 'a short block on a sparse residue sits on the first rung');
  assert.equal(module.lampBandOf(18, 6), 1, 'and the same block on a dense residue one rung up');
  assert.equal(module.lampBandOf(40, 13), 3, 'a mid-height block lands in the middle of the ladder');
  assert.equal(module.lampBandOf(200, 6), 5, 'a tower on a dense residue sits on the top rung');
  assert.equal(module.lampBandOf(200, 7), 4, 'and the same tower one rung down when its dice says sparser');
  assert.deepEqual(module.lampBandExpression(['coalesce', ['get', 'displayHeight'], ['get', 'height']]),
    ['+', ['*', ['step', ['coalesce', ['get', 'displayHeight'], ['get', 'height']], 0, 24, 1, 100, 2], rungRows],
      ['case', ['<', ['%', ['to-number', ['get', 'osmId'], 0], module.LIGHT_DENSITY_MODULUS], module.LIGHT_DENSITY_HALF], 1, 0]],
    'the rung a block wears is its own height times the rows of a tier plus the dice, spelled out here so a changed expression has to be a decided change');
  assert.equal(LIGHT_TEMPERATURES.length, 3, 'three colour temperatures, named the way the layer looks them up');
  // The recession cannot live in `fill-extrusion-opacity`, which is not data-driven, so a dimmer ring has to be its own
  // tile: the ladder below is what the layer's image name reads.
  assert.equal(LIGHT_FADES.length, 3, 'three distance rings, named the way the layer looks them up');
  assert.ok(LIGHT_FADES.every((ring, index) => index === 0 || ring.below > LIGHT_FADES[index - 1].below),
    'a step expression with ring thresholds out of order silently collapses two rings into one image');
  assert.equal(LIGHT_FADES.at(-1).below, Infinity, 'the farthest ring has to be open at the top');
  assert.ok(LIGHT_FADES.every((ring, index) => index === 0 || ring.dim < LIGHT_FADES[index - 1].dim),
    'each ring has to be dimmer than the one before it, or the ladder is not a recession');
  assert.equal(LIGHT_FADES[0].dim, 1, 'the near ring is the reference the other two are scaled against');
  assert.ok(LIGHT_FADES.at(-1).dim < 0.5 && LIGHT_FADES.at(-1).dim > 0.1,
    `the far ring keeps ${LIGHT_FADES.at(-1).dim} of the light: above half it is still foreground, under a tenth it is gone`);
  const alphaOf = (band, ring) => Math.round(LIGHT_BANDS[band].alpha * LIGHT_FADES[ring].dim);
  // The dimmest lamp in the whole ladder still has to clear the night wall grid it is laid over, or a far block reads as
  // more mullion rather than as light.
  assert.ok(alphaOf(0, LIGHT_FADES.length - 1) > module.FACADE_THEMES.night.glass[3],
    'the dimmest lamp has to stay brighter than the wall behind it');
  // What the night palette is actually for: the windows have to win. Composited over the *brightest* night mass and put
  // through the night light, every near-ring band has to clear the wall it sits on by a wide margin. The first night
  // frame failed here without failing anywhere else - the lamps were correct and the walls were a third as bright as
  // they are, so the ratio was ~1.4 and the city read as "daytime, dimmed" rather than as a dark skyline with lights.
  const NIGHT_LIGHT = [0.5, 0.58, 0.74];
  const through = (rgb) => luminance(rgb.map((channel, index) => channel * NIGHT_LIGHT[index]));
  const ratioFor = (mass, band, temperature) => {
    const alpha = alphaOf(band, 0) / 255;
    return through(mass.map((channel, at) => channel + (temperature[at] - channel) * alpha)) / through(mass);
  };
  const ofHex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const nightMass = Object.values(ATMOSPHERES.night.buildings).map(ofHex)
    .reduce((a, b) => (luminance(b) > luminance(a) ? b : a));
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    for (const [index, temperature] of LIGHT_TEMPERATURES.entries()) {
      const ratio = ratioFor(nightMass, band, temperature);
      assert.ok(ratio >= 2, `band ${band} temperature ${index} reaches the screen at ${ratio.toFixed(2)}x the night wall: ${alphaOf(band, 0)} of 255 over ${JSON.stringify(nightMass)}`);
    }
  }
  // The guard is not vacuous: this is the mass this scene shipped with, and it is the defect the ratio was written for.
  const oldMass = ofHex('#607a97');
  assert.ok(ratioFor(oldMass, 2, LIGHT_TEMPERATURES[0]) < 2,
    `the previous night wall would still pass at ${ratioFor(oldMass, 2, LIGHT_TEMPERATURES[0]).toFixed(2)}x`);
  assert.equal(`${module.LIGHT_IMAGE_PREFIX}-0-0-0`, 'building-lights-0-0-0', 'a renamed image would leave the layer with no pattern');
  assert.equal(`${module.GLOW_IMAGE_PREFIX}-2-2-2`, 'building-glow-2-2-2', 'and the same for the spill under it');
  // V7's colour budget for the night windows: 80% warm, 20% cool. `osmId % 3` dealt them evenly, which put a third of
  // the city in the blue-white of an office slab - the "全白" of the brief. The deal is a step over ten buckets now, so
  // the shares are exact rationals rather than whatever the id range happened to land on.
  const weights = module.LIGHT_TEMPERATURE_WEIGHTS, modulus = module.LIGHT_TEMPERATURE_MODULUS;
  assert.equal(weights.length, module.LIGHT_TEMPERATURES.length, 'every colour temperature has to be dealt a bucket');
  assert.equal(weights.reduce((a, b) => a + b, 0), modulus, 'the buckets have to add up to the modulus or one colour is never dealt');
  // ... and the rule that deals them has to be checkable without a browser. An off-by-one in the stop list put the
  // boundaries at 8 and 10, which dealt no cool white at all to anybody, and only the frame ever showed it.
  const dealt = module.LIGHT_TEMPERATURES.map(() => 0);
  for (let id = 0; id < modulus; id++) dealt[module.lampTemperatureOf(id)]++;
  assert.deepEqual(dealt, weights, `the rule deals ${dealt.join('/')} against the weights ${weights.join('/')}`);
  assert.deepEqual(module.lampTemperatureDeal(),
    ['step', ['%', ['to-number', ['get', 'osmId'], 0], modulus], 0, 4, 1, 8, 2],
    'and the expression the layer hangs hands out the same four-four-two');
  assert.equal((weights[0] + weights[1]) / modulus, 0.8, `${(weights[0] + weights[1]) / modulus} of the city is warm: V7 asks for 80%`);
  assert.equal(weights[2] / modulus, 0.2, `${weights[2] / modulus} is the cool end: V7 asks for 20%`);
  // And the buildings that burn nothing. One residue class of a prime modulus, coprime with both the colour deal and
  // the cross-fade groups, so switching them off cannot thin either distribution.
  const dark = module.lampDarkness();
  assert.deepEqual(dark, ['==', ['%', ['to-number', ['get', 'osmId'], 0], module.LAMP_DARK_MODULUS], module.LAMP_DARK_RESIDUE],
    'the dark slice has to be read off the block, not placed by hand');
  assert.equal(gcd(module.LAMP_DARK_MODULUS, modulus), 1, 'a modulus sharing a factor with the colour deal would thin one of them');
  assert.equal(gcd(module.LAMP_DARK_MODULUS, module.LAMP_GROUPS), 1, 'and the same against the cross-fade groups');
  const darkShare = 1 / module.LAMP_DARK_MODULUS;
  assert.ok(darkShare > 0.08 && darkShare < 0.12, `${(darkShare * 100).toFixed(1)}% of the blocks go dark: V7 asks for ~10%`);
  assert.ok(module.LAMP_DARK_RESIDUE < module.LAMP_DARK_MODULUS, 'a residue outside the modulus switches nobody off');
  // The same rule run over the ids themselves, because an expression that reads well can still deal nothing: ten full
  // turns of the modulus have to hand exactly ten blocks to the dark.
  const darks = [];
  for (let id = 0; id < module.LAMP_DARK_MODULUS * 10; id++) if (module.isLampDark(id)) darks.push(id);
  assert.deepEqual(darks, [7, 18, 29, 40, 51, 62, 73, 84, 95, 106],
    `the dark slice lands on ${darks.join('/')}, not one residue class in eleven`);
  // The blocks that breathe a whole facade at once (项 3, C 档). Same shape of dice for the same reason, and the same
  // coprimality requirement - which is the assertion that keeps the share from being "rounded up" to a fifth: five
  // shares a factor with the ten that deals the colour, and that would hand the breathing to two of the three
  // temperatures only, so the amber half of the skyline could never go dark.
  const breath = module.lampBreather();
  assert.deepEqual(breath, ['==', ['%', ['to-number', ['get', 'osmId'], 0], module.LAMP_BREATHE_MODULUS], module.LAMP_BREATHE_RESIDUE],
    'the breathing slice has to be read off the block, not placed by hand');
  for (const [name, other] of [['the cross-fade groups', module.LAMP_GROUPS], ['the colour deal', LIGHT_TEMPERATURE_MODULUS],
    ['the blocks that burn nothing', module.LAMP_DARK_MODULUS], ['the density dice', LIGHT_DENSITY_MODULUS]]) {
    assert.equal(gcd(module.LAMP_BREATHE_MODULUS, other), 1, `a modulus sharing a factor with ${name} would line the breathing up with it`);
  }
  const breathShare = 1 / module.LAMP_BREATHE_MODULUS;
  // Measured, not felt: at a forty-ninth (2 %) the crossing is worth 1,460 pixels of the crop and a cluster of 90,
  // which the brief calls "灯不动"; at a seventh it is 2,250 and 290. Past a fifth the colour dice starts to bite.
  assert.ok(breathShare > 0.12 && breathShare < 0.2, `${(breathShare * 100).toFixed(1)}% of the blocks breathe as a whole: a minority, but a visible one`);
  assert.ok(module.LAMP_BREATHE_RESIDUE < module.LAMP_BREATHE_MODULUS, 'a residue outside the modulus leaves the whole city on cells');
  const breaths = [];
  for (let id = 0; id < module.LAMP_BREATHE_MODULUS * 10; id++) if (module.isLampBreather(id)) breaths.push(id);
  assert.deepEqual(breaths, [3, 10, 17, 24, 31, 38, 45, 52, 59, 66],
    `the breathing slice lands on ${breaths.join('/')}, not one residue class in seven`);
  // The two dice have to be two throws: a block that already burns nothing cannot be seen to breathe, so the overlap
  // is exactly the one id in seventy-seven the coprimality promises - not a band of them, and not zero either (zero
  // would mean the breathing slice dodges the dark one, which is a third dice nobody threw).
  const both = [];
  for (let id = 0; id < module.LAMP_BREATHE_MODULUS * module.LAMP_DARK_MODULUS; id++) {
    if (module.isLampBreather(id) && module.isLampDark(id)) both.push(id);
  }
  assert.equal(both.length, 1, `the breathing and the dark dice overlap on ${both.length} ids in ${module.LAMP_BREATHE_MODULUS * module.LAMP_DARK_MODULUS}`);
  const off = module.windowsOffTile();
  assert.deepEqual([off.width, off.height, off.data.length], [module.LIGHT_TILE.size, module.LIGHT_TILE.size, module.LIGHT_TILE.size ** 2 * 4],
    'the dark block still needs a tile of the same repeat, or the pattern would not resolve');
  assert.equal(off.data.reduce((a, b) => a + b, 0), 0, 'and it has to be nothing at all: a tinted "off" tile is a dimmer, not a dark building');
  const { size, rows, columns } = LIGHT_TILE;
  // Measured at the hero camera (zoom 15.5 / pitch 62): a wall face is ~1.6 m per screen pixel, and the accepted facade
  // pane lands at 1.6-1.8 px wide. A cell narrower than that is averaged into the wall by mipmapping.
  const cell = (size / columns) * module.FACADE_METRES_PER_PIXEL;
  assert.ok(cell > 6 && cell < 9, `a lamp cell is ${cell.toFixed(1)} m: it has to stay wider than a screen pixel`);
  // `fill-extrusion-pattern` output is multiplied by map.setLight. The night light is #c3d8fc at intensity 0.38, i.e.
  // channel factors of about [0.50, 0.58, 0.74], so a lamp that leans blue arrives on the screen as grey.
  const warmth = (colour) => colour[0] - colour[2];
  for (const [index, colour] of LIGHT_TEMPERATURES.entries()) {
    const chroma = Math.max(...colour) - Math.min(...colour);
    assert.ok(chroma >= 40, `temperature ${index} is ${colour}: a grey lamp reads as a smudge, not as light`);
  }
  const onScreen = LIGHT_TEMPERATURES.map((lit) => [lit[0] * 0.5, lit[1] * 0.58, lit[2] * 0.74]);
  assert.ok(Math.max(...onScreen.map(warmth)) > 60,
    'at least one temperature has to land warm through the night light, which is blue by construction');
  assert.ok(warmth(LIGHT_TEMPERATURES[0]) > 150 && warmth(LIGHT_TEMPERATURES[1]) > 60,
    'the two warm ends of the range have to stay warm in the tile itself');
  assert.ok(warmth(LIGHT_TEMPERATURES[2]) < -60,
    'and the cool end has to stay cool: a skyline in one amber is what made the first night frame read flat');
  const lamps = [];
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    for (let temperature = 0; temperature < LIGHT_TEMPERATURES.length; temperature++) {
      for (let ring = 0; ring < LIGHT_FADES.length; ring++) {
        const lit = [...LIGHT_TEMPERATURES[temperature], alphaOf(band, ring)];
        lamps.push({ band, temperature, ring, lit });
        assertTile(`lights-${band}-${temperature}-${ring}`, module.lightTexture(band, temperature, ring),
          { ...LIGHT_TILE, glass: [0, 0, 0, 0], lit, litCells: LIGHT_BANDS[band].cells, groundAlpha: 0 });
      }
    }
  }
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    const tiles = lamps.filter((lamp) => lamp.band === band && lamp.temperature === 0);
    assert.notDeepEqual(tiles[0].lit, tiles[1].lit, 'a ring that dims nothing is not a distance');
    assert.notDeepEqual(tiles[1].lit, tiles[2].lit, 'and the same between the last two rings');
    assert.notDeepEqual(module.lightTexture(band, 0, 0).data, module.lightTexture(band, 0, 2).data,
      'the ring has to reach the pixels, not just the constants');
  }
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    const tiles = lamps.filter((lamp) => lamp.band === band && lamp.ring === 0);
    assert.notDeepEqual(tiles[0].lit, tiles[1].lit, 'a temperature that copies another is not a temperature');
    assert.notDeepEqual(module.lightTexture(band, 0, 0).data, module.lightTexture(band, 2, 0).data,
      'the three temperatures have to reach the pixels, not just the constants');
  }
  const dense = lamps.find((lamp) => lamp.band === LIGHT_BANDS.length - 1 && lamp.temperature === 0 && lamp.ring === 0);
  const cellY = size / rows, cellX = size / columns;
  const denseTile = () => module.lightTexture(dense.band, dense.temperature, dense.ring);
  const [first] = lampCells(denseTile(), { ...LIGHT_TILE, alpha: dense.lit[3] });
  const left = (first % columns) * cellX, top = Math.floor(first / columns) * cellY;
  let paneX = 0; while (alphaAt(denseTile(), left + paneX, top) === dense.lit[3]) paneX++;
  let paneY = 0; while (alphaAt(denseTile(), left, top + paneY) === dense.lit[3]) paneY++;
  assert.ok(paneX * module.FACADE_METRES_PER_PIXEL > 4.5 && paneY * module.FACADE_METRES_PER_PIXEL > 3.5,
    `a lamp pane is ${(paneX * module.FACADE_METRES_PER_PIXEL).toFixed(1)} x ${(paneY * module.FACADE_METRES_PER_PIXEL).toFixed(1)} m, too small to read as a window`);
  // V7 asks for this pane to halve. Measured first, it cannot: on the same wall at the hero camera the finer grid
  // delivers 154 lit pixels against these 641, because a pane under ~1.6 screen pixels is averaged straight back into
  // the wall by mipmapping. So the finer pitch is a second tile family that takes over where it resolves, and what has
  // to survive the swap is everything except the size of the pane - the share of windows lit, their brightness, their
  // colours - or zooming in would also be brightening the city.
  const near = { ...LIGHT_TILE, rows: rows * 2, columns: columns * 2 };
  assert.equal(module.LIGHT_NEAR_SCALE, (near.rows * near.columns) / (rows * columns),
    'the finer grid holds four times the cells, so a band count that does not scale with it changes the lit share mid-zoom');
  const nearCell = (size / near.columns) * module.FACADE_METRES_PER_PIXEL;
  assert.ok(Math.abs(nearCell - cell / 2) < 0.01, `the near cell is ${nearCell.toFixed(2)} m against the shipped ${cell.toFixed(2)} m: the halving is the whole item`);
  assert.ok(nearCell > 3 && nearCell < 4.2, `the near cell is ${nearCell.toFixed(2)} m: V7 asks for ~3.5 m, and past 4.2 it is not a halving`);
  const nearLamps = [];
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    for (let temperature = 0; temperature < LIGHT_TEMPERATURES.length; temperature++) {
      for (let ring = 0; ring < LIGHT_FADES.length; ring++) {
        const lit = [...LIGHT_TEMPERATURES[temperature], alphaOf(band, ring)];
        nearLamps.push({ band, temperature, ring, lit });
        assertTile(`lights-near-${band}-${temperature}-${ring}`, module.lightTexture(band, temperature, ring, 0, true),
          { ...near, glass: [0, 0, 0, 0], lit, litCells: LIGHT_BANDS[band].cells * module.LIGHT_NEAR_SCALE, groundAlpha: 0 });
      }
    }
  }
  for (const lamp of nearLamps) {
    const far = lamps.find((other) => other.band === lamp.band && other.temperature === lamp.temperature && other.ring === lamp.ring);
    assert.deepEqual(lamp.lit, far.lit, `near lamp ${lamp.band}/${lamp.temperature}/${lamp.ring}: the swap may not restyle the windows`);
    const nearTile = module.lightTexture(lamp.band, lamp.temperature, lamp.ring, 0, true);
    const farTile = module.lightTexture(lamp.band, lamp.temperature, lamp.ring);
    const shareOf = (tile, grid) => lampCells(tile, { ...grid, alpha: lamp.lit[3] }).length / (grid.rows * grid.columns);
    assert.ok(Math.abs(shareOf(nearTile, near) - shareOf(farTile, LIGHT_TILE)) < 0.001,
      `band ${lamp.band}: the near grid lights ${Math.round(shareOf(nearTile, near) * 100)}% of its cells against the shipped ${Math.round(shareOf(farTile, LIGHT_TILE) * 100)}%`);
    assert.notDeepEqual(nearTile.data, farTile.data, 'a near tile that copies the shipped one is not a finer grid');
  }
  const nearDenseTile = module.lightTexture(dense.band, dense.temperature, dense.ring, 0, true);
  const nearCells = lampCells(nearDenseTile, { ...near, alpha: dense.lit[3] });
  const [nearFirst] = nearCells;
  const nearCellX = size / near.columns, nearCellY = size / near.rows;
  const nearLeft = (nearFirst % near.columns) * nearCellX, nearTop = Math.floor(nearFirst / near.columns) * nearCellY;
  let nearPaneX = 0; while (alphaAt(nearDenseTile, nearLeft + nearPaneX, nearTop) === dense.lit[3]) nearPaneX++;
  let nearPaneY = 0; while (alphaAt(nearDenseTile, nearLeft, nearTop + nearPaneY) === dense.lit[3]) nearPaneY++;
  assert.ok(nearPaneX <= paneX / 2 && nearPaneY <= paneY / 2 && nearPaneX * module.FACADE_METRES_PER_PIXEL > 2
    && nearPaneY * module.FACADE_METRES_PER_PIXEL > 1.4,
    `the near pane is ${nearPaneX} x ${nearPaneY} texels against the shipped ${paneX} x ${paneY}: it has to be about half, and still a window`);
  // The alternate pick and the halo have to cross the swap with it, or the finer grid is the one that stops breathing.
  for (let band = 0; band < LIGHT_BANDS.length; band++) {
    const shipped = module.lightTexture(band, 0, 0, 0, true), alternate = module.lightTexture(band, 0, 0, 1, true);
    assert.deepEqual(lampCells(alternate, { ...near, alpha: alphaOf(band, 0) }).length,
      lampCells(shipped, { ...near, alpha: alphaOf(band, 0) }).length, `near band ${band}: the cross-fade may not change how many windows a block keeps`);
    assert.notDeepEqual(shipped.data, alternate.data, `near band ${band}: the alternate pick has to turn windows over on the finer grid too`);
  }
  for (const { band, temperature, ring, lit } of nearLamps) {
    const halo = module.glowTexture(band, temperature, ring, true);
    assert.equal(halo.width, size, `glow-near-${band}-${temperature}-${ring}: the same repeat as its lamp`);
    const litOnes = new Set(lampCells(module.lightTexture(band, temperature, ring, 0, true), { ...near, alpha: lit[3] }));
    let peak = 0;
    for (let i = 0; i < size * size; i++) peak = Math.max(peak, halo.data[i * 4 + 3]);
    assert.ok(peak <= lit[3] * HALO_SHARE, `glow-near-${band}-${temperature}-${ring}: a halo peaks at ${peak} against its own `
      + `window at ${lit[3]}, which is ${(peak / lit[3]).toFixed(2)} of it - as bright as its own window rather than the spill under it`);
    for (let row = 0; row < near.rows; row++) for (let column = 0; column < near.columns; column++) {
      const on = alphaAt(halo, column * nearCellX + (nearCellX >> 1), row * nearCellY + (nearCellY >> 1)) > peak / 2;
      assert.equal(on, litOnes.has(row * near.columns + column),
        `glow-near-${band}-${temperature}-${ring}: cell ${row}/${column} wears a halo the lamp ${on ? 'does not' : 'does'} light`);
    }
  }
  // A renamed family leaves the layer with no pattern at exactly the zoom the finer grid was built for, and the failure
  // is silent: MapLibre draws a wall with no windows on it.
  assert.equal(`${module.LIGHT_NEAR_IMAGE_PREFIX}-0-0-0`, 'building-lights-near-0-0-0', 'the finer grid is looked up by this spelling');
  assert.equal(`${module.LAMP_NEAR_ALT_IMAGE_PREFIX}-2-2-2`, 'building-lights-near-alt-2-2-2', 'and so is its alternate pick');
  assert.equal(`${module.GLOW_NEAR_IMAGE_PREFIX}-2-2-2`, 'building-glow-near-2-2-2', 'and so is the spill under it');
  // The stop is calibrated by measurement, not by reading the expression back: MapLibre evaluates a zoom-dependent
  // data-driven paint expression at `floor(zoom) - 1`, so this number is not the zoom the swap lands at. What it has to
  // sit between is the layers' own minzoom and the hero camera, which is the frame the shipped grid was tuned to.
  assert.ok(module.LIGHT_NEAR_ZOOM >= 14 && module.LIGHT_NEAR_ZOOM < 15.5,
    `LIGHT_NEAR_ZOOM is ${module.LIGHT_NEAR_ZOOM}: at or under 14 the lamp layers have no wall to dress, at 15.5 and above it swaps the opening frame onto a grid it cannot resolve`);
  // A band is a promise about a count, so a call that asks for something the grid cannot hold has to be refused.
  assert.throws(() => module.facadeTexture({ ...LIGHT_TILE, glass: [0, 0, 0, 0], litCells: rows * columns + 1 }), /must fit the grid/);
  assert.throws(() => module.facadeTexture({ ...near, glass: [0, 0, 0, 0], litCells: near.rows * near.columns + 1 }), /must fit the grid/,
    'and the same promise on the finer grid');
  assert.throws(() => module.facadeTexture({ size, rows, columns, glass: [0, 0, 0, 0], litCells: 2 }), /needs a lit colour/);
  for (const bad of [[LIGHT_BANDS.length, 0, 0], [-1, 0, 0], [0, LIGHT_TEMPERATURES.length, 0], [0, -1, 0], [0, 0, LIGHT_FADES.length], [0, 0, -1]]) {
    assert.throws(() => module.lightTexture(...bad), /unknown light band|unknown light temperature|unknown light ring/,
      'an out-of-range tile request must be refused');
    assert.throws(() => module.lightTexture(...bad, 0, true), /unknown light band|unknown light temperature|unknown light ring/,
      'and the refusal has to cover the finer grid');
    assert.throws(() => module.glowTexture(...bad), /unknown light band|unknown light temperature|unknown light ring/);
    assert.throws(() => module.glowTexture(...bad, true), /unknown light band|unknown light temperature|unknown light ring/,
      'and the same for the finer spill');
  }
  assertGlowGeometry(module, lamps);
}

// The spill layer, graded on what it has to be in the frame: soft, dimmer than the window it belongs to, and centred on
// that window rather than on whatever cell the shuffle happened to leave empty next to it.
function assertGlowGeometry(module, lamps) {
  const { LIGHT_TILE, LIGHT_TEMPERATURES, LIGHT_FADES } = module;
  const { size, rows, columns } = LIGHT_TILE;
  const cell = size / columns;
  const alphaAtCell = (image, row, column) => alphaAt(image, column * cell + (cell >> 1), row * cell + (cell >> 1));
  const peakOf = (image) => {
    let peak = 0;
    for (let i = 0; i < size * size; i++) peak = Math.max(peak, image.data[i * 4 + 3]);
    return peak;
  };
  for (const { band, temperature, ring, lit } of lamps) {
    const name = `glow-${band}-${temperature}-${ring}`;
    const image = module.glowTexture(band, temperature, ring);
    assert.equal(image.width, size, `${name}: same repeat as the lamp above it`);
    assert.equal(image.height, size, `${name}: same repeat as the lamp above it`);
    assert.equal(image.data.length, size * size * 4, `${name}: RGBA only`);
    const alphas = [];
    let peak = 0;
    for (let i = 0; i < size * size; i++) {
      const alpha = image.data[i * 4 + 3];
      alphas.push(alpha);
      if (alpha > peak) peak = alpha;
    }
    assert.ok(peak <= lit[3] * HALO_SHARE, `${name}: a halo peaks at ${peak} against its own window at ${lit[3]}, which is `
      + `${(peak / lit[3]).toFixed(2)} of it - as bright as its own window rather than the spill under it`);
    // Spill has no colour of its own: the only thing a halo tile may decide is how much of its lamp's colour shows.
    for (let i = 0; i < size * size; i++) if (alphas[i] > 0) {
      assert.deepEqual([image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]], LIGHT_TEMPERATURES[temperature],
        `${name}: pixel ${i % size},${Math.floor(i / size)} is a different colour than the lamp it spills`);
    }
    const distinct = new Set(alphas).size;
    assert.ok(distinct > 8, `${name}: ${distinct} alpha steps is a square, not a feather`);
    assert.ok(alphas.includes(0), `${name}: the gaps between halos have to stay clear wall`);
    const litCells = new Set(lampCells(module.lightTexture(band, temperature, ring), { ...LIGHT_TILE, alpha: lit[3] }));
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const on = alphaAtCell(image, row, column) > peak / 2;
      assert.equal(on, litCells.has(row * columns + column),
        `${name}: cell ${row}/${column} has ${on ? 'a halo centred on it' : 'only reach-over'} but the lamp ${on ? 'does not' : 'does'} light it`);
    }
    // A halo that stops at its own cell is a second, blurrier window; the whole point is that it reaches past it.
    const touched = new Set();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (alphas[y * size + x] > peak / 4) touched.add(`${Math.floor(y / cell)},${Math.floor(x / cell)}`);
    }
    assert.ok(touched.size > litCells.size,
      `${name}: the spill touches ${touched.size} cells against ${litCells.size} lit windows, so it adds nothing around them`);
  }
  // A far block whose wall has receded but whose halo has not is a halo floating in front of the skyline.
  const halos = LIGHT_FADES.map((_, ring) => peakOf(module.glowTexture(module.LIGHT_BANDS.length - 1, 0, ring)));
  assert.ok(halos.every((peak, index) => index === 0 || peak < halos[index - 1]),
    `the spill has to recede with the lamps it belongs to (${halos.join('/')})`);
  assert.deepEqual(module.glowTexture(1, 2, 0).data, module.glowTexture(1, 2, 0).data, 'the halo tiles must be deterministic too');
}

test('night lamps are three height bands of three colour temperatures at three distances, readable at the hero camera', () => {
  assertLampGeometry({
    LIGHT_BANDS, LIGHT_TEMPERATURES, LIGHT_TEMPERATURE_MODULUS, LIGHT_TEMPERATURE_WEIGHTS, LIGHT_FADES, LIGHT_TILE,
    LIGHT_TIER_BELOW, LIGHT_TIER_ROWS, LIGHT_DENSITY_MODULUS, LIGHT_DENSITY_HALF, lampDensityBit, lampBandOf, lampBandExpression,
    LIGHT_IMAGE_PREFIX, GLOW_IMAGE_PREFIX, GLOW_PEAK, LAMP_GROUPS,
    LIGHT_NEAR_ZOOM, LIGHT_NEAR_SCALE, LIGHT_NEAR_IMAGE_PREFIX, LAMP_NEAR_ALT_IMAGE_PREFIX, GLOW_NEAR_IMAGE_PREFIX,
    LAMP_DARK_MODULUS, LAMP_DARK_RESIDUE, WINDOWS_OFF_IMAGE, lampDarkness, lampTemperatureDeal, lampTemperatureOf, isLampDark, windowsOffTile,
    LAMP_BREATHE_MODULUS, LAMP_BREATHE_RESIDUE, lampBreather, isLampBreather,
    FACADE_THEMES, FACADE_METRES_PER_PIXEL, facadeTexture, lightTexture, glowTexture,
  });
});

test('the six rungs are six different buildings, and a reload lights the same windows', () => {
  const cells = LIGHT_BANDS.map((band, index) => {
    const found = lampCells(lightTexture(index, 0, 0), { ...LIGHT_TILE, alpha: band.alpha });
    assert.equal(found.length, band.cells, `band ${index} has to hold exactly its own count`);
    return found;
  });
  // Two rungs may hold the same number of windows - that is what a ladder of two densities per tier looks like - but no
  // two of them may be the same *building*: the count and the brightness together are what the frame sees, and one of
  // the two has to differ at every step up the ladder.
  const signature = LIGHT_BANDS.map((band, index) => `${band.cells}/${band.alpha}/${cells[index].join(',')}`);
  assert.equal(new Set(signature).size, LIGHT_BANDS.length,
    `six rungs, ${new Set(signature).size} distinct buildings: ${signature.join(' ')}`);
  for (let index = 1; index < LIGHT_BANDS.length; index++) {
    assert.notDeepEqual(lightTexture(index, 0, 0).data, lightTexture(index - 1, 0, 0).data,
      `rung ${index} is a copy of rung ${index - 1}, so one of the two is dead weight`);
  }
  assert.deepEqual(lampCells(lightTexture(1, 0, 0), { ...LIGHT_TILE, alpha: LIGHT_BANDS[1].alpha }), cells[1],
    'the same band must pick the same cells again');
  assert.deepEqual(lightTexture(2, 1, 0).data, lightTexture(2, 1, 0).data, 'and the same pixels');
});

/**
 * The claims the two picks of a band's cells and their cross-fade have to keep. Shared by the live module below and by
 * the mutants that break each one of them, so a mutation is graded against the same words rather than a weaker copy.
 */
function assertLampContract(module) {
  const { LAMP_SET_SEEDS, LAMP_GROUPS, LAMP_PERIODS_MS, LAMP_KEYS, LAMP_ALT_IMAGE_PREFIX, LAMP_SWAP_SHARE, LAMP_TRANSITION,
    LIGHT_BANDS, LIGHT_TEMPERATURES, LIGHT_FADES, LIGHT_TILE, lampWeight, lightTexture } = module;
  assert.equal(LAMP_SET_SEEDS.length, LAMP_GROUPS, 'one seed per group of blocks');
  assert.equal(LAMP_PERIODS_MS.length, LAMP_GROUPS, 'one period per group');
  assert.equal(LAMP_KEYS.length, LAMP_GROUPS, 'one global state number per group');
  assert.equal(LAMP_ALT_IMAGE_PREFIX, 'building-lights-alt', 'a renamed second family leaves the alternate layer with no pattern');
  assert.ok(LAMP_TRANSITION > 0 && LAMP_TRANSITION < 0.5, `a transition of ${LAMP_TRANSITION} of the cycle is neither a blink nor all cross-fade`);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  assert.equal(gcd(...LAMP_PERIODS_MS.map((period) => period / 1000)), 1,
    'two periods with no common factor in seconds, or the groups realign and the whole city swaps its windows on the same beat');
  // Twenty seconds of watching has to be enough to catch a change: each group crosses twice a period, and a crossing
  // is `LAMP_TRANSITION` of the cycle long.
  const crossing = (period) => period * LAMP_TRANSITION;
  const idle = LAMP_PERIODS_MS.map((period) => period / 2 - crossing(period));
  assert.ok(Math.max(...idle) < 20000,
    `the longest gap between two crossings is ${Math.round(Math.max(...idle) / 1000)} s - a twenty second look at the night would miss it`);
  assert.ok(LAMP_PERIODS_MS.every((period) => crossing(period) >= 1500),
    'a crossing shorter than a second and a half is a blink, not a breath');

  for (const band of [0, 1, 2]) for (const temperature of [0, 1, 2]) for (const ring of [0, 1, 2]) {
    const shipped = lightTexture(band, temperature, ring);
    const alternate = lightTexture(band, temperature, ring, 1);
    const alpha = Math.round(LIGHT_BANDS[band].alpha * LIGHT_FADES[ring].dim);
    const before = new Set(lampCells(shipped, { ...LIGHT_TILE, alpha }));
    const after = new Set(lampCells(alternate, { ...LIGHT_TILE, alpha }));
    assert.deepEqual([alternate.width, alternate.height], [shipped.width, shipped.height],
      `band ${band}/${temperature}/${ring}: the alternate pick is the same tile shape`);
    assert.equal(alternate.litPanes, shipped.litPanes, 'it lights exactly as many windows, so the cross-fade cannot change how many burn');
    assert.equal(after.size, before.size, 'read off the cells themselves');
    assert.equal([...after].every((cell) => before.has(cell)), false, 'but not the same windows - a second copy of the pick is a dimmer, not a swap');
    // ... and only a share of them. Two independent deals changed every window a block has, which is the whole-facade
    // blink the cross-fade was never supposed to look like.
    const turned = [...after].filter((cell) => !before.has(cell)).length;
    assert.ok(turned >= 1, `band ${band}: the alternate pick kept every window, so the cross-fade has nothing to show`);
    assert.ok(turned <= Math.max(1, Math.round(before.size * module.LAMP_SWAP_SHARE)),
      `band ${band}: the alternate pick turned over ${turned} of ${before.size} windows, past the ${module.LAMP_SWAP_SHARE} the contract allows`);
    assert.equal([...before].filter((cell) => after.has(cell)).length, before.size - turned,
      'and the windows that stay are the same windows, not a reshuffle that happens to land the same count');
    assert.notDeepEqual(alternate.data, shipped.data, 'and that difference has to reach the pixels');
  }
  assert.deepEqual(lightTexture(1, 2, 0, 0).data, lightTexture(1, 2, 0).data, 'the default argument is the pick this scene shipped with');
  assert.deepEqual(lightTexture(2, 0, 1, 1).data, lightTexture(2, 0, 1, 1).data, 'and the alternate pick is deterministic too');
  assert.throws(() => lightTexture(0, 0, 0, 5), /unknown lamp set/, 'a pick that does not exist cannot be asked for');

  const samples = Array.from({ length: 1001 }, (_, i) => lampWeight(i / 1000));
  assert.ok(samples.every((value) => value >= 0 && value <= 1), 'a weight is a share of one layer, never more');
  assert.equal(lampWeight(0), 1, 'cycle 0 is the frame this scene shipped with');
  assert.equal(lampWeight(1), 1, 'and the wrap point is the same frame, so a clock can run forever');
  assert.equal(lampWeight(0.5), 0, 'the far end of the cycle is the alternate pick at full strength');
  const settled = samples.filter((value) => value === 0 || value === 1).length / samples.length;
  assert.ok(settled > 0.55, `only ${Math.round(settled * 100)}% of the cycle is a settled frame; the rest is cross-fading`);
  const down = samples.slice(0, 501);
  assert.equal(down.every((value, index) => index === 0 || value <= down[index - 1]), true, 'the first half only walks one way');
  const up = samples.slice(500);
  assert.equal(up.every((value, index) => index === 0 || value >= up[index - 1]), true, 'and the second half walks back');
  assert.throws(() => lampWeight(1.2), /lamp cycle/, 'a cycle outside 0..1 is a bug in the clock, not a value to clamp');
}

test('the night windows have two picks, and a cross-fade that starts and ends on the shipped one', () => {
  assertLampContract({ LAMP_SET_SEEDS, LAMP_GROUPS, LAMP_PERIODS_MS, LAMP_KEYS, LAMP_ALT_IMAGE_PREFIX, LAMP_SWAP_SHARE, LAMP_TRANSITION,
    LIGHT_BANDS, LIGHT_TEMPERATURES, LIGHT_FADES, LIGHT_TILE, lampWeight, lightTexture });
});

test('the cross-fade contract kills pick/share/period/clamp/wrap mutants', async t => {
  const mutants = [
    ['the alternate pick is the shipped pick', 'litSet: swapCells(total, cells, LAMP_SET_SEEDS[0], seed)', 'litSet: pickCells(total, cells, LAMP_SET_SEEDS[0])', /not the same windows/],
    ['the alternate pick re-deals the facade', 'Math.round(shipped.length * share)', 'shipped.length', /past the/],
    ['the two groups share a period', 'export const LAMP_PERIODS_MS = [11000, 17000];', 'export const LAMP_PERIODS_MS = [11000, 22000];', /no common factor/],
    ['the cross-fade opens mid-swap', 'const raw = 0.5 + 0.5 * Math.cos(cycle * Math.PI * 2);', 'const raw = 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2);', /cycle 0 is the frame/],
    ['the cycle wraps onto a different frame', 'const raw = 0.5 + 0.5 * Math.cos(cycle * Math.PI * 2);', 'const raw = 0.5 + 0.5 * Math.cos((cycle + 0.25) * Math.PI * 2);', /cycle 0 is the frame/],
    ['the weight can leave the layer', 'return Math.round(Math.min(1, Math.max(0, shaped)) * 1000) / 1000;', 'return Math.round(shaped * 1000) / 1000;', /never more/],
    ['the weight can go below the layer', 'return Math.round(Math.min(1, Math.max(0, shaped)) * 1000) / 1000;', 'return Math.round(Math.min(1, shaped) * 1000) / 1000;', /never more/],
    ['the cross-fade never settles', 'export const LAMP_TRANSITION = 0.26;', 'export const LAMP_TRANSITION = 2;', /is neither a blink nor all cross-fade/],
    ['a pick outside the two', 'if (!seed) throw new Error(`unknown lamp set: ${set}`);', '', /cannot be asked for/],
  ];
  for (const [name, from, to, expected] of mutants) await t.test(name, async () => {
    const mutant = await mutatedFacade(from, to);
    assert.throws(() => assertLampContract(mutant), expected, `${name} has to be rejected by the cross-fade contract`);
    assert.doesNotThrow(() => assertFacadeContract({ ...mutant }), 'the mutant must still dress the wall grid');
  });
});

test('facade assertions kill guard/bleed/opacity/randomness/lit-count/metre/rhythm/mapping mutants', async t => {

  const combos = Object.keys(FACADE_THEMES).flatMap((atmosphere) => Object.keys(FACADE_SHAPES).map((shape) => [atmosphere, shape]));
  const correct = Object.fromEntries(combos.map(([a, s]) => [`${a}/${s}`, facadeTexture(facadeOptions(a, s))]));
  // 'rejected' is the atmosphere whose tiles must fail assertTile, 'all' is every tile, null is a mutant that leaves the
  // pixels legal, and a RegExp means the tiles stay legal but a claim about rhythms, mapping or the expression breaks -
  // in which case the RegExp is the exact wording of the assertion the mutant has to trip.
  const specs = [
    ['divisibility guard', 'if (size % rows || size % columns)', 'if (false)', null],
    ['pane bleeds to the wrap edge', 'Math.round(cellX * paneXShare)', 'Math.ceil(cellX)', 'all'],
    ['opaque glass hides the wall', 'glass: [16, 26, 34, 168]', 'glass: [16, 26, 34, 255]', 'day'],
    ['the day grid goes back to a whisper', 'glass: [16, 26, 34, 168]', 'glass: [16, 26, 34, 54]', /faintest of the three/],
    ['seeded randomness', 'state = (state + 0x6d2b79f5) >>> 0;', 'state = (state + 0x6d2b79f5 + (Math.random() * 4 | 0)) >>> 0;', null],
    ['every window lit', 'litShare: 0.16', 'litShare: 1', 'night'],
    ['a night rhythm that lights nothing', '{ litCells: litCellsFor(shape.rows * shape.columns, theme.litShare) }', '{ litCells: 0 }', 'night'],
    ['lit colour is not light', 'lit: [255, 214, 158, 110]', 'lit: [8, 14, 24, 110]', 'night'],
    ['reported lit count', 'if (value === lit) litPanes++;', '', 'night'],
    ['metres per pixel', 'export const FACADE_METRES_PER_PIXEL = 29.3 / 32;', 'export const FACADE_METRES_PER_PIXEL = 3.2 / 32;', null],
    ['two rhythms that are one rhythm', 'dense: { rows: 4, columns: 8, paneYShare: 0.62, paneXShare: 0.7 },',
      'dense: { rows: 4, columns: 4, paneYShare: 0.75, paneXShare: 0.5 },', /are the same rhythm/],
    ['a category wears another category rhythm', "public: 'civic'", "public: 'dense'", /two categories on one rhythm/],
    ['a category is missing from the mapping', "residential: 'dense', ", '', /must cover exactly the categories/],
    ['the fallback names a rhythm that does not exist', "export const FACADE_FALLBACK_SHAPE = 'plain';",
      "export const FACADE_FALLBACK_SHAPE = 'tower';", /fallback has to be a rhythm/],
    ['a rhythm finer than the measured floor', 'civic: { rows: 2,', 'civic: { rows: 8,', /outside 5-15 m/],
    ['the expression stops reading the block', "const rhythm = ['match', ['get', 'category'],",
      "const rhythm = ['match', ['get', 'heightSource'],", /reads the block's own category/],
    ['the grid stops following the hour', '[category, facadeImage(atmosphereId, shape)]',
      "[category, facadeImage('day', shape)]", /never hung on the layer/],
  ];
  for (const [name, from, to, rejected] of specs) await t.test(name, async () => {
    const mutant = await mutatedFacade(from, to);
    if (name === 'divisibility guard') {
      const uneven = { size: 32, rows: 5, columns: 8, glass: [1, 1, 1, 40] };
      assert.doesNotThrow(() => mutant.facadeTexture(uneven), 'the mutant must accept an uneven tile');
      assert.throws(() => assertTile('uneven', mutant.facadeTexture(uneven), uneven), /divide the edge evenly/,
        'and the positive check must reject what the guard let through');
    } else if (name === 'seeded randomness') {
      const night = mutant.facadeOptions('night', 'dense');
      assert.notDeepEqual(mutant.facadeTexture(night).data, mutant.facadeTexture(night).data, 'the mutant must wobble');
    } else if (name === 'metres per pixel') {
      const { size, rows } = mutant.facadeOptions('day', 'dense');
      const band = (size / rows) * mutant.FACADE_METRES_PER_PIXEL;
      assert.ok(band < 5, `the mutant must actually shrink the band to ${band.toFixed(1)} m`);
    } else if (rejected instanceof RegExp) {
      assert.throws(() => assertFacadeContract(mutant), rejected, `${name} must be rejected by the grid contract`);
    } else {
      for (const [atmosphere, shape] of combos) {
        const options = mutant.facadeOptions(atmosphere, shape);
        const image = mutant.facadeTexture(options);
        if (rejected === 'all' || rejected === atmosphere) {
          assert.throws(() => assertTile(`${atmosphere}/${shape}`, image, options),
            /wrapping|majority of the tile|translucent overlay|lit count|read as light|not a flood|some windows are lit|carries a different pane|exactly one alpha per material|exactly the glass colour|declared cell count/,
            `${atmosphere}/${shape} must be rejected under the ${name} mutant`);
        } else assert.doesNotThrow(() => assertTile(`${atmosphere}/${shape}`, image, options),
          `${atmosphere}/${shape} is outside the ${name} mutant`);
      }
    }
    assert.deepEqual(Object.fromEntries(combos.map(([a, s]) => [`${a}/${s}`, facadeTexture(facadeOptions(a, s))])), correct,
      'the module under test must still produce the pinned images');
  });
});


test('lamp and halo assertions kill band/colour/ring/feather/cell-size mutants', async t => {
  const specs = [
    ['an exact cell count silently ignored', 'const chosen = litSet !== null ? litSet : (litCells === null ? null : pickCells(rows * columns, litCells, seed));', 'const chosen = null;'],
    ['the band index is dropped', 'lit: [...colour, lampAlpha(band, ring)], litCells: cells', 'lit: [...colour, lampAlpha(band, ring)], litCells: LIGHT_BANDS[0].cells'],
    ['the temperature index is dropped', 'lit: [...colour, lampAlpha(band, ring)], litCells: cells', 'lit: [...LIGHT_TEMPERATURES[0], lampAlpha(band, ring)], litCells: cells'],
    ['the distance ring is dropped', 'lit: [...colour, lampAlpha(band, ring)], litCells: cells', 'lit: [...colour, lightBand(band).alpha], litCells: cells'],
    ['one cell too many per band', 'return new Set(order.slice(0, k));', 'return new Set(order.slice(0, k + 1));'],
    ['a count the grid cannot hold', 'if (litCells !== null && (!lit || litCells < 0 || litCells > rows * columns)) {', 'if (false) {'],
    ['a band that comes out dark', '{ below: 24, cells: 2, alpha: 224 }', '{ below: 24, cells: 0, alpha: 208 }'],
    ['a band that is no brighter than the one below it', '{ below: 100, cells: 3, alpha: 238 }', '{ below: 100, cells: 3, alpha: 208 }'],
    ['two bands that step on top of each other', '{ below: 100, cells: 3, alpha: 238 }', '{ below: 24, cells: 3, alpha: 226 }'],
    ['the tallest band is cut off instead of open', '{ below: Infinity, cells: 5, alpha: 252 }', '{ below: 200, cells: 5, alpha: 244 }'],
    ['a ring that dims nothing', '{ below: 2400, dim: 0.55 }', '{ below: 2400, dim: 1 }'],
    ['a ring that goes out entirely', '{ below: Infinity, dim: 0.28 }', '{ below: Infinity, dim: 0 }'],
    ['two rings that step on top of each other', '{ below: 2400, dim: 0.55 }', '{ below: 1500, dim: 0.55 }'],
    ['the farthest ring is cut off instead of open', '{ below: Infinity, dim: 0.28 }', '{ below: 3000, dim: 0.28 }'],
    ['the halo ignores the ring it belongs to', 'data[offset + 3] = Math.round(peak * GLOW_PEAK * dim);', 'data[offset + 3] = Math.round(peak * GLOW_PEAK);'],
    ['a cell too small to read', 'export const LIGHT_TILE = { size: 32, rows: 4, columns: 4 };', 'export const LIGHT_TILE = { size: 32, rows: 8, columns: 8 };'],
    ['a lamp that lands grey', '[255, 204, 128]', '[212, 212, 212]'],
    ['the colour spread collapses to one amber', '[140, 214, 255]', '[255, 172, 62]'],
    ['the halo is as bright as its window', 'export const GLOW_PEAK = 150;', 'export const GLOW_PEAK = 250;'],
    ['the halo is a hard disc, not a feather', 'peak = Math.max(peak, (1 - distance / radius) ** 2)', 'peak = 1'],
    ['the halo drifts off its own window', 'const chosen = [...pickCells(rows * columns, row.cells * (near ? LIGHT_NEAR_SCALE : 1), 0x51f3)];', 'const chosen = [...pickCells(rows * columns, row.cells, 0x2b71)];'],
    ['the halo stops at its own cell', 'export const GLOW_REACH = 1.35;', 'export const GLOW_REACH = 0.8;'],
    ['the breathing dice shares a factor with the colour deal', 'export const LAMP_BREATHE_MODULUS = 7;', 'export const LAMP_BREATHE_MODULUS = 5;'],
    ['the breathing dice is dealt one residue off', 'export const LAMP_BREATHE_RESIDUE = 3;', 'export const LAMP_BREATHE_RESIDUE = 4;'],
    ['the breathing dice is switched off entirely', 'return [\'==\', [\'%\', [\'to-number\', [\'get\', \'osmId\'], 0], LAMP_BREATHE_MODULUS], LAMP_BREATHE_RESIDUE];', 'return false;'],
    ['unlit lamps tint the wall twice', 'glass: [0, 0, 0, 0]', 'glass: [0, 0, 0, 60]'],
  ];
  for (const [name, from, to] of specs) await t.test(name, async () => {
    const mutant = await mutatedFacade(from, to);
    assert.throws(() => assertLampGeometry(mutant),
      /how many bands exist|densities|answer to the same height|the threshold the row carries|fewer windows than a short|height tiers of|brighter as well as busier|thresholds out of order|open at the top|three colour temperatures|distance rings|ring has to be dimmer|reference the other|of the light|brighter than the wall behind it|renamed image|lamp cell|grey lamp|land warm|two warm ends|cool end|not a distance|last two rings|reach the pixels|copy another|lit count|some windows are lit|declared cell count|majority of the tile|only clear ground|exactly the glass colour|read as light|must fit the grid|needs a lit colour|unknown light band|unknown light temperature|unknown light ring|as bright as its own window|the ladder spans|distinct shares|is a copy of rung|alpha steps|clear wall|halo centred on it|only reach-over|wears a halo the lamp|adds nothing around|recede with the lamps|deterministic too|breathing|lands on|sharing a factor|Missing expected exception/,
      `${name} must be rejected by the lamp contract`);
    // The mutant has to be a lamp defect and nothing else: the accepted wall grids must still pass their own checks. The
    // day and sunset grids are the honest control here - a lamp mutant that also broke the *night* lit count would be two
    // defects at once, and the grid injections above own that claim.
    for (const atmosphere of ['day', 'sunset']) for (const shape of Object.keys(mutant.FACADE_SHAPES)) {
      const options = mutant.facadeOptions(atmosphere, shape);
      assert.doesNotThrow(() => assertTile(`${atmosphere}/${shape}`, mutant.facadeTexture(options), options),
        `${atmosphere}/${shape} is outside the ${name} mutant`);
    }

  });
});

// Procedural facade texture for the extruded volumes.
//
// MapLibre tiles `fill-extrusion-pattern` on extruded sides by world distance, not by screen pixels: a 32 px image
// measures 29.3 m along a wall in the real renderer (probed against a 600 m needle), so one image pixel is ~0.92 m.
// That fixes the scale of everything below: a row of 8 px is a storey band of ~7.4 m, which is about two floors, and it
// is the finest pitch that does not turn into shimmer at the scene's 15.5 hero zoom. Every category rhythm in
// FACADE_SHAPES is built on that floor - a band is 8 px or 16 px, never 4 px - and the rhythms differ in the bays and
// in how much of each band the glass fills.
//
// The texture is only ever drawn through a translucent overlay layer, so the wall shows through wherever the image is
// transparent: the pattern shader ignores `fill-extrusion-color` entirely, and the category colours and the distance
// fade stay on the layer underneath.
//
// One image per atmosphere *per category rhythm. The rhythm is read from the block's own `category`, so an office tower,
// a housing tower and a civic hall are not dressed with the same grid, and nothing about the mapping is hand-placed:
// four categories in the snapshot, four shapes, one fallback.
export const FACADE_IMAGE_PREFIX = 'building-facade';
// Measured, not assumed: 32 image pixels span 29.3 m of wall height in the rendered scene.
export const FACADE_METRES_PER_PIXEL = 29.3 / 32;
export const FACADE_TILE_SIZE = 32;


// Deterministic, so a test can pin which windows are lit and a reload cannot reshuffle the skyline.
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Exactly k of the rows*columns cells, chosen by a seeded shuffle. A probabilistic share cannot be trusted here: an
// 11 % draw over a 3x3 grid came back with zero lit cells, and a tier with no windows is an invisible tier.
function pickCells(count, k, seed) {
  const order = [...Array(count).keys()];
  const next = seededRandom(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return new Set(order.slice(0, k));
}

/**
 * Build one seamless facade tile.
 *
 * @param {object} options
 * @param {number} options.size edge of the image in pixels; must divide by rows and columns so the tile is seamless.
 * @param {number} options.rows storey bands per repeat.
 * @param {number} options.columns window bays per repeat.
 * @param {number} [options.paneYShare] part of a band the glass fills; the rest is the clear storey gap.
 * @param {number} [options.paneXShare] part of a bay the glass fills; the rest is the mullion.
 * @param {number[]} options.glass rgba of an unlit window, drawn over the wall colour underneath.
 * @param {number[]} [options.lit] rgba of a lit window; omit for a theme without night lighting.
 * @param {number} [options.litShare] share of windows that get `lit`, in 0..1.
 * @param {number} [options.litCells] exact number of windows that get `lit`; overrides `litShare`.
 * @param {Set<number>} [options.litSet] the cells to light, given rather than dealt; overrides `litCells`.
 * @param {number} [options.seed] picks which windows are lit.
 * @returns {{width: number, height: number, data: Uint8Array}} an image MapLibre's addImage accepts.
 */
export function facadeTexture({ size = FACADE_TILE_SIZE, rows = 4, columns = 8, glass = [12, 22, 30, 58], lit = null, litShare = 0, litCells = null, litSet = null, paneYShare = 0.62, paneXShare = 0.7, seed = 0x51f3 }) {
  if (size % rows || size % columns) throw new Error(`facade tile must divide evenly: ${size} by ${rows}/${columns}`);
  if (litSet !== null && (lit === null || litSet.size > rows * columns)) {
    throw new Error(`an explicit cell set needs a lit colour and must fit the grid: ${litSet.size} of ${rows * columns}`);
  }
  if (litCells !== null && (!lit || litCells < 0 || litCells > rows * columns)) {
    throw new Error(`a lit cell count needs a lit colour and must fit the grid: ${litCells} of ${rows * columns}`);
  }
  const cellY = size / rows, cellX = size / columns;
  // A band of glass with a clear-storey gap above it, and a bay of glass with a mullion beside it. The two shares are
  // what a category rhythm is made of: same tile, different shares, different building.
  const paneY = Math.max(1, Math.round(cellY * paneYShare)), paneX = Math.max(1, Math.round(cellX * paneXShare));

  const data = new Uint8Array(size * size * 4);
  const next = seededRandom(seed);
  const chosen = litSet !== null ? litSet : (litCells === null ? null : pickCells(rows * columns, litCells, seed));
  let litPanes = 0;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const roll = next();
    const value = lit && (chosen ? chosen.has(row * columns + column) : roll < litShare) ? lit : glass;
    if (value === lit) litPanes++;
    const top = Math.round(row * cellY), left = Math.round(column * cellX);
    for (let y = top; y < Math.min(top + paneY, size); y++) {
      const offset = (y * size + left) * 4;
      for (let x = 0; x < Math.min(paneX, size - left); x++) {
        data[offset + x * 4] = value[0];
        data[offset + x * 4 + 1] = value[1];
        data[offset + x * 4 + 2] = value[2];
        data[offset + x * 4 + 3] = value[3];
      }
    }
  }
  return { width: size, height: size, data, litPanes };
}

// Palette per atmosphere. Geometry lives in FACADE_SHAPES, so switching the hour restyles every category at once and
// adding a rhythm never has to touch a colour table. Day and sunset only darken the wall; night lights a share of the
// panes, which is what makes the evening frame read as a city rather than as a colour chart.
//
// The day alpha is the product of two numbers, and only one of them lives here: the overlay layer's own
// `fill-extrusion-opacity` ramp is 0.42 at zoom 15 and 0.6 at 16.5, so a pane at 54/255 reached the screen as
// 0.456 × 0.212 = 9.7 % of the glass colour, which is a 8 % luminance drop on a brick wall - the "faint to the point of
// absent" the brief names. 168 puts the same grid at 25 % on the hero camera and 30 % at zoom 16, which is the band the
// reference sits in: readable, and quiet enough that the mullion still reads as the wall rather than as a stripe.
export const FACADE_THEMES = {
  day: { glass: [16, 26, 34, 168] },
  sunset: { glass: [46, 24, 30, 66] },
  // V7's "透明度从 150 降到 ~110": these are the grid's own windows, and at 150 they competed with the lamp overlay for
  // the same cells, which is what made a night wall read as a sheet of pale squares rather than as a dark mass with
  // lights in it.
  night: { glass: [8, 14, 24, 40], lit: [255, 214, 158, 110], litShare: 0.16 },
};
// One rhythm per building category, and the reason they differ is what the screen can still resolve. At the hero camera
// (zoom 15.5 / pitch 62) a wall face is ~1.6 m per screen pixel while a tile pixel is 0.92 m, so a cell finer than ~7 m
// is averaged straight back into the wall. Every shape therefore sits on a 7.3 m or a 14.7 m grid, and the four are
// separated along the two axes that survive that floor: the band period, and the shape and coverage of the pane.
//   curtain      offices - tall glass, wide mullion bays
//   dense        housing - the finest grid the floor allows, so it reads as many small windows
//   civic        public hall - double-height bands with large openings
//   plain        unclassified - banded glazing, the least busy of the four, and the fallback
export const FACADE_SHAPES = {
  curtain: { rows: 4, columns: 4, paneYShare: 0.75, paneXShare: 0.5 },
  dense: { rows: 4, columns: 8, paneYShare: 0.62, paneXShare: 0.7 },
  civic: { rows: 2, columns: 4, paneYShare: 0.5, paneXShare: 0.75 },
  plain: { rows: 4, columns: 4, paneYShare: 0.5, paneXShare: 0.62 },
};
// Read from the block's own `category`, which the snapshot derives from its OSM tags: no hand-placed building, and a
// block cannot be dressed as one use and painted as another. `plain` is also the fallback, so a category that is not in
// this table still resolves to a tile that exists.
export const FACADE_CATEGORY_SHAPES = { commercial: 'curtain', residential: 'dense', public: 'civic', unknown: 'plain' };
export const FACADE_FALLBACK_SHAPE = 'plain';

export const facadeImage = (atmosphereId, shapeId) => `${FACADE_IMAGE_PREFIX}-${atmosphereId}-${shapeId}`;

// A night theme is a count, not a probability: a 16 % share over an 8-cell grid can come out with nothing alight, and a
// shape with no lit window is an invisible shape.
function litCellsFor(count, share) {
  return Math.max(1, Math.round(count * share));
}

/**
 * The full option set of one (atmosphere, category rhythm) tile.
 *
 * @param {string} atmosphereId a key of FACADE_THEMES.
 * @param {string} shapeId a key of FACADE_SHAPES.
 */
export function facadeOptions(atmosphereId, shapeId) {
  const theme = FACADE_THEMES[atmosphereId];
  if (!theme) throw new Error(`unknown atmosphere: ${atmosphereId}`);
  const shape = FACADE_SHAPES[shapeId];
  if (!shape) throw new Error(`unknown facade shape: ${shapeId}`);
  return { size: FACADE_TILE_SIZE, ...theme, ...shape,
    ...(theme.lit ? { litCells: litCellsFor(shape.rows * shape.columns, theme.litShare) } : {}) };
}

/**
 * The paint expression that hangs one grid per category: `fill-extrusion-pattern` is data-driven, so the block's own
 * `category` picks the tile while the layer stays a single draw call.
 *
 * @param {string} atmosphereId a key of FACADE_THEMES.
 */
export function facadePattern(atmosphereId) {
  if (!FACADE_THEMES[atmosphereId]) throw new Error(`unknown atmosphere: ${atmosphereId}`);
  const rhythm = ['match', ['get', 'category'],
    ...Object.entries(FACADE_CATEGORY_SHAPES).flatMap(([category, shape]) => [category, facadeImage(atmosphereId, shape)]),
    facadeImage(atmosphereId, FACADE_FALLBACK_SHAPE)];
  // Only the night grid has windows of its own to switch off. A block the id dice has left dark cannot keep burning the
  // 16 % of panes this tile paints for every building, or "全暗" is a lamp-layer rule and not a building.
  return FACADE_THEMES[atmosphereId].lit
    ? ['case', lampDarkness(), WINDOWS_OFF_IMAGE, rhythm]
    : rhythm;
}

// Which blocks burn nothing: one residue class of the block's own OSM id. The modulus is prime and coprime with the
// ten that deals out the colour temperature and the two that deal out the cross-fade groups, so switching buildings
// off cannot thin either of those distributions - 1/11 of them is 9.1%, the ~10% the brief asks for.
export function lampDarkness() {
  return ['==', ['%', ['to-number', ['get', 'osmId'], 0], LAMP_DARK_MODULUS], LAMP_DARK_RESIDUE];
}
export function isLampDark(osmId) {
  return Math.abs(osmId) % LAMP_DARK_MODULUS === LAMP_DARK_RESIDUE;
}


// Night window lights, on their own overlay so a lamp can be bright without the wall grid turning opaque.
//
// Measured at the hero camera (zoom 15.5 / pitch 62): a wall face is ~1.6 m per screen pixel, so the facade pane above
// lands at 1.6-1.8 x 2.7-3.0 pixels and mipmapping averaged it back into the wall. This tile uses a 4x4 grid, which is
// 7.3 m per cell and a 5.5 x 4.6 m pane, i.e. ~3.3 x 2.9 pixels: the finest pitch that still reads as a window and not
// as a shimmer, and it is the reason the layer is separate rather than a fourth colour in the facade grid.
//
// The lit colours carry almost no blue on their warm end on purpose. `fill-extrusion-pattern` output is multiplied by
// `map.setLight`, and the night light (#c3d8fc at intensity 0.38) scales channels by roughly [0.50, 0.58, 0.74]: a
// warm-white lamp tile reaches the screen as neutral grey. Pushing red up and blue down is what makes amber read as light.
export const LIGHT_IMAGE_PREFIX = 'building-lights';
// The halo family is the same grid of cells drawn as feathered blobs instead of hard squares, and it is the layer
// *under* the lamps: a window keeps its edge while the wall around it picks up spill.
export const GLOW_IMAGE_PREFIX = 'building-glow';
// How bright the middle of a halo is. It stays well under a lamp because spill that reaches a lamp's alpha stops being
// spill and turns into a second, blurrier set of windows.
export const GLOW_PEAK = 150;
// How far a halo reaches, in cells of its own grid. Below ~1.2 the feather is gone at the hero camera (one texel is
// ~0.58 screen pixels there, so the mipmap averages a thin ring straight back into the wall); much past 1.5 and the
// halos of neighbouring windows merge into haze over the whole skyline.
export const GLOW_REACH = 1.35;
// Six densities, in three height tiers of two. The tier is the block's own displayed height - a 60 m slab and a 200 m
// tower do not light the same number of windows, and an even sprinkle across 3,990 blocks was what made the first
// night frame read flat - and the second row of each tier is dealt by the block's own OSM id, which is the half of V7's
// complaint the height ladder could not answer: with one count per tier, every building of a given height wore the same
// board. The `below` thresholds are compared against the same `coalesce` expression the extrusion height uses, so the
// band a block wears can never disagree with the height it is drawn at, and alpha climbs with the tier, so the tall ones
// are also the brightest rather than merely the busiest.
//
// The counts are the ceiling V7 names: five windows on this 4x4 grid is 31% of it lit, and the asked-for 8% floor is
// two. A finer ladder is possible but it is not free - the whole family doubles again per rung.
export const LIGHT_BANDS = [
  { below: 24, cells: 2, alpha: 224 },
  { below: 24, cells: 3, alpha: 224 },
  { below: 100, cells: 3, alpha: 238 },
  { below: 100, cells: 4, alpha: 238 },
  { below: Infinity, cells: 4, alpha: 252 },
  { below: Infinity, cells: 5, alpha: 252 },
];
// Which of the two rows of a tier a block wears, and the number of tiers: the band index the layer hangs its tiles by is
// `tier * LIGHT_TIER_ROWS + the dice`, so a block's height and its own id together decide the ladder rung it sits on.
//
// The dice is a residue of thirteen, not of two: modulo two *is* the cross-fade group (`osmId % LAMP_GROUPS`), and
// dealing density from the same residue would make the city's denser half breathe on one beat and its sparser half on
// the other. Thirteen is coprime with that two, with the ten that deals the colour temperature and with the eleven that
// switches buildings off, so the three dices stay three independent throws.
export const LIGHT_TIER_ROWS = 2;
export const LIGHT_DENSITY_MODULUS = 13;
export const LIGHT_DENSITY_HALF = 7;
// The heights the tiers break on, spelled out here rather than derived from LIGHT_BANDS so a row that loses its twin is
// a test failure rather than a silent collapse of two bands into one image.
export const LIGHT_TIER_BELOW = [24, 100, Infinity];
export function lampDensityBit(osmId) {
  return Math.abs(osmId) % LIGHT_DENSITY_MODULUS < LIGHT_DENSITY_HALF ? 1 : 0;
}
export function lampTierOf(height) {
  const tier = LIGHT_TIER_BELOW.findIndex((below) => height < below);
  return tier < 0 ? LIGHT_TIER_BELOW.length - 1 : tier;
}
// The band a block wears, as the rule and as the expression - one definition each, so the tile the unit test builds and
// the tile the layer asks for cannot drift apart.
export function lampBandOf(height, osmId) {
  return lampTierOf(height) * LIGHT_TIER_ROWS + lampDensityBit(osmId);
}
export function lampBandExpression(wallHeight) {
  const tier = ['step', wallHeight, 0, ...LIGHT_TIER_BELOW.slice(0, -1).flatMap((below, index) => [below, index + 1])];
  return ['+', ['*', tier, LIGHT_TIER_ROWS],
    ['case', ['<', ['%', ['to-number', ['get', 'osmId'], 0], LIGHT_DENSITY_MODULUS], LIGHT_DENSITY_HALF], 1, 0]];
}
// Three colour temperatures: sodium amber, warm white and the cool white of a lit office slab. Which one a block burns
// is read from its own OSM id, so the skyline is stable across reloads and no lamp is hand-placed.
//
// V7 asks for 80% warm and 20% cool, and `osmId % 3` was 33/33/33 - a third of the city burning blue-white, which is
// the "全白" of the complaint. The buckets stay the same three colours; only their share moves: the id is taken modulo
// ten and stepped, four to amber, four to warm white, two to cool.
export const LIGHT_TEMPERATURES = [
  [255, 148, 20],
  [255, 204, 128],
  [140, 214, 255],
];
export const LIGHT_TEMPERATURE_MODULUS = 10;
export const LIGHT_TEMPERATURE_WEIGHTS = [4, 4, 2];
// The deal, in one place: the first `weights[0]` residues of the id burn colour 0, the next `weights[1]` colour 1, the
// rest colour 2. `lampTemperatureDeal` is the expression the layer hangs, `lampTemperatureOf` is the same rule a unit
// test can run over the residues - written as one loop each, because a stop list built by hand is exactly where an
// off-by-one went: an early version put the boundaries at 8 and 10, which handed out no cool white at all and only
// showed up when the browser read the expression back.
export function lampTemperatureStops() {
  const stops = [];
  let below = 0;
  for (let index = 0; index < LIGHT_TEMPERATURE_WEIGHTS.length - 1; index++) {
    below += LIGHT_TEMPERATURE_WEIGHTS[index];
    stops.push(below, index + 1);
  }
  return stops;
}
export function lampTemperatureDeal() {
  return ['step', ['%', ['to-number', ['get', 'osmId'], 0], LIGHT_TEMPERATURE_MODULUS], 0, ...lampTemperatureStops()];
}
export function lampTemperatureOf(osmId) {
  const residue = Math.abs(osmId) % LIGHT_TEMPERATURE_MODULUS;
  let below = 0;
  for (let index = 0; index < LIGHT_TEMPERATURE_WEIGHTS.length; index++) {
    below += LIGHT_TEMPERATURE_WEIGHTS[index];
    if (residue < below) return index;
  }
  return LIGHT_TEMPERATURE_WEIGHTS.length - 1;
}
// The blocks that burn no windows at all. A city where every building is lit is the other half of the "白色大棋盘"
// read, so a slice of blocks is switched off by its own id: one residue class of a prime modulus, coprime with the
// ten that deals out the colour temperature and with the two that deal out the cross-fade groups, so switching
// buildings off cannot thin any of the other distributions. 1/11 of the blocks is 9.1%, which is the ~10% asked for.
export const LAMP_DARK_MODULUS = 11;
export const LAMP_DARK_RESIDUE = 7;
// One transparent tile, shared by both window layers and both grids: the block that wears it shows the wall and the
// category colour underneath and nothing else.
export const WINDOWS_OFF_IMAGE = 'building-windows-off';
export function windowsOffTile(size = LIGHT_TILE.size) {
  return { width: size, height: size, data: new Uint8Array(size * size * 4) };
}
// Three distance rings, indexed by the block's own `distance` from the scene centre, and the reason they are tiles
// rather than an opacity expression: `fill-extrusion-opacity` is not data-driven in MapLibre, so a layer whose opacity
// reads `['get', 'distance']` is rejected by the style validator and never reaches the map at all. Baking the recession
// into the pane alpha does the same job one level earlier - 1,441 of the 1,816 blocks on screen at the hero camera are
// past 1.5 km, and an undimmed lamp on a wall the base layer has already faded to near-black is what made the first
// night frame read as an even sprinkle instead of a skyline with depth.
export const LIGHT_FADES = [
  { below: 1500, dim: 1 },
  { below: 2400, dim: 0.55 },
  { below: Infinity, dim: 0.28 },
];
export const LIGHT_TILE = { size: 32, rows: 4, columns: 4 };
// V7 asks for the window to halve (7.3 m -> ~3.7 m, rows and columns doubled). At the hero camera that is below the
// resolution floor this scene measured - a wall face is ~1.6 m per screen pixel at 15.5/62, so an 8x8 pane lands at
// ~1.6 x 1.4 px and mipmapping averages its edge straight back into the wall. So the finer grid is a second family
// that takes over where it resolves, and the shipped one stays under it.
// The stop below is not the zoom the swap happens at: MapLibre evaluates a zoom-dependent *data-driven* paint
// expression at the pattern cross-fade level, `floor(zoom) - 1`, and re-tessellates only when that integer changes.
// Measured with a stop of 16.5 the finer family first reached the screen at zoom 18; with 15.0 it reaches it at 16.0,
// which is the zoom where an 8x8 pane covers the same ~3.4 x 2.9 screen pixels the 4x4 pane covers at the hero camera -
// so the swap fires where the finer rhythm first becomes readable and the opening frame is untouched.
export const LIGHT_NEAR_ZOOM = 15.0;
export const LIGHT_NEAR_SCALE = 4;
export const LIGHT_NEAR_IMAGE_PREFIX = 'building-lights-near';
export const LAMP_NEAR_ALT_IMAGE_PREFIX = 'building-lights-near-alt';
export const GLOW_NEAR_IMAGE_PREFIX = 'building-glow-near';

// The lit cells come in two picks. `building-lights` draws the first, `building-lights-alt` the second, and the two
// layers cross-fade against each other: one fades out exactly as the other fades in, so a block keeps the number of
// windows it was given while the windows themselves change. That is the only way this layer can move at all - the
// pattern a `fill-extrusion` shows is baked into its bucket when the tile is tessellated, and a probe proved that
// rewriting the image behind the name (`updateImage` on all twenty-seven tiles, painted as solid bright sheets) leaves
// the rendered frame byte-for-byte unchanged. Opacity, on the other hand, is live: it is read every frame, which is
// what makes a cross-fade affordable.
export const LAMP_SET_SEEDS = [0x51f3, 0x2f61];
export const LAMP_ALT_IMAGE_PREFIX = 'building-lights-alt';
// How much of a band's lit cells the alternate pick turns over. The second seed does not re-deal the facade: it moves
// this share of the windows, and keeps the rest. Two independent deals changed every window on a block at once, which
// is the one thing a cross-fade must not look like; at 14 % a building loses a window or two and gains them back,
// which is the "城市在呼吸" a still observer can notice and cannot point at. It also keeps the single halo layer -
// which is cut from the shipped pick - within a cell or two of the windows it spills.
export const LAMP_SWAP_SHARE = 0.14;
// 整栋级的慢灭：一小撮楼在自己那一组交叉淡的时候换到"整面窗全灭"的那张图，于是它暗的是**一面墙**，其余的楼照旧只翻一两格。
//
// 这一档存在的理由是一次量数，不是感觉。把两组权重从出厂的 1/1 钉到 0/1，那块 720×460 的近场画面在加这一档之前只变了
// **1,460 颗像素（0.4 %）**，最挤的一个 24×24 小窗里也只有 90 颗在动——"每栋换一格"在像素总数与成簇度上都太小，
// 所以它算得出来、也换得出来，但眯眼看就是"夜里的灯不动"。整栋灭改变的是成簇度：一栋的窗一起暗，落在屏幕上是一个
// 连贯的暗块，而不是散在城里的单点。取 1/7 之后同一笔量到 **2,250 颗（0.7 %）与成簇 290**。
// 两个上限（把整座城的窗连同它的光晕全钉灭）：10,080 颗与成簇 326——成簇度是被一栋楼的墙面积封顶的，不是被份额封顶的，
// 1/7 已经拿到那个封顶的 89 %，再往上加份额只是让更多栋同时暗，而不是让暗更像暗。
//
// 模数取 7：它和这座城其余的骰子全部互质——分组 2、色温 10、整栋不亮 11、密度 13——所以这一撮既不会恰好落在某一组、
// 某一档或那 1/11 的暗楼上，也不会与它们同相。份额想再大一级也不能取 5：5 与色温的 10 有公因子，那一撮就只会摊到
// 暖白与冷白两档上，琥珀色的楼永远不呼吸。
//
// 为什么暗在**图案**里而不在 opacity 里：`fill-extrusion-opacity` 不是数据驱动属性，表达式里一旦出现
// `['get', ...]`，MapLibre 的校验器会整层丢掉（报 error 事件而不是抛异常，画面就是"灯火不见了"且图层还在）。
// 逐栋的判断只能挂在 `fill-extrusion-pattern` 上，而图案是 `resolvedImage`、逐帧不重读，所以"跟着权重慢灭"
// 只能是"交叉淡的另一手里给它一张全灭的图"：权重=1 时那一手 opacity 精确为 0，出厂帧逐字节不变。
// 晕跟着一起灭，走的是同一个道理的另一半：那一撮被拆成两层自己的晕（按组各一层，权重写在 zoom 档位里面），
// 因为一栋灭了窗的楼不能再留着它窗亮时糊在墙上的那一片暖光。
export const LAMP_BREATHE_MODULUS = 7;
export const LAMP_BREATHE_RESIDUE = 3;
export function lampBreather() {
  return ['==', ['%', ['to-number', ['get', 'osmId'], 0], LAMP_BREATHE_MODULUS], LAMP_BREATHE_RESIDUE];
}
export function isLampBreather(osmId) {
  return Math.abs(osmId) % LAMP_BREATHE_MODULUS === LAMP_BREATHE_RESIDUE;
}
// Two groups of blocks, split by their own OSM id, cross-fading on two periods that share no common factor. One group
// reshuffling every 11 s and the other every 17 s means there is nearly always a building somewhere mid-change, and
// the whole city never swaps its windows on the same beat. At 26 % of a cycle spent crossing, a group is turning over
// twice a period - so a still observer watching twenty seconds of night sees the city breathe without being able to
// point at a window.
export const LAMP_GROUPS = LAMP_SET_SEEDS.length;
export const LAMP_PERIODS_MS = [11000, 17000];
// The global state keys the two groups' weights ride, and what each one means: 1 is the shipped pick at full
// strength and the alternate pick at none, so a page that never animates is the page that was here before this.
export const LAMP_KEYS = ['lamp-0', 'lamp-1'];
// How much of a cycle is spent crossing over; the rest is a dwell on one pick.
export const LAMP_TRANSITION = 0.26;

/**
 * Where one group's cross-fade has reached, as the weight of the shipped pick.
 *
 * The alternate pick always carries `1 - w`, which is what keeps a block's lit count constant: measured over a
 * 700x460 crop of the night skyline, the count of lit window pixels held at 42,673 / 42,668 / 42,671 across a full
 * cycle, while the frame itself changed.
 *
 * @param {number} cycle position in the group's period, 0..1; 0 and 1 are the shipped frame, so a clock can wrap.
 */
export function lampWeight(cycle) {
  if (!(cycle >= 0 && cycle <= 1)) throw new Error(`lamp cycle needs a position between 0 and 1: ${cycle}`);
  const raw = 0.5 + 0.5 * Math.cos(cycle * Math.PI * 2);
  const shaped = (raw - 0.5) / LAMP_TRANSITION + 0.5;
  return Math.round(Math.min(1, Math.max(0, shaped)) * 1000) / 1000;
}

function lightBand(index) {
  const row = LIGHT_BANDS[index];
  if (!row) throw new Error(`unknown light band: ${index}`);
  return row;
}

function lightColour(index) {
  const colour = LIGHT_TEMPERATURES[index];
  if (!colour) throw new Error(`unknown light temperature: ${index}`);
  return colour;
}

function lightRing(index) {
  const ring = LIGHT_FADES[index];
  if (!ring) throw new Error(`unknown light ring: ${index}`);
  return ring;
}

// A halo is always dimmer than the window it spills from, in both directions of the ladder.
function lampAlpha(band, ring) {
  return Math.round(lightBand(band).alpha * lightRing(ring).dim);
}

/**
 * The alternate pick of a band's cells: the shipped one with a share of its windows turned over.
 *
 * The count is held exactly - as many cells go out as come in - because the cross-fade's one promise is that a block
 * keeps the number of windows it was given.
 */
function swapCells(count, cells, baseSeed, seed, share = LAMP_SWAP_SHARE) {
  const shipped = [...pickCells(count, cells, baseSeed)];
  const taken = new Set(shipped);
  const free = [...Array(count).keys()].filter((cell) => !taken.has(cell));
  // At least one window turns over, and never all of them: a swap of every cell is the two-deal pick this replaces.
  const swaps = Math.max(1, Math.min(shipped.length - 1, free.length, Math.round(shipped.length * share)));
  const out = new Set(shipped.filter((unused, index) => !pickCells(shipped.length, swaps, seed).has(index)));
  const added = pickCells(free.length, swaps, (seed + 0x9e3779b9) >>> 0);
  for (const index of added) out.add(free[index]);
  return out;
}

/**
 * One night-light tile: the band's cells hold a lit pane and everything else is fully transparent, so the wall colour
 * and the category keep coming from the layers underneath.
 *
 * @param {number} band height band index; must be `< LIGHT_BANDS.length`.
 * @param {number} temperature colour temperature index; must be `< LIGHT_TEMPERATURES.length`.
 * @param {number} ring distance ring index; must be `< LIGHT_FADES.length`.
 * @param {number} [set=0] which of the two picks of the band's cells to light; 0 is the one this scene shipped with.
 * @returns {{width: number, height: number, data: Uint8Array, litPanes: number}}
 */
export function lightTexture(band, temperature, ring, set = 0, near = false) {
  const row = lightBand(band), colour = lightColour(temperature), seed = LAMP_SET_SEEDS[set];
  if (!seed) throw new Error(`unknown lamp set: ${set}`);
  // The near grid holds four times the cells, so the band's count scales with it and the *share* of lit windows - the
  // thing the height ladder promises - is the same on both grids.
  const tile = near ? { ...LIGHT_TILE, rows: LIGHT_TILE.rows * 2, columns: LIGHT_TILE.columns * 2 } : LIGHT_TILE;
  const cells = row.cells * (near ? LIGHT_NEAR_SCALE : 1);
  const total = tile.rows * tile.columns;
  return facadeTexture({
    ...tile, glass: [0, 0, 0, 0], lit: [...colour, lampAlpha(band, ring)], litCells: cells, seed,
    ...(set === 0 ? {} : { litSet: swapCells(total, cells, LAMP_SET_SEEDS[0], seed) }),
  });
}

/**
 * The matching halo: the same cells the lamp tile above it lights (`pickCells` is seeded identically), spread into
 * feathered blobs instead of squares. Distances wrap, because an unclipped feather that runs off the tile edge comes
 * back as a hard seam where the pattern repeats.
 *
 * @param {number} band height band index; must be `< LIGHT_BANDS.length`.
 * @param {number} temperature colour temperature index; must be `< LIGHT_TEMPERATURES.length`.
 * @param {number} ring distance ring index; must be `< LIGHT_FADES.length`.
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function glowTexture(band, temperature, ring, near = false) {
  const row = lightBand(band), colour = lightColour(temperature);
  const dim = lightRing(ring).dim;
  const { size, rows, columns } = near ? { ...LIGHT_TILE, rows: LIGHT_TILE.rows * 2, columns: LIGHT_TILE.columns * 2 } : LIGHT_TILE;
  const cell = size / columns;
  const radius = cell * GLOW_REACH;
  const chosen = [...pickCells(rows * columns, row.cells * (near ? LIGHT_NEAR_SCALE : 1), 0x51f3)];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let peak = 0;
    for (const cellIndex of chosen) {
      let dx = Math.abs(x + 0.5 - ((cellIndex % columns) + 0.5) * cell);
      let dy = Math.abs(y + 0.5 - (Math.floor(cellIndex / columns) + 0.5) * cell);
      dx = Math.min(dx, size - dx); dy = Math.min(dy, size - dy);
      const distance = Math.hypot(dx, dy);
      if (distance < radius) peak = Math.max(peak, (1 - distance / radius) ** 2);
    }
    if (!peak) continue;
    const offset = (y * size + x) * 4;
    data[offset] = colour[0];
    data[offset + 1] = colour[1];
    data[offset + 2] = colour[2];
    data[offset + 3] = Math.round(peak * GLOW_PEAK * dim);
  }
  return { width: size, height: size, data };
}

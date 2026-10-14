// Procedural water-surface texture for the river.
//
// A flat `fill-pattern` does not tile the way the facade grid does. Measured in the real renderer, one image pixel spans
// one screen pixel whatever the zoom: a 32 px tile covered 32.1 px of screen at zoom 16 and a 64 px tile covered 63.4 px
// there and 64.0 px at zoom 18. So this texture has a screen size but no metre size, and it must be described as surface
// rhythm on screen, never as a wavelength, a current or a reflection.
//
// It is drawn through a translucent overlay above the basemap's own water fill, because `fill-pattern` makes the shader
// ignore `fill-color`: the per-atmosphere water colour keeps coming from the layer underneath.

import { seededRandom } from './facade.js';

export const WATER_IMAGE_PREFIX = 'river-surface';

/**
 * Build one seamless water tile: short crests, each with its shadow one row below, scattered over `rows` bands.
 *
 * @param {object} options
 * @param {number} options.size edge of the tile in pixels, which is also its width on screen.
 * @param {number} options.rows crest bands per repeat; the band below the ink stays clear so tiling cannot draw a seam.
 * @param {number[]} options.crest rgba of a wave crest.
 * @param {number[]} [options.trough] rgba of the shadow under a crest; omit for highlights only.
 * @param {number} options.density chance that a step plants a crest, in 0..1.
 * @param {number} [options.seed] picks which crests exist, so a reload cannot reshuffle the surface.
 * @returns {{width: number, height: number, data: Uint8Array, dashes: number}} an image MapLibre's addImage accepts.
 */
export function waterTexture({ size = 64, rows = 8, crest = [255, 255, 255, 46], trough = null, density = 0.5, seed = 0x2ea7 } = {}) {
  if (size % rows) throw new Error(`water tile must divide evenly by rows: ${size} by ${rows}`);
  const band = size / rows;
  // Two rows of ink plus the shadow row, and the rest of the band clear, so no crest can reach the next band.
  const inkRows = Math.min(2, Math.max(1, band - 2));
  const data = new Uint8Array(size * size * 4);
  const next = seededRandom(seed);
  const put = (x, y, value) => {
    const offset = ((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4;
    data[offset] = value[0];
    data[offset + 1] = value[1];
    data[offset + 2] = value[2];
    data[offset + 3] = value[3];
  };
  let dashes = 0;
  for (let row = 0; row < rows; row++) {
    const top = row * band;
    for (let x = 0; x < size;) {
      if (next() < density) {
        const length = 2 + Math.floor(next() * 4);
        const y = top + Math.floor(next() * inkRows);
        for (let k = 0; k < length; k++) {
          // The crest walks down one row every three pixels, so the dashes read as an uneven surface instead of a grid.
          put(x + k, y + Math.floor(k / 3), crest);
          if (trough) put(x + k, y + 1 + Math.floor(k / 3), trough);
        }
        dashes++;
        x += length;
      }
      x += 1 + Math.floor(next() * 3);
    }
  }
  return { width: size, height: size, data, dashes };
}

// One texture per atmosphere. The day surface only lifts a little sheen off the flat teal; sunset adds a warm glint and
// night a cooler one, which is what keeps the river reading as water instead of as a second land colour.
//
// Sunset is the other half of a pair with `ATMOSPHERES.sunset.water`: the fill is the lit channel, the crest here is the
// sky in it, and the trough is `#8a6a58` - the water in the shade of the bank. The two stops the brief names are both
// present, and which one dominates is settled by the shader: a fill layer's `fill-pattern` ignores `fill-color`, so the
// overlay is the only place a second colour can live and the flat fill is the only place the first one can be read.
export const WATER_THEMES = {
  day: { size: 64, rows: 8, crest: [255, 255, 255, 72], trough: [52, 98, 110, 56], density: 0.5 },
  sunset: { size: 64, rows: 8, crest: [246, 196, 138, 92], trough: [138, 106, 88, 74], density: 0.45 },
  // V6-4 lifted the crest to 104 to make the shimmer read at all; V7's budget puts the river in the last band, and
  // measured with the sheen on a dark surface the band still sat at 40.6 against 31.5 for the walls. Both ends of the
  // pair come back down by half, which keeps the *difference* between crest and trough that the eye reads as movement
  // while dropping the whole surface under the city it reflects.
  night: { size: 64, rows: 8, crest: [206, 232, 255, 52], trough: [4, 14, 28, 37], density: 0.5 },
};

/**
 * Slide a tile's rows by a whole number of screen pixels, wrapping past the edge so tiling cannot show a seam.
 *
 * The offset wraps at the tile height, so a repeated scroll cannot run a phase away: after `size` steps the surface is
 * back on the rows it started on, and composing two scrolls is exact because whole rows are copied, never resampled.
 * The river still keeps one pristine tile per atmosphere and scrolls from that, so switching atmosphere can put every
 * image back on its shipped rows in one write and leave the same frame a page without this feature would have drawn.
 *
 * @param {{width: number, height: number, data: Uint8Array, dashes?: number}} image a tile from {@link waterTexture}.
 * @param {number} offset rows to move up on screen; any integer, negative slides the other way.
 * @returns {{width: number, height: number, data: Uint8Array, dashes: number}} a fresh image for `updateImage`.
 */
export function scrollWater(image, offset) {
  const { width, height, data: source } = image;
  if (!Number.isInteger(offset)) throw new Error(`water offset must be a whole number of screen pixels: ${offset}`);
  const step = ((offset % height) + height) % height;
  const data = new Uint8Array(source.length);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const from = (((y + step) % height) * rowBytes);
    data.set(source.subarray(from, from + rowBytes), y * rowBytes);
  }
  return { width, height, data, dashes: image.dashes ?? 0 };
}

// 波光层的透明度斜坡。原来只写在 `map.js` 那条 `river-surface` 的 `fill-opacity` 表达式里，新引擎每帧要自己求值同一个数，
// 所以把档表挪到这里，两边读同一份：现版把它摊平成表达式，引擎按分段线性插值。
export const RIVER_OPACITY_STOPS = [[12, 0.4], [14, 0.72], [18.5, 0.72]];

/** 现版那侧要的 MapLibre 表达式（12 级以下江面还只是一条平色河带，14 级起满档）。 */
export const riverOpacityExpression = () => ['interpolate', ['linear'], ['zoom'], ...RIVER_OPACITY_STOPS.flat()];

/** 新引擎那侧要的同一个斜坡，按镜头层级求值；低于首档取首值、高于末档取末值。 */
export function riverOpacityFor(zoom) {
  if (!(zoom > RIVER_OPACITY_STOPS[0][0])) return RIVER_OPACITY_STOPS[0][1];
  for (let index = 1; index < RIVER_OPACITY_STOPS.length; index++) {
    const [from, fromValue] = RIVER_OPACITY_STOPS[index - 1];
    const [to, toValue] = RIVER_OPACITY_STOPS[index];
    if (zoom <= to) return fromValue + (toValue - fromValue) * ((zoom - from) / (to - from));
  }
  return RIVER_OPACITY_STOPS.at(-1)[1];
}


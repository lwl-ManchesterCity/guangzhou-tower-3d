// 夜灯那七层与它们的 324 张贴图（#219 从 map.js 拆出）：表达式、分组闸门、懒登记与层本体都收在这里，
// 外面只拿三样东西——`lampGates`（透视镜与氛围要逐层开关的名单）、`lampFilter`（组 clause 随基 filter 同行）、
// `ensureLampImages`（第一次开灯门前补图）。行为与拆分前一字不差。
import { GLOW_IMAGE_PREFIX, GLOW_NEAR_IMAGE_PREFIX, LAMP_ALT_IMAGE_PREFIX, LAMP_NEAR_ALT_IMAGE_PREFIX, LAMP_GROUPS, LAMP_KEYS, LIGHT_BANDS, LIGHT_FADES, LIGHT_IMAGE_PREFIX, LIGHT_NEAR_IMAGE_PREFIX, LIGHT_NEAR_ZOOM, LIGHT_TEMPERATURES, WINDOWS_OFF_IMAGE, glowTexture, lampBandExpression, lampBreather, lampDarkness, lampTemperatureDeal, lightTexture } from '../facade.js';

export function createLamps(map, formFilter) {
  // The night lamps are four layers rather than one: two groups of blocks, split by their own OSM id, each cross-fading
  // between two picks of the same band's cells. The shipped pick keeps the layer this scene has always had - same id,
  // same tile family - so everything that reads `building-lights` still reads it. See LAMP_GROUPS in facade.js for why
  // a cross-fade on opacity is the only motion this layer can make at all.
  const lampLayers = [
    { id: 'building-lights', group: 0, pick: 0 },
    { id: 'building-lights-alt', group: 0, pick: 1 },
    { id: 'building-lights-2', group: 1, pick: 0 },
    { id: 'building-lights-2-alt', group: 1, pick: 1 },
  ];
  const lampGroup = (group) => ['==', ['%', ['to-number', ['get', 'osmId'], 0], LAMP_GROUPS], group];
  const lampBreath = lampBreather();
  // `setFilter` replaces rather than merges, so every time the lens hands a base filter back the group clause has to
  // ride along with it - otherwise half the city's lamps end up drawn over the other half's group. The spill has no
  // group of its own except on the two layers that carry the breathing minority, whose halo has to go out with the
  // windows it spills from.
  const lampFilter = (layer, base) => {
    const gates = [base];
    if (layer.group !== null) gates.push(lampGroup(layer.group));
    if (layer.breath === true) gates.push(lampBreath);
    else if (layer.breath === false) gates.push(['!', lampBreath]);
    return ['all', ...gates];
  };
  const glowLayers = [
    { id: 'building-glow', group: null, breath: false },
    { id: 'building-glow-breath-0', group: 0, breath: true },
    { id: 'building-glow-breath-1', group: 1, breath: true },
  ];
  const lampGates = [...lampLayers, ...glowLayers];
  // Night lamps are coplanar overlays rather than a brighter colour in the grid above: an overlay can be almost opaque
  // where a window is and still leave the rest of the wall transparent, so the category colour and the distance fade of
  // the layer underneath keep coming through. How many windows a block lights is read from its own displayed height,
  // what colour they burn from its own OSM id and how brightly from its own distance, so no lamp is hand-placed and a
  // reload cannot reshuffle the skyline.
  // `fill-extrusion-vertical-gradient` stays off so a ground-floor window is not darker than a top-floor one, and the
  // pattern necessarily paints the top face too, so a low block shows lamps on its roof as well - accepted rather than
  // hidden, since masking the roof would mean drawing a second geometry. Turned on by the night atmosphere only, and it
  // shadows `building-facade`'s filter so a lamp never hangs in the air over a block the current lens hides.
  const wallHeight = ['coalesce', ['get', 'displayHeight'], ['get', 'height']];
  // The band is stepped on the same expression the extrusion height uses, so a block can never be drawn at one height
  // and dressed for another. Band x temperature x ring names one tile, i.e. twenty-seven per family.
  const lampBand = lampBandExpression(wallHeight);
  // Distance is a tile axis rather than an opacity one because `fill-extrusion-opacity` is not data-driven: the moment
  // MapLibre's style validator sees `['get', ...]` in it, the whole layer is dropped - as an `error` event, not a
  // throw, so the map simply renders without lamps. Without the ring a block 2.9 km away burns as brightly as one 300 m
  // off, and 1,441 of the 1,816 blocks on screen at the hero camera are past 1.5 km, which is most of what made the
  // first night frame read as an even sprinkle instead of a skyline with depth.
  const lampRing = ['step', ['get', 'distance'], 0, ...LIGHT_FADES.slice(0, -1).flatMap((ring, index) => [ring.below, index + 1])];
  // The colour temperature is dealt out by the block's own id too, but no longer three ways: `osmId % 3` gave a third
  // of the city the blue-white of an office slab, which is the "全白" the brief is about. Ten buckets, four amber, four
  // warm white, two cool - 80% warm, 20% cool - and the dark slice below is dealt from a *different* modulus, so
  // switching buildings off cannot thin the colour distribution with it.
  const lampTemperature = lampTemperatureDeal();
  const lampDark = lampDarkness();
  const lampTile = (prefix) => ['concat', prefix, '-', lampBand, '-', lampTemperature, '-', lampRing];    // The pane pitch is a tile axis as well: the shipped grid is 7.3 m per cell because that is the finest pitch the
  // hero camera (zoom 15.5 / pitch 62, ~1.6 m per screen pixel on a wall face) still resolves as a window, and V7
  // asks for half of it. Halving it everywhere put the hero camera's windows below that floor - measured 154 lit
  // pixels against 641 on the same wall - so the 3.7 m grid is a second family that takes over where it resolves.
  // `['zoom']` stays the outermost input of the top-level step: nested, the whole property is silently refused.
  // `dark` is the set of blocks that gets no tile at all: the 1/11 that burns nothing, plus - on the alternate pick
  // only - the 1/17 that breathes a whole facade instead of a cell or two.
  const lampImage = (prefix, nearPrefix, dark = lampDark) => ['step', ['zoom'],
    ['case', dark, WINDOWS_OFF_IMAGE, lampTile(prefix)], LIGHT_NEAR_ZOOM,
    ['case', dark, WINDOWS_OFF_IMAGE, lampTile(nearPrefix)]];
  // 本组那一枚出厂档的表达式写法（注意它与 `src/facade.js` 那个算数值的 `lampWeight` 同名不同物，这里叫
  // `lampState`）。`['zoom']` has to stay
  // the input of the outermost interpolate - nested inside a `['*']` the whole property is silently refused - so the
  // global state rides inside each stop, which is also how the day/sunset/night blend walks these same numbers.
  const lampState = (group) => ['global-state', LAMP_KEYS[group]];
  const lampAlpha = (layer) => layer.pick === 0
    ? lampState(layer.group) : ['-', 1, lampState(layer.group)];
  const lampOpacity = (layer) => ['interpolate', ['linear'], ['zoom'],
    14, 0, 15, ['*', 0.62, lampAlpha(layer)], 16.5, ['*', 0.72, lampAlpha(layer)], 18, ['*', 0.8, lampAlpha(layer)]];
  // The spill's own ramp. `weight` is null for the majority, whose halo is spill and not a window and so never moves;
  // the breathing minority gets its group's weight, so the wash on its wall goes out with the windows that made it
  // instead of floating on a dark building. At weight 1 the multiplier is exactly 1 - the shipped frame is unchanged.
  const glowOpacity = (weight) => ['interpolate', ['linear'], ['zoom'], 14, 0,
    15, weight ? ['*', 0.44, weight] : 0.44,
    16.5, weight ? ['*', 0.56, weight] : 0.56,
    18, weight ? ['*', 0.66, weight] : 0.66];
  // 324 张灯格家族贴图只在夜里被采样：读它们的层出厂就是 `visibility: 'none'`，而 MapLibre 是在渲染时才解析
  // pattern 图名，藏着的层不会去查图。所以这一族不在开图时造——白昼那张首帧一张也用不上，324 次离屏画布
  // 光栅化全是白花的。第一次把灯门打开（`swapArt('night')`，走路的中点与瞬切都经过它）才补登记，登记一次
  // 就够：图进了样式就一直在，之后来回切昼夜不再造。
  let lampImagesAdded = false;
  function ensureLampImages() {
    if (lampImagesAdded) return;
    lampImagesAdded = true;
    for (let band = 0; band < LIGHT_BANDS.length; band++) {
      for (let temperature = 0; temperature < LIGHT_TEMPERATURES.length; temperature++) {
        for (let ring = 0; ring < LIGHT_FADES.length; ring++) {
          map.addImage(`${LIGHT_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring));
          map.addImage(`${LAMP_ALT_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring, 1));
          map.addImage(`${GLOW_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, glowTexture(band, temperature, ring));
          map.addImage(`${LIGHT_NEAR_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring, 0, true));
          map.addImage(`${LAMP_NEAR_ALT_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, lightTexture(band, temperature, ring, 1, true));
          map.addImage(`${GLOW_NEAR_IMAGE_PREFIX}-${band}-${temperature}-${ring}`, glowTexture(band, temperature, ring, true));
        }
      }
    }
  }
  for (const layer of lampLayers) {
    map.addLayer({
      id: layer.id, type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14, filter: lampFilter(layer, formFilter),
      layout: { visibility: 'none' },
      paint: {
        // On the alternate hand, the breathing minority is handed the all-dark tile: as its group's weight walks from
        // 1 to 0 the whole facade goes out with it, while every other block just turns a cell or two over. Opacity
        // cannot carry that per-block rule - `['get']` in `fill-extrusion-opacity` drops the layer - so the dice is
        // read here, where a data-driven pattern is what the layer already runs on.
        'fill-extrusion-pattern': lampImage(layer.pick ? LAMP_ALT_IMAGE_PREFIX : LIGHT_IMAGE_PREFIX,
          layer.pick ? LAMP_NEAR_ALT_IMAGE_PREFIX : LIGHT_NEAR_IMAGE_PREFIX,
          layer.pick ? ['any', lampDark, lampBreath] : lampDark),
        'fill-extrusion-opacity': lampOpacity(layer),
        'fill-extrusion-height': wallHeight,
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-vertical-gradient': false,
      },
    }, 'height-estimates');
  }
  // Spill goes under the lamps it belongs to: the hard-edged tile draws over its own halo, so a window keeps an edge
  // while the wall around it picks up the light. Same geometry, same band, same gates - and it has to be inserted by
  // id, since the lamps already exist at this point. It stays on the shipped pick: a halo is spill, not a window, and
  // the two picks' halos differ only in which cells they smear. The breathing minority is the exception, and it is
  // its own two layers rather than a per-block opacity (which `fill-extrusion-opacity` cannot carry): a building
  // whose windows are going out cannot keep the wash they cast.
  let under = lampLayers[0].id;
  for (const layer of glowLayers) {
    map.addLayer({
      id: layer.id, type: 'fill-extrusion', source: 'canton-buildings', minzoom: 14,
      filter: lampFilter(layer, formFilter),
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-pattern': lampImage(GLOW_IMAGE_PREFIX, GLOW_NEAR_IMAGE_PREFIX),
        'fill-extrusion-opacity': glowOpacity(layer.group === null ? null : lampState(layer.group)),
        'fill-extrusion-height': wallHeight,
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-vertical-gradient': false,
      },
    }, under);
    under = layer.id;
  }
  return { lampGates, lampFilter, ensureLampImages };
}
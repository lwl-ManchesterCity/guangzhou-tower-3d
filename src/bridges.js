// Bridge decks over the river, from `data/canton-bridges.geojson`.
//
// The river is the main subject of this frame and until now nothing crossed it but a label: OSM draws every one of
// these crossings as a tagged *line*, and a line has no height in MapLibre - `line` layers are draped on the ground,
// and there is no `line-height` to give them. So the deck is a polygon, built offline by sweeping a strip along the
// way, and what lifts it off the water is the extrusion's own `base`.
//
// Two layers, because the brief asks for a parapet rather than a floating slab: the deck, and one narrow upstand along
// each edge. Both read their heights straight off the feature, which is where the 示意 clearance and thickness are
// recorded - they are drawing constants, not surveyed values, and the snapshot's metadata says so in the same words.
//
// Nothing here is placed by hand. Each feature carries the OSM way id it was swept from, and a way only earns a deck
// if its own polyline crosses a `waterway` line in the same box.

export const BRIDGE_SOURCE = 'canton-bridges';
export const BRIDGE_DECK = 'bridge-decks';
export const BRIDGE_PARAPET = 'bridge-parapets';

const height = (property) => ['coalesce', ['get', property], 0];

/**
 * The two bridge layers, coloured by the atmosphere that is current.
 *
 * `foot` is read from the way's own highway class, not from a name: a pedestrian crossing is the one the frame already
 * labels warmer, and the tag is what says so.
 *
 * @param {object} theme one entry of `ATMOSPHERES`.
 */
export function bridgeLayers(theme) {
  return [
    {
      id: BRIDGE_DECK, type: 'fill-extrusion', source: BRIDGE_SOURCE, filter: ['==', ['get', 'part'], 'deck'],
      paint: {
        // `case`, not `match`: a `match` refuses a boolean label, and MapLibre drops a layer whose paint fails
        // validation in silence - no throw, no console error, the id simply missing from `getLayersOrder()`.
        'fill-extrusion-color': ['case', ['==', ['get', 'foot'], true], theme.bridgeFoot, theme.bridge],
        'fill-extrusion-height': height('height'), 'fill-extrusion-base': height('base'),
        'fill-extrusion-vertical-gradient': false,
      },
    },
    {
      id: BRIDGE_PARAPET, type: 'fill-extrusion', source: BRIDGE_SOURCE, filter: ['==', ['get', 'part'], 'kerb'],
      paint: {
        'fill-extrusion-color': theme.bridgeParapet, 'fill-extrusion-height': height('height'),
        'fill-extrusion-base': height('base'), 'fill-extrusion-vertical-gradient': false,
      },
    },
  ];
}

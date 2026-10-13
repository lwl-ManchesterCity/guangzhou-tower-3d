// One silhouette per landmark, drawn small enough to sit inside a nameplate so the mark says who it is before you read
// the name.
//
// These are outlines of the shapes the buildings actually have, read off public descriptions of each - the tower's
// hyperboloid waist and mast, the East Tower's stepped setbacks and crown spire, the West Tower's smooth taper from a
// wide triangular foot to a rounded top, the museum's slab cantilevered over a recessed base, the bridge's arched rib
// under a flat deck, the square's long axis running away from the eye. They are drawn to be legible at 16 px, not to be
// measured: the heights in the card come from OSM, and the 3D forms are the next step.
//
// Coordinates are a 24x24 box with the ground line at y=21, so every mark stands on the same base.
export const GLYPH_BOX = '0 0 24 24';

export const LANDMARK_GLYPHS = {
  // 广州塔: two curves in to a waist and out again under the crown, with the mast on top.
  584204634: ['M6,21 C8,17 9.4,15 9.4,12 C9.4,9 8,7 7.4,5 L16.6,5 C16,7 14.6,9 14.6,12 C14.6,15 16,17 18,21',
    'M12,5 L12,1.5', 'M6,21 L18,21'],
  // 东塔: four stepped setbacks, tapering on both faces, ending in a crown spire.
  511404889: ['M7,21 L7,16 L8.6,16 L8.6,12 L10.2,12 L10.2,8 L11.4,8 L11.4,4 L12.6,4 L12.6,8 L13.8,8 L13.8,12 L15.4,12 L15.4,16 L17,16 L17,21 Z',
    'M12,4 L12,1.6', 'M7,21 L17,21'],
  // 西塔: a wide foot with curved-in faces, closing to a rounded crown. No waist, no setback.
  184738716: ['M6.8,21 C8.4,15.6 9.2,10.4 9.6,6.6 C9.8,4.8 10.7,4 12,4 C13.3,4 14.2,4.8 14.4,6.6 C14.8,10.4 15.6,15.6 17.2,21',
    'M6.8,21 L17.2,21'],
  // 广东省博物馆: the big box, and the thin recessed storey it appears to float on.
  240896442: ['M4,5.4 L20,5.4 L20,17.2 L15.6,17.2 L15.6,21 L8.4,21 L8.4,17.2 L4,17.2 Z', 'M12,8 L12,14.6'],
  // 海心桥: a flat deck on two abutments, one arch rib springing above it and hangers down to the deck - the same
  // reading the 3D form uses, where `bridge:structure=arch` is what OSM says and the rib's rise is drawn.
  1313608038: ['M2.6,14.6 L21.4,14.6', 'M4.6,14.6 C7.4,6.6 16.6,6.6 19.4,14.6',
    'M9.6,14.6 L9,10', 'M14.4,14.6 L15,10', 'M4.6,14.6 L4.6,20.6', 'M19.4,14.6 L19.4,20.6'],
  // 花城广场: the two-kilometre axis underfoot, drawn as ground running away from the eye - the one mark here that is
  // not stood up, because the square has no elevation to stand.
  243319596: ['M4,21 L9.4,13 L14.6,13 L20,21 Z', 'M12,21 L12,13'],
  // 猎德大桥: the deck on two piers and the lozenge pylon that carries it, with the stays fanned down to the deck.
  // OSM gives only the two carriageway outlines, so the pylon's shape is read off public pictures and is 示意 - unlike
  // 海心桥 above, whose rib the data does describe (`bridge:structure=arch`) and whose rise is measured.
  233809684: ['M2.6,14.8 L21.4,14.8', 'M12,14.8 L9.6,9.2 L12,3.4 L14.4,9.2 Z',
    'M12,4.6 L6.2,14.8', 'M12,4.6 L17.8,14.8', 'M7.6,14.8 L7.6,20.8', 'M16.4,14.8 L16.4,20.8'],
};

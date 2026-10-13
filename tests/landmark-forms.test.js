import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import * as formsModule from '../src/landmark-forms.js';
import {
  FORM_BREATH_MS,
  DECK_CLEARANCE_METRES, DECK_THICKNESS_METRES, FORM_NIGHT_BODY, FORM_NIGHT_CROWN, FORM_OSM_IDS,
  LANDMARK_FORMS, createLandmarkForms, crownBreath, finStrips, loftGeometry, refineLevels, refineRing,
  SHELL_BAND_METRES, SHELL_FACET_METRES, SHELL_STOREY_METRES, DIAGRID_RIB_METRES, DIAGRID_STOREYS, FACADE_CELL_METRES, FORM_NIGHT_LAMP, splitLevels, shellGridScale, shellGridTexture, shellStoreyMetres,
} from '../src/landmark-forms.js';
import { FACADE_CATEGORY_SHAPES, FACADE_SHAPES } from '../src/facade.js';
import { FACADE_PIXEL_METRES } from '../src/tower-facade.js';
import { ATMOSPHERES, mixHex, recedeColor } from '../src/atmosphere.js';
import { DEFAULT_CENTER, RADIUS_METERS, SCENE } from '../src/config.js';
import { distanceMeters, plane } from '../src/geo.js';

const buildings = JSON.parse(readFileSync(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8'));
const bridge = JSON.parse(readFileSync(new URL('../public/data/haixin-bridge.geojson', import.meta.url), 'utf8'));
const features = [...buildings.features, ...bridge.features];
const featureOf = (osmId) => features.find((feature) => feature.properties.osmId === osmId);
const heightOf = (feature) => Number(feature.properties.displayHeight ?? feature.properties.height);
const widenings = (levels) => levels.filter(([, scale], index) => index > 0 && scale > levels[index - 1][1]).length;
/** 变宽发生在同一标高的那一对上，才是一块朝下的底面（悬挑的 soffit）；跨在一带里变宽只是墙向外倾，仍是墙。 */
const soffits = (levels) => levels.filter(([, scale], index) => index > 0 && scale > levels[index - 1][1] && levels[index][0] === levels[index - 1][0]).length;
const ledges = (levels) => levels.filter(([t], index) => index > 0 && t === levels[index - 1][0]).length;
const sides = (ring) => (ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.length - 1 : ring.length);
/** The share of its lamp one part of a form burns at, read off the table the form itself carries. */
const shareOf = (osmId, part) => {
  const night = LANDMARK_FORMS[osmId].night;
  // 塔身穿了灯图就按灯档走：暗格是 0，所以平均亮度还是由"亮了多少格"决定，这一档只管亮着的那些真亮。
  if (part === 'body' && night.lamps && LANDMARK_FORMS[osmId].facade) return FORM_NIGHT_LAMP;
  return part === 'crown' ? night.crown ?? FORM_NIGHT_CROWN : night.body ?? FORM_NIGHT_BODY;
};

/** Every triangle's face normal, area and signed volume contribution, as the geometry actually holds it. */
function faceNormals(geometry) {
  const position = geometry.getAttribute('position');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const faces = [];
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    faces.push({
      normal: normal.clone().normalize(),
      area: normal.length() / 2,
      // One sixth of the scalar triple product is the signed volume this triangle contributes with the origin as apex;
      // summed over a shell it gives the enclosed volume, whose sign is the winding.
      volume: a.clone().cross(b).dot(c) / 6,
      centroid: a.clone().add(b).add(c).divideScalar(3),
    });
  }
  return faces;
}

/** Where a shell's faces ended up: how many walls, how many lids facing up, how many facing down. */
function shell(ring, height, levels, origin, options = {}) {
  const geometry = loftGeometry(ring, height, levels, origin, options);
  const foot = sides(ring);
  const out = { geometry, box: new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position')), walls: 0, up: 0, down: 0, volume: 0, lidArea: 0 };
  for (const face of faceNormals(geometry)) {
    // A real triangle on these rings is at least a tenth of a square metre; the only way to get a zero-area one is to
    // leave the ring's closing duplicate in and build a seam on top of itself.
    assert.ok(face.area > 1e-6, `a ${face.area.toExponential(2)} m² triangle: a seam left in the ring`);
    out.volume += face.volume;
    if (Math.abs(face.normal.y) < 0.9) {
      out.walls += 1;
      assert.ok(Math.abs(face.normal.x) + Math.abs(face.normal.z) > 0.5, 'a face that is neither a wall nor a lid');
    } else {
      assert.ok(Math.abs(face.normal.x) < 0.02 && Math.abs(face.normal.z) < 0.02, 'a tilted lid');
      if (face.normal.y > 0) {
        out.up += 1;
        out.lidArea += face.area;
      } else out.down += 1;
    }
  }
  // The face budget is exact, not a floor: every pair of levels is either a band of wall or a ring of ledges, the roof
  // and the underside are triangulated (n-2 triangles for an n-gon), and an overhang's soffit turns down. A band that
  // widens as it climbs - 西塔 bulging to its widest ring at a third of its height - is still a wall: it leans out, it
  // does not turn its face to the ground.
  const bands = levels.length - 1;
  const flat = ledges(levels);
  const hung = soffits(levels);
  assert.equal(out.walls, 2 * foot * (bands - flat), `${out.walls} wall triangles for ${bands} bands, ${flat} of them level`);
  assert.equal(out.up, foot - 2 + 2 * foot * (flat - hung), `${out.up} upward faces: a triangulated roof plus the top of each narrowing step`);
  assert.equal(out.down, 2 * foot * hung + (options.cap ? foot - 2 : 0),
    `${out.down} downward faces: the soffit of each ledge that steps out${options.cap ? ' and the capped underside' : ''}`);
  // The winding is proved over the whole shell rather than face by face against a centre point: 海心桥's outline is a
  // curved strip whose centre falls outside the deck, so a wall on the inner edge of that curve legitimately faces it.
  // Flipping any face's winding moves this sum, and flipping the shell's turns it negative.
  assert.ok(out.volume > 0, 'the shell is wound inward');
  return out;
}

test('every form is a measured element, and its curve is the kind of thing it is', () => {
  assert.deepEqual(FORM_OSM_IDS, Object.keys(LANDMARK_FORMS).map(Number));
  for (const [osmId, form] of Object.entries(LANDMARK_FORMS)) {
    const feature = featureOf(Number(osmId));
    assert.ok(feature, `${osmId} must be an element a shipped snapshot carries, not one typed in from memory`);
    assert.equal(feature.geometry.type, 'Polygon', `${osmId} is drawn from its own outline`);
    const { levels } = form;
    assert.ok(sides(feature.geometry.coordinates[0]) > 3, `${osmId} needs a ring with area`);
    assert.equal(levels[0][0], 0, `${osmId} starts at the bottom of its own storey`);
    assert.equal(levels.at(-1)[0], 1, `${osmId} ends at the top of it`);
    // 脚必须落在实测轮廓上（1.0），往上最多鼓出 6%——西塔最宽的那一圈在 1/3 高度，是事务所写的，不是量出来的。
    assert.ok(levels.every(([fraction, scale]) => fraction >= 0 && fraction <= 1 && scale > 0 && scale <= 1.1),
      `${osmId} 的曲线鼓过了实测轮廓的 10%，或缩到了零以下`);
    assert.equal(levels[0][1], form.kind === 'taper' || form.kind === 'setbacks' ? 1 : levels[0][1],
      `${osmId} 的塔脚没站在自己那条实测轮廓上`);
    for (let i = 1; i < levels.length; i += 1) {
      assert.ok(levels[i][0] >= levels[i - 1][0], `${osmId} climbs in order at level ${i}`);
    }
    if (form.kind === 'taper') {
      assert.ok(heightOf(feature) > 100, `${osmId} is only worth a shell because it is tall`);
      // 「最宽处在高度的三分之一处，向上越收越窄」——所以允许它在到达那之前变宽，之后必须一路收窄。
      const widest = levels.reduce((best, level) => (level[1] > best[1] ? level : best), levels[0]);
      assert.ok(Math.abs(widest[0] - 1 / 3) < 0.05, `${osmId} 最宽的一圈在 ${widest[0]} 高度，事务所说的是三分之一处`);
      assert.equal(widenings(levels.slice(levels.indexOf(widest))), 0, `${osmId} 过了最宽那一圈还在变宽`);
      assert.ok(soffits(levels) === 0, `${osmId} 的收分曲线里不该有一块朝下的底面`);
      assert.ok(levels.at(-1)[1] > 1 / 2, `${osmId} ends ${levels.at(-1)[1]} of its foot width - that is a spire, not a crown`);
    }
    if (form.kind === 'setbacks') {
      assert.equal(widenings(levels), 0, `${osmId} steps back all the way up`);
      // KPF 说的是四个转接点（办公→住宅→酒店→塔冠），所以硬跳恰好四道，且全在上半段：下半段是一根直筒。
      assert.equal(ledges(levels), 4, `${osmId} has ${ledges(levels)} horizontal faces, not four transitions`);
      const first = levels.findIndex(([fraction], index) => index && fraction === levels[index - 1][0]);
      assert.ok(levels[first][0] > 0.5, `${osmId} 的第一道退台在 ${levels[first][0]} 高度 - 直段比那截短就不叫直筒了`);
      assert.ok(levels.at(-1)[1] > 2 / 3, `${osmId} ends on a crown, not a point`);
    }
    if (form.kind === 'cantilever') {
      assert.equal(widenings(levels), 1, `${osmId} hangs over its base once, at the lip of the box`);
      const lip = levels.findIndex(([, scale], index) => index > 0 && scale > levels[index - 1][1]);
      assert.ok(levels[lip][0] < 0.5, `${osmId}'s overhang starts at ${levels[lip][0]} of its height - the box is the building`);
      assert.equal(levels.at(-1)[1], 1, `${osmId}'s box fills its own measured footprint`);
    }
    if (form.kind === 'deck') {
      assert.equal(feature.properties.structure, 'arch', 'the tag is what says this is an arch bridge at all');
      assert.ok(feature.properties.name === '海心桥', `${osmId} must be the bridge the label names`);
      assert.ok(DECK_CLEARANCE_METRES > 0 && DECK_THICKNESS_METRES > 0);
      assert.ok(Number.isNaN(heightOf(feature)), 'the bridge carries no OSM height, so nothing here may claim one');
    }
  }
});

test('a shell stands on its own footprint, tops out at its own height, and faces outward', () => {
  for (const [osmId, form] of Object.entries(LANDMARK_FORMS)) {
    if (form.kind === 'deck') continue;
    const feature = featureOf(Number(osmId));
    const height = heightOf(feature);
    const ring = feature.geometry.coordinates[0];
    const { box } = shell(ring, height, form.levels, SCENE.center);
    assert.ok(Math.abs(box.max.y - height) < 1e-3, `${osmId} tops out at ${box.max.y}, not its measured ${height} m`);
    assert.ok(box.min.y < 1e-6, `${osmId} starts at the ground it stands on`);
    // The widest level is the one that sets the span, so the shell cannot be wider than the block OSM measured.
    const widest = Math.max(...form.levels.map(([, scale]) => scale));
    const foot = ring.map(([lng, lat]) => plane(SCENE.center, { lng, lat }));
    const span = (values) => Math.max(...values) - Math.min(...values);
    assert.ok(Math.abs(span(foot.map((p) => p.dx)) * widest - (box.max.x - box.min.x)) < 0.5, `${osmId} keeps its east-west span`);
    assert.ok(Math.abs(span(foot.map((p) => p.dy)) * widest - (box.max.z - box.min.z)) < 0.5, `${osmId} keeps its north-south span`);
  }
});

test('the deck is the OSM outline stood between two drawn numbers', () => {
  const feature = featureOf(1313608038);
  const ring = feature.geometry.coordinates[0];
  const levels = LANDMARK_FORMS[1313608038].levels;
  const top = DECK_CLEARANCE_METRES + DECK_THICKNESS_METRES;
  const { box, lidArea } = shell(ring, top, levels, SCENE.center, { base: DECK_CLEARANCE_METRES, cap: true });
  assert.ok(Math.abs(box.min.y - DECK_CLEARANCE_METRES) < 1e-3, `the deck starts at ${box.min.y}, not its drawn clearance`);
  assert.ok(Math.abs(box.max.y - top) < 1e-3, `the deck walks on a ${box.max.y - box.min.y} m slab, not ${DECK_THICKNESS_METRES}`);
  // The plan is the way, unchanged: the deck cannot be wider or narrower than what OSM measured.
  const area = (points) => {
    let twice = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      twice += a.x * b.y - b.x * a.y;
    }
    return Math.abs(twice / 2);
  };
  const foot = ring.map(([lng, lat]) => {
    const { dx, dy } = plane(SCENE.center, { lng, lat });
    return { x: dx, y: dy };
  });
  // The deck has one upward face set - its roof - so the area it tiles has to be the area the way describes.
  assert.ok(Math.abs(lidArea - area(foot)) / area(foot) < 0.01,
    `the deck's roof is ${lidArea.toFixed(0)} m² against the way's ${area(foot).toFixed(0)} m²`);
  assert.ok(area(foot) > 5000 && area(foot) < 9000, `${area(foot).toFixed(0)} m² is not the 6,800 m² strip the way describes`);
});

test('the bridge snapshot says where it came from and carries one closed way', () => {
  assert.equal(bridge.type, 'FeatureCollection');
  assert.equal(bridge.features.length, 1, 'one element: the deck outline the label points at');
  const metadata = bridge.metadata;
  assert.equal(metadata.license, 'ODbL-1.0');
  assert.match(metadata.attribution, /OpenStreetMap/);
  assert.ok(metadata.timestamp, 'a snapshot without a timestamp cannot be diffed later');
  assert.match(metadata.source, /^https:\/\//);
  assert.match(metadata.selection, /way\/1313608038/);
  const ring = bridge.features[0].geometry.coordinates[0];
  assert.equal(metadata.points, ring.length);
  assert.deepEqual(ring[0], ring.at(-1), 'the way has to be closed to be a deck outline');
  assert.equal(bridge.features[0].geometry.coordinates.length, 1, 'no holes in a bridge deck');
  for (const [lng, lat] of ring) {
    assert.ok(lng > 113.2 && lng < 113.4 && lat > 23.0 && lat < 23.2, `${lng},${lat} is outside the scene`);
  }
});

test('the forms are the curves, dressed in their own category colour', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  assert.deepEqual(forms.ids, FORM_OSM_IDS, 'one form per curve, and nothing invented alongside them');
  for (const form of forms.forms) {
    const feature = featureOf(form.osmId);
    assert.equal(form.category, feature.properties.category ?? 'unknown', `${form.osmId} wears its own category colour`);
    assert.equal(form.kind, LANDMARK_FORMS[form.osmId].kind);
    if (form.kind === 'deck') {
      assert.equal(form.height, DECK_CLEARANCE_METRES + DECK_THICKNESS_METRES);
      assert.equal(form.hit, false, 'the deck is not clickable: its nameplate opens the card, and a hit box would claim a storey');
    } else {
      assert.equal(form.height, heightOf(feature), `${form.osmId} is as tall as the snapshot says`);
      assert.equal(form.hit, true);
    }
  }
  const parts = forms.forms.reduce((sum, form) => sum + form.shells.length, 0);
  const meshes = forms.group.children.filter((child) => child.isMesh);
  assert.equal(meshes.length, parts, 'one mesh per part of every form, and no rib yet');
  assert.ok(parts > forms.forms.length, 'a crown that burns brighter than its shaft has to be drawn as its own mesh');
  const meshOf = (osmId) => meshes.find((child) => child.name === String(osmId));
  // A shell mesh carries two materials: slot 0 is the wall with its window grid, slot 1 the lid without one.
  const wallOf = (mesh) => (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
  const lidOf = (mesh) => (Array.isArray(mesh.material) ? mesh.material[1] : null);
  for (const child of meshes) {
    assert.ok(child.isMesh, 'the group holds meshes, not wrappers');
    assert.equal(child.frustumCulled, false, 'a 530 m shell measured from the scene centre cannot trust a local bounding sphere');
  }
  // The obstruction lamps are gone by the user's ruling of 2026-10-04 (「把上面这些红圈去掉」), so the only claim left
  // here is that nothing red comes back: the V8 brief still names 障碍红灯 in its Phase 3 list, and that line is void.
  assert.deepEqual(forms.group.children.filter((child) => child.name.endsWith(':beacon')).map((child) => child.name), [],
    'a red obstruction lamp is drawn again after being cancelled');
  assert.equal(forms.beacons, undefined, 'the beacon clock is being ticked again');
  // A shell is not in the fog business on its own: it has to wear the same hex the extrusion ramp paints a block at
  // that distance, or a landmark tower stands crisp in a far field that recedes.
  for (const form of forms.forms) {
    assert.ok(Number.isFinite(form.distance) && form.distance > 0, `${form.osmId} has no distance to recede by`);
    assert.ok(form.distance < RADIUS_METERS, `${form.osmId} sits ${form.distance} m out, past the ring`);
  }
  forms.setAtmosphere({ from: ATMOSPHERES.night, share: 1 });
  forms.recede(16);
  for (const form of forms.forms) {
    const night = LANDMARK_FORMS[form.osmId].night;
    assert.ok(night?.glow, `${form.osmId} has a form and no lamp colour to stand in for the window grid it does not have`);
    assert.ok(form.shells.some((shell) => shell.part === 'crown') === Boolean(night.crownFrom),
      `${form.osmId} splits for a crown only when it names where the crown starts`);
    for (const shell of form.shells) {
      // The ramp's own hex, run through the light floor MapLibre gives a side face. A mesh carries no directional light,
      // so wearing the hex raw put a landmark shaft a third above the walls standing next to it - measured at 48.9
      // against 31.5 with the shell's own lamp switched off - which is the inversion V7's night budget forbids.
      assert.equal(`#${shell.material.color.getHexString()}`,
        mixHex(recedeColor(ATMOSPHERES.night, form.category, form.distance, { zoom: 16 }), '#000000', ATMOSPHERES.night.light.intensity),
        `${form.osmId} is not the ramp's hex at ${form.distance} m, dimmed by the night light floor`);
      // Night without a window grid would leave a black hole where a lit tower stands, so the shell carries a lamp
      // colour of its own - and not its wall colour, which at night is the near-black the extrusions recede to.
      assert.equal(`#${shell.material.emissive.getHexString()}`, night.glow,
        `${form.osmId} does not light with its own lamp colour`);
      assert.equal(shell.material.emissiveIntensity, shareOf(form.osmId, shell.part),
        `${form.osmId}'s ${shell.part} is at the wrong share of its lamp`);
      // 顶面跟着自己的墙一起烧：一栋亮着的楼顶上盖一张黑纸，读起来就是那个洞。肋和桥台不是壳体，没有顶面。
      // 但顶面走的是**墙面那一档**而不是灯那一档——屋顶上没有窗可亮，给它 0.55 就是在广场上方摊一块白板。
      if (shell.roof) {
        assert.equal(shell.roof.emissiveIntensity, shell.share,
          `${form.osmId} 的屋顶没跟着它墙面的那一档亮`);
        assert.equal(`#${shell.roof.emissive.getHexString()}`, `#${shell.material.emissive.getHexString()}`,
          `${form.osmId} 的屋顶点了另一盏灯`);
      }
    }
  }
  assert.ok(FORM_NIGHT_CROWN > FORM_NIGHT_BODY, 'the top of the curve is the part that reads as a crown');
  // The two low forms wear no crown at all: a 16 m roof or a 15 m deck at a tower's crown share reads as a sheet of
  // paper laid on the plaza, which is the frame this was measured on. Their shaft is a band, not a lamp of its own -
  // V7 put every shaft in the scene on the same budget as the walls standing next to it, so neither is allowed above
  // the default any more.
  for (const osmId of [240896442, 1313608038]) {
    assert.ok(shareOf(osmId, 'body') <= FORM_NIGHT_BODY, `${osmId} burns at ${shareOf(osmId, 'body')} of its lamp, above the shaft band`);
    assert.equal(LANDMARK_FORMS[osmId].night.crownFrom, undefined, `${osmId} is too low to wear a crown`);
  }
  forms.setAtmosphere({ from: ATMOSPHERES.day, share: 1 });
  forms.recede(16);
  for (const shell of forms.forms.flatMap((form) => form.shells)) {
    assert.equal(shell.material.emissiveIntensity, 0, 'a shell does not light up a sunny afternoon');
    assert.equal(`#${shell.material.emissive.getHexString()}`, `#${shell.material.color.getHexString()}`,
      'and its emissive goes back to the wall, not to a lamp nobody asked for');
  }
  // The same shells read at the overview camera, where the ramp starts earlier: pulling back has to pale them too.
  forms.recede(12);
  for (const form of forms.forms) {
    const mesh = meshOf(form.osmId);
    assert.equal(`#${wallOf(mesh).color.getHexString()}`,
      recedeColor(ATMOSPHERES.day, form.category, form.distance, { zoom: 12 }), `${form.osmId} at the overview`);
    // 顶面走的是同一档墙色，只是不挂窗格：一格的 v 是一个数，挂上去就是把一条玻璃带摊在楼顶上。
    assert.equal(lidOf(mesh).map, null, `${form.osmId} 的屋顶挂了窗格`);
    assert.equal(`#${lidOf(mesh).color.getHexString()}`, `#${wallOf(mesh).color.getHexString()}`,
      `${form.osmId} 的屋顶和它自己的墙不是一个色`);
  }
  const before = `#${wallOf(meshOf(511404889)).color.getHexString()}`;
  assert.equal(forms.recede(12.004), false, 'a nudge of the camera must not repaint every frame');
  assert.equal(forms.recede(13), true, 'a real zoom step has to repaint');
  assert.notEqual(`#${wallOf(meshOf(511404889)).color.getHexString()}`, before, 'the zoom walk did not move the colour');
  forms.setVisible(false);
  assert.equal(forms.group.visible, false, 'the height lens hands the block back to its extrusion');
  forms.setVisible(true);
  assert.equal(DEFAULT_CENTER.lat, SCENE.center.lat, 'the tower scene is the one these forms belong to');
});

test('a crown is cut out of the same curve, at the level the curve already makes a ledge', () => {
  for (const [osmId, form] of Object.entries(LANDMARK_FORMS)) {
    const parts = splitLevels(form.levels, form.night?.crownFrom);
    assert.equal(parts.length, form.night?.crownFrom ? 2 : 1, `${osmId} cuts into ${parts.length} parts`);
    assert.deepEqual(parts[0][1].slice(0, 2), form.levels.slice(0, 2), `${osmId}'s shaft starts where the whole curve did`);
    assert.equal(parts.at(-1)[1].at(-1), form.levels.at(-1), `${osmId}'s top part ends at the top of the curve`);
    if (parts.length === 1) continue;
    const [, body] = parts[0];
    const [, crown] = parts[1];
    assert.equal(body.at(-1)[0], crown[0][0], `${osmId}: the two halves meet at one height, not across a gap`);
    assert.equal(body.at(-1)[1], crown[0][1], `${osmId}: and at one width, so the ledge is drawn once`);
    assert.equal(body.length + crown.length, form.levels.length + 1, `${osmId} loses no level to the cut`);
    assert.ok(crown.length > 1, `${osmId}'s crown has something to loft`);
    assert.ok(crown.at(-1)[0] === 1 && crown[0][0] < 1, `${osmId}'s crown is the top of the curve, not its bottom`);
  }
  // A crown fraction that names no step - or the very top - cuts nothing, so a form cannot lose its roof to a typo.
  assert.equal(splitLevels([[0, 1], [1, 1]], 0.5).length, 1, 'a two-level curve has no ledge to split at');
  assert.equal(splitLevels([[0, 1], [0.5, 0.8], [1, 0.6]], 1).length, 1, 'a crown at the very top is not a crown');
});

test('a shell carries a plumb u around its own ring, and its height for v', () => {
  for (const [osmId, form] of Object.entries(LANDMARK_FORMS)) {
    const feature = featureOf(Number(osmId));
    const ring = feature.geometry.coordinates[0];
    const base = form.kind === 'deck' ? DECK_CLEARANCE_METRES : 0;
    const height = form.kind === 'deck' ? DECK_CLEARANCE_METRES + DECK_THICKNESS_METRES : heightOf(feature);
    const geometry = loftGeometry(ring, height, form.levels, SCENE.center, form.kind === 'deck' ? { base } : {});
    const uv = geometry.getAttribute('uv');
    const position = geometry.getAttribute('position');
    assert.ok(uv, `${osmId} has no texture coordinates to hold a rhythm`);
    const ups = new Map();
    for (let vertex = 0; vertex < uv.count; vertex += 1) {
      const u = +uv.getX(vertex).toFixed(9);
      assert.ok(u >= 0 && u < 1, `${osmId}'s u ran past the seam of one trip: ${u}`);
      // v is the height in metres, so a rhythm that wants to be 30 m apart stays 30 m apart on a 530 m tower.
      assert.ok(Math.abs(uv.getY(vertex) - position.getY(vertex)) < 1e-4, `${osmId}'s v is not its own height`);
      const at = `${u}:${position.getY(vertex).toFixed(3)}`;
      ups.set(at, (ups.get(at) ?? 0) + 1);
    }
    const distinct = new Set([...ups.keys()].map((key) => key.split(':')[0]));
    assert.equal(distinct.size, sides(ring), `${osmId} reads ${distinct.size} u values around a ${sides(ring)}-sided ring`);
    // Plumb: every level stands at the same u for the same ring vertex, so a stripe is a line straight up the facade.
    assert.equal(ups.size, sides(ring) * new Set(form.levels.map(([fraction]) => fraction)).size,
      `${osmId} does not meet its own levels at one u per corner`);
    // The perimeter the repeat count is derived from is the ring's own, measured the way the geometry measures it -
    // at the level the shell starts on, because that is the ring it actually drew. 省博's table begins at 0.7 (the
    // box hangs over a recessed base), so its shell's foot is seven tenths of the snapshot's outline.
    const points = ring.slice(0, ring[0][0] === ring.at(-1)[0] ? -1 : undefined)
      .map(([lng, lat]) => plane(SCENE.center, { lng, lat }));
    let around = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i], b = points[(i + 1) % points.length];
      around += Math.hypot(b.dx - a.dx, b.dy - a.dy);
    }
    assert.ok(Math.abs(geometry.userData.perimeter - around * form.levels[0][1]) < 1e-3,
      `${osmId} reports ${geometry.userData.perimeter} m around, measured ${around.toFixed(1)} × ${form.levels[0][1]}`);
    // u runs around the ring by its own edge lengths - which side of the ring it starts on is the winding's business,
    // so the gaps are read as a set and the closing trip is the gap from the last corner back to 1.
    const gaps = points.map((point, index) => {
      const b = points[(index + 1) % points.length];
      return +(Math.hypot(b.dx - point.dx, b.dy - point.dy) / around).toFixed(9);
    }).sort((a, b) => a - b);
    const walked = [...distinct].map(Number).sort((a, b) => a - b);
    const measured = walked.slice(1).map((u, index) => u - walked[index]);
    measured.push(1 - walked.at(-1));
    // u is stored as a 32-bit float, so the gaps agree with the ring's edges to a hundred-thousandth of a trip.
    const pairs = measured.sort((a, b) => a - b);
    assert.equal(pairs.length, gaps.length, `${osmId} cut its ring into ${pairs.length} gaps, not ${gaps.length}`);
    gaps.forEach((gap, index) => assert.ok(Math.abs(pairs[index] - gap) < 1e-5,
      `${osmId}'s gap ${index} is ${pairs[index]}, the ring's is ${gap}`));
    assert.ok(walked.includes(0), `${osmId}'s ring starts its u somewhere else`);
  }
});

test('the fin strip is a plumb line, a valley, and a seam that is not a join', () => {
  const columns = 64;
  const shipped = finStrips({ columns, duty: 0.4, floor: 0.6 });
  const values = Array.from({ length: columns }, (unused, column) => shipped.image.data[column * 4]);
  assert.equal(values[0], 255, 'the middle of a fin is the lamp colour, whole');
  assert.equal(values.at(-1), values[1], 'and the ring closes on itself: the columns either side of the seam match');
  assert.equal(values[columns / 2], Math.round(255 * 0.6), 'the valley keeps the floor it was asked for');
  assert.ok(values.every((value) => value >= Math.round(255 * 0.6) - 1 && value <= 255), 'nothing leaves the two ends of the profile');
  const lit = values.filter((value) => value > (255 + Math.round(255 * 0.6)) / 2).length;
  assert.ok(Math.abs(lit / columns - 0.4) < 0.08, `duty 0.4 lit ${lit} of ${columns} columns`);
  // Monotone from the fin out to the valley, so the band has an edge and not a staircase.
  for (let i = 2; i < columns / 2; i += 1) assert.ok(values[i] <= values[i - 1] + 1, `the profile turned brighter again at column ${i}`);
  assert.equal(shipped.wrapS, THREE.RepeatWrapping, 'u runs around a ring, so it has to wrap');
  assert.equal(shipped.generateMipmaps, false, 'one row of pixels has nothing to average into a mipmap');
  assert.equal(shipped.colorSpace, THREE.NoColorSpace, 'a multiplier on the lamp colour is not a colour of its own');
  // A flatter profile is a dimmer rhythm, not a different texture size.
  assert.ok(finStrips({ columns, floor: 0.9 }).image.data[(columns / 2) * 4] > values[columns / 2]);
});

test('the scene carries no obstruction lamp anywhere - the red circles were cancelled, not dimmed', () => {
  // V6-2 built these as a sphere per tall top plus a 1.5 s flash with a 0.5 floor; the whole mechanism is gone, so the
  // tripwire is the absence of the constants as much as the absence of the meshes.
  for (const name of ['beaconFlash', 'createBeacon', 'BEACON_PHASES', 'BEACON_PERIOD_MS', 'BEACON_MIN_METRES', 'BEACON_FLOOR'])
    assert.equal(formsModule[name], undefined, `${name} is still exported, so the lamps can be rebuilt from the module`);
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  forms.setAtmosphere({ from: ATMOSPHERES.night, share: 1 });
  forms.recede(16);
  const red = forms.group.children.filter((child) => child.material?.blending === THREE.AdditiveBlending);
  assert.deepEqual(red.map((child) => child.name), [], 'an additive red fixture is back on the skyline');
});

test('the two towers wear a rhythm, and its spacing is the one the table asks for', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  for (const form of forms.forms) {
    const fins = LANDMARK_FORMS[form.osmId].night?.fins;
    for (const shell of form.shells) {
      // Each part carries its own ring at its own scale, so each one's spacing is measured on the wall it drew.
      const around = shell.mesh.geometry.userData.perimeter;
      if (!fins) {
        assert.equal(shell.material.emissiveMap, null, `${form.osmId} has no fin table and so no strip`);
        continue;
      }
      const map = shell.material.emissiveMap;
      assert.ok(map, `${form.osmId}'s ${shell.part} has no strip on it`);
      if (shell.lamp) {
        // 灯图与立面图同一条坐标轴：横向一整圈就是一趟，纵向一整趟就是这根塔高。
        assert.equal(map.repeat.x, 1, `${form.osmId} 的灯图横向又铺了一遍，窗会与立面图上的格子错开`);
        assert.ok(map.repeat.y > 0 && Math.abs(1 / map.repeat.y - form.height) < 1e-6,
          `${form.osmId} 的灯图纵向不覆盖这根 ${form.height} m 的塔`);
        const lit = map.image.data.filter((value, index) => index % 4 === 0 && value === 255).length;
        const panes = map.image.width * map.image.height;
        assert.ok(lit > 0 && lit / panes < 0.25, `${form.osmId} 的灯图亮了 ${(lit / panes * 100).toFixed(1)} % 的像素`);
        continue;
      }
      assert.ok(Number.isInteger(map.repeat.x) && map.repeat.x >= 2,
        `${form.osmId} trips its strip ${map.repeat.x} times - a whole number of trips around the ring, or none`);
      const actual = around / map.repeat.x;
      assert.ok(Math.abs(actual - fins.metres) <= fins.metres * 0.5,
        `${form.osmId} asked for ${fins.metres} m and stands at ${actual.toFixed(1)} m`);
    }
  }
});

test('the crowns breathe on periods nobody else in the scene keeps', () => {
  assert.equal(crownBreath(0), 1, 'the top of a breath is the shipped share');
  assert.ok(Math.abs(crownBreath(0.5) - 0.8) < 1e-12, 'the bottom of a breath is four fifths of it');
  const samples = Array.from({ length: 101 }, (unused, i) => crownBreath(i / 100));
  assert.ok(Math.max(...samples) <= 1 + 1e-12 && Math.min(...samples) >= 0.8 - 1e-12,
    `the breath wandered outside 0.8..1: ${Math.min(...samples)}..${Math.max(...samples)}`);
  for (let i = 1; i <= 50; i += 1) assert.ok(samples[i] <= samples[i - 1] + 1e-12, 'the crown brightened on its way down');
  for (let i = 51; i <= 100; i += 1) assert.ok(samples[i] >= samples[i - 1] - 1e-12, 'the crown dimmed on its way back up');
  assert.throws(() => crownBreath(1.4), /between 0 and 1/);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  assert.equal(gcd(...FORM_BREATH_MS.map((period) => period / 1000)), 1,
    'two crowns on periods with a common factor realign, and the axis pulses in step again');
  for (const period of FORM_BREATH_MS) {
    assert.ok(gcd(period / 1000, 9) === 1, `a ${period} ms crown shares its beat with the tower's 9 s glow`);
    assert.ok(period >= 6000 && period <= 8000, `a ${period} ms crown is not the slow breath the brief asks for`);
  }
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  forms.setAtmosphere({ from: ATMOSPHERES.night, share: 1 });
  forms.recede(16);
  const crowns = forms.forms.flatMap((form) => form.shells).filter((shell) => shell.part === 'crown');
  const shafts = forms.forms.flatMap((form) => form.shells).filter((shell) => shell.part === 'body');
  assert.ok(crowns.length >= 2, `${crowns.length} crowns is not enough to prove two periods`);
  assert.equal(new Set(crowns.map((shell) => shell.breath)).size, crowns.length, 'two crowns ride the same period');
  for (const shell of shafts) assert.equal(shell.breath, null, 'a shaft holds its share; the top of the curve breathes');
  // The clock moves the crowns and leaves the shafts alone, and 0 hands back exactly the shipped frame.
  const at = (ms) => { forms.setBreath(ms); return { crowns: crowns.map((shell) => shell.material.emissiveIntensity), shafts: shafts.map((shell) => shell.material.emissiveIntensity) }; }
  const rest = at(0);
  assert.deepEqual(rest.crowns, crowns.map((shell) => shell.share), 'cycle 0 is not the shipped share');
  const half = at(FORM_BREATH_MS[0] / 2);
  assert.ok(Math.abs(half.crowns[0] - crowns[0].share * 0.8) < 1e-9, `the first crown breathed to ${half.crowns[0]}`);
  assert.ok(Math.abs(half.crowns[1] - crowns[1].share * (0.8 + 0.2 * (0.5 + 0.5 * Math.cos((FORM_BREATH_MS[0] / 2 / FORM_BREATH_MS[1]) % 1 * Math.PI * 2)))) < 1e-9,
    'the second crown did not ride its own, different period');
  assert.deepEqual(half.shafts, rest.shafts, 'a shaft moved with the breath');
  assert.deepEqual(at(0), rest, 'the clock did not hand the shipped frame back');
});

test('the night lamps ride the walk the walls walk, and come back down on it', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  const share = () => forms.forms.flatMap((form) => form.shells
    .map((shell) => shell.material.emissiveIntensity / shareOf(form.osmId, shell.part)));
  // Nothing has been asked for yet: the scene opens on a day, and a lamp that is not lit is not lit.
  forms.recede(16);
  assert.deepEqual(share(), share().map(() => 0), 'the shipped frame has no glow to fade in');
  forms.setAtmosphere({ from: ATMOSPHERES.day, to: ATMOSPHERES.night, share: 0.5 });
  forms.recede(16);
  assert.deepEqual(share().map((value) => +value.toFixed(6)), share().map(() => 0.5), 'half-way up the walk is half the lamp');
  forms.setAtmosphere({ from: ATMOSPHERES.day, to: ATMOSPHERES.night, share: 1 });
  forms.recede(16);
  assert.deepEqual(share(), share().map(() => 1));
  // Out of the night the same curve runs backwards, and it starts from the frame the walls are on rather than from
  // the theme the walk was going to leave behind.
  forms.setAtmosphere({ from: ATMOSPHERES.night, to: ATMOSPHERES.sunset, share: 0.25 });
  forms.recede(16);
  assert.deepEqual(share().map((value) => +value.toFixed(6)), share().map(() => 0.75));
  // An interrupted walk carries on from what it was showing, which is what the walls' `resume` is for.
  forms.setAtmosphere({ from: ATMOSPHERES.night, to: ATMOSPHERES.day, share: 0.5, resume: true });
  forms.recede(16);
  const middle = share().map((value) => +value.toFixed(6));
  assert.deepEqual(middle, middle.map(() => 0.375), 'a walk abandoned mid-glow fades on from the glow it had reached');
  // The arrival is written as a share of 1, so a reduce-motion cut that never walked still ends up fully lit.
  const cut = createLandmarkForms({ features, origin: SCENE.center });
  cut.setAtmosphere({ from: ATMOSPHERES.night, share: 1 });
  cut.recede(16);
  assert.ok(cut.forms.flatMap((form) => form.shells).every((shell) => shell.material.emissiveIntensity > 0),
    'the same end frame, no frames to spend');
});

// 壳体加密与窗格。这两件事都是"只改密度与材质、不改它要画的那条轮廓"，所以判据全部对着原表量。
// 原表在同一个标高上可以有两行（那正是一条硬跳），所以那一格允许两个答案。
const curveAt = (levels, fraction) => {
  const answers = [];
  for (let index = 1; index < levels.length; index += 1) {
    const [from, fromScale] = levels[index - 1];
    const [to, toScale] = levels[index];
    if (fraction > from && fraction <= to) answers.push(fromScale + (toScale - fromScale) * (fraction - from) / (to - from));
    if (fraction === from) answers.push(fromScale);
    if (fraction === to) answers.push(toScale);
  }
  if (fraction === 0) answers.push(levels[0][1]);
  if (fraction === 1) answers.push(levels.at(-1)[1]);
  return answers;
};
const around = (points) => points.reduce((sum, point, index) => sum + distanceMeters(
  { lng: point[0], lat: point[1] },
  { lng: points[(index + 1) % points.length][0], lat: points[(index + 1) % points.length][1],
}), 0);

test('加密只加密度：角点一个不少、周长一毫米不变、每一带都在硬上限之内', () => {
  for (const [osmId, form] of Object.entries(LANDMARK_FORMS)) {
    const feature = featureOf(Number(osmId));
    const ring = feature.geometry.coordinates[0];
    const height = form.kind === 'deck' ? form.base + form.thickness : heightOf(feature);
    const outline = refineRing(ring);
    for (const corner of ring.slice(0, -1)) {
      assert.ok(outline.some((point) => point[0] === corner[0] && point[1] === corner[1]),
        `${osmId} 的角 ${corner.join(',')} 在加密后丢了，轮廓被换掉了`);
    }
    assert.ok(Math.abs(around(outline) - around(ring.slice(0, -1))) < 1,
      `${osmId} 周长从 ${around(ring.slice(0, -1)).toFixed(1)} m 变成 ${around(outline).toFixed(1)} m`);
    assert.ok(outline.length > sides(ring), `${osmId} 的环没有加密，还是 ${outline.length} 个点`);
    let longest = 0;
    for (let index = 0; index < outline.length; index += 1) {
      longest = Math.max(longest, distanceMeters({ lng: outline[index][0], lat: outline[index][1] },
        { lng: outline[(index + 1) % outline.length][0], lat: outline[(index + 1) % outline.length][1] }));
    }
    assert.ok(longest <= SHELL_FACET_METRES * 1.6, `${osmId} 加密后最长一格 ${longest.toFixed(1)} m，超过 ${SHELL_FACET_METRES} m 的余量`);

    const levels = refineLevels(form.levels, height);
    assert.equal(ledges(levels), ledges(form.levels), `${osmId} 的退台硬跳被抹平了`);
    // 跨带变宽（西塔鼓出去那两带）会被插行插出一串来，本来就该如此；不能丢的是**同一标高上**那块朝下的底。
    assert.equal(soffits(levels), soffits(form.levels), `${osmId} 的悬挑底面被插值抹平了`);
    assert.equal(levels[0][0], 0);
    assert.equal(levels.at(-1)[0], 1);
    for (const [fraction, scale] of levels) {
      const answers = curveAt(form.levels, fraction);
      assert.ok(answers.some((value) => Math.abs(scale - value) < 1e-12),
        `${osmId} 在 ${fraction} 处的宽度 ${scale} 不在原来那条曲线上（应为 ${answers.join(' 或 ')}）`);
    }
    for (let index = 1; index < levels.length; index += 1) {
      if (levels[index][0] === levels[index - 1][0]) continue;
      assert.ok((levels[index][0] - levels[index - 1][0]) * height <= SHELL_BAND_METRES + 1e-6,
        `${osmId} 第 ${index} 带高 ${(levels[index][0] - levels[index - 1][0]) * height} m，比 ${SHELL_BAND_METRES} m 粗`);
    }
    // 门槛跟着体量走：16 m 的省博本来就只有几带来分，530 m 的东塔必须走到几十带才不是一摞鼓。
    assert.ok(levels.length - 1 >= Math.max(2, Math.floor(height / (SHELL_BAND_METRES * 1.5))),
      `${osmId} 高 ${height} m 只有 ${levels.length - 1} 带，收分还是折线`);
  }
});

test('壳上的窗格是真米数，节奏仍从类别表里来', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  const meshes = forms.group.children.filter((child) => child.isMesh);
  for (const form of forms.forms) {
    const parts = meshes.filter((mesh) => mesh.name === String(form.osmId) || mesh.name === `${form.osmId}:crown`);
    assert.ok(parts.length, `${form.osmId} 没有壳体`);
    if (form.kind === 'deck') {
      for (const mesh of parts) {
        assert.equal(mesh.material[0].map, null, '桥面不该铺一栋楼的窗格');
        assert.equal(mesh.material[1].map, null, '桥的底面也不该铺窗格');
      }
      continue;
    }
    const shape = FACADE_SHAPES[FACADE_CATEGORY_SHAPES[form.category] ?? 'plain'];
    assert.notEqual(shape, undefined, `${form.osmId} 的类别 ${form.category} 认不出一格节奏`);
    for (const mesh of parts) {
      const map = mesh.material[0].map;
      assert.ok(map, `${form.osmId} 的壳没挂窗格，还是一块平板`);
      if (form.facade) {
        // 立面图是一栋塔自己的一圈 × 整根塔高，不重复，所以"一格是多少真米数"这一问换了地方：它不在 repeat 的倍数上，
        // 在一张图铺开多少米、一个像素顶多少米上。壳的 v 是标高米数（`loftGeometry`），所以 repeat.y 必须是 1/塔高，
        // 否则 0.5 m 以上全被夹到最顶那一行，整根塔身读出来是一条色带。
        assert.equal(map.wrapS, THREE.RepeatWrapping, `${form.osmId} 的立面图横向没绕回，接缝上会缺半颗菱形`);
        assert.equal(map.wrapT, THREE.ClampToEdgeWrapping, `${form.osmId} 的立面图纵向绕回了，塔顶之上没有东西可采样`);
        assert.equal(map.repeat.x, 1, `${form.osmId} 的立面图绕环又铺了一遍，一张不重复的图不该再铺`);
        assert.equal(map.repeat.y, 1 / form.height, `${form.osmId} 的立面图没按标高米数铺开`);
        assert.equal(form.facade.tall, Math.round(form.facade.height / FACADE_PIXEL_METRES),
          `${form.osmId} 的立面图一行不是一半米`);
        assert.equal(form.facade.wide, Math.round(form.facade.perimeter / FACADE_PIXEL_METRES),
          `${form.osmId} 的立面图一列不是一半米`);
        // 图的横轴是这一栋底圈自己量出来的周长，不是照别栋抄的。
        if (mesh.name === String(form.osmId)) {
          // 比的是**原始那条 OSM 轮廓**的周长，不是塔脚那一圈：省博是悬挑，脚只有 0.7 倍，
          // 网格报的是它自己那一层画出来的周长，而 u 一直是整圈的分数。
          const ring = featureOf(form.osmId).geometry.coordinates[0];
          const points = ring.slice(0, ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? -1 : undefined)
            .map(([lng, lat]) => plane(SCENE.center, { lng, lat }));
          let around = 0;
          for (let index = 0; index < points.length; index += 1) {
            const p1 = points[index];
            const p2 = points[(index + 1) % points.length];
            around += Math.hypot(p2.dx - p1.dx, p2.dy - p1.dy);
          }
          assert.ok(Math.abs(form.facade.perimeter - around) < 1,
            `${form.osmId} 的立面图按 ${form.facade.perimeter.toFixed(1)} m 一圈画的，这条轮廓量出来是 ${around.toFixed(1)} m`);
        }
        if (form.facade.lattice) {
          // 一颗菱形占满绕环的整数分之一，所以接缝上那根撑是完整的一根；它仍是这一栋点名的那一格，误差只来自"凑整数颗"。
          assert.ok(form.facade.diamonds >= 2, `${form.osmId} 的菱形不到 2 颗`);
          assert.equal(form.facade.diamond, form.facade.perimeter / form.facade.diamonds,
            `${form.osmId} 的一颗菱形不是周长的整数分之一`);
          assert.ok(Math.abs(form.facade.diamond - form.cell) / form.cell <= 0.5 / form.facade.diamonds + 1e-9,
            `${form.osmId} 的一颗菱形 ${form.facade.diamond.toFixed(2)} m，离点名的那一格 ${form.cell.toFixed(2)} m 太远`);
        }
      } else {
        assert.equal(map.repeat.y, 1 / form.cell, '一格不等于这一栋自己点名的那一格（' + form.cell.toFixed(1) + ' m）');
        assert.equal(map.repeat.x, Math.max(2, Math.round(mesh.geometry.userData.perimeter / form.cell)),
          '绕环不是整格数，接缝上会有一根柱子只有半格宽');
      }
      const position = mesh.geometry.getAttribute('position');
      const heights = new Set();
      const corners = new Set();
      for (let index = 0; index < position.count; index += 1) {
        heights.add(Math.round(position.getY(index) * 1000) / 1000);
        corners.add(`${Math.round(position.getX(index))},${Math.round(position.getZ(index))}`);
      }
      // 门槛按这一段自己有多高算：冠只有全高的零头，不能拿整栋楼的要求问它要带数。
      const span = Math.max(...[...heights]) - Math.min(...[...heights]);
      assert.ok(heights.size >= Math.max(2, Math.floor(span / (SHELL_BAND_METRES * 1.5))),
        `${mesh.name} 这一段 ${span.toFixed(0)} m 只有 ${heights.size} 个标高，收分还是折线`);
      const facets = Math.round(mesh.geometry.userData.perimeter / SHELL_FACET_METRES);
      assert.ok(corners.size >= Math.min(facets, Math.max(24, Math.round(facets * 0.6))),
        `${form.osmId} 一圈只有 ${corners.size} 个位置（周长 ${Math.round(mesh.geometry.userData.perimeter)} m），侧面还是多面鼓`);
    }
  }
});

test('壳上的层高是快照自己算的，格子尺度落在街区那一格上', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  let measured = 0;
  for (const form of forms.forms) {
    if (form.kind === 'deck') {
      assert.equal(form.cell, null, '桥面没有窗格，也就不该有一个格距');
      continue;
    }
    const levels = Number(featureOf(form.osmId).properties.levels);
    if (levels > 0) {
      assert.ok(Math.abs(form.storey - form.height / levels) < 1e-9, `${form.osmId} 的层高不是 高度 ÷ 层数`);
      measured += 1;
    } else {
      assert.equal(form.storey, SHELL_STOREY_METRES, `${form.osmId} 没有层数，该回落到常量而不是猜一个`);
    }
    // 只有点名了斜撑的那一栋允许换格，而且换的是"一颗菱形占满一格"，不是随手一个尺度。
    if (LANDMARK_FORMS[form.osmId].diagrid) {
      assert.equal(form.cell, form.storey * LANDMARK_FORMS[form.osmId].diagrid.storeys,
        `${form.osmId} 的一格不等于一颗菱形（${LANDMARK_FORMS[form.osmId].diagrid.storeys} 层）`);
    } else {
      assert.equal(form.cell, FACADE_CELL_METRES, `${form.osmId} 的一格没落在街区那一格上`);
    }
    assert.equal(form.rows, Math.round(form.cell / form.storey), `${form.osmId} 的一格里没装整层数`);
    // 一带就是一层，误差只能来自"把一格切成整数层"这一步，上限就是半层除以层数。塔不比街区粗一倍也不比它细一倍，
    // 才是同一座城市；差得多，就是两栋塔穿着布料、城市穿着网格。
    assert.ok(Math.abs(form.band - form.storey) / form.storey <= 0.5 / form.rows + 1e-9,
      `${form.osmId} 的一带 ${form.band.toFixed(2)} m，和真层高 ${form.storey.toFixed(2)} m 差得超过了半层`);
  }
  assert.ok(measured >= 2, '没有两栋楼带上快照层数，这条测试什么都没量到');
  // 点名两个数：快照里这两栋的层数一改，这里要响。
  assert.equal(forms.forms.find((form) => form.osmId === 184738716).storey, 440.2 / 103);
  assert.equal(forms.forms.find((form) => form.osmId === 511404889).storey, 530 / 111);
  assert.equal(shellStoreyMetres({ properties: {} }, 100), SHELL_STOREY_METRES, '没有层数时不该猜一个');
  // 西塔那一颗菱形：12 层 × 4.274 m = 51.3 m，事务所那句写的是 54 m，差 5% 以内，取整层数这一档。
  const west = forms.forms.find((form) => form.osmId === 184738716);
  assert.ok(Math.abs(west.cell - 54) / 54 < 0.06, `一颗菱形 ${west.cell.toFixed(1)} m，离稿子里那句 54 m 超过 6%`);
  assert.equal(west.rows, DIAGRID_STOREYS, '一颗菱形里装的层数不是点名的那个数');
  assert.deepEqual(shellGridScale(440.2 / 103, FACADE_SHAPES.curtain, { storeys: DIAGRID_STOREYS }),
    { storey: 440.2 / 103, rows: 12, columns: 7, band: 440.2 / 103, cell: (440.2 / 103) * 12, size: 168,
      rib: { metres: DIAGRID_RIB_METRES, period: (440.2 / 103) * 12 } },
    '一颗菱形该是 12 层 × 7 个开间，横竖同一个周期，斜撑才在接缝上接得上');
  assert.deepEqual(shellGridScale(440.2 / 103, FACADE_SHAPES.curtain),
    { storey: 440.2 / 103, rows: 7, columns: 4, band: FACADE_CELL_METRES / 7, cell: FACADE_CELL_METRES, size: 56, rib: null },
    '没有斜撑的那一格该切成 7 层、每格 4 个开间');
});

test('斜撑是同一张图里的两组 45° 线，周期等于一颗菱形，绕环与向上都接得上', () => {
  const scale = shellGridScale(440.2 / 103, FACADE_SHAPES.curtain, { storeys: DIAGRID_STOREYS });
  const texture = shellGridTexture({ ...FACADE_SHAPES.curtain, rows: scale.rows, columns: scale.columns, size: scale.size, rib: scale.rib });
  const data = texture.image.data;
  const size = Math.sqrt(data.length / 4);
  const at = (x, y) => data[(y * size + x) * 4];
  assert.equal(size, scale.size, '一张图的像素数不等于它自己算出来的那个');
  // 两条对角线族：x−y ≡ 0 与 x+y ≡ 0（mod size）。第二条必须从左边绕回顶边，接缝上才不断根。
  for (let y = 0; y < size; y += 1) {
    assert.equal(at(y, y), 255, `第 ${y} 行上 x=y 处不是撑，斜线断了`);
    assert.equal(at((size - y) % size, y), 255, `第 ${y} 行上 x+y≡0 处不是撑，绕环那一边接不上`);
  }
  // 菱形中间必须是空的，否则整张图全白，等于没有窗格。
  const mid = Math.round(size / 4);
  assert.ok(at(mid, 0) < 255 || at(0, mid) < 255, '斜撑铺满了整张图');
  let white = 0;
  for (let i = 0; i < data.length; i += 4) white += data[i] === 255 ? 1 : 0;
  const share = white / (size * size);
  assert.ok(share > 0.15 && share < 0.85, `撑与竖框占了 ${(share * 100).toFixed(0)}%，玻璃读不出来了`);
  // 撑是"切过玻璃"才看得见的那道白：同一张图不挂斜撑时，对角线上总有玻璃，挂了之后那些点必须全变白。
  const bare = shellGridTexture({ ...FACADE_SHAPES.curtain, rows: scale.rows, columns: scale.columns, size: scale.size });
  const bareData = bare.image.data;
  const bareAt = (x, y) => bareData[(y * size + x) * 4];
  let glassOnLine = 0;
  for (let y = 0; y < size; y += 1) {
    if (bareAt(y, y) < 255) {
      glassOnLine += 1;
      assert.equal(at(y, y), 255, `第 ${y} 行对角线上本来是玻璃，挂了斜撑却没被切开`);
    }
  }
  assert.ok(glassOnLine > size / 4, `对角线上只有 ${glassOnLine} 处本来是玻璃，这张图的竖框快铺满了`);
  // 周期必须正好是一颗菱形。这一发单独量它：把窗格关掉（整张图都是玻璃），斜线就成了唯一会白的东西，
  // 每行两组线的中心必须落在 x ≡ y 与 x ≡ −y（mod size）上——写成半颗会多出一对，写成两颗会少一半。
  const lattice = shellGridTexture({ paneYShare: 1, paneXShare: 1, glass: 0.4, size: scale.size, rib: scale.rib });
  const latticeData = lattice.image.data;
  const size2 = Math.sqrt(latticeData.length / 4);
  assert.equal(size2, size, '关掉窗格之后那张图的尺寸变了，说明它跟窗格不是同一套参数');
  for (const y of [0, 7, 42, Math.round(size / 2), 123]) {
    const white = (x) => latticeData[(y * size + x) * 4] === 255;
    const centres = [];
    for (let x = 0; x < size; x += 1) {
      if (!white(x) || white((x - 1 + size) % size)) continue;
      let span = 0;
      while (white((x + span) % size) && span < size) span += 1;
      centres.push((x + Math.floor(span / 2)) % size);
    }
    const want = [...new Set([y % size, (size - y) % size])].sort((a, b) => a - b);
    assert.deepEqual(centres.sort((a, b) => a - b), want, `第 ${y} 行的斜线在 ${centres}，该在 ${want}（一颗菱形的周期）`);
  }
});


test('裙房是同一圈轮廓放大出来的，且和塔身共用一格', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  const meshOf = (name) => forms.group.children.find((child) => child.name === name);
  let withPodium = 0;
  for (const form of forms.forms) {
    const podium = form.shells.filter((shell) => shell.part === 'podium');
    const table = LANDMARK_FORMS[form.osmId].podium;
    if (!table) {
      assert.equal(podium.length, 0, `${form.osmId} 没点名裙房，不该凭空多出一圈`);
      continue;
    }
    withPodium += 1;
    assert.equal(podium.length, 1, `${form.osmId} 的裙房该恰好一圈`);
    const mesh = meshOf(`${form.osmId}:podium`);
    assert.ok(mesh, `${form.osmId} 的裙房没进场景`);
    const box = new THREE.Box3().setFromObject(mesh);
    assert.ok(Math.abs(box.max.y - table.metres) < 1e-3,
      `${form.osmId} 的裙房顶在 ${box.max.y.toFixed(2)} m，不在点名的 ${table.metres} m 上`);
    assert.equal(box.min.y, 0, `${form.osmId} 的裙房没坐在地上`);
    // 外扩是绕轮廓自己的中心放的，所以它的水平尺寸就是塔身尺寸的比值倍——不是另一个面。
    // 比的是塔脚那一圈（=实测轮廓），不是塔身整体包围盒：西塔最宽的一圈在 1/3 高度，拿它比会把外扩算少。
    const foot = meshOf(String(form.osmId)).geometry.getAttribute('position');
    const extent = (axis) => {
      const at = axis === 'x' ? 0 : 2;
      let low = Infinity;
      let high = -Infinity;
      for (let index = 0; index < foot.count; index += 1) {
        if (foot.getY(index) > 1e-6) continue;
        low = Math.min(low, foot.getComponent(index, at));
        high = Math.max(high, foot.getComponent(index, at));
      }
      return high - low;
    };
    for (const axis of ['x', 'z']) {
      const wide = box.max[axis] - box.min[axis];
      const own = extent(axis);
      assert.ok(Math.abs(wide / own - table.spread) < 0.02,
        `${form.osmId} 的裙房在 ${axis} 上外扩了 ${(wide / own).toFixed(3)} 倍，不是 ${table.spread} 倍`);
    }
    // 一格和塔身同一尺度，读起来才是一栋楼；绕自己这圈周长走整格数，接缝上不缺半根柱子。
    const map = mesh.material[0].map;
    assert.equal(map.repeat.y, 1 / FACADE_CELL_METRES, `${form.osmId} 的裙房和塔身不在一格上`);
    assert.equal(map.repeat.x, Math.max(2, Math.round(mesh.geometry.userData.perimeter / FACADE_CELL_METRES)),
      `${form.osmId} 的裙房绕圈不是整格数`);
    // 塔身穿的是不重复的立面图，裙房穿的是重复窗格，两者的 repeat.x 已经不是同一种数，所以外扩生效要直接量圈。
    assert.ok(mesh.geometry.userData.perimeter > meshOf(String(form.osmId)).geometry.userData.perimeter,
      `${form.osmId} 的裙房比塔身还窄，外扩没生效`);
  }
  assert.equal(withPodium, 2, '该恰好两栋塔有裙房（省博本身就是个悬挑的盒子，桥没有底座）');
});

test('窗格贴图是乘性的一层：柱子是白的，玻璃按比例压暗', () => {
  const shape = FACADE_SHAPES.curtain;
  const texture = shellGridTexture(shape);
  const data = texture.image.data;
  const size = Math.sqrt(data.length / 4);
  let glass = 0;
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i], data[i + 1]);
    assert.equal(data[i + 1], data[i + 2]);
    assert.equal(data[i + 3], 255, '一格半透明就会把底下的墙面色混进来');
    seen.add(data[i]);
    if (data[i] < 255) glass += 1;
  }
  assert.ok(seen.has(255), '没有纯白的柱子，等于整面墙被压暗');
  assert.equal(seen.size, 2, '一格只有"玻璃/柱子"两级，出现第三级就是有人在画阴影');
  const share = glass / (size * size);
  assert.ok(Math.abs(share - shape.paneYShare * shape.paneXShare) < 0.02,
    `玻璃占 ${share.toFixed(3)}，表里要的是 ${(shape.paneYShare * shape.paneXShare).toFixed(3)}`);
  assert.equal(texture.wrapS, THREE.RepeatWrapping);
  assert.equal(texture.wrapT, THREE.RepeatWrapping);
  assert.equal(texture.colorSpace, THREE.NoColorSpace, '乘性贴图走色彩空间会被再转换一次');
});

test('海心桥的拱挂在量出来的跨径线上，不是手放的', async () => {
  const bridge = await import('../src/bridge-form.js');
  const feature = featureOf(1313608038);
  const chord = bridge.crossingChord(feature.geometry.coordinates[0], SCENE.center);
  const deck = feature.geometry.coordinates[0];
  // 跨径线的每一个采样点都必须在轮廓里——这正是它区别于"bbox 对角线"的地方。
  // 两端点本来就在轮廓上，射线法对边界点是掷硬币；判据与 crossingChord 用同一口径，只问内部采样点。
  for (const station of chord.stations.slice(1, -1)) {
    const ring = deck.map(([lng, lat]) => { const p = plane(SCENE.center, { lng, lat }); return [p.dx, p.dy]; });
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > station.y) !== (yj > station.y) && station.x < ((xj - xi) * (station.y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    assert.ok(inside, `跨径线站 ${station.x.toFixed(0)},${station.y.toFixed(0)} 跑到轮廓外了`);
  }
  // 轮廓的包围盒对角线比跨径长得多（L 形），所以"最长内连线"必须明显短于它，否则就是又去拿了对角线。
  const box = (() => {
    const pts = deck.map(([lng, lat]) => plane(SCENE.center, { lng, lat }));
    const xs = pts.map((p) => p.dx);
    const ys = pts.map((p) => p.dy);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  })();
  assert.ok(chord.length < box * 0.75, `跨径 ${Math.round(chord.length)} m 对包围盒对角线 ${Math.round(box)} m，不像"内部"最长线`);
  assert.ok(chord.length > 120, `跨径只有 ${Math.round(chord.length)} m，主跨量丢了`);

  const forms = createLandmarkForms({ features, origin: SCENE.center });
  const deckForm = forms.forms.find((form) => form.osmId === 1313608038);
  assert.equal(deckForm.structure.hangers, 14, '吊杆道数不是常数那 14 道');
  assert.ok(Math.abs(deckForm.structure.span - Math.round(chord.length)) < 1, '卡片里的跨径与量出来的不是同一个数');
  const rib = forms.group.children.find((child) => child.name === '1313608038:rib');
  rib.geometry.computeBoundingBox();
  const top = DECK_CLEARANCE_METRES + DECK_THICKNESS_METRES;
  assert.ok(rib.geometry.boundingBox.max.y > top + bridge.ARCH_RISE_METRES - 6,
    `肋顶 ${rib.geometry.boundingBox.max.y.toFixed(0)} m，没拱到示意拱高 ${bridge.ARCH_RISE_METRES} m`);
  assert.ok(rib.geometry.boundingBox.min.y > DECK_CLEARANCE_METRES - 0.5, '肋低到桥面底下去了');
  const abutment = forms.group.children.find((child) => child.name === '1313608038:abutment');
  abutment.geometry.computeBoundingBox();
  assert.equal(Math.round(abutment.geometry.boundingBox.min.y), 0, '桥台没落到地面');
  assert.equal(Math.round(abutment.geometry.boundingBox.max.y), DECK_CLEARANCE_METRES, '桥台顶到了桥面底，不多不少');
});

import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { DEFAULT_CENTER } from './config.js';
import { ATMOSPHERES } from './atmosphere.js';
import { LANDMARK_FORMS } from './landmark-forms.js';
import { PLAZA_SURFACE_MIN_ZOOM } from './plaza-surface.js';
import { plane } from './geo.js';

// The top of the mast, which is also where the aviation lamp sits. The silhouette's lattice stops at 450 m and the
// mast carries on above it; 600 m is the number the model is built to.
const MAST_TOP_METRES = 600;

export function towerPoint(t, angle) {
  const twist = Math.PI * 0.76;
  return new THREE.Vector3(
    (1 - t) * 42 * Math.cos(angle) + t * 31 * Math.cos(angle + twist),
    t * 450,
    (1 - t) * 33 * Math.sin(angle) + t * 26 * Math.sin(angle + twist),
  );
}

function beams(segments, radius, material) {
  const geometry = new THREE.CylinderGeometry(radius, radius, 1, 5);
  const mesh = new THREE.InstancedMesh(geometry, material, segments.length);
  const up = new THREE.Vector3(0, 1, 0);
  const transform = new THREE.Object3D();
  segments.forEach(([a, b], index) => {
    const direction = b.clone().sub(a);
    transform.position.copy(a).add(b).multiplyScalar(0.5);
    transform.quaternion.setFromUnitVectors(up, direction.clone().normalize());
    transform.scale.set(1, direction.length(), 1);
    transform.updateMatrix();
    mesh.setMatrixAt(index, transform.matrix);
  });
  mesh.frustumCulled = false;
  return mesh;
}

// The lattice does not glow evenly. An even green over 450 m of grid is what put the tower's shaft above its own crown
// in the night budget (measured: luma 103.6 median against 113 for the crowns, with the waist carrying most of the
// pixels), and the brief asks for a dark waist with lit ends instead. The beams are instanced - all 24 columns share
// one cylinder geometry - so a gradient cannot be baked into vertex attributes; it goes into the material's emissive
// term and reads the instance's own height. That costs no geometry and no extra material, and it cannot move the day
// silhouette: a day emissive of zero times any ladder is still zero.
export const TOWER_LADDER = [[0, 1], [0.45, 0.4], [1, 1]];

/**
 * Where the lattice's glow stands at one point up the tower.
 *
 * @param {number} fraction 0 at the foot, 1 at the top of the mast
 */
export function towerLadder(fraction) {
  const at = Math.min(1, Math.max(0, fraction));
  for (let index = 1; index < TOWER_LADDER.length; index++) {
    const [high, highValue] = TOWER_LADDER[index];
    if (at <= high) {
      const [low, lowValue] = TOWER_LADDER[index - 1];
      return low === high ? highValue : lowValue + (highValue - lowValue) * (at - low) / (high - low);
    }
  }
  return TOWER_LADDER.at(-1)[1];
}

const LADDER_STEPS = 64;

// The curve reaches the GPU as a one-row texture rather than as hand-written GLSL, so `towerLadder` stays the only
// place the waist is defined - and a Node test can read the same numbers the shader samples.
function ladderTexture() {
  const data = new Uint8Array(LADDER_STEPS * 4);
  for (let step = 0; step < LADDER_STEPS; step++) {
    const value = Math.round(towerLadder(step / (LADDER_STEPS - 1)) * 255);
    data[step * 4] = value;
    data[step * 4 + 1] = value;
    data[step * 4 + 2] = value;
    data[step * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, LADDER_STEPS, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Scale one lattice material's emissive by the height ladder.
 *
 * @param {THREE.Material} material a `MeshStandardMaterial` already carrying an emissive channel
 * @param {number} topMetres the height the ladder's far stop sits at
 */
function ladderGlow(material, topMetres) {
  const map = ladderTexture();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLadderMap = { value: map };
    shader.uniforms.uLadderTop = { value: topMetres };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLadderHeight;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 ladderPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          ladderPosition = instanceMatrix * ladderPosition;
        #endif
        vLadderHeight = ( modelMatrix * ladderPosition ).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLadderHeight;\nuniform sampler2D uLadderMap;\nuniform float uLadderTop;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= texture2D( uLadderMap, vec2( clamp( vLadderHeight / uLadderTop, 0.0, 1.0 ), 0.5 ) ).r;`);
  };
  // Without a key of its own the renderer can hand this material a program compiled for the unpatched source.
  material.customProgramCacheKey = () => `tower-ladder-${topMetres}`;
  material.ladderMap = map;
  return material;
}

export function createTowerModel() {
  const group = new THREE.Group();
  const silver = ladderGlow(new THREE.MeshStandardMaterial({ name: 'silver', color: '#d4dfe0', roughness: 0.65, metalness: 0.25 }), MAST_TOP_METRES);
  const pale = ladderGlow(new THREE.MeshStandardMaterial({ name: 'pale', color: '#e7ece9', roughness: 0.6, metalness: 0.2 }), MAST_TOP_METRES);
  const diagonal = ladderGlow(new THREE.MeshStandardMaterial({ name: 'diagonal', color: '#8da5ad', roughness: 0.75, metalness: 0.15 }), MAST_TOP_METRES);
  const glass = new THREE.MeshStandardMaterial({ name: 'glass', color: '#72949c', roughness: 0.45, metalness: 0.3 });
  const warm = new THREE.MeshStandardMaterial({ name: 'warm', color: '#d9a669', roughness: 0.55, metalness: 0.2 });
  const columns = [], rings = [], braces = [];
  for (let column = 0; column < 24; column++) {
    const angle = column / 24 * Math.PI * 2;
    columns.push([towerPoint(0, angle), towerPoint(1, angle)]);
    for (let floor = 0; floor < 44; floor++) {
      braces.push([towerPoint(floor / 44, angle), towerPoint((floor + 1) / 44, angle + Math.PI * 2 / 24)]);
    }
  }
  for (let floor = 0; floor <= 44; floor++) {
    for (let side = 0; side < 72; side++) {
      rings.push([towerPoint(floor / 44, side / 72 * Math.PI * 2), towerPoint(floor / 44, (side + 1) / 72 * Math.PI * 2)]);
    }
  }
  group.add(beams(columns, 1.35, silver), beams(rings, 0.58, pale), beams(braces, 0.38, diagonal));
  const core = new THREE.Mesh(new THREE.CylinderGeometry(9, 12, 440, 32), glass);
  core.position.y = 225;
  group.add(core);
  const profile = [];
  for (let i = 0; i <= 18; i++) {
    const t = 0.76 + i / 18 * 0.22;
    const p = towerPoint(t, 0);
    profile.push(new THREE.Vector2(Math.hypot(p.x, p.z) * 0.82, p.y));
  }
  group.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 48), glass));
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(26, 24, 5, 64), warm);
  crown.position.y = 450;
  group.add(crown);
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(28, 27, 3, 64), pale);
  deck.position.y = 443;
  group.add(deck);
  for (const [bottom, top, radius, material] of [[453, 490, 5, silver], [490, 535, 3.1, pale], [535, 575, 1.9, warm], [575, 600, 0.7, silver]]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.75, radius, top - bottom, 12), material);
    mast.position.y = (top + bottom) / 2;
    group.add(mast);
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(42, 46, 5, 64), pale);
  base.scale.z = 0.8;
  base.position.y = 2.5;
  group.add(base);
  group.traverse((object) => { object.frustumCulled = false; });
  return group;
}

// Only the emissive materials are the tower's own lighting. The beam over the mast lives beside the model rather than
// inside it - it is not part of a 600 m silhouette - and it has no emissive channel, so this is what keeps it out of
// every walk over the tower.
const emissiveMaterials = (model) => {
  const materials = new Set();
  model.traverse((object) => { if (object.material?.emissive) materials.add(object.material); });
  return materials;
};

export function applyTowerAtmosphere(model, preset) {
  const materials = emissiveMaterials(model);
  for (const material of materials) {
    material.color.set(preset.colors[material.name]);
    const [color, intensity] = preset.emission[material.name];
    material.emissive.set(color);
    material.emissiveIntensity = intensity;
  }
}

// The atmosphere presets already hand every tower material an emissive baseline, so a breath scales those baselines
// between this floor and 100% of themselves rather than switching on a light the preset never declared. Daylight
// baselines are all zero, which means the same pulse is invisible at noon by construction: the tower does not light up
// a sunny afternoon, and no cycle here can be read as the building being open or occupied.
export const TOWER_GLOW_FLOOR = 0.55;

/**
 * Where a breath cycle has reached, as the 0..1 glow amount the materials scale by.
 *
 * @param {number} cycle position in the cycle, 0..1; 0 and 1 are the same dimmed point, so a clock can wrap.
 */
export function towerBreath(cycle) {
  if (!(cycle >= 0 && cycle <= 1)) throw new Error(`tower breath needs a cycle between 0 and 1: ${cycle}`);
  return 0.5 - 0.5 * Math.cos(cycle * Math.PI * 2);
}

/** One material's intensity at one point in the breath, derived from the atmosphere's own baseline. */
export function towerGlow(baseline, amount) {
  if (!(baseline >= 0)) throw new Error(`a baseline emission cannot be negative: ${baseline}`);
  if (!(amount >= 0 && amount <= 1)) throw new Error(`tower glow needs an amount between 0 and 1: ${amount}`);
  if (!baseline) return 0;
  // Anchored at the top so that amount 1 is the baseline bit for bit: turning the loop off has to hand back exactly the
  // frame the atmosphere shipped with, not a rounding of it.
  return baseline * (1 - (1 - TOWER_GLOW_FLOOR) * (1 - amount));
}

export function applyTowerPulse(model, preset, amount, scale = 1) {
  const materials = emissiveMaterials(model);
  for (const material of materials) {
    const entry = preset.emission[material.name];
    if (!entry) continue;
    // `scale` sits outside `towerGlow` on purpose: the floor inside it is the breath's own contract (a show that never
    // fully darkens), while a scheme switch needs to be able to take the emission all the way down.
    material.emissiveIntensity = towerGlow(entry[1], amount) * scale;
  }
}

/**
 * A feature's own outline ring, whether the snapshot stored the way as a polygon or swept it into a multipolygon.
 * Used for the shells' footprints, which is where each tower's band is measured from.
 */
export function outlineRing(feature) {
  const geometry = feature?.geometry;
  const ring = geometry?.type === 'Polygon' ? geometry.coordinates[0] : geometry?.type === 'MultiPolygon' ? geometry.coordinates[0]?.[0] : null;
  return ring?.length > 3 ? ring : null;
}

// How far a band reaches across the water. Not a guess: with the centre on the measured channel and the edges at the
// shipped 90 m width, every one of the three bands sat on drawn water for all 21 axis samples at 200 m, at all three
// cameras, while 260 m started putting samples on the bank (two of the three leaked 2-3 points). The channel there is
// about 240 m wide, so this is the band lying inside the river rather than across it.
export const SPILL_REACH_METRES = 200;

/**
 * The stretch of river this scene looks out onto, slid along its own bank to the tower that is asking.
 *
 * OSM draws 珠江 as a centre line, so the point is measured rather than placed: the foot of the perpendicular from the
 * scene's own centre - which is where 广州塔 stands - onto that line, with the tangent of the segment carrying it. The
 * next tower down the bank gets that same point slid along the tangent by however far its own foot lies down-channel,
 * and its band then runs from that foot out to the water, which is the direction its light travels. Measured against the
 * alternative: each shell's *own* nearest point on the line falls in the north channel, at (113.3203, 23.1152) and
 * (113.3179, 23.1152), where the basemap draws water for only 11 of the 24 samples along the axis - a hundred-odd metres
 * of creek with promenade on both sides. The main channel is what the two towers actually face at night, so that is what
 * their spill is laid on.
 *
 * @param {number[][][]} lines the river's polylines, as `[lng, lat]` arrays.
 * @param {number[]} target the tower's own foot, as `[lng, lat]`.
 * @returns {object|null} the axis `createGlowBand` wants, or null when there is no line to measure.
 */
export function channelCrossing(lines, target, reach = SPILL_REACH_METRES) {
  let best = null;
  for (const line of lines ?? []) {
    for (let index = 1; index < line.length; index++) {
      const a = plane(DEFAULT_CENTER, { lng: line[index - 1][0], lat: line[index - 1][1] });
      const b = plane(DEFAULT_CENTER, { lng: line[index][0], lat: line[index][1] });
      const dx = b.dx - a.dx, dy = b.dy - a.dy;
      const squared = dx * dx + dy * dy;
      if (!squared) continue;
      const along = Math.max(0, Math.min(1, -(a.dx * dx + a.dy * dy) / squared));
      const foot = { dx: a.dx + dx * along, dy: a.dy + dy * along };
      const distance = Math.hypot(foot.dx, foot.dy);
      if (!best || distance < best.distance) best = { distance, foot, tx: dx / Math.sqrt(squared), ty: dy / Math.sqrt(squared) };
    }
  }
  if (!best) return null;
  const from = plane(DEFAULT_CENTER, { lng: target[0], lat: target[1] });
  const shift = from.dx * best.tx + from.dy * best.ty;
  const centre = { dx: best.foot.dx + best.tx * shift, dy: best.foot.dy + best.ty * shift };
  // The scene's frame is x east, z south; the plane's dy runs north.
  const spill = { x: centre.dx - from.dx, z: from.dy - centre.dy };
  const out = Math.hypot(spill.x, spill.z);
  if (!(out > 0)) return null;
  return { ux: spill.x / out, uz: spill.z / out, cx: centre.dx, cz: -centre.dy, from: Math.round(out - reach / 2), length: reach };
}

/**
 * A tower's own light on the water off its bank: a drawn band laid across the channel, brightest at the end near the
 * tower and gone by the far one.
 *
 * It is 示意 in the same register as the beam over the mast - no OSM element carries it - and it is here because the
 * brightest object in the frame with a dead flat surface under it does not read as a river at night. V7's band-10 item
 * asks for one per tower, so the three towers on the axis each get a band in their own lamp colour.
 */
export function createGlowBand({ axis, width = 90, colour = '#c9a4ff', alpha = 0.55 } = {}) {
  const steps = 32;
  const data = new Uint8Array(steps * steps * 4);
  // Where the band reaches full strength, as a fraction of its own length from the near end. The shoreline is not
  // straight, so a band that starts at full width and full light ends with a cut across the water; it comes in on a
  // ramp instead, and the profile below is divided by its own peak so the ramp costs no brightness.
  const ramp = 0.16;
  const profile = (t) => Math.min(1, t / ramp) * (1 - t) ** 2;
  for (let v = 0; v < steps; v += 1) {
    // Squared so the band holds its light near the bank and lets go toward the far side, rather than ending in a line.
    const along = profile(v / (steps - 1)) / profile(ramp);
    for (let u = 0; u < steps; u += 1) {
      // And both long edges feather out across most of the width, or a quad of light on water reads as a painted card.
      const across = (1 - Math.abs(2 * (u / (steps - 1)) - 1) ** 2) ** 1.4;
      data.set([255, 255, 255, Math.round(255 * along * across)], (v * steps + u) * 4);
    }
  }
  const map = new THREE.DataTexture(data, steps, steps, THREE.RGBAFormat);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  const geometry = new THREE.PlaneGeometry(width, axis.length);
  // Lay the plane on the water, turn its length onto the crossing axis, then stand it out from the bank.
  geometry.rotateX(-Math.PI / 2);
  geometry.rotateY(Math.atan2(-axis.ux, -axis.uz));
  geometry.translate(axis.cx, 1.5, axis.cz);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    map, color: colour, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  mesh.name = 'river-glow';
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, material: mesh.material, alpha };
}

// How bright a shell's own spill is against the tower's. The two shafts are on band 7 of the night budget on purpose -
// V7 put them there because they were the brightest buildings on the axis for no reason but their own emissive - so what
// reaches the water from them has to sit under what reaches it from 广州塔, whose band is the picture's protagonist. At
// three fifths of the tower's 0.55 they did not: measured at the hero camera in a 37x21 box on each band's own centre,
// with motion off, the tower lifted the river from 28.6 to 52.6 and the east tower lifted its own patch from 29.5 to
// 51.0 - a tie. Two fifths lands the shells at 44.6, which is +15 against the tower's +24, and all three still read.
export const SHELL_SPILL_ALPHA = 0.24;

export function createTowerLayer(forms, nearField, river = [], greenery = null, ground = null, bases = null) {
  let renderer, scene, camera, modelMatrix, model, beam, hemisphere, light, mapRef, preset, band;
  let spills = [], formsVisible = true;
  const nearGroups = nearField?.groups ?? [];
  // The plaza's ground decal is on the picture when the camera is close enough for a 1.2 m joint to reach a pixel, and
  // off whenever the height lens has taken the buildings back - it is the same kind of guest as the trees.
  let groundOn = true;
  const paintGround = (zoom) => {
    if (ground) ground.visible = groundOn && zoom >= PLAZA_SURFACE_MIN_ZOOM;
  };
  let night = 0;
  // Steady on purpose. The bands used to sway 14 % on the breath clock, which made "stopping hands the shipped frame
  // back" depend on where the clock had got to - two byte-comparison tests caught that the moment the bands moved onto
  // the river the frame is looking at - and a spill that pulses is a lamp, which is the one thing V6 said this is not.
  const paintBand = () => {
    if (band) {
      band.material.opacity = band.alpha * night;
      band.mesh.visible = night > 0;
    }
    // A shell's band belongs to its shell: the height lens takes the extrusions back, and a patch of coloured water left
    // behind by a building that is no longer drawn is a smear over the survey.
    for (const spill of spills) {
      spill.material.opacity = spill.alpha * night;
      spill.mesh.visible = night > 0 && formsVisible;
    }
  };
  return {
    id: 'canton-tower', type: 'custom', renderingMode: '3d',
    setAtmosphere(next) {
      preset = next;
      applyTowerAtmosphere(model, next);
      // The band on the water is the tower's own light spilling, so it takes the tower's own night colour.
      if (band) band.material.color.set(next.emission.pale?.[0] ?? next.colors.pale);
      hemisphere.color.set(next.hemisphere[0]);
      hemisphere.groundColor.set(next.hemisphere[1]);
      hemisphere.intensity = next.hemisphere[2];
      light.color.set(next.directional[0]);
      light.intensity = next.directional[1];
      light.position.set(...next.position);
      mapRef.triggerRepaint();
    },
    // Amount 1 is the preset's own baseline, so handing the tower back means the lighting is byte-for-byte what an
    // atmosphere switch would have set with no motion at all.
    setPulse(amount, scale = 1) {
      applyTowerPulse(model, preset, amount, scale);
      mapRef.triggerRepaint();
    },
    setHue(shift, scheme) {
      applyTowerHue(model, preset, shift, scheme);
      mapRef.triggerRepaint();
    },
    // What the three bands are showing on this frame. The pixels prove they reach the river; this is what proves the
    // theme hands them back on a page where nothing is ticking.
    spillState() {
      return [band, ...spills].filter(Boolean).map(({ mesh, material }) => ({
        name: mesh.name,
        visible: mesh.visible,
        opacity: Math.round(material.opacity * 100) / 100,
      }));
    },
    // The beam is a light in the sky, not a colour on the lattice: only the night theme asks for it, and it is the one
    // thing here that has no OSM element behind it, so it is called out as 示意 wherever the tower is described.
    setBeam(on) {
      beam.visible = Boolean(on);
      mapRef.triggerRepaint();
    },
    // The landmark shells take the same theme pair, reveal number and walk share the extrusions are being blended
    // between; what they do with it is on the next line of `render`, because a shell has to read the camera too.
    setForms(options) {
      forms?.setAtmosphere(options);
      mapRef?.triggerRepaint();
    },
    // The crowns breathe on their own periods, which are the forms' business; the tower's glow already walks on the
    // atmosphere preset, so this only carries the elapsed clock across.
    setBreath(ms) {
      forms?.setBreath(ms);
      mapRef?.triggerRepaint();
    },
    // The height lens colours walls to read a number off them, and a shaped shell has no single wall height to read,
    // so the lens takes the extrusions back and these step out.
    showForms(on) {
      formsVisible = Boolean(on);
      forms?.setVisible(on);
      paintBand();
      mapRef?.triggerRepaint();
    },
    // The near-field traffic is the same kind of guest as the shells: separate objects in the tower's metre frame, and
    // nothing to do with its own lighting, so the atmosphere walks and the hue cycle never reach them.
    // Since the vehicles and the walkers became models rather than glow points, the field is on the picture in every
    // mode - a car in daylight is a car, not a light - so the two switches are separate: the lens that hides the
    // buildings hides the field with them, and only the lamps follow the night.
    // 车、人、船都在 `nearField` 那一个口令后面（见 `src/near-field.js`），所以这里不再有"第二个客人忘了带"的位置。
    setTraffic(on) {
      nearField?.setVisible(on);
      mapRef?.triggerRepaint();
    },
    // 判据看的那一眼：现版这一侧的近场里到底挂了哪些网格、各多少台。装配是共用的，
    // 但"挂进场景"这一步两条路径各写一次，所以这一格必须能在页面上读到才结得了账。
    // 灯那三层是挂在车流组里的**子组**，所以要一路往下走，不能只看一层孩子。
    trafficParts: () => nearGroups.flatMap((group) => {
      const rows = [];
      group.traverse((child) => {
        if (child === group) return;
        rows.push(`${child.name}:${child.count ?? child.geometry?.getAttribute('position').count ?? 0}`);
      });
      return rows;
    }),
    // 树和车流是同一类客人：站在塔的米制坐标里，与塔自己的灯光无关，所以高度透视镜把它们和楼一起收走。
    setVegetation(on) {
      greenery?.setVegetation(on);
      mapRef?.triggerRepaint();
    },
    // 广场地面那块贴图跟着树一起走：镜头一拉远它就是彩纸，透视镜一开就该和楼一起收掉。
    setGround(on) {
      groundOn = on;
      paintGround(mapRef?.getZoom() ?? 0);
      mapRef?.triggerRepaint();
    },
    // 楼根那圈接地带的开关与门控：它是楼的附属物，所以透视镜一开（楼变成数据）它就该一起没，
    // 与拉伸体、窗格、灯火走同一个口令，而不是自己的。
    setBases(on) {
      bases?.setShown(on);
      mapRef?.triggerRepaint();
    },
    setTrafficLamps(lit) {
      nearField?.setLit(lit);
      mapRef?.triggerRepaint();
    },
    runTraffic(seconds, zoom) {
      // 传进来的已经是秒（`motion.life / 1000`），再除一次 1000 就是让船以千分之一速在江上冻住。
      nearField?.advance(seconds, zoom);
      mapRef?.triggerRepaint();
    },
    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      model = createTowerModel();
      beam = createTowerBeam();
      hemisphere = new THREE.HemisphereLight();
      light = new THREE.DirectionalLight();
      // The model matrix is folded into the camera, so anything in this scene is already measured in metres above the
      // tower's own foot. The beam joins as a sibling: the silhouette stays 600 m and the light leaves the top of it.
      // So do the landmark forms - they are separate buildings, and keeping them out of `model` is what stops the
      // atmosphere walks, the pulse and the hue cycle from reaching into a facade that is not the tower's. The near-field
      // traffic joins for the same reason: a car has to sit on a metre-measured road, not on a map tile.
      scene.add(hemisphere, light, model, beam, ...(forms ? [forms.group] : []), ...nearGroups,
        ...(greenery ? [greenery.group] : []), ...(ground ? [ground] : []), ...(bases ? [bases.group] : []));
      const origin = MercatorCoordinate.fromLngLat([DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], 0);
      const scale = origin.meterInMercatorCoordinateUnits();
      // The three towers each lay a band of their own light on the water in front of them. Where that is comes from the
      // river's own centre line, not from a coordinate typed in: see `channelCrossing`.
      const lines = (river ?? []).map((feature) => feature.geometry?.coordinates).filter((line) => line?.length > 1);
      const bandAt = (foot, options) => {
        const axis = channelCrossing(lines, foot);
        if (!axis) return null;
        const glow = createGlowBand({ axis, ...options });
        scene.add(glow.mesh);
        return glow;
      };
      band = bandAt([DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], {});
      // A form that does not ask for a spill gets none - that is why the museum has no band.
      spills = [];
      for (const form of forms?.forms ?? []) {
        if (!LANDMARK_FORMS[form.osmId]?.night?.spill) continue;
        const outline = outlineRing(form.feature);
        if (!outline) continue;
        const open = outline.slice(0, -1);
        const foot = [open.reduce((sum, point) => sum + point[0], 0) / open.length, open.reduce((sum, point) => sum + point[1], 0) / open.length];
        const spill = bandAt(foot, { colour: LANDMARK_FORMS[form.osmId].night.glow, alpha: SHELL_SPILL_ALPHA });
        if (!spill) continue;
        spill.mesh.name = `${form.osmId}:spill`;
        spills.push(spill);
      }
      modelMatrix = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z)
        .scale(new THREE.Vector3(scale, -scale, scale)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      this.setAtmosphere(ATMOSPHERES.day.tower);
      forms?.setAtmosphere({ from: ATMOSPHERES.day });
    },
    render(gl, args) {
      // The shells recede on the same ramp the extrusions read, and that ramp moves with the camera, so the picture is
      // recomputed on the frame it is drawn in rather than on a second clock. The vehicles' headlights and taillights
      // follow the camera for the same reason.
      const zoom = mapRef.getZoom();
      forms?.recede(zoom);
      // The near field's scale and its pedestrian gate ride the same number, on the same frame, for the same reason:
      // a page that never animated and a page that ran and stopped have to hand back one picture.
      nearField?.setZoom(zoom);
      nearField?.faceCamera(mapRef.getBearing());
      // 树和楼根那片接地带都是静态的，但"这一帧在不在图上"是同一个镜头数决定的：载入那帧、跑过又停下那帧、
      // 从没动过的页面必须落在同一张画面上，所以两者都在画的这一帧读。
      greenery?.setZoom(zoom);
      bases?.setZoom(zoom);
      // The plaza decal reads on the same number on the same frame, for the same reason: it must not be a second clock.
      paintGround(zoom);
      // The bands ride the shells' night weight, and they have to read it on the frame they draw. When this landed the
      // only thing handing it over was a motion-loop tick, so a page that switched to night with motion already off
      // drew a night skyline with no light on the water - measured at the band's own centre, 28.9 against the 44.9 the
      // same frame reaches once the weight is handed over.
      const lit = forms?.nightShare() ?? 0;
      if (lit !== night) {
        night = lit;
        paintBand();
      }
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(modelMatrix);
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    onRemove() {
      const geometries = new Set(), materials = new Set();
      scene.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
        if (object.isInstancedMesh) object.dispose();
      });
      geometries.forEach((geometry) => geometry.dispose());
      // A material does not own its textures, and a shell's fin strip and a lamp's halo are two it made.
      materials.forEach((material) => { material.map?.dispose(); material.emissiveMap?.dispose(); material.ladderMap?.dispose(); material.dispose(); });
      renderer.dispose();
    },
  };
}

/**
 * Where a colour cycle has reached, as the hue rotation the emissive colours are turned by.
 *
 * @param {number} cycle 0..1 around the wheel; 0 is the shipped colour, bit for bit, so stopping hands back the frame
 *   the atmosphere set rather than a rounding of it.
 */
export function towerHue(cycle) {
  if (!(cycle >= 0 && cycle <= 1)) throw new Error(`tower hue needs a cycle between 0 and 1: ${cycle}`);
  return cycle;
}

const tint = new THREE.Color();
const components = { h: 0, s: 0, l: 0 };
const crown = { h: 0, s: 0, l: 0 };

// Hues are a circle: a raw difference between two of them takes the long way round, so every turn below is wrapped back
// into the wheel first.
const wrap = (hue) => ((hue % 1) + 1) % 1;

/**
 * The tower's night lighting schemes, in the order the buttons offer them.
 *
 * `single` is the default: the whole shaft one hue at any instant, and the hue turns over forty seconds, which is what
 * a floodlit tower actually does. `cycle` is the five-colour wheel this scene shipped with - kept, because it is the
 * one that shows off the lattice, but no longer the first thing anybody sees. `breath` changes no colour at all.
 */
export const TOWER_MODES = ['single', 'cycle', 'breath'];

/**
 * The tower's night colours at one point of the wheel, in one of two schemes.
 *
 * `cycle` - the shipped one - turns all five preset colours by the same amount, so the lattice keeps its cyan body and
 * warm crown and the whole set wheels round together. That is the 彩虹渐变 the brief calls a toy: at any one moment the
 * shaft is five colours, which is not how a floodlit tower looks.
 *
 * `single` is what a real one does: one hue for the whole shaft, and the hue is the thing that changes. Each material
 * keeps its own saturation and lightness, so the lattice still reads as glass over a darker structure, and the hue the
 * shaft takes is the preset's own crown, so the show starts on the colour the still frame already ends with.
 *
 * There is no crossfade between the two. The preset's five night hues span two thirds of the wheel, so any scheme that
 * gathered them into one colour by moving each along its shortest path would first have to pull the ones that sit close
 * *through zero* apart again - measured, not guessed: the spread opens from 0.37 to 0.48 of a turn before it closes.
 * The switch is the moment the shaft changes, exactly as pressing 彩虹 changes it.
 *
 * @param {number} shift 0..1 around the wheel; 0 is the shipped preset, bit for bit, so stopping hands back the frame
 *   the atmosphere set rather than a rounding of it.
 * @param {string} [scheme] `cycle` or `single`.
 */
export function applyTowerHue(model, preset, shift, scheme = 'cycle') {
  const single = scheme === 'single';
  let show = 0;
  if (single && shift) {
    // The show's hue is the preset's own crown, so the wheel starts on the colour the still frame already ends with.
    // A theme that lights nothing - daylight, where every emission baseline is zero - has no crown to start from and no
    // shaft to paint, and the loop reaches this branch in any atmosphere, so it is refused here rather than crashing
    // on a material the preset never named.
    const glowing = Object.keys(preset.emission).filter((key) => preset.emission[key]?.[1]);
    if (!glowing.length) return;
    tint.set(preset.emission[glowing.includes('warm') ? 'warm' : glowing[0]][0]).getHSL(crown);
    show = wrap(crown.h + shift);
  }
  for (const material of emissiveMaterials(model)) {
    const entry = preset.emission[material.name];
    if (!entry || entry[1] === 0) continue;
    if (!shift) {
      material.emissive.set(entry[0]);
      material.color.set(preset.colors[material.name]);
      continue;
    }
    if (single) {
      // Both halves of the material, not just the glow: the lattice is also lit by the scene's own lights, and leaving
      // `pale` violet while the glass went cyan is what kept a second colour on the shaft. Each material keeps its own
      // saturation and lightness, which is what still reads as structure rather than as a painted tube.
      tint.set(entry[0]).getHSL(components);
      material.emissive.setHSL(show, components.s, components.l);
      tint.set(preset.colors[material.name]).getHSL(components);
      material.color.setHSL(show, components.s, components.l);
      continue;
    }
    tint.set(entry[0]).getHSL(components);
    material.emissive.setHSL(wrap(components.h + shift), components.s, components.l);
  }
}

/**
 * The beam over the mast: a cone of light leaving the antenna, additive so the sky behind it stays the sky.
 *
 * Nothing in OSM says a searchlight sits on the tower, so this is 示意 and the landmark card says so out loud. It is
 * off unless the night theme asks for it, and it is not an emissive material, so the atmosphere walks leave it alone.
 */
export function createTowerBeam({ base = 3, top = 26, height = 190, color = '#8fe6ff', opacity = 0.13 } = {}) {
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(base, top, height, 40, 1, true),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  beam.name = 'beam';
  beam.position.y = 600 + height / 2;
  beam.visible = false;
  beam.frustumCulled = false;
  return beam;
}

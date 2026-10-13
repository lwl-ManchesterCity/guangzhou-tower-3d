import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { DEFAULT_CENTER } from './config.js';
import { ATMOSPHERES } from './atmosphere.js';

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

export function createTowerModel() {
  const group = new THREE.Group();
  const silver = new THREE.MeshStandardMaterial({ name: 'silver', color: '#d4dfe0', roughness: 0.65, metalness: 0.25 });
  const pale = new THREE.MeshStandardMaterial({ name: 'pale', color: '#e7ece9', roughness: 0.6, metalness: 0.2 });
  const diagonal = new THREE.MeshStandardMaterial({ name: 'diagonal', color: '#8da5ad', roughness: 0.75, metalness: 0.15 });
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

export function applyTowerAtmosphere(model, preset) {
  const materials = new Set();
  model.traverse((object) => { if (object.material) materials.add(object.material); });
  for (const material of materials) {
    material.color.set(preset.colors[material.name]);
    const [color, intensity] = preset.emission[material.name];
    material.emissive.set(color);
    material.emissiveIntensity = intensity;
  }
}

export function createTowerLayer() {
  let renderer, scene, camera, modelMatrix, model, hemisphere, light, mapRef;
  return {
    id: 'canton-tower', type: 'custom', renderingMode: '3d',
    setAtmosphere(preset) {
      applyTowerAtmosphere(model, preset);
      hemisphere.color.set(preset.hemisphere[0]);
      hemisphere.groundColor.set(preset.hemisphere[1]);
      hemisphere.intensity = preset.hemisphere[2];
      light.color.set(preset.directional[0]);
      light.intensity = preset.directional[1];
      light.position.set(...preset.position);
      mapRef.triggerRepaint();
    },
    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      model = createTowerModel();
      hemisphere = new THREE.HemisphereLight();
      light = new THREE.DirectionalLight();
      scene.add(hemisphere, light, model);
      const origin = MercatorCoordinate.fromLngLat([DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], 0);
      const scale = origin.meterInMercatorCoordinateUnits();
      modelMatrix = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z)
        .scale(new THREE.Vector3(scale, -scale, scale)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      this.setAtmosphere(ATMOSPHERES.day.tower);
    },
    render(gl, args) {
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
      materials.forEach((material) => material.dispose());
      renderer.dispose();
    },
  };
}

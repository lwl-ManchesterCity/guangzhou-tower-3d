import * as THREE from 'three';
const out = {};
for (const [key, hex] of Object.entries({ red: '#ff2d1a', amber: '#ffb020', green: '#2fd66b', off: '#22262a' })) {
  const c = new THREE.Color(hex);
  out[key] = { full: [c.r, c.g, c.b].map((v) => Number(v.toFixed(8))), day: [c.r * 0.55, c.g * 0.55, c.b * 0.55].map((v) => Number(v.toFixed(8))) };
}
console.log(JSON.stringify(out, null, 1));
const cyl = new THREE.CylinderGeometry(0.075, 0.1, 3.2, 6, 1);
console.log('裸柱顶点', cyl.getAttribute('position').count);

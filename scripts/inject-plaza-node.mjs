// 一次性：给 `src/engine/plaza.js` 做四条注入，每条跑 `node --test tests/engine.test.js`，要求当场红，然后原样还回去。
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const file = 'src/engine/plaza.js';
const backup = '/tmp/plaza.bak.js';
copyFileSync(file, backup);
const original = readFileSync(file, 'utf8');
const mutants = [
  ['网格站到路带底下', "  surface: GROUND_LAYERS.road + 0.04,", '  surface: GROUND_LAYERS.road - 0.01,'],
  ['门控失效（永远在画）', 'decal.visible = zoom >= PLAZA_SURFACE_MIN_ZOOM;', 'decal.visible = true;'],
  ['换氛围不刷广场那三块板', 'for (const mesh of meshes) mesh.material.color.set(colours[mesh.name]);', ''],
  ['贴图没人还', '      surface.texture.dispose();', ''],
  ['还了资源没摘节点', '      group.clear();', ''],
];
for (const [label, from, to] of mutants) {
  if (!original.includes(from)) { console.log(`SKIP ${label}：锚点没找到`); continue; }
  writeFileSync(file, original.replace(from, to));
  let out = '';
  try { out = execSync('node --test tests/engine.test.js 2>&1', { encoding: 'utf8' }); } catch (error) { out = error.stdout ?? String(error); }
  writeFileSync(file, readFileSync(backup, 'utf8'));
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map(([, name]) => name);
  console.log(`${label} → ${failed.length ? `红：${failed.join(' / ')}` : '全绿（这条注入动不到判据！）'}`);
}
copyFileSync(backup, file);
rmSync(backup);
console.log(execSync('git status --short src', { encoding: 'utf8' }));

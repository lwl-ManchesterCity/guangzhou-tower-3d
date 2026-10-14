// 一次性：#189 的 Node 侧判据做缺陷注入（`tests/river.test.js`）。
// 每条注入先证明"文件真的被改了"，再跑那一个测试文件，跑完逐字还原。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const R = 'src/engine/river.js';
const source = readFileSync(R, 'utf8');

const cases = [
  ['半透明双面没钉单通道', '    forceSinglePass: true,\n', ''],
  ['格子钉回视口：setView 不吃镜头中心', '      const offset = !centre ? state.offset : (() => {',
    '      const offset = true ? state.offset : (() => {'],
  ['片元里删掉那个相位起点', '\tvec2 riverUv = fract( ( riverGround + riverOffset + vec2( 0.0, riverScroll ) ) / riverTile );',
    '\tvec2 riverUv = fract( ( riverGround + vec2( 0.0, riverScroll ) ) / riverTile );'],
  ['材质不带自己的程序缓存键', "  material.customProgramCacheKey = () => 'river-sheen';\n", ''],
  ['拆场景不还那三张贴图', '      for (const texture of Object.values(tiles)) texture.dispose();\n      group.clear();',
    '      group.clear();'],
  ['屏幕节奏开了 mipmap', '  texture.generateMipmaps = false;', '  texture.generateMipmaps = true;'],
  ['滚动不绕回', '      state.scroll = (((state.scroll + steps) % size) + size) % size;', '      state.scroll = state.scroll + steps;'],
  ['抬高层进路带那一档', 'export const RIVER_SHEEN_LIFT_METRES = 0.02;', 'export const RIVER_SHEEN_LIFT_METRES = 0.35;'],
];

for (const [label, from, to] of cases) {
  const hits = source.split(from).length - 1;
  if (hits !== 1) {
    console.log(`\n· ${label}\n  锚点命中 ${hits} 次（要正好 1 次）— 这条注入无效，先修锚点`);
    continue;
  }
  writeFileSync(R, source.split(from).join(to));
  const changed = readFileSync(R, 'utf8') !== source;
  const run = spawnSync('node', ['--test', 'tests/river.test.js'], { encoding: 'utf8', cwd: process.cwd() });
  const out = `${run.stdout}${run.stderr}`;
  const failed = /fail (\d+)/.exec(out)?.[1];
  const first = /^✖[^\n]*\n[^\n]*[^\n]*/m.exec(out)?.[0]?.replace(/\s+/g, ' ').slice(0, 150);
  writeFileSync(R, source);
  console.log(`\n· ${label}`);
  console.log(`  改到了文件：${changed}｜还原：${readFileSync(R, 'utf8') === source}`);
  console.log(`  ${Number(failed) > 0 ? `红 ✓ ${failed} 条被抓到` : '绿 ✗ 没抓到'}｜${first ?? out.split('\n').filter((l) => /pass |fail /.test(l)).join(' ')}`);
}
writeFileSync(R, source);
console.log('\n还原检查：', readFileSync(R, 'utf8') === source);

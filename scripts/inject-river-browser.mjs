// 一次性：给 #189 那两条浏览器判据做缺陷注入
// （`the new engine lays the river sheen ...` 与 `the new engine gives back every geometry, material and texture it made`）。
// 每条注入先证明"文件真的被改了"，再跑那一条测试，跑完逐字还原；红线要落在哪一句判据上写在期望里。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const R = 'src/engine/river.js';
const files = [R];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));

const river = ['river sheen'];
const census = ['gives back every geometry'];

const cases = [
  ['格子钉回视口：setView 不吃镜头中心', R, '      const offset = !centre ? state.offset : (() => {',
    '      const offset = true ? state.offset : (() => {', river, '平移之后地面相位没动'],
  ['转角不进画面：bearing 被丢掉', R, '      const rotate = -(bearing * Math.PI) / 180;', '      const rotate = 0;',
    river, '转角'],
  ['画布中心不交：格子起点回到左下角', R,
    '      const center = [Math.round(width * scale / 2), Math.round(height * scale / 2)];', '      const center = [0, 0];',
    river, '画布与设备倍率'],
  ['半透明双面没钉单通道：一块网格付两发数', R, '    forceSinglePass: true,\n', '', river, '发数'],
  ['换氛围不清相位：上一档的偏移留在江面上', R,
    '      state.scroll = 0;\n      uniform(\'riverMap\', tiles[id]);\n      uniform(\'riverScroll\', 0);\n',
    '      uniform(\'riverMap\', tiles[id]);\n', river, '换了氛围还留着上一档的偏移'],
  ['滚动不绕回：一拍加一格、走出那一圈', R,
    '      state.scroll = (((state.scroll + steps) % size) + size) % size;', '      state.scroll = state.scroll + steps;',
    river, '相位'],
  ['透明度不读斜坡：钉死在 0.72', R, '        state.opacity = riverOpacityFor(zoom);', '        state.opacity = 0.72;',
    river, '斜坡'],
  ['还资源但不摘节点：组里留着那一块网格', R,
    '      for (const texture of Object.values(tiles)) texture.dispose();\n      group.clear();',
    '      for (const texture of Object.values(tiles)) texture.dispose();', census, '还留着节点'],
  ['几何没还：dispose 少了那一笔', R, '      geometry.dispose();\n', '', census, 'dispose 没还掉'],
];

for (const [label, file, from, to, groups, want] of cases) {
  const source = original[file];
  const hits = source.split(from).length - 1;
  if (hits !== 1) {
    console.log(`\n· ${label}\n  锚点在 ${file} 里命中 ${hits} 次（要正好 1 次）— 这条注入无效，先修锚点`);
    continue;
  }
  writeFileSync(file, source.split(from).join(to));
  const changed = readFileSync(file, 'utf8') !== source;
  const run = spawnSync('npx', ['playwright', 'test', 'tests/engine.browser.spec.js', '-g', groups[0],
    '--reporter=list'], { encoding: 'utf8', cwd: process.cwd() });
  const out = `${run.stdout}${run.stderr}`;
  const red = /1 failed/.test(out) && !/1 passed/.test(out);
  const first = /Error:[^\n]*/.exec(out)?.[0]?.slice(0, 160);
  writeFileSync(file, source);
  const restored = readFileSync(file, 'utf8') === source;
  console.log(`\n· ${label}`);
  console.log(`  改到了文件：${changed}｜还原：${restored}`);
  console.log(`  ${red ? `红 ✓ 被抓到（${first ?? ''}）` : `绿 ✗ 没抓到｜${out.split('\n').filter((l) => /passed|failed/.test(l)).join(' ')}`}｜期望点名「${want}」`);
}

for (const [file, text] of Object.entries(original)) writeFileSync(file, text);
console.log('\n还原检查：', files.every((file) => readFileSync(file, 'utf8') === original[file]));

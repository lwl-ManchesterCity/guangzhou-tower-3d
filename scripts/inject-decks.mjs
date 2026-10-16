// 一次性：三条注入。前两条改 `src/near-field.js`（真装错的样子），第三条改测试那侧的装配（把整份快照表喂给引擎）。
// 每条都跑 `tests/near-field.test.js`，要求当场红；跑完原样还回去。
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const cases = [
  ['src/near-field.js', '把表整个丢掉（boot 漏传的那一类）', '  .map((feature) => {', '  .map(() => null).filter(Boolean).map((feature) => {'],
  ['src/near-field.js', '顶高读成厚度而不是顶面', 'height: form.base + form.thickness', 'height: form.thickness'],
  ['tests/near-field.test.js', '给引擎喂整份快照表（车站到没画出来的桥上）',
    'origin: DEFAULT_CENTER, decks: engineDeckTable, sprite: null });', 'origin: DEFAULT_CENTER, decks, sprite: null });'],
];
for (const [file, label, from, to] of cases) {
  const backup = `/tmp/inject-${file.replace(/\//g, '-')}.bak`;
  copyFileSync(file, backup);
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { console.log(`SKIP ${label}：锚点没找到`); continue; }
  writeFileSync(file, original.replace(from, to));
  let out = '';
  try { out = execSync('node --test tests/near-field.test.js 2>&1', { encoding: 'utf8' }); } catch (error) { out = error.stdout ?? String(error); }
  writeFileSync(file, readFileSync(backup, 'utf8'));
  rmSync(backup);
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map(([, name]) => name);
  const reason = /values:\s*\n\s*(- \[?.*)/.exec(out)?.[1]?.trim() ?? '';
  console.log(`${label} → ${failed.length ? `红：${failed.join(' / ')}` : '全绿（这条注入动不到判据！）'}${reason ? `｜${reason}` : ''}`);
}
console.log('还原后 src+tests 的改动仍然只有我这一批：');
console.log(execSync('git status --short src tests', { encoding: 'utf8' }));

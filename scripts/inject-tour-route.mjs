// 一次性：这条新判据（八站时路线条只留当前那一站的名字）要双向都能红——
// 把"非当前站收掉名字"那条规则摘掉，八个名字会全冒出来；把当前站那一格的名字也收掉，一个都不剩。
// 两条都跑 `npx playwright test -g "narrow screens"`，要求当场红，然后原样还回去。
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const cases = [
  ['src/style.css', '非当前站的名字没收',
    '.tour-route.is-long li { font-size: 0; line-height: 12px; }',
    '.tour-route.is-long li { line-height: 12px; }'],
  ['src/style.css', '连当前那一站的名字也收了',
    ".tour-route.is-long li[aria-current='step'] { flex: 0 0 auto; margin-right: 10px; font-size: 10px; }",
    ".tour-route.is-long li[aria-current='step'] { flex: 0 0 auto; margin-right: 10px; }"],
];
for (const [file, label, from, to] of cases) {
  const backup = `/tmp/probe-${file.split('/').pop()}.bak`;
  copyFileSync(file, backup);
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { console.log(`SKIP ${label}：锚点没找到`); continue; }
  writeFileSync(file, original.replace(from, to));
  let out = '';
  let red = false;
  try { out = execSync('npx playwright test tests/browser.spec.js -g "narrow screens" --workers=1 --reporter=line 2>&1', { encoding: 'utf8', timeout: 420000 }); } catch (error) { out = error.stdout ?? String(error); red = true; }
  writeFileSync(file, readFileSync(backup, 'utf8'));
  rmSync(backup);
  console.log(`${label} → ${red ? '红' : '全绿（这条注入动不到判据！）'}`);
  console.log(out.split('\n').filter((line) => /(expected|Expected|received|只该留|passed|failed)/.test(line)).slice(0, 6).join('\n'));
  console.log('---');
}
console.log(execSync('git status --short src', { encoding: 'utf8' }));

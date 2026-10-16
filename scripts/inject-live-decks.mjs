// 一次性：两条注入跑真页面判据。每条改完跑 `npx playwright test -g "stands the deck"`，要求当场红，然后原样还回去。
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const cases = [
  ['src/engine/boot.js', 'boot 漏传桥面表', 'sprite, decks: engineDecks(bridge) });', 'sprite });'],
  ['src/landmark-forms.js', '那一个数与画出来的那一层分家',
    'export const DECK_TOP_METRES = DECK_CLEARANCE_METRES + DECK_THICKNESS_METRES;',
    'export const DECK_TOP_METRES = DECK_CLEARANCE_METRES + DECK_THICKNESS_METRES + 1;'],
];
for (const [file, label, from, to] of cases) {
  const backup = `/tmp/probe-${file.split('/').pop()}.bak`;
  copyFileSync(file, backup);
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) { console.log(`SKIP ${label}：锚点没找到`); continue; }
  writeFileSync(file, original.replace(from, to));
  let out = '';
  let red = false;
  try { out = execSync('npx playwright test tests/engine.browser.spec.js -g "stands the deck" --workers=1 --reporter=line 2>&1', { encoding: 'utf8', timeout: 420000 }); } catch (error) { out = error.stdout ?? String(error); red = true; }
  writeFileSync(file, readFileSync(backup, 'utf8'));
  rmSync(backup);
  const reason = /(?:Error|expect)\s*\(?\s*received[^\n]*|期望[^\n]*|与 DECK_TOP_METRES 分家[^\n]*|汇总不对[^\n]*/.exec(out)?.[0]?.slice(0, 220) ?? '';
  console.log(`${label} → ${red ? '红' : '全绿（这条注入动不到判据！）'}`);
  console.log(out.split('\n').filter((line) => /(expected|Expected|received|\+   |\-   |passed|failed)/.test(line)).slice(0, 8).join('\n'));
  console.log('---');
}
console.log(execSync('git status --short src', { encoding: 'utf8' }));

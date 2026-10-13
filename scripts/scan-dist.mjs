// 一次性：构建产物的隐私扫描。key 只从 `.env.local` 读进来比对，**一律不打印**；
// 空串或过短的模式会让 `grep -F ""` 命中每一个文件（上一轮就是这么把 25/25 报成"全含 key"的），所以先拒绝。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = readFileSync(fileURLToPath(new URL('../.env.local', import.meta.url)), 'utf8');
const key = /^\s*AMAP_KEY\s*=\s*(.+)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!key || key.length < 8) {
  console.error(`AMAP_KEY 读不到或太短（长度 ${key?.length ?? 0}），拒绝扫描——空模式会命中每一个文件。`);
  process.exit(1);
}
const needles = ['__AMAP_KEY__', 'restapi.amap', 'jingtai-amap', '/local/', '127.0.0.1', 'localhost'];
const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const path = join(dir, entry);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const files = walk(root);
const hits = Object.fromEntries(needles.map((needle) => [needle === '__AMAP_KEY__' ? key : needle, []]));
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const needle of Object.keys(hits)) if (text.includes(needle)) hits[needle].push(relative(root, file));
}
const hex32 = [...new Set((() => { const out = []; for (const file of files) { const text = readFileSync(file, 'utf8'); out.push(...(text.match(/\b[0-9a-f]{32}\b/g) ?? [])); } return out; })())];
console.log(`扫描 ${files.length} 个文件：`);
for (const [needle, found] of Object.entries(hits)) {
  console.log(`  ${needle === key ? 'AMAP_KEY（逐字节比对，不打印值）' : needle}: ${found.length} 命中${found.length ? ` → ${found.join(', ')}` : ''}`);
}
console.log(`  32 位十六进制串: ${hex32.length} 条${hex32.length ? `（${hex32.join(', ')}）` : ''}`);

// P1-4a：把东亚建筑矢量数据集（Zenodo `10.5281/zenodo.8174931`，CC BY 4.0，2023-04 成图）里广州那一个成员
// 取出来，按景泰校区周围的近场盒筛成 `data/jingtai-eastasia-footprints.geojson`。
//
// 这一支脚本存在的理由：那份切片当初是**一次性探测脚本**产出的（README 的 P1-4 节自己写着"尚未固化为仓库
// 脚本"），于是"这 4,780 栋从哪来"在仓库里无法复现。这里把它固化下来，并且拿仓库里那份切片当**对照物**：
// 条数、身份、属性、逐位坐标都得对得上，对不上就如实报差在哪一条（`--verify` 给逐位统计）。
//
//   node scripts/extract-eastasia-footprints.mjs --members   只读 zip 中央目录，列出广州的成员与字节数
//   node scripts/extract-eastasia-footprints.mjs --fetch     只把需要的三个成员取进缓存
//   node scripts/extract-eastasia-footprints.mjs             取数（缓存命中则跳过）+ 解析 + 筛选 + 写切片
//   node scripts/extract-eastasia-footprints.mjs --verify    与仓库里那份切片对账，逐字节一致才返回 0
//   node scripts/extract-eastasia-footprints.mjs --prefix --verify   下载没完时，先拿已落盘的那一段对账
//   node scripts/extract-eastasia-footprints.mjs --rule bbox-box   换近场盒的口径（见 NEAR_RULES）
//   node scripts/extract-eastasia-footprints.mjs --archive /path/to/East_Asian_buildings.zip   完全离线
//
// 缓存默认在 `.cache/eastasia/`（解压后约 0.6 GB，在仓库目录内、`public/` 之外，所以构建收不到它）。
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { SCENES } from '../src/scenes.js';

const RECORD = { record: 8174931, file: 'East_Asian_buildings.zip', size: 23_108_515_351,
  md5: 'd356f487b19eaa13c6e12eb42ac3ca53' };
const MEMBER = 'China/Guangdong/Guangzhou';
const UTM_ZONE = 49;
// 切片自己的口径：坐标四舍五入到 7 位小数（约 1 cm），属性取 .dbf 里那几列的**原始文本**去空白，
// 不重新格式化数字——`dataset_id` 在切片里是 `"6393.00000000000"`，那是字段原样，不是解析结果。
const DECIMALS = 7;
// 属性来源是**真归档的列名**（2026-10-06 取回 .dbf 后读到的四列：`id`、`ORIG_OID`、`STATUS`、`ORIG_FID`）。
// 切片里那个 `dataset_id: "6393.00000000000"` 来自 `id` 这一列（N 型、11 位小数），不是叫 DATASET_ID 的列——
// 名字是切片自己起的，列名照抄会全成 null。`osm_id` 那列在这份数据里根本不存在，所以恒为 null。
const FIELDS = { dataset: 'id', status: 'STATUS', oid: 'ORIG_OID', osm: 'OSM_ID' };
const JINGTAI = SCENES.jingtai;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] ? args[at + 1] : fallback; };
const cacheDir = opt('cache', '.cache/eastasia');
const outPath = opt('out', 'data/jingtai-eastasia-footprints.geojson');
const centre = { lat: Number(opt('lat', JINGTAI.center.lat)), lng: Number(opt('lng', JINGTAI.center.lng)) };
const boxMetres = Number(opt('box', JINGTAI.radius));
const rule = opt('rule', 'vertex-box');
const source = opt('archive', `https://zenodo.org/api/records/${RECORD.record}/files/${RECORD.file}/content`);
const remote = source.startsWith('http');
// Zenodo 的 /content 端点对没有 UA 的请求给 403（本机实测：curl 206、node fetch 403）。
const HEADERS = { 'User-Agent': 'neighborhood-atlas/1.0 (local research reproducible extract)' };

const log = (...line) => console.log(...line);
const fatal = (message) => { throw new Error(message); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 一次尝试，失败就换一次等待。慢链路（本机实测约 100 KB/s）上"重试"是常态，不是异常。 */
async function attempt(times, what, run) {
  for (let i = 0; i < times; i++) {
    try {
      return await run();
    } catch (error) {
      if (i === times - 1) fatal(`${what} 连续 ${times} 次没成：${error.message}`);
      log(`  ${what} 断了（${error.message}），第 ${i + 2} 次重试`);
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

let localHandle = null;
/** 一次 Range 读，不重试（重试在调用方，因为分块下载要按块重试而不是整段重来）。本地归档走同一条签名。 */
async function readRange(start, end) {
  if (!remote) {
    localHandle ??= openSync(source, 'r');
    const buffer = Buffer.allocUnsafe(end - start + 1);
    for (let at = 0; at < buffer.length;) {
      const got = readSync(localHandle, buffer, at, buffer.length - at, start + at);
      if (!got) fatal(`本地归档在 ${start + at} 处读不动了`);
      at += got;
    }
    return buffer;
  }
  const response = await fetch(source, { headers: { ...HEADERS, Range: `bytes=${start}-${end}` } });
  if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== end - start + 1) throw new Error(`只给回 ${bytes.length} B，要 ${end - start + 1} B`);
  return bytes;
}

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * zip 的中央目录。整包 23.1 GB 超过 4 GB，EOCD32 里那几个字段是占位的 `0xffffffff`，真值在 EOCD64；
 * 单条成员也可能带 Zip64 扩展行（tag 0x0001）。两处都得读，否则偏移静默指到别处去。
 */
function parseCentralDirectory(cd) {
  const entries = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const entry = { name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'), method: cd.readUInt16LE(p + 10),
      crc32: cd.readUInt32LE(p + 16), compressed: cd.readUInt32LE(p + 20), uncompressed: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42) };
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra.readUInt16LE(q), size = extra.readUInt16LE(q + 2);
      if (id === 0x0001) {
        let r = q + 4;
        if (entry.uncompressed === 0xffffffff) { entry.uncompressed = Number(extra.readBigUInt64LE(r)); r += 8; }
        if (entry.compressed === 0xffffffff) { entry.compressed = Number(extra.readBigUInt64LE(r)); r += 8; }
        if (entry.localOffset === 0xffffffff) entry.localOffset = Number(extra.readBigUInt64LE(r));
      }
      q += 4 + size;
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function centralDirectory() {
  const tail = await attempt(6, 'zip 尾部 64 KB', () => readRange(RECORD.size - 65_536, RECORD.size - 1));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fatal('zip 尾部 64 KB 里找不到 EOCD，这个归档不像 zip 或者声明的长度不对');
  let offset = tail.readUInt32LE(eocd + 16), size = tail.readUInt32LE(eocd + 12), count = tail.readUInt16LE(eocd + 10);
  const locator = eocd - 20;
  if (locator >= 0 && tail.readUInt32LE(locator) === 0x07064b50) {
    const at = Number(tail.readBigUInt64LE(locator + 8));
    const eocd64 = await attempt(6, 'EOCD64', () => readRange(at, at + 55));
    if (eocd64.readUInt32LE(0) !== 0x06064b50) fatal('EOCD64 定位符指到的地方签名不对');
    count = Number(eocd64.readBigUInt64LE(32)); size = Number(eocd64.readBigUInt64LE(40)); offset = Number(eocd64.readBigUInt64LE(48));
  }
  log(`中央目录：${count} 条成员，在 ${offset}，长 ${size} B`);
  return parseCentralDirectory(await attempt(6, '中央目录', () => readRange(offset, offset + size - 1)));
}

/** 中央目录给的偏移指向**局部头**，而局部头里的名字/扩展长度可以与中央目录不同，数据起点得按局部头重算。 */
async function dataStart(entry) {
  const head = await attempt(6, `${entry.name} 的局部头`, () => readRange(entry.localOffset, entry.localOffset + 29));
  if (head.readUInt32LE(0) !== 0x04034b50) fatal(`${entry.name} 的局部头签名不对`);
  return entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
}

/**
 * 分块 Range 下载 + 断点续传。一次整段读 126 MB 在这条链路上被 undici 报成 `terminated`（本机实测），
 * 所以按 4 MB 一块取、每块单独重试，`.deflate` 里已落盘的整数块不重下——跑到 90 % 断了不必从头再来。
 */
const CHUNK = 4 * 1024 * 1024;
async function fetchMember(entry, path) {
  const start = await dataStart(entry);
  const temp = `${path}.deflate`;
  const have = existsSync(temp) ? Math.floor(statSync(temp).size / CHUNK) * CHUNK : 0;
  const handle = openSync(temp, have ? 'r+' : 'w');
  const started = Date.now();
  try {
    for (let at = have; at < entry.compressed; at += CHUNK) {
      const size = Math.min(CHUNK, entry.compressed - at);
      const raw = await attempt(8, `${entry.name} 的 ${Math.round(at / CHUNK)} 号块`, () => readRange(start + at, start + at + size - 1));
      writeSync(handle, raw, 0, size, at);
      if (at % (CHUNK * 8) === 0) log(`  ${entry.name.split('/').pop()} ${Math.round(at / entry.compressed * 100)} %`
        + `（${Math.round(at / 1024 / 1024)} MiB / ${Math.round(entry.compressed / 1024 / 1024)} MiB，`
        + `${Math.round((Date.now() - started) / 1000)} s）`);
    }
  } finally {
    closeSync(handle);
  }
  const compressed = readFileSync(temp);
  if (compressed.length < entry.compressed) fatal(`${entry.name} 只落了 ${compressed.length} B，声明 ${entry.compressed} B`);
  const raw = compressed.subarray(0, entry.compressed);
  let bytes = raw;
  if (entry.method === 8) bytes = inflateRawSync(raw, { maxOutputLength: entry.uncompressed });
  else if (entry.method !== 0) fatal(`${entry.name} 的压缩方法是 ${entry.method}，这一支只认 0（存）与 8（deflate）`);
  if (bytes.length !== entry.uncompressed) fatal(`${entry.name} 解出 ${bytes.length} B，中央目录声明 ${entry.uncompressed} B`);
  // 带 data descriptor 时局部头的长度是 0，所以长度与 CRC 都只信中央目录——这一条是"取回来的确实是那一份数据"的唯一凭据。
  if (crc32(bytes) !== (entry.crc32 >>> 0)) fatal(`${entry.name} 的 CRC32 与声明值不符：取回来的不是那一份数据`);
  // 落盘的是**解压后**的那一份。上一版在这里直接把 `.deflate` 改名成正式文件，于是缓存里躺的是压缩字节，
  // 长度校验认不出来、每次重下，`.prj` 读回来是一串乱码——缓存的正确性也在这一行上。
  writeFileSync(`${path}.inflated`, bytes);
  await rename(`${path}.inflated`, path);
  unlinkSync(temp);
  log(`  已取 ${path}：压缩 ${entry.compressed} B → 解压 ${bytes.length} B，CRC32 ${(entry.crc32 >>> 0).toString(16)}，`
    + `用时 ${Math.round((Date.now() - started) / 1000)} s`);
}

/** 成员进缓存；缓存里那份长度对得上就直接用，所以这一支可以反复跑而不重复下载。 */
async function cached(entry) {
  const path = `${cacheDir}/${entry.name.split('/').pop()}`;
  if (existsSync(path) && statSync(path).size === entry.uncompressed) {
    log(`  缓存命中 ${path}（${entry.uncompressed} B）`);
    return { path, bytes: () => readFileSync(path) };
  }
  await mkdir(cacheDir, { recursive: true });
  await fetchMember(entry, path);
  return { path, bytes: () => readFileSync(path) };
}

/**
 * ESRI shapefile。文件头是**大端**（除版本与字节序标记两处），`fileLength` 以 16 位字为单位；记录体是小端。
 * 只认 0（空）、5（Polygon）、15（MultiPolygon）——别的类型宁可炸掉，也不静默少一栋楼。
 * `lenient` 给 `--prefix`：下载没完时按 deflate 的同步冲刷只能解出文件的前一段，那时最后一条被截断的记录
 * 要停下来而不是炸掉，前面完整的记录照样能拿去对账。
 */
export function parseShapefile(buffer, { lenient = false } = {}) {
  if (buffer.readInt32BE(0) !== 9994) fatal('不是 shapefile（文件头 code 应为 9994）');
  if (!lenient && buffer.readInt32BE(24) * 2 !== buffer.length) {
    fatal(`shapefile 声明 ${buffer.readInt32BE(24) * 2} B，实际 ${buffer.length} B`);
  }
  // 头里 28 是版本号（小端 1000）、32 是**整个文件的形状类型**，不是字节序标记：拿 32 去等 1 会把每一份真
  // shapefile 都判成坏文件（真文件的这一格是 5 或 15）。
  if (buffer.readInt32LE(28) !== 1000) fatal(`shapefile 版本号是 ${buffer.readInt32LE(28)}，这一支只认 1000`);
  const records = [];
  for (let p = 100; p + 8 <= buffer.length;) {
    const number = buffer.readInt32BE(p), words = buffer.readInt32BE(p + 4);
    const body = buffer.subarray(p + 8, p + 8 + words * 2);
    if (body.length !== words * 2) {
      if (lenient) break;
      fatal(`记录 ${number} 声明 ${words} 个字，但只剩 ${body.length} B`);
    }
    const type = body.readInt32LE(0);
    const box = type === 0 ? null : [body.readDoubleLE(4), body.readDoubleLE(12), body.readDoubleLE(20), body.readDoubleLE(28)];
    if (type === 0) records.push({ number, box, parts: [] });
    else if (type === 5) records.push({ number, box, parts: readParts(body, 36) });
    else if (type === 15) {
      // MultiPolygon 比 Polygon 多一张"钉书针"表（PartTypes，每个点一个 int32，写它属于哪个部件），点在其后。
      // 漏算这一段，读回来的就是钉书针的整数而不是坐标。
      records.push({ number, box, parts: readParts(body, 36, body.readInt32LE(40) * 4) });
    } else fatal(`记录 ${number} 的类型是 ${type}；这一支只认 0、5、15`);
    p += 8 + words * 2;
  }
  return records;
}

/**
 * 环数组：`numParts`、`numPoints`、`Parts[numParts]` 个起点索引，然后（MultiPolygon 才有）`PartTypes[numPoints]`
 * 这张钉书针，最后才是点。两处都是本轮拿真归档对出来的：`Parts` **没有终止项**（按 NumParts+1 读会让每条记录
 * 的起点都往后错 4 B，一个部件五个点的记录就成了"需要 132 B 而文件给 128 B"），钉书针漏算则读回的是整数表。
 */
function readParts(body, at, shift = 0) {
  const parts = body.readInt32LE(at), points = body.readInt32LE(at + 4);
  const index = [];
  for (let i = 0; i < parts; i++) index.push(body.readInt32LE(at + 8 + i * 4));
  const flat = [];
  const start = at + 8 + parts * 4 + shift;
  for (let i = 0; i < points; i++) {
    flat.push({ x: body.readDoubleLE(start + i * 16), y: body.readDoubleLE(start + i * 16 + 8) });
  }
  const rings = [];
  for (let i = 0; i < parts; i++) rings.push(flat.slice(index[i], i + 1 < parts ? index[i + 1] : points));
  return rings;
}

/**
 * dBASE：头 32 B、字段描述各 32 B、`headerLength` 之后是定长记录，每条前有一个删除标记字节。
 * 行**按需取**（`rowAt`）而不是整表展开：广州这一份有 1,792,111 行，而近场只留 11,257 条，
 * 全部展开要先造一百多万个对象。
 */
export function parseDbf(buffer) {
  const fields = [];
  const headerEnd = buffer.readUInt16LE(8), recordLength = buffer.readUInt16LE(10), count = buffer.readInt32LE(4);
  for (let p = 32; p + 32 <= headerEnd; p += 32) {
    if (buffer[p] === 0x0d) break;
    const name = buffer.subarray(p, p + 11).toString('latin1').split('\0')[0].trim();
    if (!name) break;
    fields.push({ name, type: String.fromCharCode(buffer[p + 11]), size: buffer[p + 16] });
  }
  const span = fields.reduce((sum, field) => sum + field.size, 0);
  if (span !== recordLength - 1) fatal(`.dbf 声明记录长 ${recordLength} B，字段加起来是 ${span + 1} B`);
  if (headerEnd + count * recordLength > buffer.length) {
    fatal(`.dbf 声明 ${count} 行，但文件只装得下 ${Math.floor((buffer.length - headerEnd) / recordLength)} 行`);
  }
  return { fields, count, rowAt: (index) => {
    let offset = headerEnd + index * recordLength + 1;
    const row = {};
    // 取的是**原始文本**：切片里 `"6393.00000000000"` 那种带一串零的写法只能来自字段本身，解析成数再格式化就对不上了。
    for (const field of fields) {
      row[field.name] = buffer.subarray(offset, offset + field.size).toString('latin1').trim();
      offset += field.size;
    }
    return row;
  } };
}

/**
 * UTM（EPSG:32649 = WGS84 / UTM 49N，中央经线 111°，比例 0.9996，假东 500 km）反算。
 * 级数取 Snyder 标准式，与当初那份 `utm.py`（pip 的 `utm` 模块）同一套系数；末位差的风险由 `--verify`
 * 的逐位统计兜住——它报"多少坐标差、最大差多少"，而不是只报一个"不一样"。
 */
export function utmToWgs84({ easting, northing }, zone = UTM_ZONE, north = true) {
  const a = 6_378_137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const cm = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const x = easting - 500_000, y = (north ? northing : northing - 20_000_000) / k0;
  const mu = y / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  // 底点纬度 φ₁：μ 只是"等长纬度"的线性近似，它与真实纬度之间差的那一段（广州这一带 0.15°，约 17 km）
  // 必须由这条级数补回来。少了这一段，正反算就不闭合——这不是精度问题，是差一整座城的距离。
  const phi1 = mu + (1.5 * e1 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + 151 * e1 ** 3 / 96 * Math.sin(6 * mu) + 1097 * e1 ** 4 / 512 * Math.sin(8 * mu);
  const sin = Math.sin(phi1), cos = Math.cos(phi1), tan = Math.tan(phi1);
  const c1 = ep2 * cos * cos, t1 = tan * tan;
  const n1 = a / Math.sqrt(1 - e2 * sin * sin);
  const r1 = a * (1 - e2) / (1 - e2 * sin * sin) ** 1.5;
  const d = x / (n1 * k0);
  const phi = phi1 - (n1 * tan / r1)
    * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
      + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720);
  const lambda = cm + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
    + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / cos;
  return { lat: (phi * 180) / Math.PI, lng: (lambda * 180) / Math.PI };
}

/** 正算：盒是在 UTM 里开的，所以校区中心得先进 UTM。与反算同一套系数。 */
export function wgs84ToUtm({ lat, lng }, zone = UTM_ZONE, north = true) {
  const a = 6_378_137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const rad = (deg) => (deg * Math.PI) / 180;
  const cm = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const phi = rad(lat), bigA = Math.cos(phi) * (rad(lng) - cm);
  const sin = Math.sin(phi), tan = Math.tan(phi), n = a / Math.sqrt(1 - e2 * sin * sin);
  const t = tan * tan, c = ep2 * Math.cos(phi) ** 2;
  // 子午线弧长 M(φ)：三条 sin 项的符号是**交替**的（−、+、−），全写成加号会让广州这一带多出 0.15° 的弧，
  // 于是正算与反算互相不闭合——这是本轮实测抓出来的错，不是照抄时手滑。
  const m = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256) * phi
    - (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 * e2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  let northing = k0 * (m + n * tan * (bigA * bigA / 2 + (5 - t + 9 * c + 4 * c * c) * bigA ** 4 / 24
    + (61 - 58 * t + t * t + 600 * c - 330 * ep2) * bigA ** 6 / 720));
  if (!north) northing -= 20_000_000;
  return { easting: k0 * n * (bigA + (1 - t + c) * bigA ** 3 / 6
    + (5 - 18 * t + t * t + 72 * c - 58 * ep2) * bigA ** 5 / 120) + 500_000, northing };
}

const inside = (point, box) => point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;

/** 近场盒的三种口径。当初那份一次性脚本用的是哪一种，由 `--verify` 的条数对上与否判定，判完写回这段注释。 */
export const NEAR_RULES = {
  'vertex-box': (record, box) => record.parts.some((ring) => ring.some((point) => inside(point, box))),
  'bbox-box': (record, box) => (record.box
    ? record.box[0] <= box.maxX && record.box[2] >= box.minX && record.box[1] <= box.maxY && record.box[3] >= box.minY
    : NEAR_RULES['vertex-box'](record, box)),
  'centroid-box': (record, box) => inside(centroidOf(record), box),
};

function centroidOf(record) {
  let x = 0, y = 0, weight = 0;
  for (const ring of record.parts) for (let i = 1; i < ring.length; i++) {
    const cross = ring[i - 1].x * ring[i].y - ring[i].x * ring[i - 1].y;
    x += (ring[i - 1].x + ring[i].x) * cross / 2;
    y += (ring[i - 1].y + ring[i].y) * cross / 2;
    weight += cross / 2;
  }
  if (!weight) return record.parts[0]?.[0] ?? { x: 0, y: 0 };
  return { x: x / (6 * weight), y: y / (6 * weight) };
}

/** 校区中心进 UTM，再按米开盒。盒用平面米数，不用度数——两个轴上一度不是一段长度。 */
export function nearBox({ center = centre, half = boxMetres } = {}) {
  const origin = wgs84ToUtm(center);
  return { minX: origin.easting - half, maxX: origin.easting + half, minY: origin.northing - half, maxY: origin.northing + half, origin };
}

/**
 * 环分组，作用在**原始 .shp 环**上：ESRI 的约定是"顺时针是外环、逆时针是洞"（`signedArea < 0` 即顺时针）。
 * 切片里看到的却是反过来——外环全是逆时针、洞全是顺时针——因为输出还要过一道"先闭合再反转"（见 `emitRing`），
 * 反转把符号翻了一次。两处合起来才是那份切片：11,271 个外环逆时针 + 25 个洞顺时针 + 每个环开头一笔重复首点。
 * 这条链是 2026-10-06 逐条对 1,955 条真记录对出来的：分组按逆时针外环写、或者忘了反转，`--verify` 会报出
 * 一片类型/点数不符。
 */
export function groupRings(rings) {
  const polygons = [];
  for (const ring of rings) {
    if (signedArea(ring) < 0 || !polygons.length) polygons.push([ring]);
    else polygons[polygons.length - 1].push(ring);
  }
  return polygons;
}

const signedArea = (ring) => {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += ring[i - 1].x * ring[i].y - ring[i].x * ring[i - 1].y;
  return sum / 2;
};

const round = (value) => Number(value.toFixed(DECIMALS));

/** 一条 .shp 记录 + 对应 .dbf 行 → 一个 feature。`id` 用的是 .shp 自己的记录号，不重新编号。 */
export function featureOf(record, row) {
  // 分组在 UTM 空间做（`signedArea` 吃的是平面米数），分完再逐点反算：纬度差会让经纬度下的面积与米制下的
  // 差一个比例，虽然不至于翻号，但"按什么算的"写清楚比"结果碰巧一样"可靠。
  const polygons = groupRings(record.parts).map((parts) => parts.map((ring) => emitRing(ring.map((point) => {
    const { lat, lng } = utmToWgs84({ easting: point.x, northing: point.y });
    return [round(lng), round(lat)];
  }))));
  return { type: 'Feature', id: `gz-${record.number}`,
    properties: { osm_id: row[FIELDS.osm] ? row[FIELDS.osm] : null, dataset_id: row[FIELDS.dataset] ?? null,
      status: row[FIELDS.status] ?? null, orig_oid: row[FIELDS.oid] ?? null, rings: record.parts.length },
    geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons } };
}

/**
 * 输出一个环：**先闭合、再反转**。真归档的环本身是闭合的（正方形 5 个点），补一个首点再反转就成了
 * `[A, A, D, C, B, A]` —— 切片里那个"开头多一笔重复首点"的形状就是这么来的（也是外环从 ESRI 的顺时针
 * 变成切片里的逆时针的原因）。少这一步，`--verify` 会报一片"第 0 环点数 6 vs 5"与点位顺序不符。
 * 万一遇到不闭合的环，正常收尾后反转，不产出非法 GeoJSON。
 */
function emitRing(ring) {
  const first = ring[0];
  if (!first) return ring;
  return [...ring, first].reverse();
}

/** Python `json.dumps` 的默认分隔符是 `", "` / `": "`，与 `JSON.stringify` 不一样；要逐字节复现就得照它写。 */
export function pyDumps(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyDumps).join(', ')}]`;
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pyDumps(item)}`).join(', ')}}`;
}

export function buildSlice({ shapes, dbf, box = nearBox(), keep = NEAR_RULES[rule], lenient = false }) {
  if (!lenient && dbf.count !== shapes.length) {
    fatal(`.dbf 行 ${dbf.count} 与 .shp 记录 ${shapes.length} 不等，身份与属性会错位`);
  }
  const features = [];
  for (let i = 0; i < shapes.length; i++) if (keep(shapes[i], box)) features.push(featureOf(shapes[i], dbf.rowAt(i)));
  return features;
}

/**
 * `--prefix`：下载没完成时，把已落盘的那段 deflate 用同步冲刷解出来，得到 .shp 的**前一段**。
 * 这不是偷懒的替代品，是一条独立的降级路：慢链路上（本机实测 13 KB/s，整份 .shp 要两个多小时）也能当场
 * 验证"zip64 偏移、局部头、deflate、.shp 记录、.dbf 字段、UTM 反算、环方向、身份"整条链对不对。
 * CRC32 在这一段上验不了（它属于整条流），所以前缀模式只用于对账，写正式产物必须等整份取完。
 */
function prefixBytes(entry, path) {
  const temp = `${path}.deflate`;
  if (!existsSync(temp)) fatal(`--prefix 需要 ${temp}，先把 .shp 取一部分下来`);
  const raw = readFileSync(temp);
  const bytes = inflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
  log(`  前缀模式：${raw.length} B 压缩 → ${bytes.length} B .shp，即声明 ${entry.uncompressed} B 的 `
    + `${(bytes.length / entry.uncompressed * 100).toFixed(1)} %（CRC32 这一段验不了）`);
  return bytes;
}

async function main() {
  const started = Date.now();
  const prefix = flag('prefix');
  const entries = await centralDirectory();
  const members = entries.filter((entry) => entry.name.startsWith(`${MEMBER}.`));
  log(`${entries.length} 条成员里 ${MEMBER} 前缀命中 ${members.length} 条：`);
  for (const entry of members) log(`  ${entry.name}  压缩 ${entry.compressed} B → 解压 ${entry.uncompressed} B  method ${entry.method}`);
  if (flag('members')) return;
  const picked = {};
  for (const entry of members) {
    const extension = entry.name.split('.').pop().toLowerCase();
    if (!['shp', 'dbf', 'prj'].includes(extension)) continue;
    const path = `${cacheDir}/${entry.name.split('/').pop()}`;
    if (prefix && extension === 'shp' && !existsSync(path)) picked.shp = { bytes: () => prefixBytes(entry, path) };
    else picked[extension] = await cached(entry);
  }
  if (flag('fetch')) return;
  const prj = picked.prj.bytes().toString('utf8').replace(/\s+/g, ' ');
  log(`.prj：${prj.slice(0, 150)}`);
  if (!/UTM_Zone_49N|32649/i.test(prj)) fatal('.prj 声明的不是 UTM 49N，反算系数不能照这套走');
  const shapes = parseShapefile(picked.shp.bytes(), { lenient: prefix });
  const dbf = parseDbf(picked.dbf.bytes());
  log(`.shp 记录 ${shapes.length} 条（号段 ${shapes[0]?.number}~${shapes[shapes.length - 1]?.number}）；`
    + `.dbf ${dbf.fields.length} 列（${dbf.fields.map((f) => f.name).join(' ')}）、行 ${dbf.count}`);
  const box = nearBox();
  if (!NEAR_RULES[rule]) fatal(`未知口径 --rule ${rule}，可选：${Object.keys(NEAR_RULES).join(' / ')}`);
  log(`盒 ±${boxMetres} m，中心 UTM ${Math.round(box.origin.easting)} / ${Math.round(box.origin.northing)}，口径 ${rule}`);
  const features = buildSlice({ shapes, dbf, box, lenient: prefix });
  log(`留下 ${features.length} 条（Polygon ${features.filter((f) => f.geometry.type === 'Polygon').length} / `
    + `MultiPolygon ${features.filter((f) => f.geometry.type === 'MultiPolygon').length}）`);
  const text = pyDumps({ type: 'FeatureCollection', features });
  if (flag('verify')) return verify(text, features, { prefix, scanned: shapes });
  // 默认**不覆盖**仓库里那份切片：它是 `src/footprints.js` 与正式快照的上游输入，而本脚本与当年那份一次性
  // 脚本在末位上有 1 cm 级的差（见 README 的 P1-4a 一节）。要替换必须显式 `--write <路径>`。
  const target = opt('write', null);
  if (!target) {
    await mkdir(cacheDir, { recursive: true });
    const temp = `${cacheDir}/regenerated${prefix ? '-prefix' : ''}.geojson`;
    writeFileSync(temp, text);
    log(`没有给 --write：产物写到 ${temp}（${Buffer.byteLength(text)} B），${outPath} 未动。`);
    return;
  }
  if (prefix) fatal('前缀模式不写产物：那会把不完整的切片当成正式文件。去掉 --prefix 等整份取完再写。');
  writeFileSync(target, text);
  log(`已写 ${target}：${Buffer.byteLength(text)} B，SHA-256 ${createHash('sha256').update(text).digest('hex')}，`
    + `用时 ${Math.round((Date.now() - started) / 1000)} s`);
}

/**
 * 与仓库里那份切片对账：条数、身份、属性、逐位坐标、整文件逐字节。
 * 前缀模式下只比"已扫到的那段号段"，并且反向查一遍——号段里切片有、我没留下的，说明盒的口径不对。
 */
function verify(text, features, { prefix = false, scanned = [] } = {}) {
  const shipped = readFileSync(outPath, 'utf8');
  const original = JSON.parse(shipped);
  const byId = new Map(original.features.map((feature) => [feature.id, feature]));
  const extra = [], mismatch = [];
  let coordinates = 0, differing = 0, worst = 0;
  const flatten = (geometry) => (geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat());
  for (const feature of features) {
    const mine = byId.get(feature.id);
    if (!mine) { extra.push(feature.id); continue; }
    byId.delete(feature.id);
    if (JSON.stringify(mine.properties) !== JSON.stringify(feature.properties)) mismatch.push(feature.id);
    // 类型也要比：环数与点数在 Polygon 与 MultiPolygon 之间是同样的数，只比环数会让"洞被拆成两个体块"
    // 这一类错静默通过（本轮就是这么漏过一次，靠人工对 gz-274 才发现分组口径要看原始环向）。
    if (mine.geometry.type !== feature.geometry.type) {
      mismatch.push(`${feature.id} 类型 ${mine.geometry.type} vs ${feature.geometry.type}`);
      continue;
    }
    const a = flatten(mine.geometry), b = flatten(feature.geometry);
    if (a.length !== b.length) { mismatch.push(`${feature.id} 环数 ${a.length} vs ${b.length}`); continue; }
    for (let i = 0; i < a.length; i++) {
      if (a[i].length !== b[i].length) { mismatch.push(`${feature.id} 第 ${i} 环点数 ${a[i].length} vs ${b[i].length}`); continue; }
      for (let p = 0; p < a[i].length; p++) for (const axis of [0, 1]) {
        const delta = Math.abs(a[i][p][axis] - b[i][p][axis]);
        coordinates++;
        if (delta > 0) { differing++; worst = Math.max(worst, delta); }
      }
    }
  }
  const missing = [...byId.keys()];
  // 前缀模式下"切片里有、我没扫到"不算差：那只是下载还没到那一段。反向只查号段之内的：号段里切片有、
  // 我没留下的，就是盒的口径不对——这一条是前缀模式里真正能证伪的东西。
  // （号段用循环求，不用 `Math.max(...)`：40 万条记录展开成实参会把调用栈撑爆。）
  let highest = 0;
  for (const record of scanned) highest = Math.max(highest, record.number);
  if (!prefix) highest = Infinity;
  const missedInRange = prefix ? missing.filter((id) => Number(id.slice(3)) <= highest) : [];
  log(JSON.stringify({
    mode: prefix ? `prefix（扫到记录号 ≤ ${highest}）` : 'full',
    shipped: { features: original.features.length, bytes: Buffer.byteLength(shipped),
      sha256: createHash('sha256').update(shipped).digest('hex') },
    extracted: { features: features.length, bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex') },
    byteIdentical: shipped === text,
    idsOnlyInShipped: missing.length, idsOnlyInShippedWithinRange: missedInRange.length,
    idsOnlyInExtracted: extra.length, propertyOrRingMismatch: mismatch.length,
    coordinates, coordinatesDiffering: differing, worstCoordinateDelta: worst,
    sample: { onlyShippedInRange: missedInRange.slice(0, 5), onlyExtracted: extra.slice(0, 5), mismatch: mismatch.slice(0, 5) },
  }, null, 1));
  // 结论单独一行：结构类的差是"口径错"，末位类的差是"当年那份脚本的浮点路径不可恢复"（README 的 P1-4a），
  // 两者不能混在一句"不一致"里。退出码仍然只要有任何差就给 1，不让漂移悄悄过去。
  const structural = extra.length + mismatch.length + missedInRange.length;
  log(structural ? `结论：结构类不符 ${structural} 处 —— 提取口径有错，先修这个。`
    : coordinatesDifferingReport(coordinates, differing, worst));
  if (!prefix && shipped !== text) process.exitCode = 1;
  if (prefix && (mismatch.length || differing || extra.length || missedInRange.length)) process.exitCode = 1;
}

function coordinatesDifferingReport(coordinates, differing, worst) {
  if (!differing) return `结论：结构逐条一致，${coordinates} 个坐标值全部逐位相同。`;
  // 末位差换算成厘米：1e-7 度约 1.1 cm，按米取一位小数会印成 "0.0 m"，看着像没有差。
  const centimetres = (worst * 111320 * 100).toFixed(1);
  return `结论：结构逐条一致；坐标 ${differing}/${coordinates} 个值差在末位，最大 ${worst.toExponential(2)}°`
    + `（约 ${centimetres} cm）——逐字节一致不可达，见 README 的 P1-4a。`;
}

// 本目录名带非 ASCII（`3D街道`），`process.argv[1]` 与 `import.meta.url` 因此不是一条字串能比出来的，
// 必须两边都走 file URL；`node -e` 里 argv[1] 是 undefined，所以先要确认它有值。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`提取失败：${error.message}`); process.exit(1); });
}

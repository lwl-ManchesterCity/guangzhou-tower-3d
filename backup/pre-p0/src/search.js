const HAN = /\p{Script=Han}/u;

// OSM names carry spaces, full-width punctuation and mixed cases, and Chinese queries are typed without separators, so
// both sides are squeezed to letters, digits and Han characters before they are compared.
export function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '');
}

const fields = new WeakMap();

function searchable(entry) {
  let fieldsOfEntry = fields.get(entry);
  if (!fieldsOfEntry) {
    fields.set(entry, fieldsOfEntry = [entry.name, entry.nameEn, entry.street, `${entry.street} ${entry.house}`].map(normalizeText));
  }
  return fieldsOfEntry;
}

// Lower wins: a block whose own name opens with the query beats one that merely mentions it, and an address match
// ranks below any name so "广州塔" is not buried under 阅江西路's hundred door numbers.
function rank(entry, needle) {
  const [name, nameEn, street, address] = searchable(entry);
  if (name && name.startsWith(needle)) return 0;
  if (nameEn && nameEn.startsWith(needle)) return 1;
  if (name && name.includes(needle)) return 2;
  if ((address && address.startsWith(needle)) || (street && street.startsWith(needle))) return 3;
  if ((address && address.includes(needle)) || (street && street.includes(needle)) || (nameEn && nameEn.includes(needle))) return 4;
  return -1;
}

function compareIds(a, b) {
  // Keep legacy numeric way ordering; relation IDs use a locale-independent string order (after ways).
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a), right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function searchBuildings(entries, query, limit = 8) {
  const needle = normalizeText(query);
  if (!needle.length || (needle.length < 2 && !HAN.test(needle))) return [];
  return entries
    .map((entry) => [rank(entry, needle), entry])
    .filter(([score]) => score >= 0)
    .sort((a, b) => a[0] - b[0] || a[1].distance - b[1].distance || compareIds(a[1].osmId, b[1].osmId))
    .slice(0, limit)
    .map(([, entry]) => entry);
}

export async function loadSearchIndex(fetcher, url, timeoutMs = 15000) {
  let response;
  try {
    response = await fetcher(url, { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // fetch rejects with a bare TypeError when the network is out; the status line is Chinese everywhere else.
    throw new Error(error.name === 'TimeoutError' ? '检索索引下载超时，请检查网络后重试。' : '暂时无法下载检索索引，请检查网络后重试。');
  }
  if (!response.ok) throw new Error(`检索索引暂时不可用（HTTP ${response.status}）。`);
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data?.entries)) throw new Error('检索索引不完整，请重新打开搜索后重试。');
  return data.entries;
}

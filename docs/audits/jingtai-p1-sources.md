# 景泰小学 P1：建筑轮廓补充来源核查

对应 `docs/jingtai-upgrade-plan.md` 的 P1 第 1～3 步。本文件只记录已实测的结论与证据来源；凡本机取不到的数据，直接写明取不到，不用推断补位。

中心 23.17107, 113.26646；半径 2000 m；近场阈值 500 m（与 P0 审计同一套常量）。

## P1-1 最新 OSM 与现有快照的差异：无改善

`node scripts/prepare-jingtai.mjs --fetch --fetch-only --raw-dir=candidates/jingtai-p1 --out=candidates/jingtai-p1` 重新抓取一次完整快照（单次请求，不重试同一端点），再用 `node scripts/diff-jingtai-source.mjs data/jingtai-overpass.json candidates/jingtai-p1/jingtai-overpass.json --out=docs/audits/jingtai-source-diff.md` 按内容逐要素比对。明细见 `docs/audits/jingtai-source-diff.md`。

| 项目 | 基准 `data/` | 候选 `candidates/jingtai-p1/` |
| --- | --- | --- |
| OSM 时间戳 | 2026-09-22T06:51:02Z | 2026-09-23T01:13:01Z |
| 要素总数 | 23492 | 23492 |
| 建筑要素数 | 910 | 910 |
| 新增／删除／标签变化／几何变化（建筑） | — | 0／0／0／0 |

分区（同一几何相交规则，基准 → 候选）：100 m 0→0，200 m 2→2，300 m 17→17，500 m 157→157，1000 m 370→370，2000 m 908→908；近场净变化 **+0 栋**。

用新快照重跑产物生成器后，`candidates/jingtai-p1/` 与 `candidates/jingtai-p0/` 的 `jingtai-buildings.geojson`、`jingtai-buildings-index.json`、`jingtai-grounds.geojson` 三个文件逐字节相同；`jingtai-pois.json` 只有 115 个要素之外的信封字段变化（`source.osmTimestamp`、`source.rawSha256` 记录新快照），要素本身零差异。产物既已相同，P0 审计的分区数值对本候选同样成立，不重跑。

结论：**记录为「无改善」**。近场没有楼不是因为抓得不够勤。

## P1-2 底图与本地快照是否互补：不互补，且不可归因

`node scripts/probe-jingtai-basemap.mjs`（只读探测，不写数据；自校验先行：校园中心对本层命中 0、对 `school-campus` 用地命中 1、已知建筑命中 1，三项必须同时成立才采信后续数字）。结果见 `docs/audits/jingtai-basemap.json` 与 `docs/screenshots/jingtai-p1-basemap.png`。2026-09-23 重跑时修掉该脚本一处自身缺陷：截图路径原先取 `new URL(...).pathname`，而项目目录含非 ASCII 字符，`.pathname` 会把它百分号编码，Playwright 于是在仓库外另建了一层 `3D%E8%A1%97%E9%81%93/docs/screenshots/` 并把图写进去，`docs/screenshots/jingtai-p1-basemap.png` 因此一直不存在；改用 `fileURLToPath` 后重跑，逐项数字与下表完全一致（1994/1638/1989/1633/5，matched 10，snapshotInView 882），证据 JSON 除 `capturedAt` 外逐字段相同。

面积抽样（z16.5，8 像素步长，1994 个格点）：底图建筑层命中 1638 格，本地产物层命中 1989 格，两者同命中 1633 格，**只有底图命中的仅 5 格**。

身份核对（在瓦片源自身 `maxzoom: 14` 上用 `querySourceFeatures` 取 116 个建筑要素）：要素属性只有 `colour`、`render_height`、`render_min_height` 三列，**没有 `osm_id`、没有楼名、没有 kind**；113 个带数字 id 的元素里只有 10 个能对上快照，同镜头快照内有 882 栋，其中 872 栋在瓦片要素里找不到对应。

三条独立理由，任一成立都足以否定"从底图补轮廓"：

1. **同源且更旧**。底图 `openmaptiles` 的建筑层来自 OpenFreeMap 的 OSM 提取，瓦片 URL 里的日期是 `20260913_164504`，而本地快照的 OSM 时间戳是 2026-09-22。用一份更早的同源提取补更新的同源提取，只能引入过期轮廓。
2. **不可归因**。P1 要求每个补充要素带"原始身份"。瓦片要素不携带 OSM 身份，数字 id 与 OSM id 无法稳定对应（上面 10/113 的命中率即为此实测），因此从瓦片提取的轮廓既不能标注来源身份，也不能声称来自 OSM。
3. **不互补**。500 m 步长内底图独有格点 5/1994，且底图在本场景里只负责半径外（`distance > RADIUS_METERS`）的 `context-buildings`，半径内本来就不画底图建筑。

许可侧同时记一笔：底图 attribution 为 OpenFreeMap / OpenMapTiles / OpenStreetMap，属 ODbL 谱系，与本项目的 OSM 许可不冲突；冲突点在"混合许可能否合并再分发"尚未澄清，因此即使前两条成立，接入前仍需单独确认。

## P1-3 开放建筑矢量来源（Microsoft / Google Open Buildings / Overture）：无一通过覆盖检查

按"先核覆盖、再谈接入"的顺序检查三类非 OSM 来源。可达性先测：`api.github.com`、`bfppub.blob.core.windows.net`、`data.source.coop`、`*.s3.us-west-2.amazonaws.com` 可达；`storage.googleapis.com`、`sites.research.google`、`raw.githubusercontent.com`、`minedbuildings.z5.web.core.windows.net`、`bfppub.z5.web.core.windows.net` 超时或重置，Planetary Computer 的 `ms-buildings` 矢量瓦片端点对巴黎、东京同样返回 404（该端点已失效，不能当覆盖判据，故改用官方下载清单本身判定）。

| 来源 | 许可 | 坐标系 | 广州覆盖实测 | 判定 |
| --- | --- | --- | --- | --- |
| Microsoft Building Footprints（`dataset-links.csv`，2026-08-13 发行，30340 个瓦片） | README 声明 CDLA-Permissive-2.0（Planetary Computer 目录标 ODbL-1.0，两处不一致） | EPSG:4326 | 225 个区域名里没有任何中国大陆条目；按 Bing quadkey 索引，广州所在的 L5 前缀 `13212` 命中 **0** 个瓦片 | 覆盖未通过 |
| Google Open Buildings（Source Cooperative 云原生镜像 `country_iso=CN`，2713208 栋） | CC-BY-4.0（`collection.json`） | parquet 的 GEOMETRY 逻辑类型声明 EPSG:4326 | 只扫字典编码的 `quadkey` 列（每 row group 约 6 kB）：校园所在 z8 瓦片 `13212222` **0** 栋，其 3×3 邻域（每片约 143 km 宽）**0** 栋；CN 分区 271 万栋只落在 59 个 z8 瓦片，最近的有数据瓦片距校园 **486 km** | 覆盖未通过 |
| Overture Maps `theme=buildings`（`2026-08-19.0`） | 混合（CDLA-Permissive-2.0 等，按上游分别标注） | EPSG:4326 | 其建筑内容是上两家的聚合。两个上游在广州都是 0，非 OSM 增量预期为 0；且当前发行按 hash 分片（整个 release 987 个约 500 MB 文件），无瓦片级寻址，做同一负证明需扫约 50 GB | 不接入（依据上游） |

Google Open Buildings 扫描带三道自校验，全部通过才输出上述数字：quadkey 编码往返（校园 → `13212222` → 瓦片中心，偏差 64.6 km，小于该瓦片半宽）；逐 row group 读取的行数必须等于该组 `num_rows`；总和必须等于 `num_rows = 2713208`（首版未校验时曾把同一批行重复累加成 2.47 亿，正是这条不变量抓出来的）。同时打印最密集的 5 个 CN 瓦片及其中心坐标（97.7°～106.2°E，即云南、广西边境一带），证明该扫描"有楼时能看见楼"。

即便覆盖成立，这个镜像也还过不了另两道门：CN 分区只有 `area_in_meters`、`confidence`、`full_plus_code`、`geometry`、`quadkey`、`country_iso` 六列，**没有 `buildings_id` 与 `height`**，取不到"原始身份"，官方 v3 原始发行是否含这两列在本机无法核验（域名超时）；`confidence` 为影像推导线度（抽样 0.66～0.72），轮廓与真实楼体在密集城区的偏差无人核验过。

## P1-3b 东亚建筑矢量数据集（Zenodo 8174931）：覆盖与坐标系通过，逐要素溯源与许可链未通过

P1-3 落空后继续找到的第四个来源，也是本项目里**第一个通过覆盖检查**的非 OSM 矢量来源，因此单列。

- 记录：Qian Shi、Jiajun Zhu、Xiaoping Liu 等（中山大学地理科学与规划学院），*A first high-quality vector data of buildings in East Asian countries based on a comprehensive large-scale mapping framework*，DOI `10.5281/zenodo.8174931`，发布 2023-07-22，`license = cc-by-4.0`，`access_right = open`，资源类型为 Dataset，正文摘要仅一句（"filling the gaps in the existing public buildings data"）。
- 取法：Zenodo 单文件 `East_Asian_buildings.zip`（23,108,515,351 B，md5 `d356f487b19eaa13c6e12eb42ac3ca53`）支持 HTTP Range（实测 206），归档内 2878 个成员按 国家/省/地级市 切分，无需账号。目标成员 `China/Guangdong/Guangzhou.shp` 压缩 126,024,029 B、解压 261,559,312 B（整包的 0.55 %），本机实测 1,227 s 下完；解压字节数与中央目录声明的 `usize` 逐字节相等，作为传输自校验。
- 坐标系：`Guangzhou.prj` 为 **EPSG:32649**（WGS84 / UTM 49N，中央经线 111°E，单位米），不是 4326，必须先反算；文件 bbox x 700175–810161、y 2497588–2648977，校园 UTM 值 732018.6 / 2564263.7 落在其中。反算用 Snyder 四级级数自实现，2000 个随机点往返最大偏差 0.0009 m。
- 规模：`.shp` 记录 1,792,111 条，与 `.dbf` 声明行数完全一致（对齐自校验），shape type 全为 5（Polygon）。

覆盖结果与 P0 用同一条 `distanceToGeometry` 相交规则，数字可与 `docs/audits/jingtai-coverage.md` 直接对照（下三列均为"累计到该档"）：

| 分档(m) | OSM 原始要素（P0 审计） | 本数据集要素 | 其中 15 m 内无 OSM 轮廓对应 |
| --- | --- | --- | --- |
| 100 | 0 | 62 | **62** |
| 200 | 2 | 274 | 255 |
| 300 | 17 | 498 | 442 |
| 500 | 157 | 1046 | **785** |
| 1000 | 370 | 2722 | 1857 |
| 2000 | 908 | 8728 | 6062 |

P0 里 100 m 档为 0 栋的近场空洞，在这个数据集中有 62 个轮廓，且 62 个全部在 15 m 内找不到任何 OSM 轮廓对应（最近的 OSM 楼在 122–170 m 外）。两条控制实验保证这不是宽松过滤造出来的虚数：**正控制**——我们自己 156 栋近场 OSM 楼里 154 栋在该数据集中 0 m 命中（中位 0、P90 0、最大 53.14 m），说明投影反算与解析链路对得上实物；**负控制**——把中心北移 0.1°（≈11 km）后 2 km 内命中 0 条。

增量的几何质量（同一 15 m 判据）：100 m 档 62 个合计 7,508 m²，其中 <1 m² 有 1 个、1–20 m² 有 6 个、≥20 m² 有 55 个，质心相距 <1 m 的重复 2 对，任一顶点落在校园面（`way/1178149399`）内的 8 个、其中首顶点即在面内的 5 个（2026-09-23 用 `src/buildings.js` 的 `insideRing` 复测更正，原记「首顶点 0 个、增量全在校园外街区」不成立）；500 m 档 785 个增量里 <1 m² 19 个、1–20 m² 143 个（合计 20.6 % 属碎屑级）、≥20 m² 623 个、重复 17 对。接入前必须先按面积阈值与重叠合并筛一遍。

三道没过的门：

1. **逐要素来源无法记录**。`.dbf` 只有 `id`、`ORIG_OID`、`STATUS`、`ORIG_FID` 四列，近场抽样里 `STATUS` 取值 0/1/2，归档内 2878 个成员没有任何 README、LICENCE 或代码表成员，记录页也没有方法说明——按 P1「每个元素记录来源」的要求，这一层现在填不出值。
2. **许可链上游未清**。CC BY 4.0 是作者对自己成果品的声明；该团队配套论文与报道写明轮廓由高分辨率 Google Earth 影像提取（Remote Sensing 2024，2.8 亿栋），2025 年 ESSD 全球版另写明以人工筛选的 OSM 注记作训练。计划书禁止"从商业地图截图描摹并声称为 OSM 数据"，也禁止"把免费浏览当作再分发许可"——第三方给的开放许可不自动清掉上游影像条款，也不保证相对 OSM 的独立性。这一层不由我判定，属用户决定。
3. **没有高度，且成图早于现状**。字段里既无 `height` 也无 `levels`，解决不了 P0 记下的"156 栋只有 9.6 m 示意高度"（那是 P2 的事）；`.shp.xml` 的 `CreaDate` 是 20230423，比我们 2026-09-22 的 OSM 快照早 3 年 4 个月，只能当作历史影像判读结果，不能当现状。

因此本轮仍不改动 `src/` 与 `public/data/`，也不产出候选快照：在许可与逐要素溯源未定之前，任何候选数据都是半成品。

## 结论与解锁条件

四个来源核查下来，OSM 侧没有任何新增（P1-1），底图不互补且不可归因（P1-2），Microsoft / Google Open Buildings 两个开放矢量来源在广州为 0 覆盖、Overture 依据其上游不接入（P1-3）。唯一覆盖成立的是东亚建筑矢量数据集（P1-3b）：100 m 档 62 个轮廓、500 m 档净增 785 个，正好填上 P0 认定的近场空洞；但它的许可链上游（影像来源）与逐要素溯源（`STATUS` 无代码表、归档内无许可文本）都没有落地，高度字段为无。按计划书的验收句执行——**来源未通过覆盖、许可、坐标系检查前，不承诺接入成功**：本轮不改动 `src/` 与 `public/data/`，不描摹商业地图截图，不给校园教学楼编轮廓，不把 9.6 m 示意高度升格成"真实高度"。

要推进 P1-4～P1-6，需要下列任一项外部输入，且必须先单独确认录入范围与再分发授权：

1. 对 P1-3b 的取舍决定（最快可落地的路径）：该数据集覆盖与坐标系已实测通过，剩下的是一道授权判断——是否接受"作者声明 CC BY 4.0、但配套论文写明由高分辨率 Google Earth 影像提取、且无逐要素来源代码表"的轮廓进入本项目公开产物。若接受，接入方案已就绪：面积 <20 m² 丢弃、质心 <1 m 的重叠合并、15 m 内与 OSM 同位的以 OSM 为准、`jingtai-metadata.json` 记 DOI/发布日/md5/成图日期，来源三分类扩一类"影像推导线度（2023）"，并在卡片里明示它既不参与高度也不参与命名检索。**（本条已于 2026-09-23 由用户接受，先候选、后升为正式数据，见下文两节。）**
2. 具备明确开放许可、且许可文本能覆盖上游数据的中国大陆建筑轮廓数据集（含来源时间、许可文本、CRS、是否有逐要素稳定 id）。国内开放数据平台需按数据集逐条看许可，不能按"能免费浏览"推定可再分发。
3. 用户提供有合法使用权的资料：校园及周边总平面图、权属或物业提供的建筑底图、有授权的高分辨率影像，并注明允许描摹与再分发。
4. P0 遗留的近场核验清单 `docs/audits/jingtai-reference.json`（每项含位置、来源、核验日期、许可）。有了它，至少能把"现实中确实有楼"钉到具体位置，并在接入新来源后立刻量化命中率——这同样是对 P1-3b 那 62 个增量做人工判读的最直接办法。

## P1-4～P1-6 接入记录（2026-09-23，用户验收解锁条件 1）

用户以「先帮我吧景泰小学附近的居民楼复现吧，附近这么多居民楼，怎么什么都没有显示」指示接受上文解锁条件 1 的授权判断，即接受"作者声明 CC BY 4.0、配套论文写明由高分辨率影像判读、无逐要素来源代码表"的轮廓进入本项目。接入按候选交付：`public/data/` 与 `data/` 的正式快照逐字节未动，合并结果只写 `candidates/jingtai-p1-merge/`，是否升为正式数据由下一轮决定。

**提取。** `data/jingtai-eastasia-footprints.geojson`（4,361,112 B，SHA-256 `fb478410cfbc3cec9bf284859db3a2830fafd19dba768801e9bf848782fb9cb3`）是从归档的 `China/Guangdong/Guangzhou.shp` 按 Range 取成员、`inflateRaw` 流式解压、按 `.prj` 声明的 EPSG:32649 反算 WGS84 后落在校园 2 公里方框内的 11,257 条记录（11,245 个 Polygon、12 个 MultiPolygon，环全部闭合）。该切片由一次性探测脚本产出，尚未固化为仓库脚本（待办 P1-4a）；合并与校验只靠本地输入即可复现：`node scripts/merge-jingtai-footprints.mjs`。

**规则与数量。** `src/footprints.js` 的 `normalizeFootprints` 按固定顺序剔除：几何无效 0、2 公里外 2,535、任一顶点落入校园面 8、面积 <20 m² 1,789、与既有 OSM 轮廓间距 ≤15 m（以 OSM 为准）2,159、质心相距 <1 m 的重复 0；11,271 个面部件留下 4,780 个。合并后 2 公里内 5,686 栋 = OSM 906 + 影像轮廓 4,780。分档（OSM／合并）为 100 m 0／**48**、200 m 2／201、300 m 17／348、500 m 156／**772**、1000 m 370／1,828、2000 m 906／5,686。

**与 P1-3b 的对账。** 100 m 档 62 个增量到 48 栋的差来自两条规则：任一顶点落入校园面的 8 个（上文已把「首顶点 0 个」更正为「任一顶点 8 个、首顶点 5 个」），面积 <20 m² 的 7 个里另有 1 个同时落在校园面内，故 62 − 8 − 6 = 48；15 m 与 OSM 同位的判据两处一致，该档 `matches-osm` 为 0。P1-3b 记的「重复 2 对／17 对」是在未过滤的增量上由一次性探测脚本按其自带质心算法统计的，脚本已删除、口径无法在现有代码里复现；按融合规则自身的质心谓词复算，4,780 栋里质心相距 <1 m 的配对为 0，即重叠合并本轮实际触发 0 次。

**身份与呈现。** 轮廓 id 为 `eastasia/<序号>`、来源记录 id 为 `eastasia/gz-<shapefile 记录号>[#p部件号]`，两者都不匹配 `src/main.js` 中生成 OSM 链接的 `^(?:relation\/)?\d+$`，所以卡片不会出现 openstreetmap.org 链接，改为指向 Zenodo 记录页；`src/link.js` 的前缀白名单只放 `relation/` 与 `eastasia/`，`way/1`、`node/1` 一类仍拒绝解析。用途一律 `unknown`、高度一律 `heightSource: 'estimate'` 的 9.6 m 示意、不写任何名称与地址字段，因而 `searchIndex` 按「无名称且无街道即跳过」的既有规则自动把这些轮廓排除在楼名与地址检索之外。地图署名行新增「另有 4,780 个影像推导轮廓 / CC BY 4.0（2023）」。

**取证。** 审计重跑 `node scripts/audit-jingtai-coverage.mjs` 新增「候选合并」一行，100/500/2000 m 三档产物 48/772/5,686、转换缺失 0、同镜头已渲染 48/772/5,686；渲染证据 `docs/audits/jingtai-render-p1-merge.json` 由 `EVIDENCE_TAG=p1-merge BUILDINGS_FILE=candidates/jingtai-p1-merge/jingtai-buildings.geojson node scripts/probe-jingtai-render.mjs` 产出（首屏镜头视野内 2,563 栋、近景 1,417 栋，missing 均为 0），截图为 `docs/screenshots/jingtai-p1-merge-hero.png` 与 `jingtai-p1-merge-near.png`。交互实测：点击一栋轮廓得到卡片「未分类 · 距景泰小学直线 102 m／未命名轮廓（来源无名称）／轮廓来自 2023 年影像判读的开放矢量数据集；用途、名称与高度均未收录／占地约 230 m²」，链接为 `https://zenodo.org/records/8174931`，地址栏写作 `#map=16.7/23.17107/113.26646/0/55&b=eastasia/3520@23.170362,113.267426`，在新标签页打开同一链接卡片复现。回归：Node 测试 **261 项通过**（新增 `tests/footprints.test.js` 13 项，含 8 类合并校验注入；`tests/link.test.js` 新增命名空间项并把链接缺陷注入扩到 5 类），浏览器套件 **28 通过／2 项数据缺口 fixme／0 失败**，生产构建主包 1,637.69 kB／gzip 438.86 kB（较 P0 +1.52 kB）。

**仍未解决。** 覆盖率依旧不能评估：`docs/audits/jingtai-reference.json` 仍缺，「OSM 与影像数据集都没有」的近场位置是否真有楼仍无独立清单可证。高度依旧缺失：该来源既无 `height` 也无 `levels`，P0 记下的「近场楼全部只有 9.6 m 示意」一点没变，属 P2。时效：轮廓是 2023-04 的影像判读结果，比 2026-09-22 的 OSM 快照早 3 年 4 个月，2023 年之后建成的楼不会出现。许可：上游影像条款与 `STATUS` 代码表仍未落地，本轮是按用户决定接入，不代表该层已澄清。逐要素来源：`sourceRecord` 只能给到 shapefile 记录号，`dataset_id` 在 11,257 条里只有 6,712 个不同值，不能当唯一键。

**撤销。** 删除 `candidates/jingtai-p1-merge/`、`docs/audits/jingtai-footprint-merge.md`、`docs/audits/jingtai-render-p1-merge.json`、两张 `jingtai-p1-merge-*.png`、`src/footprints.js`、`scripts/merge-jingtai-footprints.mjs`、`tests/footprints.test.js`、`data/jingtai-eastasia-footprints.geojson` 与 `dist-p1merge/`，并还原行级改动：`src/main.js` 的 `EASTASIA_SOURCE` 导入与 `buildingFacts`／`showBuilding` 的 derived 分支、`src/map.js` 的 `buildingId` 字符串化与 `canton-buildings` 署名行、`src/link.js` 的前缀白名单、`scripts/audit-jingtai-coverage.mjs` 的候选行与逐产物渲染证据、`scripts/probe-jingtai-render.mjs` 的 `BUILDINGS_FILE`／`EVIDENCE_TAG` 注入、`tests/link.test.js` 的命名空间项。本段只描述候选那一轮：正式数据当时未改动，所以那一轮的撤销不需要重生成任何东西；正式数据的提升与撤销见下文 P1-7 段。

## P1-7 升为正式数据（2026-09-23，用户指令「升为正式数据」）

上一轮给出三条推进方式（升为正式数据／先固化提取脚本 P1-4a／先做 P2 视觉），用户选第一项，解锁条件 1 的取舍由此从「候选」变为「正式产物」。**上文「三道门未过」的结论没有被改写**：许可链上游与 `STATUS` 代码表仍未落地，本轮是把该风险按用户决定接进正式数据，不是把它判定为已澄清。

**流程。** ① 备份：`backup/pre-p1-merge/public/data/` 存提升前的 `jingtai-buildings.geojson`（906 栋，SHA-256 `a7936a92…9075`）、`jingtai-buildings-index.json`、`jingtai-metadata.json` 三个文件；`backup/pre-p1-merge/SHA256SUMS.txt` 里的路径相对项目根，`shasum -a 256 -c backup/pre-p1-merge/SHA256SUMS.txt` 必须在根目录跑，本轮实测按备份恢复后三行全部 OK。② 提升：`node scripts/merge-jingtai-footprints.mjs --out=public/data`。脚本先把输入里上一轮并入的轮廓与 `properties.sources` 信封剥掉，只用 ODbL 那一层作基线，所以重跑是完整重算而非追加：第二次运行的 OSM 底仍是 906 栋、校验和仍是 `a7936a92…`，产物与已评审的 `candidates/jingtai-p1-merge/jingtai-buildings.geojson` 逐字节相同（`b4bc8c03…4fd3`）。③ 登记：第二来源写进 `public/data/jingtai-metadata.json` 新增的 `footprintMerge` 段（来源、规则、剔除计数、分档、基线路径与校验和、两侧高度分布、索引条目数与一句说明），metadata 的 SHA-256 随之变为 `ed3d8f28…64f80`；`jingtai-buildings-index.json`、`jingtai-grounds.geojson`、`jingtai-pois.json` 逐字节未动。

**校验分工。** `validateJingtai` 的语义是「每个要素都能追溯到原始 OSM 元素」，对合并后的正式文件必然报 `Feature has no OSM source: eastasia/…`，因此它改为只跑 OSM 那一层（`tests/jingtai-data.test.js` 的 `osmFiles` 视图），新增层仍由 `validateMergedJingtai` 负责；缺陷注入表也搬到 OSM 视图上，否则首个报错来自影像轮廓、与注入的那条缺陷无关。`tests/footprints.test.js` 的复现测试从正式文件里剥出 OSM 底再重算，并断言正式产物 === 已评审候选：不剥离的话每条轮廓都会被判 `matches-osm`，测试必然通过却什么都没测。三处新断言各自做过注入——删掉 `formatCoverageReport` 的 note 行、把注入表改回 `files`、把剥离过滤器改成恒真——三条分别失败。

**审计与取证。** `scripts/audit-jingtai-coverage.mjs` 的正式行改名「正式快照（public/data，OSM＋东亚轮廓）」，「候选合并」行删除（同一文件审计两遍只多一列，不多证据）；正式行改用 `docs/audits/jingtai-render-p1-live.json`（`EVIDENCE_TAG=p1-live node scripts/probe-jingtai-render.mjs`，不带 `BUILDINGS_FILE`，直接探测 5174 上的正式数据：首屏镜头视野内 2,563 栋、近景 1,417 栋，missing 均为 0），截图为 `docs/screenshots/jingtai-p1-live-hero.png` 与 `jingtai-p1-live-near.png`。`formatCoverageReport` 新增一行来源说明，由审计脚本按产物里的 `footprintSource` 计数生成，用来挡住「产物 772 栋 vs 原始 157 处」被读成 OSM 快照新增长度。P0 的 `docs/audits/jingtai-render.json` 保留为 OSM 层的证据，测试里 OSM 视图仍以它核对（906 栋、产物存在但未渲染 0 栋）。

**新出现的代价。** 景泰建筑载荷从 368,632 B 涨到 3,207,852 B（gzip 后 61,704→363,137 B），而 dev 与 `vite preview` 都不压缩 `.geojson`，本地首屏就是 3.2 MB 原样传输。计划书 P2 第 6 条「数据显著增多后再评估空间分块和按需加载」由此从假设变为有实测触发条件的一项。帧率侧本台机器未见代价：5,686 栋下学校环绕 15 秒提交 900 帧、平均 59.99 fps、帧间隔 P95 17.6 ms、期间额外数据请求 0。

**回归。** Node 测试 **261 项通过／0 失败**；浏览器套件 **28 通过／2 项数据缺口 fixme／0 失败**（11.7 分钟，两条 fixme 仍是校内操场与校门步行距离，未补画）；生产构建主包 1,637.69 kB／gzip 438.86 kB、CSS 113.17 kB／gzip 17.19 kB、Worker 508.48 kB。随后按「重新跑一下测试确认没有回归」原样复跑两套：Node 仍 261／0，浏览器仍 28／2 fixme／0 失败（11.1 分钟），学校环绕段为 900 帧／15,001.4 ms／59.994 fps、p95 由 17.6 ms 变 17.5 ms，两次都远高于该断言的 50 fps 下限，属测量抖动不是回归。

**撤销。** 一条命令回到提升前（在项目根跑）：`cp backup/pre-p1-merge/public/data/jingtai-buildings.geojson backup/pre-p1-merge/public/data/jingtai-metadata.json public/data/`，随后 `shasum -a 256 -c backup/pre-p1-merge/SHA256SUMS.txt` 应三行 OK。撤销后还要同步三处期望，否则测试会拿正式数据去比候选记录：`tests/jingtai-data.test.js` 的 `liveSha256` 两个值改回 `a7936a92…`／`899e2576…`，`tests/coverage-audit.test.js` 正式行的 48／772／5,686 改回 0／156／906 并去掉 `jingtai-render-p1-live.json` 引用，`scripts/audit-jingtai-coverage.mjs` 的正式行标签与 `renderFor` 指回 `docs/audits/jingtai-render.json`。`src/footprints.js`、合并脚本、切片输入与 `candidates/jingtai-p1-merge/` 可以整批留着——不接正式数据时它们只是候选产物，不进运行时。

## 复现方式

- P1-1：上面两条命令；只写 `candidates/jingtai-p1/`，正式快照 `data/` 与其校验和未改动。
- P1-2：`node scripts/probe-jingtai-basemap.mjs`（需 dev 服务在 `http://127.0.0.1:5174`）。
- P1-3：一次性探测脚本，未纳入仓库（需临时安装 `hyparquet` 才能按 range 读远端 parquet）。核心判据两条：Microsoft `dataset-links.csv` 的区域名与 quadkey 索引；Google Open Buildings CN parquet 的 `quadkey` 列按 z8 前缀计数，校园瓦片为 0。
- P1-3b：一次性探测脚本，同样未纳入仓库，三步。① 取中央目录：`curl -r -400000 https://zenodo.org/api/records/8174931/files/East_Asian_buildings.zip/content` 后按 zip 尾部的 central directory 解析成员名、`csize`、`usize`、本地头偏移；② 按成员 Range 取字节并 `zlib.decompressobj(-15)` 流式解压（`.shp` 126,024,029 B→261,559,312 B，解压长度必须等于 `usize`）；③ 顺序遍历 shape record，用 `.prj` 声明的 EPSG:32649 反算成 WGS84 后交给 `distanceToGeometry` 分档，并跑上面那两条正/负控制。归档 md5 为 `d356f487b19eaa13c6e12eb42ac3ca53`，逐成员 Range 取法可复现，不必下整包 23.1 GB。
- P1-4～P1-6：`node scripts/merge-jingtai-footprints.mjs`（默认只写 `candidates/jingtai-p1-merge/`），输入是 `data/jingtai-eastasia-footprints.geojson` 与 `public/data/` 的 OSM 快照，不发网络请求；该切片本身由上面 P1-3b 的一次性脚本产出，尚未固化进仓库。
- P1-7：`node scripts/merge-jingtai-footprints.mjs --out=public/data` 提升，`node scripts/audit-jingtai-coverage.mjs` 重跑审计，`EVIDENCE_TAG=p1-live node scripts/probe-jingtai-render.mjs` 取正式数据的渲染证据（需 dev 服务在 `http://127.0.0.1:5174`）。提升可重复执行：脚本每次先从输入里剥掉上一轮并入的轮廓再重算，产物逐字节一致。

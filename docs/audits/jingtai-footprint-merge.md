# 景泰小学近场轮廓合并（已升为正式数据）

由 `node scripts/merge-jingtai-footprints.mjs --out=public/data` 生成；输入为本地文件，不发网络请求。已写入 `public/data/jingtai-buildings.geojson`（5686 栋）与 `public/data/jingtai-metadata.json` 的 `footprintMerge` 段；`jingtai-buildings-index.json`、`jingtai-grounds.geojson`、`jingtai-pois.json` 逐字节未动，撤销见 `backup/pre-p1-merge/`。

- 基线：从 `public/data/jingtai-buildings.geojson` 读出 906 栋，先剥离上一轮并入的 0 个轮廓，OSM 底为 906 栋。
- 建筑轮廓来源：东亚建筑矢量数据集（East Asian countries building vector data），DOI `10.5281/zenodo.8174931`，发布 2023-07-22，影像判读 2023-04-23，成员 `China/Guangdong/Guangzhou.shp`（EPSG:32649 反算为 WGS84），归档 md5 `d356f487b19eaa13c6e12eb42ac3ca53`。
- 许可：CC BY 4.0。作者声明 CC BY 4.0；配套论文写明轮廓由高分辨率商业影像判读，归档内无许可文本与 STATUS 代码表，上游影像条款未清。
- 规则：面积 < 20 m² 丢弃；质心相距 < 1 m 的重复保留较大轮廓；与既有 OSM 轮廓间距 ≤ 15 m 以 OSM 为准；轮廓顶点落入校园用地面内一律剔除。
- 身份：新增要素 `osmId = eastasia/<序号>`、`sourceId = eastasia/gz-<归档记录号>[#p<多边形号>]`，不写 OSM 链接；`heightSource` 恒为 `estimate`（数据集无 height/levels 字段，所有轮廓只能按默认 9.6 m 示意绘制）；`category` 恒为 `unknown`，无名称与地址字段（数据集无名称与地址字段，这些轮廓不参与楼名与地址检索）。
- 检索索引：`public/data/jingtai-buildings-index.json` 的 74 条楼名/地址条目全部仍指向 OSM 建筑，新增轮廓 0 条进入索引。

| 分档(m) | OSM 快照 | 本次新增 | 合并后 |
| --- | --- | --- | --- |
| 100 | 0 | 48 | 48 |
| 200 | 2 | 199 | 201 |
| 300 | 17 | 331 | 348 |
| 500 | 156 | 616 | 772 |
| 1000 | 370 | 1458 | 1828 |
| 2000 | 906 | 4780 | 5686 |

近场 500 m 内新增 616 栋；100 m 档由 0 栋变为 48 栋。

输入 11257 条记录 → 11271 个多边形部分 → 采用 4780 栋。剔除计数：

- `invalid-geometry`：0
- `outside-radius`：2535
- `inside-campus`：8
- `tiny-area`：1789
- `matches-osm`：2159
- `duplicate-footprint`：0

新增轮廓占地：中位 99 m²，合计 1,066,819 m²；100 m 档 48 栋，中位 77 m²。

高度来源分布：OSM 快照 {"estimate":897,"levels":5,"height":4} → 合并后 {"estimate":5677,"levels":5,"height":4}。

`validateMergedJingtai` 通过：OSM 部分逐字节未变，新增部分无 OSM 身份、无高度与命名声明、全部落在 2000 m 内且不在校园面内、无 < 1 m 的重复。耗时 2371 ms。

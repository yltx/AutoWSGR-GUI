# 地图情报快照工具

这个工具独立下载 AutoNoelle GraphQL 数据库中的地图情报，当前保存：

- 地图、节点和节点类型；
- 节点之间的带路条件、条件通过数量和概率权重；
- 节点敌方编成、阵型和编成内舰船；
- 掉落、迂回、夜战及路线可见性原始字段。

工具不修改 `resource/maps`，不接入 GUI，也不转换 AutoWSGR 舰种代码。采集层保留
服务端原始枚举和路线顺序，后续接入时再建立明确的数据映射。

## 运行

只需要 Python 3.12，不需要安装第三方包：

```powershell
python tools/map_intel/sync_map_intel.py `
  --output C:\AutoWSGR-Data\map-intel
```

可选参数：

```text
--scope CN             数据区服，默认 CN
--data-url URL         GraphQL 地址，必须使用 HTTPS
--timeout 30           单次 HTTP 请求超时秒数
```

命令成功时输出一行 `RESULT_JSON=...`，可供计划任务或 CI 读取。失败时退出码为
`1`，并且不会覆盖已有的有效数据。

## 输出

```text
<output>/
├── latest.json
└── snapshots/
    └── <data_sha256>.json
```

`latest.json` 是当前有效快照。`snapshots/` 按地图数据内容哈希保存历史版本：

- 数据没有变化时不会重复生成文件；
- 数据变化时先写入历史快照，再原子替换 `latest.json`；
- 下载不完整、游标异常、字段类型变化、引用不存在或写入失败时保留旧文件；
- 每份文件都包含查询哈希、数据哈希、抓取时间、区服和数量统计。

快照中的地图和节点按 ID 排序，路线、路线条件和敌方舰船保持服务端原始顺序。
外部服务新增枚举值时会原样保存；删除或改变已查询字段会导致本次更新明确失败。

## 定时更新

可以用 Windows 任务计划程序每天执行一次上述命令。任务应记录标准输出和退出码；
不要在命令成功前删除旧目录，也不要让多个任务同时写入同一个输出目录。

首次接入业务前，应固定并审核 `schema_version`、外部舰种映射和带路条件语义。
当前快照属于外部可重建数据，不应与用户计划或配置放在同一目录。

## 测试

```powershell
python -m unittest discover -s tools/map_intel -p "test_*.py" -v
```

测试覆盖 GraphQL 分页及无进展拒绝、稳定排序、内容寻址去重、快照元数据一致性、
严格 JSON 校验、无效数据拒绝和原子替换失败时保留旧文件。

# 发布版本与更新桥接规则

本文是维护者和开发 Agent 修改 GUI 版本、更新频道与 Release 工作流时的强制
契约。目标是确保已安装的 1.4.x Stable 和 2.x Alpha 客户端都能沿单调递增的
SemVer 路径进入后续 Stable，不依赖自动降级或用户手动覆盖安装。

## 版本格式

只发布以下两类 GUI 版本：

| 类型 | 格式 | 频道 | GitHub Release |
|---|---|---|---|
| Stable | `X.Y.Z` | `latest` | 正式版 |
| Alpha | `X.Y.Z-alpha.N` | `alpha` | prerelease |

新的 Alpha 必须带递增序号 `.N`。不要继续创建无序号的 `X.Y.Z-alpha`。不得在
同一发布线混用 beta、rc、dev 或非 SemVer 后缀。

## 2.1 首次稳定版桥接

线上已有最高 Alpha 为 `2.0.16-alpha`，其旧 updater 只接受 `alpha` 频道。
2.1 首次稳定版必须按以下顺序发布：

```text
2.0.16-alpha
→ 2.1.0-alpha.1
→ 2.1.0
```

禁止把首个 Stable 定为 `2.0.1`、`2.0.16` 或任何不高于现有 Alpha 的版本。
`allowDowngrade` 必须保持 `false`。

`2.1.0-alpha.1` 是迁移桥：

- 旧 `2.0.16-alpha` 通过 `alpha.yml` 发现它；
- Alpha 构建在 `allow_test_updates` 字段缺失时默认继续接收测试版；
- 新 updater 接受 Stable 和更高 Alpha；
- 用户关闭“允许测试版更新”后切换到 `latest`，等待 `2.1.0`，不降级。

## 双仓库发布责任

两个已发布客户端群使用不同更新源：

| 已安装用户 | 固定更新源 | 所需资产 |
|---|---|---|
| 1.4.x Stable | `yltx/AutoWSGR-GUI` | `latest.yml`、Stable EXE、blockmap |
| 2.0.x Alpha | `ShiinaKuroko/AutoWSGR-GUI` | `alpha.yml`、桥接 Alpha EXE、blockmap |

因此，不能只在其中一个仓库发布 `2.1.0` 后宣称所有旧用户可自动升级。

Stable 发布必须同时完成：

1. `yltx/AutoWSGR-GUI` 发布完整 `latest` 资产，覆盖 1.4.x。
2. `ShiinaKuroko/AutoWSGR-GUI` 发布完整 Stable 资产。
3. Stable Release 在迁移窗口内附带 `2.1.0-alpha.1` 的 `alpha.yml`、EXE 和
   blockmap，覆盖在 Stable 发布后才恢复检查更新的旧 Alpha 用户。
4. 两边资产校验通过后再公开 Release；任何权限、Tag、资产冲突都必须
   fail closed。

后续 Stable 成为 Release feed 最新条目时，在维护者明确结束旧 Alpha 迁移窗口
之前，也必须继续携带兼容 Alpha 三件套，否则休眠客户端可能再次被阻断。

## 后续版本号选择

- `2.1.0-alpha.N` 只能递增 `N`，Stable 为 `2.1.0`。
- `2.1.0` 发布后，下一个测试线从 `2.1.1-alpha.1` 开始；不要发布
  `2.1.0-alpha.N` 的新构建。
- 下一个 Stable 是 `2.1.1`，并满足
  `2.1.1-alpha.N < 2.1.1`。
- 只有不兼容契约或明确产品代际变化才提升 minor/major；不要用版本号规避
  更新频道或历史 Alpha 排序问题。
- 已发布版本、Tag、清单和资产不可覆盖或复用。

## Agent 修改发布代码前的门禁

任何 Agent 在修改 `package.json`、builder 配置、updater、Release workflow 或
频道清单前，必须：

1. 查询两个仓库当前最高 Stable 和 Alpha。
2. 用 SemVer 证明所有受支持客户端到候选版本都是严格向上升级。
3. 检查旧客户端实际写死的 repository、channel 和候选校验逻辑。
4. 为 Stable 和 Alpha 各生成一次真实 NSIS 候选并运行
   `npm run test:release-package`。
5. 验证 Stable 默认不接受 Alpha、桥接 Alpha 可进入 Stable、
   `allowDowngrade` 仍为 `false`。
6. 核对两个更新源均有写权限、无同名 Tag/Release/资产冲突。
7. 未完成真实 feed 下载验证时，只能说明“候选与离线契约通过”，不得宣称
   已安装用户能够在线收到更新。

## 禁止事项

- 不得让 `alpha.yml` 声明 Alpha 版本却下载版本号不同的 Stable 安装包。
- 不得通过开启 downgrade 把高版本 Alpha 强制降到低版本 Stable。
- 不得只改 GitHub Release 的 prerelease 标志而忽略客户端频道清单。
- 不得在一个仓库发布后静默跳过另一个仓库。
- 不得在 release workflow 中把写 Token 暴露给构建和测试步骤。
- 不得删除或移动已有远端 Tag 来修复发布错误。

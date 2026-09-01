# ADR-001：当前运行时边界

- 状态：已接受
- 基线：当前工作区代码，包括未提交改动
- 范围：Renderer、Electron Main、Python 后端、存储、迁移和更新

## 背景

项目同时包含浏览器运行时、Node/Electron 运行时和 Python 后端。方案、配置和
任务又存在多个持久化来源。若状态所有权或依赖方向不明确，容易出现两份状态、
View 直连文件系统、安装目录被写入、迁移不可重试等问题。

以下决策是当前实现必须保持的边界。

## 决策 1：Renderer 单向数据流

```text
Repository / Model -> Controller -> ViewObject -> View
View -> 用户意图 -> Controller
```

- Controller 编排，不拥有 DOM。
- View 拥有 DOM 和局部视觉状态，不访问有状态 Model、Adapter、ApiClient 或
  ElectronBridge。
- Model 拥有领域状态和规则，不操作 DOM。
- Adapter 隔离 IPC、HTTP、WebSocket、序列化和浏览器存储。
- Shared 只包含无状态、跨运行时可复用逻辑。

边界由 `test-renderer-architecture.js` 强制。

## 决策 2：组合根不承载业务规则

`AppController` 是 Renderer 组合根，`electron/main.ts` 是 Main 组合根。它们
允许创建对象、注入依赖、注册生命周期和协调顶层流程，不实现：

- YAML Codec。
- 路径安全。
- 方案归一化。
- Python/更新策略。
- 舰队分配规则。
- 文件持久化细节。

业务分别进入 Controller 用例模块、Model、Service、Repository 或 Codec。

## 决策 3：Preload 是唯一 Electron 桥

Renderer 只通过 `window.electronBridge` 使用 Main 能力，且 Controller 依赖
`IpcAdapter` 裁剪后的窄 Gateway。`src/types/ipc.ts` 是桥接 DTO 的类型来源。

新增通道必须同步 preload、Main IPC、Adapter 和契约测试。同步 getter 的
`sendSync/ipcMain.on` 配对不能单侧修改。

## 决策 4：系统资源只读，用户数据写 userData

| 数据 | 位置 |
|---|---|
| 系统作战/编队/日常方案、地图、内置模板、强化数据 | `resource/` |
| 用户作战方案 | `userData/user_battle_plans/` |
| 用户编队方案 | `userData/user_team_plans/` |
| 用户日常方案 | `userData/user_daily_plans/` |
| YAML/GUI 设置、任务组、用户模板 | `userData/` |
| 舰船资料库工作副本 | `userData/ship-library/` |
| 舰船资料库内置源 | `resource/ship-library/`，只读 |
| 迁移账本 | `userData/.migration-state.json` |
| 执行计划 | temp 的进程专属目录 |

安装目录中的可变文件只作为旧迁移来源。通用文件 IPC 不获得任意磁盘读写权。

## 决策 5：配置是跨文件事务

`usersettings.yaml` 和 `gui_settings.json` 是不同域，但设置页一次保存必须保持
一致：

```text
写 YAML -> 原子写 JSON -> 失败则恢复 YAML -> 成功后更新 Renderer 内存
```

`GuiSettingsStore` 保留未知顶层字段；新的旧配置转换需要独立迁移标记。

## 决策 6：方案使用 Codec/Repository/Service

- Codec：结构、兼容和未知字段保留。
- Repository：系统/用户来源、路径、文件和原子写入。
- Service：导入、保存、重命名、删除、关联和运行时准备。
- IPC：参数和结果边界。

Renderer 的 `PlanModel.rawRoot` 保留未建模 YAML。系统和用户同名文件仍是不同
identity。运行前由 `RuntimePlanService` 展开到临时目录。

## 决策 7：普通编队与决战状态独立

`FleetPlannerController` 独占普通 `FleetDraft`，
`DecisivePlanController` 独占 `DecisiveFleetDraft`。两者共享
`ShipGalleryView` 视觉行为，但不共享草稿、文件 identity 或保存状态。

共享图库必须用 `AbortController` 和 `ResizeObserver.disconnect()` 完整释放，
释放链到达 `AppController.onBeforeUnload`。

## 决策 8：调度区分轮次与逻辑任务

- `id`：物理轮次。
- `logicalId`：有限/无限任务、重试、gap 和修理等待的稳定身份。
- Cron pending 和取消使用 `logicalId`。
- 未到终点或战果不满足的成功轮次不减少 `remainingTimes`。
- 自动任务记录实际完成/处理，不在入队时提前标记。

自动战役固定每日 8 次正常结算。常规出击额度按计划来源、文件和舰队去重。

## 决策 9：迁移是可重试状态机

`MigrationStateStore` 独占 `.migration-state.json`：

1. 完成 marker 只合并，不覆盖。
2. 文件全部成功后才完成阶段。
3. 失败只重试未完成项。
4. 源文件不修改、不删除。
5. 同名不同内容保留“（旧版）”。
6. 旧来源用 started/configuration-complete/complete 封存。

当前主要版本为用户数据 v6、旧方案 v7。

## 决策 10：后端来源与能力先验证

managed 和 external 使用唯一明确 AutoWSGR 来源。启动前检查：

- 实际 import 路径。
- OCR GPU 和截图环境变量行为。
- `autowsgr.server.main:app` 的 ASGI 能力。
- Python 3.12/3.13、依赖和 CUDA。

不满足时直接失败，不回退到另一后端来源。

## 决策 11：启动与退出顺序固定

单实例锁必须早于更新、迁移、pip 和窗口。pending 更新必须早于迁移和窗口。

退出时必须先保存窗口状态，再正式停止后端、等待进程树、停止内置 ADB，最后
退出。无法确认释放时阻止退出和更新安装。

## 决策 12：生成源与运行产物分离

- HTML 源：`src/view/html/**`
- SCSS 源：`src/view/styles/**/*.scss`
- Electron 运行：生成的 `src/view/index.html` 和 `styles.css`
- Renderer 运行：`dist/renderer.bundle.js`

生成的 HTML/CSS 提交到仓库；partial 和 TypeScript 不打入安装包。生成文件不
手改。

## 后果

- 新状态必须先确定唯一所有者。
- 新文件必须先确定只读资源或 userData 位置。
- 新共享组件必须有真实复用和完整生命周期。
- 新迁移必须有独立 marker 与失败重试测试。
- 新 IPC 必须补桥接契约测试。
- 修改调度身份、后端来源或退出顺序时必须增加对应领域/Service 测试。

# `src` TypeScript 模块索引

本索引按当前工作区统计，共 134 个 TypeScript 文件。用途是快速定位，不替代
具体专题文档。

```text
src/
├─ adapter/      6
├─ controller/  42
├─ model/       25
├─ view/        40
├─ types/        7
├─ shared/      13
└─ utils/        1
```

## Adapter（6）

| 文件 | 责任 |
|---|---|
| `ApiAdapter.ts` | HTTP 与 WebSocket 传输实现 |
| `IpcAdapter.ts` | 将 ElectronBridge 裁剪为用例 Gateway/Repository |
| `JsonAdapter.ts` | JSON 编解码 |
| `YamlAdapter.ts` | YAML 编解码和结构辅助 |
| `StorageAdapter.ts` | 键值存储契约与 localStorage 实现 |
| `index.ts` | Adapter 实例和类型集中导出 |

## Controller（42）

### `controller/app`（12）

| 文件 | 责任 |
|---|---|
| `AppController.ts` | Renderer 组合根和全局生命周期 |
| `AutomaticDecisiveTask.ts` | 自动决战两种来源的请求构造 |
| `ConfigController.ts` | 配置候选、事务保存和运行时同步 |
| `constants.ts` | 应用层展示和任务常量 |
| `CurrentFleetController.ts` | 当前任务舰队 ViewObject |
| `NavigationController.ts` | 页面与方案标签导航 |
| `OperationsController.ts` | 远征、奖励等快捷操作 |
| `rendering.ts` | 主页面 ViewObject |
| `ScheduledTaskLoader.ts` | 自动化设置到 SchedulerTask |
| `SchedulerBinder.ts` | Scheduler/Cron/日志/UI 联结 |
| `SchedulerRuntimeTracker.ts` | 运行日志派生状态 |
| `SettingsController.ts` | 环境、设备、资料库、更新和主题 |

### `controller/startup`（3）

| 文件 | 责任 |
|---|---|
| `StartupController.ts` | Renderer 启动总编排 |
| `connection.ts` | 后端健康、系统启动与连接 |
| `envAndUpdates.ts` | 环境准备和 GUI 更新检查 |

### `controller/plan`（12）

| 文件 | 责任 |
|---|---|
| `BattlePlanLoaderController.ts` | 受管方案选择器 |
| `DecisivePlanController.ts` | 决战草稿和持久化 |
| `FleetPlannerController.ts` | 普通编队草稿和持久化 |
| `fleetViewObjects.ts` | 编队 DTO 到 ViewObject |
| `nodeEditor.ts` | 节点编辑意图 |
| `PlanController.ts` | 当前作战方案和地图 |
| `PlanFleetPresetController.ts` | 方案舰队预设清单 |
| `PlanManagementController.ts` | 方案管理用例 |
| `planManagementViewObjects.ts` | 关联和删除影响推导 |
| `presetFlow.ts` | 独立任务预设流程 |
| `rendering.ts` | 方案预览 ViewObject |
| `selectedNodes.ts` | 路线默认、规范化和执行校验 |

### `controller/taskGroup`（8）

| 文件 | 责任 |
|---|---|
| `TaskGroupController.ts` | 任务组 CRUD 和 ViewObject |
| `TaskListLoaderController.ts` | 任务列表批量载入 |
| `DailyTaskLoaderController.ts` | 日常方案选择 |
| `addItems.ts` | 添加四类任务条目 |
| `contextMenu.ts` | 条目上下文操作 |
| `managedPlanReader.ts` | 读取受管作战/日常方案 |
| `metaLoader.ts` | 条目展示元数据 |
| `queueLoader.ts` | 条目到 SchedulerTask |

### `controller/template`（5）

| 文件 | 责任 |
|---|---|
| `TemplateController.ts` | 模板兼容链路协调 |
| `crud.ts` | 模板 CRUD/导入导出 |
| `selectors.ts` | 模板参数选择 |
| `useTemplate.ts` | 模板实例化 |
| `wizard.ts` | 模板创建向导 |

### 其他（2）

| 文件 | 责任 |
|---|---|
| `contracts.ts` | 跨流程最小 Host 契约 |
| `migration/MigrationConflictController.ts` | 迁移冲突复核 |

## Model（25）

### 根模型（6）

| 文件 | 责任 |
|---|---|
| `ApiClient.ts` | AutoWSGR HTTP/WS 客户端 |
| `ConfigModel.ts` | YAML 配置和 GUI automation |
| `MapDataLoader.ts` | 地图读取与缓存 |
| `PlanModel.ts` | 作战方案解析、编辑和未知字段保留 |
| `TaskGroupModel.ts` | 任务组 v4 状态、迁移和持久化 |
| `TemplateModel.ts` | 内置/用户模板兼容 |

### `model/fleet`（7）

| 文件 | 责任 |
|---|---|
| `DecisiveFleetDraft.ts` | 决战草稿 |
| `FleetDraft.ts` | 普通编队草稿和 DTO 转换 |
| `FleetDraftEditor.ts` | 编辑意图应用 |
| `FleetPresetIdentity.ts` | 编队预设身份 |
| `FleetRuleMapper.ts` | 规则到 API 映射 |
| `ShipMatcher.ts` | 舰船匹配 |
| `index.ts` | Fleet 领域出口 |

### `model/scheduler`（11）

| 文件 | 责任 |
|---|---|
| `CampaignDailyQuota.ts` | 战役每日正常结算额度 |
| `CronScheduler.ts` | 每分钟自动任务触发 |
| `ExpeditionTimer.ts` | 远征倒计时 |
| `NormalFightDailyQuota.ts` | 自动出击每日额度状态 |
| `RepairManager.ts` | 泡澡和轮换编队 |
| `Scheduler.ts` | 任务生命周期 |
| `SchedulerRepairPolicy.ts` | 修理调度纯策略 |
| `SchedulerTaskPolicy.ts` | 任务构建和插入纯策略 |
| `StopConditionChecker.ts` | 三阶段停止条件 |
| `TaskQueue.ts` | 就绪/延迟队列 |
| `index.ts` | Scheduler 领域出口 |

### 统计（1）

| 文件 | 责任 |
|---|---|
| `statistics/DailySortieStats.ts` | 今日出征和评级统计 |

## View（40）

### 配置（4）

| 文件 | 责任 |
|---|---|
| `config/ConfigView.ts` | 设置页 Facade |
| `config/ConfigAutomationView.ts` | 自动任务局部视觉 |
| `config/ConfigRuntimeView.ts` | 环境与更新局部视觉 |
| `config/settingSelectWidth.ts` | 下拉宽度纯 DOM 辅助 |

### 主页面（6）

`main/MainView.ts` 组合 `NavigationView.ts`、`StatusBar.ts`、
`TaskQueueView.ts`、`LogView.ts` 和 `FleetPreviewView.ts`。

### 方案与编队（16）

| 文件 | 责任 |
|---|---|
| `BattlePlanLoaderView.ts` | 作战方案选择浮窗 |
| `DecisivePlanView.ts` | 决战页 |
| `FleetEditorView.ts` | 舰位和拖放编辑 |
| `FleetGalleryView.ts` | 普通舰队图库适配 |
| `FleetPlannerView.ts` | 普通舰队 Facade |
| `FleetPresetView.ts` | 方案内舰队预设 |
| `FleetRuleView.ts` | 舰位规则编辑 |
| `GalleryShipCollection.ts` | 图库筛选/排序纯计算 |
| `MapView.ts` | 地图 |
| `NodeEditorView.ts` | 节点编辑器 |
| `PlanManagementView.ts` | 方案管理 |
| `PlanPreviewView.ts` | 方案页 Facade |
| `ShipArtwork.ts` | 舰船卡片图片结构 |
| `ShipGalleryView.ts` | 两页面共享舰船图库 |
| `TeamPlanListUi.ts` | 编队列表纯 UI 辅助 |
| `TeamPlanLoaderView.ts` | 编队方案选择 |

### 任务组与模板（6）

- `taskGroup/DailyTaskLoaderView.ts`
- `taskGroup/TaskGroupView.ts`
- `taskGroup/TaskListLoaderView.ts`
- `template/SelectorDialog.ts`
- `template/TemplateLibraryView.ts`
- `template/TemplateWizardView.ts`

### 共享、迁移、引导和主题（8）

- `shared/AnimatedSelect.ts`
- `shared/DialogHelper.ts`
- `shared/LoaderDialog.ts`
- `shared/scrollPosition.ts`
- `shared/ShipAutocomplete.ts`
- `migration/MigrationConflictView.ts`
- `setup/SetupWizardView.ts`
- `theme.ts`

## Types（7）

| 文件 | 契约 |
|---|---|
| `api.ts` | AutoWSGR REST/WS 和 TaskRequest |
| `fleetEditor.ts` | 编队编辑意图 |
| `ipc.ts` | ElectronBridge 与 Main DTO |
| `model.ts` | 配置、方案、模板等领域类型 |
| `scheduler.ts` | SchedulerTask、状态和回调 |
| `statistics.ts` | 出征统计 |
| `view.ts` | Controller 到 View 的 ViewObject |

## Shared（13）

| 文件 | 责任 |
|---|---|
| `campaign.ts` | 每日战役固定次数 |
| `decisiveAutomation.ts` | 自动决战来源 |
| `decisivePlan.ts` | 决战持久化契约 |
| `fleetShipTypes.ts` | 22 舰种公开规则 |
| `legacyDecisiveAutomation.ts` | 旧决战字段归档 |
| `lootPlans.ts` | 战利品计划稳定标识 |
| `migrationConflicts.ts` | 迁移冲突 DTO |
| `nativeFleetShipTypes.generated.ts` | 从 AutoWSGR 同步的生成快照 |
| `nodeDecision.ts` | 节点决策纯规则 |
| `normalFightQuota.ts` | 自动出击额度纯规则 |
| `shipCatalog.ts` | 只读舰船目录辅助 |
| `shipNameNormalizer.ts` | 舰名规范化 |
| `taskPreset.ts` | 独立任务预设 Codec |

`shared` 只能放无状态、无 DOM、无 Electron、无浏览器存储的跨层逻辑。

## Utils（1）

`utils/Logger.ts` 统一 Renderer 日志缓冲、输出和刷新。

## 定位方法

文件数会随实现变化。新增、删除或移动模块后，用以下命令核对本索引：

```powershell
rg --files src -g "*.ts"
rg -n "export (class|interface|type|function|const|enum)" src
```

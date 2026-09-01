# `src` TypeScript 模块拆分方案

## 1. 范围和结论

本方案是历史拆分记录，早期阶段曾覆盖 `src/` 下 77 个 TypeScript 文件，阶段中间曾
记录 97 个文件。它不定义当前目录数量；当前模块和职责以
`docs/architecture/09-src-typescript-catalog.md` 为准：

| 目录 | 文件数 |
|---|---:|
| `controller` | 33 |
| `view` | 28 |
| `model` | 22 |
| `types` | 5 |
| `adapter` | 6 |
| 其他 `src` 目录 | 3 |

拆分不以行数为唯一标准。只有出现以下情况才拆：

1. 一个文件包含多个独立变化原因。
2. View、Controller、Model 之间发生越层调用。
3. YAML、JSON、IPC、HTTP、WebSocket 或 `localStorage` 没有明确适配边界。
4. 多个界面重复实现同一套舰船筛选、拖拽或规则转换。
5. 可以提取纯策略，同时不产生第二份可写状态。

本次只调整 Renderer 的模块边界，不改变 IPC channel、HTTP API、YAML 格式、
任务队列行为、candidate-only 语义和用户数据目录。

## 2. 目标边界

```text
View
  只持有 DOM 引用、渲染 ViewObject、发出用户操作回调
  不直接调用全局 electronBridge、localStorage、js-yaml 或有状态 Model
  可以读取类型、不可变目录和无状态领域函数

Controller
  持有页面/用例状态，协调 View、Model 和 Repository
  不直接依赖 YAML/JSON parser，不使用 any 绕过 Host/Port 契约

Model
  持有领域状态和纯业务规则
  不直接访问 window、document、electronBridge 或 localStorage

Adapter
  负责 IPC、REST、WebSocket、YAML、JSON 和浏览器存储
  对 Controller/Model 暴露最小接口
```

状态所有权保持不变：

| 状态 | 唯一所有者 |
|---|---|
| 当前任务、调度状态 | `Scheduler` |
| 就绪队列、延迟重试队列 | `TaskQueue` |
| Cron 定时器和 pending 标记 | `CronScheduler` |
| 泡澡舰船集合 | `RepairManager` |
| 当前作战方案 | `PlanController` |
| 舰队编辑草稿 | `FleetPlannerController` + 单个 `FleetDraft` |
| 决战舰队草稿 | `DecisivePlanController` + 单个 `DecisiveFleetDraft` |

## 3. 最终目录

实现采用完整边界和完整业务功能作为文件粒度，没有继续执行早期草案中的微型
Repository、Codec 或 helper 拆分。下列目录是 S6 收口后的实际结构：

```text
src/
├─ adapter/
│  ├─ ApiAdapter.ts
│  ├─ IpcAdapter.ts
│  ├─ JsonAdapter.ts
│  ├─ StorageAdapter.ts
│  ├─ YamlAdapter.ts
│  └─ index.ts
├─ controller/
│  ├─ app/
│  │  ├─ NavigationController.ts
│  │  ├─ OperationsController.ts
│  │  ├─ AppController.ts
│  │  ├─ ConfigController.ts
│  │  ├─ SchedulerBinder.ts
│  │  └─ SettingsController.ts
│  ├─ plan/
│  │  ├─ BattlePlanLoaderController.ts
│  │  ├─ DecisivePlanController.ts
│  │  ├─ FleetPlannerController.ts
│  │  └─ PlanController.ts
│  ├─ startup/
│  ├─ taskGroup/
│  └─ template/
├─ model/
│  ├─ fleet/
│  │  ├─ DecisiveFleetDraft.ts
│  │  ├─ FleetDraft.ts
│  │  ├─ FleetRuleMapper.ts
│  │  ├─ ShipCatalog.ts
│  │  ├─ ShipMatcher.ts
│  │  ├─ ShipNameNormalizer.ts
│  │  └─ index.ts
│  └─ scheduler/
│     ├─ SchedulerRepairPolicy.ts
│     ├─ SchedulerTaskPolicy.ts
│     └─ index.ts
├─ view/
│  ├─ plan/
│  │  ├─ FleetPlannerView.ts
│  │  ├─ FleetEditorView.ts
│  │  ├─ FleetRuleView.ts
│  │  ├─ FleetGalleryView.ts
│  │  ├─ PlanManagementView.ts
│  │  └─ TeamPlanLoaderView.ts
│  ├─ config/
│  ├─ main/
│  ├─ setup/
│  ├─ shared/
│  ├─ taskGroup/
│  └─ template/
└─ types/
   ├─ api.ts
   ├─ ipc.ts
   ├─ model.ts
   ├─ view.ts
   └─ scheduler.ts
```

无引用的 Controller barrel 已删除。`model/fleet/index.ts` 和
`model/scheduler/index.ts` 仍有实际调用方，因此继续作为领域公共入口。

## 4. Controller 逐文件映射

| 现有文件 | 处理 | 目标 |
|---|---|---|
| `controller/app/AppController.ts` | 收口完成 | 保留唯一组合根；设置页交互进入 `SettingsController`，心跳由 `StartupController` 持有 |
| `controller/app/ConfigController.ts` | 收口完成 | 保留完整配置用例协调，通过公开方法更新最小依赖，不再绕过私有 Host |
| `controller/app/SchedulerBinder.ts` | 保留并收口 | 继续统一绑定 Scheduler/CronScheduler 回调，不复制调度状态 |
| `controller/app/SettingsController.ts` | 新增并收口 | 集中设置页环境检测、ADB、舰船库、更新检查和主题交互 |
| `controller/app/constants.ts` | 保留并清理 | 保留优先级和状态文案；删除无引用的 `resolveRepairModeLabel()` |
| `controller/app/index.ts` | 已删除 | 无代码、脚本或打包入口引用 |
| `controller/app/rendering.ts` | 保留 | 继续作为纯 ViewObject 构造模块 |
| `controller/app/theme.ts` | 已迁移到 `view/theme.ts` | View 持有 DOM 和系统主题事件；偏好读取复用 Storage Adapter |
| `controller/plan/BattlePlanLoaderController.ts` | 新增并收口 | 独立持有受管方案选择器状态并返回最终选择结果 |
| `controller/plan/PlanController.ts` | 收口完成 | 保留当前方案编辑、地图、保存和执行；方案选择委托给 Loader |
| `controller/plan/index.ts` | 已删除 | 无代码、脚本或打包入口引用 |
| `controller/plan/nodeEditor.ts` | 保留 | 节点编辑用例集中，无需再拆 |
| `controller/plan/presetFlow.ts` | 保留并收口 | 集中预设导入、展示和任务请求构造 |
| `controller/plan/rendering.ts` | 保留 | 继续作为纯 ViewObject mapper |
| `controller/plan/selectedNodes.ts` | 保留 | 单一纯规则 |
| `controller/shared/ControllerHost.ts` | 已删除 | 各控制器使用自己的最小 Host/Port |
| `controller/shared/DialogHelper.ts` | 保留 | 集中的对话框适配层 |
| `controller/shared/index.ts` | 已删除 | 无调用方，不再保留无意义 barrel |
| `controller/startup/StartupController.ts` | 保留并清理 | 保留环境检查、更新、后端连接和销毁顺序 |
| `controller/startup/connection.ts` | 保留 | 后端连接启动流程集中 |
| `controller/startup/envAndUpdates.ts` | 保留 | 环境准备和启动更新仍构成一个完整启动业务边界 |
| `controller/startup/index.ts` | 已删除 | 无代码、脚本或打包入口引用 |
| `controller/taskGroup/TaskListLoaderController.ts` | 保留并收口 | 继续负责完整的任务列表加载用例 |
| `controller/taskGroup/TaskGroupController.ts` | 保留并瘦身 | 继续协调任务组；固定 DOM 事件迁到 View 回调 |
| `controller/taskGroup/addItems.ts` | 保留并收口 | 保留添加条目用例；删除无引用的 `addFileToGroup()`，文件/YAML 处理走 Adapter |
| `controller/taskGroup/contextMenu.ts` | 保留并收口 | 集中上下文菜单和任务编辑意图，不再继续拆成微型文件 |
| `controller/taskGroup/importExport.ts` | 已删除 | 两个导出函数均无调用方，且没有对应 UI 入口 |
| `controller/taskGroup/index.ts` | 已删除 | 无代码、脚本或打包入口引用 |
| `controller/taskGroup/managedPlanReader.ts` | 保留 | 被元数据和队列加载流程共同调用 |
| `controller/taskGroup/metaLoader.ts` | 保留并收口 | 保留批量元数据编排；YAML 解析统一走 `yamlCodec` |
| `controller/taskGroup/queueLoader.ts` | 保留并收口 | 集中 managed/group/template 三种来源的入队规则 |
| `controller/template/TemplateController.ts` | 收口完成 | 保留模板页和向导协调，使用稳定的强类型状态引用 |
| `controller/template/crud.ts` | 保留并收口 | 保留 CRUD 用例，JSON 解析统一走 `jsonCodec` |
| `controller/template/index.ts` | 已删除 | 无代码、脚本或打包入口引用 |
| `controller/template/selectors.ts` | 保留并收口 | 保留选择用例，使用强类型和 `yamlCodec`，移除 `any` |
| `controller/template/useTemplate.ts` | 保留 | 用例单一 |
| `controller/template/wizard.ts` | 保留并改契约 | 保留步骤规则；用明确状态接口替代 `as any` ref-wrapper |

## 5. View 逐文件映射

| 现有文件 | 处理 | 目标 |
|---|---|---|
| `view/config/ConfigView.ts` | 保留并收口 | 完整设置页纯渲染组件；不解析 YAML，不访问 IPC |
| `view/main/FleetPreviewView.ts` | 保留并注入 | 由 Controller 传入舰船库 manifest，移除直接 IPC |
| `view/main/LogView.ts` | 保留 | 日志渲染职责集中 |
| `view/main/MainView.ts` | 保留 | 继续作为主页面 facade |
| `view/main/StatusBar.ts` | 保留 | 状态栏职责集中 |
| `view/main/TaskQueueView.ts` | 保留 | 队列渲染和拖拽回调集中 |
| `view/plan/BattlePlanLoaderView.ts` | 新增并收口 | 集中受管方案选择弹窗、搜索筛选、列表和舰队预览 DOM |
| `view/plan/DecisivePlanView.ts` | 保留并收口 | 通过 `DecisivePlanViewHost` 发出意图，草稿由 `DecisivePlanController` 独立持有 |
| `view/plan/FleetEditDialog.ts` | 保留并收口 | 对话框保留，复用只读舰船目录和唯一名称规范化规则 |
| `view/plan/FleetPlannerView.ts` | 拆分完成 | facade + `FleetEditorView`、`FleetRuleView`、`FleetGalleryView`、`PlanManagementView`、`TeamPlanLoaderView` |
| `view/plan/FleetPresetView.ts` | 保留并收口 | 通过最小 Host 获取计划和舰船库数据，不直接访问全局 IPC |
| `view/plan/MapView.ts` | 保留 | 地图渲染职责集中 |
| `view/plan/NodeEditorView.ts` | 保留 | 节点编辑表单职责集中 |
| `view/plan/PlanPreviewView.ts` | 保留 | 继续组合地图、节点和方案表单 |
| `view/plan/ShipArtwork.ts` | 保留 | 集中计划页舰船图片创建和 fallback |
| `view/plan/TeamPlanListUi.ts` | 保留 | 集中编队计划过滤、排序和卡片渲染 |
| `view/setup/SetupWizardView.ts` | 保留 | 向导渲染职责集中 |
| `view/shared/ShipAutocomplete.ts` | 保留 | 通用自动补全组件 |
| `view/shared/scrollPosition.ts` | 保留 | 通用纯 DOM 工具 |
| `view/taskGroup/TaskGroupView.ts` | 保留 | 任务组面板渲染职责集中 |
| `view/template/SelectorDialog.ts` | 保留 | 通用选择弹窗 |
| `view/template/TemplateLibraryView.ts` | 保留 | 模板列表渲染职责集中 |
| `view/template/TemplateWizardView.ts` | 保留并收口 | 继续负责向导 DOM；固定事件通过回调交给 Controller |

## 6. Model、Types、Data、Utils 逐文件映射

| 现有文件 | 处理 | 目标 |
|---|---|---|
| `model/ApiClient.ts` | 收口完成 | 保留业务 API facade；REST 和 WebSocket 传输委托 `ApiAdapter` |
| `model/ConfigModel.ts` | 收口完成 | 保留配置状态、默认值和迁移；YAML 解析统一走 `yamlCodec` |
| `model/MapDataLoader.ts` | 收口完成 | 保留缓存和地图查询；文件读取和 JSON 解析委托 Adapter |
| `model/PlanModel.ts` | 收口完成 | 保留方案状态、未知字段合并和序列化规则；底层 YAML 解析统一走 `yamlCodec` |
| `model/TaskGroupModel.ts` | 收口完成 | 保留任务组权威状态/CRUD；JSON 和文件持久化委托 Adapter |
| `model/TemplateModel.ts` | 收口完成 | 保留模板 CRUD 和校验；JSON 和文件持久化委托 Adapter |
| `model/scheduler/CronScheduler.ts` | 策略/存储提取 | 保留定时器和 pending 状态；时间规则与 `localStorage` 分离 |
| `model/scheduler/ExpeditionTimer.ts` | 保留 | 单一定时职责 |
| `model/scheduler/RepairManager.ts` | 策略/存储提取 | 保留 `bathingShips`；阈值判断与持久化分离 |
| `model/scheduler/Scheduler.ts` | 提取纯策略 | 保留 `currentTask/status`、消费和 API 回调；纯规则进入 `SchedulerTaskPolicy` 和 `SchedulerRepairPolicy` |
| `model/scheduler/StopConditionChecker.ts` | 保留 | 停止条件职责集中 |
| `model/scheduler/TaskQueue.ts` | 保留并收口 | 继续唯一持有就绪和延迟队列 |
| `model/scheduler/index.ts` | 保留 | 继续作为调度系统公共出口 |
| `types/api.ts` | 真实定义 | 后端请求、响应、任务 DTO 和 WebSocket 事件 |
| `types/ipc.ts` | 真实定义 | IPC DTO、`ElectronBridge` 和全局 Window 声明 |
| `types/model.ts` | 真实定义 | 配置、方案、模板、舰队和修理领域类型 |
| `types/scheduler.ts` | 保留 | 调度类型内聚且规模合理 |
| `types/view.ts` | 真实定义 | 页面 ViewObject、表单值和展示状态 |
| `data/shipData.ts` | 已删除 | 舰船目录、名称规范化、匹配和规则映射已归入 `model/fleet/` |
| `utils/Logger.ts` | 保留 | 日志格式、级别和输出职责集中 |

## 7. 重点模块的实际拆法

### 7.1 `FleetPlannerView.ts`

最终按完整舰队业务功能拆分，而不是按单个 helper 拆分：

1. `FleetPlannerController` 持有唯一 `FleetDraft`。
2. `FleetGalleryView` 负责图鉴筛选、排序、加载缓存等纯展示状态。
3. `FleetEditorView` 负责舰队槽位编辑和拖拽意图。
4. `FleetRuleView` 负责主选、备选、舰种和等级规则输入。
5. `TeamPlanLoaderView` 负责编队计划选择。
6. `PlanManagementView` 负责计划列表和管理意图。
7. `FleetPlannerView` 只组合上述完整业务 View 并转发回调。

`FleetDraft` 必须保留 candidate-only：没有明确 `name` 的槽位不能把第一个
candidate 提升为主选。

### 7.2 `Scheduler.ts`

不把执行流程拆成多个可写对象。只提取纯策略：

- `SchedulerTaskPolicy`：任务完成、重试、后触发和队列请求规则。
- `SchedulerRepairPolicy`：修理和替换相关的无状态判断。

`consumeNext()`、重试时序、`currentTask` 和状态切换继续留在 `Scheduler`。

### 7.3 `PlanModel.ts` 和 `ConfigModel.ts`

Model 不再直接依赖 `js-yaml`，公共方法继续保留：

```typescript
PlanModel.fromYaml(content)
plan.toYaml()
config.loadFromYaml(content)
config.toYaml()
```

这些方法统一委托 `yamlCodec`，保持 YAML 未知字段、头部注释和旧字段迁移行为。

## 8. 实施状态

| 阶段 | 状态 | 结果 |
|---|---|---|
| S0 行为基线 | 已完成 | 建立迁移、API、Fleet 和 Scheduler 特征测试 |
| S1 Types | 已完成并复核粒度 | 四个领域和 Scheduler 各一个真实定义文件，不保留子目录 barrel |
| S2 Adapter | 已完成 | 形成 5 个完整边界 Adapter 和统一入口 |
| S3 Domain | 已完成 | Fleet/Scheduler 规则收口，状态所有权未复制 |
| S4 Controller | 已完成 | `AppController` 保持唯一组合根，子 Controller 使用最小 Host |
| S5 View | 已完成 | Fleet View 按完整业务功能拆分，业务草稿移出 View |
| S6 清理 | 已完成 | facade、无引用 barrel 和死代码已删除，文档与最终回归通过 |

## 9. 每阶段验收

每个提交至少执行：

```powershell
npm run build
npm run test:api-contract
git diff --check
```

按改动范围追加：

```powershell
npm run test:migrations
npm run test:settings
npm run test:main-services
npm run test:main-ipc
```

最终静态边界检查：

```powershell
npm run test:architecture-boundaries
rg -n "window\.electronBridge|\(window as any\)" src/model src/view
rg -n "js-yaml|yaml\.load|yaml\.dump" src/controller src/model src/view
rg -n "\bas any\b" src/controller src/model src/view
```

Controller 门禁应通过，其余 3 条均应无结果。

S6 最终验证已通过：

- `npm run build`、舰种契约同步检查。
- Fleet、Scheduler、旧配置、旧方案、任务组迁移和 API 契约测试。
- 设置持久化、主进程服务、主进程 IPC 和 Python 环境测试。
- 舰船库更新器、活动资源测试、静态边界检查和 `git diff --check`。

桌面 Electron 启动、舰队拖拽、模拟器连接和实际任务执行没有在本轮工具环境中
进行手工验收，仍需在合并前按下列清单验证。

最终手工回归：

1. 启动、ADB 连接、心跳和后端停止。
2. 配置加载/保存、外部 Python、CUDA/OCR、更新检查。
3. 作战方案加载、修改、保存、执行和 candidate-only 请求。
4. 编队创建、备选拖拽、覆盖确认、计划管理和批量导出。
5. 任务组保存、加载、排序、单项/整组入队和旧数据迁移。
6. Cron、重试、停止条件、泡澡轮换和远征任务。
7. 模板创建、编辑、导入和加入任务组。

## 10. 明确不做

- 不在拆分提交中修改 IPC channel、接口字段或用户文件格式。
- 不同时重写 UI 样式。
- 不把 `Scheduler`、`CronScheduler`、`RepairManager` 的状态复制到新对象。
- 不以“文件超过多少行”为理由继续细拆单一职责文件。
- 不在当前脏工作区直接进行全目录搬迁。

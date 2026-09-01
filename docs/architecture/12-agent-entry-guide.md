# AGENT 进入指南

这份文档用于让第一次进入仓库的 AGENT 在不破坏边界的前提下定位和修改代码。

## 先确认基线

本项目经常存在未提交实现。不要只看 HEAD：

```powershell
git status --short
git diff --stat
git diff --cached --stat
```

以当前工作区文件为事实来源。遇到已有改动：

- 不回退用户改动。
- 阅读当前完整文件和 diff。
- 在已有实现上继续。
- 只修改请求涉及的范围。

## 5 分钟建立上下文

```powershell
Get-Content package.json -Raw
rg --files src electron scripts/tests
rg -n "目标类名|目标方法|界面文案" src electron scripts
```

然后阅读：

1. [总架构](00-overview.md)。
2. [运行时边界 ADR](10-runtime-boundaries-adr.md)。
3. 对应专题。
4. 目标文件的调用方、类型和测试。

不要从生成的 `src/view/index.html`、`styles.css` 或 `dist/**` 反推源代码。

## 需求到文件

| 需求 | 首要入口 | 通常还要检查 |
|---|---|---|
| 应用启动/退出 | `electron/main.ts` | `SingleInstanceService`、`WindowService`、Backend shutdown |
| Renderer 启动 | `StartupController.ts` | `startup/connection.ts`、`envAndUpdates.ts` |
| 页面导航 | `NavigationController.ts`、对应 View | HTML partial、`AppController` 装配 |
| 设置字段 | `ConfigModel.ts`、`ConfigController.ts` | Config View、IPC 类型、GuiConfigurationService |
| 配置持久化 | `GuiSettingsCommitService.ts` | Store、ConfigurationIpc、preload |
| 自动任务 | `CronScheduler.ts`、`SchedulerBinder.ts` | ScheduledTaskLoader、额度 Model、配置 |
| 队列/重试/次数 | `Scheduler.ts` | TaskQueue、SchedulerTaskPolicy、scheduler types |
| 作战方案 YAML | `PlanModel.ts` | CombatPlanCodec、Controller rendering |
| 方案管理 | `PlanManagementController.ts` | Main PlanManagementService、Repository |
| 编队规则 | `src/model/fleet/` | FleetPlannerController、fleetEditor types |
| 决战编队 | `DecisiveFleetDraft.ts` | DecisivePlanController/View、DailyPlanService |
| 舰船图库 | `ShipGalleryView.ts` | FleetGalleryView、DecisivePlanView、SCSS |
| 任务组 | `TaskGroupModel.ts` | `controller/taskGroup/*`、迁移测试 |
| 模板 | `TemplateModel.ts` | `controller/template/*`、旧任务组兼容 |
| IPC 方法 | `src/types/ipc.ts` | preload、Main IPC、IpcAdapter |
| 后端 API | `src/types/api.ts`、`ApiClient.ts` | Scheduler/Controller、API 契约测试 |
| Python/CUDA | `electron/pythonEnv/` | Environment Service、BackendRuntimeContract |
| ADB/模拟器 | `AdbService.ts`、`emulatorDetect.ts` | DeviceIpc、设置页 |
| 迁移 | `UserDataMigrationService.ts` / `LegacyPlanMigration.ts` | MigrationStateStore、fixtures |
| GUI 更新 | `UpdaterIpc.ts`、`GuiUpdatePolicy.ts` | Installer、state store、main lifecycle |
| HTML | `src/view/html/` | 对应 View 和 DOM 契约 |
| 样式 | `src/view/styles/` | HTML/View 所有权和聚合入口 |
| 构建/打包 | `package.json` | scripts、builder config、workflow |

## 判断代码应该放哪

问四个问题：

1. 是否操作 DOM、浏览器事件或动画？放 View。
2. 是否是领域状态、校验或纯业务规则？放 Model 或 Shared。
3. 是否协调多个对象完成一个用例？放 Controller。
4. 是否访问 Electron、文件、HTTP、WS 或浏览器存储？放 Adapter/Main Service。

Main 侧再区分：

- IPC：输入输出边界。
- Service：用例和业务策略。
- Repository：目录、文件和来源。
- Codec：YAML/JSON 结构和兼容。
- `main.ts`：只装配和生命周期。

## 禁止依赖

### Controller 禁止

```text
document.*
window.electronBridge
localStorage.*
window.addEventListener
window.matchMedia
HTMLElement / HTMLInputElement / ResizeObserver 等 DOM 类型
```

### View 禁止

```text
stateful Model import
ApiClient import
Adapter import
window.electronBridge
localStorage.*
```

`view/theme.ts` 通过 StorageAdapter 管理 UI 偏好是已有例外。

### Shared 禁止

```text
DOM
Electron
Node 文件系统
浏览器存储
有状态 singleton
```

## 修改步骤

1. 用 `rg` 找定义、调用方、类型和测试。
2. 阅读当前文件，不只读 Git 版本。
3. 确定状态唯一所有者和依赖方向。
4. 写出最小变更范围。
5. 先改开发源，再生成产物。
6. 跑最小专项测试。
7. 跑构建/架构门禁。
8. 检查 diff 是否只包含预期文件。

```powershell
git diff --check
git status --short
git diff -- <affected paths>
```

## 最小验证矩阵

| 改动范围 | 必跑 |
|---|---|
| 任意 TypeScript/HTML/SCSS | `npm run test:build` |
| Controller/View 边界 | `npm run test:architecture-boundaries` |
| HTML/DOM ID | `npm run test:renderer-contract` |
| 设置页 | `npm run test:settings` |
| Scheduler/Cron/额度 | `npm run test:scheduler-domain` |
| Fleet/舰种/候选 | `npm run test:fleet-domain`、`npm run check:fleet-types` |
| Main Service | `npm run test:main-services` |
| preload/IPC | `npm run test:main-ipc` |
| 迁移 | `npm run test:migrations` |
| 后端请求/DTO | `npm run test:api-contract` |
| Python/CUDA/后端来源 | `npm run test:python-environment` |
| 打包资源 | `npm run pack`、`npm run test:release-package` |

专项测试通过不代表构建门禁可以省略。涉及用户交互时还要运行 Electron 做实际
页面回归。

## 生成文件

| 修改源 | 必须生成 |
|---|---|
| `src/view/html/**` | `npm run build:html` -> `src/view/index.html` |
| `src/view/styles/**/*.scss` | `npm run build:css` -> `styles.css` |
| TypeScript | `npm run build` -> `dist/**`，但 `dist` 不作为手改源 |

安装包只包含生成后的 HTML/CSS 和 Bundle，不包含 HTML/SCSS/TS 源。

## 高风险不变量

- 新/切换地图计划默认只有节点 `0`；只有 `0` 时禁止入队。
- 节点参数继承 `node_defaults`。
- `PlanModel.rawRoot` 和 Main Codec 保留未知 YAML 字段。
- 普通舰队与决战草稿独立。
- candidate-only 不提升第一候选为主选。
- 舰种使用 22 canonical code，导巡为 `KP/kp`。
- 调度用 `logicalId` 管理整个逻辑任务。
- 未到终点或战果不足不减少轮次。
- 自动战役固定每日 8 次正常结算。
- 系统资源只读，用户数据只写 userData。
- 迁移完成 marker 不覆盖，写完文件后才标记。
- 次实例不能执行迁移、pip 或创建第二个主窗口。
- 退出/安装更新前必须确认后端进程树和内置 ADB 已释放。

## 何时停止扩大改动

出现以下情况时，回到边界重新设计，而不是继续加特殊判断：

- View 需要完整 Model 或 Repository。
- Controller 需要 DOM 元素。
- IPC 开始解析 YAML 或写业务规则。
- 同一状态在两个对象中都可写。
- 新 fallback 吞掉 Controller、页面、OCR 或环境异常。
- 为一个调用方创建“共享”组件。
- 修改生成文件才能让源码工作。

## 完成标准

一个修改只有同时满足以下条件才算完成：

- 行为由正确层负责。
- 当前工作区已有改动未被覆盖。
- 生成文件与开发源一致。
- 受影响专项测试和构建门禁通过。
- Electron 交互在需要时已回归。
- 文档、类型、preload、IPC 和调用方没有遗漏的契约变化。

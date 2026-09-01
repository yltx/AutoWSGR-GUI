# `src` TypeScript 模块拆分单 Agent 执行任务书

## 1. 文档用途

本文件把 [`src` TypeScript 模块拆分方案](./2026-08-04-src-module-split-plan.md)
转换为一个长期 Agent 可以分阶段执行的任务书。

两份文档的职责不同：

- 原方案说明为什么拆、最终边界和现有模块的去向。
- 本任务书规定单个 Agent 每个阶段做什么、允许修改什么、如何验证和何时停止。

本任务书不是一次性全目录搬迁，也不是多 Agent 并行队列。实施过程按 S0-S6
串行推进，并在每个阶段验证行为和架构边界。

本任务的目标不是机械复制 `electron/` 的目录名称，而是让 `src/` 形成同样清晰的
职责边界：

```text
src/
├─ adapter/    YAML、JSON、IPC、HTTP、WebSocket、Storage 边界
├─ controller/ 页面和用例编排
├─ model/      领域模型、规则和唯一状态所有者
├─ view/       DOM/ViewObject 渲染和用户意图回调
├─ types/      按领域和通信方向组织的类型
└─ shared/     无状态共享工具
```

最终没有为了目录外观增加 `app/` 或 `domain/`：`AppController` 继续是 Renderer
组合根，领域状态继续位于 `model/`。Adapter 按完整边界收敛为
`ApiAdapter.ts`、`IpcAdapter.ts`、`JsonAdapter.ts`、`StorageAdapter.ts` 和
`YamlAdapter.ts`，避免微型文件。

## 2. 执行启用门槛

本轮实际执行记录：

```text
BASE_SHA=7bd0c65
WORK_BRANCH=ShiinaKuroko
CURRENT_STAGE=POST_S6_TYPES_CONSOLIDATION_COMPLETED
PATCH_LEVEL=L0
```

维护者已明确要求以当前脏工作树为准并保留全部未提交改动，因此本轮没有创建
独立 worktree，也没有执行 reset、checkout、stash 或覆盖用户文件。该授权只适用
于本次连续实施；后续新一轮拆分仍应先记录基线并隔离工作树。

## 3. 单 Agent 通用执行协议

### 3.1 开始阶段

Agent 每次只执行一个阶段，例如 `S2`。阶段完成并经过维护者验收后，才可以开始
下一个阶段。开始阶段前必须完整读取：

1. `AGENTS.md`
2. `.editorconfig`
3. `.gitattributes`
4. `tsconfig.json`
5. `package.json`
6. `CONTRIBUTING.md`
7. 原拆分方案
8. 本任务书
9. 当前阶段卡指定的架构文档和现有测试

### 3.2 修改前报告

Agent 在写代码前必须报告：

```text
阶段 ID：
基线 SHA：
当前分支/worktree：
行为目标：
非目标：
允许修改的主要文件：
状态所有者：
当前数据流：
预期数据流：
Patch 等级：
计划执行的验证：
```

没有完成该报告，不得开始写代码。阶段完成后必须暂停，不得自动进入下一阶段。

### 3.3 修改范围

- 只修改当前阶段卡的“主要范围”。
- 可以修改直接 import、barrel export、对应测试和对应架构文档。
- 需要进入未列出的业务模块时，立即停止并报告范围扩散；不得顺手修改其他阶段
  的核心文件。
- 不修改 IPC channel、API 字段、YAML/JSON 公共格式和用户目录。
- 不修改 UI 样式，除非当前阶段明确允许。
- 不进行无关格式化、依赖升级、资源更新或命名清理。
- 不使用 `any`、类型断言、retry、sleep、fallback 或第二状态源绕过问题。

### 3.4 兼容迁移

拆文件时采用以下顺序：

1. 增加目标模块和最小接口。
2. 将现有逻辑原样迁入，先保持行为。
3. 原公共入口暂时改为 facade 或 re-export。
4. 修改调用方。
5. 运行验证。
6. 只有 S6 可以删除跨阶段兼容出口。

禁止在同一个任务中一边迁移结构，一边修改业务语义。

### 3.5 每个阶段的通用验证

所有代码阶段至少执行：

```powershell
npm run build
git diff --check
git status --short
```

`npm run build` 会生成 CSS/构建输出。没有样式变化时，不得把生成差异作为任务
成果提交。

阶段卡列出的专项测试必须全部执行。无法执行时，阶段不得标记完成，交付记录
必须写明阻塞原因和未验证风险。

### 3.6 强制停止条件

出现任一情况，Agent 必须停止，不得继续补代码：

1. 当前工作树包含无法确认归属的修改。
2. 阶段需要修改另一个未解锁阶段的核心文件。
3. 需要新增第二份可写状态、同步标志、延时或 fallback。
4. 两次实现尝试仍未通过同一验证。
5. 旧测试与架构文档对当前行为给出冲突结论。
6. 无法证明 candidate-only、YAML 未知字段或任务生命周期保持不变。
7. 需要改变 IPC、API 或持久化格式才能完成结构拆分。

## 4. 状态所有权不变量

所有任务都必须遵守：

| 状态 | 唯一可写所有者 | 禁止行为 |
|---|---|---|
| 当前任务、运行状态 | `Scheduler` | 子策略保存镜像状态 |
| 就绪队列、延迟重试 | `TaskQueue` | Controller 保存第二份任务队列 |
| Cron 定时器、pending | `CronScheduler` | Store 决定触发行为 |
| 泡澡舰船集合 | `RepairManager` | View/Controller 维护影子集合 |
| 当前作战方案 | `PlanController` | 子 View 持有可独立修改副本 |
| 舰队编辑草稿 | 单个 `FleetDraft` | 多个子 View 各自保存草稿 |
| 决战舰队草稿 | 单个 `DecisiveFleetDraft` | 复用普通草稿后再加补偿字段 |

以下外部语义不得改变：

- 纯候选舰船槽位不得自动生成顶层 `name`。
- `candidates` 中每项仍必须有 `name`。
- YAML 未知字段、头部注释和旧字段迁移行为保持。
- 队列优先级、延迟重试、后触发和停止条件时序保持。
- IPC channel、参数、返回值和错误文本保持。
- REST/WebSocket 路径、请求和回调顺序保持。

## 5. 状态所有权与目标边界

### 5.1 Renderer 目标数据流

```text
Adapter → Domain Model → Controller → ViewObject → View
                              ↑             │
                              └ 用户意图 ───┘
```

职责要求：

- `adapter/` 只处理 YAML、JSON、IPC、HTTP、WebSocket 和 Storage 边界。
- `model/` 只持有领域状态和纯业务规则，不访问 `window`、`document`、Electron 或
  Node 文件系统。
- `controller/` 只编排用例和转换 ViewObject，不直接依赖 YAML/JSON parser。
- `view/` 只渲染 DOM、读取用户输入并发出意图，不访问有状态 Model、全局 IPC 或
  Storage；允许使用类型、不可变目录和无状态领域函数。
- `AppController` 是 Renderer 组合根，负责生命周期和跨域协调。
- `types/` 区分领域类型、API DTO、IPC DTO 和 ViewObject。
- `shared/` 只放无状态、无业务所有权的共享工具。

### 5.2 单一状态所有者

| 状态 | 唯一可写所有者 | 其他模块允许做什么 |
|---|---|---|
| 当前任务、运行状态 | `Scheduler` | 读取、发出用户意图 |
| 就绪队列、延迟重试 | `TaskQueue` | 读取、请求入队 |
| Cron timer、pending | `CronScheduler` | 读取、请求触发 |
| 泡澡舰船集合 | `RepairManager` | 读取快照、请求修理 |
| 当前作战方案 | `PlanController` | View 只能通过意图修改 |
| 普通舰队草稿 | `FleetDraft` | Controller 只协调 mutation |
| 决战舰队草稿 | `DecisiveFleetDraft` | Controller 只协调 mutation |

Controller 不得保存 Draft、Scheduler 或 RepairManager 的镜像字段。Store、Policy、
Factory 和 View 都不得成为第二个可写状态源。

## 6. 单 Agent 阶段顺序

严格串行执行以下阶段。每个阶段完成后暂停，维护者验收通过后才能继续：

```text
S0 只读审计与行为基线
→ S1 Types 拆分
→ S2 Adapter 边界
→ S3 Domain 拆分
→ S4 App 与 Controller 收口
→ S5 View 拆分
→ S6 兼容层清理与文档同步
```

不得把这些阶段拆给多个 Agent 并行执行。单个 Agent 必须持续掌握同一套状态所有权、
依赖图和目标边界。

## 7. 阶段总表

| ID | 阶段 | 前置阶段 | 主要状态 |
|---|---|---|---|
| S0 | 只读审计与行为基线 | 基线 SHA | 已完成 |
| S1 | Types 拆分与兼容出口 | S0 | 已完成 |
| S2 | YAML/JSON/IPC/API/Storage Adapter | S1 | 已完成 |
| S3 | Fleet、Plan、Scheduler Domain | S2 | 已完成 |
| S4 | App 与 Controller 收口 | S3 | 已完成 |
| S5 | View 拆分与纯 View 边界 | S4 | 已完成 |
| S6 | 删除兼容层、死代码并同步文档 | S0-S5 | 已完成 |

## 8. 阶段卡

### S0 只读审计与行为基线

**目标**：不改变业务行为，固定可复现基线。

**允许范围**：`scripts/`、`docs/reviews/`，以及为基线测试新增的最小 fixture。

**必须完成**：

- 记录 `BASE_SHA`、Node/npm 版本、依赖状态和工作树状态。
- 生成 `src` import 依赖图和直接越层访问清单。
- 覆盖 YAML round-trip、未知字段、头部注释、candidate-only、任务队列、Cron、
  Repair、TaskGroup/Template 迁移和 API/IPC 契约。
- 记录每个测试的通过/失败，不在本阶段修业务。

**验收**：

```powershell
npm run build
npm run test:migrations
npm run test:api-contract
npm run test:settings
npm run test:main-services
npm run test:main-ipc
git diff --check
```

**完成后必须暂停。** 未固定基线不得进入 S1。

### S1 Types 拆分与兼容出口

**范围**：

```text
src/types/api.ts
src/types/ipc.ts
src/types/model.ts
src/types/view.ts
src/types/scheduler.ts
```

**要求**：

- API DTO、IPC DTO、领域类型、ViewObject 和调度类型各自保持完整文件。
- 不保留只做 re-export 的 Types facade 或二级子目录。
- 不改变类型语义，不修改运行时行为。
- 不批量迁移所有 import，只需证明新出口可用。
- 不把默认值、迁移逻辑和 View 逻辑放入 types。

**验收**：`npm run build`、`npm run test:api-contract`。

### S2 Adapter 边界

**范围**：

```text
src/adapter/ApiAdapter.ts
src/adapter/IpcAdapter.ts
src/adapter/JsonAdapter.ts
src/adapter/StorageAdapter.ts
src/adapter/YamlAdapter.ts
src/model/PlanModel.ts
src/model/ConfigModel.ts
src/model/TaskGroupModel.ts
src/model/TemplateModel.ts
src/model/MapDataLoader.ts
src/model/ApiClient.ts
```

**要求**：

- YAML/JSON 解析、迁移和序列化各只有一个实现位置。
- Repository/Store 只处理边界，不决定业务行为。
- `ApiClient` 保留业务 facade，HTTP/WS 传输实现移入 adapter。
- 保持未知字段、注释、旧格式、storage key、IPC channel、API path、请求体和回调
  时序。
- 不增加通用文件 IPC、备用 endpoint 或第二份持久化状态。

**验收**：

```powershell
npm run test:migrations
npm run test:api-contract
npm run test:main-ipc
```

### S3 Domain 拆分

**范围**：

```text
src/model/fleet/
src/model/scheduler/
src/data/shipData.ts
```

**Fleet 要求**：

- 集中 `ShipCatalog`、`ShipNameNormalizer`、`ShipMatcher`、`FleetRuleMapper`、
  `FleetDraft`、`DecisiveFleetDraft`。
- candidate-only 不得自动生成顶层 `name`。
- candidates 顺序和每项独立规则必须保留。
- `ship_type`、`search_name`、等级规则不能在 View 中重复解释。
- `shipData.ts` 在迁移期只作为 facade。

**Scheduler 要求**：

- `Scheduler` 唯一持有当前任务和运行状态。
- `TaskQueue` 唯一持有 ready/delayed 队列。
- `CronScheduler` 唯一持有 timer/pending。
- `RepairManager` 唯一持有 bathingShips。
- 提取的 Policy/Factory 只能是纯函数或无状态对象。

**必须新增或补齐测试**：优先级、延迟、重试、后触发、Cron 恢复、Repair 恢复、舰队
预设切换、candidate-only、舰种和等级规则。

### S4 App 与 Controller 收口

**范围**：`src/controller/app/`、`src/controller/startup/`、
`src/controller/plan/`、`src/controller/taskGroup/`、`src/controller/template/`。

**要求**：

- `AppController` 是唯一 Renderer 组合根。
- `StartupController` 保留启动顺序和销毁顺序。
- 子 Controller 只接收最小 Host/Port，不接收整个 AppController。
- Controller 不直接依赖 YAML/JSON parser，不直接持久化业务状态。
- Plan、TaskGroup、Template 的请求构造分别收口到明确的 mapper/factory。
- 保持任务顺序、次数、优先级、重试、停止条件和后端连接时序。

**验收**：`npm run test:settings`、`npm run test:main-services`、
`npm run test:main-ipc`、`npm run test:python-environment`、相关 API/迁移测试。

### S5 View 拆分与纯 View 边界

**范围**：`src/view/` 以及与 View 直接相关的 Controller/ViewObject mapper。

**要求**：

- View 只渲染 DOM、读取输入和发出用户意图。
- View 不访问有状态 Model、全局 IPC、localStorage、js-yaml 或持久化。
- View 可以使用类型、不可变目录和无状态领域函数，但不能取得业务状态所有权。
- View 不保存可独立修改的业务副本。
- `FleetPlannerView` 必须先建立唯一 `FleetDraft`，再拆编辑、规则、图鉴、选择和管理子 View。
- `DecisivePlanView` 使用独立 `DecisiveFleetDraft`，不得复用普通草稿后叠加补偿字段。
- 保持 candidate-only、舰队规则、保存覆盖、导入导出和预览行为。

**验收**：build、API/迁移/服务测试，以及固定步骤的手工验证记录。

### S6 兼容层清理与文档同步

**前置**：S0-S5 全部完成并通过验收。

**要求**：

- 先用 `rg`、bundle 检查、测试和入口检查证明旧 facade 无内部/外部依赖。
- 再删除 types facade、`shipData` facade、旧 View re-export、无引用 helper 和 barrel。
- 不因为目标目录存在就删除仍可能是公共入口的 facade。
- 同步 `docs/architecture/`、本方案和本任务书，使文档与实现一致。

**最终静态检查**：

```powershell
rg -n "window\.electronBridge|\(window as any\)" src/model src/view
rg -n "localStorage" src/model src/view
rg -n "js-yaml|yaml\.load|yaml\.dump" src/controller src/model src/view
rg -n "\bas any\b" src/controller src/model src/view
rg -n "shipData" src scripts electron
rg -n "types/(api|ipc|model|view)/" src scripts electron
rg -n "controller/shared/ControllerHost|controller/(app|plan|startup|taskGroup|template|shared)/index" src scripts electron
```

最终运行全部基线测试和 `git diff --check`。`as any` 只能在明确注释的第三方边界存在，
业务 Controller/Model/View 中不得存在。

**实际清理结果**：

- 原 4 个 Types 根 facade 已由真实定义替代，旧 Types 子目录已删除。
- 删除 `data/shipData.ts` 和 6 个无引用 Controller barrel。
- 删除无调用方的 `controller/shared/ControllerHost.ts` 和
  `controller/taskGroup/importExport.ts`。
- 保留仍有测试或业务调用方的 `model/fleet/index.ts`、
  `model/scheduler/index.ts`、`queueLoader.ts` 和 `managedPlanReader.ts`。
- 更新 `docs/architecture/`、拆分方案和本任务书。

**最终验证结果**：

- 构建、舰种契约、Fleet/Scheduler Domain、旧配置/旧方案/任务组迁移和 API 契约通过。
- 设置持久化、主进程服务、主进程 IPC、Python 环境、舰船库更新器和活动资源测试通过。
- 7 项静态边界/旧入口检查无匹配，删除路径均不存在。
- `git diff --check` 通过，仅报告资源 JSON 的 CRLF/LF 转换提示。

桌面 Electron 启动、舰队拖拽、模拟器连接和实际任务执行未在本轮工具环境中手工
验证。代码仍处于未提交工作树，没有生成完成 SHA。

## 9. 阶段交付格式

单 Agent 完成每个阶段后必须按以下格式交付，并在交付后暂停：

```text
阶段 ID：
基线 SHA：
完成 SHA：

行为目标：
实际修改：
明确未修改：

修改文件：
新增文件：
删除文件：

状态所有者变化：
外部契约变化：无 / 具体说明
兼容层：新增 / 保留 / 删除

执行命令及结果：
1.
2.

手工验证：
未验证路径：
失败尝试次数：
当前 Patch 等级：
回滚方式：

git status --short：
下一阶段建议：
```

交付中只说“构建通过”不算完成。必须列出专项测试和业务不变量的验证证据。

## 10. 可直接派发的提示词

维护者可以复制以下内容，替换阶段 ID 和 SHA。不要把多个阶段一次性派给 Agent：

```text
请执行 C:\ShiinaKuroko\04.Code\AutoWSGR\AutoWSGR-GUI\docs\reviews\2026-08-04-src-module-split-agent-runbook.md 中的阶段 <STAGE_ID>。

基线 SHA：<BASE_SHA>
前置阶段完成 SHA：<PREVIOUS_SHA>

你只能执行该阶段，不得开始下一阶段。修改前先按任务书提交预检报告。
使用独立分支/worktree，保护现有未提交修改。完成后执行通用验证和阶段卡专项验证，
并按“阶段交付格式”报告，然后暂停等待维护者验收。出现强制停止条件时停止写代码
并报告，不得自行扩大范围。
```

## 11. 阶段验收

维护者接受每个阶段前必须确认：

- [ ] Agent 使用了正确的基线。
- [ ] 只完成一个阶段 ID。
- [ ] 没有混入共享工作树的旧改动。
- [ ] 状态所有者没有复制。
- [ ] 外部契约没有变化，或已获得单独批准。
- [ ] 通用验证和专项验证均有结果。
- [ ] 失败尝试和 Patch 等级已披露。
- [ ] 文档与实现没有互相矛盾。
- [ ] 回滚该任务不会要求同时回滚未关联功能。
- [ ] 下一阶段基于本阶段合并后的新 SHA。

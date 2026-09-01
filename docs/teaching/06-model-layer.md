# 06：Model 与领域状态

> 前置阅读：[01 按职责拆分类](01-extract-class.md)

Model 层保存领域状态并执行领域规则。判断一个类是否属于 Model，不看它是否
“处理数据”，而看它是否拥有业务含义、状态不变量和转换规则。

## 当前领域分布

```text
src/model/
├─ ConfigModel.ts
├─ PlanModel.ts
├─ TaskGroupModel.ts
├─ TemplateModel.ts
├─ MapDataLoader.ts
├─ ApiClient.ts
├─ fleet/
├─ scheduler/
└─ statistics/
```

主要状态所有者：

| 领域 | 权威状态 |
|---|---|
| 配置 | `ConfigModel` |
| 当前作战方案 | `PlanModel` |
| 任务组 | `TaskGroupModel` |
| 模板 | `TemplateModel` |
| 普通舰队草稿 | Fleet 领域 + `FleetPlannerController` |
| 决战草稿 | `DecisiveFleetDraft` + `DecisivePlanController` |
| 调度 | `Scheduler` |
| 每日额度 | `CampaignDailyQuota`、`NormalFightDailyQuota` |
| 出征统计 | `DailySortieStats` |

Controller 可以持有 Model，但不复制 Model 的可写状态。

## ConfigModel：两个配置域

`ConfigModel` 同时维护两个明确分开的域：

```typescript
private settings: UserSettings;
private guiAutomation: GuiAutomationSettings;
```

- `settings` 对应 AutoWSGR `usersettings.yaml`。
- `guiAutomation` 对应 GUI 自身自动化设置。

`rawRoot` 保存 GUI 尚未建模的 YAML 字段：

```typescript
private rawRoot: Record<string, unknown> = {};
```

这样读取、编辑和写回时不会静默删除后端新增或用户手写字段。

这里的教学重点是：Model 不只保存“已知字段”，还维护 round-trip 不变量和旧
字段迁移语义。

## PlanModel：继承规则属于领域

节点参数由默认值和节点覆盖合并：

```typescript
getNodeArgs(nodeId: string): NodeArgs {
  const defaults = this.data.node_defaults ?? {};
  const overrides = this.data.node_args?.[nodeId] ?? {};
  const args = { ...defaults, ...overrides };
  if (this.data.endpoint_nodes?.includes(nodeId)) {
    args.proceed = false;
  }
  return args;
}
```

这段逻辑属于 `PlanModel`，因为：

- 它解释方案字段语义。
- Controller 和 View 都需要一致结果。
- 持久化结构变化时只应改一处。

View 不应自行合并 `node_defaults`，Controller 也不应为每个页面复制规则。

`PlanModel.rawRoot` 同样保留未知 YAML 字段，保存时只覆盖 GUI 管理的字段。

## 独立纯规则放在哪里

有些规则属于一个领域，但不需要读取领域对象状态。例如：

- `SchedulerTaskPolicy.ts`
- `SchedulerRepairPolicy.ts`
- Fleet 目录中的草稿变换函数
- `src/controller/plan/selectedNodes.ts`

`selectedNodes.ts` 维护路线用例规则：

```typescript
export function initialSelectedNodesForNewPlan(): string[] {
  return ['0'];
}

export function assertPlanRouteReadyForExecution(
  selectedNodes: readonly string[],
): void {
  if (selectedNodes.length === 1 && selectedNodes[0] === '0') {
    throw new Error('出征计划只启用了起始节点，请至少开启一个路线节点');
  }
}
```

它位于 Controller 领域辅助模块，是因为“新建/执行方案”属于应用用例边界；
`PlanModel` 仍只解释方案本身。

位置判断取决于规则语义，不是所有纯函数都必须进入 `shared/`。

## Fleet：草稿、编辑和持久化分开

`src/model/fleet/**` 包含：

- `FleetDraft`
- `DecisiveFleetDraft`
- `FleetDraftEditor`
- `FleetPresetIdentity`
- `FleetRuleMapper`
- `ShipMatcher`

普通舰队与决战舰队共享舰船资料和部分视觉行为，但草稿状态独立。

关键不变量：

- 主选舰优先于候选舰。
- candidate-only 槽位不能把第一个候选自动提升为主选。
- 全局唯一分配优先保留主选。
- 主选失败后再用候选重新执行全局分配。
- 舰种只接受规定的 canonical code。

这些规则属于 Model/Fleet 领域，不应放进卡片点击事件或 Main IPC。

## Scheduler：唯一任务状态机

`Scheduler` 组合：

- `TaskQueue`
- `RepairManager`
- `StopConditionChecker`
- `ExpeditionTimer`
- 任务和修理纯策略

它拥有：

- 当前物理轮次。
- 就绪队列。
- 延迟和等待任务。
- 系统和停止状态。
- 重试和后续轮次推进。

任务身份分两层：

```text
id         一次物理执行轮次
logicalId  整个多轮逻辑任务
```

`buildFollowUpTask()` 创建下一物理轮次时生成新 `id`，但保留 `logicalId`。

这使取消、完成和每日额度可以针对整个逻辑任务，而不是误把每轮都当成独立用户
任务。

## Model 通过事件通知，不操作页面

Scheduler 使用 `SchedulerCallbacks` 通知 Controller。Controller 的
`SchedulerBinder` 再更新页面、Cron 和统计。

```text
Scheduler 状态变化
  -> SchedulerCallbacks
  -> SchedulerBinder
  -> Controller 状态 / ViewObject
  -> MainView
```

Model 不调用 `document.*`，也不 import 具体 View。

## Model、Shared 和 Adapter 的区别

| 位置 | 适合内容 |
|---|---|
| `src/model/**` | 有领域状态、领域不变量或领域内策略 |
| `src/shared/**` | Renderer/Main 都能用的无状态纯逻辑 |
| `src/adapter/**` | HTTP、WS、IPC、Storage、YAML/JSON 技术边界 |

例如：

- `fleetShipTypes.ts` 在 Shared，因为 Main 和 Renderer 都需同一舰种规则。
- `SchedulerTaskPolicy.ts` 在 Scheduler 子系统，因为规则只服务调度领域。
- `YamlAdapter.ts` 是技术编解码边界，不拥有 Plan 业务。

`ApiClient` 当前位于 Model，但网络传输由 `ApiAdapter` 注入。新增后端字段时仍需
保持 API DTO 与领域状态分开。

## Model 的持久化原则

领域 Model 负责：

- 校验和规范化。
- 默认值。
- 未知字段保留。
- 旧字段兼容。
- 领域对象到可持久化结构的转换。

Main Repository/Service 负责：

- 文件位置和来源。
- 读写权限。
- 原子写入。
- 导入导出。
- 多文件事务。

Model 不应自行拼 `userData` 路径。

## 常见反例

- View 持有并修改 `PlanModel.data`。
- Controller 同时维护一份 Scheduler 队列副本。
- Repository 决定 candidate-only 业务语义。
- Shared 模块读取 DOM 或 Electron。
- 一个“Manager”同时拥有配置、任务和页面状态。
- 为了复用，把普通舰队和决战草稿合成一个可写对象。

## 新增领域规则的步骤

1. 确认规则属于哪个领域和状态所有者。
2. 搜索所有现有实现和兼容分支。
3. 判断规则需要状态还是可做纯输入输出。
4. 在唯一所有者或领域策略中实现。
5. 保持序列化未知字段和旧格式兼容。
6. 通过 Controller 转换成 VO，不让 View 重复解释。
7. 添加领域专项测试。

## 验证

```powershell
npm run test:scheduler-domain
npm run test:fleet-domain
npm run test:settings
npm run test:migrations
npm run test:build
git diff --check
```

# 方案与编队系统

> 主要目录：`src/model/PlanModel.ts`、`src/model/fleet/`、
> `src/controller/plan/`、`electron/services/*Plan*.ts`

## 三类受管方案

| 类型 | 系统只读目录 | 用户可写目录 |
|---|---|---|
| 作战方案 | `resource/system_battle_plans/` | `userData/user_battle_plans/` |
| 编队方案 | `resource/system_team_plans/` | `userData/user_team_plans/` |
| 日常方案 | `resource/system_daily_plans/` | `userData/user_daily_plans/` |

系统和用户方案通过同一管理 UI 展示，但来源 identity 必须保留。系统方案不能
原地覆盖；编辑后保存为用户副本。

## 作战方案模型

`PlanModel` 负责 Renderer 中的 YAML 解析、编辑和序列化。重要字段包括：

```typescript
interface PlanData {
  chapter: number | string;
  map: number | string;
  selected_nodes: string[];
  endpoint_nodes?: string[];
  node_defaults?: NodeArgs;
  node_args?: Record<string, NodeArgs>;
  fleet_presets?: FleetPreset[];
  times?: number;
  gap?: number;
  fleet_id?: number;
  repair_mode?: number | number[];
}
```

### 未建模字段保留

`PlanModel.fromYaml(content, path)` 保存原始根对象 `rawRoot`。`toYaml()` 以
`rawRoot` 为基底，仅覆盖 GUI 管理字段，因此后端扩展字段、根注释和 GUI 尚未
认识的内容不会被整份重建丢失。

修改序列化时必须保留这一行为。不要用一个只包含 TypeScript 已知字段的新对象
替换原始 YAML 根。

### 节点默认值

节点执行参数必须继承 `node_defaults`：

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

`node_args` 只覆盖节点特有字段；终点节点强制 `proceed = false`。

### 新计划路线

`src/controller/plan/selectedNodes.ts` 固定以下规则：

- 新计划只启用节点 `0`。
- 后端执行的节点白名单始终包含 `0`。
- 只有 `0` 时禁止入队，提示至少开启一个路线节点。

这区分“节点追踪尚未识别字母节点”和“用户尚未选择实际路线”。新增或切换地图
时不能默认全选路线。

## 地图

`MapDataLoader` 从 `resource/maps/` 加载普通和活动地图，缓存读取结果。
`controller/plan/rendering.ts` 将地图、PlanModel 和节点编辑状态组合成
`PlanPreviewViewObject`。

`MapView` 只渲染节点、连线和选择意图，不决定后端执行参数。地图同步由
`scripts/sync-map-resources.js` 负责，修改资源后运行 `npm run check:maps`。

无效空地图数据不能覆盖已有有效快照。

## Renderer 方案控制器

| 模块 | 所有权 |
|---|---|
| `PlanController` | 当前作战方案和地图 |
| `BattlePlanLoaderController` | 受管方案选择和筛选 |
| `PlanFleetPresetController` | 当前方案引用的编队列表 |
| `PlanManagementController` | 管理目录、关联和删除影响 |
| `FleetPlannerController` | 普通编队唯一草稿及文件 identity |
| `DecisivePlanController` | 决战独立草稿 |
| `presetFlow.ts` | 独立任务预设详情和执行 |
| `nodeEditor.ts` | 节点编辑意图 |
| `selectedNodes.ts` | 路线选择与执行校验 |

Controller 负责 `file/source`、保存覆盖和持久化 DTO；View 只看到不透明 ID 和
ViewObject。

## 编队领域

`src/model/fleet/` 是编队业务规则边界：

| 文件 | 责任 |
|---|---|
| `FleetDraft.ts` | 普通舰队草稿、校验、与 `UserTeamPlan` 双向转换 |
| `DecisiveFleetDraft.ts` | 决战 level1/level2 草稿 |
| `FleetDraftEditor.ts` | 显式编辑意图的唯一应用入口 |
| `FleetPresetIdentity.ts` | 预设身份和引用 |
| `FleetRuleMapper.ts` | GUI 规则到 API 规则 |
| `ShipMatcher.ts` | 舰船匹配和展示标签 |

普通舰队与决战舰队不能共享同一草稿。它们只共享
`ShipGalleryView` 的搜索、筛选、排序、增量渲染和卡片交互。

### 舰位语义

舰位可以是：

- 空位。
- 明确主选舰船。
- 带国籍、舰种、等级等约束的结构化主选。
- `candidates` 备选规则。
- candidate-only 槽位。

candidate-only 槽位没有顶层 `name`，候选项地位平等；不能把第一项自动提升为
主选。全局唯一分配优先保留主选，主选不可用后才使用候选并重新执行全局分配。

舰种只使用原生 0.3 定义的 22 个 canonical code 和业务组合
`ss_or_ssg`。导巡 canonical code 为 `KP/kp`。舰种同步快照由：

```powershell
npm run sync:fleet-types
npm run check:fleet-types
```

维护，API 契约测试会与 AutoWSGR 仓库交叉验证。

## Main 计划流水线

作战方案：

```text
CombatPlanIpc
  -> PlanManagementService / PlanExportService
  -> CombatPlanCodec
  -> CombatPlanRepository
  -> AtomicFileStore / AppPaths
```

编队方案：

```text
TeamPlanIpc
  -> TeamPlanService
  -> TeamPlanCodec
  -> TeamPlanRepository
```

日常方案：

```text
DailyPlanIpc
  -> DailyPlanService
  -> CombatPlanCodec / TaskPresetCodec
```

IPC 不直接解析 YAML 或决定命名。Codec 负责结构和兼容，Repository 负责来源目录
和原子文件操作，Service 负责用例。

## 保存与执行

保存作战方案时，内嵌 `fleet_presets` 可拆成受管编队方案并建立引用。运行时：

1. `PlanManagementService` 读取受管方案。
2. `CombatPlanCodec` 解析并解析编队引用。
3. `RuntimePlanService` 展开成后端可读 YAML。
4. 写入 `<temp>/AutoWSGR-GUI/runtime_battle_plans/<pid>/`。
5. Scheduler 只把临时运行路径发送给后端。

运行时临时文件序号由 `RuntimePlanService` 独占，外部用户选择路径不能直接进入
任务队列。

## 导入、导出与删除

- 用户显式选择的本地 YAML 通过当前 Codec 升级后导入用户目录。
- 源文件保持不变。
- 同名覆盖需要用户确认。
- 删除编队前必须计算作战方案引用。
- 删除作战方案前必须计算任务组引用。
- 系统来源只读，导出只选择用户方案。

方案管理 View 不读取 Repository；关联状态统一由
`planManagementViewObjects.ts` 推导。

## 验证

| 修改 | 最小验证 |
|---|---|
| PlanModel、路线和 YAML | `npm run test:api-contract`、`npm run test:main-services` |
| FleetDraft/舰种/候选 | `npm run test:fleet-domain`、`npm run check:fleet-types` |
| 方案管理删除 | `npm run test:plan-management-delete` |
| Main Codec/Repository/Service | `npm run test:main-services` |
| 迁移兼容 | `npm run test:migrations` |
| 方案/编队 View | `npm run test:build`，并在 Electron 中回归交互 |

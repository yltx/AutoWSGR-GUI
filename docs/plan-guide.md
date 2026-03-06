# 战斗方案 YAML 编写指南

本文档介绍如何编写 AutoWSGR-GUI 的战斗方案配置文件。方案文件为 YAML 格式，放置在 `plans/` 目录下，可在 GUI 中导入使用。

---

## 方案类型

每个 YAML 文件对应一种任务类型。通过 `task_type` 字段（或直接使用 `chapter` + `map` 隐含常规战斗）来区分。

### 1. 常规战斗 (normal_fight)

最常用的方案类型，用于地图出击。

```yaml
chapter: 9
map: 2
selected_nodes: [A, D, G, H, M, O, E, K]
fight_condition: 1
repair_mode: 1
fleet_id: 1

node_defaults:
  formation: 4
  night: false
  proceed: true

node_args:
  E:
    enemy_rules:
      - [NAP < 1, retreat]
```

也可以引用内置方案：

```yaml
task_type: normal_fight
plan_id: 2-1捞胖次
times: 10
```

### 2. 战役 (campaign)

```yaml
task_type: campaign
campaign_name: 困难航母
times: 3
```

`campaign_name` 可选值：`简单驱逐`、`简单巡洋`、`简单战列`、`简单航母`、`简单潜艇`、`困难驱逐`、`困难巡洋`、`困难战列`、`困难航母`、`困难潜艇`。

### 3. 演习 (exercise)

```yaml
task_type: exercise
fleet_id: 4
```

### 4. 决战 (decisive)

```yaml
task_type: decisive
chapter: 6
level1:
  - U-1206
  - U-96
  - 鹦鹉螺
level2:
  - 大青花鱼
flagship_priority:
  - U-1206
```

### 5. 活动 (event_fight)

与常规战斗类似，但需指定 `task_type: event_fight` 和 `event_name`。

---

## 常规战斗字段详解

以下是常规战斗方案的完整字段说明。

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `chapter` | 数字 | 是 | 地图章节 (如 `9`) |
| `map` | 数字 | 是 | 地图编号 (如 `2` 表示 9-2) |
| `selected_nodes` | 字符串列表 | 是 | 途经的节点列表，如 `[A, D, G, H, M, O]` |
| `fleet_id` | 数字 | 否 | 使用的舰队编号 (1-4)，默认 `1` |
| `fight_condition` | 数字 | 否 | 战况条件，见下表 |
| `repair_mode` | 数字 | 否 | 修理策略，见下表 |
| `node_defaults` | 对象 | 否 | 所有节点的默认配置 |
| `node_args` | 对象 | 否 | 按节点名覆盖的个性化配置 |

### fight_condition 战况条件

| 值 | 含义 |
|----|------|
| `1` | 稳步前进 |
| `2` | 火力万岁 |
| `3` | 小心翼翼 |
| `4` | 瞄准 |
| `5` | 搜索阵型 |

### repair_mode 修理策略

| 值 | 含义 |
|----|------|
| `1` | 中破就修 |
| `2` | 大破才修 |

---

## 节点配置 (node_defaults / node_args)

`node_defaults` 设置所有节点的默认行为，`node_args` 为特定节点覆盖配置。两者使用相同的字段。

| 字段 | 类型 | 说明 |
|------|------|------|
| `formation` | 数字 | 阵型选择 |
| `night` | 布尔 | 是否进行夜战 |
| `proceed` | 布尔 | 战斗后是否继续推进 |
| `proceed_stop` | 数字列表 | 各位置的推进/撤退阈值 (6 个值，对应 6 个舰位) |
| `enemy_rules` | 列表 | 索敌规则，根据敌方编队决定行为 |

### formation 阵型

| 值 | 阵型 |
|----|------|
| `1` | 单纵阵 |
| `2` | 复纵阵 |
| `3` | 轮型阵 |
| `4` | 梯形阵 |
| `5` | 单横阵 |

### proceed_stop 推进阈值

6 个数字的列表，分别对应舰队 6 个位置。每个值表示该位置舰船受损到何种程度时停止推进：

| 值 | 含义 |
|----|------|
| `1` | 中破停止 |
| `2` | 大破停止 |

示例：`[2, 2, 2, 2, 2, 2]` 表示所有位置大破才停。

---

## 索敌规则 (enemy_rules)

索敌规则是方案中最重要的部分，决定了索敌成功后根据敌方舰队组成采取的行动。

### 格式

```yaml
enemy_rules:
  - [条件表达式, 动作]
  - [条件表达式, 动作]
```

规则**按顺序匹配**，第一条满足条件的规则生效。如果所有规则都不满足，则按默认阵型战斗。

### 动作

| 动作 | 说明 |
|------|------|
| `1` ~ `5` | 使用对应阵型战斗 (1=单纵 2=复纵 3=轮型 4=梯形 5=单横) |
| `retreat` | 撤退 |

### 条件表达式

条件表达式基于敌方舰队中的**舰种数量**进行判断。

#### 可用舰种代号

| 代号 | 舰种 |
|------|------|
| `CV` | 航母 |
| `CVL` | 轻母 |
| `AV` | 装母 |
| `BB` | 战列 |
| `BBV` | 航战 |
| `BC` | 战巡 |
| `CA` | 重巡 |
| `CAV` | 航巡 |
| `CLT` | 雷巡 |
| `CL` | 轻巡 |
| `DD` | 驱逐 |
| `SS` | 潜艇 |
| `SSG` | 导潜 |
| `SC` | 炮潜 |
| `NAP` | 补给舰 |
| `BM` | 重炮 |

#### 运算符

| 运算符 | 说明 | 示例 |
|--------|------|------|
| `+` | 多舰种数量求和 | `DD + CL` |
| `>=` | 大于等于 | `NAP >= 1` |
| `<=` | 小于等于 | `DD + CL <= 1` |
| `>` | 大于 | `CV > 0` |
| `<` | 小于 | `NAP < 1` |
| `==` | 等于 | `CVL == 1` |
| `and` | 逻辑与 | `CVL == 1 and CV == 0` |

### 迂回节点的特殊行为

地图数据中某些节点标记为**迂回节点**（在 GUI 方案预览中以虚线边框显示）。对于迂回节点：

- **默认行为：尝试迂回**（不战斗直接绕过）
- 如果 `enemy_rules` 命中某条规则且动作为**阵型编号**（1-5），则**取消迂回，改为战斗**
- 如果 `enemy_rules` 命中 `retreat`，则**撤退**
- **迂回失败时默认继续战斗**（除非另有配置）

---

## 完整示例

### 示例 1：9-2 捞胖次

迂回节点有补给舰时战斗，否则迂回；E/K 点无补给舰则撤退。

```yaml
# 9-2 捞胖次
chapter: 9
map: 2
selected_nodes: [A, D, G, H, M, O, E, K]
fight_condition: 1
repair_mode: 1
fleet_id: 1

node_defaults:
  formation: 4
  night: false
  proceed: true

node_args:
  A:
    enemy_rules:
      - [NAP >= 1, 4]
  D:
    enemy_rules:
      - [NAP >= 1, 4]
  G:
    enemy_rules:
      - [NAP >= 1, 4]
  H:
    enemy_rules:
      - [NAP >= 1, 4]
  M:
    enemy_rules:
      - [NAP >= 1, 4]
  E:
    enemy_rules:
      - [NAP < 1, retreat]
  K:
    enemy_rules:
      - [NAP < 1, retreat]
```

### 示例 2：7-4 漂流捞胖次

根据敌方编队组成选择不同阵型，Boss 点夜战。

```yaml
# 7-4 漂流捞胖次
chapter: 7
map: 4
selected_nodes: [A, B, C, E, D, F, G, H, I, J, L, M, K]
fight_condition: 4
repair_mode: 1
fleet_id: 3

node_defaults:
  enemy_rules:
    - [DD + CL <= 1, 4]
    - [CVL == 1 and CV == 0, 4]
  formation: 2
  night: false
  proceed: true
  proceed_stop: [2, 2, 2, 2, 2, 2]

node_args:
  M:
    enemy_rules:
      - [SAP < 1, retreat]
    formation: 4
    night: true
  I:
    enemy_rules:
      - [SAP < 1, retreat]
```

### 示例 3：简单挂机方案

引用内置方案，设置次数。

```yaml
task_type: normal_fight
plan_id: 2-1捞胖次
times: 10
```

### 示例 4：战役

```yaml
task_type: campaign
campaign_name: 困难航母
times: 3
```

### 示例 5：演习

```yaml
task_type: exercise
fleet_id: 4
```

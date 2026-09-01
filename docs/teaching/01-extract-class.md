# 01：按职责拆分类

> 前置阅读：[00 全局概览](00-overview.md)

Extract Class 的目标不是减少单文件行数，而是把不同的状态、变化原因和生命周期
分开。拆完后如果两个文件仍共同修改同一批字段，只是多了一层转发，边界并没有
改善。

## 先找责任，不先找行数

适合提取的信号：

- 一组字段只被一组方法使用。
- 一段逻辑有独立输入输出，可以不依赖宿主内部状态。
- 某个区域有自己的资源生命周期，如事件监听器或 Observer。
- 某个用例只需要宿主的少量能力。
- 同一视觉行为被两个真实页面重复实现。
- 一组规则可以单独测试，不需要启动 DOM、Electron 或后端。

不适合提取的理由：

- “文件超过 N 行”。
- “以后可能复用”。
- “每个方法都应该有一个类”。
- “先建 Manager/Factory，后面再接功能”。

## 案例一：AppController 只做组合

当前 Renderer 入口是：

`src/controller/app/AppController.ts`

它仍然持有核心对象，但细分行为由明确模块负责：

```text
src/controller/app/
├─ AppController.ts
├─ ConfigController.ts
├─ CurrentFleetController.ts
├─ NavigationController.ts
├─ OperationsController.ts
├─ ScheduledTaskLoader.ts
├─ SchedulerBinder.ts
├─ SchedulerRuntimeTracker.ts
├─ SettingsController.ts
└─ rendering.ts
```

拆分判断依据不是“AppController 太长”，而是变化原因不同：

| 模块 | 独立变化原因 |
|---|---|
| `NavigationController` | 页面和标签导航 |
| `ConfigController` | 配置加载、转换和提交 |
| `SettingsController` | Python、CUDA、ADB、更新和资料库 |
| `SchedulerBinder` | Scheduler/Cron/后端事件接线 |
| `SchedulerRuntimeTracker` | 从日志派生运行状态 |
| `rendering.ts` | 状态到 `MainViewObject` 的纯转换 |

`AppController` 保留对象创建、依赖连接和启动/退出生命周期。这是组合根应承担的
责任，不能为了“更短”再把对象创建随机搬到多个全局单例。

## 案例二：有状态核心与纯策略分开

Scheduler 的权威状态仍在：

`src/model/scheduler/Scheduler.ts`

它拥有运行任务、队列、等待任务、状态和子模块。可独立计算的规则被提取为：

- `SchedulerTaskPolicy.ts`
- `SchedulerRepairPolicy.ts`

例如任务创建规则不需要访问 Scheduler 私有状态：

```typescript
export function createSchedulerTask(
  options: SchedulerTaskOptions,
): SchedulerTask {
  const times = options.times ?? 1;
  const unlimited = !Number.isFinite(times);
  const normalizedTimes = unlimited ? 1 : Math.max(1, Math.trunc(times));
  return {
    id: options.id,
    logicalId: options.id,
    remainingTimes: normalizedTimes,
    totalTimes: normalizedTimes,
    maxRetries: 2,
    retryCount: 0,
    // 其余字段来自显式输入
  };
}
```

这种拆分有三个收益：

1. 状态所有者仍然唯一。
2. 规则可以用普通输入输出测试。
3. Scheduler 只负责何时调用规则和如何推进状态机。

反例是把 `currentTask`、`waitingTasks` 分别放进多个“Manager”，再让它们相互
回调修改。那会产生多个可写状态源。

## 案例三：View Facade 与职责子 View

当前设置页由 `ConfigView` 对 Controller 保持统一 API，内部组合：

- `ConfigAutomationView`
- `ConfigRuntimeView`
- `settingSelectWidth.ts`

这次拆分的边界是视觉责任：

- 自动任务列表和额度摘要一起变化。
- Python、CUDA、ADB、更新状态一起变化。
- 下拉框宽度计算是独立纯 DOM 辅助。

Controller 仍只依赖 `ConfigView`，没有因为视觉拆分而获得三个新依赖。

这种结构是 Facade：

```text
Controller -> ConfigView
                  ├─ ConfigAutomationView
                  ├─ ConfigRuntimeView
                  └─ settingSelectWidth
```

Facade 的价值是保持外部契约稳定，而不是把每个 DOM 元素包装成一个类。

## 案例四：共享组件必须有真实复用

普通舰队页和决战页原本都需要：

- 舰船搜索和筛选。
- 排序和批量渲染。
- 卡片交互和拖拽。
- 滚动位置恢复。

这些完整视觉行为进入：

`src/view/plan/ShipGalleryView.ts`

页面差异通过 `ShipGalleryViewHost` 注入。普通舰队的主选/候选规则和决战的
level1/level2 草稿仍留在各自领域，不进入共享图库。

共享边界成立是因为：

1. 已有两个真实消费者。
2. 共享的是完整视觉行为，不是相似名称。
3. 页面业务差异仍由 Host 隔离。
4. 共享组件拥有完整 `dispose()` 生命周期。

如果只有一个调用方，或提取后充满 `if (page === ...)`，就不应创建共享组件。

## 案例五：源文件拆分不能改变运行结构

HTML 和 SCSS 也按职责拆分：

```text
src/view/html/**                  # HTML 开发源
src/view/styles/pages/config/**  # 设置页 SCSS partial
src/view/styles/pages/plan/**    # 方案页 SCSS partial
```

构建后 Electron 仍加载：

```text
src/view/index.html
src/view/styles/styles.css
```

机械拆分必须保持：

- DOM 顺序和 ID。
- CSS 选择器、属性和加载顺序。
- 事件绑定时机。
- 页面行为和视觉效果。

因此源文件拆分和功能修改应分批进行。

## 安全提取步骤

1. 用 `rg` 找字段、方法、调用方、DOM ID、类型和测试。
2. 写清楚待提取责任，以及仍留在宿主的责任。
3. 确认状态唯一所有者不变。
4. 先定义最小输入输出或 Host。
5. 移动一条完整责任，不顺手改业务规则。
6. 保持原公共 API，或同步修改所有消费者。
7. 补齐监听器、Observer、定时器等释放链。
8. 跑专项测试并检查 diff。

## 拆分完成的判断

一次有效拆分应满足：

- 提取模块能用一句话描述责任。
- 不需要访问宿主大部分私有字段。
- 没有新增第二份可写业务状态。
- 错误仍在原来的业务边界报告。
- 外部调用方没有被迫理解内部拆分。
- 测试能更直接地验证该责任。

## 验证

Renderer 类和 View 拆分至少执行：

```powershell
npm run test:architecture-boundaries
npm run test:renderer-contract
npm run test:build
git diff --check
```

涉及 Scheduler 或 Fleet 时再执行：

```powershell
npm run test:scheduler-domain
npm run test:fleet-domain
```

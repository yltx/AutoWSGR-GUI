# 重构与架构实践教学

本目录用 AutoWSGR-GUI 的**当前工作区代码**讲解架构设计和安全重构方法，
包括尚未提交或尚未 push 的实现。示例不是历史快照，也不使用旧文件数和旧行数
描述当前系统。

## 文档定位

- 想知道“项目现在怎么组成”，阅读[架构文档](../architecture/README.md)。
- 准备修改代码，先遵守项目根目录的 [AGENTS.md](../../AGENTS.md)。
- 想理解“为什么这样拆、如何判断代码放哪”，阅读本教学系列。

可执行配置、测试和生产源码是最终事实来源。代码变化后，教学示例也必须同步
更新，不能为了匹配文档而改回旧架构。

## 阅读顺序

| # | 文档 | 学习目标 |
|---|---|---|
| 00 | [全局概览](00-overview.md) | 建立进程、分层、数据流和状态所有权认知 |
| 01 | [按职责拆分类](01-extract-class.md) | 判断何时拆分，以及如何保持行为不变 |
| 02 | [Host 接口与依赖注入](02-host-interface.md) | 用最小能力接口解除具体对象耦合 |
| 03 | [ViewObject 单向数据流](03-viewobject-flow.md) | 从 Model 到 View，再把用户意图送回 Controller |
| 04 | [Electron Main 分层](04-electron-split.md) | 区分组合根、IPC、Service、Repository 和 Codec |
| 05 | [View 层组织](05-view-layer.md) | 组织 Facade、局部 View、共享组件、HTML 和 SCSS |
| 06 | [Model 与领域状态](06-model-layer.md) | 确定唯一状态所有者，拆分领域规则和调度策略 |
| 07 | [类型系统分层](07-type-system.md) | 区分 API、IPC、Model、Scheduler、Intent 和 ViewObject |

建议第一次按 `00 -> 01 -> 02 -> 03` 阅读，再按工作范围选择 `04～07`。

## 学习方式

每章都按同一顺序使用：

1. 先看要解决的耦合或状态问题。
2. 打开章节列出的当前源码。
3. 理解为什么边界放在这里。
4. 对照反例判断哪些“拆分”只是在搬代码。
5. 使用章节末尾命令验证依赖、构建和行为。

阅读代码时优先使用：

```powershell
rg -n "目标类名|目标方法|界面文案" src electron scripts/tests
rg --files src electron scripts/tests
git status --short
```

不要只查看 Git HEAD。本项目允许工作区存在尚未提交的连续开发，当前文件才是
正在生效的实现。

## 核心原则

1. 按职责和状态所有权拆分，不按行数平均拆分。
2. Controller 编排用例，但不拥有 DOM 或底层 IPC。
3. View 拥有 DOM 和局部视觉状态，但不拥有业务状态。
4. Model 拥有领域状态和规则，不依赖具体 View。
5. Renderer 外部能力经过 Adapter；Electron 能力经过 preload 和 IPC。
6. Main 的可测试行为进入 Service，文件来源进入 Repository，格式进入 Codec。
7. 新抽象必须有真实调用方，并减少实质重复或隔离明确边界。
8. 拆分前后状态来源、持久化契约、交互和错误语义保持一致。

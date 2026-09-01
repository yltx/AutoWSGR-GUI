# 架构文档

本目录描述 **当前工作区代码** 的实际架构，包括尚未提交或尚未 push 的实现。
代码、`package.json`、构建脚本和 CI 配置是最终事实来源；文档与代码冲突时，
先按代码确认行为，再同步修正文档。

## 第一次进入项目

按以下顺序阅读：

1. [总架构](00-overview.md)：先建立进程、分层、目录和启动顺序的全局认识。
2. [AGENT 进入指南](12-agent-entry-guide.md)：按需求定位文件，确定最小修改和验证命令。
3. [运行时边界 ADR](10-runtime-boundaries-adr.md)：确认不能破坏的状态、存储和生命周期边界。
4. 再阅读对应业务专题，不需要从头读完全部文档。

## 专题目录

| # | 文档 | 主要内容 |
|---|---|---|
| 00 | [总架构](00-overview.md) | Electron、Renderer、Python 后端、目录、存储和启动流程 |
| 01 | [Controller 层](01-controller-layer.md) | 组合根、最小 Host、单向数据流和层级禁区 |
| 02 | [任务调度](02-task-scheduling.md) | Scheduler、Cron、逻辑任务、重试、终点计数和每日额度 |
| 03 | [配置系统](03-configuration.md) | YAML/JSON 双存储、事务保存、配置页拆分和迁移 |
| 04 | [方案与编队](04-battle-plan.md) | 作战、编队、日常方案，PlanModel、Codec/Repository/Service |
| 05 | [模板与任务组](05-template-and-taskgroup.md) | 模板兼容链路、任务组 v4、四类条目和入队 |
| 06 | [通信边界](06-backend-communication.md) | Preload/IPC、Adapter、HTTP、WebSocket 和异常边界 |
| 07 | [环境与生命周期](07-environment-management.md) | Python、CUDA、ADB、后端启动、迁移、更新和退出 |
| 08 | [开发与验证](08-dev-setup.md) | 构建、生成文件、测试、CI 和打包 |
| 09 | [`src` 模块索引](09-src-typescript-catalog.md) | Renderer 各目录和关键文件定位 |
| 10 | [运行时边界 ADR](10-runtime-boundaries-adr.md) | 当前必须保持的架构决策 |
| 11 | [Renderer 视觉架构](11-renderer-visual-architecture.md) | HTML partial、View、共享图库、SCSS 和生命周期 |
| 12 | [AGENT 进入指南](12-agent-entry-guide.md) | 需求到文件映射、修改步骤、验证矩阵和止损规则 |
| 13 | [发布版本治理](13-release-version-governance.md) | Stable/Alpha 版本号、双仓更新源和 2.1 桥接规则 |

## 三条先决规则

1. 不直接修改生成文件 `src/view/index.html`、`src/view/styles/styles.css` 或
   `dist/**`；修改源文件后运行 `npm run build`。
2. Renderer Controller 不接触 DOM、`window.electronBridge` 或
   `localStorage`；View 不导入有状态 Model、Adapter 或 ApiClient。
3. 系统资源只读，用户可变数据写入 Electron `userData`；主进程文件能力必须
   经过 Service 和 IPC 边界。

工程级强制规范见项目根目录的 [AGENTS.md](../../AGENTS.md)。

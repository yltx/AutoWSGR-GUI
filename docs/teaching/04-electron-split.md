# 04：Electron Main 分层

> 前置阅读：[00 全局概览](00-overview.md)

Electron Main 同时能访问文件、进程、窗口和系统 API，因此最需要控制权限边界。
当前架构不是简单地把 `main.ts` 拆成多个文件，而是区分组合、传输、用例、来源
和格式。

## 当前分层

```text
electron/
├─ main.ts                 # 组合根和生命周期
├─ preload.ts              # 唯一 Renderer Bridge
├─ ipc/                    # 通道和参数边界
├─ services/               # 主进程用例、策略和持久化
└─ pythonEnv/              # Python、依赖、CUDA 和后端来源
```

Main 内部常见职责：

| 层 | 负责 | 不负责 |
|---|---|---|
| `main.ts` | 创建服务、注入依赖、注册 IPC、启动/退出顺序 | 文件格式和业务规则 |
| preload | 暴露白名单方法、转发 invoke/sendSync/event | 主进程业务 |
| IPC | 通道契约、输入输出和异常边界 | 持久化细节 |
| Service | 一个主进程用例或策略 | Renderer DOM |
| Repository | 目录、文件 identity、系统/用户来源 | 页面展示 |
| Codec | YAML/JSON 结构、校验、升级、未知字段 | 文件选择和窗口 |

## main.ts 是组合根

`electron/main.ts` 创建具体实现并把它们连接起来，例如：

```typescript
registerConfigurationIpc(ipcMain, {
  getAppVersion: () => app.getVersion(),
  backendPort: BACKEND_PORT,
  configuration: guiConfigurationService,
  settingsCommit: guiSettingsCommitService,
  cudaEnvironment: cudaEnvironmentService,
  pythonEnvironment: pythonEnvironmentService,
  windows: windowService,
});
```

这段代码表达对象关系，实际配置提交、CUDA 检测和窗口逻辑分别在 Service 中。

组合根允许依赖具体类，因为它的责任就是选择实现。子 Service 不应反向导入
`main.ts` 获取全局变量。

## preload 是唯一桥

`electron/preload.ts` 通过 `contextBridge` 暴露：

```typescript
window.electronBridge
```

完整契约定义在：

`src/types/ipc.ts`

Renderer Controller 和 View 不直接访问该全局对象。Adapter 使用 `Pick` 将完整
Bridge 裁剪成不同用例需要的 Gateway/Repository。

这样可以同时限制：

- Renderer 能调用哪些系统能力。
- 某个 Controller 能看到哪些 IPC 方法。
- IPC DTO 如何跨进程序列化。

## IPC 必须保持薄

以 `electron/ipc/ConfigurationIpc.ts` 为例，它负责：

- 注册同步 getter。
- 注册异步 handler。
- 把请求交给配置、环境、窗口和提交服务。

事务保存由：

`electron/services/GuiSettingsCommitService.ts`

处理，而不是写在 IPC handler 中。

判断逻辑放错位置的信号：

- IPC 开始解析 YAML。
- IPC 直接拼用户目录。
- IPC 决定迁移策略。
- IPC 捕获异常后改走业务 fallback。

这些行为应进入 Codec、Repository 或 Service。

## 配置事务案例

设置页一次提交会同时影响：

- `userData/usersettings.yaml`
- `userData/gui_settings.json`

`GuiSettingsCommitService.commitAtomic()` 的顺序是：

```text
准备窗口配置
  -> 快照 usersettings.yaml
  -> 保存新 YAML
  -> 提交 gui_settings.json
  -> JSON 失败时恢复 YAML
  -> 全部成功后返回提交结果
```

事务属于 Service，因为它协调多个存储并定义失败恢复语义。若放在 Renderer，
窗口关闭、IPC 中断或 Main 写入失败时就无法可靠回滚。

## 方案的 Codec / Repository / Service

作战和编队方案展示了三层分工：

```text
CombatPlanCodec
  解析、规范化、拆分、展开和序列化

CombatPlanRepository / TeamPlanRepository
  系统与用户目录、文件 identity 和读写

PlanManagementService / TeamPlanService / RuntimePlanService
  管理、保存、删除影响和运行时准备
```

例如运行前展开舰队引用：

```text
受管作战方案
  -> Repository 读取
  -> Codec 校验和展开独立舰队
  -> RuntimePlanService 写入临时执行方案
  -> 后端执行
```

Codec 不弹文件对话框，Repository 不构建页面 VO，Service 不手写 YAML 字符串。

## 文件能力为什么不能直接暴露

通用文件 IPC 经过：

- `SafePathService`
- `SecureFileService`
- `AtomicFileStore`

它们共同保证：

- 读取只在允许的资源和 `userData` 根内。
- 写入只进入 `userData`。
- 拒绝路径穿越、UNC、盘符跳转和 ADS。
- 检查符号链接或 junction 的真实目标。
- 写入使用临时文件和原子替换。

“用户在对话框选过一个文件”只授权该次操作，不能顺便扩大通用文件 IPC 的根
目录。

## 生命周期也是架构边界

启动顺序不能随意移动：

```text
单实例锁
  -> 更新恢复
  -> userData 迁移
  -> Python / 后端环境
  -> 方案和资料库
  -> IPC
  -> BrowserWindow
```

退出时 Main 保存窗口状态，并停止后端和 GUI 内置 ADB。次实例必须在迁移、pip、
后端和窗口初始化之前退出。

生命周期逻辑可以在 `main.ts` 编排，但可测试的停止、更新和单实例行为分别由
Service 实现。

## Python 环境为什么单独成域

`electron/pythonEnv/**` 负责：

- 解释器来源和版本。
- managed/external 后端模式。
- 依赖安装和 `.env_ready`。
- CUDA 环境。
- AutoWSGR 唯一来源和正式运行契约。

`BackendService` 只在环境和契约通过后启动 Uvicorn。环境检查失败不能静默切换
到另一个不明确来源。

## 新逻辑应该放哪

| 新需求 | 放置位置 |
|---|---|
| 新 IPC 方法 | `src/types/ipc.ts`、preload、对应 IPC |
| 文件命名和来源 | Repository |
| YAML 字段兼容 | Codec |
| 跨文件事务 | Service |
| 启动先后顺序 | `main.ts` |
| Python 查找或安装 | `electron/pythonEnv/**` |
| 后端进程控制 | Backend Service |
| 页面显示 | Renderer View/Controller |

## 常见反例

- 在 `main.ts` 直接实现一个完整 CRUD 用例。
- preload 暴露 Node `fs` 或任意路径读取。
- IPC 同时校验参数、解析 YAML、写文件和刷新窗口。
- Repository 返回页面文案。
- Codec 根据 Electron 对话框选择文件。
- 捕获 Main 异常后在 Renderer 触发另一个业务流程。

## 验证

```powershell
npm run test:main-services
npm run test:main-ipc
npm run test:migrations
npm run test:python-environment
npm run test:build
git diff --check
```

涉及进程、窗口、更新或安装时，还需要实际启动 Electron 并验证关闭和强制退出。

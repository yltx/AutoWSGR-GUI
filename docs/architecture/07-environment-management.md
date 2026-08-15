# 环境与运行生命周期

> 主要目录：`electron/pythonEnv/`、`electron/services/Backend*.ts`、
> `electron/main.ts`

## Python 环境

GUI 只接受 Python 3.12 或 3.13。查找顺序：

1. `gui_settings.json.python_path` 指定解释器。
2. GUI 安装目录内置 `python/python.exe`。
3. 系统 `python`/`python3`，再解析真实 `sys.executable`。

查找缓存位于 `electron/pythonEnv/context.ts`，切换 Python、模式或路径时由配置
服务清除。不要在 Service 中建立第二份 Python 缓存。

## `pythonEnv` 模块

| 文件 | 责任 |
|---|---|
| `context.ts` | 环境依赖和唯一查找缓存 |
| `finder.ts` | 解释器发现与版本校验 |
| `environment.ts` | Python 来源、安装目标和后端来源描述 |
| `dependencies.ts` | GUI/后端/资料库 Python 依赖清单 |
| `envCheck.ts` | 完整检查和 `.env_ready` |
| `installer.ts` | pip、便携 Python 和依赖安装 |
| `backendRequirement.ts` | 打包后端发行清单 |
| `backendContractProbe.ts` | AutoWSGR 正式运行契约探测 |
| `updater.ts` | managed 后端兼容检查和固定提交安装 |
| `cuda.ts` | CUDA 环境变量和 PyTorch 能力 |
| `utils.ts` | `_pth`、pip、环境变量和路径辅助 |
| `index.ts` | 对 Main Service 的聚合出口 |

IPC 通过 `PythonEnvironmentService` 使用这些能力。

## managed 与 external

| 模式 | 后端来源 | 依赖位置 |
|---|---|---|
| `managed` | `build/backend-distribution.json` 按 GUI 更新通道指定的受控 AutoWSGR | `{appRoot}/python/site-packages` |
| `external` + 内置 Python | 用户指定本地 AutoWSGR 仓库 | GUI `site-packages` + 仓库 |
| `external` + 外部 Python | 用户指定仓库和解释器 | 解释器自身环境 + 仓库 |

external 仓库无效时直接失败，不能回退 managed，也不能把 GUI site-packages
偷偷混入外部解释器。

发行清单同时固定两条后端来源：

- Stable：`OpenWSGR/AutoWSGR@main` 的明确提交。
- Alpha：`ShiinaKuroko/AutoWSGR@ShiinaKuroko` 的明确提交。

运行时使用与 GUI 相同的 `allow_test_updates` 选择后端。安装后清除
`.env_ready`，首次启动按 `forceUpdateOnInstall` 完成受控更新和复核。

## `.env_ready`

`{appRoot}/.env_ready` 缓存已验证的环境身份，包括：

- Python 路径和版本。
- AutoWSGR 版本/来源。
- 当前受管后端固定来源（仓库和提交）。
- managed/external 模式和仓库。
- 依赖安装目标。

快速路径仍会检查解释器、环境身份和后端契约。配置、安装目标、GUI 更新通道或
后端固定来源变化后删除标记；失败时不写完成标记，使下次启动继续检查。
external 模式始终使用用户指定仓库，不受 GUI 更新通道影响。

## CUDA 与 OCR

配置：

- `ocr_gpu_mode`: `auto | cpu | cuda`
- `cuda_path`

启动前使用同一 Python 探测 `torch.cuda.is_available()`。最终只向后端传明确
模式 `cpu` 或 `cuda`：

- 强制 `cpu` 始终使用 CPU。
- `auto` 有 CUDA 时用 CUDA，否则用 CPU。
- 强制 `cuda` 但探测失败时直接报错。

正式环境变量：

```text
AUTOWSGR_OCR_GPU_MODE=cpu|cuda
AUTOWSGR_SAVE_IMAGES=true|false
```

GUI 不通过 monkey patch 控制 OCR。

## ADB 与模拟器

| 能力 | 所有者 |
|---|---|
| 注册表检测模拟器 | `electron/emulatorDetect.ts` |
| ADB 路径、devices、connect/disconnect | `AdbService` |
| Renderer IPC | `DeviceIpc` |

当前检测 MuMu、雷电和 BlueStacks。后端启动前读取用户配置的 serial 并连接。
退出时只停止 GUI 内置 ADB server，不应杀死系统或其他工具的 ADB。

NSIS 覆盖安装也只按完整可执行路径停止安装目录中的 `adb.exe`。

## 后端启动

`BackendService.startBackend()` 顺序：

```text
解析 PythonEnvironment
  -> 构建 PATH/CUDA/ADB 环境
  -> 探测 torch CUDA
  -> 选择明确 OCR 模式
  -> 验证 AutoWSGR 实际导入来源
  -> 验证正式环境变量行为
  -> 验证 autowsgr.server.main:app 是 ASGI
  -> spawn python -X utf8 -c <bootstrap>
  -> uvicorn 绑定 127.0.0.1:<port>
```

`BackendService` 独占活动子进程引用。`BackendIpc` 不能保存另一个进程状态。

stdout/stderr 日志由 Main 过滤 access/debug 噪声后发送 Renderer；原始进程错误
仍应保留足够上下文用于启动失败诊断。

## Main 启动生命周期

主进程顺序不可随意交换：

```text
SingleInstanceService.acquire()
  -> 处理 pending GUI update
  -> 旧安装迁移选择
  -> initPythonEnv()
  -> initBackend()
  -> 初始化作战/编队用户目录
  -> 初始化舰船资料库
  -> v6 预设库存迁移
  -> v7 旧方案迁移
  -> 迁移报告与冲突状态
  -> registerUpdaterIpc()
  -> WindowService.createWindow()
```

次实例立即退出并唤醒已有窗口。更新安装中的次实例只显示更新提示，不能执行
配置迁移、pip 或创建旧窗口。

## 迁移

`MigrationStateStore` 独占：

```text
userData/.migration-state.json
```

当前主阶段：

- `UserDataMigrationService`：用户数据迁移版本 6。
- `migration:v6:preset-inventory:complete`：预设库存。
- `LegacyPlanMigration`：旧方案版本 7。
- `migration:v7:legacy-plans:complete`：旧方案分类。
- 每个旧安装来源的 `started`、`configuration-complete`、`complete`。

规则：

1. `mergeCompleted()` 合并旧 marker，不覆盖已完成项。
2. 所有文件原子写入成功后才完成阶段。
3. 失败时只重试未完成阶段/文件。
4. 源文件不删除、不修改。
5. 同名不同内容以“（旧版）”保留。
6. 引用随实际迁移目标同步。
7. 实际发生迁移时显示总数、成功数和失败项。

新的配置转换必须使用独立 stage key，不能复用或覆盖已有完成标记。

NSIS 从 1.4.x 覆盖升级时，必须在旧卸载器运行前将旧用户数据移到
`%LOCALAPPDATA%\AutoWSGR-GUI\legacy-upgrade`，新文件安装后再恢复为迁移源。
保存冲突或恢复失败时安装停止，备份目录继续保留。回退应使用该备份和旧安装器，
不得让旧版直接写入唯一的 2.0 `userData`。

## GUI 更新

`GuiUpdatePolicy` 支持严格版本/频道：

| 版本 | 频道 |
|---|---|
| `X.Y.Z` | `latest` |
| `X.Y.Z-alpha[.N]` | `alpha` |
| `X.Y.Z-beta.N` | `beta` |
| `X.Y.Z-dev[.N]` | `dev` |

用户设置 `allow_test_updates` 同时选择 GUI 与 managed 后端来源：

- Stable 从 `yltx/AutoWSGR-GUI` 读取 `latest`，后端使用
  `OpenWSGR/AutoWSGR@main` 的固定提交。
- Alpha 从 `ShiinaKuroko/AutoWSGR-GUI` 读取 `alpha`，后端使用
  `ShiinaKuroko/AutoWSGR@ShiinaKuroko` 的固定提交。

Alpha 构建在该字段缺失时默认开启，Stable 默认关闭。关闭预览版后不会自动降级，
而是等待版本号更高的 Stable。频道 setter 可能重新允许降级，因此每次切换后必须
显式恢复 `allowDowngrade = false`。后端在重启后根据新通道更新。

已有 `2.0.16-alpha` 客户端使用旧的 Alpha-only 策略，因此首个 Stable 版本线必须
先发布更高的 Alpha 桥，再发布同基础版本 Stable。Stable Release 在迁移窗口内同时
携带桥接版的 `alpha.yml`、安装包和 blockmap，确保休眠旧 Alpha 客户端仍能先升级
到桥接版，再切换到 Stable。
更新检查返回 `available | up-to-date | error`，网络错误不能显示为最新版。

下载完成后用户选择立即重启或下次启动。pending 更新必须在任何迁移和窗口创建前
处理。

## 停止与退出

`BackendShutdownService` 的固定顺序：

1. `POST /api/system/stop`，等待正式清理。
2. Windows 使用 `taskkill /PID <pid> /T` 终止进程树。
3. 等待 `close`。
4. 超时后 `/T /F` 强制终止并再次等待。
5. 仍无法确认退出时抛错，保留活动进程引用。

Main `before-quit` 再停止内置 ADB，成功后才调用 `app.quit()`。GUI 更新安装复用
同一资源停止流程。

## 验证

```powershell
npm run test:python-environment
npm run test:backend-distribution
npm run test:main-services
npm run test:migrations
```

修改安装/更新资源后还应执行 `npm run pack` 和
`npm run test:release-package`。

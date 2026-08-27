# AutoWSGR-GUI

[AutoWSGR](https://github.com/OpenWSGR/AutoWSGR) 的 Windows 桌面图形界面，使用 Electron、TypeScript 和 SCSS 构建。

GUI 负责配置、编辑和管理 YAML，并通过 HTTP 与 WebSocket 连接 AutoWSGR 后端。后端模型和 YAML 契约是功能的事实来源，GUI 不额外定义后端不支持的字段或规则。

> 当前稳定版本为 **GUI 2.1.0**，使用 `latest` 更新频道。1.4.x 用户覆盖安装时，
> 安装器会先将旧用户数据保存在
> `%LOCALAPPDATA%\AutoWSGR-GUI\legacy-upgrade`，再由 2.x 首次启动迁移。
> 包括 `2.0.16-alpha` 在内的 Alpha 客户端不会跨频道自动切换到稳定版，
> 需要手动下载安装 2.1.0。

## 功能总览

当前主导航分为 **作战**、**计划** 和 **设置**。

### 作战

- 展示当前任务、剩余次数、任务进度、运行状态和远征倒计时。
- 导入出征 YAML，或从计划管理中选择已有计划。
- 管理任务列表：新建、保存、加载及整组加入队列。
- 管理任务队列：开始、停止和清空。
- 提供收取远征、收取奖励、收取建造、食堂烹饪和浴室修理等快捷操作。
- 实时显示后端日志，并支持按日志等级筛选。
- 当前任务携带明确编队时，在舰队预览中展示最多六艘舰船立绘；
  没有任务执行时显示空状态。

### 计划

计划页用于生成、保存和管理 YAML，不直接执行出征任务。完成编辑后，需要回到作战页将计划加入任务列表和任务队列。

#### 舰队规划

- 使用本地舰船资料库展示舰船立绘和资料。
- 支持舰名或编号搜索、舰种和国籍多选、改造过滤及多种排序方式。
- 编辑六个主选位置，以及每个位置独立的备选队列。
- 支持主选、备选和舰船图鉴之间拖拽，空位自动整理到右侧。
- 支持纯备选位置、位置级等级限制及复制备选队列。
- 支持新建、保存和加载；未保存修改与同名覆盖均会二次确认。
- 用户舰队保存到应用用户数据目录下的
  `user_team_plans/team-{预设名称}.yaml`。

舰队 YAML 支持主选舰船和位置级 `candidates`。一个位置也可以没有主选 `name`，只保留非空的结构化 `candidates`。

#### 出征规划

- 编辑地图章节、关卡、执行次数、轮次间隔和舰队编号。
- 配置战况、维修策略、维修方式、战利品停止条件和掉落停止条件。
- 选择并预览一个或多个舰队方案。
- 通过地图编辑节点启用状态、终点、迂回、阵型、战斗动作、最低战果和索敌规则。
- 支持新建、保存和加载；保存时校验文件名、地图信息及 YAML 内容。
- 用户计划保存到应用用户数据目录下的
  `user_battle_plans/bettle-{预设名称}.yaml`。

出征规划当前没有直接执行入口。保存后的计划应在作战页加载并加入队列。

#### 决战计划（旧）

保留旧版决战计划配置入口，用于现有决战流程。该页面属于兼容功能，不代表新的统一 YAML 任务设计。

#### 计划管理

- 汇总系统和用户的出征计划、舰队方案及关联状态。
- 支持按来源、类型、名称和“仅看需要处理”筛选。
- 标记舰队缺失、未被引用或 YAML 无法读取等状态。
- 支持从管理列表跳转到舰队规划或出征规划并加载对应文件。
- 用户 YAML 可以删除；系统 YAML 在界面中按只读资源处理。
- 对不需要关联舰队的 YAML，可以忽略未关联提示并随时恢复。

### 设置

设置页分为 **系统设置** 和 **脚本行为**。

系统设置包括：

- 模拟器类型、路径、账号和 ADB 地址。
- ADB 主动连接、断开、自动检测及在线状态。
- 自动远征、战役、演习、出征和胖次任务。
- 日志等级、日志目录和调试模式。
- Python 路径、后端地址、后端启动模式及本地 AutoWSGR 仓库路径。
- 默认窗口大小、记录退出时窗口位置和大小。
- GUI 更新模式、舰船数据库更新。
- 亮色、暗色、跟随系统主题及主色调。

脚本行为包括：

- 全局操作延迟。
- 手动安全强化。策略继续保存但不加入 Scheduler；可扫描只读库存并生成 occurrence 收益预览，界面不提供执行入口。
- OCR 下载源、加速模式、CUDA 路径和硬件识别。
- 舰名匹配置信度、系统舰名规则、自定义舰名映射和识别纠错规则。
- 舰队、船坞、维修、解装及自定义作战方案目录等后端配置。

## 推荐使用流程

1. 在设置页配置模拟器、ADB、Python 和后端启动模式。
2. 按需更新舰船数据库。
3. 在舰队规划中创建并保存舰队方案。
4. 在出征规划中创建计划、关联舰队并保存 YAML。
5. 在计划管理中检查计划与舰队的关联状态。
6. 回到作战页加载计划，加入任务列表和任务队列后执行。

## 安装与运行

### 普通用户

1. 安装并启动 MuMu 12、雷电或 BlueStacks。
2. 从 [Releases](https://github.com/ShiinaKuroko/AutoWSGR-GUI/releases) 下载 Windows x64 安装包。
3. 安装并启动 AutoWSGR-GUI。
4. 在设置页确认模拟器、ADB 地址和后端环境。

### 从旧版本升级与回退

- 1.4.x 稳定版用户可以使用 2.1.0 安装包覆盖升级。旧安装目录中的设置、任务列表、
  模板和用户计划会先备份到
  `%LOCALAPPDATA%\AutoWSGR-GUI\legacy-upgrade`；确认迁移结果前不要删除该目录。
- Alpha 与稳定版使用不同更新频道。Alpha 客户端不会自动收到 `latest` 频道的
  2.1.0，必须手动运行稳定版安装包。
- 如果必须回退，应先退出 2.x，使用旧安装器重新安装，再从上述备份恢复旧格式
  数据；不要让旧版直接使用或覆盖唯一的 2.x `userData`。

默认的 `managed` 模式由 GUI 管理 Python 和 AutoWSGR 依赖。依赖安装到程序自己的 `python/site-packages/`，不会写入系统 Python 的全局包目录。

安装包不预装 `python/site-packages`。首次使用 `managed` 模式时需要联网安装 GUI
锁定提交的 AutoWSGR 及其依赖，准备时间受网络影响。离线使用或联调后端源码时，
应在设置页选择 `external` 模式并指定已有 AutoWSGR 仓库和 Python 环境。

遇到环境问题时，可以运行 `debug_deps.bat` 生成诊断信息。

### 发布包内容

GUI 2.1.0 稳定版安装包包含并验收以下运行内容：

- AutoWSGR-GUI、便携版 Python 3.12、pip、ADB 和 VC++ 运行库。
- 地图、系统出征计划、系统舰队方案、系统日常计划和舰船资料库。
- 安装与环境诊断脚本、舰船资料更新工具。
- AutoWSGR 固定来源信息；主库本体在首次环境准备时安装。

用户 YAML、`usersettings.yaml`、`gui_settings.json` 和 `task_groups.json` 不进入
安装包，也不会因更新系统资源而被覆盖。

### 源码运行

前置要求：

- Windows 10/11
- Node.js 18 或更高版本
- npm
- AutoWSGR 后端需要 Python 3.12 或 3.13

```powershell
git clone https://github.com/yltx/AutoWSGR-GUI.git
cd AutoWSGR-GUI
npm install
npm run dev
```

项目没有热重载。修改代码后需要退出当前 Electron 实例，再次运行 `npm run dev`。

## 后端启动模式

### managed

适合普通用户：

- GUI 查找或准备可用的 Python。
- AutoWSGR 及依赖由 GUI 安装到本地 `python/site-packages/`。
- GUI 启动并管理 uvicorn 后端进程。
- 自动更新策略由设置页的更新模式控制。

### external

适合同时开发 GUI 和 AutoWSGR 后端：

- 使用本地 AutoWSGR 仓库源码及其虚拟环境。
- 本地仓库根目录必须包含 `autowsgr/server/main.py`。
- GUI 将仓库根目录加入后端 Python 的模块搜索路径。
- external 模式不会自动安装或更新远端 `autowsgr`；缺少依赖时，本地仓库本身作为安装 requirement。

可以在设置页填写，也可以在开发模式的 `gui_settings.json` 中配置：

```json
{
  "backend_startup_mode": "external",
  "backend_repo_path": "C:\\path\\to\\AutoWSGR",
  "python_path": "C:\\path\\to\\AutoWSGR\\.venv\\Scripts\\python.exe",
  "update_mode": "manual"
}
```

默认后端地址为 `http://127.0.0.1:8438`。MuMu 12 常用 ADB 地址为 `127.0.0.1:16384`，实际值应以模拟器实例为准。

## YAML 与数据目录

系统资源和用户数据分开存放：

| 路径 | 内容 |
| --- | --- |
| `resource/system_battle_plans/` | 系统出征计划，界面中只读 |
| `resource/system_team_plans/` | 系统舰队方案，界面中只读 |
| `resource/system_daily_plans/` | 系统日常计划，界面中只读 |
| `resource/ship-library/` | 舰船资料库 manifest、中文标签和本地资源 |
| `resource/maps/` | 出征规划使用的地图数据 |
| `userData/user_battle_plans/` | 用户出征计划，标准文件名为 `bettle-{名称}.yaml` |
| `userData/user_team_plans/` | 用户舰队方案，标准文件名为 `team-{名称}.yaml` |
| `userData/user_daily_plans/` | 用户日常计划 |
| `userData/usersettings.yaml` | 传递给 AutoWSGR 后端的用户配置 |
| `userData/gui_settings.json` | GUI 环境、窗口、调度及界面状态 |
| `userData/task_groups.json` | 作战页任务列表数据 |

`userData` 表示 Electron 为当前用户分配的应用数据目录。打包运行时，系统资源从
安装包资源目录读取，用户数据由主进程写入该可写目录。不要直接修改系统方案；
需要调整时应另存为个人副本。1.4.x 覆盖升级时，旧版安装目录中的配置会先移到
`%LOCALAPPDATA%\AutoWSGR-GUI\legacy-upgrade`，再恢复为迁移源并复制到
`userData`；备份副本会保留用于迁移重试和手工回退。

GUI 保存的 YAML 必须通过当前前端校验，并最终符合 AutoWSGR 后端模型。战斗方案字段说明见 [docs/plan-guide.md](docs/plan-guide.md)。

## 开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 清理、编译、打包并启动 Electron |
| `npm start` | 执行构建后启动 Electron |
| `npm run build` | 编译 TypeScript、SCSS 并打包渲染进程，不启动应用 |
| `npm run build:css` | 单独编译 SCSS |
| `npm run prepare-python` | 准备便携版 Python |
| `npm run prepare-adb` | 准备 ADB 工具 |
| `npm run pack` | 生成未安装的应用目录 |
| `npm run dist` | 准备 Python 和 ADB，并生成 NSIS 安装包 |
| `npm run test:release-package` | 验证安装包版本、频道、运行时和内置资源 |

## 项目结构

```text
├── electron/                   # Electron 主进程、IPC、后端和环境管理
│   ├── main.ts                 # 主进程组合根和生命周期
│   ├── preload.ts              # 安全桥接
│   ├── ipc/                    # 最小 IPC 通道注册
│   ├── services/               # 文件、计划、迁移、更新和后端服务
│   ├── emulatorDetect.ts       # 模拟器检测
│   └── pythonEnv/              # Python 与依赖环境管理
├── src/
│   ├── controller/             # 页面业务协调与调度
│   ├── model/                  # 配置、计划、API、任务和调度模型
│   ├── view/                   # 作战、计划、设置页面及 SCSS
│   ├── types/                  # TypeScript 类型与 bridge 契约
│   ├── shared/                 # 跨层纯契约和无状态规则
│   └── utils/                  # 日志及通用工具
├── resource/
│   ├── maps/                   # 地图数据
│   ├── ship-library/           # 舰船资料库
│   ├── system_battle_plans/    # 系统出征计划
│   ├── system_daily_plans/     # 系统日常计划
│   └── system_team_plans/      # 系统舰队方案
├── tools/ship_library/         # 舰船资料库更新工具
├── scripts/                    # 构建、Python 和 ADB 准备脚本
├── docs/                       # 使用与架构文档
├── build/                      # electron-builder / NSIS 配置
├── setup.bat                   # Windows 环境配置脚本
├── debug_deps.bat              # 环境诊断脚本
├── package.json
└── tsconfig.json
```

## 文档

- [用户使用指南（含节点索敌规则说明）](docs/user-guide.md)
- [战斗方案 YAML 说明](docs/plan-guide.md)
- [架构文档索引](docs/architecture/README.md)
- [开发环境搭建](docs/architecture/08-dev-setup.md)
- [环境管理](docs/architecture/07-environment-management.md)
- [贡献指南](CONTRIBUTING.md)

## 技术栈

- Electron 33
- TypeScript 5.6
- esbuild
- Sass / SCSS
- electron-builder / NSIS
- js-yaml
- AutoWSGR FastAPI / uvicorn 后端

## 贡献

欢迎参与开发！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和强制性的 [AGENTS.md](AGENTS.md)。

## 许可证

项目源码采用 MIT 许可证。第三方运行时资源不因进入本仓库而自动适用 MIT；例如
随包分发的 WSG-NCC 运行数据按 [`resource/wsg-ncc/NOTICE.md`](resource/wsg-ncc/NOTICE.md)
记录的作者授权处理。

# AutoWSGR GUI

[AutoWSGR](https://github.com/OpenWSGR/AutoWSGR) 的桌面图形界面，基于 Electron + TypeScript 构建。

## 当前 GUI 已实现功能

- **主页**
  - 连接状态与远征倒计时展示
  - 手动运维操作（收远征 / 收奖励 / 收建造 / 食堂烹饪 / 浴室修理）
  - 任务队列开始、停止、清空
  - 任务组管理（新建、重命名、删除、导入导出、整组入队）
  - 后端日志实时查看与等级过滤
- **方案预览**
  - 导入 YAML 或从地图新建方案
  - 节点路线可视化与节点级参数编辑
  - 方案级参数配置（修理策略、战况、编队、次数、间隔、终止条件）
  - 编队预设与泡澡修理阈值配置
  - 一键加入队列 / 加入任务组 / 保存 YAML / 另存为
- **模板库**
  - 支持普通出击、演习、战役、决战四类模板
  - 模板导入、创建、详情配置、加入任务列表
- **配置页**
  - 模拟器类型、路径、ADB 串号检测
  - Python 解释器路径检测与后端端口设置
  - 自动更新模式与手动检查更新
  - 每日自动任务（远征、战役、演习、常规出击、决战、战利品）
  - 主题模式、主色调、调试模式
- **调度与运行**
  - 任务优先级调度
  - 条件停止与失败重试
  - 启动流程检查与运行期日志可观测

## 安装

### 普通用户

1. 安装 Android 模拟器（MuMu 12 / 雷电 / 蓝叠）
2. 从 [Releases](https://github.com/yltx/AutoWSGR-GUI/releases) 下载最新安装包
3. 安装运行，程序自动配置环境（下载便携 Python 3.12、安装 autowsgr 依赖到程序目录，**不影响系统环境**）
4. 确保模拟器已运行，程序自动检测并连接

> 如果你已有 Python ≥ 3.12，程序也可以使用它（依赖仍安装到 `python/site-packages/`，不修改全局包）。
>
> 遇到问题时可运行 `debug_deps.bat` 生成诊断报告。

### 开发者

```bash
git clone https://github.com/yltx/AutoWSGR-GUI.git
cd AutoWSGR-GUI
npm install
setup.bat              # 安装便携 Python + autowsgr 依赖
npm run dev            # 编译 + 启动 Electron
```

## 用户文档

- GUI 操作指南（含“从方案预览页开始的新建任务配置流程”）：[docs/user-guide.md](docs/user-guide.md)
- YAML 关键字说明（战斗方案编写）：[docs/plan-guide.md](docs/plan-guide.md)

## 编写战斗方案

参见 [docs/plan-guide.md](docs/plan-guide.md)，详细说明 YAML 方案的所有关键字和用法。

`plans/` 目录提供了多个示例方案可供参考。

## 项目结构

```text
├── electron/               # Electron 主进程
│   ├── main.ts             #   窗口管理、IPC 注册、应用生命周期
│   ├── preload.ts          #   contextBridge 安全桥接
│   ├── backend.ts          #   Python 后端进程管理
│   ├── emulatorDetect.ts   #   模拟器注册表检测
│   └── pythonEnv/          #   Python 环境检查、安装、更新（7 个模块）
├── src/
│   ├── controller/         # 控制器层 — 业务逻辑与调度
│   │   ├── app/            #   AppController、ConfigController、SchedulerBinder
│   │   ├── plan/           #   PlanController（方案编辑）
│   │   ├── startup/        #   StartupController（启动流程）
│   │   ├── taskGroup/      #   TaskGroupController
│   │   ├── template/       #   TemplateController
│   │   └── shared/         #   ControllerHost 接口
│   ├── model/              # 模型层 — 数据、API、调度
│   │   ├── ApiClient.ts    #   HTTP + WebSocket 通信
│   │   ├── ConfigModel.ts  #   用户配置读写
│   │   ├── PlanModel.ts    #   方案数据 & YAML 序列化
│   │   ├── scheduler/      #   Scheduler、CronScheduler、TaskQueue
│   │   ├── TaskGroupModel.ts
│   │   └── TemplateModel.ts
│   ├── view/               # 视图层 — 纯 DOM 渲染
│   │   ├── main/           #   主页面（状态、队列、日志）
│   │   ├── plan/           #   方案预览 & 地图可视化
│   │   ├── config/         #   配置页
│   │   ├── template/       #   模板库
│   │   ├── taskGroup/      #   任务组管理
│   │   ├── setup/          #   安装向导
│   │   └── styles/         #   SCSS 样式
│   ├── types/              # TypeScript 类型定义
│   ├── data/               # 静态数据（舰船信息）
│   └── utils/              # 工具（Logger 等）
├── resource/               # 运行时资源（地图 JSON、内置方案、图片）
├── scripts/                # 构建脚本（esbuild、prepare-python、prepare-adb）
├── plans/                  # 示例 YAML 战斗方案
├── templates/              # 用户模板持久化
├── docs/                   # 文档 & 架构说明
├── build/                  # electron-builder 配置（NSIS 脚本）
├── setup.bat               # 环境一键配置
├── debug_deps.bat          # 依赖诊断脚本
├── package.json
└── tsconfig.json
```

## 开发命令

| 命令 | 说明 |
| ------ | ------ |
| `npm run dev` | 编译 TypeScript + 打包 + 启动 Electron |
| `npm run build` | 仅编译 + 打包（不启动） |
| `npm run build:css` | 编译 SCSS → CSS |
| `npm run dist` | 下载 Python/ADB + 编译 + 打包为 NSIS 安装程序 |
| `npm run pack` | 编译 + 打包为目录（不生成安装程序） |

## 架构说明

采用 **MVC + ViewObject** 模式，详细文档见 [docs/architecture/](docs/architecture/)。

- **Controller** — 从 Model 提取数据，拼装为只读 ViewObject，单向传递给 View
- **View** — 纯 DOM 渲染，不包含业务逻辑
- **Model** — API 通信、配置解析、任务调度、数据持久化

Python 后端通过 `pip install autowsgr` 安装（`--target` 安装到程序目录），由 Electron 主进程管理 uvicorn 子进程，前端通过 HTTP + WebSocket 与后端通信。

## 贡献

欢迎参与开发！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT

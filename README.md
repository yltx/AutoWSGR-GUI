# AutoWSGR GUI

[AutoWSGR](https://github.com/OpenWSGR/AutoWSGR) 的桌面图形界面，基于 Electron + TypeScript 构建。

## 功能

- **主页** — 实时状态面板、任务队列管理、后端日志查看、远征自动检查
- **方案预览** — 导入 YAML 战斗方案，点击节点编辑阵型/夜战/推进/索敌规则
- **配置** — 模拟器路径自动检测、账号设置、主题切换（暗色/浅色/跟随系统）、自定义主色调

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Android 模拟器 | MuMu 12 / 雷电 / 蓝叠 | 必须 |
| [Python](https://www.python.org/) | ≥ 3.12 | setup 可自动安装便携版 |
| [Node.js](https://nodejs.org/) | ≥ 18 | 仅开发需要 |
| [Git](https://git-scm.com/) | 任意 | 仅开发需要 |

> **普通用户**只需安装模拟器，从 [Releases](https://github.com/yltx/AutoWSGR-GUI/releases) 下载安装包即可。首次启动会自动下载便携 Python 并安装后端依赖到程序目录，不会影响系统环境。
>
> 如果你已有全局 Python (≥ 3.12)，程序也可以使用它（依赖仍安装到程序目录的 `python/site-packages/`，不修改全局包）。

## 快速开始（用户）

1. 从 [Releases](https://github.com/yltx/AutoWSGR-GUI/releases) 下载最新安装包
2. 安装并启动，程序会自动配置环境（下载 Python、安装 autowsgr 依赖）
3. 确保模拟器已运行，程序自动检测并连接

也可以手动运行 `setup.bat` 来配置环境。

## 快速开始（开发者）

```bash
# 1. 克隆仓库
git clone https://github.com/yltx/AutoWSGR-GUI.git
cd AutoWSGR-GUI

# 2. 安装前端依赖
npm install

# 3. 安装后端依赖（以下二选一）
pip install autowsgr              # 从 PyPI 安装
.\setup.bat                       # 或运行 setup 脚本自动配置

# 4. 启动
npm run dev
```

## 编写战斗方案

参见 [docs/plan-guide.md](docs/plan-guide.md) — 详细说明 YAML 方案配置的所有关键字和用法。

`plans/` 目录提供了多个示例方案可供参考。

## 项目结构

```
├── electron/           # Electron 主进程
│   ├── main.ts         #   窗口管理、IPC、后端进程管理
│   └── preload.ts      #   contextBridge 安全桥接
├── src/
│   ├── controller/     # 控制器（业务逻辑）
│   │   └── AppController.ts
│   ├── model/          # 模型（数据 & API）
│   │   ├── ApiClient.ts
│   │   ├── ConfigModel.ts
│   │   ├── PlanModel.ts
│   │   ├── Scheduler.ts
│   │   └── types.ts
│   └── view/           # 视图（纯渲染）
│       ├── MainView.ts
│       ├── PlanPreviewView.ts
│       ├── ConfigView.ts
│       ├── viewObjects.ts
│       ├── index.html
│       └── styles.css
├── scripts/
│   └── bundle.js       # esbuild 打包脚本
├── plans/              # 示例战斗方案 (YAML)
├── docs/               # 文档
├── resource/            # 地图数据、图标等资源
├── package.json
└── tsconfig.json
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 编译 + 打包 + 启动 Electron |
| `npm run build` | 仅编译 + 打包（不启动） |
| `npm run dist` | 打包为安装程序 (electron-builder) |

## 架构说明

采用 **MVC + ViewObject** 模式：

- **Controller** 从 Model 提取数据，拼装为只读的 ViewObject，单向传递给 View
- **View** 仅负责 DOM 渲染，不包含业务逻辑
- **Model** 封装 API 通信、配置解析、任务调度

后端通过 `pip install autowsgr` 安装（所有依赖使用 `--target` 安装到程序目录），Electron 主进程自动启动 uvicorn 服务（`127.0.0.1:8000`），前端通过 HTTP + WebSocket 与后端通信。

## 许可证

MIT

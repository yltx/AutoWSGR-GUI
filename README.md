# AutoWSGR GUI

[AutoWSGR](https://github.com/OpenWSGR/AutoWSGR) 的桌面图形界面，基于 Electron + TypeScript 构建。

## 功能

- **主页** — 实时状态面板、任务队列管理、后端日志查看
- **方案预览** — 导入 YAML 战斗方案，点击节点编辑阵型/夜战/推进/索敌规则
- **配置** — 模拟器路径自动检测、账号设置、主题切换（暗色/浅色/跟随系统）、自定义主色调

## 环境要求

| 依赖 | 版本 |
|------|------|
| [Node.js](https://nodejs.org/) | ≥ 18 |
| [Python](https://www.python.org/) | ≥ 3.12 |
| [Git](https://git-scm.com/) | 任意 |
| Android 模拟器 | MuMu 12 / 雷电 / 蓝叠 |

## 快速开始

```bash
# 1. 克隆仓库（含后端子模块）
git clone --recurse-submodules https://github.com/yltx/AutoWSGR-GUI.git
cd AutoWSGR-GUI

# 2. 安装前端依赖
npm install

# 3. 安装后端依赖（首次运行时也会自动安装）
pip install -e ./autowsgr

# 4. 启动
npm run dev
```

> 如果克隆时忘记 `--recurse-submodules`，可以补执行：
> ```bash
> git submodule update --init
> ```

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
├── autowsgr/           # 后端子模块 (OpenWSGR/AutoWSGR)
├── package.json
└── tsconfig.json
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 编译 + 打包 + 启动 Electron |
| `npm run build` | 仅编译 + 打包（不启动） |

## 架构说明

采用 **MVC + ViewObject** 模式：

- **Controller** 从 Model 提取数据，拼装为只读的 ViewObject，单向传递给 View
- **View** 仅负责 DOM 渲染，不包含业务逻辑
- **Model** 封装 API 通信、配置解析、任务调度

后端（AutoWSGR）通过 `pip install -e ./autowsgr` 以开发模式安装，Electron 主进程自动启动 uvicorn 服务（`127.0.0.1:8000`），前端通过 HTTP + WebSocket 与后端通信。

## 许可证

MIT

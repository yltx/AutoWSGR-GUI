# 贡献指南

感谢你对 AutoWSGR-GUI 的关注！本文档帮助你快速上手项目开发。

## 开发环境搭建

### 前置要求

| 工具 | 版本 | 说明 |
|------|------|------|
| [Node.js](https://nodejs.org/) | ≥ 18 | 推荐使用 LTS 版本 |
| [Git](https://git-scm.com/) | 任意 | — |
| Android 模拟器 | MuMu 12 / 雷电 / 蓝叠 | 调试时需要 |

> Python ≥ 3.12 由 `setup.bat` 自动安装便携版到 `python/` 目录，无需手动准备。

### 初始化

```bash
git clone https://github.com/yltx/AutoWSGR-GUI.git
cd AutoWSGR-GUI
npm install            # 安装前端依赖
setup.bat              # 安装便携 Python + autowsgr 后端依赖
npm run dev            # 编译 + 启动
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 编译 + 启动 Electron（日常开发） |
| `npm run build` | 仅编译，不启动 |
| `npm run build:css` | 编译 SCSS |
| `npm run dist` | 完整打包为安装程序 |

## 项目结构概览

```
electron/       → Electron 主进程（窗口、IPC、后端进程管理、Python 环境）
src/controller/ → 控制器层（业务逻辑、调度绑定）
src/model/      → 模型层（API 通信、数据、调度器）
src/view/       → 视图层（纯 DOM 渲染，不含业务逻辑）
src/types/      → TypeScript 类型定义
resource/       → 运行时资源（地图 JSON、内置方案、图片）
scripts/        → 构建与准备脚本
docs/           → 架构文档 & 教程
```

架构采用 **MVC + ViewObject** 模式，Controller 拼装只读 ViewObject 单向传递给 View。详细说明见 [docs/architecture/](docs/architecture/)。

## 代码风格与规范

### 通用规范

- **缩进**：2 空格
- **换行**：LF（已通过 `.gitattributes` + `.editorconfig` 统一）
- **编码**：UTF-8

### TypeScript

- 使用 `strict` 模式（`tsconfig.json` 已配置）
- 文件名使用 PascalCase（类文件）或 camelCase（工具/类型文件）
- 遵循分层原则：
  - **View** 不直接调用 Model 或 API，只接收 ViewObject
  - **Controller** 负责组合 Model 数据并生成 ViewObject
  - **Model** 不感知 View 的存在
- 新增模块时参考同层已有文件的组织方式

### 样式

- 使用 SCSS（`src/view/styles/`），通过 `npm run build:css` 编译
- 遵循已有的 BEM 命名风格

## 分支与提交规范

### 分支命名

| 前缀 | 用途 | 示例 |
|------|------|------|
| `feat/` | 新功能 | `feat/loot-scheduler` |
| `fix/` | 修复 | `fix/websocket-reconnect` |
| `chore/` | 构建、依赖、配置等 | `chore/upgrade-electron` |
| `docs/` | 文档 | `docs/architecture-update` |

### Commit Message

采用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <简要描述>

[可选正文]
```

**type**：`feat` / `fix` / `chore` / `docs` / `refactor` / `style` / `perf`

**scope**（可选）：`controller` / `model` / `view` / `electron` / `build` 等

示例：

```
feat(scheduler): 支持任务优先级拖拽排序
fix(plan): 修复 repair_mode 数组序列化异常
chore(build): 升级 electron-builder 至 v26
docs: 更新架构文档
```

### 提交粒度

- 一个 commit 对应一个逻辑变更，避免把不相关的修改混在一起
- 如果一个功能涉及多层修改（model + controller + view），可以放在同一个 commit 中

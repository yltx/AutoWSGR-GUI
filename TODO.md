# AutoWSGR-GUI 开发路线图

## 阶段一：基础框架与核心功能

- [x] Electron + TypeScript 项目搭建 (esbuild 打包)
- [x] MVC + ViewObject 架构
- [x] 主页面 — 状态卡片、任务队列、远征倒计时、日志面板
- [x] 配置页 — 表单渲染、保存/加载、启动时读取配置
- [x] 方案预览页 — YAML 导入、节点路线、节点编辑面板
- [x] ApiClient — HTTP + WebSocket 与 Python 后端通信
- [x] Scheduler 调度器 — 任务队列管理、顺序执行、状态回调
- [x] 日志面板 — 前端本地日志 + 后端 WebSocket 实时日志
- [x] 多任务类型支持 — 普通战斗、演习、战役、决战、活动
- [x] 任务预设 YAML 导入 — 直接加入队列
- [x] 模拟器自动检测 (注册表读取 ADB 串口)
- [x] 后端自动启动 (Python 子进程管理)
- [x] 环境检查系统 (Python、依赖包版本检测)
- [x] 暗色/亮色主题切换
- [x] UI 美化 — 毛玻璃设计、配置页两栏布局
- [x] 配置页游戏账号卡片隐藏、保存按钮移至标题栏

## 阶段 1.5：打包发布与环境管理

- [x] electron-builder 打包 (NSIS 安装器 + 便携版)
- [x] GitHub Actions 自动构建发布 (workflow_dispatch)
- [x] 打包后空白窗口、UI 冻结、编码问题修复 (共 4 轮)
- [x] 便携 Python 支持 — 自动下载 Python 3.12 嵌入包
- [x] setup.bat 一键配置脚本
- [x] 后端从源码子模块迁移为 pip 包 (`pip install autowsgr`)
- [x] `--target` 本地安装 — 所有依赖安装到项目目录，不污染全局环境
- [x] autowsgr 版本检查 (>= 2.0.4)
- [x] 远征检查接口 — 系统启动后立即检查远征 + 15 分钟定时检查
- [x] 后端添加 `POST /api/expedition/check` 端点 (PR #350)

## 阶段二：方案可视化配置

- [x] 地图数据集成 — 55+ 地图 JSON 文件
- [x] MapDataLoader 模块 — IPC 加载地图 JSON、内存缓存
- [x] 节点类型系统 — 8 种类型 (Start/Normal/Boss/Resource/Penalty/Suppress/Aerial/Hard)
- [x] 节点类型视觉区分 — 不同颜色、CSS 类名、迂回节点虚线边框
- [x] SVG 图标徽章 — Boss(皇冠)、Aerial(炸弹)、Suppress(准星) 等
- [x] 非战斗节点信息面板
- [x] 方案关闭与重新打开
- [x] 可视化地图画布 — Canvas/SVG 渲染节点位置和连线
- [ ] YAML 方案构建器 — 引导式创建新方案 (选图→选路线→配置节点)
- [ ] 方案编辑与保存 — 修改后导出为 YAML 文件
- [ ] 节点拖拽排序

## 阶段三：高级特性与完善

- [ ] 任务组 / 流程编排 — 多方案串联执行
- [ ] 流程模板库 — 预设常用流程模板 (日常、活动、练级等)
- [ ] 模板保存与加载 — 用户自定义模板持久化
- [ ] 远征管理增强 — 远征队伍配置、自动收取提醒
- [ ] 战绩统计与可视化 — 出击记录、资源变化图表
- [ ] 错误恢复与重试策略 — 任务失败后的自动重试/跳过逻辑

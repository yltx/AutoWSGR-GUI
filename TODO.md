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
- [x] debug_deps.bat 诊断脚本 — 输出到文件、检测 distutils/adb/setuptools

## 阶段二：方案可视化配置与日常调度

### 地图可视化（已完成）

- [x] 地图数据集成 — 55+ 地图 JSON 文件
- [x] MapDataLoader 模块 — IPC 加载地图 JSON、内存缓存
- [x] 节点类型系统 — 8 种类型 (Start/Normal/Boss/Resource/Penalty/Suppress/Aerial/Hard)
- [x] 节点类型视觉区分 — 不同颜色、CSS 类名、迂回节点虚线边框
- [x] SVG 图标徽章 — Boss(皇冠)、Aerial(炸弹)、Suppress(准星) 等
- [x] 非战斗节点信息面板
- [x] 方案关闭与重新打开
- [x] 可视化地图画布 — Canvas/SVG 渲染节点位置和连线

### Bug 修复（已完成）

- [x] repair_mode 标签修正 — "大破就修" → "大破才修"
- [x] repair_mode 数组支持 — 6 位独立维修模式 + 混合模式显示 (①大破 ②中破 …)
- [x] Plan + Task YAML 合并 — PlanData 扩展 times/gap/stop_condition/fleet_id
- [x] 地图节点识别/迂回动画/MVP 舰名/掉落 OCR 修复

### 定时调度系统（已完成）

- [x] CronScheduler 模块 — 60 秒 tick 定时器，系统启动后自动运行
- [x] 自动演习 — 支持 0:00/12:00/18:00 刷新窗口检测，按时段自动触发
- [x] 自动战役 — 每天自动触发，可配置次数
- [x] YAML scheduled_time 字段 — 方案支持定时启动 (HH:MM 格式)
- [x] CronScheduler ↔ Scheduler 集成 — 回调自动创建任务并开始消费
- [x] 离线演习补发 — localStorage 缓存关闭时间，重启后检测错过的刷新窗口并自动补发
- [x] 配置页 UI — 演习舰队选择 (1-4)、战役次数输入
- [x] 日常自动化 UI 分块 — 远征/战役/演习三段分隔

### 方案编辑与导出（已完成）

- [x] 方案级别编辑 — 修理策略/战况/编队 改为内联下拉框直接编辑
- [x] 节点编辑 — 阵型/夜战/追击/索敌规则（已有，集成到编辑流程）
- [x] YAML 导出 — PlanModel.toYaml() 序列化 + 保存文件对话框
- [x] 新建空方案 — 选择海域+地图 → 加载所有节点 → 从零配置
- [x] 保存文件对话框 IPC — save-file-dialog (main/preload/bridge)
- [ ] 引导式创建优化 — 选路线子集、节点拖拽排序

## 阶段三：容错与重试

- [ ] 任务失败自动重试 — 可配置重试次数、间隔
- [ ] 异常恢复策略 — 连接丢失重连、卡死检测重启
- [ ] 任务跳过机制 — 连续失败 N 次后自动跳过当前任务
- [ ] 日志级别过滤 — 分级显示 debug/info/warning/error

## 阶段四：高级特性

- [ ] 任务组 / 流程编排 — 多方案串联执行
- [ ] 流程模板库 — 预设常用流程模板 (日常、活动、练级等)
- [ ] 模板保存与加载 — 用户自定义模板持久化
- [ ] 远征管理增强 — 远征队伍配置、自动收取提醒
- [ ] 战绩统计与可视化 — 出击记录、资源变化图表

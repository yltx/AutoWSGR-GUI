# PR #18 Migration Ledger

基线：GUI 2.0 `da5fd8d`
参考：下午整改代码 `reference/gui2-afternoon-20260803` -> `a58b1d1`

## 已重新实现

- 用户计划、舰队、配置迁移到 Electron `userData`。
- 任务组 v1→v2 首次加载写回磁盘，根级/组级/条目级未知字段保留。
- 用户编队根级/槽位级/候选级未知字段 round-trip，candidate-only 结构保留。
- 旧计划启动自动迁移，保留源文件、同名冲突另存、状态记录和失败重试。
- 旧任务组 v1 兼容读取并转换为 v2，保留 `path`、managed identity 和未知条目字段。
- v5 迁移按旧安装目录记录来源和内容哈希；已有 `userData` 时仍会深度合并
  旧设置，迁移任务组、模板和有效 YAML，并更新队列引用。实际输出文件名写入
  迁移状态，重复启动不会重复导入；本次完成后弹窗展示成功和失败数量。
- Electron 文件 IPC 按读写能力限制到 `userData`/只读 `resource`，并拒绝
  `..`、越权绝对路径、UNC、盘符跳转和符号链接逃逸。
- atomic write 失败时不删除旧文件。
- Plan / Config 未知字段 round-trip。
- candidate-only 编队语义。
- scheduler logicalId 与逻辑完成事件。
- external 后端无效时显式失败。
- updater 结果区分 available / up-to-date / error。
- 舰队 1 可更换编成，首槽保护保留。
- 计划添加流程允许不绑定舰队预设。
- AutoWSGR 编队 OCR info 日志。
- AutoWSGR 主库的 20260730 E1/E5/H1/H5 系统计划恢复到只读 `resource/system_battle_plans`，并恢复 `builtin_event_20260730` 模板。
- `main.ts` 已缩减为组合根；主进程按 22 个 Service 和 10 个 IPC 文件拆分，
  IPC 通道名、参数顺序和同步/异步方式由契约测试锁定。
- 舰船资料库使用临时目录、备份目录和失败恢复完成版本切换。
- managed / external 的检查、安装和启动复用同一 Python 环境描述。
- 作战计划、编队、任务组、API map / NodeDecision 均有兼容 fixture。

## 参考分支处理结论

- `electron/fileIpc.ts`：未直接移植；已按当前 SafePath 和 selected-file 能力重写为 `ipc/FileIpc.ts`。
- `electron/appPaths.ts`：未直接移植；已拆为 `AppPaths`、`SafePathService`、`AtomicFileStore` 和迁移服务。
- `electron/shipLibrary.ts`：未直接移植；已拆为 `ShipLibraryService` 和 `ShipLibraryUpdater` 并覆盖失败恢复。
- `src/controller/taskGroup/managedPlanReader.ts`：当前 GUI 2.0 已有同名服务，需补 v1 path identity 和 preset/task group 场景测试。
- `src/controller/taskGroup/TaskListLoaderController.ts`：参考分支没有该文件，不能直接移植；应保留 GUI 2.0 当前任务列表管理器。
- Python 环境服务拆分：未使用参考分支的私有 monkey-patch；当前通过统一环境描述和显式依赖完成。

## 尚未完成的 Issue #18 项目

- Windows 文件锁自动化测试。
- backend graceful shutdown 和完整进程树终止。
- updater prerelease/stable channel 隔离。
- managed / external / CPU / CUDA 真实环境矩阵。
- 新 PR 的提交拆分。

## 验证记录

- `npm run test:settings` 曾在与其他 Electron 测试并行执行时因 Windows
  `dist` 文件锁出现 `EPERM`；清理残留 Electron 进程后串行执行通过。后续
  Electron 测试必须串行运行，避免测试进程竞争构建目录。
- 当前没有使用这个失败结果放宽测试；根因是测试资源生命周期竞争，不是设置持久化断言失败。
- `npm run test:migrations` 统一覆盖已有 `userData`、不同安装目录、
  同名任务组合并、旧 YAML 升级、队列引用更新和重复启动幂等。PR 工作流
  `Build and migration contracts` 会在 Windows runner 自动执行。
- 使用 `AutoWSGR-GUI-old` 的真实数据在隔离临时目录完成两轮演练：空计划目标
  下迁移 4 个作战计划和 8 个编队；复制当前完整 `userData` 后再次迁移时，
  当前队列和用户修改过的编队均保留，旧任务组引用升级成功。演练未修改真实
  `%APPDATA%` 和旧目录，临时目录已清理。
- 主进程拆分完成后已通过：
  `test:main-services`、`test:main-ipc`、`test:settings`、
  `test:migrations`、`test:api-contract`、
  `test:python-environment` 和 `test:event-resources`。

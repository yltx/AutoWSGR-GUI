# AutoWSGR-GUI Agent 约束

本文件是所有人工辅助 Agent、自动化 Agent、代码生成/审查工具和 Issue 分析工具的项目入口。用户明确要求优先于本文件；本文件中的 Coding 原则适用于所有分支和发布频道，`alpha` 不是降低质量门槛的理由。

## 1. Coding 最高原则

### 1.1 四大原则

每一次代码改动，无论大小，都必须同时满足：

1. **最小改动**：只修改实现目标所需的代码、契约和测试，不顺手重构、格式化或清理无关内容。
2. **最大复用**：优先复用职责、生命周期、输入输出和副作用均匹配的现有实现；不得为了表面复用扩大原模块职责。
3. **最低影响现有功能**：业务逻辑、现有能力、UI 元素、交互、样式、配置和已发布数据契约默认保持不变。
4. **严格控制代码边界**：改动必须留在清晰的功能和架构边界内，不得引入跨层补偿、重复状态源或隐式耦合。

业务逻辑正确性和现有行为兼容性为第一优先级。用户提出修复功能 A，只代表授权修改 A 的目标行为，不自动授权改变关联业务规则；若根因修复必须改变业务实现、默认行为、数据含义、交互或功能 B，写入前必须说明现状、拟议变化、影响范围和验证方式，并取得用户确认。

### 1.2 分批改动

- 涉及多个独立功能、多个架构边界或大量手写文件时，必须先给出分批方案，经用户确认后实施。
- 每一批只解决一个可描述、可验证、可审查、可回滚的行为边界，并独立遵守四大原则。
- 每批完成后先检查 diff、运行匹配测试并确认没有相邻回归，再开始下一批。
- 不得先批量搬迁或重写，再依靠后续批次恢复功能；任何中间批次都不能故意处于已知损坏状态。
- 生成入口文件可随对应源文件在同一批更新，但机械生成内容与手写行为代码必须分开说明。

### 1.3 功能边界与防回归

- 修改前必须搜索功能 A 的全部调用方、导入方、事件订阅、DOM ID/Class、CSS 选择器、DTO、持久化字段和测试，列出依赖其实现或契约的功能 B。
- 修复 A 时不得破坏 B 对公共行为的合理依赖；若公共实现必须变化，应先建立兼容边界或同步修改并验证所有消费者。
- 局部问题不得通过修改全局刷新、渲染、调度、持久化或错误处理语义来解决。
- 状态只能有一个权威所有者；重渲染、重新绑定、切页、弹窗开关和异步刷新不得意外重置或复制状态。
- **历史高频回归**：拖动条/滑块在刷新、重渲染或修改其他设置后复位。涉及控件初始化、配置渲染、事件绑定或 View 拆分时，必须验证当前值保持、重复初始化不重置、事件不重复绑定，并回归依赖同一渲染链路的其他控件。
- Bug 修复必须提供修复前可失败、修复后可通过的复现证据；不能只证明目标路径“现在能跑”。

## 2. 接入与事实来源

### 2.0 窄操作快速路径

- 用户明确要求 `push`、`pull`、`fetch`、查看状态/差异、运行一个指定命令或测试、停止进程、读取指定文件等窄操作时，该请求优先于此前 Goal、Team 计划和开发叙事；先完成该操作，不得自动恢复或扩大旧任务。
- 本文件关于实现前搜索调用方、架构阅读、行为设计、测试矩阵和交付审查的规则适用于代码修改、修复、重构、提交和发布，不适用于已经存在 commit 的普通 push 或其他不修改实现的窄 Git 操作。
- 普通 push 不是发布。若上一条消息已经明确仓库、分支、commit 和工作区状态，直接使用这些已建立事实；否则只检查当前仓库的 `git status --short --branch` 和 configured upstream，然后普通 push。成功后最多做一次本地/远端 ref 或 status 确认并立即停止。
- 普通 push 前不得重新运行测试、重新审查实现、盘点无关分支、绘制完整提交图、分析 merge-base、检查 CI/Tag/Release、探测 SSH 或审计其他仓库。只有当前 push 失败且对应证据直接决定下一步时，才一次增加一个诊断动作；不得并行尝试多种传输、代理或认证方案。
- 窄操作通常控制在一至两个工具轮次内。每个额外调用都必须回答一个尚未解决、且会改变下一步决策的事实；仅用于“再确认一次”、展示活动或恢复旧 Goal 的调用应省略。

开始写入前必须：

1. 执行 `git status --short --branch`，识别当前分支和用户已有修改；不得覆盖、回退或整理非当前任务内容。
2. 首次进入项目或开始新的非平凡实现前，按 `docs/architecture/README.md` 的路由读取 `00-overview.md`、`12-agent-entry-guide.md`、`10-runtime-boundaries-adr.md` 和任务对应专题。后续局部任务不要求重复通读无关专题。
3. 按任务读取 `package.json`、`tsconfig.json`、构建脚本、CI、受影响源码、直接调用方和最近的专项测试。
4. 说明行为目标、非目标、可复用实现、最少修改文件、状态所有者、功能消费者、风险和验证计划。
5. 搜索同领域规则、历史 workaround 和兼容契约；第三次修复或重复回归必须先分析此前失败原因，不能继续叠加 guard、retry、delay 或 fallback。

事实与约束分开判断：

- 用户明确要求最高；本文件是 Coding、质量和协作流程的唯一规范入口。
- 当前 GUI 的目录、依赖、命令和运行行为以可执行配置、CI、测试和生产源码为准；不得用主库旧基线反向改造当前结构。
- `docs/architecture/**` 描述当前架构，`10-runtime-boundaries-adr.md` 定义应保持的设计边界；发现文档与实现冲突时先报告并判断是实现偏离还是文档过期，不得静默选择一方。
- 本文件 4.1 节是基于主库 1.4.4 路线的有效并行协作契约，不是当前 GUI 的目录或完成状态清单。
- 架构、公共契约或协作职责发生变化时，同一批更新对应架构/工程文档；仅定位文件时可使用 `09-src-typescript-catalog.md`，不得把数量快照当稳定边界。

### 2.1 修复止损

- 声称修复后问题仍可复现、验证失败、需要绕过上次错误假设，或保留旧 workaround 后再增加特殊处理，均算一次失败尝试；纯诊断日志和不改变行为的 instrumentation 不计入。

| 等级 | 触发条件 | 必须执行的动作 |
|---|---|---|
| L0 正常变更 | 无失败尝试、无意外扩散、有直接证据 | 正常实现和审查 |
| L1 记录修正 | 一次失败，或出现一个止损信号 | 记录原假设、失败证据、状态所有者和新验证计划 |
| L2 维护者检查点 | 两次连续失败，或同时出现两个止损信号 | 暂停实现；用户批准重新设计、拆分或干净重写后才能继续 |
| L3 Patch Freeze | 三次失败且仍有止损信号，或出现竞争状态源 | 禁止叠加补丁，先建立确定性复现和替代设计 |
| L4 干净重写 | 无法删除失败 workaround、恢复单一状态源或证明端到端行为 | 从最后已知正常基线建立隔离分支/worktree，先固定行为契约再重新实现 |

- 止损信号包括范围外跨层补偿、新可写状态/同步标志/影子缓存、规则重复、retry/delay/catch-and-ignore/多级 fallback、放宽类型或测试，以及无法解释完整因果链。
- 同一问题的失败次数跨 Agent、会话、分支和实现方案累计，不能通过换人、换文件或改名重置。
- 第三次尝试前必须说明前两次为什么失败、原因链如何变化、新证据如何区分假设；没有新因果模型不得继续补 guard、retry、delay 或 fallback。
- 修改中出现新状态源、跨层补偿、公共契约变化或范围升级时，立即重新评估 Patch Level，并按更高等级执行。
- L4 不得复制失败分支或覆盖用户工作树；必须记录正常基线 SHA/Tag，仅迁移仍被当前契约和测试证明需要的行为，并保留旧失败补丁供只读对照。

## 3. 当前源码边界

| 边界 | 当前职责与入口 |
|---|---|
| Electron 组合根 | `electron/main.ts`：单实例、生命周期、服务装配、IPC 注册和退出协调 |
| Electron 服务 | `electron/services/**`：Service 编排用例，Repository 管理路径/来源/文件，Codec 管理格式和兼容转换 |
| IPC 边界 | `electron/ipc/**` + `electron/preload.ts`：注册受限通道并向 Renderer 暴露白名单 |
| Renderer 组合根 | `src/controller/app/AppController.ts`：构造 Model、Adapter、Controller、View 并绑定生命周期 |
| Adapter | `src/adapter/**`：HTTP、WebSocket、IPC、序列化和浏览器存储等外部能力 |
| Model | `src/model/**`：领域状态、规则和数据转换，不依赖 DOM、具体 View 或 Electron |
| Controller | `src/controller/**`：业务编排、用户意图、Model/View 协调，不直接操作 DOM 或底层 IPC |
| View | `src/view/**`：DOM、组件和局部 UI 状态，不直接调用 Model、ApiClient 或 Electron Bridge |
| Types / Shared | `src/types/**` 定义 DTO/契约；`src/shared/**` 放置跨运行时纯逻辑，不依赖 DOM、Electron 或 Node 专属能力 |

依赖和实现规则：

- 外部通信必须经 Adapter；Renderer 不得绕过 Adapter 直接调用 `window.electronBridge`。
- Controller 可以协调 Model、Adapter 和 View，但不得复制领域状态、解析文件格式或实现路径安全。
- View 只能消费 ViewObject、Types、Shared 和 View 内组件。当前特例仅是 `src/view/theme.ts` 通过 `StorageAdapter` 保存纯 UI 偏好，不得扩展为通用持久化入口。
- ViewObject、领域模型、API DTO 和 IPC DTO 必须区分；不得用 `any`、双重类型断言或可选字段堆积掩盖契约。
- `electron/main.ts` 新增代码应限于装配和生命周期；可独立测试的行为放入 `electron/services/**`，传输适配放入 `electron/ipc/**`。
- GUI 只能依赖后端公开接口；前后端一起变化时必须检查 `src/model/ApiClient.ts`、Adapter、DTO 和跨仓契约测试。
- View 创建的事件监听器、Observer、Timer、`requestAnimationFrame`、订阅和缓存必须有唯一所有者、幂等初始化和幂等 `dispose()`，并接入 `AppController.dispose()` 清理链。
- 拆分复杂 View 时保持原 Facade 公共 API；共享视觉组件至少需要两个真实消费者，并完整负责自身绑定、更新和释放。
- 新建抽象必须有当前真实调用方，并能减少实质重复或隔离明确边界；不得为未来可能需求预留空接口、Manager、Factory、Registry 或 EventBus。

## 4. 高风险不变量

- 安装资源只读；用户配置、计划、迁移状态和运行数据写入 Electron `userData`。
- 文件入口必须经 canonicalize 和 containment 检查；Renderer 不得通过通用 IPC 读写任意绝对路径。
- 用户数据使用原子写入，替换失败必须保留旧文件；迁移只能在全部文件成功写入后记录阶段完成。
- 已发布格式、目录、模板 ID、任务索引、配置默认值和未知字段属于兼容契约；不得静默丢弃或覆盖。
- 单实例锁必须早于迁移、后端启动和窗口初始化；退出、更新和强制关闭必须停止后端、ADB 和相关进程树。
- Scheduler 是定时、轮换和任务执行的唯一调度所有者；不得增加并行定时器或第二套任务状态机。
- 强化、解装、购买等不可逆或消耗资源的操作默认关闭，必须由用户明确确认；目标、状态或确认不确定时 fail closed。
- 自动强化中的舰船身份只能由 WSG-NCC 识别结果决定。允许调用 WSG-NCC 的普通模式和遮罩识别模式，但不得使用 OCR 舰名、立绘匹配、文本规则或其他识别器补全、替换或二次裁决舰船身份；WSG-NCC 无有效结果时必须保持未知或 fail closed。
- 自动强化中的 OCR 仅允许读取火力、鱼雷、装甲、防空等强化等级数值，不得参与舰船身份、舰种、稀有度或候选资格判断；滚动与重叠验证阶段不得调用强化等级 OCR，仅在逻辑视口确定后读取必要数值。
- 不得泄露或提交密钥、Token、用户配置、含隐私日志、运行时数据或本地环境文件。

### 4.1 主库 1.4.4 并行协作边界

- 当前 GUI 的实际结构和现有业务行为优先；配合主库开发者时复用当前 Model、Adapter、Controller、View、Service、Repository 和 Codec 边界，不建立与当前架构竞争的第二套实现。
- 当前路线负责让 GUI 2.0 已有功能安全、兼容、可合并。自动强化的后端 API、device lease、正式 Scheduler 任务、业务规则和最终接线由主库开发者负责；未经用户重新分配，不得越界实现或修改其业务语义。
- 修改双方共享的 Scheduler task type、API 请求、设置 Schema、`ApiClient`、`ConfigModel`、`ConfigController`、`SchedulerBinder`、Fleet/Plan Types 前，必须说明所有权、双方调用方、合并影响和验证方式并取得用户确认。
- 必须保持舰队方案与出征计划分离、运行前由 `RuntimePlanService` 展开、系统/用户数据边界清晰、candidate-only 平等候选、未知 YAML 字段保留，以及单一 Scheduler 所有权。
- 仅允许为已经确认的主库协作功能保留最小扩展余量。例如自动强化可在现有 task type、API 和设置 Schema 上保留兼容入口，但不得提前建立空框架、独立定时器、第二状态机或未接线实现。
- 协作兼容清单中的 `resource/builtin_plans/活动20260730-*.yaml` 是旧安装输入路径，不是当前仓库应恢复的目录；通过现有迁移映射、兼容资源和专项测试验证，不得重新复制一套来源。
- 第 13 节协作契约在用户明确宣布合并完成或职责调整前持续有效；主库开发者提交的改动也必须通过当前 GUI 的四大原则、架构门禁和非回归验证。

## 5. 源文件与生成文件

- HTML 源位于 `src/view/html/**`，由 `scripts/build-view-html.js` 生成并校验已提交的 `src/view/index.html`。
- SCSS 源位于 `src/view/styles/**/*.scss`，构建生成并提交 `src/view/styles/styles.css`。
- TypeScript 由 `tsc` 编译到 `dist/**`，Renderer 由 `scripts/bundle.js` 生成 `dist/renderer.bundle.js`；`dist/**` 和 `release/**` 不提交。
- 不得手工修改 `src/view/index.html`、`src/view/styles/styles.css` 或 `dist/**`。修改 HTML/SCSS/TypeScript 源后运行 `npm run build`，提交需要跟踪的生成入口。
- lockfile 只能随明确依赖变更更新；大型资源、fixture、图片和机械生成内容必须与手写行为代码分开说明。

## 6. 风格与实现门禁

- 使用 UTF-8、LF 和文件末尾换行；TS/SCSS/JSON/Markdown/YAML 2 空格，Python 4 空格。
- TypeScript 保持 strict；新代码不得引入隐式 `any` 或用断言绕过边界。类文件 PascalCase，工具/类型文件 camelCase，样式遵循现有 SCSS/BEM 结构。
- 能修改现有实现时不得新增重复模块、包装层、状态源或兼容分支；每个新增文件、函数、类型、依赖和缓存都必须说明必要性。
- 除 4.1 节已确认的跨分支协作契约外，不得以“以后可能扩展”“先搭起来”“文件太长”作为增加抽象或拆分文件的理由。
- 注释解释设计原因、限制和兼容背景，不复述代码；临时 workaround 必须说明触发条件、移除条件和对应测试。
- 防御式代码只放在真实外部边界或已验证失败路径；不得用宽泛 `try/catch`、静默降级和多层 fallback 掩盖状态所有权或契约错误。
- 为测试新增注入点时优先使用构造参数或显式依赖，不得把调试开关、测试状态或仅测试使用的 API 暴露到生产路径。
- 发现范围扩大、新状态源、跨层补偿或依赖功能回归时立即停止，重新说明范围并取得用户确认。
- 不得关闭 SSL、路径、类型、Schema、测试、签名或权限校验来绕过问题。

## 7. 验证路由

所有行为修改都需要确定性验证；build、截图或一次手工运行不能替代专项测试。

| 改动范围 | 最低验证 |
|---|---|
| TypeScript / SCSS / HTML | `npm run test:build` |
| HTML、DOM ID、View 拆分 | `npm run test:renderer-contract` |
| Controller、View、共享边界 | `npm run test:architecture-boundaries` |
| Electron Service / IPC | `npm run test:main-services`、`npm run test:main-ipc` |
| Scheduler / Fleet / 地图 | `npm run test:scheduler-domain`、`npm run test:fleet-domain`、`npm run check:fleet-types`、`npm run check:maps` |
| 配置 / 迁移 / 活动资源 | `npm run test:settings`、`npm run test:migrations`、`npm run test:event-resources` |
| Python / 后端分发 / API | 选择 `npm run test:python-environment`、`npm run test:backend-distribution`、`npm run test:api-contract` |
| 打包 / 安装 / 发布 | `npm run dist`、`npm run test:release-package`，并实际启动安装后的 GUI |

- 测试命令以当前 `package.json` 为准；已有专项测试按风险选择，不得只运行最容易通过的测试。
- 涉及 Electron、端口、`userData`、临时目录、进程或共享缓存的测试默认串行执行。
- 修改 GUI 交互时必须回归目标功能、共享组件消费者、重复初始化和状态保持；涉及游戏执行链路还须通过模拟器验证。无法验证时明确列出未验证路径。
- 交付前执行 `git diff --check`，确认 diff 只含本批任务文件，并记录命令、结果、失败尝试和剩余风险。

## 8. Git 与发布

### 8.1 工作区和提交

- 不得覆盖、回退、删除、暂存或格式化用户已有修改；发现无关修改时忽略，只有确实妨碍任务时才请求处理方式。
- 未经明确要求，不得执行 `git reset --hard`、`git checkout -- <path>`、强制清理、历史重写、`--no-verify` 或无条件 `git push --force`。
- 不得 `git add .`；按逻辑变更显式暂存。分支使用语义前缀，Commit 使用 Conventional Commits，一个 commit 对应一个可独立审查的逻辑变更。

### 8.2 ShiinaKuroko Fork

- 路径以仓库为基准：GUI 为当前仓库根目录，后端默认是同级 `../AutoWSGR`；不得固化某台机器的绝对路径。
- 当前仓库是个人 Fork。`main` 只用于同步 `yltx/AutoWSGR-GUI:alpha`，不直接开发功能；同步上游 `alpha` 后再更新个人 Fork 的 `origin/main`。
- `ShiinaKuroko` 是主力开发分支，代表个人 Fork 的最新有效代码。功能实现、正式自动化测试和必要生成入口必须先合入该分支并完成验证，再由该分支执行普通 push。
- 未经维护者事先明确允许，不得创建任何本地或远程分支、备份分支、worktree 或发布克隆；不得以隔离脏工作树、备份、测试、打包或发布为理由自行创建。
- 只有维护者明确要求并批准 PR 时，才允许创建对应 PR 分支；格式为 `feat/<功能>-PR` 或 `fix/<功能>-PR`，Git 分支名不得使用反斜杠。创建下一条 PR 前必须检查上一条临时 PR 的状态，确认代码已经合入目标分支后，删除对应的本地和远端 PR 分支；未合入或状态不明确时不得删除。
- 仅在当前会话尚无可用网络配置事实，或网络操作实际失败且代理状态会决定下一步时读取系统代理设置；不得为每次正常 push 重复读取。只允许命令级临时代理，不得硬编码端口或修改全局 Git 配置。
- 每次 push `ShiinaKuroko` 前必须先 `git fetch origin`。本地落后或出现分叉时，先审查并整合远端提交，不得用强推覆盖远端代码。
- 只有维护者明确要求并批准时，才以当前 `origin/ShiinaKuroko` 为指针创建远端不可移动备份 `backup/YYYYMMDD-<short-sha>`；不得擅自创建、移动、复用或删除 backup 分支。
- 普通 push 禁止 `--force` 和 `--force-with-lease`。只有用户明确授权历史改写、已说明将被替换的远端提交且备份完成时，才允许使用 `--force-with-lease`。
- push 完成后检查其他本地工作分支：只有确认有效提交已进入 `ShiinaKuroko`、没有独有未推送提交、没有未提交修改且未被 worktree 使用时才能删除。不得批量强删；保留 `main`、`ShiinaKuroko` 和仍未合入的活动 PR 分支。

### 8.3 Alpha 与正式发布

- `alpha` 是预发布版本/更新频道，不是质量豁免分支；四大原则、测试门禁、数据安全和兼容要求全部生效。
- 只有用户明确要求时，才能改版本、创建 Tag、触发发布或上传产物。
- Release commit 只含版本和发布元数据；Tag、`package.json`、`package-lock.json` 和产物版本必须一致，不得覆盖已有远程 Tag。
- 发布前必须完成构建、专项测试、安装包验证和实际启动；无法完成时不得宣称发布可用。

## 9. Windows 打包

- 正式 Windows 产物使用 `npm run dist` 生成 NSIS 安装程序；`npm run pack` 的 unpacked 目录不是“单 EXE”交付物。
- 不得通过关闭 `signAndEditExecutable`、签名、权限或产物校验来绕过打包问题。
- `winCodeSign` 解压或符号链接失败时先区分权限、缓存和工具链问题；不得重复相同命令或用运行时 fallback 掩盖。
- 单 EXE 交付只取 `AutoWSGR-GUI-Setup-<version>.exe`，检查版本、哈希并实际安装启动；`release/**` 和 Electron Builder 缓存不得提交。

## 10. 专用入口与维护

- `.github/agents/code-length-audit.agent.md` 只用于代码长度审计；`.github/skills/commit-and-release/SKILL.md` 只用于提交发布；`.claude/skills/generic-issue-log-analysis/SKILL.md` 只用于 Issue/日志分析。
- `.github/workflows/**` 定义实际自动化；修改前必须说明权限、Secret、触发条件和发布影响。
- 本文件维护长期工程门禁和主库 1.4.4 协作契约，`docs/architecture/**` 维护当前 GUI 结构与 ADR；发现两者与实现不一致时按第 2 节处理。
- 工具入口只指向本文件，不复制整套规则。阶段性迁移清单、历史事故和已结束的单次分工放入对应任务文档，不写入长期 Agent 约束。
- 修改本文件前必须先审查当前代码和门禁；新增、删除或降低规则前，先向用户列明具体动作、原因和影响并取得确认。

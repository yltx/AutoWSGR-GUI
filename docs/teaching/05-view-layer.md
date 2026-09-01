# 05：View 层组织

> 前置阅读：[03 ViewObject 单向数据流](03-viewobject-flow.md)

View 层的边界不是“所有前端代码”，而是 DOM、浏览器事件、局部视觉状态和资源
生命周期。它不负责文件、调度、持久化或领域规则。

## 三类开发源

```text
src/view/
├─ html/**          # HTML partial
├─ styles/**        # SCSS partial 和生成 CSS
└─ **/*.ts          # View、Facade、共享视觉组件
```

构建后 Electron 加载：

```text
src/view/index.html
src/view/styles/styles.css
dist/renderer.bundle.js
```

HTML partial 和 SCSS partial 是开发结构，不会在运行时 fetch 或动态 include。

## View 负责什么

- 查找和更新 DOM。
- 绑定 DOM、window、document 事件。
- 管理搜索、筛选、排序、展开和 loading。
- 管理滚动、动画和 Observer。
- 收集表单草稿。
- 通过 callback 或 intent 上报用户动作。
- 释放自己创建的事件、Observer 和定时资源。

View 不负责：

- Scheduler 和任务重试。
- 配置或方案持久化。
- 文件 identity 和系统/用户来源。
- HTTP、IPC 或 Electron Bridge。
- 可写领域 Model。

该边界由 `scripts/tests/test-renderer-architecture.js` 静态检查。

## Facade：保持外部 API 稳定

Facade 对 Controller 提供稳定入口，内部组合职责子 View。

### MainView

`src/view/main/MainView.ts` 内部组合：

- `StatusBar`
- `TaskQueueView`
- `FleetPreviewView`
- `LogView`

Controller 只调用：

```typescript
this.mainView.render(vo);
this.mainView.appendLog(entry);
```

新增一个主页面局部视觉模块时，优先由 `MainView` 组合，而不是让
`AppController` 直接管理更多 DOM 组件。

### ConfigView

`src/view/config/ConfigView.ts` 保持设置页公共 API，内部组合：

- `ConfigAutomationView`
- `ConfigRuntimeView`
- `settingSelectWidth.ts`

拆分后 Controller 仍面对一个 `ConfigView`，配置状态也没有转移到子 View。

### FleetPlannerView

`src/view/plan/FleetPlannerView.ts` 组合：

- `FleetEditorView`
- `FleetGalleryView`
- `TeamPlanLoaderView`

它通过 `FleetPlannerViewHost` 发送编辑和保存意图，业务草稿仍由 Controller 和
Fleet 领域维护。

## 职责子 View 和共享组件不同

职责子 View 只服务一个 Facade，例如 `ConfigRuntimeView`。

共享组件必须有多个真实消费者，例如：

`src/view/plan/ShipGalleryView.ts`

它同时服务普通舰队和决战页面，复用：

- 搜索和筛选。
- 排序。
- 增量渲染。
- 舰船卡片。
- 滚动恢复。
- 拖拽起点。

页面差异由 `ShipGalleryViewHost` 提供。共享组件不能持有：

- 普通舰队主选/候选语义。
- 决战 level1/level2 草稿。
- 保存状态和文件 identity。

共享的是视觉行为，不是业务状态。

## 生命周期必须完整

`ShipGalleryView` 创建一组事件监听器和一个 `ResizeObserver`：

```typescript
private readonly eventController = new AbortController();
private readonly resizeObserver: ResizeObserver;

dispose(): void {
  if (this.disposed) return;
  this.disposed = true;
  this.eventController.abort();
  this.resizeObserver.disconnect();
}
```

释放链是：

```text
AppController.onBeforeUnload
  -> FleetPlannerController.dispose()
  -> FleetPlannerView.dispose()
  -> ShipGalleryView.dispose()

AppController.onBeforeUnload
  -> DecisivePlanController.dispose()
  -> DecisivePlanView.dispose()
  -> ShipGalleryView.dispose()
```

创建 `window/document` 监听器、Observer、interval 或 animation frame 时，必须
同时确定所有者和释放入口。

## 局部状态和业务状态

可以留在 View：

- 图库搜索词。
- 当前筛选和排序。
- 弹窗展开。
- 拖拽中的滚动位置。
- 尚未保存的输入框文本。

必须交回 Controller/Model：

- 舰队槽位内容。
- 计划选中节点。
- 已保存配置。
- Scheduler 队列。
- 任务组条目。

局部状态不应在 `render()` 时被无条件重置，否则其他字段变化会导致滑块、选择
或滚动位置回退。

## HTML partial 是 DOM 契约

HTML 源位于：

`src/view/html/**`

由 `scripts/build-view-html.js` 递归展开 include。构建脚本拒绝：

- include 逃出源目录。
- 循环 include。
- 生成结果与已提交 `src/view/index.html` 不一致。

View 使用的 DOM ID 是契约。移动 HTML 时要检查：

```powershell
rg -n "getElementById|querySelector|data-" src/view
```

`test-renderer-dom-contract.js` 检查重复 ID、View 引用缺失和例外白名单。

## SCSS 按所有权组织

```text
src/view/styles/
├─ base/
├─ components/
├─ pages/
├─ themes/
└─ main.scss
```

规则：

- 页面特有布局留在 `pages/`。
- 两个以上页面共享的独立视觉组件进入 `components/`。
- 拆分 partial 时保持选择器、属性和加载顺序。
- 不在机械拆分中同时修改视觉效果。
- 只编辑 SCSS 源，不手工改 `styles.css`。

## View 可以导入什么

允许：

- `src/types/view.ts`
- `src/types/fleetEditor.ts` 等明确 intent 类型
- `src/shared/**` 中纯逻辑和只读契约
- `src/view/shared/**` 中共享 UI
- 同功能域子 View

禁止：

- 有状态 `src/model/**`
- `ApiClient`
- `src/adapter/**`
- `window.electronBridge`
- 直接 `localStorage`

当前唯一受控例外是 `src/view/theme.ts` 通过 `StorageAdapter` 保存纯 UI 偏好。

## 提取 View 的步骤

1. 确定一个完整视觉责任和 DOM 所有权。
2. 搜索该区域全部 ID、class、事件和 CSS。
3. 保持 Controller 对外 API 不变。
4. 不移动业务状态。
5. 定义最小 callback/Host。
6. 明确创建和释放生命周期。
7. 拆 HTML/SCSS 时保持生成结果和顺序。
8. 回归所有共享组件消费者。

## 验证

```powershell
npm run build:html
npm run test:renderer-contract
npm run test:architecture-boundaries
npm run test:build
git diff --check
```

涉及交互时还要在 Electron 中回归点击、输入、拖放、滚动、弹窗和窗口关闭。

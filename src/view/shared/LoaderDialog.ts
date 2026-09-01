/**
 * 加载浮窗共用的生命周期管理。
 *
 * 算法流程：
 * 1. View 把现有 modal-overlay 元素交给 LoaderDialog。
 * 2. open() 统一用 flex 展示弹窗。
 * 3. close() 统一隐藏弹窗。
 * 4. bindDismiss() 只绑定一次通用关闭事件。
 * 5. 点击遮罩空白处时触发业务层提供的关闭回调。
 * 6. 按下 Escape 时只关闭当前最上层弹窗。
 * 7. 内层确认框存在时，不会误关底层加载浮窗。
 * 8. 业务按钮仍由各自 View 绑定，不进入共用层。
 * 9. 各 View 继续使用原有 DOM 结构和样式 class。
 * 10. 各 View 继续自行渲染列表、预览和空状态。
 * 11. 共用层不改变现有视觉样式和页面布局。
 * 12. 该模块不保存选择状态，也不决定确认按钮是否可用。
 * 13. 该模块不生成完整弹窗 DOM，继续复用现有静态结构。
 * 14. 因此迁移不会改变已有元素 id 和控制器通信协议。
 * 15. 后续加载浮窗只需复用本模块，不再重复实现基础行为。
 */

/** 统一现有静态加载浮窗的打开、关闭和通用退出行为。 */
export class LoaderDialog {
  private dismissBound = false;

  constructor(private readonly overlay: HTMLElement) {}

  open(): void {
    this.overlay.style.display = 'flex';
  }

  close(): void {
    this.overlay.style.display = 'none';
  }

  isOpen(): boolean {
    return window.getComputedStyle(this.overlay).display !== 'none';
  }

  /** 关闭回调属于业务层，共用层只判断何时应当触发。 */
  bindDismiss(onDismiss: () => void): void {
    if (this.dismissBound) return;
    this.dismissBound = true;
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) onDismiss();
    });
    document.addEventListener('keydown', (event) => {
      if (
        event.key !== 'Escape'
        || !this.isOpen()
        || !this.isTopmostModal()
      ) {
        return;
      }
      event.preventDefault();
      onDismiss();
    });
  }

  private isTopmostModal(): boolean {
    const visibleModals = Array.from(
      document.querySelectorAll<HTMLElement>('.modal-overlay'),
    ).filter(element => (
      window.getComputedStyle(element).display !== 'none'
    ));
    const topmostModal = visibleModals.reduce<HTMLElement | null>(
      (topmost, element) => {
        if (!topmost) return element;
        const topmostZIndex = this.readZIndex(topmost);
        const elementZIndex = this.readZIndex(element);
        return elementZIndex >= topmostZIndex ? element : topmost;
      },
      null,
    );
    return topmostModal === this.overlay;
  }

  private readZIndex(element: HTMLElement): number {
    const zIndex = Number.parseInt(
      window.getComputedStyle(element).zIndex,
      10,
    );
    return Number.isNaN(zIndex) ? 0 : zIndex;
  }
}

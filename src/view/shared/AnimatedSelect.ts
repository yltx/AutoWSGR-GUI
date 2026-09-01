/**
 * 为原生 select 提供统一的动画选项面板。
 *
 * 原生 select 仍保留在原位置，并继续作为业务数据的唯一来源。
 * 用户选择选项后，本组件只更新 selectedIndex，再派发 input/change，
 * 因此现有表单读取、设置保存和动态生成下拉框都不需要适配。
 */
class AnimatedSelectController {
  private readonly panel: HTMLElement;
  private readonly observer: MutationObserver;
  private activeSelect: HTMLSelectElement | null = null;
  private optionElements: HTMLOptionElement[] = [];
  private activeIndex = -1;
  private closeTimer: number | null = null;
  private openAnimationFrame: number | null = null;
  private disposed = false;

  constructor() {
    this.panel = document.createElement('div');
    this.panel.id = 'animated-select-listbox';
    this.panel.className = 'animated-select-popover';
    this.panel.setAttribute('role', 'listbox');
    this.panel.hidden = true;
    document.body.appendChild(this.panel);

    this.enhanceNode(document);
    this.observer = new MutationObserver((records) => {
      records.forEach((record) => {
        record.addedNodes.forEach((node) => this.enhanceNode(node));
      });
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    document.addEventListener('mousedown', this.handleMouseDown, true);
    document.addEventListener('click', this.handleClick, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('scroll', this.handleScroll, true);
    this.panel.addEventListener('mousemove', this.handlePanelMouseMove);
    this.panel.addEventListener('click', this.handlePanelClick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.observer.disconnect();
    document.removeEventListener('mousedown', this.handleMouseDown, true);
    document.removeEventListener('click', this.handleClick, true);
    document.removeEventListener('keydown', this.handleKeyDown, true);
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('scroll', this.handleScroll, true);
    this.panel.removeEventListener('mousemove', this.handlePanelMouseMove);
    this.panel.removeEventListener('click', this.handlePanelClick);

    this.cancelClose();
    this.cancelOpenAnimationFrame();
    this.activeSelect?.classList.remove('is-select-open');
    this.activeSelect?.setAttribute('aria-expanded', 'false');
    this.activeSelect?.removeAttribute('aria-activedescendant');
    this.activeSelect = null;
    this.optionElements = [];
    this.activeIndex = -1;
    this.panel.remove();
  }

  private enhanceNode(node: Node): void {
    if (node instanceof HTMLSelectElement) {
      this.enhanceSelect(node);
    }

    if (node instanceof Document || node instanceof HTMLElement) {
      node.querySelectorAll<HTMLSelectElement>('select').forEach(
        (select) => this.enhanceSelect(select),
      );
    }
  }

  private enhanceSelect(select: HTMLSelectElement): void {
    if (select.multiple || select.size > 1) return;

    select.classList.add('animated-select-source');
    select.setAttribute('aria-haspopup', 'listbox');
    select.setAttribute('aria-expanded', 'false');
    select.setAttribute('aria-controls', this.panel.id);
  }

  private isSupportedSelect(
    target: EventTarget | null,
  ): target is HTMLSelectElement {
    return target instanceof HTMLSelectElement
      && target.classList.contains('animated-select-source')
      && !target.multiple
      && target.size <= 1;
  }

  private handleMouseDown = (event: MouseEvent): void => {
    const target = event.target;

    if (this.panel.contains(target as Node)) {
      if (
        target instanceof HTMLElement
        && target.closest('.animated-select-option')
      ) {
        event.preventDefault();
      }
      return;
    }

    if (this.isSupportedSelect(target)) {
      if (target.matches(':disabled')) return;

      event.preventDefault();
      target.focus({ preventScroll: true });
      if (this.activeSelect === target && !this.panel.hidden) {
        this.close();
      } else {
        this.open(target);
      }
      return;
    }

    this.close();
  };

  private handleClick = (event: MouseEvent): void => {
    if (this.isSupportedSelect(event.target)) {
      event.preventDefault();
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.isSupportedSelect(event.target)) return;

    const select = event.target;
    const isOpen = this.activeSelect === select && !this.panel.hidden;

    if (!isOpen) {
      if (
        event.key === 'Enter'
        || event.key === ' '
        || event.key === 'ArrowDown'
        || event.key === 'ArrowUp'
      ) {
        event.preventDefault();
        this.open(select);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.moveToBoundary(1);
    } else if (event.key === 'End') {
      event.preventDefault();
      this.moveToBoundary(-1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.commitActive();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (event.key === 'Tab') {
      this.close();
    }
  };

  private handlePanelMouseMove = (event: MouseEvent): void => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      '.animated-select-option',
    );
    if (!item || item.classList.contains('is-disabled')) return;

    const index = Number(item.dataset['optionIndex']);
    if (Number.isInteger(index)) this.setActiveIndex(index);
  };

  private handlePanelClick = (event: MouseEvent): void => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      '.animated-select-option',
    );
    if (!item || item.classList.contains('is-disabled')) return;

    const index = Number(item.dataset['optionIndex']);
    if (!Number.isInteger(index)) return;

    this.setActiveIndex(index);
    this.commitActive();
  };

  private handleResize = (): void => {
    if (this.activeSelect) this.positionPanel(this.activeSelect);
  };

  private handleScroll = (event: Event): void => {
    if (this.panel.contains(event.target as Node)) return;
    this.close();
  };

  private open(select: HTMLSelectElement): void {
    this.cancelClose();
    this.cancelOpenAnimationFrame();
    this.activeSelect?.classList.remove('is-select-open');
    this.activeSelect?.setAttribute('aria-expanded', 'false');

    this.activeSelect = select;
    select.classList.add('is-select-open');
    select.setAttribute('aria-expanded', 'true');
    this.renderOptions(select);
    this.positionPanel(select);

    this.panel.hidden = false;
    this.panel.classList.remove('is-open');
    this.openAnimationFrame = requestAnimationFrame(() => {
      this.openAnimationFrame = null;
      if (this.disposed) return;
      if (this.activeSelect !== select) return;
      this.panel.classList.add('is-open');
      this.scrollActiveIntoView();
    });
  }

  private close(): void {
    if (!this.activeSelect && this.panel.hidden) return;

    this.cancelOpenAnimationFrame();
    this.activeSelect?.classList.remove('is-select-open');
    this.activeSelect?.setAttribute('aria-expanded', 'false');
    this.activeSelect?.removeAttribute('aria-activedescendant');
    this.activeSelect = null;
    this.panel.classList.remove('is-open');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.finishClose();
      return;
    }

    this.cancelClose();
    this.closeTimer = window.setTimeout(() => this.finishClose(), 140);
  }

  private finishClose(): void {
    this.cancelClose();
    if (this.activeSelect) return;

    this.panel.hidden = true;
    this.panel.replaceChildren();
    this.optionElements = [];
    this.activeIndex = -1;
  }

  private cancelClose(): void {
    if (this.closeTimer === null) return;
    window.clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  private cancelOpenAnimationFrame(): void {
    if (this.openAnimationFrame === null) return;
    cancelAnimationFrame(this.openAnimationFrame);
    this.openAnimationFrame = null;
  }

  private renderOptions(select: HTMLSelectElement): void {
    this.panel.replaceChildren();
    this.optionElements = Array.from(select.options);

    Array.from(select.children).forEach((child) => {
      if (child instanceof HTMLOptionElement) {
        this.panel.appendChild(this.createOptionItem(child));
        return;
      }

      if (child instanceof HTMLOptGroupElement) {
        const label = document.createElement('div');
        label.className = 'animated-select-group';
        label.textContent = child.label;
        this.panel.appendChild(label);
        Array.from(child.children).forEach((option) => {
          if (option instanceof HTMLOptionElement) {
            this.panel.appendChild(this.createOptionItem(option));
          }
        });
      }
    });

    const selectedIndex = select.selectedIndex;
    this.activeIndex = this.isSelectable(selectedIndex)
      ? selectedIndex
      : this.findNextSelectable(-1, 1);
    this.updateActiveOption();
  }

  private createOptionItem(option: HTMLOptionElement): HTMLElement {
    const optionIndex = this.optionElements.indexOf(option);
    const item = document.createElement('div');
    item.id = `animated-select-option-${optionIndex}`;
    item.className = 'animated-select-option';
    item.dataset['optionIndex'] = String(optionIndex);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.textContent = option.label || option.textContent || '';

    if (this.isOptionDisabled(option)) {
      item.classList.add('is-disabled');
      item.setAttribute('aria-disabled', 'true');
    }
    if (option.selected) item.classList.add('is-selected');

    return item;
  }

  private isOptionDisabled(option: HTMLOptionElement): boolean {
    return option.disabled
      || (
        option.parentElement instanceof HTMLOptGroupElement
        && option.parentElement.disabled
      );
  }

  private isSelectable(index: number): boolean {
    const option = this.optionElements[index];
    return Boolean(option && !this.isOptionDisabled(option));
  }

  private findNextSelectable(start: number, direction: 1 | -1): number {
    const count = this.optionElements.length;
    if (count === 0) return -1;

    for (let step = 1; step <= count; step += 1) {
      const index = (start + direction * step + count) % count;
      if (this.isSelectable(index)) return index;
    }
    return -1;
  }

  private moveActive(direction: 1 | -1): void {
    const next = this.findNextSelectable(this.activeIndex, direction);
    if (next >= 0) this.setActiveIndex(next);
  }

  private moveToBoundary(direction: 1 | -1): void {
    const start = direction === 1 ? -1 : this.optionElements.length;
    const next = this.findNextSelectable(start, direction);
    if (next >= 0) this.setActiveIndex(next);
  }

  private setActiveIndex(index: number): void {
    if (!this.isSelectable(index)) return;
    this.activeIndex = index;
    this.updateActiveOption();
    this.scrollActiveIntoView();
  }

  private updateActiveOption(): void {
    this.panel.querySelectorAll<HTMLElement>(
      '.animated-select-option',
    ).forEach((item) => {
      item.classList.toggle(
        'is-active',
        Number(item.dataset['optionIndex']) === this.activeIndex,
      );
    });

    if (this.activeSelect && this.activeIndex >= 0) {
      this.activeSelect.setAttribute(
        'aria-activedescendant',
        `animated-select-option-${this.activeIndex}`,
      );
    }
  }

  private scrollActiveIntoView(): void {
    this.panel.querySelector<HTMLElement>(
      '.animated-select-option.is-active',
    )?.scrollIntoView({ block: 'nearest' });
  }

  private commitActive(): void {
    const select = this.activeSelect;
    if (!select || !this.isSelectable(this.activeIndex)) return;

    const changed = select.selectedIndex !== this.activeIndex;
    select.selectedIndex = this.activeIndex;
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.close();
  }

  private positionPanel(select: HTMLSelectElement): void {
    const rect = select.getBoundingClientRect();
    const viewportMargin = 8;
    const gap = 4;
    const matchSourceWidth = (
      select.dataset['animatedSelectWidth'] === 'source'
    );
    const panelWidth = Math.min(
      matchSourceWidth ? rect.width : Math.max(rect.width, 160),
      window.innerWidth - viewportMargin * 2,
    );
    const availableBelow = window.innerHeight - rect.bottom - gap
      - viewportMargin;
    const availableAbove = rect.top - gap - viewportMargin;
    const openAbove = availableBelow < 160 && availableAbove > availableBelow;
    const availableHeight = openAbove ? availableAbove : availableBelow;
    const left = Math.min(
      Math.max(rect.left, viewportMargin),
      window.innerWidth - viewportMargin - panelWidth,
    );

    this.panel.classList.toggle('is-above', openAbove);
    this.panel.style.left = `${left}px`;
    this.panel.style.width = `${panelWidth}px`;
    this.panel.style.maxHeight = `${Math.max(
      48,
      Math.min(280, availableHeight),
    )}px`;

    if (openAbove) {
      this.panel.style.top = 'auto';
      this.panel.style.bottom = `${window.innerHeight - rect.top + gap}px`;
    } else {
      this.panel.style.top = `${rect.bottom + gap}px`;
      this.panel.style.bottom = 'auto';
    }
  }
}

let controller: AnimatedSelectController | null = null;

export function initAnimatedSelects(): void {
  controller ??= new AnimatedSelectController();
}

export function disposeAnimatedSelects(): void {
  controller?.dispose();
  controller = null;
}

/** 为舰名输入框提供搜索建议、键盘选择和补全。 */
/**
 * 舰船名称自动补全组件（共享）。
 * 使用事件委托，对指定容器内匹配选择器的 input 提供下拉补全。
 */
import { ALL_SHIPS } from '../../shared/shipCatalog';
import { shipTypeLabel } from '../../shared/fleetShipTypes';

function escapeHtml(str: string): string {
  const d = document.createElement('span');
  d.textContent = str;
  return d.innerHTML;
}

export class ShipAutocomplete {
  private dropdown: HTMLElement | null = null;
  private maxResults: number;
  private disposed = false;

  constructor(
    private container: HTMLElement | Document,
    private inputSelector: string,
    options?: { maxResults?: number },
  ) {
    this.maxResults = options?.maxResults ?? 20;
    (this.container as HTMLElement).addEventListener('input', this.onInput);
    (this.container as HTMLElement).addEventListener('focusin', this.onFocusIn);
    (this.container as HTMLElement).addEventListener('focusout', this.onFocusOut);
    (this.container as HTMLElement).addEventListener('keydown', this.onKeyDown);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    (this.container as HTMLElement).removeEventListener('input', this.onInput);
    (this.container as HTMLElement).removeEventListener('focusin', this.onFocusIn);
    (this.container as HTMLElement).removeEventListener('focusout', this.onFocusOut);
    (this.container as HTMLElement).removeEventListener('keydown', this.onKeyDown);
    this.hide();
  }

  // ── 事件委托 ────────────────────────────────

  private match(e: Event): HTMLInputElement | null {
    const el = e.target as HTMLElement;
    return el.matches?.(this.inputSelector) ? (el as HTMLInputElement) : null;
  }

  private onInput = (e: Event) => {
    const inp = this.match(e);
    if (inp) this.show(inp);
  };

  private onFocusIn = (e: Event) => {
    const inp = this.match(e);
    if (inp && inp.value.trim()) this.show(inp);
  };

  private onFocusOut = (e: Event) => {
    if (this.match(e)) setTimeout(() => this.hide(), 150);
  };

  private onKeyDown = (e: Event) => {
    const ke = e as KeyboardEvent;
    const inp = this.match(ke);
    if (!inp || !this.dropdown) return;

    const items = this.dropdown.querySelectorAll<HTMLElement>('.ship-ac-item');
    if (!items.length) return;

    const active = this.dropdown.querySelector<HTMLElement>('.ship-ac-item.active');
    let idx = active ? Array.from(items).indexOf(active) : -1;

    if (ke.key === 'ArrowDown') {
      ke.preventDefault();
      active?.classList.remove('active');
      idx = (idx + 1) % items.length;
      items[idx].classList.add('active');
      items[idx].scrollIntoView({ block: 'nearest' });
    } else if (ke.key === 'ArrowUp') {
      ke.preventDefault();
      active?.classList.remove('active');
      idx = idx <= 0 ? items.length - 1 : idx - 1;
      items[idx].classList.add('active');
      items[idx].scrollIntoView({ block: 'nearest' });
    } else if (ke.key === 'Enter') {
      ke.preventDefault();
      if (active) {
        inp.value = active.dataset.shipName!;
        this.hide();
      }
    } else if (ke.key === 'Escape') {
      this.hide();
    }
  };

  // ── 下拉渲染 ────────────────────────────────

  private show(inp: HTMLInputElement): void {
    const query = inp.value.trim().toLowerCase();
    if (!query) { this.hide(); return; }

    const matches = ALL_SHIPS
      .filter(s => s.name.toLowerCase().includes(query))
      .slice(0, this.maxResults);

    if (!matches.length) { this.hide(); return; }
    if (matches.length === 1 && matches[0].name === inp.value.trim()) {
      this.hide();
      return;
    }

    this.hide();
    const dd = document.createElement('div');
    dd.className = 'ship-autocomplete';

    for (const ship of matches) {
      const item = document.createElement('div');
      item.className = 'ship-ac-item';
      item.dataset.shipName = ship.name;
      item.innerHTML =
        `<span class="ship-ac-name">${this.highlight(ship.name, query)}</span>` +
        `<span class="ship-ac-meta">${escapeHtml(ship.nation)} · ${escapeHtml(shipTypeLabel(ship.ship_type))}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        inp.value = ship.name;
        this.hide();
      });
      dd.appendChild(item);
    }

    inp.parentElement!.appendChild(dd);
    this.dropdown = dd;
  }

  private hide(): void {
    this.dropdown?.remove();
    this.dropdown = null;
  }

  private highlight(name: string, query: string): string {
    const idx = name.toLowerCase().indexOf(query);
    if (idx < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, idx))
      + '<b>' + escapeHtml(name.slice(idx, idx + query.length)) + '</b>'
      + escapeHtml(name.slice(idx + query.length));
  }
}

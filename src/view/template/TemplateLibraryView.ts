/**
 * TemplateLibraryView —— 模板库纯渲染组件。
 * 接收 TemplateLibraryItemVO[] 并渲染模板卡片列表；不包含业务逻辑。
 */
import type { TemplateLibraryItemVO } from '../../types/view';

export class TemplateLibraryView {
  private container: HTMLElement;

  onUse?: (id: string) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string) => void;

  constructor() {
    this.container = document.getElementById('template-library-items')!;

    // 委托点击
    this.container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-tpl-action]') as HTMLElement | null;
      if (!btn) return;
      const id = btn.dataset.tplId!;
      const action = btn.dataset.tplAction;
      if (action === 'use') this.onUse?.(id);
      else if (action === 'edit') this.onEdit?.(id);
      else if (action === 'delete') this.onDelete?.(id);
      else if (action === 'rename') this.onRename?.(id);
    });
  }

  render(items: TemplateLibraryItemVO[]): void {
    if (items.length === 0) {
      this.container.innerHTML = '<p class="tpl-empty">暂无模板，点击「创建模板」添加</p>';
      return;
    }

    this.container.innerHTML = items.map(item => {
      const builtinBadge = item.isBuiltin ? '<span class="tpl-builtin-badge">内置</span>' : '';
      const planInfo = item.type === 'normal_fight' && item.planCount > 1 ? ` · ${item.planCount}个方案` : '';
      const descTitle = item.description ? ` title="${this.esc(item.description)}"` : ` title="${this.esc(item.name)}"`;
      const editBtns = item.isBuiltin ? '' : `<button class="btn btn-small" data-tpl-action="edit" data-tpl-id="${item.id}" title="编辑">✎</button>
         <button class="btn btn-small btn-danger" data-tpl-action="delete" data-tpl-id="${item.id}" title="删除">✕</button>`;
      return `<div class="tpl-item" data-tpl-id="${item.id}">
        <div class="tpl-item-info"${descTitle}>
          <div class="tpl-item-name">${builtinBadge}${this.esc(item.name)}</div>
          <div class="tpl-item-type">${this.esc(item.typeLabel)}${planInfo}${item.defaultTimes ? ` · ×${item.defaultTimes}` : ''}</div>
        </div>
        <div class="tpl-item-actions">
          <button class="btn btn-small btn-primary" data-tpl-action="use" data-tpl-id="${item.id}" title="加入任务列表">加入列表</button>
          ${editBtns}
        </div>
      </div>`;
    }).join('');
  }

  /** 填充决战模板下拉列表（配置页用） */
  populateDecisiveSelect(options: { id: string; name: string }[], selectedId?: string): void {
    const sel = document.getElementById('cfg-decisive-template') as HTMLSelectElement | null;
    if (!sel) return;
    const desiredVal = selectedId ?? sel.value;
    sel.innerHTML = '<option value="">未选择</option>' +
      options.map(o => `<option value="${o.id}">${this.esc(o.name)}</option>`).join('');
    sel.value = desiredVal;
  }

  private esc(s: string): string {
    const d = document.createElement('span');
    d.textContent = s;
    return d.innerHTML;
  }
}

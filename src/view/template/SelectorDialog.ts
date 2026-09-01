/** 渲染通用选项对话框并返回用户选择。 */
import type { SelectorOption } from '../../types/view.js';

/** 单选选择器：返回选中项的索引 + 次数，取消返回 null */
export function showSelector(title: string, options: SelectorOption[], showTimes = false, defaultTimes = 1): Promise<{ index: number; times: number } | null> {
  return new Promise(resolve => {
    const overlay = document.getElementById('plan-selector-dialog')!;
    const titleEl = document.getElementById('plan-selector-title')!;
    const list = document.getElementById('plan-selector-list')!;
    const timesRow = document.getElementById('plan-selector-times-row')!;
    const timesInput = document.getElementById('plan-selector-times') as HTMLInputElement;
    const confirmBtn = document.getElementById('btn-plan-selector-confirm')!;
    confirmBtn.style.display = 'none';
    timesRow.style.display = showTimes ? '' : 'none';
    if (showTimes) timesInput.value = String(defaultTimes);

    titleEl.textContent = title;
    list.innerHTML = options.map((opt, i) => {
      return `<div class="plan-selector-item" data-plan-idx="${i}">
        <span class="plan-icon">${opt.icon}</span>
        <span>${opt.label}</span>
      </div>`;
    }).join('');

    const cleanup = () => {
      overlay.style.display = 'none';
      list.removeEventListener('click', onSelect);
      document.getElementById('btn-plan-selector-cancel')?.removeEventListener('click', onCancel);
    };

    const onSelect = (e: Event) => {
      const item = (e.target as HTMLElement).closest('.plan-selector-item') as HTMLElement | null;
      if (!item) return;
      const idx = parseInt(item.dataset.planIdx ?? '-1');
      if (idx < 0 || idx >= options.length) return;
      const times = showTimes ? (parseInt(timesInput.value) || 1) : defaultTimes;
      cleanup();
      resolve({ index: idx, times });
    };

    const onCancel = () => { cleanup(); resolve(null); };

    list.addEventListener('click', onSelect);
    document.getElementById('btn-plan-selector-cancel')?.addEventListener('click', onCancel);
    overlay.style.display = 'flex';
  });
}

/** 多选选择器（checkbox）：返回选中项的索引数组，取消返回空数组 */
export function showMultiSelector(title: string, options: SelectorOption[]): Promise<number[]> {
  return new Promise(resolve => {
    const overlay = document.getElementById('plan-selector-dialog')!;
    const titleEl = document.getElementById('plan-selector-title')!;
    const list = document.getElementById('plan-selector-list')!;
    const timesRow = document.getElementById('plan-selector-times-row')!;
    const confirmBtn = document.getElementById('btn-plan-selector-confirm')!;
    timesRow.style.display = 'none';
    confirmBtn.style.display = '';

    titleEl.textContent = title;
    list.innerHTML = options.map((opt, i) => {
      return `<div class="plan-selector-item" data-plan-idx="${i}" style="cursor:pointer">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;width:100%">
          <input type="checkbox" data-preset-idx="${i}" style="flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600; margin-bottom:2px">${opt.icon} ${opt.label}</div>
            ${opt.sublabel ? `<div class="fleet-preset-ships" style="font-size:10px">${opt.sublabel}</div>` : ''}
          </div>
        </label>
      </div>`;
    }).join('');

    const updateBtn = () => {
      const checked = list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
      confirmBtn.textContent = checked.length > 0 ? `确认 (${checked.length})` : '确认';
      (confirmBtn as HTMLButtonElement).disabled = checked.length === 0;
    };
    updateBtn();

    const cleanup = () => {
      overlay.style.display = 'none';
      confirmBtn.style.display = 'none';
      list.removeEventListener('change', onCheckChange);
      confirmBtn.removeEventListener('click', onConfirm);
      document.getElementById('btn-plan-selector-cancel')?.removeEventListener('click', onCancel);
    };

    const onCheckChange = () => updateBtn();

    const onConfirm = () => {
      const checked = list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
      if (checked.length === 0) return;
      const indices = Array.from(checked).map(cb => parseInt(cb.dataset.presetIdx ?? '-1')).filter(i => i >= 0);
      cleanup();
      resolve(indices);
    };

    const onCancel = () => { cleanup(); resolve([]); };

    list.addEventListener('change', onCheckChange);
    confirmBtn.addEventListener('click', onConfirm);
    document.getElementById('btn-plan-selector-cancel')?.addEventListener('click', onCancel);
    overlay.style.display = 'flex';
  });
}

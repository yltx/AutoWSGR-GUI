/** 渲染模板创建向导、计划列表和分步表单。 */
/**
 * TemplateWizardView —— 模板向导 + 选择器弹窗的纯渲染组件。
 * 负责向导 overlay 的显示/隐藏、步骤导航 UI、表单读写、舰船自动补全、
 * 以及通用选择器弹窗（方案/战役/舰队/决战章节）。不含任何业务逻辑。
 */
import type { WizardFormData, WizardPrefillData, SelectorOption } from '../../types/view.js';
import { showSelector as showSelectorFn, showMultiSelector as showMultiSelectorFn } from './SelectorDialog';
import { ShipAutocomplete } from '../shared/ShipAutocomplete';

export class TemplateWizardView {
  private wizardOverlay: HTMLElement;
  private wizardTitle: HTMLElement;
  private currentStep = 1;

  onPrevious?: () => void;
  onNext?: () => void;
  onCancel?: () => void;
  onTypeChange?: (type: string) => void;
  onBrowsePlan?: () => void;
  onScanPlans?: () => void;
  onRemovePlan?: (index: number) => void;

  constructor() {
    this.wizardOverlay = document.getElementById('template-wizard')!;
    this.wizardTitle = document.getElementById('wizard-title')!;
    new ShipAutocomplete(document, '.fleet-ship');

    document.getElementById('btn-wizard-prev')?.addEventListener(
      'click',
      () => this.onPrevious?.(),
    );
    document.getElementById('btn-wizard-next')?.addEventListener(
      'click',
      () => this.onNext?.(),
    );
    document.getElementById('btn-wizard-cancel')?.addEventListener(
      'click',
      () => this.onCancel?.(),
    );
    document.querySelectorAll<HTMLInputElement>(
      'input[name="tpl-type"]',
    ).forEach((radio) => {
      radio.addEventListener('change', () => {
        this.onTypeChange?.(this.getSelectedType());
      });
    });
    document.getElementById('btn-tpl-browse-plan')?.addEventListener(
      'click',
      () => this.onBrowsePlan?.(),
    );
    document.getElementById('btn-tpl-scan-plans')?.addEventListener(
      'click',
      () => this.onScanPlans?.(),
    );
    document.getElementById('tpl-plan-list')?.addEventListener(
      'click',
      (event) => {
        const button = (event.target as HTMLElement)
          .closest<HTMLElement>('.btn-remove-plan');
        if (!button) return;
        const index = parseInt(button.dataset.idx ?? '-1', 10);
        if (index >= 0) this.onRemovePlan?.(index);
      },
    );
    for (const suffix of ['nf', 'ex', 'cp']) {
      const checkbox = document.getElementById(
        `tpl-fleet-enable-${suffix}`,
      ) as HTMLInputElement | null;
      checkbox?.addEventListener('change', () => {
        const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
        if (grid) grid.style.display = checkbox.checked ? '' : 'none';
      });
    }
  }

  // ════════════════════════════════════════
  // 向导 生命周期
  // ════════════════════════════════════════

  show(title = '创建模板'): void {
    this.currentStep = 1;
    // 重置表单
    (document.querySelector('input[name="tpl-type"][value="normal_fight"]') as HTMLInputElement).checked = true;
    (document.getElementById('tpl-plan-path') as HTMLInputElement).value = '';
    (document.getElementById('tpl-name') as HTMLInputElement).value = '';
    (document.getElementById('tpl-default-times') as HTMLInputElement).value = '1';
    (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = '-1';
    (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = '-1';
    this.renderPlanList([]);
    // 重置编队设置
    for (const suffix of ['nf', 'ex', 'cp']) {
      const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
      const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
      if (cb) cb.checked = false;
      if (grid) {
        grid.style.display = 'none';
        grid.querySelectorAll<HTMLInputElement>('.fleet-ship').forEach(inp => inp.value = '');
      }
    }
    this.wizardTitle.textContent = title;
    this.setConfigPanel(this.getSelectedType());
    this.updateStepUI();
    this.wizardOverlay.style.display = 'flex';
  }

  hide(): void {
    this.wizardOverlay.style.display = 'none';
  }

  setTitle(title: string): void {
    this.wizardTitle.textContent = title;
  }

  // ════════════════════════════════════════
  // 步骤导航 UI  
  // ════════════════════════════════════════

  getStep(): number { return this.currentStep; }

  setStep(step: number): void {
    this.currentStep = step;
    this.updateStepUI();
  }

  private updateStepUI(): void {
    const step = this.currentStep;
    for (let i = 1; i <= 3; i++) {
      const page = document.getElementById(`wizard-step-${i}`);
      if (page) page.style.display = i === step ? '' : 'none';
    }
    document.querySelectorAll('.wizard-step').forEach(el => {
      const s = parseInt(el.getAttribute('data-step') ?? '0');
      el.classList.toggle('active', s === step);
      el.classList.toggle('done', s < step);
    });
    document.getElementById('btn-wizard-prev')!.style.display = step > 1 ? '' : 'none';
    const nextBtn = document.getElementById('btn-wizard-next')!;
    nextBtn.textContent = step === 3 ? '保存' : '下一步';
  }

  // ════════════════════════════════════════
  // 配置面板
  // ════════════════════════════════════════

  /** 根据模板类型显示对应的配置面板 */
  setConfigPanel(type: string): void {
    const panelType = type === 'event_fight' ? 'normal_fight' : type;
    const panels = ['normal_fight', 'exercise', 'campaign', 'decisive'];
    for (const p of panels) {
      const el = document.getElementById(`wizard-cfg-${p}`);
      if (el) el.style.display = p === panelType ? '' : 'none';
    }
  }

  /** 读取当前选中的模板类型 */
  getSelectedType(): string {
    return (document.querySelector('input[name="tpl-type"]:checked') as HTMLInputElement)?.value ?? 'normal_fight';
  }

  // ════════════════════════════════════════
  // 方案列表
  // ════════════════════════════════════════

  renderPlanList(paths: string[]): void {
    const container = document.getElementById('tpl-plan-list');
    if (!container) return;
    if (paths.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;margin:0">尚未添加方案文件</p>';
      return;
    }
    container.innerHTML = paths.map((p, i) => {
      const name = p.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? p;
      return `<div class="tpl-plan-entry">
        <span class="plan-name" title="${p}">${name}</span>
        <span class="btn-remove-plan" data-idx="${i}" title="移除">✕</span>
      </div>`;
    }).join('');
  }

  // ════════════════════════════════════════
  // 编队网格
  // ════════════════════════════════════════

  fillFleetGrid(suffix: string, ships: string[]): void {
    const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
    const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
    if (!cb || !grid) return;
    if (ships.some(s => s)) {
      cb.checked = true;
      grid.style.display = '';
      const inputs = grid.querySelectorAll<HTMLInputElement>('.fleet-ship');
      ships.forEach((name, i) => { if (inputs[i]) inputs[i].value = name; });
    }
  }

  readFleetGrid(suffix: string): string[] | undefined {
    const cb = document.getElementById(`tpl-fleet-enable-${suffix}`) as HTMLInputElement | null;
    if (!cb?.checked) return undefined;
    const grid = document.getElementById(`tpl-fleet-grid-${suffix}`);
    if (!grid) return undefined;
    const ships = Array.from(grid.querySelectorAll<HTMLInputElement>('.fleet-ship'))
      .map(inp => inp.value.trim());
    return ships.some(s => s) ? ships : undefined;
  }

  // ════════════════════════════════════════
  // 预填 (编辑/导入)
  // ════════════════════════════════════════

  prefill(data: WizardPrefillData): void {
    if (data.type) {
      const radio = document.querySelector(`input[name="tpl-type"][value="${data.type}"]`) as HTMLInputElement | null;
      if (radio) radio.checked = true;
      this.setConfigPanel(data.type);
    }

    switch (data.type) {
      case 'normal_fight':
      case 'event_fight': {
        if (data.fleet_id) (document.getElementById('tpl-fleet') as HTMLSelectElement).value = String(data.fleet_id);
        if (data.fleet?.length) this.fillFleetGrid('nf', data.fleet);
        break;
      }
      case 'exercise': {
        if (data.fleet_id) (document.getElementById('tpl-exercise-fleet') as HTMLSelectElement).value = String(data.fleet_id);
        if (data.fleet?.length) this.fillFleetGrid('ex', data.fleet);
        break;
      }
      case 'campaign': {
        if (data.campaign_name) (document.getElementById('tpl-campaign-type') as HTMLSelectElement).value = data.campaign_name;
        if (data.fleet?.length) this.fillFleetGrid('cp', data.fleet);
        break;
      }
      case 'decisive': {
        if (data.chapter) (document.getElementById('tpl-decisive-chapter') as HTMLSelectElement).value = String(data.chapter);
        if (data.level1?.length) (document.getElementById('tpl-decisive-level1') as HTMLTextAreaElement).value = data.level1.join('\n');
        if (data.level2?.length) (document.getElementById('tpl-decisive-level2') as HTMLTextAreaElement).value = data.level2.join('\n');
        if (data.flagship_priority?.length) (document.getElementById('tpl-decisive-flagship') as HTMLTextAreaElement).value = data.flagship_priority.join('\n');
        (document.getElementById('tpl-decisive-quick-repair') as HTMLInputElement).checked = data.use_quick_repair !== false;
        break;
      }
    }

    if (data.name) (document.getElementById('tpl-name') as HTMLInputElement).value = data.name;
    if (data.defaultTimes) (document.getElementById('tpl-default-times') as HTMLInputElement).value = String(data.defaultTimes);
    if (data.defaultStopCondition?.loot_count_ge != null && data.defaultStopCondition.loot_count_ge > 0) {
      (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = String(data.defaultStopCondition.loot_count_ge);
    }
    if (data.defaultStopCondition?.ship_count_ge != null && data.defaultStopCondition.ship_count_ge > 0) {
      (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = String(data.defaultStopCondition.ship_count_ge);
    }
  }

  /** 设置向导中的 plan 路径输入框 */
  setPlanPathInput(path: string): void {
    (document.getElementById('tpl-plan-path') as HTMLInputElement).value = path;
  }

  /** 设置 fleet ID 下拉 */
  setFleetId(id: number): void {
    (document.getElementById('tpl-fleet') as HTMLSelectElement).value = String(id);
  }

  /** 设置模板名称 */
  setName(name: string): void {
    (document.getElementById('tpl-name') as HTMLInputElement).value = name;
  }

  /** 设置默认次数 */
  setDefaultTimes(times: number): void {
    (document.getElementById('tpl-default-times') as HTMLInputElement).value = String(times);
  }

  /** 设置停止条件 */
  setStopConditions(loot?: number, ship?: number): void {
    if (loot != null) (document.getElementById('tpl-stop-loot') as HTMLInputElement).value = String(loot);
    if (ship != null) (document.getElementById('tpl-stop-ship') as HTMLInputElement).value = String(ship);
  }

  // ════════════════════════════════════════
  // 表单收集
  // ════════════════════════════════════════

  collectForm(): WizardFormData {
    const type = this.getSelectedType();
    const name = (document.getElementById('tpl-name') as HTMLInputElement).value.trim();
    const defaultTimes = parseInt((document.getElementById('tpl-default-times') as HTMLInputElement).value) || 1;
    const stopLoot = parseInt((document.getElementById('tpl-stop-loot') as HTMLInputElement).value) || 0;
    const stopShip = parseInt((document.getElementById('tpl-stop-ship') as HTMLInputElement).value) || 0;

    const data: WizardFormData = { type, name, defaultTimes, stopLoot, stopShip };

    switch (type) {
      case 'normal_fight':
      case 'event_fight':
        data.planPath = (document.getElementById('tpl-plan-path') as HTMLInputElement).value;
        data.fleetId = parseInt((document.getElementById('tpl-fleet') as HTMLSelectElement).value);
        data.fleetNf = this.readFleetGrid('nf');
        break;
      case 'exercise':
        data.exerciseFleetId = parseInt((document.getElementById('tpl-exercise-fleet') as HTMLSelectElement).value);
        data.fleetEx = this.readFleetGrid('ex');
        break;
      case 'campaign':
        data.campaignName = (document.getElementById('tpl-campaign-type') as HTMLSelectElement).value;
        data.fleetCp = this.readFleetGrid('cp');
        break;
      case 'decisive':
        data.chapter = parseInt((document.getElementById('tpl-decisive-chapter') as HTMLSelectElement).value);
        data.level1 = this.parseLines('tpl-decisive-level1');
        data.level2 = this.parseLines('tpl-decisive-level2');
        data.flagshipPriority = this.parseLines('tpl-decisive-flagship');
        data.useQuickRepair = (document.getElementById('tpl-decisive-quick-repair') as HTMLInputElement).checked;
        break;
    }

    return data;
  }

  /** 聚焦名称输入框 */
  focusName(): void {
    (document.getElementById('tpl-name') as HTMLInputElement).focus();
  }

  private parseLines(id: string): string[] {
    return (document.getElementById(id) as HTMLTextAreaElement).value
      .split('\n').map(s => s.trim()).filter(Boolean);
  }

  // ════════════════════════════════════════
  // 通用选择器弹窗
  // ════════════════════════════════════════

  /** 单选选择器：委托到独立模块 */
  showSelector(title: string, options: SelectorOption[], showTimes = false, defaultTimes = 1): Promise<{ index: number; times: number } | null> {
    return showSelectorFn(title, options, showTimes, defaultTimes);
  }

  /** 多选选择器：委托到独立模块 */
  showMultiSelector(title: string, options: SelectorOption[]): Promise<number[]> {
    return showMultiSelectorFn(title, options);
  }
}

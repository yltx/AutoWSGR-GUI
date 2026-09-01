/** 协调模板库、模板向导和任务组添加流程。 */
/**
 * TemplateController —— 模板系统控制器（精简版）。
 * 向导逻辑 → wizard.ts，使用模板 → useTemplate.ts，
 * 选择弹窗 → selectors.ts，CRUD → crud.ts。
 */
import { TemplateModel } from '../../model/TemplateModel';
import { TaskGroupModel } from '../../model/TaskGroupModel';
import type { PlanData } from '../../types/model.js';
import type { TemplateLibraryItemVO } from '../../types/view.js';
import { TemplateLibraryView } from '../../view/template/TemplateLibraryView';
import { TemplateWizardView } from '../../view/template/TemplateWizardView';
import { Logger } from '../../utils/Logger';
import { showWizard, wizardNav, finishWizard } from './wizard';
import { useTemplateFlow, type UseTemplateCallbacks } from './useTemplate';
import { showPlanSelector, showCampaignSelector, showExerciseFleetSelector, showDecisiveChapterSelector } from './selectors';
import { editTemplate, deleteTemplate, renameTemplate, importTemplatesFlow } from './crud';
import { yamlCodec } from '../../adapter';
import {
  getTemplateRepository,
  type TemplateRepository,
} from '../../adapter/IpcAdapter.js';

export class TemplateController {
  static readonly TEMPLATE_TYPE_LABELS: Record<string, string> = {
    normal_fight: '普通出击',
    event_fight: '活动出击',
    exercise: '演习',
    campaign: '战役',
    decisive: '决战',
  };

  private readonly wizardPlanPathsRef: { value: string[] } = { value: [] };
  private readonly editingIdRef: { value: string | null } = { value: null };
  private libraryView: TemplateLibraryView;
  private wizardView: TemplateWizardView;

  constructor(
    private readonly templateModel: TemplateModel,
    private readonly taskGroupModel: TaskGroupModel,
    private readonly renderTaskGroup: () => void,
    public plansDir: string,
    public appRoot: string,
    private readonly repository: TemplateRepository | undefined =
      getTemplateRepository(),
  ) {
    this.libraryView = new TemplateLibraryView();
    this.wizardView = new TemplateWizardView();
  }

  // ════════════════════════════════════════
  // 公共接口
  // ════════════════════════════════════════

  bindActions(): void {
    this.libraryView.onCreate = () => {
      showWizard(this.wizardView, this.wizardPlanPathsRef, this.editingIdRef);
    };

    this.libraryView.onImport = () => {
      void importTemplatesFlow(
        this.templateModel,
        this.wizardView,
        this.wizardPlanPathsRef,
        this.appRoot,
        () => this.renderLibrary(),
        this.repository,
      );
    };

    this.wizardView.onPrevious = () => {
      wizardNav(-1, this.wizardView, () => this.doFinishWizard());
    };
    this.wizardView.onNext = () => {
      wizardNav(1, this.wizardView, () => this.doFinishWizard());
    };
    this.wizardView.onCancel = () => this.wizardView.hide();
    this.wizardView.onTypeChange = type => (
      this.wizardView.setConfigPanel(type)
    );
    this.wizardView.onBrowsePlan = () => void this.browsePlan();
    this.wizardView.onScanPlans = () => void this.scanPlans();
    this.wizardView.onRemovePlan = (index) => {
      if (index < this.wizardPlanPathsRef.value.length) {
        this.wizardPlanPathsRef.value.splice(index, 1);
        this.wizardView.renderPlanList(this.wizardPlanPathsRef.value);
      }
    };

    // Library view 回调
    this.libraryView.onUse = (id) => this.doUseTemplate(id);
    this.libraryView.onEdit = (id) => editTemplate(id, this.templateModel, this.wizardView, this.wizardPlanPathsRef, this.editingIdRef);
    this.libraryView.onDelete = (id) => deleteTemplate(id, this.templateModel, () => this.renderLibrary());
    this.libraryView.onRename = (id) => renameTemplate(id, this.templateModel, () => this.renderLibrary());

    // 初始渲染模板库
    this.renderLibrary();
  }

  renderLibrary(): void {
    const templates = this.templateModel.getAll()
      .filter(tpl => tpl.type !== 'decisive');
    const items: TemplateLibraryItemVO[] = templates.map(tpl => ({
      id: tpl.id,
      name: tpl.name,
      type: tpl.type,
      typeLabel: TemplateController.TEMPLATE_TYPE_LABELS[tpl.type] ?? tpl.type,
      planCount: tpl.planPaths?.length ?? (tpl.planPath ? 1 : 0),
      defaultTimes: tpl.defaultTimes ?? 0,
      description: tpl.description,
      isBuiltin: !!tpl.builtin,
    }));
    this.libraryView.render(items);
  }

  private async browsePlan(): Promise<void> {
    if (!this.repository) return;
    const result = await this.repository.openFileDialog(
      [{ name: 'YAML 方案', extensions: ['yaml', 'yml'] }],
      this.plansDir || undefined,
    );
    if (!result) return;

    const filePath = result.path;
    if (!this.wizardPlanPathsRef.value.includes(filePath)) {
      this.wizardPlanPathsRef.value.push(filePath);
      this.wizardView.renderPlanList(this.wizardPlanPathsRef.value);
    }
    this.wizardView.setPlanPathInput(filePath);
    if (this.wizardPlanPathsRef.value.length !== 1) return;

    try {
      const parsed = yamlCodec.parse<Partial<PlanData>>(result.content);
      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.fleet_id === 'number') {
        this.wizardView.setFleetId(parsed.fleet_id);
      }
      const presets = Array.isArray(parsed.fleet_presets)
        ? parsed.fleet_presets
        : [];
      const fixedShips = presets[0]?.ships.filter(
        (ship): ship is string => typeof ship === 'string',
      ) ?? [];
      if (fixedShips.length > 0) {
        this.wizardView.fillFleetGrid('nf', fixedShips);
      }
      const stopCondition = parsed.stop_condition;
      if (stopCondition?.loot_count_ge != null
        && stopCondition.loot_count_ge >= 0) {
        this.wizardView.setStopConditions(
          stopCondition.loot_count_ge,
          undefined,
        );
      }
      if (stopCondition?.ship_count_ge != null
        && stopCondition.ship_count_ge >= 0) {
        this.wizardView.setStopConditions(
          undefined,
          stopCondition.ship_count_ge,
        );
      }
      const fileName = filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.ya?ml$/i, '') ?? '';
      if (fileName) this.wizardView.setName(fileName);
      if (typeof parsed.times === 'number' && parsed.times > 0) {
        this.wizardView.setDefaultTimes(parsed.times);
      }
    } catch {
      // YAML 解析失败不影响用户继续填写模板。
    }
  }

  private async scanPlans(): Promise<void> {
    if (!this.repository) return;
    const files = await this.repository.listPlanFiles();
    let added = 0;
    for (const file of files) {
      const fullPath = `${this.plansDir}\\${file.file}`;
      if (this.wizardPlanPathsRef.value.includes(fullPath)) continue;
      this.wizardPlanPathsRef.value.push(fullPath);
      added += 1;
    }
    if (added > 0) {
      this.wizardView.renderPlanList(this.wizardPlanPathsRef.value);
      Logger.info(`扫描到 ${files.length} 个方案文件，新增 ${added} 个`);
    }
  }

  // ════════════════════════════════════════
  // 内部代理
  // ════════════════════════════════════════

  private async doFinishWizard(): Promise<void> {
    await finishWizard(
      this.wizardView, this.templateModel,
      this.wizardPlanPathsRef.value, this.editingIdRef,
      () => this.renderLibrary(),
    );
  }

  private async doUseTemplate(id: string): Promise<void> {
    const callbacks: UseTemplateCallbacks = {
      showPlanSelector: (tpl, paths, gn) => showPlanSelector(
        tpl,
        paths,
        gn,
        this.wizardView,
        this.taskGroupModel,
        this.renderTaskGroup,
        this.repository,
      ),
      showCampaignSelector: (tpl, gn) => showCampaignSelector(tpl, gn, this.wizardView, this.taskGroupModel, this.renderTaskGroup),
      showExerciseFleetSelector: (tpl, gn) => showExerciseFleetSelector(tpl, gn, this.wizardView, this.taskGroupModel, this.renderTaskGroup),
      showDecisiveChapterSelector: (tpl, gn) => showDecisiveChapterSelector(tpl, gn, this.wizardView, this.taskGroupModel, this.renderTaskGroup),
    };
    await useTemplateFlow(id, this.templateModel, this.taskGroupModel, this.renderTaskGroup, callbacks);
  }
}

/** 维护模板向导步骤、预填数据和表单提交。 */
/**
 * wizard —— 模板向导显示/导航/完成逻辑。
 */
import type { TemplateWizardView } from '../../view/template/TemplateWizardView';
import type { TemplateModel } from '../../model/TemplateModel';
import type { TaskTemplate } from '../../types/model.js';
import type { WizardPrefillData } from '../../types/view.js';
import { Logger } from '../../utils/Logger';
import { showAlert, showSaveSuccess } from '../../view/shared/DialogHelper';

/** 打开创建模板向导 */
export function showWizard(
  wizardView: TemplateWizardView,
  wizardPlanPaths: { value: string[] },
  editingTemplateId: { value: string | null },
): void {
  wizardPlanPaths.value = [];
  editingTemplateId.value = null;
  wizardView.show('创建模板');
}

/** 用已有模板数据预填向导（导入/编辑） */
export function showWizardWithTemplate(
  tpl: WizardPrefillData,
  wizardView: TemplateWizardView,
  wizardPlanPaths: { value: string[] },
): void {
  wizardView.show('导入模板');
  const planPaths = tpl.planPaths?.length ? [...tpl.planPaths]
    : tpl.planPath ? [tpl.planPath] : [];
  wizardPlanPaths.value = planPaths;
  if (planPaths.length > 0) {
    wizardView.renderPlanList(planPaths);
  }
  wizardView.prefill(tpl);
  wizardView.setStep(2);
}

/** 向导导航 */
export function wizardNav(
  dir: number,
  wizardView: TemplateWizardView,
  finishCallback: () => void,
): void {
  const step = wizardView.getStep();
  if (step === 3 && dir === 1) { finishCallback(); return; }
  const next = step + dir;
  if (next < 1 || next > 3) return;
  wizardView.setStep(next);
}

/** 完成向导，创建或更新模板 */
export async function finishWizard(
  wizardView: TemplateWizardView,
  templateModel: TemplateModel,
  wizardPlanPaths: string[],
  editingTemplateId: { value: string | null },
  renderLibrary: () => void,
): Promise<void> {
  const form = wizardView.collectForm();
  const type = form.type as TaskTemplate['type'];
  const name = form.name;
  if (!name) { wizardView.focusName(); return; }

  const times = form.defaultTimes;

  let stopCondition: TaskTemplate['defaultStopCondition'];
  if (type !== 'decisive') {
    const loot = form.stopLoot;
    const ship = form.stopShip;
    stopCondition = (loot > 0 || ship > 0) ? {
      ...(loot > 0 ? { loot_count_ge: loot } : {}),
      ...(ship > 0 ? { ship_count_ge: ship } : {}),
    } : undefined;
  }

  const partial: Omit<TaskTemplate, 'id' | 'createdAt'> = {
    name,
    type,
    defaultTimes: times,
    defaultStopCondition: stopCondition,
  };

  switch (type) {
    case 'normal_fight':
    case 'event_fight': {
      if (wizardPlanPaths.length === 0) {
        const planPath = form.planPath;
        if (!planPath) { wizardView.setStep(2); return; }
        wizardPlanPaths.push(planPath);
      }
      partial.planPaths = [...wizardPlanPaths];
      partial.planPath = wizardPlanPaths[0];
      partial.fleet_id = form.fleetId;
      partial.fleet = form.fleetNf;
      break;
    }
    case 'exercise':
      partial.fleet_id = form.exerciseFleetId;
      partial.fleet = form.fleetEx;
      break;
    case 'campaign':
      partial.campaign_name = form.campaignName;
      partial.fleet = form.fleetCp;
      break;
    case 'decisive':
      partial.chapter = form.chapter;
      partial.level1 = form.level1;
      partial.level2 = form.level2;
      partial.flagship_priority = form.flagshipPriority;
      partial.use_quick_repair = form.useQuickRepair;
      break;
  }

  try {
    if (editingTemplateId.value) {
      const updated = await templateModel.update(
        editingTemplateId.value,
        partial,
      );
      if (!updated) throw new Error('模板不存在或不可编辑');
      Logger.info(`模板「${name}」已更新`);
      editingTemplateId.value = null;
    } else {
      await templateModel.add(partial);
      Logger.info(`模板「${name}」已创建`);
    }
  } catch (error) {
    await showAlert(
      '保存失败',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  wizardView.hide();
  renderLibrary();
  showSaveSuccess(`模板「${name}」保存成功`);
}

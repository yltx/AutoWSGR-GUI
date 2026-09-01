/** 实现模板创建、编辑、删除、导入和导出用例。 */
/**
 * crud —— 模板 CRUD 操作。
 */
import type { TemplateModel } from '../../model/TemplateModel';
import type { TemplateWizardView } from '../../view/template/TemplateWizardView';
import type { WizardPrefillData } from '../../types/view.js';
import { Logger } from '../../utils/Logger';
import {
  showAlert,
  showConfirm,
  showPrompt,
} from '../../view/shared/DialogHelper';
import { showWizardWithTemplate } from './wizard';
import { jsonCodec } from '../../adapter';
import {
  getTemplateRepository,
  type TemplateRepository,
} from '../../adapter/IpcAdapter.js';

function isTemplateRecord(
  value: unknown,
): value is Record<string, unknown> & { name: string; type: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.type === 'string';
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function toWizardPrefillData(
  record: Record<string, unknown> & { name: string; type: string },
): WizardPrefillData {
  const stop = record.defaultStopCondition;
  const stopRecord = stop && typeof stop === 'object' && !Array.isArray(stop)
    ? stop as Record<string, unknown>
    : null;
  return {
    type: record.type,
    name: record.name,
    defaultTimes: typeof record.defaultTimes === 'number'
      ? record.defaultTimes
      : undefined,
    planPaths: stringArray(record.planPaths),
    planPath: typeof record.planPath === 'string'
      ? record.planPath
      : undefined,
    fleet_id: typeof record.fleet_id === 'number'
      ? record.fleet_id
      : undefined,
    fleet: stringArray(record.fleet),
    campaign_name: typeof record.campaign_name === 'string'
      ? record.campaign_name
      : undefined,
    chapter: typeof record.chapter === 'number' ? record.chapter : undefined,
    level1: stringArray(record.level1),
    level2: stringArray(record.level2),
    flagship_priority: stringArray(record.flagship_priority),
    use_quick_repair: typeof record.use_quick_repair === 'boolean'
      ? record.use_quick_repair
      : undefined,
    defaultStopCondition: stopRecord ? {
      loot_count_ge: typeof stopRecord.loot_count_ge === 'number'
        ? stopRecord.loot_count_ge
        : undefined,
      ship_count_ge: typeof stopRecord.ship_count_ge === 'number'
        ? stopRecord.ship_count_ge
        : undefined,
    } : undefined,
  };
}

/** 编辑模板 */
export function editTemplate(
  id: string,
  templateModel: TemplateModel,
  wizardView: TemplateWizardView,
  wizardPlanPaths: { value: string[] },
  editingTemplateId: { value: string | null },
): void {
  if (templateModel.isBuiltin(id)) return;
  const tpl = templateModel.get(id);
  if (!tpl) return;
  editingTemplateId.value = id;
  showWizardWithTemplate(tpl, wizardView, wizardPlanPaths);
  wizardView.setTitle('编辑模板');
}

/** 删除模板 */
export async function deleteTemplate(
  id: string,
  templateModel: TemplateModel,
  renderLibrary: () => void,
): Promise<void> {
  if (templateModel.isBuiltin(id)) return;
  const tpl = templateModel.get(id);
  if (!tpl) return;
  const ok = await showConfirm('确认删除', `确定删除模板「${tpl.name}」？`);
  if (!ok) return;
  await templateModel.remove(id);
  renderLibrary();
  Logger.info(`模板「${tpl.name}」已删除`);
}

/** 重命名模板 */
export async function renameTemplate(
  id: string,
  templateModel: TemplateModel,
  renderLibrary: () => void,
): Promise<void> {
  if (templateModel.isBuiltin(id)) return;
  const tpl = templateModel.get(id);
  if (!tpl) return;
  const newName = await showPrompt('重命名模板', '请输入新名称：', tpl.name);
  if (!newName?.trim()) return;
  await templateModel.rename(id, newName.trim());
  renderLibrary();
}

/** 从 JSON 文件导入模板 */
export async function importTemplatesFlow(
  templateModel: TemplateModel,
  wizardView: TemplateWizardView,
  wizardPlanPaths: { value: string[] },
  appRoot: string,
  renderLibrary: () => void,
  repository: TemplateRepository | undefined = getTemplateRepository(),
): Promise<void> {
  if (!repository) return;
  const defaultDir = appRoot ? `${appRoot}\\templates` : undefined;
  const result = await repository.openFileDialog(
    [{ name: '模板文件', extensions: ['json'] }],
    defaultDir,
  );
  if (!result) return;

  let arr: unknown[];
  try {
    const parsed = jsonCodec.parse<unknown>(result.content);
    arr = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    showAlert('导入失败', '文件格式错误，请选择有效的 JSON 模板文件。');
    return;
  }

  const valid = arr.filter(isTemplateRecord);
  if (valid.length === 0) {
    showAlert('导入失败', '未找到有效的模板数据（需包含 name 和 type 字段）。');
    return;
  }

  showWizardWithTemplate(
    toWizardPrefillData(valid[0]),
    wizardView,
    wizardPlanPaths,
  );
  if (valid.length > 1) {
    const rest = valid.slice(1);
    const count = await templateModel.importFromJson(rest);
    renderLibrary();
    Logger.info(`其余 ${count} 个模板已直接导入`);
  }
}

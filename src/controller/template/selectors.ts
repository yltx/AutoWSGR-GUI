/** 提供方案、舰队和任务参数的模板选择流程。 */
/**
 * selectors —— 模板使用时的选择弹窗逻辑。
 */
import type { TemplateWizardView } from '../../view/template/TemplateWizardView';
import type { TaskGroupModel } from '../../model/TaskGroupModel';
import type {
  FleetPreset,
  PlanData,
  TaskTemplate,
} from '../../types/model.js';
import type { SelectorOption } from '../../types/view.js';
import { shipSlotLabel } from '../../model/fleet/ShipMatcher';
import { Logger } from '../../utils/Logger';
import { addPlanToTaskList } from './useTemplate';
import { yamlCodec } from '../../adapter';
import {
  getTemplateRepository,
  type TemplateRepository,
} from '../../adapter/IpcAdapter.js';

const CAMPAIGN_OPTIONS: string[] = [
  '困难潜艇', '困难航母', '困难驱逐', '困难巡洋', '困难战列',
  '简单航母', '简单潜艇', '简单驱逐', '简单巡洋', '简单战列',
];

const DECISIVE_CHAPTERS = [
  { value: 1, label: '第 1 章' }, { value: 2, label: '第 2 章' },
  { value: 3, label: '第 3 章' }, { value: 4, label: '第 4 章' },
  { value: 5, label: '第 5 章' }, { value: 6, label: '第 6 章' },
];

const NORMAL_FLEET_IDS = [1, 2, 3, 4] as const;

async function showNormalFightFleetSelector(
  templateName: string,
  planName: string,
  defaultFleetId: number,
  wizardView: TemplateWizardView,
): Promise<number | undefined | null> {
  const options: SelectorOption[] = [
    { icon: '📄', label: '仅使用方案，不指定编队预设' },
    ...NORMAL_FLEET_IDS.map((fleetId) => ({
      icon: '⚓',
      label: fleetId === defaultFleetId
        ? `第 ${fleetId} 分队（默认）`
        : `第 ${fleetId} 分队`,
    })),
  ];

  const result = await wizardView.showSelector(`「${templateName} / ${planName}」— 选择使用分队`, options);
  if (!result) return null;
  if (result.index === 0) return undefined;
  return NORMAL_FLEET_IDS[result.index - 1] ?? null;
}

/** 方案选择器（多方案模板） */
export async function showPlanSelector(
  tpl: TaskTemplate,
  paths: string[],
  groupName: string,
  wizardView: TemplateWizardView,
  taskGroupModel: TaskGroupModel,
  renderTaskGroup: () => void,
  repository: TemplateRepository | undefined = getTemplateRepository(),
): Promise<void> {
  const options: SelectorOption[] = paths.map(p => ({
    icon: '📄',
    label: p.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? p,
  }));

  const result = await wizardView.showSelector(`「${tpl.name}」— 选择执行方案`, options);
  if (!result) return;

  const idx = result.index;
  const planPath = paths[idx];
  const planName = planPath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? planPath;

  // 选完方案后直接加入任务列表（无需编队预设选择）的公共步骤
  const addPlanDirect = (): void => {
    addPlanToTaskList(tpl, planPath, groupName, taskGroupModel);
    taskGroupModel.save();
    renderTaskGroup();
    Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（方案: ${planName}）`);
  };

  let parsedPlan: Partial<PlanData> | undefined;

  if (repository) {
    try {
      const content = await repository.readFile(planPath);
      parsedPlan = yamlCodec.parse<Partial<PlanData>>(content);
      const rawPresets = Array.isArray(parsedPlan?.fleet_presets)
        ? parsedPlan.fleet_presets
        : [];
      if (rawPresets.length > 0) {
        let defaultFleetId = tpl.fleet_id ?? 1;
        const rawFleetId = Number(parsedPlan?.fleet_id);
        if (Number.isFinite(rawFleetId) && rawFleetId >= 1 && rawFleetId <= 4) {
          defaultFleetId = rawFleetId;
        }

        const selectedFleetId = await showNormalFightFleetSelector(tpl.name, planName, defaultFleetId, wizardView);
        if (selectedFleetId === null) return;
        if (selectedFleetId === undefined) {
          addPlanDirect();
          return;
        }

        await showFleetPresetPicker(
          tpl,
          planPath,
          rawPresets,
          groupName,
          wizardView,
          taskGroupModel,
          renderTaskGroup,
          selectedFleetId,
        );
        return;
      }
    } catch { /* 忽略读取失败 */ }
  }

  addPlanDirect();
}

/** 编队预设多选器 */
export async function showFleetPresetPicker(
  tpl: TaskTemplate,
  planPath: string,
  rawPresets: FleetPreset[],
  groupName: string,
  wizardView: TemplateWizardView,
  taskGroupModel: TaskGroupModel,
  renderTaskGroup: () => void,
  selectedFleetId: number,
): Promise<void> {
  const planName = planPath.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? '';
  const options: SelectorOption[] = rawPresets.map((p, i) => {
    const pName = p.name ?? `预设${i + 1}`;
    const ships = Array.isArray(p.ships) ? p.ships : [];
    const shipsHtml = ships.map((s) => {
      if (typeof s === 'string') return `<span class="ship-tag">${s}</span>`;
      const label = shipSlotLabel(s);
      return `<span class="ship-tag ship-tag-filter">${label}</span>`;
    }).join('');
    return { icon: '⚓', label: pName, sublabel: shipsHtml };
  });

  const indices = await wizardView.showMultiSelector(`「${planName}」— 选择编队（可多选）`, options);
  if (indices.length === 0) return;

  for (const idx of indices) {
    const preset = rawPresets[idx];
    const presetName = preset?.name ?? '';
    addPlanToTaskList(
      tpl,
      planPath,
      groupName,
      taskGroupModel,
      idx,
      presetName,
      selectedFleetId,
    );
  }
  taskGroupModel.save();
  renderTaskGroup();
  const names = indices.map(i => rawPresets[i]?.name ?? '').join(', ');
  Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（方案: ${planName}, 分队: ${selectedFleetId}, 编队预设: ${names}）`);
}

/** 战役类型选择器 */
export async function showCampaignSelector(
  tpl: TaskTemplate,
  groupName: string,
  wizardView: TemplateWizardView,
  taskGroupModel: TaskGroupModel,
  renderTaskGroup: () => void,
): Promise<void> {
  const options: SelectorOption[] = CAMPAIGN_OPTIONS.map(name => ({ icon: '⚔', label: name }));
  const result = await wizardView.showSelector(
    `「${tpl.name}」— 选择战役类型`, options, true, tpl.defaultTimes ?? 1,
  );
  if (!result) return;

  const chosen = CAMPAIGN_OPTIONS[result.index];
  if (!chosen) return;

  taskGroupModel.addItem(groupName, {
    templateId: tpl.id, kind: 'template', times: result.times,
    label: `${tpl.name} (${chosen})`, campaignName: chosen,
  });
  taskGroupModel.save();
  renderTaskGroup();
  Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（${chosen}）`);
}

/** 演习舰队选择器 */
export async function showExerciseFleetSelector(
  tpl: TaskTemplate,
  groupName: string,
  wizardView: TemplateWizardView,
  taskGroupModel: TaskGroupModel,
  renderTaskGroup: () => void,
): Promise<void> {
  const fleetOptions = ['第 1 舰队', '第 2 舰队', '第 3 舰队', '第 4 舰队'];
  const options: SelectorOption[] = fleetOptions.map(name => ({ icon: '⚓', label: name }));
  const result = await wizardView.showSelector(`「${tpl.name}」— 选择舰队`, options);
  if (!result) return;

  const idx = result.index;
  taskGroupModel.addItem(groupName, {
    templateId: tpl.id, kind: 'template', times: tpl.defaultTimes ?? 1,
    label: `${tpl.name} (${fleetOptions[idx]})`, fleet_id: idx + 1,
  });
  taskGroupModel.save();
  renderTaskGroup();
  Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（${fleetOptions[idx]}）`);
}

/** 决战章节选择器 */
export async function showDecisiveChapterSelector(
  tpl: TaskTemplate,
  groupName: string,
  wizardView: TemplateWizardView,
  taskGroupModel: TaskGroupModel,
  renderTaskGroup: () => void,
): Promise<void> {
  const options: SelectorOption[] = DECISIVE_CHAPTERS.map(ch => ({ icon: '🏆', label: ch.label }));
  const result = await wizardView.showSelector(
    `「${tpl.name}」— 选择章节`, options, true, tpl.defaultTimes ?? 1,
  );
  if (!result) return;

  const chosen = DECISIVE_CHAPTERS[result.index];
  if (!chosen) return;

  taskGroupModel.addItem(groupName, {
    templateId: tpl.id, kind: 'template', times: result.times,
    label: `${tpl.name} (${chosen.label})`, chapter: chosen.value,
  });
  taskGroupModel.save();
  renderTaskGroup();
  Logger.info(`模板「${tpl.name}」→ 已加入任务列表「${groupName}」（${chosen.label}）`);
}

/** 自动决战只允许使用计划页方案或内置系统预设。 */

export const USER_DECISIVE_PLAN_ID = 'user_plan';
export const SYSTEM_DECISIVE_PRESET_ID = 'system_preset';
export const SYSTEM_DECISIVE_TEMPLATE_ID = 'builtin_decisive_6';

export type DecisiveAutomationSource =
  | typeof USER_DECISIVE_PLAN_ID
  | typeof SYSTEM_DECISIVE_PRESET_ID;

/** 将旧模板 ID 和异常值收口到当前两种稳定来源。 */
export function normalizeDecisiveAutomationSource(
  value: unknown,
): DecisiveAutomationSource {
  return value === USER_DECISIVE_PLAN_ID
    ? USER_DECISIVE_PLAN_ID
    : SYSTEM_DECISIVE_PRESET_ID;
}

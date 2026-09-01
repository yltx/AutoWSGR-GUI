/**
 * 旧版设置页保存过的决战自动化配置。
 *
 * 自动决战开关和模板可升级到正式 GUI 自动化配置；票数保留仅做
 * 无损归档，不参与执行轮数，也不能覆盖独立维护的决战计划。
 */
export interface LegacyDecisiveAutomationSettings {
  autoDecisive?: boolean;
  ticketReserve?: number;
  templateId?: string;
}

export const LEGACY_DECISIVE_YAML_KEYS = [
  'auto_decisive',
  'decisive_ticket_reserve',
  'decisive_template_id',
] as const;

export type LegacyDecisiveYamlKey =
  typeof LEGACY_DECISIVE_YAML_KEYS[number];

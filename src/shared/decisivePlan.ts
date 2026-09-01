/** Main、Preload 与 Renderer 共用的决战计划契约和初始默认值。 */
export interface DecisivePlanSettings {
  chapter: number;
  useQuickRepair: boolean;
  level1: string[];
  level2: string[];
}

export const DEFAULT_DECISIVE_PLAN_SETTINGS: DecisivePlanSettings = {
  chapter: 6,
  useQuickRepair: true,
  level1: [
    'U-47',
    'U-1405',
    'U-1206',
    'U-2540',
    'U-81',
    'U-96',
  ],
  level2: [
    'U-505',
    '射水鱼',
    '大青花鱼',
    'M-296',
    '鹦鹉螺',
    'S-49',
    'IIIA',
    'K-21',
    'U-441',
    '潜甲',
    '潜乙',
    '伊-201',
    '伊-25',
    '鲃鱼',
    '伊-400',
    '激流',
    'U-4501',
    'U-459',
    'U-14',
    'U-35',
    'K1',
  ],
};

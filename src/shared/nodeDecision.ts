/** 统一归一化新旧节点决策字段，供主进程和 Renderer 共用。 */
export function normalizeLegacyNodeDecisionFields<
  T extends Record<string, unknown>,
>(args: T): T {
  const normalized: Record<string, unknown> = { ...args };
  if (
    normalized.SL_when_detour_fails == null
    && typeof normalized.sl_when_detour_fails === 'boolean'
  ) {
    normalized.SL_when_detour_fails = normalized.sl_when_detour_fails;
  }
  delete normalized.sl_when_detour_fails;
  return normalized as T;
}

/** 提供舰船损伤阈值、替换候选和修理时长的纯规则。 */
/** Pure scheduler repair waiting policy. */

export function calculateRepairWaitMs(
  bathingShips?: ReadonlyMap<string, { repairEndTime: number }>,
  now = Date.now(),
): number {
  if (!bathingShips || bathingShips.size === 0) return -1;

  let minEndTime = Infinity;
  for (const ship of bathingShips.values()) {
    if (ship.repairEndTime > 0) minEndTime = Math.min(minEndTime, ship.repairEndTime);
  }

  if (!Number.isFinite(minEndTime)) return -1;
  if (minEndTime <= now) return 5_000;
  return Math.min(minEndTime - now + 5_000, 30_000);
}

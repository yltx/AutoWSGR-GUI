/** 提供 22 种规范舰种代码、标签、映射和契约校验。 */
import {
  NATIVE_FLEET_SHIP_TYPE_CODES,
  NATIVE_FLEET_SHIP_TYPE_LABELS,
} from './nativeFleetShipTypes.generated';

export {
  NATIVE_FLEET_SHIP_TYPE_CODES,
  NATIVE_FLEET_SHIP_TYPE_LABELS,
} from './nativeFleetShipTypes.generated';

/** GUI 显示和 YAML 校验共用的后端舰种代码。 */
export const TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ...NATIVE_FLEET_SHIP_TYPE_LABELS,
  ss_or_ssg: '潜艇/导潜',
});

export const FLEET_SHIP_TYPE_CODES = Object.freeze([
  ...NATIVE_FLEET_SHIP_TYPE_CODES,
  'ss_or_ssg',
]);

const CANONICAL_FLEET_SHIP_TYPES = new Set(FLEET_SHIP_TYPE_CODES);

/** 舰船资料库的显示优先级；native 新增类型会自动追加。 */
const SHIP_TYPE_FILTER_PRIORITY: readonly string[] = Object.freeze([
  'ap',
  'av',
  'cv',
  'bb',
  'bbg',
  'bbv',
  'bc',
  'bm',
  'ca',
  'cav',
  'cl',
  'clt',
  'cvl',
  'dd',
  'asdg',
  'kp',
  'ssg',
  'sc',
  'ss',
  'aadg',
  'cg',
  'bg',
]);

export const SHIP_TYPE_FILTER_ORDER: readonly string[] = Object.freeze([
  ...SHIP_TYPE_FILTER_PRIORITY.filter(
    code => NATIVE_FLEET_SHIP_TYPE_CODES.includes(code),
  ),
  ...NATIVE_FLEET_SHIP_TYPE_CODES.filter(
    code => !SHIP_TYPE_FILTER_PRIORITY.includes(code),
  ),
]);

/** 规范大小写并校验后端 canonical code。 */
export function normalizeFleetShipTypeCode(
  value: string,
): string | null {
  const code = value.trim().toLowerCase();
  return CANONICAL_FLEET_SHIP_TYPES.has(code) ? code : null;
}

export function shipTypeLabel(code: string): string {
  const canonical = normalizeFleetShipTypeCode(code);
  return canonical ? TYPE_LABELS[canonical] : code;
}

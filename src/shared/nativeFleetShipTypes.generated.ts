/** 保存由 autowsgr_native 生成的舰种代码，供前端漂移检查。 */
/* 此文件由 scripts/sync-fleet-ship-types.js 生成，禁止手工修改。 */
export const NATIVE_FLEET_SHIP_TYPE_LABELS: Readonly<
  Record<string, string>
> = Object.freeze({
  "aadg": "防驱",
  "ap": "补给",
  "asdg": "导驱",
  "av": "装母",
  "bb": "战列",
  "bbg": "导战",
  "bbv": "航战",
  "bc": "战巡",
  "bg": "大巡",
  "bm": "重炮",
  "ca": "重巡",
  "cav": "航巡",
  "cg": "防巡",
  "cl": "轻巡",
  "clt": "雷巡",
  "cv": "航母",
  "cvl": "轻母",
  "dd": "驱逐",
  "kp": "导巡",
  "sc": "炮潜",
  "ss": "潜艇",
  "ssg": "导潜",
});

export const NATIVE_FLEET_SHIP_TYPE_CODES: readonly string[] =
  Object.freeze(Object.keys(NATIVE_FLEET_SHIP_TYPE_LABELS));

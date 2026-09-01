"""从 autowsgr_native 导出 GUI 和 Wiki 更新器共用的舰种契约。"""

from __future__ import annotations

import json
from types import MappingProxyType

from autowsgr_native.vessel_type import VesselType

CONTRACT_SCHEMA_VERSION = 1


def _discover_native_fleet_types() -> tuple[tuple[str, str], ...]:
    """发现 native 普通舰种；``NO`` 是唯一的大写特殊类型。"""
    vessel_types: list[tuple[str, str]] = []
    for attribute in sorted(name for name in dir(VesselType) if name.isupper()):
        native = getattr(VesselType, attribute)
        code = native.as_english()
        if code == 'NO':
            continue
        if code != attribute or VesselType.from_english(code) != native:
            raise RuntimeError(f'autowsgr_native 舰种契约无效: {attribute}')
        vessel_types.append((code.lower(), native.as_chinese()))
    return tuple(vessel_types)


NATIVE_FLEET_TYPES = _discover_native_fleet_types()
NATIVE_FLEET_TYPE_LABELS = MappingProxyType(dict(NATIVE_FLEET_TYPES))


def canonical_native_fleet_type(value: str) -> str:
    """校验并返回小写 canonical 舰种代码。"""
    code = value.strip().lower()
    if code not in NATIVE_FLEET_TYPE_LABELS:
        allowed = ', '.join(NATIVE_FLEET_TYPE_LABELS)
        raise ValueError(f'不支持的 native 舰种: {value!r}, 可选值: {allowed}')
    return code


def native_fleet_type_contract() -> dict[str, object]:
    """返回 TypeScript 生成器使用的稳定 JSON 契约。"""
    return {
        'schema_version': CONTRACT_SCHEMA_VERSION,
        'source': 'autowsgr_native.vessel_type.VesselType',
        'ship_types': [
            {'code': code, 'label': label}
            for code, label in NATIVE_FLEET_TYPES
        ],
    }


def main() -> None:
    """向标准输出写出 JSON 契约。"""
    print(json.dumps(native_fleet_type_contract(), ensure_ascii=False))


if __name__ == '__main__':
    main()

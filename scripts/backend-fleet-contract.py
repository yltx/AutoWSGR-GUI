"""Evaluate GUI fleet fixtures with the local AutoWSGR backend.

The Node.js contract test writes JSON cases to stdin. Each case contains the
original YAML, the YAML saved by the GUI, and the HTTP request built by the
GUI scheduler. This helper loads the real backend package from the repository
path supplied on the command line.

The three inputs pass through their production boundaries:
1. Original YAML goes through CombatPlan.from_yaml().
2. GUI YAML goes through CombatPlan.from_yaml().
3. HTTP JSON goes through NormalFightRequest and build_fleet_selection().

Only canonical FleetSlotRule data is written to stdout. Backend logs remain on
stderr, so the Node.js caller can parse the result as one JSON document.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any


def _selector_contract(selector: Any) -> dict[str, Any] | None:
    """Convert one backend ShipSelector into stable JSON contract data."""
    if selector is None:
        return None
    return {
        'name': selector.name,
        'search_name': selector.search_name,
        'ship_type': [value.value for value in selector.ship_types],
        'min_level': selector.min_level,
        'max_level': selector.max_level,
        'relaxed': selector.relaxed_constraints,
    }


def _slot_contract(slot: Any) -> dict[str, Any]:
    """Convert one backend FleetSlotRule into stable JSON contract data."""
    return {
        'primary': _selector_contract(slot.primary),
        'candidates': [
            _selector_contract(candidate)
            for candidate in slot.candidates
        ],
    }


def _plan_contract(plan: Any) -> list[dict[str, Any]]:
    """Return the first fleet preset as canonical backend slot rules."""
    if not plan.fleet_presets:
        raise AssertionError('contract plan has no fleet_presets')
    return [_slot_contract(slot) for slot in plan.fleet_presets[0].slots]


def main() -> None:
    """Load contract cases from stdin and write backend results to stdout."""
    if len(sys.argv) != 2:
        raise SystemExit('usage: backend-fleet-contract.py <AutoWSGR repository>')

    backend_root = Path(sys.argv[1]).resolve()
    if not (backend_root / 'autowsgr' / 'server' / 'schemas.py').is_file():
        raise FileNotFoundError(f'invalid AutoWSGR repository: {backend_root}')
    sys.path.insert(0, str(backend_root))

    from autowsgr.combat import CombatPlan
    from autowsgr.server.schemas import NormalFightRequest
    from autowsgr.server.serializers import build_combat_plan, build_fleet_selection

    cases = json.load(sys.stdin)
    results: list[dict[str, Any]] = []
    with TemporaryDirectory(prefix='autowsgr-gui-contract-') as temp:
        temp_root = Path(temp)
        for index, case in enumerate(cases):
            source_path = temp_root / f'{index}-source.yaml'
            gui_path = temp_root / f'{index}-gui.yaml'
            source_path.write_text(case['source_yaml'], encoding='utf-8')
            gui_path.write_text(case['gui_yaml'], encoding='utf-8')

            request = NormalFightRequest.model_validate(case['request'])
            if request.plan is None:
                raise AssertionError('contract request has no plan')
            api_plan = build_combat_plan(request.plan)
            selection = build_fleet_selection(api_plan, request.plan)
            if selection.slot_rules is None:
                raise AssertionError('contract request produced no fleet rules')

            results.append({
                'name': case['name'],
                'source_yaml': _plan_contract(
                    CombatPlan.from_yaml(source_path),
                ),
                'gui_yaml': _plan_contract(
                    CombatPlan.from_yaml(gui_path),
                ),
                'api': [
                    _slot_contract(slot)
                    for slot in selection.slot_rules
                ],
            })

    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main()

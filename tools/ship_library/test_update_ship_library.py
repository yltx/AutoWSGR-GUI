"""Wiki 舰种识别和 native 边界转换测试。"""

from __future__ import annotations

import json
import sqlite3
import unittest
from collections import Counter
from pathlib import Path

from native_fleet_types import NATIVE_FLEET_TYPE_LABELS
from update_ship_library import (
    build_ship_records,
    canonical_wiki_type_code,
    detect_wiki_type_schema,
)


def module_ships(*codes: str) -> dict[int, dict[str, object]]:
    return {
        index: {
            "name": f"测试舰{index}",
            "rarity": 4,
            "type": code,
            "country": "中国",
            "size": "中型",
        }
        for index, code in enumerate(codes, start=1)
    }


def index_html(ship_id: int, type_icon: str) -> str:
    return f"""
    <div style="position: relative">
      <a href="/wiki/test">
        <img src="/M_NORMAL_WEBP/M_NORMAL_{ship_id}.webp">
      </a>
      <img src="/assets/4star_bg.webp">
      <img src="/assets/4star_box.webp">
      <img src="/assets/{type_icon}.webp">
    </div>
    """


class WikiShipTypeTest(unittest.TestCase):
    def test_legacy_schema_converts_old_wiki_codes(self) -> None:
        ships = module_ships("CG", "CGAA", "CBG", "DDG", "DDGAA")

        schema = detect_wiki_type_schema(ships)

        self.assertEqual(schema, "legacy")
        self.assertEqual(canonical_wiki_type_code("CG", schema), "kp")
        self.assertEqual(canonical_wiki_type_code("CGAA", schema), "cg")
        self.assertEqual(canonical_wiki_type_code("CBG", schema), "bg")
        self.assertEqual(canonical_wiki_type_code("DDG", schema), "asdg")
        self.assertEqual(canonical_wiki_type_code("DDGAA", schema), "aadg")

    def test_native_schema_keeps_canonical_cg(self) -> None:
        ships = module_ships("CG", "KP", "BG", "ASDG", "AADG")

        schema = detect_wiki_type_schema(ships)

        self.assertEqual(schema, "native")
        self.assertEqual(canonical_wiki_type_code("CG", schema), "cg")
        self.assertEqual(canonical_wiki_type_code("KP", schema), "kp")

    def test_mixed_or_ambiguous_schema_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "混用了"):
            detect_wiki_type_schema(module_ships("CGAA", "KP"))
        with self.assertRaisesRegex(ValueError, "无法确定"):
            detect_wiki_type_schema(module_ships("CG"))

    def test_lua_type_is_authoritative_and_icon_is_only_an_asset(self) -> None:
        ships = module_ships("CG", "CGAA")
        records = build_ship_records(
            index_html(1, "CG"),
            ships,
            "legacy",
        )

        self.assertEqual(records[0].ship_type_code, "kp")
        self.assertEqual(records[0].type_icon_path, "assets/type-icons/cg.webp")

        with self.assertRaisesRegex(ValueError, "Expected one type icon"):
            build_ship_records(
                index_html(1, "CGAA"),
                ships,
                "legacy",
            )

    def test_cf_is_converted_to_backend_cav(self) -> None:
        self.assertEqual(canonical_wiki_type_code("CF", "legacy"), "cav")
        self.assertEqual(canonical_wiki_type_code("CF", "native"), "cav")

        records = build_ship_records(
            index_html(1, "CF"),
            module_ships("CF"),
            "legacy",
        )
        self.assertEqual(records[0].ship_type_code, "cav")
        self.assertEqual(
            records[0].type_icon_path,
            "assets/type-icons/cf.webp",
        )

    def test_wiki_ship_name_is_corrected_to_game_text(self) -> None:
        ships = module_ships("DD", "DD")
        ships[1]["name"] = "塞尔弗里奇"
        ships[2]["name"] = "塞尔弗里奇·改"
        ships[3]["name"] = "让巴尔"
        ships[4]["name"] = "让巴尔·改"

        records = build_ship_records(
            index_html(1, "DD")
            + index_html(2, "DD")
            + index_html(3, "DD")
            + index_html(4, "DD"),
            ships,
            "native",
        )

        self.assertEqual(
            [record.source_name for record in records],
            ["塞尔弗里奇", "塞尔弗里奇·改", "让巴尔", "让巴尔·改"],
        )
        self.assertEqual(
            [record.display_name_zh for record in records],
            ["赛尔弗里吉", "赛尔弗里吉·改", "让·巴尔", "让·巴尔·改"],
        )
        self.assertEqual(
            [record.search_name for record in records],
            ["赛尔弗里吉", "赛尔弗里吉", "让·巴尔", "让·巴尔"],
        )

    def test_bundled_library_keeps_canonical_types_and_all_assets(self) -> None:
        library_root = Path(__file__).resolve().parents[2] / "resource" / "ship-library"
        manifest = json.loads(
            (library_root / "manifest.json").read_text(encoding="utf-8"),
        )
        labels = json.loads(
            (library_root / "labels.zh-CN.json").read_text(encoding="utf-8"),
        )
        ships = manifest["ships"]
        allowed_types = set(NATIVE_FLEET_TYPE_LABELS)
        manifest_type_counts = Counter(ship["ship_type"] for ship in ships)

        self.assertEqual(manifest["schema_version"], 4)
        self.assertEqual(len(ships), manifest["counts"]["ships"])
        self.assertEqual(set(manifest_type_counts), allowed_types)
        self.assertEqual(
            manifest["labels"]["ship_types"],
            dict(NATIVE_FLEET_TYPE_LABELS),
        )
        self.assertEqual(labels["ship_types"], dict(NATIVE_FLEET_TYPE_LABELS))
        self.assertEqual(
            next(ship["ship_type"] for ship in ships if ship["name"] == "大淀·改"),
            "cav",
        )

        missing_assets = [
            ship[field]
            for ship in ships
            for field in (
                "portrait",
                "background",
                "frame",
                "type_icon",
            )
            if not (library_root / ship[field]).is_file()
        ]
        self.assertEqual(missing_assets, [])

        connection = sqlite3.connect(
            library_root / "database" / "ships.sqlite3",
        )
        try:
            database_type_counts = dict(
                connection.execute(
                    """
                    SELECT ship_type_code, COUNT(*)
                    FROM ships
                    WHERE is_active = 1
                    GROUP BY ship_type_code
                    """,
                ),
            )
            group_type_codes = {
                row[0]
                for row in connection.execute(
                    "SELECT DISTINCT ship_type_code FROM ship_type_groups",
                )
            }
        finally:
            connection.close()

        self.assertEqual(
            database_type_counts,
            dict(manifest_type_counts),
        )
        self.assertLessEqual(group_type_codes, allowed_types)


if __name__ == "__main__":
    unittest.main()

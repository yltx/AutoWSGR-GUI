"""从 AutoWSGR 日志提取舰名 OCR 样本并生成复核报告。

首次提取::

    python tools/ocr_log_analyzer.py ../autowsgr_2026-08-05.debug.log

一次分析多个日志（相同事件会自动去重）::

    python tools/ocr_log_analyzer.py ../*.log --output-dir ocr-log-report

人工填写 ``ocr_review.csv`` 的 ``actual_ship`` 列后重新生成报告和纠错规则::

    python tools/ocr_log_analyzer.py ../*.log \
        --review ocr-log-report/ocr_review.csv \
        --output-dir ocr-log-report

``matcher_result`` 只是程序匹配结果，不是真值。只有人工填写的 ``actual_ship``
才会被视为已确认舰名，并用于检测误匹配和生成 ``ocr_corrections.txt``。
"""

from __future__ import annotations

import argparse
import ast
import csv
import glob
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence


_LOG_LINE_RE = re.compile(
    r"^(?P<timestamp>(?:\d{4}-\d{2}-\d{2}\s+)?"
    r"\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\|\s+"
    r"(?P<level>[A-Z]+)\s+\|\s+"
    r"(?P<logger>[^|]+?)\s+\|\s+"
    r"(?P<message>.*)$",
)
_FILE_DATE_RE = re.compile(r"(?P<date>\d{4}-\d{2}-\d{2})")
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
_OCR_MARKER = "[准备页] 编队 OCR 识别:"
_TARGET_MARKER = "[准备页] 根据主选优先规则确定目标编成:"
_OUTPUT_ENCODING = "utf-8-sig"
_PENDING_REPORT_LIMIT = 15

_OBSERVATION_FIELDS = (
    "event_time",
    "scene",
    "slot",
    "raw_text",
    "patched_text",
    "matcher_result",
    "actual_ship",
    "comparison_status",
    "ground_truth_source",
    "target_slot_hint",
    "target_fleet",
    "source_locations",
)
_REVIEW_FIELDS = (
    "raw_text",
    "patched_text",
    "matcher_result",
    "suggested_ship",
    "actual_ship",
    "count",
    "review_status",
    "target_slot_hints",
    "target_fleets",
    "first_seen",
    "last_seen",
    "source_locations",
)
_SUMMARY_FIELDS = (
    "raw_text",
    "patched_text",
    "matcher_result",
    "actual_ship",
    "comparison_status",
    "count",
    "first_seen",
    "last_seen",
)


@dataclass
class ExtractionStats:
    """日志扫描统计。"""

    files: int = 0
    lines: int = 0
    structured_events: int = 0
    observations: int = 0
    duplicates: int = 0
    parse_errors: int = 0


@dataclass
class Observation:
    """单个舰队槽位的一次 OCR 结果。"""

    event_time: str
    logger: str
    slot: int
    raw_text: str
    patched_text: str
    matcher_result: str
    target_fleet: tuple[str | None, ...] = ()
    source_locations: set[str] = field(default_factory=set)

    @property
    def target_slot_hint(self) -> str:
        """返回同槽目标舰名，仅作为人工复核提示。"""
        if self.slot >= len(self.target_fleet):
            return ""
        return self.target_fleet[self.slot] or ""

    def deduplication_key(self) -> tuple[str, str, int, str, str, str]:
        """生成跨 INFO/DEBUG 日志去重键。"""
        return (
            self.event_time,
            self.logger,
            self.slot,
            self.raw_text,
            self.patched_text,
            self.matcher_result,
        )

    def review_key(self) -> tuple[str, str, str]:
        """生成与人工复核表关联的稳定键。"""
        return (self.raw_text, self.patched_text, self.matcher_result)


@dataclass
class ReviewAggregate:
    """相同 OCR 差异样本的聚合结果。"""

    raw_text: str
    patched_text: str
    matcher_result: str
    actual_ship: str = ""
    count: int = 0
    first_seen: str = ""
    last_seen: str = ""
    target_slot_hints: set[str] = field(default_factory=set)
    target_fleets: set[str] = field(default_factory=set)
    source_locations: set[str] = field(default_factory=set)

    def add(self, observation: Observation) -> None:
        """合并一次观测。"""
        self.count += 1
        if not self.first_seen or observation.event_time < self.first_seen:
            self.first_seen = observation.event_time
        if not self.last_seen or observation.event_time > self.last_seen:
            self.last_seen = observation.event_time
        if observation.target_slot_hint:
            self.target_slot_hints.add(observation.target_slot_hint)
        if observation.target_fleet:
            self.target_fleets.add(_format_fleet(observation.target_fleet))
        self.source_locations.update(observation.source_locations)


@dataclass
class VerifiedShipSummary:
    """按人工确认的真实舰名聚合识别结果。"""

    actual_ship: str
    variants: Counter[tuple[str, str, str]] = field(default_factory=Counter)

    def add(self, observation: Observation) -> None:
        self.variants[
            (
                observation.raw_text,
                observation.patched_text,
                observation.matcher_result,
            )
        ] += 1

    @property
    def count(self) -> int:
        return sum(self.variants.values())

    @property
    def correct_count(self) -> int:
        return sum(
            count
            for (_, _, matcher_result), count in self.variants.items()
            if matcher_result == self.actual_ship
        )

    @property
    def problem_count(self) -> int:
        return self.count - self.correct_count


@dataclass
class AnalysisResult:
    """提取和比对后的完整结果。"""

    observations: list[Observation]
    reviews: dict[tuple[str, str, str], str]
    stats: ExtractionStats
    input_files: list[Path]


def _parse_literal_list(value: str) -> list[object]:
    parsed = ast.literal_eval(value.strip())
    if not isinstance(parsed, list):
        raise TypeError("内容不是列表")
    return parsed


def _file_date(path: Path) -> str:
    match = _FILE_DATE_RE.search(path.name)
    return match.group("date") if match else ""


def _event_time(timestamp: str, path: Path) -> str:
    if re.match(r"^\d{4}-\d{2}-\d{2}\s+", timestamp):
        return timestamp
    date = _file_date(path)
    return f"{date} {timestamp}".strip()


def _display_location(path: Path, line_number: int) -> str:
    return f"{path.name}:{line_number}"


def _parse_target_fleet(payload: str) -> tuple[str | None, ...]:
    values = _parse_literal_list(payload)
    fleet: list[str | None] = []
    for value in values:
        if value is not None and not isinstance(value, str):
            raise TypeError("目标编成包含非文字舰名")
        fleet.append(value)
    return tuple(fleet)


def _parse_ocr_payload(
    payload: str,
    *,
    event_time: str,
    logger: str,
    target_fleet: tuple[str | None, ...],
    source_location: str,
) -> list[Observation]:
    entries = _parse_literal_list(payload)
    observations: list[Observation] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise TypeError("OCR 条目不是字典")
        slot = entry.get("slot")
        raw_text = entry.get("raw")
        patched_text = entry.get("patched")
        matcher_result = entry.get("matched")
        if not isinstance(slot, int) or not isinstance(raw_text, str):
            raise TypeError("OCR 条目缺少合法的 slot/raw")
        if not isinstance(patched_text, str):
            raise TypeError("OCR 条目缺少合法的 patched")
        if matcher_result is not None and not isinstance(matcher_result, str):
            raise TypeError("OCR 条目的 matched 不是文字或 None")
        observations.append(
            Observation(
                event_time=event_time,
                logger=logger,
                slot=slot,
                raw_text=raw_text,
                patched_text=patched_text,
                matcher_result=matcher_result or "",
                target_fleet=target_fleet,
                source_locations={source_location},
            ),
        )
    return observations


def _merge_observation(
    observations: dict[tuple[str, str, int, str, str, str], Observation],
    incoming: Observation,
    stats: ExtractionStats,
) -> None:
    key = incoming.deduplication_key()
    current = observations.get(key)
    if current is None:
        observations[key] = incoming
        return
    current.source_locations.update(incoming.source_locations)
    if not current.target_fleet and incoming.target_fleet:
        current.target_fleet = incoming.target_fleet
    stats.duplicates += 1


def extract_observations(
    paths: Sequence[Path],
) -> tuple[list[Observation], ExtractionStats]:
    """扫描日志并提取准备页结构化 OCR 记录。"""
    stats = ExtractionStats(files=len(paths))
    deduplicated: dict[tuple[str, str, int, str, str, str], Observation] = {}
    for path in paths:
        target_fleet: tuple[str | None, ...] = ()
        with path.open("r", encoding="utf-8-sig", errors="replace") as log_file:
            for line_number, raw_line in enumerate(log_file, start=1):
                stats.lines += 1
                line = _ANSI_RE.sub("", raw_line.rstrip("\r\n"))
                match = _LOG_LINE_RE.match(line)
                if match is None:
                    continue
                message = match.group("message")
                try:
                    if message.startswith(_TARGET_MARKER):
                        target_fleet = _parse_target_fleet(
                            message.removeprefix(_TARGET_MARKER)
                        )
                        continue
                    if not message.startswith(_OCR_MARKER):
                        continue
                    stats.structured_events += 1
                    parsed = _parse_ocr_payload(
                        message.removeprefix(_OCR_MARKER),
                        event_time=_event_time(match.group("timestamp"), path),
                        logger=match.group("logger").strip(),
                        target_fleet=target_fleet,
                        source_location=_display_location(path, line_number),
                    )
                except (SyntaxError, TypeError, ValueError):
                    stats.parse_errors += 1
                    continue
                for observation in parsed:
                    _merge_observation(deduplicated, observation, stats)
    result = sorted(
        deduplicated.values(),
        key=lambda item: (item.event_time, item.slot, item.raw_text),
    )
    stats.observations = len(result)
    return result, stats


def discover_log_files(inputs: Sequence[str]) -> list[Path]:
    """展开文件、目录和 shell 未展开的通配符。"""
    discovered: set[Path] = set()
    for raw_input in inputs:
        expanded = glob.glob(raw_input, recursive=True)
        candidates = (
            [Path(item) for item in expanded] if expanded else [Path(raw_input)]
        )
        for candidate in candidates:
            if candidate.is_dir():
                discovered.update(path.resolve() for path in candidate.rglob("*.log"))
            elif candidate.is_file():
                discovered.add(candidate.resolve())
    return sorted(discovered, key=str)


def load_reviews(path: Path | None) -> dict[tuple[str, str, str], str]:
    """读取人工复核 CSV，空白 actual_ship 不视为真值。"""
    if path is None:
        return {}
    reviews: dict[tuple[str, str, str], str] = {}
    with path.open("r", encoding=_OUTPUT_ENCODING, newline="") as review_file:
        reader = csv.DictReader(review_file)
        required = {"raw_text", "patched_text", "matcher_result", "actual_ship"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            missing = sorted(required.difference(reader.fieldnames or []))
            raise ValueError(f"复核表缺少列: {', '.join(missing)}")
        for row in reader:
            actual_ship = (row.get("actual_ship") or "").strip()
            if not actual_ship:
                continue
            key = (
                (row.get("raw_text") or "").strip(),
                (row.get("patched_text") or "").strip(),
                (row.get("matcher_result") or "").strip(),
            )
            previous = reviews.get(key)
            if previous is not None and previous != actual_ship:
                raise ValueError(f"同一 OCR 样本存在冲突真值: {key[0]}")
            reviews[key] = actual_ship
    return reviews


def _comparison_status(observation: Observation, actual_ship: str) -> str:
    if actual_ship:
        if not observation.matcher_result:
            status = "verified_unmatched"
        elif observation.matcher_result != actual_ship:
            status = "verified_mismatch"
        elif observation.raw_text == actual_ship:
            status = "verified_exact"
        else:
            status = "verified_corrected"
    elif not observation.matcher_result:
        status = "unmatched"
    elif observation.raw_text == observation.matcher_result:
        status = "matcher_exact"
    else:
        status = "matcher_corrected"
    return status


def _review_status(aggregate: ReviewAggregate) -> str:
    if aggregate.actual_ship:
        if not aggregate.matcher_result:
            return "已确认-未匹配"
        if aggregate.matcher_result != aggregate.actual_ship:
            return "已确认-算法误匹配"
        return "已确认-算法匹配正确"
    if not aggregate.matcher_result:
        return "待确认-未匹配"
    if aggregate.raw_text == aggregate.matcher_result:
        return "待确认-原文匹配"
    return "待确认-算法已纠正"


def _format_fleet(fleet: Iterable[str | None]) -> str:
    return json.dumps(list(fleet), ensure_ascii=False, separators=(",", ":"))


def _joined(values: Iterable[str]) -> str:
    return " | ".join(sorted(value for value in values if value))


def _observation_rows(result: AnalysisResult) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for observation in result.observations:
        actual_ship = result.reviews.get(observation.review_key(), "")
        rows.append(
            {
                "event_time": observation.event_time,
                "scene": "fleet_preparation",
                "slot": observation.slot,
                "raw_text": observation.raw_text,
                "patched_text": observation.patched_text,
                "matcher_result": observation.matcher_result,
                "actual_ship": actual_ship,
                "comparison_status": _comparison_status(observation, actual_ship),
                "ground_truth_source": "human_review"
                if actual_ship
                else "matcher_only",
                "target_slot_hint": observation.target_slot_hint,
                "target_fleet": _format_fleet(observation.target_fleet),
                "source_locations": _joined(observation.source_locations),
            },
        )
    return rows


def _aggregate_reviews(
    result: AnalysisResult,
    *,
    include_exact: bool = False,
) -> list[ReviewAggregate]:
    aggregates: dict[tuple[str, str, str], ReviewAggregate] = {}
    for observation in result.observations:
        key = observation.review_key()
        actual_ship = result.reviews.get(key, "")
        needs_review_row = (
            actual_ship
            or not observation.matcher_result
            or observation.raw_text != observation.matcher_result
        )
        if not include_exact and not needs_review_row:
            continue
        aggregate = aggregates.setdefault(
            key,
            ReviewAggregate(
                raw_text=observation.raw_text,
                patched_text=observation.patched_text,
                matcher_result=observation.matcher_result,
                actual_ship=actual_ship,
            ),
        )
        aggregate.add(observation)
    return sorted(
        aggregates.values(),
        key=lambda item: (
            item.actual_ship != "",
            item.matcher_result != "",
            -item.count,
            item.raw_text,
        ),
    )


def _review_rows(result: AnalysisResult) -> list[dict[str, object]]:
    return [
        {
            "raw_text": aggregate.raw_text,
            "patched_text": aggregate.patched_text,
            "matcher_result": aggregate.matcher_result,
            "suggested_ship": aggregate.matcher_result,
            "actual_ship": aggregate.actual_ship,
            "count": aggregate.count,
            "review_status": _review_status(aggregate),
            "target_slot_hints": _joined(aggregate.target_slot_hints),
            "target_fleets": _joined(aggregate.target_fleets),
            "first_seen": aggregate.first_seen,
            "last_seen": aggregate.last_seen,
            "source_locations": _joined(aggregate.source_locations),
        }
        for aggregate in _aggregate_reviews(result, include_exact=True)
    ]


def _verified_ship_summaries(result: AnalysisResult) -> list[VerifiedShipSummary]:
    summaries: dict[str, VerifiedShipSummary] = {}
    for observation in result.observations:
        actual_ship = result.reviews.get(observation.review_key(), "")
        if not actual_ship:
            continue
        summary = summaries.setdefault(
            actual_ship,
            VerifiedShipSummary(actual_ship=actual_ship),
        )
        summary.add(observation)
    return sorted(
        summaries.values(),
        key=lambda item: (-item.problem_count, -item.count, item.actual_ship),
    )


def _pending_review_aggregates(result: AnalysisResult) -> list[ReviewAggregate]:
    return [
        aggregate
        for aggregate in _aggregate_reviews(result)
        if not aggregate.actual_ship
    ]


def _inline_code(value: str) -> str:
    escaped = value.replace("`", "'")
    return f"`{escaped or '（空）'}`"


def _format_recognition_result(
    raw_text: str,
    patched_text: str,
    matcher_result: str,
) -> str:
    parts = [f"OCR {_inline_code(raw_text)}"]
    if patched_text != raw_text:
        parts.append(f"补丁 {_inline_code(patched_text)}")
    if matcher_result:
        parts.append(f"程序结果 {_inline_code(matcher_result)}")
    else:
        parts.append("程序结果 **未匹配**")
    return " → ".join(parts)


def _summary_rows(
    observation_rows: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    aggregates: dict[tuple[str, str, str, str, str], dict[str, object]] = {}
    for row in observation_rows:
        key = (
            str(row["raw_text"]),
            str(row["patched_text"]),
            str(row["matcher_result"]),
            str(row["actual_ship"]),
            str(row["comparison_status"]),
        )
        aggregate = aggregates.setdefault(
            key,
            {
                "raw_text": key[0],
                "patched_text": key[1],
                "matcher_result": key[2],
                "actual_ship": key[3],
                "comparison_status": key[4],
                "count": 0,
                "first_seen": str(row["event_time"]),
                "last_seen": str(row["event_time"]),
            },
        )
        aggregate["count"] = int(aggregate["count"]) + 1
        aggregate["first_seen"] = min(
            str(aggregate["first_seen"]),
            str(row["event_time"]),
        )
        aggregate["last_seen"] = max(
            str(aggregate["last_seen"]), str(row["event_time"])
        )
    return sorted(
        aggregates.values(),
        key=lambda item: (-int(item["count"]), str(item["raw_text"])),
    )


def _write_csv(
    path: Path,
    fieldnames: Sequence[str],
    rows: Sequence[dict[str, object]],
) -> None:
    with path.open("w", encoding=_OUTPUT_ENCODING, newline="") as output_file:
        writer = csv.DictWriter(
            output_file, fieldnames=fieldnames, extrasaction="ignore"
        )
        writer.writeheader()
        writer.writerows(rows)


def _is_unsafe_short_rule(raw_text: str) -> bool:
    value = raw_text.strip()
    return len(value) <= 1 or (len(value) <= 2 and value.isascii())


def _build_corrections(
    result: AnalysisResult,
) -> tuple[list[tuple[str, str]], list[str]]:
    corrections: dict[str, str] = {}
    conflicted: set[str] = set()
    warnings: list[str] = []
    for observation in result.observations:
        actual_ship = result.reviews.get(observation.review_key(), "")
        if not actual_ship or actual_ship in {
            observation.raw_text,
            observation.matcher_result,
        }:
            continue
        if _is_unsafe_short_rule(observation.raw_text):
            warnings.append(
                f"跳过过短规则 '{observation.raw_text}' -> '{actual_ship}'，"
                "当前纠错采用包含匹配，可能误伤其他舰名。",
            )
            continue
        if observation.raw_text in conflicted:
            continue
        previous = corrections.get(observation.raw_text)
        if previous is not None and previous != actual_ship:
            warnings.append(
                f"跳过冲突规则 '{observation.raw_text}': '{previous}' / '{actual_ship}'。",
            )
            corrections.pop(observation.raw_text, None)
            conflicted.add(observation.raw_text)
            continue
        corrections[observation.raw_text] = actual_ship
    return sorted(corrections.items()), sorted(set(warnings))


def _write_corrections(
    path: Path,
    result: AnalysisResult,
) -> tuple[list[tuple[str, str]], list[str]]:
    corrections, warnings = _build_corrections(result)
    lines = [
        "# 仅由人工填写 actual_ship 的未匹配/误匹配样本生成。",
        "# 粘贴到 GUI“识别纠错规则”；冒号两侧空格可省略。",
        *(f"{raw}: {actual}" for raw, actual in corrections),
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    return corrections, warnings


def _write_report(
    path: Path,
    result: AnalysisResult,
    corrections: Sequence[tuple[str, str]],
    warnings: Sequence[str],
) -> None:
    ship_summaries = _verified_ship_summaries(result)
    pending = _pending_review_aggregates(result)
    verified_count = sum(summary.count for summary in ship_summaries)
    verified_problems = sum(summary.problem_count for summary in ship_summaries)
    pending_count = sum(aggregate.count for aggregate in pending)
    input_files = "、".join(
        _inline_code(input_file.name) for input_file in result.input_files
    )
    lines = [
        "# OCR 分析结果",
        "",
        f"- 日志：{input_files}",
        f"- OCR 样本：{result.stats.observations} 次",
        f"- 已确认真实舰名：{len(ship_summaries)} 种，{verified_count} 次",
        f"- 已确认识别问题：{verified_problems} 次",
        f"- 待确认差异：{len(pending)} 种，{pending_count} 次",
        "",
        "## 按真实舰名",
        "",
    ]

    if not ship_summaries:
        lines.extend(
            [
                "当前没有人工确认的真实舰名，不能可靠回答“什么船被识别成了什么”。",
                "请先在 `ocr_review.csv` 的 `actual_ship` 列填写真实舰名。",
            ],
        )
    for summary in ship_summaries:
        lines.extend(
            [
                f"### {summary.actual_ship}：{summary.count} 次"
                f"（正确 {summary.correct_count}，问题 {summary.problem_count}）",
                "",
            ],
        )
        variants = sorted(
            summary.variants.items(),
            key=lambda item: (-item[1], item[0]),
        )
        for (raw_text, patched_text, matcher_result), count in variants:
            verdict = "正确" if matcher_result == summary.actual_ship else "有问题"
            lines.append(
                f"- {count} 次："
                f"{_format_recognition_result(raw_text, patched_text, matcher_result)}"
                f" → **{verdict}**",
            )
        if summary.problem_count:
            lines.append("- 结论：需要处理，具体规则见下方“怎么解决”。")
        else:
            lines.append("- 结论：程序结果与真实舰名一致，无需处理。")
        lines.append("")

    lines.extend(["## 怎么解决", ""])
    if corrections:
        lines.extend(
            [
                "把下面内容直接加入 GUI 的“识别纠错规则”：",
                "",
                "```text",
                *(f"{raw}: {actual}" for raw, actual in corrections),
                "```",
            ],
        )
    elif ship_summaries:
        lines.append("- 当前已确认样本不需要新增安全纠错规则。")
    else:
        lines.append(
            "- 先在 `ocr_review.csv` 的 `actual_ship` 列填写真实舰名，"
            "否则无法判断程序结果是否正确。",
        )
    if warnings:
        lines.extend(
            [
                "",
                "以下问题不能直接生成全局规则：",
                "",
                *[f"- {warning}" for warning in warnings],
            ],
        )

    if pending:
        lines.extend(
            [
                "",
                "## 待确认真实舰名",
                "",
                "优先确认以下高频差异：",
                "",
            ],
        )
        for aggregate in pending[:_PENDING_REPORT_LIMIT]:
            line = (
                f"- {aggregate.count} 次："
                f"{
                    _format_recognition_result(
                        aggregate.raw_text,
                        aggregate.patched_text,
                        aggregate.matcher_result,
                    )
                }"
            )
            hints = _joined(aggregate.target_slot_hints)
            if hints:
                line += f"；候选提示 {_inline_code(hints)}"
            lines.append(line)
        remaining = len(pending) - _PENDING_REPORT_LIMIT
        if remaining > 0:
            lines.append(f"- 其余 {remaining} 种见 `ocr_review.csv`。")
        lines.extend(
            [
                "",
                "重新运行时增加：",
                "",
                "```text",
                "--review ocr-log-report\\ocr_review.csv",
                "```",
            ],
        )

    if not ship_summaries and not pending:
        lines.append("- 当前没有需要复核的差异；如需真值统计，仍需提供人工确认数据。")

    if result.stats.parse_errors:
        lines.extend(
            [
                "",
                f"> 有 {result.stats.parse_errors} 条结构化 OCR 日志解析失败，"
                "请先修复日志格式再判断结果。",
            ],
        )
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_reports(result: AnalysisResult, output_dir: Path) -> list[str]:
    """写出明细、聚合、复核表、纠错规则和 Markdown 摘要。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    observation_rows = _observation_rows(result)
    review_rows = _review_rows(result)
    _write_csv(
        output_dir / "ocr_observations.csv",
        _OBSERVATION_FIELDS,
        observation_rows,
    )
    _write_csv(
        output_dir / "ocr_summary.csv",
        _SUMMARY_FIELDS,
        _summary_rows(observation_rows),
    )
    _write_csv(output_dir / "ocr_review.csv", _REVIEW_FIELDS, review_rows)
    corrections, warnings = _write_corrections(
        output_dir / "ocr_corrections.txt",
        result,
    )
    _write_report(
        output_dir / "ocr_report.md",
        result,
        corrections,
        warnings,
    )
    return warnings


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从 AutoWSGR 日志提取舰名 OCR 差异并生成复核报告",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "logs",
        nargs="+",
        help="日志文件、目录或通配符；目录会递归扫描 *.log",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        default="ocr-log-report",
        help="报告输出目录",
    )
    parser.add_argument(
        "--review",
        help="已填写 actual_ship 的 ocr_review.csv；可与输出文件使用同一路径",
    )
    parser.add_argument(
        "--fail-on-parse-error",
        action="store_true",
        help="发现结构化 OCR 日志损坏时返回非零状态",
    )
    return parser.parse_args(argv)


def _print_console_summary(result: AnalysisResult, output_dir: Path) -> None:
    ship_summaries = _verified_ship_summaries(result)
    pending = _pending_review_aggregates(result)
    corrections, _ = _build_corrections(result)
    print(f"分析日志: {result.stats.files} 个")
    print(f"OCR 样本: {result.stats.observations} 次")
    if ship_summaries:
        print("按真实舰名:")
        for summary in ship_summaries:
            results = "；".join(
                f"{raw_text or '（空）'} -> {matcher_result or '未匹配'} {count} 次"
                for (raw_text, _, matcher_result), count in sorted(
                    summary.variants.items(),
                    key=lambda item: (-item[1], item[0]),
                )
            )
            print(
                f"  {summary.actual_ship}: {summary.count} 次"
                f"（正确 {summary.correct_count}，问题 {summary.problem_count}）；"
                f"{results}",
            )
    elif pending:
        print("当前没有人工确认的真实舰名，请先填写 ocr_review.csv。")
        print("高频待确认:")
        for aggregate in pending[:5]:
            print(
                f"  {aggregate.raw_text or '（空）'} -> "
                f"{aggregate.matcher_result or '未匹配'}: {aggregate.count} 次",
            )

    if corrections:
        print("建议加入 GUI 识别纠错规则:")
        for raw_text, actual_ship in corrections:
            print(f"  {raw_text}: {actual_ship}")
    print(f"待确认差异: {len(pending)} 种 / {sum(item.count for item in pending)} 次")
    if result.stats.parse_errors:
        print(f"结构化记录解析失败: {result.stats.parse_errors}")
    print(f"详细报告: {output_dir / 'ocr_report.md'}")


def main(argv: Sequence[str] | None = None) -> int:
    """CLI 入口。"""
    args = _parse_args(argv)
    log_files = discover_log_files(args.logs)
    if not log_files:
        print("[ERROR] 未找到可读取的日志文件。", file=sys.stderr)
        return 2
    review_path = Path(args.review).resolve() if args.review else None
    if review_path is not None and not review_path.is_file():
        print(f"[ERROR] 复核表不存在: {review_path}", file=sys.stderr)
        return 2
    try:
        reviews = load_reviews(review_path)
    except (OSError, ValueError) as error:
        print(f"[ERROR] 复核表读取失败: {error}", file=sys.stderr)
        return 2

    observations, stats = extract_observations(log_files)
    result = AnalysisResult(
        observations=observations,
        reviews=reviews,
        stats=stats,
        input_files=log_files,
    )
    output_dir = Path(args.output_dir).resolve()
    warnings = write_reports(result, output_dir)

    _print_console_summary(result, output_dir)
    for warning in warnings:
        print(f"[WARN] {warning}")
    if not observations:
        print("[WARN] 未发现准备页结构化 OCR 记录。", file=sys.stderr)
        return 1
    if args.fail_on_parse_error and stats.parse_errors:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

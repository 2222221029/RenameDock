"""重命名引擎：规则流水线预览、冲突检测、物理重命名与撤销。"""

import os
import random
from dataclasses import dataclass, field

from .rules import apply_rule, normalize_rule


@dataclass
class RenameContext:
    """执行单条规则时携带的文件与流水线上下文。"""

    item: dict
    file_index: int
    checked_index: int
    rule_index: int = 0
    serial_counters: dict = field(default_factory=dict)
    rng: random.Random = field(default_factory=random.Random)


def normalize_rules(rules):
    """规范化规则列表，返回 (规范规则列表, 错误列表)。"""

    normalized = []
    errors = []
    for index, rule in enumerate(rules or []):
        if not isinstance(rule, dict):
            errors.append(f"第 {index + 1} 条规则格式错误")
            continue
        normalized_rule, rule_errors = normalize_rule(rule)
        if rule_errors:
            errors.extend(f"第 {index + 1} 条规则：{message}" for message in rule_errors)
            continue
        normalized.append(normalized_rule)
    return normalized, errors


def _set_status(item, new_name, active_rules, manual):
    if not active_rules and not manual:
        item["status"] = "➖ 无规则"
    elif new_name == item["old_name"]:
        item["status"] = "➖ 无变化"
    else:
        item["status"] = "✨ 准备就绪"
    if manual:
        item["status"] = ("✍️ 手动修改准备就绪" if item["status"] == "➖ 无变化"
                          else f"✍️ 手动基底 | {item['status']}")


def preview_file_list(file_list, rules):
    """对文件列表执行实时预览，原地更新 new_name/status/conflict。"""

    normalized_rules, rule_errors = normalize_rules(rules)
    if rule_errors:
        for item in file_list:
            if item.get("checked", True):
                item["new_name"] = ""
                item["status"] = "❌ 规则错误"
                item["conflict"] = False
                item["error"] = "；".join(rule_errors[:3])
        detect_conflicts(file_list)
        return False

    active_rules = [rule for rule in normalized_rules if rule.get("enabled", True)]
    serial_counters = {}
    rng = random.Random()
    checked_index = 0

    for file_index, item in enumerate(file_list):
        item["conflict"] = False
        item["error"] = None
        if not item.get("checked", True):
            item["new_name"] = ""
            item["status"] = "⏸️ 未勾选"
            continue

        base_name = item.get("manual_base_name", item["old_name"])
        base_part, ext_part = os.path.splitext(base_name)
        ctx = RenameContext(
            item=item,
            file_index=file_index,
            checked_index=checked_index,
            serial_counters=serial_counters,
            rng=rng,
        )

        error = None
        for rule_index, rule in enumerate(normalized_rules):
            if not rule.get("enabled", True):
                continue
            ctx.rule_index = rule_index
            try:
                base_part, ext_part = apply_rule(
                    rule["type"], base_part, ext_part, rule["params"], ctx
                )
            except Exception as exc:  # noqa: BLE001 - 预览不能因单文件异常中断
                error = str(exc) or rule["type"]
                break

        checked_index += 1
        if error:
            item["new_name"] = ""
            item["status"] = "❌ 规则错误"
            item["error"] = error
            continue

        item["new_name"] = base_part + ext_part
        _set_status(item, item["new_name"], active_rules, item.get("is_manual", False))

    detect_conflicts(file_list)
    return True


def _casefold(value):
    return value.casefold() if os.name == "nt" else value


def detect_conflicts(file_list):
    """基于目标路径（而非仅文件名）检测冲突。

    同一目录下生成同名文件、或新名称撞上仍在原位未改名的文件时，标记冲突。
    不同目录下同名不算冲突；大小写在 Windows 上视为同一名字。
    """

    duplicate_groups = {}
    for item in file_list:
        if not item.get("checked", True) or not item.get("new_name"):
            continue
        key = (
            _casefold(os.path.dirname(item["path"])),
            _casefold(item["new_name"]),
        )
        duplicate_groups.setdefault(key, []).append(item)

    conflict_ids = set()
    for group in duplicate_groups.values():
        if len(group) > 1:
            conflict_ids.update(id(item) for item in group)

    static_files = {}
    for item in file_list:
        if not item.get("checked", True) or not item.get("new_name"):
            static_files.setdefault(
                (_casefold(os.path.dirname(item["path"])), _casefold(item["old_name"])), []
            ).append(item)
            continue
        if item["new_name"] == item["old_name"]:
            static_files.setdefault(
                (_casefold(os.path.dirname(item["path"])), _casefold(item["old_name"])), []
            ).append(item)

    for item in file_list:
        if not item.get("checked", True) or not item.get("new_name"):
            continue
        if item["new_name"] == item["old_name"]:
            continue
        target_key = (
            _casefold(os.path.dirname(item["path"])),
            _casefold(item["new_name"]),
        )
        if any(id(other) != id(item) for other in static_files.get(target_key, [])):
            conflict_ids.add(id(item))

    for item in file_list:
        item["conflict"] = id(item) in conflict_ids
        if item["conflict"] and item.get("new_name"):
            item["status"] = "❌ 命名冲突"


def perform_rename(file_list, on_progress=None):
    """执行物理重命名，返回统计信息和撤销批次。"""

    ready_count = sum(
        1
        for item in file_list
        if item.get("checked", True) and item.get("new_name") and item["new_name"] != item["old_name"]
    )
    undo_batch = []
    stats = {"success": 0, "conflict_skipped": 0, "failed": 0, "failures": []}

    for item in file_list:
        if not item.get("checked", True) or not item.get("new_name"):
            continue
        if item["new_name"] == item["old_name"]:
            continue

        directory = os.path.dirname(item["path"])
        new_full_path = os.path.join(directory, item["new_name"])
        try:
            target_exists = os.path.exists(new_full_path)
            same_file_case_only = (
                os.path.normcase(item["old_name"]) == os.path.normcase(item["new_name"])
            )
            if target_exists and not same_file_case_only:
                item["status"] = "❌ 命名冲突"
                item["conflict"] = True
                stats["conflict_skipped"] += 1
                continue

            original_path = item["path"]
            os.rename(original_path, new_full_path)
            undo_batch.append((new_full_path, original_path))
            item["path"] = new_full_path
            item["old_name"] = item["new_name"]
            item["status"] = "✅ 成功"
            item["conflict"] = False
            item["is_manual"] = False
            item.pop("manual_base_name", None)
            item.pop("error", None)
            stats["success"] += 1
        except Exception as exc:  # noqa: BLE001 - 单文件失败不能中断整批
            item["status"] = "❌ 重命名失败"
            item["conflict"] = False
            item["error"] = str(exc)
            stats["failed"] += 1
            stats["failures"].append((item, str(exc)))

        if on_progress:
            on_progress(stats["success"], ready_count)

    stats["undo_batch"] = undo_batch
    return stats


def perform_undo(undo_batch, file_list, on_progress=None):
    """撤销一批重命名，失败项会进入 failures 供 UI 提示。"""

    stats = {"reverted": 0, "failed": 0, "failures": []}
    total = len(undo_batch)
    for current_path, original_path in undo_batch:
        try:
            if not os.path.exists(current_path):
                raise OSError("文件不存在，可能已被外部移动或删除")
            os.rename(current_path, original_path)
            for item in file_list:
                if item["path"] == current_path:
                    item["path"] = original_path
                    item["old_name"] = os.path.basename(original_path)
                    item["new_name"] = ""
                    item["status"] = "↩️ 已撤销"
                    item["conflict"] = False
                    item["is_manual"] = False
                    item.pop("manual_base_name", None)
                    item.pop("error", None)
                    break
            stats["reverted"] += 1
        except Exception as exc:  # noqa: BLE001
            stats["failed"] += 1
            stats["failures"].append((current_path, original_path, str(exc)))
        if on_progress:
            on_progress(stats["reverted"], total)
    return stats


__all__ = [
    "RenameContext",
    "normalize_rules",
    "preview_file_list",
    "detect_conflicts",
    "perform_rename",
    "perform_undo",
]


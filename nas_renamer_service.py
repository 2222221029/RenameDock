"""RenameDock NAS-safe scanning, preview, rename and history services."""

from __future__ import annotations

import hashlib
import json
import os
import random
import re
import secrets
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable


PROJECT_DIR = Path(__file__).resolve().parent
from renamer.engine import RenameContext
from renamer.rules import (
    RULE_DEFS,
    RULE_DEFS_MAP,
    apply_rule,
    normalize_rule,
    summarize_rule,
)


INVALID_FILENAME = re.compile(r"[\\/\x00]")
ENHANCED_RULE_DEFS = [
    {
        "type": "Template",
        "label": "变量模板 (Template)",
        "description": "使用日期、时间、大小、哈希和媒体元数据生成名称",
        "fields": [
            {
                "kind": "text",
                "key": "template",
                "label": "名称模板",
                "default": "{name}_{n:03d}",
                "required": True,
            },
        ],
    },
    {
        "type": "Conditional",
        "label": "条件处理 (Conditional)",
        "description": "名称满足正则表达式时执行替换、添加前缀或后缀",
        "fields": [
            {"kind": "text", "key": "pattern", "label": "匹配正则", "required": True},
            {
                "kind": "choice",
                "key": "action",
                "label": "满足条件后",
                "default": "prefix",
                "options": [
                    ("prefix", "添加前缀"),
                    ("suffix", "添加后缀"),
                    ("replace", "文本替换"),
                    ("regex", "正则替换"),
                ],
            },
            {"kind": "text", "key": "text", "label": "前缀/后缀内容", "default": ""},
            {"kind": "text", "key": "find", "label": "查找内容", "default": ""},
            {"kind": "text", "key": "replace", "label": "替换为", "default": ""},
            {"kind": "bool", "key": "ignore_case", "label": "忽略大小写", "default": False},
        ],
    },
]


class ServiceError(Exception):
    """Error safe to return to the Web client."""


def _natural_key(value: str) -> list[Any]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def _media_values(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        from PIL import ExifTags, Image

        with Image.open(path) as image:
            result.update(
                width=str(image.width),
                height=str(image.height),
                format=str(image.format or "").lower(),
            )
            tags = {ExifTags.TAGS.get(key, str(key)): value for key, value in image.getexif().items()}
            for source, target in (
                ("DateTimeOriginal", "taken"),
                ("Make", "camera_make"),
                ("Model", "camera_model"),
                ("Artist", "artist"),
            ):
                if tags.get(source) is not None:
                    result[target] = str(tags[source]).replace("/", "-")
    except Exception:
        pass
    try:
        from mutagen import File as MediaFile

        media = MediaFile(path, easy=True)
        if media and media.tags:
            for source, target in (
                ("title", "title"),
                ("artist", "artist"),
                ("album", "album"),
                ("date", "media_date"),
                ("tracknumber", "track"),
                ("genre", "genre"),
            ):
                if media.tags.get(source):
                    result[target] = str(media.tags[source][0])
            if getattr(media, "info", None):
                result["duration"] = str(int(getattr(media.info, "length", 0)))
    except Exception:
        pass
    try:
        if path.suffix.casefold() == ".pdf":
            from pypdf import PdfReader

            metadata = PdfReader(str(path)).metadata or {}
            for source, target in (("/Title", "title"), ("/Author", "author"), ("/Subject", "subject")):
                if metadata.get(source):
                    result[target] = str(metadata[source])
    except Exception:
        pass
    return result


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class PathGuard:
    """Restrict every operation to explicitly mounted NAS roots."""

    def __init__(self, roots: list[str] | None = None):
        configured = roots or [part for part in os.environ.get("NAS_ROOTS", "").split(os.pathsep) if part]
        if not configured:
            configured = [str(PROJECT_DIR)]
        self.roots = [Path(root).expanduser().resolve() for root in configured]

    def resolve(self, value: str | os.PathLike[str], must_exist: bool = True) -> Path:
        raw = Path(value)
        candidate = raw.resolve(strict=False) if raw.is_absolute() else (self.roots[0] / raw).resolve(strict=False)
        if not any(candidate == root or root in candidate.parents for root in self.roots):
            raise ServiceError("路径不在允许访问的 NAS 挂载目录中")
        if must_exist and not candidate.exists():
            raise ServiceError(f"路径不存在：{candidate}")
        return candidate

    def public_roots(self) -> list[dict[str, str]]:
        return [{"name": root.name or str(root), "path": str(root)} for root in self.roots]


class Scanner:
    def __init__(self, guard: PathGuard):
        self.guard = guard

    def browse(self, value: str) -> dict[str, Any]:
        path = self.guard.resolve(value)
        if not path.is_dir():
            raise ServiceError("只能浏览文件夹")
        entries = []
        try:
            children = sorted(path.iterdir(), key=lambda item: (not item.is_dir(), _natural_key(item.name)))
            for child in children:
                try:
                    if child.is_symlink():
                        continue
                    stat = child.stat()
                    entries.append(
                        {
                            "name": child.name,
                            "path": str(child),
                            "is_dir": child.is_dir(),
                            "size": stat.st_size,
                            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                        }
                    )
                except OSError:
                    continue
        except PermissionError as exc:
            raise ServiceError(f"没有权限读取此目录：{exc}") from exc
        parent = str(path.parent) if path not in self.guard.roots else None
        return {"path": str(path), "parent": parent, "entries": entries}

    def scan(self, options: dict[str, Any]) -> list[dict[str, Any]]:
        base = self.guard.resolve(str(options.get("path", "")))
        if not base.is_dir():
            raise ServiceError("扫描路径必须是文件夹")
        recursive = bool(options.get("recursive", False))
        include_dirs = bool(options.get("include_dirs", False))
        include_hidden = bool(options.get("include_hidden", False))
        iterator = base.rglob("*") if recursive else base.iterdir()
        extensions = {
            value.strip().casefold().lstrip(".")
            for value in str(options.get("extensions", "")).split(",")
            if value.strip()
        }
        try:
            name_pattern = re.compile(str(options.get("name_regex", ""))) if options.get("name_regex") else None
        except re.error as exc:
            raise ServiceError(f"文件名正则无效：{exc}") from exc
        min_size = int(options.get("min_size") or 0)
        max_size = int(options.get("max_size") or 0)
        after = datetime.fromisoformat(options["after"]).timestamp() if options.get("after") else None
        before = datetime.fromisoformat(options["before"]).timestamp() if options.get("before") else None
        items: list[dict[str, Any]] = []
        for path in iterator:
            try:
                if path.is_symlink():
                    continue
                if not include_hidden and any(part.startswith(".") for part in path.relative_to(base).parts):
                    continue
                is_dir = path.is_dir()
                if is_dir and not include_dirs:
                    continue
                if not is_dir and not path.is_file():
                    continue
                stat = path.stat()
                if extensions and (is_dir or path.suffix.casefold().lstrip(".") not in extensions):
                    continue
                if name_pattern and not name_pattern.search(path.name):
                    continue
                if not is_dir and min_size and stat.st_size < min_size:
                    continue
                if not is_dir and max_size and stat.st_size > max_size:
                    continue
                if after and stat.st_mtime < after:
                    continue
                if before and stat.st_mtime > before:
                    continue
                items.append(_item_from_path(path, stat))
            except (OSError, ValueError):
                continue
        sort_by = options.get("sort", "name")
        reverse = bool(options.get("descending", False))
        if sort_by == "size":
            items.sort(key=lambda item: item["size"], reverse=reverse)
        elif sort_by == "modified":
            items.sort(key=lambda item: item["modified"], reverse=reverse)
        else:
            items.sort(key=lambda item: _natural_key(item["path"]), reverse=reverse)
        if options.get("deduplicate"):
            seen: dict[tuple[int, str], str] = {}
            for item in items:
                if item["is_dir"]:
                    continue
                key = (item["size"], _sha256(Path(item["path"])))
                if key in seen:
                    item["duplicate_of"] = seen[key]
                else:
                    seen[key] = item["path"]
        return items


def _item_from_path(path: Path, stat: os.stat_result | None = None) -> dict[str, Any]:
    stat = stat or path.stat()
    return {
        "path": str(path),
        "old_name": path.name,
        "new_name": path.name,
        "checked": True,
        "is_dir": path.is_dir(),
        "size": stat.st_size,
        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "status": "等待预览",
        "conflict": False,
    }


def rule_definitions() -> list[dict[str, Any]]:
    return [*RULE_DEFS, *ENHANCED_RULE_DEFS]


def _normalize_rules(rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = []
    for index, rule in enumerate(rules or []):
        if rule.get("type") in {"Template", "Conditional"}:
            params = dict(rule.get("params") or {})
            if rule["type"] == "Template" and not params.get("template"):
                raise ServiceError(f"第 {index + 1} 条规则：模板不能为空")
            if rule["type"] == "Conditional":
                try:
                    re.compile(str(params.get("pattern", "")))
                except re.error as exc:
                    raise ServiceError(f"第 {index + 1} 条规则：条件正则无效：{exc}") from exc
            normalized.append({"type": rule["type"], "enabled": rule.get("enabled", True), "params": params})
            continue
        normalized_rule, errors = normalize_rule(rule)
        if errors:
            raise ServiceError(f"第 {index + 1} 条规则：{'；'.join(errors)}")
        normalized.append(normalized_rule)
    return normalized


def _template_values(path: Path, base: str, ext: str, index: int) -> dict[str, Any]:
    now = datetime.now()
    stat = path.stat()
    values: dict[str, Any] = {
        "name": base,
        "original": path.stem,
        "ext": ext.lstrip("."),
        "n": index + 1,
        "date": now.strftime("%Y-%m-%d"),
        "time": now.strftime("%H%M%S"),
        "created": datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d"),
        "modified": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d"),
        "accessed": datetime.fromtimestamp(stat.st_atime).strftime("%Y-%m-%d"),
        "created_time": datetime.fromtimestamp(stat.st_ctime).strftime("%H%M%S"),
        "modified_time": datetime.fromtimestamp(stat.st_mtime).strftime("%H%M%S"),
        "accessed_time": datetime.fromtimestamp(stat.st_atime).strftime("%H%M%S"),
        "size": stat.st_size,
        "random": secrets.token_hex(4),
        "uuid": str(uuid.uuid4()),
        "sha256": _sha256(path) if path.is_file() else "",
    }
    if path.is_file():
        values.update(_media_values(path))
    return values


class _OptionalTemplateValues(dict):
    """Missing media tags expand to blank because mixed batches are common."""

    def __missing__(self, _key):
        return ""


def _apply_enhanced(rule: dict[str, Any], base: str, ext: str, path: Path, index: int) -> tuple[str, str]:
    params = rule["params"]
    if rule["type"] == "Template":
        values = _template_values(path, base, ext, index)
        try:
            return str(params["template"]).format_map(_OptionalTemplateValues(values)), ext
        except ValueError as exc:
            raise ServiceError(f"模板格式无效：{exc}") from exc
    flags = re.IGNORECASE if params.get("ignore_case") else 0
    if not re.search(str(params.get("pattern", "")), base, flags):
        return base, ext
    action = params.get("action", "prefix")
    if action == "prefix":
        return str(params.get("text", "")) + base, ext
    if action == "suffix":
        return base + str(params.get("text", "")), ext
    if action == "replace":
        return base.replace(str(params.get("find", "")), str(params.get("replace", ""))), ext
    return re.sub(str(params.get("find", "")), str(params.get("replace", "")), base, flags=flags), ext


def preview(guard: PathGuard, paths: list[str], rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = _normalize_rules(rules)
    output = []
    serial_counters: dict[Any, Any] = {}
    rng = random.Random()
    for index, raw_path in enumerate(paths):
        path = guard.resolve(raw_path)
        item = _item_from_path(path)
        base, ext = os.path.splitext(path.name)
        context = RenameContext(
            item=item,
            file_index=index,
            checked_index=index,
            serial_counters=serial_counters,
            rng=rng,
        )
        try:
            for rule_index, rule in enumerate(normalized):
                if not rule.get("enabled", True):
                    continue
                context.rule_index = rule_index
                if rule["type"] in {"Template", "Conditional"}:
                    base, ext = _apply_enhanced(rule, base, ext, path, index)
                else:
                    base, ext = apply_rule(rule["type"], base, ext, rule["params"], context)
            new_name = base + ext
            validate_filename(new_name)
            item["new_name"] = new_name
            item["status"] = "无变化" if new_name == path.name else "准备就绪"
        except Exception as exc:
            item["new_name"] = ""
            item["status"] = "规则错误"
            item["error"] = str(exc)
        output.append(item)
    _mark_conflicts(output)
    return output


def validate_filename(name: str) -> None:
    if not name or name in {".", ".."} or INVALID_FILENAME.search(name):
        raise ServiceError("目标名称为空或包含路径分隔符")
    if len(name.encode("utf-8")) > 255:
        raise ServiceError("目标名称超过文件系统常见的 255 字节限制")


def _mark_conflicts(items: list[dict[str, Any]]) -> None:
    targets: dict[str, list[dict[str, Any]]] = {}
    sources = {str(Path(item["path"]).resolve()).casefold() for item in items}
    for item in items:
        if not item.get("new_name"):
            continue
        target = str(Path(item["path"]).with_name(item["new_name"]).resolve()).casefold()
        targets.setdefault(target, []).append(item)
        if Path(item["path"]).with_name(item["new_name"]).exists() and target not in sources:
            item["conflict"] = True
            item["status"] = "目标已存在"
    for group in targets.values():
        if len(group) > 1:
            for item in group:
                item["conflict"] = True
                item["status"] = "命名冲突"


@dataclass
class Job:
    id: str
    state: str = "queued"
    total: int = 0
    completed: int = 0
    message: str = "等待执行"
    result: dict[str, Any] | None = None
    error: str | None = None
    pause_event: threading.Event = field(default_factory=threading.Event, repr=False)
    cancel_event: threading.Event = field(default_factory=threading.Event, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "message": self.message,
            "result": self.result,
            "error": self.error,
        }


class HistoryStore:
    def __init__(self, config_dir: Path):
        self.path = config_dir / "history.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def load(self) -> list[dict[str, Any]]:
        with self.lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                return data if isinstance(data, list) else []
            except (OSError, json.JSONDecodeError):
                return []

    def add(self, pairs: list[tuple[Path, Path]]) -> dict[str, Any]:
        batch = {
            "id": uuid.uuid4().hex,
            "time": datetime.now().isoformat(timespec="seconds"),
            "undone": False,
            "items": [{"source": str(source), "target": str(target)} for source, target in pairs],
        }
        with self.lock:
            history = self.load_unlocked()
            history.insert(0, batch)
            self.path.write_text(json.dumps(history[:100], ensure_ascii=False, indent=2), encoding="utf-8")
        return batch

    def load_unlocked(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def mark_undone(self, batch_id: str) -> None:
        with self.lock:
            history = self.load_unlocked()
            for batch in history:
                if batch.get("id") == batch_id:
                    batch["undone"] = True
                    break
            self.path.write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")


class RenameManager:
    def __init__(self, guard: PathGuard, history: HistoryStore):
        self.guard = guard
        self.history = history
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.operation_lock = threading.Lock()

    def start(self, items: list[dict[str, Any]], conflict: str) -> Job:
        if conflict not in {"error", "skip", "auto", "overwrite"}:
            raise ServiceError("未知的冲突策略")
        job = Job(id=uuid.uuid4().hex, total=len(items))
        job.pause_event.set()
        with self.lock:
            if any(entry.state in {"queued", "running", "paused"} for entry in self.jobs.values()):
                raise ServiceError("已有重命名任务正在运行，请等待其完成")
            if len(self.jobs) > 100:
                self.jobs = {
                    key: value for key, value in list(self.jobs.items())[-50:]
                    if value.state in {"queued", "running", "paused"}
                }
            self.jobs[job.id] = job
        thread = threading.Thread(target=self._worker, args=(job, items, conflict), daemon=True)
        thread.start()
        return job

    def get(self, job_id: str) -> Job:
        with self.lock:
            job = self.jobs.get(job_id)
        if not job:
            raise ServiceError("任务不存在或服务已重启")
        return job

    def pause(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.state == "running":
            job.pause_event.clear()
            job.state = "paused"
            job.message = "已暂停"
        return job

    def resume(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.state == "paused":
            job.state = "running"
            job.message = "正在执行"
            job.pause_event.set()
        return job

    def cancel(self, job_id: str) -> Job:
        job = self.get(job_id)
        if job.state in {"queued", "running", "paused"}:
            job.cancel_event.set()
            job.pause_event.set()
            job.message = "正在安全取消"
        return job

    def _worker(self, job: Job, items: list[dict[str, Any]], conflict: str) -> None:
        job.state = "running"
        job.message = "正在校验并暂存文件"
        try:
            pairs = self._prepare_pairs(items, conflict)
            job.total = len(pairs)

            def progress(done: int, message: str) -> None:
                job.completed = done
                job.message = message

            with self.operation_lock:
                completed = self._run_pairs(pairs, job.pause_event, job.cancel_event, progress)
            if job.cancel_event.is_set() and not completed:
                job.state = "cancelled"
                job.message = "已取消，文件已恢复原状"
                return
            try:
                batch = self.history.add(completed)
                history_warning = None
            except OSError as exc:
                batch = None
                history_warning = f"文件已改名，但历史记录保存失败：{exc}"
            job.completed = len(completed)
            job.result = {"batch": batch, "renamed": len(completed), "history_warning": history_warning}
            job.state = "completed"
            job.message = history_warning or f"已完成 {len(completed)} 项重命名"
        except Exception as exc:
            job.state = "failed"
            job.error = str(exc)
            job.message = "执行失败，已尝试恢复原状"

    def _prepare_pairs(self, items: list[dict[str, Any]], conflict: str) -> list[tuple[Path, Path]]:
        candidates: list[tuple[Path, Path]] = []
        sources: set[Path] = set()
        for item in items:
            if not item.get("checked", True) or not item.get("new_name"):
                continue
            source = self.guard.resolve(item["path"])
            validate_filename(str(item["new_name"]))
            target = self.guard.resolve(source.with_name(str(item["new_name"])), must_exist=False)
            if source == target:
                continue
            candidates.append((source, target))
            sources.add(source)
        for source, _ in candidates:
            if any(other != source and other in source.parents for other in sources):
                raise ServiceError("不能在同一批次中同时重命名父文件夹及其内部项目，请分两批执行")
        result: list[tuple[Path, Path]] = []
        reserved: set[Path] = set()
        for source, target in candidates:
            external_collision = target.exists() and target not in sources
            duplicate = target in reserved
            if external_collision or duplicate:
                if conflict == "skip":
                    continue
                if conflict == "error":
                    raise ServiceError(f"目标已存在或重复：{target}")
                if conflict == "auto":
                    stem, suffix = target.stem, target.suffix
                    counter = 1
                    while target.exists() or target in reserved:
                        target = target.with_name(f"{stem} ({counter}){suffix}")
                        counter += 1
                elif duplicate:
                    raise ServiceError(f"覆盖模式无法处理同批次重复目标：{target}")
            reserved.add(target)
            result.append((source, target))
        return result

    @staticmethod
    def _run_pairs(
        pairs: list[tuple[Path, Path]],
        pause_event: threading.Event,
        cancel_event: threading.Event,
        progress: Callable[[int, str], None],
    ) -> list[tuple[Path, Path]]:
        staged: list[tuple[Path, Path, Path]] = []
        backups: list[tuple[Path, Path]] = []
        committed: list[tuple[Path, Path]] = []
        source_set = {source for source, _ in pairs}
        try:
            for index, (source, target) in enumerate(pairs):
                pause_event.wait()
                if cancel_event.is_set():
                    break
                if target.exists() and target != source and target not in source_set:
                    backup = target.with_name(f".__renamedock_backup_{uuid.uuid4().hex}")
                    target.rename(backup)
                    backups.append((backup, target))
                temporary = source.with_name(f".__renamedock_stage_{uuid.uuid4().hex}")
                source.rename(temporary)
                staged.append((temporary, source, target))
                progress(index + 1, f"正在暂存 {index + 1}/{len(pairs)}")
            if cancel_event.is_set():
                for temporary, source, _ in reversed(staged):
                    if temporary.exists():
                        temporary.rename(source)
                for backup, target in reversed(backups):
                    if backup.exists():
                        backup.rename(target)
                return []
            for index, (temporary, source, target) in enumerate(staged):
                temporary.rename(target)
                committed.append((source, target))
                progress(index + 1, f"正在提交 {index + 1}/{len(staged)}")
            for backup, _ in backups:
                try:
                    if backup.is_dir():
                        import shutil

                        shutil.rmtree(backup)
                    elif backup.exists():
                        backup.unlink()
                except OSError:
                    # The rename is already committed.  Leaving a hidden backup is
                    # safer than reporting a false rollback after an overwrite.
                    pass
            return committed
        except Exception:
            for source, target in reversed(committed):
                if target.exists() and not source.exists():
                    target.rename(source)
            for temporary, source, _ in reversed(staged):
                if temporary.exists() and not source.exists():
                    temporary.rename(source)
            for backup, target in reversed(backups):
                if backup.exists() and not target.exists():
                    backup.rename(target)
            raise

    def undo(self, batch_id: str) -> dict[str, Any]:
        history = self.history.load()
        batch = next((entry for entry in history if entry.get("id") == batch_id), None)
        if not batch:
            raise ServiceError("历史批次不存在")
        if batch.get("undone"):
            raise ServiceError("此批次已经撤销")
        batch_items = list(reversed(batch.get("items", [])))
        current_paths = {self.guard.resolve(item["target"]) for item in batch_items}
        pairs = []
        for item in batch_items:
            current = self.guard.resolve(item["target"])
            original = self.guard.resolve(item["source"], must_exist=False)
            if original.exists() and original not in current_paths:
                raise ServiceError(f"无法撤销，原路径已被占用：{original}")
            pairs.append((current, original))
        pause = threading.Event()
        pause.set()
        with self.operation_lock:
            completed = self._run_pairs(pairs, pause, threading.Event(), lambda *_: None)
        self.history.mark_undone(batch_id)
        return {"reverted": len(completed)}


class PresetStore:
    def __init__(self, config_dir: Path):
        self.path = config_dir / "presets.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def load(self) -> dict[str, Any]:
        with self.lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                return data if isinstance(data, dict) else {}
            except (OSError, json.JSONDecodeError):
                return {}

    def save(self, name: str, rules: list[dict[str, Any]]) -> None:
        if not name.strip():
            raise ServiceError("方案名称不能为空")
        _normalize_rules(rules)
        with self.lock:
            data: dict[str, Any]
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    data = {}
            except (OSError, json.JSONDecodeError):
                data = {}
            data[name.strip()] = rules
            self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def delete(self, name: str) -> None:
        with self.lock:
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                data = {}
            if isinstance(data, dict):
                data.pop(name, None)
                self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def rule_summary(rule: dict[str, Any]) -> str:
    if rule.get("type") == "Template":
        return f"变量模板：{rule.get('params', {}).get('template', '')}"
    if rule.get("type") == "Conditional":
        return f"条件：/{rule.get('params', {}).get('pattern', '')}/"
    try:
        return summarize_rule(rule)
    except Exception:
        return str(rule.get("type", "未知规则"))


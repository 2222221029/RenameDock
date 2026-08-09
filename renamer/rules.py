"""规则定义、参数规范化与执行逻辑。

规则类型与 ReNamer 官方规则清单对应；每条规则对“主名 + 扩展名”模型操作，
与经典 ReNamer 的“文件名 + 扩展名”处理方式保持一致。
"""

import re
from datetime import datetime

from .utils import cleanup_name, transliterate


class RuleError(Exception):
    """规则执行期错误。"""


RULE_TYPES = [
    "Insert",
    "Delete",
    "Remove",
    "Replace",
    "Rearrange",
    "Extension",
    "Strip",
    "Case",
    "Serialize",
    "Randomize",
    "Padding",
    "CleanUp",
    "Translit",
    "RegEx",
    "ReformatDate",
    "UserInput",
]

# 旧版中文明细 -> 新版规范类型
LEGACY_TYPE_MAP = {
    "替换文本": "Replace",
    "移除文本": "Remove",
    "插入字符": "Insert",
    "删除固定位置": "Delete",
    "大小写转换": "Case",
    "剥离/清理": "Strip",
    "添加序号": "Serialize",
    "修改扩展名": "Extension",
    "正则表达式": "RegEx",
}


def _choice(key, label, values, default):
    return {"kind": "choice", "key": key, "label": label, "options": values, "default": default}


def _int(default, **kwargs):
    field = {"kind": "int", "default": default}
    field.update(kwargs)
    return field


def _text(label, required=False, default="", **kwargs):
    field = {"kind": "text", "label": label, "required": required, "default": default}
    field.update(kwargs)
    return field


def _bool(label, default=False, **kwargs):
    field = {"kind": "bool", "label": label, "default": default}
    field.update(kwargs)
    return field


RULE_DEFS = [
    {
        "type": "Insert",
        "label": "插入 (Insert)",
        "fields": [
            _text("插入内容", required=True, key="text"),
            {"kind": "choice", "key": "position",
                "label": "插入位置",
                "options": [
                    ("prefix", "作为前缀（开头）"),
                    ("suffix", "作为后缀（结尾）"),
                    ("index", "指定索引（从左）"),
                    ("index_from_right", "指定索引（从右）"),
                    ("before_text", "指定文本之前"),
                    ("after_text", "指定文本之后"),
                ],
                "default": "prefix"},
            _int(1, label="索引（首字符为 1）", key="index",
                 visible_when={"position": ["index", "index_from_right"]}),
            _text("定位文本", key="anchor",
                  visible_when={"position": ["before_text", "after_text"]}),
            _int(1, label="第几次出现", key="occurrence",
                 visible_when={"position": ["before_text", "after_text"]}),
        ],
    },
    {
        "type": "Delete",
        "label": "删除 (Delete)",
        "fields": [
            {"kind": "choice", "key": "mode", "label": "删除方式",
                "options": [
                    ("delete_range", "删除指定范围"),
                    ("delete_to_end", "删除到结尾"),
                    ("delete_before_delimiter", "删除分隔文本之前"),
                    ("delete_after_delimiter", "删除分隔文本之后"),
                ],
                "default": "delete_range"},
            _int(1, label="起始索引（首字符为 1）", key="start",
                 visible_when={"mode": ["delete_range", "delete_to_end"]}),
            _int(1, label="删除长度", key="count", visible_when={"mode": ["delete_range"]}),
            _text("分隔文本", key="delimiter",
                  visible_when={"mode": ["delete_before_delimiter", "delete_after_delimiter"]}),
            _int(1, label="第几次出现", key="occurrence",
                 visible_when={"mode": ["delete_before_delimiter", "delete_after_delimiter"]}),
            _choice("direction", "处理方向", [("ltr", "从左往右"), ("rtl", "从右往左")], "ltr"),
        ],
    },
    {
        "type": "Remove",
        "label": "移除 (Remove)",
        "fields": [
            _text("要移除的文本", required=True, key="text"),
            _choice("mode", "移除方式", [("all", "全部"), ("first", "第一个"), ("last", "最后一个")], "all"),
            _bool("启用通配符 (* 和 ?)", key="wildcard"),
        ],
    },
    {
        "type": "Replace",
        "label": "替换 (Replace)",
        "fields": [
            _choice("mode", "替换方式", [("all", "全部"), ("first", "第一个"), ("last", "最后一个")], "all"),
            {"kind": "multiline", "label": "查找 => 替换（每行一对）", "key": "pairs_text",
             "height": 90},
        ],
    },
    {
        "type": "Rearrange",
        "label": "重排 (Rearrange)",
        "fields": [
            _text("分隔文本（留空表示按单个字符拆分）", key="delimiter", default=" "),
            _text("顺序（逗号分隔，1 开头，负数从右数）", required=True, key="parts", default="1"),
            _text("连接符", key="separator", default=" "),
        ],
    },
    {
        "type": "Extension",
        "label": "扩展名 (Extension)",
        "fields": [
            _choice(
                "mode",
                "操作模式",
                [
                    ("set", "修改为新扩展名"),
                    ("remove", "彻底删除扩展名"),
                    ("lower", "转为小写"),
                    ("upper", "转为大写"),
                ],
                "set",
            ),
            _text("新扩展名（不需要加点）", key="extension",
                  visible_when={"mode": ["set"]}),
        ],
    },
    {
        "type": "Strip",
        "label": "清理字符 (Strip)",
        "fields": [
            _bool("删除所有数字", key="digits"),
            _bool("删除所有字母", key="letters"),
            _bool("删除所有空白字符", key="spaces"),
            _bool("删除标点和特殊字符", key="symbols"),
            _bool("删除括号字符", key="brackets"),
            _bool("同时处理扩展名", key="apply_to_extension"),
            _text("自定义字符（可选）", key="custom_chars"),
        ],
    },
    {
        "type": "Case",
        "label": "大小写 (Case)",
        "fields": [
            _choice(
                "mode",
                "转换模式",
                [
                    ("lower", "全部小写"),
                    ("upper", "全部大写"),
                    ("title", "单词首字母大写"),
                    ("sentence", "句子首字母大写"),
                    ("invert", "反转大小写"),
                ],
                "lower",
            ),
        ],
    },
    {
        "type": "Serialize",
        "label": "添加序号 (Serialize)",
        "fields": [
            _int(1, label="起始数字", key="start"),
            _int(1, label="步长", key="step"),
            _int(3, label="补零位数（0 表示不补零）", key="pad"),
            _choice("position", "序号位置",
                    [("prefix", "作为前缀（开头）"), ("suffix", "作为后缀（结尾）")], "prefix"),
            _text("分隔符（可留空）", key="separator"),
        ],
    },
    {
        "type": "Randomize",
        "label": "随机文本 (Randomize)",
        "fields": [
            _choice(
                "mode",
                "随机类型",
                [
                    ("letters", "字母"),
                    ("digits", "数字"),
                    ("alphanumeric", "字母和数字"),
                    ("hex", "十六进制"),
                ],
                "digits",
            ),
            _int(4, label="长度", key="length"),
            _choice("position", "插入位置",
                    [("prefix", "作为前缀（开头）"), ("suffix", "作为后缀（结尾）")], "prefix"),
            _bool("使用大写字母", key="uppercase"),
        ],
    },
    {
        "type": "Padding",
        "label": "数字补零 (Padding)",
        "fields": [
            _choice("mode", "补零方式",
                    [("pad_numbers", "数字补位"), ("remove_padding", "移除前导补位")], "pad_numbers"),
            _int(3, label="目标位数", key="length"),
            _text("填充字符", key="char", default="0"),
            _choice("direction", "补位方向", [("left", "左侧"), ("right", "右侧")], "left"),
        ],
    },
    {
        "type": "CleanUp",
        "label": "清理命名 (Clean Up)",
        "fields": [
            _bool("删除括号及其内容", key="remove_brackets", default=True),
            _bool("合并连续空白", key="collapse_spaces", default=True),
            _bool("去除首尾空白", key="trim", default=True),
            _bool("去除开头的点", key="remove_leading_dots", default=True),
            _bool("去除开头的 www.", key="remove_www"),
        ],
    },
    {
        "type": "Translit",
        "label": "转写 (Translit)",
        "fields": [
            {"kind": "info", "label": "将常见非英文字母（重音、西里尔、希腊）转写为拉丁字母"},
        ],
    },
    {
        "type": "RegEx",
        "label": "正则表达式 (RegEx)",
        "fields": [
            _text("正则表达式", required=True, key="pattern"),
            _text("替换为", key="replace"),
            _choice("mode", "替换方式", [("all", "全部"), ("first", "第一个"), ("last", "最后一个")], "all"),
            _bool("忽略大小写", key="ignore_case"),
        ],
    },
    {
        "type": "ReformatDate",
        "label": "日期格式化 (Reformat Date)",
        "fields": [
            {"kind": "choice", "key": "source", "label": "原日期格式",
                "options": [
                    ("YYYY-MM-DD", "YYYY-MM-DD"),
                    ("DD-MM-YYYY", "DD-MM-YYYY"),
                    ("MM-DD-YYYY", "MM-DD-YYYY"),
                    ("YYYY/MM/DD", "YYYY/MM/DD"),
                    ("DD/MM/YYYY", "DD/MM/YYYY"),
                    ("DD.MM.YYYY", "DD.MM.YYYY"),
                ],
                "default": "YYYY-MM-DD"},
            {"kind": "choice", "key": "target", "label": "新日期格式",
                "options": [
                    ("YYYY-MM-DD", "YYYY-MM-DD"),
                    ("YYYYMMDD", "YYYYMMDD"),
                    ("DD-MM-YYYY", "DD-MM-YYYY"),
                    ("YYYY年MM月DD日", "YYYY年MM月DD日"),
                    ("MM/DD/YYYY", "MM/DD/YYYY"),
                ],
                "default": "YYYY-MM-DD"},
            _bool("只替换第一个", key="first_only"),
        ],
    },
    {
        "type": "UserInput",
        "label": "手动名称列表 (User Input)",
        "fields": [
            {"kind": "multiline", "label": "新名称（每行一个，按文件顺序使用）", "key": "names",
             "height": 120},
        ],
    },
]

RULE_DEFS_MAP = {definition["type"]: definition for definition in RULE_DEFS}


_CHOICE_VALUES = {}
for _definition in RULE_DEFS:
    for _field in _definition["fields"]:
        if _field["kind"] == "choice":
            _CHOICE_VALUES[(_definition["type"], _field["key"])] = {
                value: label for value, label in _field["options"]
            }


def _normalize_legacy_params(rule_type, raw):
    """把旧版中文参数名迁移到规范参数名。"""

    params = dict(raw or {})
    if rule_type == "Insert":
        position_map = {
            "作为前缀 (开头)": "prefix",
            "作为后缀 (结尾)": "suffix",
            "指定索引(从左)": "index",
            "指定索引(从右)": "index_from_right",
        }
        if "pos" in params:
            params["position"] = position_map.get(params.pop("pos"), "prefix")
    elif rule_type == "Delete":
        if "start" in params and "count" in params:
            params.setdefault("mode", "delete_range")
    elif rule_type == "Remove":
        if "remove_text" in params:
            params["text"] = params.pop("remove_text")
    elif rule_type == "Replace":
        if "find" in params:
            find = params.get("find", "")
            replace = params.get("replace", "")
            params["pairs_text"] = f"{find} => {replace}"
            params.pop("find", None)
            params.pop("replace", None)
    elif rule_type == "RegEx":
        pass
    elif rule_type == "Case":
        mode_map = {
            "全部小写 (lowercase)": "lower",
            "全部大写 (UPPERCASE)": "upper",
            "首字母大写 (Capitalize)": "sentence",
            "单词首字母大写 (Title Case)": "title",
        }
        if "mode" in params:
            params["mode"] = mode_map.get(params["mode"], params["mode"])
    elif rule_type == "Strip":
        char_sets = list(params.pop("char_sets", []))
        if params.pop("digits", False):
            char_sets.append("digits")
        if params.pop("letters", False):
            char_sets.append("letters")
        if params.pop("spaces", False):
            char_sets.append("spaces")
        if params.pop("symbols", False):
            char_sets.append("symbols")
        params["char_sets"] = char_sets
    elif rule_type == "Serialize":
        pos_map = {"作为前缀 (开头)": "prefix", "作为后缀 (结尾)": "suffix"}
        if "pos" in params:
            params["position"] = pos_map.get(params.pop("pos"), "prefix")
    elif rule_type == "Extension":
        mode_map = {
            "修改为新扩展名": "set",
            "转为小写": "lower",
            "转为大写": "upper",
            "彻底删除扩展名": "remove",
        }
        if "mode" in params:
            params["mode"] = mode_map.get(params["mode"], params["mode"])
            if "new_ext" in params:
                params["extension"] = params.pop("new_ext")
    return params


def _parse_pairs(raw):
    pairs = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                pairs.append({"find": str(item.get("find", "")), "replace": str(item.get("replace", ""))})
            else:
                pairs.append({"find": str(item), "replace": ""})
        return pairs
    for line in str(raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if "=>" in line:
            find, _, replace = line.partition("=>")
            pairs.append({"find": find.strip(), "replace": replace.strip()})
        else:
            pairs.append({"find": line, "replace": ""})
    return pairs


def normalize_params(rule_type, raw_params):
    """规范化并校验一条规则的参数，返回 (params, errors)。"""

    params = _normalize_legacy_params(rule_type, dict(raw_params or {}))
    errors = []

    def get_int(key, default):
        value = params.get(key, default)
        try:
            return int(value)
        except (TypeError, ValueError):
            errors.append(f"参数 {key} 必须是整数")
            return default

    def get_text(key, default=""):
        value = params.get(key, default)
        return str(value) if value is not None else default

    def get_choice(key, options, default):
        value = params.get(key, default)
        if value not in options:
            errors.append(f"参数 {key} 的值无效")
            return default
        return value

    if rule_type == "Insert":
        text = get_text("text")
        if not text:
            errors.append("插入内容不能为空")
        position = get_choice("position", ["prefix", "suffix", "index", "index_from_right",
                                           "before_text", "after_text"], "prefix")
        if position in ("before_text", "after_text") and not get_text("anchor"):
            errors.append("定位文本不能为空")
        params = {
            "text": text,
            "position": position,
            "index": get_int("index", 1),
            "anchor": get_text("anchor"),
            "occurrence": max(1, get_int("occurrence", 1)),
        }
    elif rule_type == "Delete":
        delimiter = get_text("delimiter")
        mode = get_choice("mode", ["delete_range", "delete_to_end",
                                   "delete_before_delimiter", "delete_after_delimiter"],
                          "delete_range")
        if mode in ("delete_before_delimiter", "delete_after_delimiter") and not delimiter:
            errors.append("分隔文本不能为空")
        params = {
            "mode": mode,
            "start": max(1, get_int("start", 1)),
            "count": max(0, get_int("count", 1)),
            "delimiter": delimiter,
            "occurrence": max(1, get_int("occurrence", 1)),
            "direction": get_choice("direction", ["ltr", "rtl"], "ltr"),
        }
    elif rule_type == "Remove":
        text = get_text("text")
        if not text:
            errors.append("要移除的文本不能为空")
        params = {
            "text": text,
            "mode": get_choice("mode", ["all", "first", "last"], "all"),
            "wildcard": bool(params.get("wildcard", False)),
        }
    elif rule_type == "Replace":
        raw_pairs = params.get("pairs", params.get("pairs_text", ""))
        pairs = _parse_pairs(raw_pairs)
        if not pairs or not any(pair["find"] for pair in pairs):
            errors.append("至少需要一条“查找 => 替换”规则")
        params = {
            "pairs": pairs,
            "mode": get_choice("mode", ["all", "first", "last"], "all"),
        }
    elif rule_type == "Rearrange":
        try:
            parts = [int(part.strip()) for part in str(params.get("parts", "1")).split(",") if part.strip()]
        except ValueError:
            parts = []
            errors.append("顺序必须是用逗号分隔的整数")
        if not parts:
            errors.append("顺序不能为空")
        params = {
            "delimiter": get_text("delimiter", " "),
            "parts": parts,
            "separator": get_text("separator", " "),
        }
    elif rule_type == "Extension":
        mode = get_choice("mode", ["set", "remove", "lower", "upper"], "set")
        extension = get_text("extension").strip().lstrip(".")
        if mode == "set" and not extension:
            errors.append("新扩展名不能为空")
        params = {"mode": mode, "extension": extension}
    elif rule_type == "Strip":
        char_sets = list(params.get("char_sets", []))
        for key in ("digits", "letters", "spaces", "symbols", "brackets"):
            if params.get(key):
                char_sets.append(key)
        valid_sets = ["digits", "letters", "spaces", "symbols", "brackets"]
        char_sets = [item for item in char_sets if item in valid_sets]
        params = {
            "char_sets": char_sets,
            "apply_to_extension": bool(params.get("apply_to_extension", False)),
            "custom_chars": get_text("custom_chars"),
        }
    elif rule_type == "Case":
        params = {"mode": get_choice("mode", ["lower", "upper", "title", "sentence", "invert"], "lower")}
    elif rule_type == "Serialize":
        params = {
            "start": get_int("start", 1),
            "step": get_int("step", 1),
            "pad": max(0, get_int("pad", 3)),
            "position": get_choice("position", ["prefix", "suffix"], "prefix"),
            "separator": get_text("separator"),
        }
    elif rule_type == "Randomize":
        params = {
            "mode": get_choice("mode", ["letters", "digits", "alphanumeric", "hex"], "digits"),
            "length": max(1, get_int("length", 4)),
            "position": get_choice("position", ["prefix", "suffix"], "prefix"),
            "uppercase": bool(params.get("uppercase", False)),
        }
    elif rule_type == "Padding":
        char = get_text("char", "0") or "0"
        if len(char) != 1:
            errors.append("填充字符只能是一个字符")
        params = {
            "mode": get_choice("mode", ["pad_numbers", "remove_padding"], "pad_numbers"),
            "length": max(1, get_int("length", 3)),
            "char": char,
            "direction": get_choice("direction", ["left", "right"], "left"),
        }
    elif rule_type == "CleanUp":
        params = {
            "remove_brackets": bool(params.get("remove_brackets", True)),
            "collapse_spaces": bool(params.get("collapse_spaces", True)),
            "trim": bool(params.get("trim", True)),
            "remove_leading_dots": bool(params.get("remove_leading_dots", True)),
            "remove_www": bool(params.get("remove_www", False)),
        }
    elif rule_type == "Translit":
        params = {}
    elif rule_type == "RegEx":
        pattern = get_text("pattern")
        try:
            re.compile(pattern)
        except re.error as exc:
            errors.append(f"正则表达式语法错误：{exc}")
        params = {
            "pattern": pattern,
            "replace": get_text("replace"),
            "mode": get_choice("mode", ["all", "first", "last"], "all"),
            "ignore_case": bool(params.get("ignore_case", False)),
        }
    elif rule_type == "ReformatDate":
        params = {
            "source": get_choice("source", ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY",
                                            "YYYY/MM/DD", "DD/MM/YYYY", "DD.MM.YYYY"], "YYYY-MM-DD"),
            "target": get_choice("target", ["YYYY-MM-DD", "YYYYMMDD", "DD-MM-YYYY",
                                            "YYYY年MM月DD日", "MM/DD/YYYY"], "YYYY-MM-DD"),
            "first_only": bool(params.get("first_only", False)),
        }
    elif rule_type == "UserInput":
        raw_names = params.get("names", "")
        if isinstance(raw_names, list):
            names = [str(name).strip() for name in raw_names if str(name).strip()]
        else:
            names = [line.strip() for line in str(raw_names).splitlines() if line.strip()]
        params = {"names": names}
    else:
        errors.append(f"未知规则类型：{rule_type}")
        params = {}

    return params, errors


def normalize_rule(rule):
    """规范化一条规则：迁移旧类型/参数并校验。"""

    rule_type = rule.get("type", "")
    rule_type = LEGACY_TYPE_MAP.get(rule_type, rule_type)
    params, errors = normalize_params(rule_type, rule.get("params", {}))
    normalized = {
        "type": rule_type,
        "params": params,
        "enabled": bool(rule.get("enabled", True)),
    }
    normalized["desc"] = summarize_rule(normalized)
    return normalized, errors


def _find_occurrence(text, needle, occurrence, from_right=False):
    if not needle:
        return -1
    if from_right:
        start = len(text)
        for _ in range(occurrence):
            index = text.rfind(needle, 0, start)
            if index < 0:
                return -1
            start = index
        return index
    start = 0
    index = -1
    for _ in range(occurrence):
        index = text.find(needle, start)
        if index < 0:
            return -1
        start = index + len(needle)
    return index


def _apply_delete(base, params):
    mode = params["mode"]
    direction = params["direction"]
    if mode == "delete_range":
        if direction == "rtl":
            right_index = len(base) - params["start"] + 1
            start = max(0, right_index - params["count"])
        else:
            start = min(len(base), max(0, params["start"] - 1))
        return base[:start] + base[start + params["count"]:]
    if mode == "delete_to_end":
        if direction == "rtl":
            start = max(0, len(base) - params["start"])
        else:
            start = min(len(base), max(0, params["start"] - 1))
        return base[:start]
    index = _find_occurrence(base, params["delimiter"], params["occurrence"], direction == "rtl")
    if index < 0:
        return base
    if mode == "delete_before_delimiter":
        return base[index:]
    if mode == "delete_after_delimiter":
        return base[:index + len(params["delimiter"])]
    return base


def _wildcard_to_regex(text):
    return re.escape(text).replace(r"\*", ".*").replace(r"\?", ".")


def _replace_mode(text, find, replace, mode):
    if mode == "all":
        return text.replace(find, replace)
    if mode == "first":
        return text.replace(find, replace, 1)
    index = text.rfind(find)
    if index < 0:
        return text
    return text[:index] + replace + text[index + len(find):]


def _apply_rearrange(base, params):
    delimiter = params["delimiter"]
    parts = base.split(delimiter) if delimiter else list(base)
    selected = []
    for part_index in params["parts"]:
        index = part_index - 1 if part_index > 0 else len(parts) + part_index
        if 0 <= index < len(parts):
            selected.append(parts[index])
        else:
            return base
    return params["separator"].join(selected)


_DATE_SOURCES = {
    "YYYY-MM-DD": (r"\d{4}-\d{1,2}-\d{1,2}", "%Y-%m-%d"),
    "DD-MM-YYYY": (r"\d{1,2}-\d{1,2}-\d{4}", "%d-%m-%Y"),
    "MM-DD-YYYY": (r"\d{1,2}-\d{1,2}-\d{4}", "%m-%d-%Y"),
    "YYYY/MM/DD": (r"\d{4}/\d{1,2}/\d{1,2}", "%Y/%m/%d"),
    "DD/MM/YYYY": (r"\d{1,2}/\d{1,2}/\d{4}", "%d/%m/%Y"),
    "DD.MM.YYYY": (r"\d{1,2}\.\d{1,2}\.\d{4}", "%d.%m.%Y"),
}

_DATE_TARGETS = {
    "YYYY-MM-DD": "%Y-%m-%d",
    "YYYYMMDD": "%Y%m%d",
    "DD-MM-YYYY": "%d-%m-%Y",
    "YYYY年MM月DD日": "%Y年%m月%d日",
    "MM/DD/YYYY": "%m/%d/%Y",
}


def _apply_reformat_date(base, params):
    pattern, source_format = _DATE_SOURCES[params["source"]]
    target_format = _DATE_TARGETS[params["target"]]

    def replace_date(match):
        try:
            return datetime.strptime(match.group(0), source_format).strftime(target_format)
        except ValueError:
            return match.group(0)

    return re.sub(pattern, replace_date, base, count=1 if params["first_only"] else 0)


def _apply_strip(base, params):
    for char_set in params["char_sets"]:
        if char_set == "digits":
            base = re.sub(r"\d+", "", base)
        elif char_set == "letters":
            base = re.sub(r"[A-Za-z]+", "", base)
        elif char_set == "spaces":
            base = re.sub(r"\s+", "", base)
        elif char_set == "symbols":
            base = re.sub(r"[^\w\s\u4e00-\u9fa5]", "", base)
        elif char_set == "brackets":
            base = base.translate(str.maketrans("", "", "()[]{}<>【】（）《》"))
    if params.get("custom_chars"):
        base = base.translate(str.maketrans("", "", params["custom_chars"]))
    return base


def apply_rule(rule_type, base, ext, params, ctx):
    """执行单条规则，返回 (新主名, 新扩展名)。"""

    if rule_type == "Insert":
        text = params["text"]
        position = params["position"]
        if position == "prefix":
            return text + base, ext
        if position == "suffix":
            return base + text, ext
        if position == "index":
            index = max(0, min(params["index"] - 1, len(base)))
        elif position == "index_from_right":
            index = max(0, len(base) - params["index"])
        else:
            anchor_index = _find_occurrence(base, params["anchor"], params["occurrence"])
            if anchor_index < 0:
                return base, ext
            if position == "before_text":
                index = anchor_index
            else:
                index = anchor_index + len(params["anchor"])
        return base[:index] + text + base[index:], ext
    if rule_type == "Delete":
        return _apply_delete(base, params), ext
    if rule_type == "Remove":
        if params["wildcard"]:
            pattern = _wildcard_to_regex(params["text"])
            flags = 0
            if params["mode"] == "all":
                return re.sub(pattern, "", base, flags=flags), ext
            if params["mode"] == "first":
                return re.sub(pattern, "", base, count=1, flags=flags), ext
            matches = list(re.finditer(pattern, base, flags))
            if not matches:
                return base, ext
            match = matches[-1]
            return base[:match.start()] + base[match.end():], ext
        return _replace_mode(base, params["text"], "", params["mode"]), ext
    if rule_type == "Replace":
        name = base
        for pair in params["pairs"]:
            if not pair["find"]:
                continue
            name = _replace_mode(name, pair["find"], pair["replace"], params["mode"])
        return name, ext
    if rule_type == "Rearrange":
        return _apply_rearrange(base, params), ext
    if rule_type == "Extension":
        mode = params["mode"]
        if mode == "set":
            ext = "." + params["extension"]
        elif mode == "remove":
            ext = ""
        elif mode == "lower":
            ext = ext.lower()
        elif mode == "upper":
            ext = ext.upper()
        return base, ext
    if rule_type == "Strip":
        new_base = _apply_strip(base, params)
        new_ext = _apply_strip(ext, params) if params.get("apply_to_extension") else ext
        return new_base, new_ext
    if rule_type == "Case":
        mode = params["mode"]
        if mode == "lower":
            return base.lower(), ext
        if mode == "upper":
            return base.upper(), ext
        if mode == "title":
            return base.title(), ext
        if mode == "sentence":
            return (base[:1].upper() + base[1:].lower()) if base else "", ext
        return base.swapcase(), ext
    if rule_type == "Serialize":
        counter = ctx.serial_counters.get(ctx.rule_index, params["start"])
        number = str(counter).zfill(params["pad"]) if params["pad"] else str(counter)
        ctx.serial_counters[ctx.rule_index] = counter + params["step"]
        if params["position"] == "prefix":
            return params["separator"] + number + base, ext
        return base + params["separator"] + number, ext
    if rule_type == "Randomize":
        mode = params["mode"]
        if mode == "letters":
            alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if params["uppercase"] else "abcdefghijklmnopqrstuvwxyz"
        elif mode == "digits":
            alphabet = "0123456789"
        elif mode == "hex":
            alphabet = "0123456789ABCDEF" if params["uppercase"] else "0123456789abcdef"
        else:
            alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" if params["uppercase"] else "abcdefghijklmnopqrstuvwxyz0123456789"
        text = "".join(ctx.rng.choice(alphabet) for _ in range(params["length"]))
        if params["position"] == "prefix":
            return text + base, ext
        return base + text, ext
    if rule_type == "Padding":
        char = params["char"]
        length = params["length"]
        if params["mode"] == "remove_padding":
            def remove_padding(match):
                number = match.group(0).lstrip(char)
                return number or "0"
            return re.sub(r"\d+", remove_padding, base), ext

        def pad_number(match):
            number = match.group(0)
            if len(number) >= length:
                return number
            return number.rjust(length, char) if params["direction"] == "left" else number.ljust(length, char)
        return re.sub(r"\d+", pad_number, base), ext
    if rule_type == "CleanUp":
        return cleanup_name(
            base,
            remove_brackets=params["remove_brackets"],
            collapse_spaces=params["collapse_spaces"],
            trim=params["trim"],
            remove_leading_dots=params["remove_leading_dots"],
            remove_www=params["remove_www"],
        ), ext
    if rule_type == "Translit":
        return transliterate(base), ext
    if rule_type == "RegEx":
        flags = re.IGNORECASE if params["ignore_case"] else 0
        if params["mode"] == "all":
            return re.sub(params["pattern"], params["replace"], base, flags=flags), ext
        if params["mode"] == "first":
            return re.sub(params["pattern"], params["replace"], base, count=1, flags=flags), ext
        matches = list(re.finditer(params["pattern"], base, flags))
        if not matches:
            return base, ext
        match = matches[-1]
        return base[:match.start()] + re.sub(params["pattern"], params["replace"], match.group(0), count=1, flags=flags) + base[match.end():], ext
    if rule_type == "ReformatDate":
        return _apply_reformat_date(base, params), ext
    if rule_type == "UserInput":
        index = ctx.checked_index
        if 0 <= index < len(params["names"]):
            return params["names"][index], ext
        return base, ext
    raise RuleError(f"未实现规则：{rule_type}")


def summarize_rule(rule):
    """生成规则的简短中文描述。"""

    rule_type = rule.get("type")
    params = rule.get("params", {})
    insert_positions = {
        "prefix": "前缀",
        "suffix": "后缀",
        "index": "指定索引（从左）",
        "index_from_right": "指定索引（从右）",
        "before_text": "指定文本之前",
        "after_text": "指定文本之后",
    }
    delete_modes = {
        "delete_range": "删除指定范围",
        "delete_to_end": "删除到结尾",
        "delete_before_delimiter": "删除分隔文本之前",
        "delete_after_delimiter": "删除分隔文本之后",
    }
    case_modes = {
        "lower": "全部小写",
        "upper": "全部大写",
        "title": "单词首字母大写",
        "sentence": "句子首字母大写",
        "invert": "反转大小写",
    }
    extension_modes = {
        "set": "修改为",
        "remove": "彻底删除",
        "lower": "转为小写",
        "upper": "转为大写",
    }
    occurrence_modes = {"all": "全部", "first": "第一个", "last": "最后一个"}

    if rule_type == "Insert":
        position = insert_positions.get(params.get("position", ""), params.get("position", ""))
        return f"插入 '{params.get('text', '')}' 到 {position}"
    if rule_type == "Delete":
        mode = delete_modes.get(params.get("mode", ""), params.get("mode", ""))
        direction = "从右往左" if params.get("direction") == "rtl" else "从左往右"
        return f"删除：{mode} ({direction})"
    if rule_type == "Remove":
        mode = occurrence_modes.get(params.get("mode", ""), params.get("mode", ""))
        return f"移除 '{params.get('text', '')}' ({mode})"
    if rule_type == "Replace":
        pairs = params.get("pairs", [])
        mode = occurrence_modes.get(params.get("mode", ""), params.get("mode", ""))
        return f"替换 {len(pairs)} 对文本 ({mode})"
    if rule_type == "Rearrange":
        return f"按分隔符重排为 {params.get('parts', [])}"
    if rule_type == "Extension":
        mode = extension_modes.get(params.get("mode", ""), params.get("mode", ""))
        return f"扩展名：{mode} {params.get('extension', '')}".rstrip()
    if rule_type == "Strip":
        char_sets = params.get("char_sets", [])
        return "清理字符：" + (", ".join(char_sets) if char_sets else "无")
    if rule_type == "Case":
        mode = case_modes.get(params.get("mode", ""), params.get("mode", ""))
        return f"大小写：{mode}"
    if rule_type == "Serialize":
        return f"序号：起始 {params.get('start', 1)}, 步长 {params.get('step', 1)}, 补零 {params.get('pad', 3)}"
    if rule_type == "Randomize":
        return f"随机 {params.get('mode', 'digits')} x {params.get('length', 4)}"
    if rule_type == "Padding":
        return f"数字{('补位' if params.get('mode') == 'pad_numbers' else '去零')}至 {params.get('length', 3)} 位"
    if rule_type == "CleanUp":
        return "清理常见命名习惯"
    if rule_type == "Translit":
        return "转写非英文字母为拉丁字母"
    if rule_type == "RegEx":
        mode = occurrence_modes.get(params.get("mode", ""), params.get("mode", ""))
        return f"正则：{params.get('pattern', '')} ({mode})"
    if rule_type == "ReformatDate":
        return f"日期：{params.get('source', '')} -> {params.get('target', '')}"
    if rule_type == "UserInput":
        return f"手动名称列表（{len(params.get('names', []))} 条）"
    return rule_type


__all__ = [
    "RULE_TYPES",
    "RULE_DEFS",
    "RULE_DEFS_MAP",
    "LEGACY_TYPE_MAP",
    "RuleError",
    "normalize_params",
    "normalize_rule",
    "apply_rule",
    "summarize_rule",
]


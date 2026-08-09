"""通用工具函数：排序、文本转换与清理。"""

import re
import unicodedata


def natural_sort_key(value, _nsre=re.compile(r"([0-9]+)")):
    """自然排序键：让 "file2" 排在 "file10" 前面。"""

    return [int(part) if part.isdigit() else part.lower() for part in _nsre.split(str(value))]


_CYRILLIC_MAP = {
    "А": "A", "Б": "B", "В": "V", "Г": "G", "Д": "D", "Е": "E", "Ё": "Yo",
    "Ж": "Zh", "З": "Z", "И": "I", "Й": "Y", "К": "K", "Л": "L", "М": "M",
    "Н": "N", "О": "O", "П": "P", "Р": "R", "С": "S", "Т": "T", "У": "U",
    "Ф": "F", "Х": "Kh", "Ц": "Ts", "Ч": "Ch", "Ш": "Sh", "Щ": "Sch",
    "Ъ": "", "Ы": "Y", "Ь": "", "Э": "E", "Ю": "Yu", "Я": "Ya",
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}

_GREEK_MAP = {
    "Α": "A", "Β": "B", "Γ": "G", "Δ": "D", "Ε": "E", "Ζ": "Z", "Η": "I",
    "Θ": "Th", "Ι": "I", "Κ": "K", "Λ": "L", "Μ": "M", "Ν": "N", "Ξ": "X",
    "Ο": "O", "Π": "P", "Ρ": "R", "Σ": "S", "Τ": "T", "Υ": "Y", "Φ": "F",
    "Χ": "Ch", "Ψ": "Ps", "Ω": "O",
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i",
    "θ": "th", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "x",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
    "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o",
}


def transliterate(text):
    """将常见非英文字母转写为拉丁字母表示。"""

    normalized = unicodedata.normalize("NFKD", text)
    result = []
    for char in normalized:
        if unicodedata.category(char).startswith("M"):
            continue
        if "A" <= char <= "Z" or "a" <= char <= "z":
            result.append(char)
            continue
        mapped = _CYRILLIC_MAP.get(char) or _GREEK_MAP.get(char)
        result.append(mapped if mapped is not None else char)
    return "".join(result)


def cleanup_name(name, remove_brackets=True, collapse_spaces=True, trim=True,
                 remove_leading_dots=True, remove_www=False):
    """按常见互联网命名习惯清理文件名。"""

    if remove_brackets:
        name = re.sub(r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|【[^】]*】|（[^）]*）|《[^》]*》", "", name)
    if remove_www:
        name = re.sub(r"(?i)^www\.", "", name)
    if collapse_spaces:
        name = re.sub(r"\s+", " ", name)
    if trim:
        name = name.strip()
    if remove_leading_dots:
        name = re.sub(r"^\.+", "", name)
    return name


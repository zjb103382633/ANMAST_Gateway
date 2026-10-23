"""ucomp.anchors — 锚点抽取与渲染（确定性安全网）。

从外置前区域文本（含 pairs 原文）提取关键事实清单，由 pipeline 以固定格式追加在
摘要正文之后；适配器注入的 LLM 摘要器也照样追加，安全网与摘要实现无关（§8）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ucomp.policy import CompactionPolicy
from ucomp.types import TextBlock

if TYPE_CHECKING:  # 仅类型标注；运行时依赖方向 anchors → types, policy（§2.1）
    from ucomp.summarize import ToolPair

__all__ = ["Anchors", "extract_anchors", "render_anchor_block"]

_ABS_PATH_RE = re.compile(r"(?:/[\w.\-]+){2,}")
_EXT_RE = re.compile(
    r"[\w.\-]+\.(?:py|ts|tsx|js|jsx|json|md|txt|yaml|yml|toml|sh|rs|go|java|c|cpp|h|css|html|sql|cfg|ini|lock)")
# [\w.\-] 连续段：_EXT_RE 的匹配只可能起始于段首（见 _paths_in_text）
_WORD_RUN_RE = re.compile(r"[\w.\-]+")
_ERROR_PREFIXES = ("Error", "ERROR", "error", "Exception", "panic", "FATAL")
_ERROR_ENTRY_MAX_BYTES = 200


@dataclass(frozen=True)
class Anchors:
    file_paths: tuple[str, ...]
    commands: tuple[str, ...]
    errors: tuple[str, ...]


def _cut_utf8(text: str, limit: int) -> str:
    b = text.encode("utf-8")
    if len(b) <= limit:
        return text
    return b[:limit].decode("utf-8", errors="ignore")


def _dedup(items):
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _pair_content_text(pair: "ToolPair") -> str:
    c = pair.result.content
    return c if isinstance(c, str) else "\n".join(t.text for t in c)


def _paths_in_text(text: str) -> list[str]:
    r"""两类文件路径正则按位置合并，同起点取更长者，重叠不重复收录。

    _EXT_RE 的扫描只从 [\w.\-] 连续段首发起：段内起点的匹配必被段首的贪婪
    匹配支配（起点更早、终点不早于），合并去重时本就会被丢弃——跳过它们可
    避免长单行纯 \w 文本上 finditer 逐起点回溯的 O(n²) 退化（已对随机文本
    做新旧扫描差分验证等价；与 ucomp.summarize._paths_in_text 同款规则）。
    """
    matches = [(m.start(), m.end(), m.group(0)) for m in _ABS_PATH_RE.finditer(text)]
    for run in _WORD_RUN_RE.finditer(text):
        ext = _EXT_RE.match(text, run.start())
        if ext:
            matches.append((ext.start(), ext.end(), ext.group(0)))
    matches.sort(key=lambda t: (t[0], -(t[1] - t[0])))
    out: list[str] = []
    last_end = -1
    for start, end, group in matches:
        if start < last_end:
            continue
        out.append(group)
        last_end = end
    return out


def _is_error_line(line: str) -> bool:
    return ("Traceback (most recent call last)" in line
            or line.startswith(_ERROR_PREFIXES)
            or "error:" in line
            or "failed to" in line)


def _region_texts(messages) -> list[str]:
    return [b.text for m in messages for b in m.content if isinstance(b, TextBlock)]


def extract_anchors(region_original, pairs, policy: CompactionPolicy) -> Anchors:
    """抽取规则复用 §7.2 files/errors 的正则与 pair 键规则；去重一律首现顺序保留。"""
    texts = _region_texts(region_original) + [_pair_content_text(p) for p in pairs]
    regex_paths: list[str] = []
    for text in texts:
        regex_paths.extend(_paths_in_text(text))
    pair_paths: list[str] = []
    commands: list[str] = []
    for pair in pairs:
        inp = pair.use.input if isinstance(pair.use.input, dict) else {}
        pair_paths.extend(inp[k] for k in ("file_path", "path", "filename")
                          if isinstance(inp.get(k), str))
        commands.extend(inp[k] for k in ("command", "cmd") if isinstance(inp.get(k), str))
    file_paths = _dedup(regex_paths + pair_paths)[:policy.anchors.max_file_paths]
    commands = _dedup(commands)[:policy.anchors.max_commands]
    errors: list[str] = []
    for pair in pairs:
        if pair.result.is_error:
            text = _pair_content_text(pair)
            first = text.split("\n", 1)[0] if text else ""
            errors.append(f"tool={pair.use.name}: {first}")
    for text in texts:
        errors.extend(ln for ln in text.splitlines() if _is_error_line(ln))
    errors = [_cut_utf8(e, _ERROR_ENTRY_MAX_BYTES) for e in _dedup(errors)]
    errors = errors[:policy.anchors.max_errors]
    return Anchors(tuple(file_paths), tuple(commands), tuple(errors))


def render_anchor_block(anchors: Anchors) -> str:
    """逐字格式：
    <anchors>
    files: a.py, src/b.ts
    commands: pytest -q, git status
    errors: ModuleNotFoundError: No module named 'x'
    </anchors>
    三类各占一行，分隔符 = 英文逗号+空格；空类整行省略；三类全空返回空串。"""
    lines = ["<anchors>"]
    if anchors.file_paths:
        lines.append("files: " + ", ".join(anchors.file_paths))
    if anchors.commands:
        lines.append("commands: " + ", ".join(anchors.commands))
    if anchors.errors:
        lines.append("errors: " + ", ".join(anchors.errors))
    if len(lines) == 1:
        return ""
    lines.append("</anchors>")
    return "\n".join(lines)

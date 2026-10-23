"""ucomp.summarize — Summarizer 注入协议 + v0 内置规则版摘要器。

规则版纯规则、零网络、确定性（C3）；LLM 摘要器由适配器按 §7.3 注入。
锚点块不由摘要器生成——pipeline 在 §8 统一追加。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from ucomp.policy import CompactionPolicy
from ucomp.types import Message, TextBlock, ToolResultBlock, ToolUseBlock

if TYPE_CHECKING:  # 仅类型标注；运行时依赖方向 summarize → types, policy（§2.1）
    from ucomp.externalize import ExternalizeRecord

__all__ = ["Summarizer", "SummaryRequest", "RuleBasedSummarizer", "ToolPair", "RegionStats",
           "SUMMARIZER_PROMPT_TEMPLATE"]

# 框架行逐字（§7.2）；版本须与 ucomp.__version__ 保持一致
_HEADER = "[上下文压缩摘要 by ucomp v0.1.0]"
_FOOTER = "[摘要结束；其后为近期原文]"

_SECTION_TITLES = {
    "goal": "## 目标与意图",
    "concepts": "## 关键技术概念",
    "files": "## 文件与代码段",
    "errors": "## 错误与修复",
    "todos": "## 待办",
    "current": "## 当前工作",
    "next": "## 下一步",
    "reread": "## 可重读文件清单",
}

SUMMARIZER_PROMPT_TEMPLATE = (
    "你是上下文压缩摘要器。请按以下 8 段输出结构化摘要（Markdown 二级标题逐字使用）：\n"
    + "\n".join(f"- {name}: {title}" for name, title in _SECTION_TITLES.items())
    + "\n硬性要求：文件路径、命令行、错误原文必须逐字保留，不得改写或省略。"
)  # v0 引擎自身对该常量无行为依赖（§7.3，v0.1 生效）


@dataclass(frozen=True)
class ToolPair:
    use: ToolUseBlock
    result: ToolResultBlock   # 外置前的原文（供逐字提取），非最终上下文内容
    message_index: int        # 区域内局部索引


@dataclass(frozen=True)
class RegionStats:
    n_messages: int
    n_pairs: int
    bytes_original: int       # 外置前区域总字节
    bytes_after_externalize: int


@dataclass(frozen=True)
class SummaryRequest:
    messages: list[Message]   # 外置后的区域（存根已在内）——最终上下文将呈现的形态
    pairs: list[ToolPair]     # 外置前配对（原文在此，供提取错误行/命令/路径）
    externalized: list["ExternalizeRecord"]
    sections: tuple[str, ...]
    policy: CompactionPolicy
    stats: RegionStats


class Summarizer(Protocol):
    def __call__(self, request: SummaryRequest) -> str:
        """返回摘要正文（不含锚点块——锚点由 pipeline 统一追加）。
        实现不得修改 request；不得有隐藏全局状态。"""
        ...


# ---- 规则与上限（§7.2） -------------------------------------------------

_BACKTICK_RE = re.compile(r"`([^`\n]{1,60})`")
_ABS_PATH_RE = re.compile(r"(?:/[\w.\-]+){2,}")
_EXT_RE = re.compile(
    r"[\w.\-]+\.(?:py|ts|tsx|js|jsx|json|md|txt|yaml|yml|toml|sh|rs|go|java|c|cpp|h|css|html|sql|cfg|ini|lock)")
# [\w.\-] 连续段：_EXT_RE 的匹配只可能起始于段首（见 _paths_in_text）
_WORD_RUN_RE = re.compile(r"[\w.\-]+")
_TODO_RE = re.compile(r"TODO|待办|待确认|下一步|next step|尚未|未完成", re.IGNORECASE)
_ERROR_PREFIXES = ("Error", "ERROR", "error", "Exception", "panic", "FATAL")
_ERROR_ENTRY_MAX_BYTES = 200
_FILE_REGEX_LIMIT = 15
_CONCEPTS_LIMIT = 10
_ERRORS_LIMIT = 10
_TODOS_LIMIT = 8
_REREAD_LIMIT = 15
_CURRENT_HEAD_BYTES = 800
_NEXT_HEAD_BYTES = 400


def _cut_utf8(text: str, limit: int) -> str:
    b = text.encode("utf-8")
    if len(b) <= limit:
        return text
    return b[:limit].decode("utf-8", errors="ignore")


def _cap_lines(lines, cap: int):
    """按行截断到字节上限；返回 (保留行, 是否发生截断)。首行恒保留。"""
    kept: list[str] = []
    acc = 0
    for ln in lines:
        lb = len(ln.encode("utf-8"))
        if kept and acc + lb > cap:
            return kept, True
        kept.append(ln)
        acc += lb
    return kept, False


def _dedup(items):
    """首现顺序保留去重（确定性，禁 set 迭代序）。"""
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _region_texts(messages) -> list[str]:
    return [b.text for m in messages for b in m.content if isinstance(b, TextBlock)]


def _pair_content_text(pair: ToolPair) -> str:
    c = pair.result.content
    return c if isinstance(c, str) else "\n".join(t.text for t in c)


def _full_texts(request: SummaryRequest) -> list[str]:
    """「全文」= 区域文本（含存根）+ 外置前配对原文，供概念/路径/错误行提取。"""
    return _region_texts(request.messages) + [_pair_content_text(p) for p in request.pairs]


def _paths_in_text(text: str) -> list[str]:
    r"""两类文件路径正则按位置合并，同起点取更长者，重叠不重复收录。

    _EXT_RE 的扫描只从 [\w.\-] 连续段首发起：段内起点的匹配必被段首的贪婪
    匹配支配（起点更早、终点不早于），合并去重时本就会被丢弃——跳过它们可
    避免长单行纯 \w 文本上 finditer 逐起点回溯的 O(n²) 退化（已对随机文本
    做新旧扫描差分验证等价）。
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


def _input_get(use: ToolUseBlock, keys) -> list[str]:
    inp = use.input if isinstance(use.input, dict) else {}
    return [inp[k] for k in keys if isinstance(inp.get(k), str)]


def _head_by_line(text: str, limit: int) -> str:
    """前 limit 字节，按行边界截；首行超限时按字节截断该行。"""
    kept: list[str] = []
    acc = 0
    for line in text.splitlines():
        lb = len(line.encode("utf-8"))
        if acc + lb > limit:
            if not kept:
                kept.append(_cut_utf8(line, limit))
            break
        kept.append(line)
        acc += lb
        if acc >= limit:
            break
    return "\n".join(kept)


class RuleBasedSummarizer:
    """v0 内置摘要器：无状态、确定性、同输入逐字节同输出。"""

    __slots__ = ()

    def __call__(self, request: SummaryRequest) -> str:
        renderers = {
            "goal": self._goal,
            "concepts": self._concepts,
            "files": self._files,
            "errors": self._errors,
            "todos": self._todos,
            "current": self._current,
            "next": self._next,
            "reread": self._reread,
        }
        lines = [_HEADER]
        for name in request.sections:
            renderer = renderers.get(name)
            if renderer is None:  # summary_sections 可增删段名；未知段名跳过
                continue
            title, body = renderer(request)
            cap = request.policy.section_byte_caps.get(name, 10_000)
            kept, truncated = _cap_lines(body, cap)
            lines.append(title)
            lines.extend(kept if kept else ["(无)"])
            if truncated:
                lines.append("…(截断)")
        lines.append(_FOOTER)
        return "\n".join(lines)

    @staticmethod
    def _goal(request: SummaryRequest):
        for msg in request.messages:
            if msg.role != "user":
                continue
            lines: list[str] = []
            for block in msg.content:
                if isinstance(block, TextBlock):
                    lines.extend(block.text.splitlines())
            body = [ln for ln in lines if ln.strip()][:3]
            if body:
                return _SECTION_TITLES["goal"], body
        return _SECTION_TITLES["goal"], []

    @staticmethod
    def _concepts(request: SummaryRequest):
        counts: dict[str, list] = {}  # span -> [count, first_pos]
        pos = 0
        for text in _full_texts(request):
            for m in _BACKTICK_RE.finditer(text):
                span = m.group(1)
                if span in counts:
                    counts[span][0] += 1
                else:
                    counts[span] = [1, pos]
                pos += 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1][0], kv[1][1]))[:_CONCEPTS_LIMIT]
        return _SECTION_TITLES["concepts"], [f"- {span} ×{c}" for span, (c, _) in ordered]

    @staticmethod
    def _files(request: SummaryRequest):
        regex_paths: list[str] = []
        for text in _full_texts(request):
            regex_paths.extend(_paths_in_text(text))
        pair_paths: list[str] = []
        for pair in request.pairs:
            pair_paths.extend(_input_get(pair.use, ("file_path", "path", "filename")))
        body = _dedup(_dedup(regex_paths)[:_FILE_REGEX_LIMIT] + pair_paths)
        return _SECTION_TITLES["files"], body

    @staticmethod
    def _errors(request: SummaryRequest):
        entries: list[str] = []
        for pair in request.pairs:
            if pair.result.is_error:
                text = _pair_content_text(pair)
                first = text.split("\n", 1)[0] if text else ""
                entries.append(f"tool={pair.use.name}: {first}")
        for text in _full_texts(request):
            entries.extend(ln for ln in text.splitlines() if _is_error_line(ln))
        body = [_cut_utf8(e, _ERROR_ENTRY_MAX_BYTES) for e in _dedup(entries)][:_ERRORS_LIMIT]
        return _SECTION_TITLES["errors"], body

    @staticmethod
    def _todos(request: SummaryRequest):
        body: list[str] = []
        for msg in request.messages:
            if msg.role != "user":
                continue
            for block in msg.content:
                if isinstance(block, TextBlock):
                    body.extend(ln for ln in block.text.splitlines() if _TODO_RE.search(ln))
        return _SECTION_TITLES["todos"], body[:_TODOS_LIMIT]

    @staticmethod
    def _current(request: SummaryRequest):
        for msg in reversed(request.messages):
            if msg.role != "assistant":
                continue
            text = "\n".join(b.text for b in msg.content if isinstance(b, TextBlock))
            if not text.strip():
                continue
            return _SECTION_TITLES["current"], _head_by_line(text, _CURRENT_HEAD_BYTES).splitlines()
        return _SECTION_TITLES["current"], []

    @staticmethod
    def _next(request: SummaryRequest):
        for msg in reversed(request.messages):
            if msg.role != "user":
                continue
            text = "\n".join(b.text for b in msg.content if isinstance(b, TextBlock))
            if not text.strip():
                continue
            return _SECTION_TITLES["next"], _head_by_line(text, _NEXT_HEAD_BYTES).splitlines()
        return _SECTION_TITLES["next"], []

    @staticmethod
    def _reread(request: SummaryRequest):
        by_id = {p.use.id: p for p in request.pairs}
        body: list[str] = []
        for rec in request.externalized:
            if len(body) >= _REREAD_LIMIT:
                break
            if rec.category == "file":
                preview_lines = rec.preview.splitlines()
                first = preview_lines[0] if preview_lines else ""
                body.append(f"- {first} → 原文路径：{rec.artifact_path}")
            elif rec.category == "rerunnable":
                pair = by_id.get(rec.tool_use_id)
                commands = _input_get(pair.use, ("command", "cmd")) if pair is not None else []
                if commands:
                    body.append(f"- 重跑：{commands[0]}（输出存于 {rec.artifact_path}）")
        return _SECTION_TITLES["reread"], body

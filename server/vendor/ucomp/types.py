"""ucomp.types — canonical 消息类型、(反)序列化、字节与 token 估算工具。

canonical 格式 = Anthropic 风格 content blocks（docs/engine-api.md §3）。
engine 内 block 列表一律用 tuple，序列化时转 list。
ValidationIssue / InvalidTranscript 定义于本模块（依赖方向最低层），ucomp.validate 再导出。
"""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field

_ROLES = ("user", "assistant")
_DIALECTS = ("canonical", "anthropic")


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    severity: str  # "error" | "warning"
    message: str
    message_index: int
    block_index: int | None


class InvalidTranscript(ValueError):
    """输入违反协议规则；str(exc) 为多行可读文本，exc.issues 供 CLI 序列化。"""

    def __init__(self, issues):
        self.issues = list(issues)
        lines = [f"invalid transcript: {len(self.issues)} issue(s)"]
        for iss in self.issues:
            loc = f"msg[{iss.message_index}]"
            if iss.block_index is not None:
                loc += f" block[{iss.block_index}]"
            lines.append(f"  {iss.code}/{iss.severity} @{loc}: {iss.message}")
        super().__init__("\n".join(lines))


@dataclass(frozen=True)
class TextBlock:
    text: str
    type: str = "text"  # 序列化时输出，恒为 "text"

    def to_dict(self) -> dict:
        return {"type": self.type, "text": self.text}


@dataclass(frozen=True)
class ToolUseBlock:
    id: str  # 非空字符串，全会话唯一；引擎绝不改写
    name: str
    input: dict = field(default_factory=dict)
    type: str = "tool_use"

    def to_dict(self) -> dict:
        return {
            "type": self.type,
            "id": self.id,
            "name": self.name,
            "input": copy.deepcopy(self.input),
        }


@dataclass(frozen=True)
class ToolResultBlock:
    tool_use_id: str  # 必须指向更早出现的 ToolUseBlock.id
    content: str | tuple[TextBlock, ...]
    is_error: bool = False
    type: str = "tool_result"

    def to_dict(self) -> dict:
        content = self.content
        if isinstance(content, tuple):
            content = [b.to_dict() for b in content]
        return {
            "type": self.type,
            "tool_use_id": self.tool_use_id,
            "content": content,
            "is_error": self.is_error,  # 恒输出（false 也输出），保证字节级确定性
        }


@dataclass(frozen=True)
class Message:
    role: str
    content: tuple[TextBlock | ToolUseBlock | ToolResultBlock, ...]

    def to_dict(self) -> dict:
        return {"role": self.role, "content": [b.to_dict() for b in self.content]}

    @classmethod
    def from_dict(cls, obj, *, dialect: str = "canonical", message_index: int = 0) -> "Message":
        """从 dict 构造；违反消息级规则（§10.1 中可在单消息内判定的部分）抛 InvalidTranscript。

        会话级规则（E010 重复 id / E011 前向引用 / E012 无应答）需全会话上下文，
        由 ucomp.validate.validate_messages / check_pairing 负责。
        v0 不支持 openai 方言的构造（仅 validate 支持，§14）。
        """
        if dialect not in _DIALECTS:
            raise ValueError(f"from_dict supports dialects {_DIALECTS} only, got {dialect!r}")
        if not isinstance(obj, dict):
            raise ValueError(f"message must be a dict, got {type(obj).__name__}")
        issues: list[ValidationIssue] = []
        role = obj.get("role")
        if role not in _ROLES:
            issues.append(ValidationIssue(
                "E001", "error", f"role must be 'user'|'assistant', got {role!r}", message_index, None))
            role = "user"
        content = obj.get("content")
        if isinstance(content, str) and dialect == "anthropic":
            blocks_in = [{"type": "text", "text": content}]
        elif isinstance(content, list):
            blocks_in = content
        else:
            issues.append(ValidationIssue(
                "E003", "error",
                f"content must be a list (or a string in anthropic dialect), got {type(content).__name__}",
                message_index, None))
            blocks_in = []
        blocks = []
        for bi, raw in enumerate(blocks_in):
            blk = _block_from_dict(raw, role=role, dialect=dialect,
                                   mi=message_index, bi=bi, issues=issues)
            if blk is not None:
                blocks.append(blk)
        if issues:
            raise InvalidTranscript(issues)
        return cls(role, tuple(blocks))


Session = list[Message]  # 会话消息列表的类型别名（顺序即时间序，append-only 语义）


def _block_from_dict(raw, *, role, dialect, mi, bi, issues):
    if not isinstance(raw, dict):
        issues.append(ValidationIssue("E002", "error", "block must be a JSON object", mi, bi))
        return None
    btype = raw.get("type")
    if btype == "text":
        text = raw.get("text")
        if not isinstance(text, str):
            issues.append(ValidationIssue("E004", "error", "text block requires a string 'text'", mi, bi))
            return None
        return TextBlock(text)
    if btype == "tool_use":
        tid = raw.get("id")
        name = raw.get("name")
        inp = raw.get("input", {})
        ok = True
        if not isinstance(tid, str) or not tid:
            issues.append(ValidationIssue("E010", "error", "tool_use.id must be a non-empty string", mi, bi))
            ok = False
        if not isinstance(name, str) or not name:
            issues.append(ValidationIssue("E010", "error", "tool_use.name must be a non-empty string", mi, bi))
            ok = False
        if "input" in raw and not isinstance(raw["input"], dict):
            issues.append(ValidationIssue("E016", "error", "tool_use.input must be a JSON object when present", mi, bi))
            inp = {}
            ok = False
        if role == "user":
            issues.append(ValidationIssue("E013", "error", "tool_use block is not allowed in a user message", mi, bi))
        return ToolUseBlock(tid if isinstance(tid, str) else "", name if isinstance(name, str) else "",
                            inp if isinstance(inp, dict) else {}) if ok else None
    if btype == "tool_result":
        tuid = raw.get("tool_use_id")
        if not isinstance(tuid, str) or not tuid:
            issues.append(ValidationIssue("E011", "error", "tool_result.tool_use_id must be a non-empty string", mi, bi))
            tuid = ""
        c = raw.get("content")
        if isinstance(c, str):
            content = c
        elif isinstance(c, list):
            texts: list[TextBlock] = []
            for item in c:
                if not isinstance(item, dict) or item.get("type") != "text":
                    issues.append(ValidationIssue(
                        "E015", "error", "tool_result.content only accepts text blocks", mi, bi))
                    continue
                t = item.get("text")
                if not isinstance(t, str):
                    issues.append(ValidationIssue("E004", "error", "nested text block requires a string 'text'", mi, bi))
                    continue
                texts.append(TextBlock(t))
            content = tuple(texts)
        else:
            issues.append(ValidationIssue(
                "E003", "error", "tool_result.content must be a string or a list of text blocks", mi, bi))
            content = ""
        is_error = raw.get("is_error", False)
        if not isinstance(is_error, bool):
            issues.append(ValidationIssue("E002", "error", "tool_result.is_error must be a boolean", mi, bi))
            is_error = False
        if role == "assistant":
            issues.append(ValidationIssue("E013", "error", "tool_result block is not allowed in an assistant message", mi, bi))
        return ToolResultBlock(tuid, content, is_error)
    issues.append(ValidationIssue("E002", "error", f"unknown block type: {btype!r}", mi, bi))
    return None


@dataclass(frozen=True)
class ExternalizeRecord:
    """外置记录（报告/摘要用）。定义于 types 以便 summarize/anchors 引用而不违反依赖方向；
    ucomp.externalize 再导出（§6.5）。"""

    message_index: int        # 区域内局部索引（区域第 0 条起算）
    tool_use_id: str
    tool: str
    category: str
    bytes_before: int
    artifact_path: str
    sha256: str
    preview: str              # 原文前 200 字节（utf-8 解码 errors="replace"），供摘要器引用

    def to_dict(self) -> dict:
        return {
            "message_index": self.message_index,
            "tool_use_id": self.tool_use_id,
            "tool": self.tool,
            "category": self.category,
            "bytes_before": self.bytes_before,
            "artifact_path": self.artifact_path,
            "sha256": self.sha256,
            "preview": self.preview,
        }


def session_to_dict(messages) -> dict:
    """Session → CLI 外层信封 {"messages": [...]}。"""
    return {"messages": [m.to_dict() for m in messages]}


def block_text_bytes(block) -> int:
    """text → utf8 字节数；tool_use → json.dumps(input) 的字节数 + 16（id/name）；
    tool_result → content 为 str 时其 utf8 字节数，为 tuple 时各 text 之和。
    亦接受裸 content（str 或 TextBlock 元组，§6.2 外置候选判定用）。"""
    if isinstance(block, str):
        return len(block.encode("utf-8"))
    if isinstance(block, tuple):
        return sum(len(t.text.encode("utf-8")) for t in block)
    if isinstance(block, TextBlock):
        return len(block.text.encode("utf-8"))
    if isinstance(block, ToolUseBlock):
        s = json.dumps(block.input, ensure_ascii=False, sort_keys=True)
        return len(s.encode("utf-8")) + 16
    if isinstance(block, ToolResultBlock):
        return block_text_bytes(block.content)
    raise TypeError(f"unsupported block type: {type(block).__name__}")


def message_bytes(msg: Message) -> int:
    """各 block 之和 + 8（role 等信封）。"""
    return sum(block_text_bytes(b) for b in msg.content) + 8


def estimate_text_tokens(text: str) -> int:
    """v0 启发式：ASCII 约 4 字节/token，非 ASCII 约 3 字节/token（CJK≈1 token/字）。"""
    b = text.encode("utf-8")
    non_ascii = sum(1 for x in b if x >= 0x80)
    return (len(b) - non_ascii + 3) // 4 + (non_ascii + 2) // 3


def estimate_message_tokens(msg: Message) -> int:
    """对各 block 的文本部分求 estimate_text_tokens 后 +4。"""
    total = 0
    for b in msg.content:
        if isinstance(b, TextBlock):
            s = b.text
        elif isinstance(b, ToolUseBlock):
            s = json.dumps(b.input, ensure_ascii=False, sort_keys=True) + "\n" + b.id + "\n" + b.name
        else:
            s = b.content if isinstance(b.content, str) else "\n".join(t.text for t in b.content)
        total += estimate_text_tokens(s)
    return total + 4

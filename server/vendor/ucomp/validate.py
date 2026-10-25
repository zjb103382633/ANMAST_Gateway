"""ucomp.validate — 三种方言的消息校验与紧凑配对检查（铁律 1 的规则源）。

validate_messages 作用于原始 dict（canonical / anthropic / openai）；
check_pairing / check_structure 作用于已构造的 Message 对象（pipeline 内部用）。
两者共享 _pairing_issues 同一套配对规则源（§12-R4）。
"""
from __future__ import annotations

import json

from ucomp.types import (  # noqa: F401  (InvalidTranscript/ValidationIssue 再导出，§10.3)
    InvalidTranscript,
    Message,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    ValidationIssue,
)

__all__ = ["validate_messages", "check_pairing", "check_structure",
           "InvalidTranscript", "ValidationIssue"]

_DIALECTS = ("canonical", "anthropic", "openai")
_CANONICAL_ROLES = ("user", "assistant")
_OPENAI_ROLES = ("system", "user", "assistant", "tool")


def validate_messages(obj, *, dialect: str = "canonical") -> list[ValidationIssue]:
    """dialect ∈ {"canonical","anthropic","openai"}；obj 为 {"messages":[...]} 或裸列表。
    只收 dict 形态的消息；信封本身不合法时抛 ValueError（CLI 归为用法错误）。"""
    if dialect not in _DIALECTS:
        raise ValueError(f"unknown dialect: {dialect!r}")
    if isinstance(obj, dict):
        if "messages" not in obj:
            raise ValueError("input object requires a 'messages' key")
        raw = obj["messages"]
    elif isinstance(obj, list):
        raw = obj
    else:
        raise ValueError("input must be {'messages': [...]} or a bare list")
    if not isinstance(raw, list):
        raise ValueError(f"'messages' must be a list, got {type(raw).__name__}")
    issues: list[ValidationIssue] = []
    uses: list[tuple[str, int, int]] = []     # (id, message_index, block_index)
    results: list[tuple[str, int, int]] = []  # (tool_use_id, message_index, block_index)
    for mi, msg in enumerate(raw):
        if not isinstance(msg, dict):
            raise ValueError(f"message[{mi}] must be an object, got {type(msg).__name__}")
        if dialect == "openai":
            _validate_openai_message(msg, mi, issues, uses, results)
        else:
            _validate_canonical_message(msg, mi, dialect, issues, uses, results)
    if dialect == "openai":
        issues.extend(_openai_pairing_issues(uses, results))
    else:
        issues.extend(_pairing_issues(uses, results))
    return issues


def _validate_canonical_message(msg, mi, dialect, issues, uses, results):
    role = msg.get("role")
    if role not in _CANONICAL_ROLES:
        issues.append(ValidationIssue(
            "E001", "error", f"role must be 'user'|'assistant', got {role!r}", mi, None))
    content = msg.get("content")
    if isinstance(content, list):
        blocks = content
    elif isinstance(content, str) and dialect == "anthropic":
        blocks = [{"type": "text", "text": content}]
    else:
        expected = "a list (or a string in anthropic dialect)"
        if dialect == "canonical":
            expected = "a list"
        issues.append(ValidationIssue(
            "E003", "error", f"content must be {expected}, got {type(content).__name__}", mi, None))
        blocks = []
    seen_text = False  # W002：user 消息中 tool_result 之前的 text 块
    for bi, block in enumerate(blocks):
        if not isinstance(block, dict):
            issues.append(ValidationIssue("E002", "error", "block must be a JSON object", mi, bi))
            continue
        btype = block.get("type")
        if btype == "text":
            if not isinstance(block.get("text"), str):
                issues.append(ValidationIssue(
                    "E004", "error", "text block requires a string 'text'", mi, bi))
            if role == "user":
                seen_text = True
        elif btype == "tool_use":
            tid = block.get("id")
            if not isinstance(tid, str) or not tid:
                issues.append(ValidationIssue(
                    "E010", "error", "tool_use.id must be a non-empty string", mi, bi))
            if not isinstance(block.get("name"), str) or not block.get("name"):
                issues.append(ValidationIssue(
                    "E010", "error", "tool_use.name must be a non-empty string", mi, bi))
            if "input" in block and not isinstance(block["input"], dict):
                issues.append(ValidationIssue(
                    "E016", "error", "tool_use.input must be a JSON object when present", mi, bi))
            if role == "user":
                issues.append(ValidationIssue(
                    "E013", "error", "tool_use block is not allowed in a user message", mi, bi))
            elif isinstance(tid, str) and tid:
                uses.append((tid, mi, bi))
        elif btype == "tool_result":
            tuid = block.get("tool_use_id")
            if not isinstance(tuid, str) or not tuid:
                issues.append(ValidationIssue(
                    "E011", "error", "tool_result.tool_use_id must be a non-empty string", mi, bi))
            c = block.get("content")
            if isinstance(c, list):
                for item in c:
                    if not isinstance(item, dict) or item.get("type") != "text":
                        issues.append(ValidationIssue(
                            "E015", "error", "tool_result.content only accepts text blocks", mi, bi))
                        break
                    if not isinstance(item.get("text"), str):
                        issues.append(ValidationIssue(
                            "E004", "error", "nested text block requires a string 'text'", mi, bi))
                        break
            elif not isinstance(c, str):
                issues.append(ValidationIssue(
                    "E003", "error",
                    f"tool_result.content must be a string or list of text blocks, got {type(c).__name__}",
                    mi, bi))
            if role == "assistant":
                issues.append(ValidationIssue(
                    "E013", "error", "tool_result block is not allowed in an assistant message", mi, bi))
            else:
                if seen_text:
                    issues.append(ValidationIssue(
                        "W002", "warning",
                        "tool_result block appears after a text block in a user message", mi, bi))
                if isinstance(tuid, str) and tuid:
                    results.append((tuid, mi, bi))
        else:
            issues.append(ValidationIssue(
                "E002", "error", f"unknown top-level block type: {btype!r}", mi, bi))


def _pairing_issues(uses, results) -> list[ValidationIssue]:
    """配对四规则（E010/E011/E012/E013 中除 E013 外的三条——E013 在消息扫描时产生）。
    canonical 与 openai 共用本函数形态；「更早」= (message_index, block_index) 字典序更小。"""
    issues: list[ValidationIssue] = []
    first_decl: dict[str, tuple[int, int]] = {}
    for tid, mi, bi in uses:
        if tid in first_decl:
            issues.append(ValidationIssue(
                "E010", "error", f"duplicate tool_use id: {tid}", mi, bi))
        else:
            first_decl[tid] = (mi, bi)
    answers: dict[str, list[tuple[int, int]]] = {}
    for tuid, mi, bi in results:
        answers.setdefault(tuid, []).append((mi, bi))
        loc = first_decl.get(tuid)
        if loc is None or loc >= (mi, bi):
            issues.append(ValidationIssue(
                "E011", "error",
                f"tool_result references tool_use {tuid!r} not declared in an earlier block", mi, bi))
    for tid, (umi, ubi) in first_decl.items():
        n = len(answers.get(tid, ()))
        if n == 0:
            issues.append(ValidationIssue(
                "E012", "error", f"tool_use {tid} has no tool_result answer", umi, ubi))
        elif n >= 2:
            issues.append(ValidationIssue(
                "E012", "error", f"tool_use {tid} answered by {n} tool_results", umi, ubi))
    return issues


def _validate_openai_message(msg, mi, issues, uses, results):
    role = msg.get("role")
    if role not in _OPENAI_ROLES:
        issues.append(ValidationIssue(
            "E001", "error",
            f"role must be one of system|user|assistant|tool, got {role!r}", mi, None))
    content = msg.get("content")
    if not isinstance(content, str):
        issues.append(ValidationIssue(
            "E003", "error", f"openai dialect requires string content, got {type(content).__name__}",
            mi, None))
    if role == "assistant":
        tool_calls = msg.get("tool_calls")
        if tool_calls is not None:
            if not isinstance(tool_calls, list):
                issues.append(ValidationIssue(
                    "E101", "error", "assistant.tool_calls must be a list", mi, None))
                return
            for ti, tc in enumerate(tool_calls):
                ok = isinstance(tc, dict)
                tc_id = tc.get("id") if ok else None
                fn = tc.get("function") if ok else None
                if (not ok or not isinstance(tc_id, str) or not tc_id
                        or not isinstance(fn, dict)
                        or not isinstance(fn.get("name"), str) or not fn["name"]):
                    issues.append(ValidationIssue(
                        "E101", "error", "tool_calls[i] requires non-empty id and function.name", mi, ti))
                    continue
                args = fn.get("arguments")
                parsed = None
                if isinstance(args, str):
                    try:
                        parsed = json.loads(args)
                    except json.JSONDecodeError:
                        parsed = None
                if not isinstance(parsed, dict):
                    issues.append(ValidationIssue(
                        "E101", "error",
                        "function.arguments must be JSON text of an object", mi, ti))
                    continue
                uses.append((tc_id, mi, ti))
    elif role == "tool":
        tcid = msg.get("tool_call_id")
        if not isinstance(tcid, str) or not tcid:
            issues.append(ValidationIssue(
                "E102", "error", "role=tool message requires a non-empty tool_call_id", mi, None))
        else:
            results.append((tcid, mi, 0))


def _openai_pairing_issues(uses, results) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    first_decl: dict[str, tuple[int, int]] = {}
    for tid, mi, ti in uses:
        if tid in first_decl:
            issues.append(ValidationIssue(
                "E101", "error", f"duplicate tool_call id: {tid}", mi, ti))
        else:
            first_decl[tid] = (mi, ti)
    answers: dict[str, int] = {}
    for tuid, mi, bi in results:
        answers[tuid] = answers.get(tuid, 0) + 1
        loc = first_decl.get(tuid)
        if loc is None or loc >= (mi, bi):
            issues.append(ValidationIssue(
                "E103", "error",
                f"tool_call_id {tuid!r} not declared in an earlier assistant message", mi, bi))
    for tid, (umi, uti) in first_decl.items():
        n = answers.get(tid, 0)
        if n == 0:
            issues.append(ValidationIssue(
                "E104", "error", f"tool_call {tid} has no tool message answer", umi, uti))
        elif n >= 2:
            issues.append(ValidationIssue(
                "E103", "error", f"tool_call {tid} answered by {n} tool messages", umi, uti))
    return issues


def check_pairing(messages) -> list[ValidationIssue]:
    """只跑配对四规则（E010/E011/E012/E013）；入参为已构造的 Message 对象。"""
    issues: list[ValidationIssue] = []
    uses: list[tuple[str, int, int]] = []
    results: list[tuple[str, int, int]] = []
    for mi, msg in enumerate(messages):
        for bi, block in enumerate(msg.content):
            if isinstance(block, ToolUseBlock):
                if msg.role == "user":
                    issues.append(ValidationIssue(
                        "E013", "error", "tool_use block is not allowed in a user message", mi, bi))
                else:
                    uses.append((block.id, mi, bi))
            elif isinstance(block, ToolResultBlock):
                if msg.role == "assistant":
                    issues.append(ValidationIssue(
                        "E013", "error", "tool_result block is not allowed in an assistant message", mi, bi))
                else:
                    results.append((block.tool_use_id, mi, bi))
    return issues + _pairing_issues(uses, results)


def check_structure(messages) -> list[ValidationIssue]:
    """对 Message 对象做基本结构检查（E001/E002/E003/E004/E010/E011/E015/E016 的对象态）。
    配对规则不在本函数（见 check_pairing）；compact 步骤 0 两者都跑。"""
    issues: list[ValidationIssue] = []
    for mi, msg in enumerate(messages):
        if not isinstance(msg, Message):
            issues.append(ValidationIssue(
                "E002", "error", f"expected Message object, got {type(msg).__name__}", mi, None))
            continue
        if msg.role not in _CANONICAL_ROLES:
            issues.append(ValidationIssue(
                "E001", "error", f"role must be 'user'|'assistant', got {msg.role!r}", mi, None))
        if not isinstance(msg.content, tuple):
            issues.append(ValidationIssue(
                "E003", "error", "Message.content must be a tuple of blocks", mi, None))
            continue
        for bi, block in enumerate(msg.content):
            if isinstance(block, TextBlock):
                if not isinstance(block.text, str):
                    issues.append(ValidationIssue(
                        "E004", "error", "text block requires a string 'text'", mi, bi))
            elif isinstance(block, ToolUseBlock):
                if not isinstance(block.id, str) or not block.id:
                    issues.append(ValidationIssue(
                        "E010", "error", "tool_use.id must be a non-empty string", mi, bi))
                if not isinstance(block.name, str) or not block.name:
                    issues.append(ValidationIssue(
                        "E010", "error", "tool_use.name must be a non-empty string", mi, bi))
                if not isinstance(block.input, dict):
                    issues.append(ValidationIssue(
                        "E016", "error", "tool_use.input must be a dict", mi, bi))
            elif isinstance(block, ToolResultBlock):
                if not isinstance(block.tool_use_id, str) or not block.tool_use_id:
                    issues.append(ValidationIssue(
                        "E011", "error", "tool_result.tool_use_id must be a non-empty string", mi, bi))
                if isinstance(block.content, tuple):
                    if any(not isinstance(t, TextBlock) for t in block.content):
                        issues.append(ValidationIssue(
                            "E015", "error", "tool_result.content only accepts text blocks", mi, bi))
                    elif any(not isinstance(t.text, str) for t in block.content):
                        issues.append(ValidationIssue(
                            "E004", "error", "nested text block requires a string 'text'", mi, bi))
                elif not isinstance(block.content, str):
                    issues.append(ValidationIssue(
                        "E003", "error", "tool_result.content must be a string or tuple of TextBlock",
                        mi, bi))
                if not isinstance(block.is_error, bool):
                    issues.append(ValidationIssue(
                        "E002", "error", "tool_result.is_error must be a boolean", mi, bi))
            else:
                issues.append(ValidationIssue(
                    "E002", "error", f"unknown block object: {type(block).__name__}", mi, bi))
    return issues

"""ucomp_bridge.py — ANMAST_Gateway 与 universal-context-compaction 的子进程桥接。

网关（Node）把规范化消息（OpenAI 风格：system/user/assistant/tool）经 stdin JSON 传入，
本脚本完成 规范化 → ucomp canonical 映射、压缩（可注入 LLM 摘要器）、canonical → 规范化
映射回，结果经 stdout JSON 返回。仅用 Python 标准库 + vendor 的 ucomp 包。

用法：
  python3 ucomp_bridge.py selfcheck            # 环境自检，输出 python/ucomp 版本
  echo '<json>' | python3 ucomp_bridge.py      # 执行压缩

stdin JSON（compact 模式）：
  {
    "messages":  [网关规范化 ChatMessage]，role ∈ system|user|assistant|tool，
                 content 为字符串或 null，assistant 可带 tool_calls，tool 带 tool_call_id，
                 多模态原始数组放 contentArray
    "policy":    {"trigger_watermark_tokens": int, "target_tokens": int}
    "artifact_dir": "外置文件目录"
    "summarizer": null 或 {"base_url","api_key","model","max_tokens"?}
  }

stdout JSON：
  {
    "ok": bool,                       # false = 桥接内部异常（调用方应原样透传消息）
    "skip": null | "empty" | "mid_system" | "multimodal" | "invalid",
    "errors": [...]                   # skip=invalid 时的校验错误码
    "triggered": bool,
    "messages": [规范化 ChatMessage] | null,   # skip 时为 null，调用方沿用原消息
    "report": {...} | null,
    "input_region_start": int | null,          # 输入坐标系中被摘要替换区域的起始下标
    "input_tail_start": int | null,            # 输入坐标系中「逐字保留尾部」的起始下标
    "summary_used": "llm" | "rule" | null
  }

约定：
  - 仅提取输入开头的连续 system 消息；中途出现 system → skip="mid_system"（安全跳过）
  - 消息粒度 1:1 映射，保证区域坐标可换算回输入坐标系
  - 任何异常都以 {ok:false, error} 退出码 0 返回，绝不抛到调用方进程外
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

# vendor 布局：本脚本与 ucomp/ 包同目录；UCOMP_HOME 可指向外部 ucomp 检出
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.environ.get("UCOMP_HOME") or _HERE)

from ucomp import (  # noqa: E402
    CompactionPolicy,
    Message,
    RuleBasedSummarizer,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    compact,
)
from ucomp.externalize import FileSystemStore  # noqa: E402
from ucomp.summarize import SUMMARIZER_PROMPT_TEMPLATE  # noqa: E402
from ucomp.types import InvalidTranscript  # noqa: E402

_LLM_TIMEOUT = 60


def _out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")


def _block_text(raw: dict) -> str:
    t = raw.get("text")
    return t if isinstance(t, str) else ""


def _has_non_text_parts(m: dict) -> bool:
    """contentArray 中存在非文本分片（图片等）→ ucomp v0 无法处理。"""
    arr = m.get("contentArray")
    if not isinstance(arr, list):
        return False
    return any(isinstance(p, dict) and p.get("type") != "text" for p in arr)


def _to_canonical(messages: list) -> tuple[list[dict], list[dict], int]:
    """规范化 → canonical dict 列表。返回 (canonical, 提取出的 system 消息, system 条数)。

    1:1 映射：assistant.tool_calls → ToolUseBlock；role:"tool" → 含 ToolResultBlock 的 user。
    中途 system 抛 _MidSystem。"""
    systems: list[dict] = []
    canonical: list[dict] = []
    for i, m in enumerate(messages):
        if not isinstance(m, dict):
            continue
        if m.get("role") == "system":
            if canonical:
                raise _MidSystem(i)
            systems.append(m)
            continue
        role = m.get("role")
        content = m.get("content")
        text = content if isinstance(content, str) else (content or "")
        blocks: list[dict] = []
        if role == "assistant":
            if text:
                blocks.append({"type": "text", "text": text})
            for tc in m.get("tool_calls") or []:
                fn = (tc or {}).get("function") or {}
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except (TypeError, ValueError):
                    args = {}
                blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id") or "",
                    "name": fn.get("name") or "",
                    "input": args if isinstance(args, dict) else {},
                })
        elif role == "tool":
            blocks.append({
                "type": "tool_result",
                "tool_use_id": m.get("tool_call_id") or "",
                "content": text or "",
                "is_error": False,
            })
        else:  # user 及未知角色一律按 user 处理
            blocks.append({"type": "text", "text": text})
        canonical.append({"role": "user" if role == "tool" else role, "content": blocks})
    return canonical, systems, len(systems)


def _from_canonical(msg: Message) -> "dict | list[dict]":
    """canonical → 规范化。user 消息可能同时含 ToolResultBlock 与 TextBlock，
    按网关 parse 的形态拆为 tool 消息 + user 消息（保持顺序）。"""
    tool_msgs: list[dict] = []
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for blk in msg.content:
        if isinstance(blk, ToolResultBlock):
            c = blk.content
            if not isinstance(c, str):
                c = "".join(b.text for b in c)
            tool_msgs.append({"role": "tool", "content": c, "tool_call_id": blk.tool_use_id})
        elif isinstance(blk, ToolUseBlock):
            tool_calls.append({
                "id": blk.id,
                "type": "function",
                "function": {"name": blk.name, "arguments": json.dumps(blk.input, ensure_ascii=False)},
            })
        elif isinstance(blk, TextBlock):
            text_parts.append(blk.text)
    text = "".join(text_parts)
    if msg.role == "assistant":
        out: dict = {"role": "assistant", "content": text or None}
        if tool_calls:
            out["tool_calls"] = tool_calls
        return out
    # user：摘要消息或普通文本；若同时携带工具结果，先 tool 后 user（与 parse.ts 的形态一致）
    out_msgs: list[dict] = list(tool_msgs)
    if text or not tool_msgs:
        out_msgs.append({"role": "user", "content": text})
    return out_msgs[0] if len(out_msgs) == 1 else out_msgs


class _MidSystem(Exception):
    def __init__(self, index: int):
        super().__init__(f"system message at non-leading index {index}")
        self.index = index


def _render_region(request) -> str:
    """把外置后的区域消息渲染成给 LLM 摘要器的纯文本转录。"""
    lines: list[str] = []
    for i, msg in enumerate(request.messages):
        parts: list[str] = []
        for blk in msg.content:
            if isinstance(blk, TextBlock):
                parts.append(blk.text)
            elif isinstance(blk, ToolUseBlock):
                parts.append(f"[调用工具 {blk.name}] {json.dumps(blk.input, ensure_ascii=False)}")
            elif isinstance(blk, ToolResultBlock):
                c = blk.content
                if not isinstance(c, str):
                    c = "".join(b.text for b in c)
                parts.append(f"[工具结果 {blk.tool_use_id}{'（错误）' if blk.is_error else ''}] {c}")
        body = "\n".join(p for p in parts if p)
        lines.append(f"### 消息 {i} · {msg.role}\n{body}")
    for rec in request.externalized:
        lines.append(
            f"[已外置] 消息 {rec.message_index} 的工具 {rec.tool} 结果（原 {rec.bytes_before} 字节）"
            f"已存盘：{rec.artifact_path}；摘要中可用其 preview：{rec.preview[:200]}"
        )
    return "\n\n".join(lines)


class _LlmThenRule:
    """LLM 摘要器：调 OpenAI 兼容接口，任何失败回退内置规则摘要器（压缩永不因此中断）。"""

    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.used = "rule"

    def __call__(self, request) -> str:
        try:
            prompt = (
                SUMMARIZER_PROMPT_TEMPLATE
                + "\n\n<被压缩的对话记录>\n" + _render_region(request) + "\n</被压缩的对话记录>\n\n"
                + "只输出摘要正文（以 8 个二级标题分节），不要任何解释。"
            )
            body = json.dumps({
                "model": self.cfg.get("model"),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": int(self.cfg.get("max_tokens") or 2000),
                "stream": False,
            }).encode("utf-8")
            req = urllib.request.Request(
                self.cfg["base_url"].rstrip("/") + "/chat/completions",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.cfg.get('api_key') or ''}",
                },
            )
            with urllib.request.urlopen(req, timeout=_LLM_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            text = text.strip()
            if text:
                self.used = "llm"
                return text
        except Exception:
            pass
        self.used = "rule"
        return RuleBasedSummarizer()(request)


def _cmd_selfcheck() -> int:
    out = {"python_version": sys.version.split()[0], "ucomp_home": os.environ.get("UCOMP_HOME") or _HERE}
    try:
        import ucomp as _u
        out["ucomp_version"] = _u.__version__
        out["available"] = True
    except Exception as exc:
        out["ucomp_version"] = None
        out["available"] = False
        out["error"] = str(exc)
    _out(out)
    return 0


def _cmd_compact() -> int:
    raw = sys.stdin.buffer.read()
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        _out({"ok": False, "error": f"stdin is not valid UTF-8 JSON: {exc}"})
        return 0

    messages = obj.get("messages")
    if not isinstance(messages, list):
        _out({"ok": False, "error": "'messages' must be a list"})
        return 0
    if not messages:
        _out({"ok": True, "skip": "empty", "triggered": False, "messages": None,
              "report": None, "input_region_start": None, "input_tail_start": None, "summary_used": None})
        return 0

    try:
        canonical, systems, n_systems = _to_canonical(messages)
    except _MidSystem as exc:
        _out({"ok": True, "skip": "mid_system", "triggered": False, "messages": None,
              "report": None, "input_region_start": None, "input_tail_start": None, "summary_used": None,
              "error": str(exc)})
        return 0
    if any(_has_non_text_parts(m) for m in messages if isinstance(m, dict)):
        _out({"ok": True, "skip": "multimodal", "triggered": False, "messages": None,
              "report": None, "input_region_start": None, "input_tail_start": None, "summary_used": None})
        return 0
    if not canonical:
        _out({"ok": True, "skip": "empty", "triggered": False, "messages": None,
              "report": None, "input_region_start": None, "input_tail_start": None, "summary_used": None})
        return 0

    pol = obj.get("policy") or {}
    try:
        kwargs: dict = {
            "trigger_watermark_tokens": int(pol.get("trigger_watermark_tokens") or 1),
            "target_tokens": int(pol.get("target_tokens") or 1),
        }
        if pol.get("min_savings_tokens") is not None:
            kwargs["min_savings_tokens"] = max(0, int(pol["min_savings_tokens"]))
        policy = CompactionPolicy(**kwargs)
        if policy.target_tokens >= policy.trigger_watermark_tokens:
            policy = CompactionPolicy(trigger_watermark_tokens=policy.trigger_watermark_tokens,
                                      target_tokens=max(1, policy.trigger_watermark_tokens - 1))
    except (TypeError, ValueError) as exc:
        _out({"ok": False, "error": f"bad policy: {exc}"})
        return 0

    summarizer = None
    if isinstance(obj.get("summarizer"), dict) and obj["summarizer"].get("model"):
        summarizer = _LlmThenRule(obj["summarizer"])

    artifact_dir = obj.get("artifact_dir") or os.path.join(_HERE, "ucomp-artifacts")
    try:
        session = [Message.from_dict(m) for m in canonical]
        result = compact(session, policy, summarizer=summarizer,
                         store=FileSystemStore(artifact_dir))
    except InvalidTranscript as exc:
        _out({"ok": True, "skip": "invalid", "triggered": False, "messages": None,
              "report": None, "input_region_start": None, "input_tail_start": None, "summary_used": None,
              "error": str(exc)})
        return 0
    except Exception as exc:  # 引擎任何异常都不允许影响网关转发
        _out({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 0

    report = result.report
    # canonical 输出 = [首条消息, 摘要, 尾窗...]（keep_first_user_message 时首条逐字保留）。
    # 换算回输入坐标：被摘要替换的区域 = [n_systems+start, n_systems+b)，
    # 逐字保留的尾部从 input_tail_start = n_systems+b 开始。
    if report.triggered and report.boundary_index is not None:
        region_start = n_systems + (1 if policy.keep_first_user_message else 0)
        input_tail_start = n_systems + report.boundary_index
    else:
        region_start = None
        input_tail_start = None

    out_messages: list[dict] = []
    out_messages.extend(systems)
    for m in result.messages:
        converted = _from_canonical(m)
        if isinstance(converted, list):
            out_messages.extend(converted)
        else:
            out_messages.append(converted)

    _out({
        "ok": True,
        "skip": None,
        "triggered": bool(report.triggered),
        "messages": out_messages,
        "report": report.to_dict(),
        "input_region_start": region_start,
        "input_tail_start": input_tail_start,
        "summary_used": (summarizer.used if summarizer is not None else "rule")
        if report.triggered else None,
    })
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "selfcheck":
        return _cmd_selfcheck()
    return _cmd_compact()


if __name__ == "__main__":
    sys.exit(main())

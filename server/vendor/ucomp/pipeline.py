"""ucomp.pipeline — compact 纯函数 / should_compact / 边界算法 / CompactionResult。

执行步骤顺序固定（§9.2）：校验 → 估 token → 水位判定 → 边界 → 缓存税守卫 →
外置 → 摘要 → 锚点 → 重组 → 终检 → 组装结果。不修改入参（C2）。
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Callable

from ucomp.anchors import extract_anchors, render_anchor_block
from ucomp.externalize import ArtifactStore, InMemoryStore, externalize_region
from ucomp.policy import CompactionPolicy
from ucomp.summarize import RegionStats, RuleBasedSummarizer, SummaryRequest, Summarizer, ToolPair
from ucomp.types import (
    ExternalizeRecord,
    InvalidTranscript,
    Message,
    Session,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    block_text_bytes,
    estimate_message_tokens,
    message_bytes,
)
from ucomp.validate import check_pairing, check_structure

__all__ = ["compact", "should_compact", "choose_boundary", "CompactionResult",
           "CompactionReport", "TriggerDecision",
           "STUB_ESTIMATE_BYTES", "SUMMARY_ESTIMATE_TOKENS"]

STUB_ESTIMATE_BYTES = 400
# 存根按 400 字节计，经 v0 启发式（4 ASCII 字节/token）折算为 token 参与步骤 5 的估算
STUB_ESTIMATE_TOKENS = STUB_ESTIMATE_BYTES // 4
SUMMARY_ESTIMATE_TOKENS = 1500

_SKIP_BELOW = "below_watermark"
_SKIP_NO_BOUNDARY = "no_valid_boundary"
_SKIP_NO_SAVINGS = "insufficient_savings"


@dataclass(frozen=True)
class TriggerDecision:
    should: bool
    reason: str  # "below_watermark" | "watermark_reached"
    tokens_estimate: int


@dataclass(frozen=True)
class CompactionReport:
    triggered: bool
    skip_reason: str | None  # None | "below_watermark" | "no_valid_boundary" | "insufficient_savings"
    tokens_before: int
    tokens_after: int        # no-op 时 == tokens_before
    estimated: bool          # token_estimator 为 None → True
    boundary_index: int | None  # 尾窗起点（输入列表坐标）
    region_messages: int
    externalized: tuple[ExternalizeRecord, ...]
    summary_bytes: int       # final_summary 的 utf8 字节数
    anchors: dict | None     # {"file_paths": n, "commands": n, "errors": n}
    projected_savings_tokens: int  # 步骤 5 的判定值
    actual_savings_tokens: int     # tokens_before - tokens_after
    over_target: bool        # tokens_after > policy.target_tokens

    def to_dict(self) -> dict:
        return {
            "triggered": self.triggered,
            "skip_reason": self.skip_reason,
            "tokens_before": self.tokens_before,
            "tokens_after": self.tokens_after,
            "estimated": self.estimated,
            "boundary_index": self.boundary_index,
            "region_messages": self.region_messages,
            "externalized": [r.to_dict() for r in self.externalized],
            "summary_bytes": self.summary_bytes,
            "anchors": dict(self.anchors) if self.anchors is not None else None,
            "projected_savings_tokens": self.projected_savings_tokens,
            "actual_savings_tokens": self.actual_savings_tokens,
            "over_target": self.over_target,
        }


@dataclass(frozen=True)
class CompactionResult:
    messages: Session    # 新列表；no-op 时为输入的深拷贝
    report: CompactionReport

    def to_dict(self) -> dict:
        return {"messages": [m.to_dict() for m in self.messages],
                "report": self.report.to_dict()}


def _default_estimator(messages) -> int:
    return sum(estimate_message_tokens(m) for m in messages)


def _straddles(messages, b: int) -> bool:
    use_ids = {blk.id for m in messages[:b] if m.role == "assistant"
               for blk in m.content if isinstance(blk, ToolUseBlock)}
    res_ids = {blk.tool_use_id for m in messages[b:] if m.role == "user"
               for blk in m.content if isinstance(blk, ToolResultBlock)}
    return bool(use_ids & res_ids)


def choose_boundary(messages, policy: CompactionPolicy) -> int | None:
    """自然边界：尾窗起点优先取 len-keep_recent；若拆散跨边界配对则逐条回退，
    把边界前的消息划入保留窗口，直到无跨界配对。tool_result 恒在 tool_use 之后，
    故区域内 use 的 result 只可能在区域内或尾窗（反向结构上不可能）。"""
    lower = 1 if policy.keep_first_user_message else 0
    if len(messages) - policy.keep_recent_messages <= lower:
        return None
    b = max(lower, len(messages) - policy.keep_recent_messages)
    while b > lower and _straddles(messages, b):
        b -= 1
    if _straddles(messages, b):
        return None  # 首条即 assistant(tool_use) 的转录不存在有效边界：安全跳过（不拆对、整体保留）
    return b


def _deepcopy_messages(messages) -> list[Message]:
    out = []
    for msg in messages:
        blocks = []
        for blk in msg.content:
            if isinstance(blk, TextBlock):
                blocks.append(TextBlock(blk.text, blk.type))
            elif isinstance(blk, ToolUseBlock):
                blocks.append(ToolUseBlock(blk.id, blk.name, copy.deepcopy(blk.input), blk.type))
            else:
                content = (tuple(TextBlock(t.text, t.type) for t in blk.content)
                           if isinstance(blk.content, tuple) else blk.content)
                blocks.append(ToolResultBlock(blk.tool_use_id, content, blk.is_error, blk.type))
        out.append(Message(msg.role, tuple(blocks)))
    return out


def _build_pairs(region) -> list[ToolPair]:
    use_by_id: dict[str, ToolUseBlock] = {}
    for msg in region:
        for blk in msg.content:
            if isinstance(blk, ToolUseBlock):
                use_by_id.setdefault(blk.id, blk)
    pairs: list[ToolPair] = []
    for mi, msg in enumerate(region):
        if msg.role != "user":
            continue
        for blk in msg.content:
            if isinstance(blk, ToolResultBlock):
                use = use_by_id.get(blk.tool_use_id)
                if use is not None:
                    pairs.append(ToolPair(use=use, result=blk, message_index=mi))
    return pairs


def _externalize_candidates(region, policy: CompactionPolicy) -> list[ToolResultBlock]:
    if not policy.enable_externalize:
        return []
    out = []
    for msg in region:
        for blk in msg.content:
            if (isinstance(blk, ToolResultBlock)
                    and block_text_bytes(blk.content) > policy.externalize_threshold_bytes):
                out.append(blk)
    return out


def _noop(messages, policy, *, reason, tokens_before, estimated,
          boundary_index=None, projected_savings=0) -> CompactionResult:
    report = CompactionReport(
        triggered=False, skip_reason=reason, tokens_before=tokens_before,
        tokens_after=tokens_before, estimated=estimated, boundary_index=boundary_index,
        region_messages=0, externalized=(), summary_bytes=0, anchors=None,
        projected_savings_tokens=projected_savings, actual_savings_tokens=0,
        over_target=tokens_before > policy.target_tokens)
    return CompactionResult(_deepcopy_messages(messages), report)


def compact(messages: Session,
            policy: CompactionPolicy,
            *,
            summarizer: Summarizer | None = None,
            store: ArtifactStore | None = None,
            token_estimator: Callable[[Session], int] | None = None) -> CompactionResult:
    """纯函数（C2）：不修改入参、无全局状态、确定性输出；副作用只经注入对象进入。"""
    issues = check_structure(messages) + check_pairing(messages)
    if issues:
        raise InvalidTranscript(issues)
    estimator = token_estimator if token_estimator is not None else _default_estimator
    estimated = token_estimator is None
    tokens_before = estimator(messages)

    # 2 水位判定
    if tokens_before < policy.trigger_watermark_tokens:
        return _noop(messages, policy, reason=_SKIP_BELOW,
                     tokens_before=tokens_before, estimated=estimated)

    # 3 边界
    b = choose_boundary(messages, policy)
    start = 1 if policy.keep_first_user_message else 0
    if b is None or b <= start:  # b==下界即区域为空，同样按无有效边界处理
        return _noop(messages, policy, reason=_SKIP_NO_BOUNDARY,
                     tokens_before=tokens_before, estimated=estimated)

    # 4 区域
    region = list(messages[start:b])

    # 5 缓存税守卫（事前判定）
    candidates = _externalize_candidates(region, policy)
    outside = list(messages[:start]) + list(messages[b:])
    projected_after = (estimator(outside)
                       + len(candidates) * STUB_ESTIMATE_TOKENS
                       + (SUMMARY_ESTIMATE_TOKENS if policy.enable_summarize else 0))
    projected_savings = tokens_before - projected_after
    if projected_savings < policy.min_savings_tokens:
        return _noop(messages, policy, reason=_SKIP_NO_SAVINGS,
                     tokens_before=tokens_before, estimated=estimated,
                     boundary_index=b, projected_savings=projected_savings)

    # 6 外置
    artifact_store = store if store is not None else InMemoryStore()
    region_ext, records = externalize_region(region, policy, artifact_store, base_sequence=0)

    # 7 摘要
    pairs = _build_pairs(region)
    summary_text = ""
    if policy.enable_summarize:
        summarizer = summarizer if summarizer is not None else RuleBasedSummarizer()
        stats = RegionStats(
            n_messages=len(region), n_pairs=len(pairs),
            bytes_original=sum(message_bytes(m) for m in region),
            bytes_after_externalize=sum(message_bytes(m) for m in region_ext))
        summary_text = summarizer(SummaryRequest(
            messages=region_ext, pairs=pairs, externalized=records,
            sections=policy.summary_sections, policy=policy, stats=stats))

    # 8 锚点
    anchor_block = ""
    anchor_counts = None
    if policy.anchors.enabled:
        anchors = extract_anchors(region, pairs, policy)
        anchor_block = render_anchor_block(anchors)
        anchor_counts = {"file_paths": len(anchors.file_paths),
                         "commands": len(anchors.commands),
                         "errors": len(anchors.errors)}
    final_summary = "\n".join(p for p in (summary_text, anchor_block) if p)

    # 9 重组：摘要为 user 角色单 text 块，插在被压区域与近期窗口之间
    new_messages = (list(messages[:start])
                    + [Message("user", (TextBlock(final_summary),))]
                    + list(messages[b:]))

    # 10 终检（防御性；触发即代码 bug）
    final_issues = check_pairing(new_messages)
    if final_issues:
        raise InvalidTranscript(final_issues)

    # 11 组装
    tokens_after = estimator(new_messages)
    report = CompactionReport(
        triggered=True, skip_reason=None, tokens_before=tokens_before,
        tokens_after=tokens_after, estimated=estimated, boundary_index=b,
        region_messages=len(region), externalized=tuple(records),
        summary_bytes=len(final_summary.encode("utf-8")), anchors=anchor_counts,
        projected_savings_tokens=projected_savings,
        actual_savings_tokens=tokens_before - tokens_after,
        over_target=tokens_after > policy.target_tokens)
    return CompactionResult(new_messages, report)


def should_compact(messages: Session,
                   policy: CompactionPolicy,
                   *,
                   token_estimator: Callable[[Session], int] | None = None) -> TriggerDecision:
    """低频轮询出口：只估 token 比水位，不做任何变换、不落盘。"""
    estimator = token_estimator if token_estimator is not None else _default_estimator
    tokens = estimator(messages)
    should = tokens >= policy.trigger_watermark_tokens
    return TriggerDecision(should, "watermark_reached" if should else "below_watermark", tokens)

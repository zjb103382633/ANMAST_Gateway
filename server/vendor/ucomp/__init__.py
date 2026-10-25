"""ucomp — 通用上下文压缩引擎 v0 公共出口（唯一对外面，§2.2）。

适配器只准使用本出口的公共 API + CLI；import 内部模块视为违约（§1.6）。
"""
from ucomp.types import (
    ExternalizeRecord,
    InvalidTranscript,
    Message,
    Session,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    ValidationIssue,
)
from ucomp.policy import AnchorConfig, CompactionPolicy
from ucomp.classifier import ToolCategory
from ucomp.externalize import ArtifactStore, FileSystemStore, InMemoryStore
from ucomp.summarize import RuleBasedSummarizer, SummaryRequest, Summarizer
from ucomp.validate import check_pairing, validate_messages
from ucomp.pipeline import (
    CompactionReport,
    CompactionResult,
    TriggerDecision,
    compact,
    should_compact,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # 类型
    "Message", "TextBlock", "ToolUseBlock", "ToolResultBlock", "Session",
    # 策略
    "CompactionPolicy", "AnchorConfig",
    # 管线
    "compact", "should_compact", "CompactionResult", "CompactionReport",
    "TriggerDecision",
    # 外置
    "ArtifactStore", "FileSystemStore", "InMemoryStore",
    "ExternalizeRecord", "ToolCategory",
    # 摘要
    "Summarizer", "SummaryRequest", "RuleBasedSummarizer",
    # 校验
    "validate_messages", "check_pairing", "InvalidTranscript", "ValidationIssue",
]

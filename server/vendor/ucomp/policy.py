"""ucomp.policy — CompactionPolicy / AnchorConfig / 默认值 / JSON 互转（严格键）。

策略是纯数据（可 JSON 序列化）；Summarizer/ArtifactStore/token_estimator 等运行时
注入对象不进 policy（docs/engine-api.md §1.2、§4）。字段即契约，逐字对齐 §4.1。
"""
from __future__ import annotations

from dataclasses import dataclass, field, fields as dc_fields


class PolicyError(ValueError):
    """策略键未知（strict 模式）或值非法。"""


@dataclass(frozen=True)
class AnchorConfig:
    enabled: bool = True
    max_file_paths: int = 15
    max_commands: int = 10
    max_errors: int = 8


@dataclass(frozen=True)
class CompactionPolicy:
    trigger_watermark_tokens: int = 120_000
    target_tokens: int = 64_000
    min_savings_tokens: int = 16_000
    keep_recent_messages: int = 8
    keep_first_user_message: bool = True
    externalize_threshold_bytes: int = 20_000
    enable_externalize: bool = True
    enable_summarize: bool = True
    anchors: AnchorConfig = field(default_factory=AnchorConfig)
    summary_sections: tuple[str, ...] = (
        "goal", "concepts", "files", "errors", "todos", "current", "next", "reread")
    section_byte_caps: dict[str, int] = field(default_factory=lambda: {
        "goal": 1500, "concepts": 800, "files": 1200, "errors": 1500,
        "todos": 600, "current": 800, "next": 600, "reread": 1200,
    })
    file_tool_names: tuple[str, ...] = (
        "read", "read_file", "Read", "view", "View", "open", "cat", "read_many_files")
    rerunnable_tool_names: tuple[str, ...] = (
        "bash", "Bash", "shell", "execute_command", "run_command", "run_terminal_cmd", "terminal")

    def __post_init__(self):
        if not (self.trigger_watermark_tokens > self.target_tokens > 0):
            raise PolicyError(
                f"require trigger_watermark_tokens > target_tokens > 0, "
                f"got {self.trigger_watermark_tokens} / {self.target_tokens}")
        if self.min_savings_tokens < 0:
            raise PolicyError(f"min_savings_tokens must be >= 0, got {self.min_savings_tokens}")
        if self.keep_recent_messages < 1:
            raise PolicyError(f"keep_recent_messages must be >= 1, got {self.keep_recent_messages}")
        if self.externalize_threshold_bytes < 1:
            raise PolicyError(
                f"externalize_threshold_bytes must be >= 1, got {self.externalize_threshold_bytes}")

    def to_dict(self) -> dict:
        return {
            "trigger_watermark_tokens": self.trigger_watermark_tokens,
            "target_tokens": self.target_tokens,
            "min_savings_tokens": self.min_savings_tokens,
            "keep_recent_messages": self.keep_recent_messages,
            "keep_first_user_message": self.keep_first_user_message,
            "externalize_threshold_bytes": self.externalize_threshold_bytes,
            "enable_externalize": self.enable_externalize,
            "enable_summarize": self.enable_summarize,
            "anchors": {f.name: getattr(self.anchors, f.name) for f in dc_fields(AnchorConfig)},
            "summary_sections": list(self.summary_sections),
            "section_byte_caps": dict(self.section_byte_caps),
            "file_tool_names": list(self.file_tool_names),
            "rerunnable_tool_names": list(self.rerunnable_tool_names),
        }

    @classmethod
    def from_dict(cls, obj, *, strict: bool = True) -> "CompactionPolicy":
        """strict 模式遇未知键抛 PolicyError（防拼写错误静默生效）；缺省键取默认值；
        anchors 嵌套 dict 合并语义：给定的键覆盖默认，未给定的保持默认。"""
        if not isinstance(obj, dict):
            raise PolicyError(f"policy must be a JSON object, got {type(obj).__name__}")
        kwargs: dict = {}
        for f in dc_fields(cls):
            if f.name not in obj:
                continue
            kwargs[f.name] = _coerce_value(f.name, obj[f.name])
        unknown = [k for k in obj if k not in {f.name for f in dc_fields(cls)}]
        if unknown and strict:
            raise PolicyError(f"unknown policy key(s): {', '.join(sorted(unknown))}")
        if "anchors" in kwargs:
            kwargs["anchors"] = _merge_anchors(kwargs.pop("anchors"), strict=strict)
        return cls(**kwargs)


_ANCHOR_INT = ("max_file_paths", "max_commands", "max_errors")


def _merge_anchors(given, *, strict: bool) -> AnchorConfig:
    if not isinstance(given, dict):
        raise PolicyError(f"anchors must be a JSON object, got {type(given).__name__}")
    known = {f.name for f in dc_fields(AnchorConfig)}
    unknown = [k for k in given if k not in known]
    if unknown and strict:
        raise PolicyError(f"unknown anchors key(s): {', '.join(sorted(unknown))}")
    kwargs = {}
    for f in dc_fields(AnchorConfig):
        if f.name in given:
            kwargs[f.name] = _coerce_anchor_value(f.name, given[f.name])
    return AnchorConfig(**kwargs)


def _reject_bool(name: str, value):
    if isinstance(value, bool):
        raise PolicyError(f"policy.{name} must be {int.__name__}, got bool")


def _coerce_int(name: str, value) -> int:
    _reject_bool(name, value)
    if not isinstance(value, int):
        raise PolicyError(f"policy.{name} must be an integer, got {type(value).__name__}")
    return value


def _coerce_bool(name: str, value) -> bool:
    if not isinstance(value, bool):
        raise PolicyError(f"policy.{name} must be a boolean, got {type(value).__name__}")
    return value


def _coerce_str_tuple(name: str, value) -> tuple[str, ...]:
    if isinstance(value, str) or not isinstance(value, (list, tuple)):
        raise PolicyError(f"policy.{name} must be a list of strings, got {type(value).__name__}")
    for item in value:
        if not isinstance(item, str):
            raise PolicyError(f"policy.{name} must contain only strings, got {item!r}")
    return tuple(value)


_INT_FIELDS = ("trigger_watermark_tokens", "target_tokens", "min_savings_tokens",
               "keep_recent_messages", "externalize_threshold_bytes")
_BOOL_FIELDS = ("keep_first_user_message", "enable_externalize", "enable_summarize")
_STR_TUPLE_FIELDS = ("summary_sections", "file_tool_names", "rerunnable_tool_names")


def _coerce_value(name: str, value):
    if name in _INT_FIELDS:
        return _coerce_int(name, value)
    if name in _BOOL_FIELDS:
        return _coerce_bool(name, value)
    if name in _STR_TUPLE_FIELDS:
        return _coerce_str_tuple(name, value)
    if name == "section_byte_caps":
        if not isinstance(value, dict):
            raise PolicyError(f"policy.{name} must be an object, got {type(value).__name__}")
        out = {}
        for k, v in value.items():
            if not isinstance(k, str):
                raise PolicyError(f"policy.{name} keys must be strings, got {k!r}")
            out[k] = _coerce_int(f"{name}.{k}", v)
        return out
    if name == "anchors":
        return value  # 由 _merge_anchors 处理
    raise PolicyError(f"unknown policy key: {name}")


def _coerce_anchor_value(name: str, value):
    if name == "enabled":
        return _coerce_bool(f"anchors.{name}", value)
    return _coerce_int(f"anchors.{name}", value)

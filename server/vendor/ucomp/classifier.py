"""ucomp.classifier — tool_result 可再生性分类（file / rerunnable / other）。

不做内容正则猜测（脆弱且不可移植）；外置对三类都执行，分类只影响存根文案、
可重读文件清单与锚点命令行来源（docs/engine-api.md §5）。
"""
from __future__ import annotations

from ucomp.policy import CompactionPolicy
from ucomp.types import ToolUseBlock

ToolCategory = str  # "file" | "rerunnable" | "other"

_FILE_KEYS = ("file_path", "path", "filename")
_COMMAND_KEYS = ("command", "cmd")


def classify_pair(use: ToolUseBlock, policy: CompactionPolicy) -> ToolCategory:
    """判定规则按序首条命中即返回，确定性：
    1) 工具名不区分大小写精确匹配 file_tool_names → "file"；
    2) 匹配 rerunnable_tool_names → "rerunnable"；
    3) input 含 str 类型的 "command"/"cmd" → "rerunnable"；
    4) input 含 str 类型的 "file_path"/"path"/"filename" → "file"；
    5) 否则 "other"。"""
    name = use.name.lower()
    if any(name == n.lower() for n in policy.file_tool_names):
        return "file"
    if any(name == n.lower() for n in policy.rerunnable_tool_names):
        return "rerunnable"
    inp = use.input if isinstance(use.input, dict) else {}
    if any(isinstance(inp.get(k), str) for k in _COMMAND_KEYS):
        return "rerunnable"
    if any(isinstance(inp.get(k), str) for k in _FILE_KEYS):
        return "file"
    return "other"


def pair_command(use: ToolUseBlock) -> str | None:
    """取 input["command"] 或 input["cmd"]（str 才收），无则 None。"""
    inp = use.input if isinstance(use.input, dict) else {}
    for k in _COMMAND_KEYS:
        v = inp.get(k)
        if isinstance(v, str):
            return v
    return None

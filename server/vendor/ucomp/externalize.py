"""ucomp.externalize — ArtifactStore 抽象 + FileSystemStore / InMemoryStore + 存根生成。

铁律 1（C6）：外置只把 ToolResultBlock.content 替换为含落盘路径的占位存根，
不删消息、不改 tool_use、不动 tool_use_id / is_error（docs/engine-api.md §6）。
"""
from __future__ import annotations

import abc
import hashlib
import os
import re

from ucomp.classifier import ToolCategory, classify_pair, pair_command
from ucomp.policy import CompactionPolicy
from ucomp.types import (
    ExternalizeRecord,
    Message,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    block_text_bytes,
)

__all__ = ["ArtifactStore", "FileSystemStore", "InMemoryStore", "ExternalizeRecord",
           "externalize_region"]


class ArtifactStore(abc.ABC):
    @abc.abstractmethod
    def save(self, *, tool: str, category: ToolCategory, content: str,
             sequence: int) -> tuple[str, str]:
        """保存原始内容，返回 (绝对路径, sha256_hex)。子类必须实现。"""


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)[:24]


class FileSystemStore(ArtifactStore):
    def __init__(self, root_dir: str):
        self.root_dir = root_dir

    def save(self, *, tool, category, content, sequence):
        os.makedirs(self.root_dir, exist_ok=True)
        sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        path = os.path.join(self.root_dir, f"{sequence:04d}-{_slug(tool)}-{sha[:8]}.txt")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return os.path.abspath(path), sha


class InMemoryStore(ArtifactStore):
    """测试与无盘环境用；save 只算 sha 不落盘。"""

    def save(self, *, tool, category, content, sequence):
        sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        return f"memory://{sequence:04d}", sha


def _content_to_text(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(t.text for t in content)


_STUB_TRAILER = {
    "file": "如需内容请重新读取原文件或上述存盘文件。",
    "rerunnable": "如需结果请重跑上述命令或读取存盘文件。",
    "other": "如需内容请读取上述存盘文件（原上下文已不含该内容）。",
}


def render_stub(tool: str, category: ToolCategory, bytes_before: int, sha256: str,
                artifact_path: str, command: str | None) -> str:
    """存根模板逐字对齐 §6.4：千分位逗号；sha256 前 8 位 + …；绝对路径；
    rerunnable 且无命令时省略「命令」行。"""
    noun = "该命令输出" if category == "rerunnable" else "该工具结果"
    lines = [
        f"[外部化] {noun}（原 {bytes_before:,} 字节）未随上下文发送，原文已存盘：",
        f"tool={tool}  分类={category}  sha256={sha256[:8]}…",
    ]
    if category == "rerunnable" and command:
        lines.append(f"命令：{command}")
    lines.append(f"原文路径：{artifact_path}")
    lines.append(_STUB_TRAILER.get(category, _STUB_TRAILER["other"]))
    return "\n".join(lines)


def externalize_region(region, policy: CompactionPolicy, store: ArtifactStore, *,
                       base_sequence: int = 0):
    """对区域内超阈值的 tool_result 执行外置，返回 (新区域消息列表, 外置记录列表)。

    不修改入参；消息条数、顺序、角色、同消息内其他 block 一律不动。
    序号从 base_sequence+1 起算（1-based），保证跨多次压缩文件名不冲突。"""
    if not policy.enable_externalize:
        return list(region), []
    use_by_id: dict[str, ToolUseBlock] = {}
    for msg in region:
        for blk in msg.content:
            if isinstance(blk, ToolUseBlock):
                use_by_id.setdefault(blk.id, blk)
    new_region: list[Message] = []
    records: list[ExternalizeRecord] = []
    seq = base_sequence
    for mi, msg in enumerate(region):
        blocks = []
        replaced = False
        for blk in msg.content:
            if isinstance(blk, ToolResultBlock):
                nbytes = block_text_bytes(blk.content)
                if nbytes > policy.externalize_threshold_bytes:
                    use = use_by_id.get(blk.tool_use_id)
                    tool = use.name if use is not None else "unknown"
                    category = classify_pair(use, policy) if use is not None else "other"
                    text = _content_to_text(blk.content)
                    seq += 1
                    artifact_path, sha = store.save(tool=tool, category=category,
                                                    content=text, sequence=seq)
                    stub = render_stub(tool, category, nbytes, sha, artifact_path,
                                       pair_command(use) if use is not None else None)
                    preview = text.encode("utf-8")[:200].decode("utf-8", errors="replace")
                    blocks.append(ToolResultBlock(blk.tool_use_id, stub, blk.is_error))
                    records.append(ExternalizeRecord(
                        message_index=mi, tool_use_id=blk.tool_use_id, tool=tool,
                        category=category, bytes_before=nbytes,
                        artifact_path=artifact_path, sha256=sha, preview=preview))
                    replaced = True
                    continue
            blocks.append(blk)
        new_region.append(Message(msg.role, tuple(blocks)) if replaced else msg)
    return new_region, records

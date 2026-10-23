"""ucomp.cli — argparse + stdin/stdout JSON + 退出码（全部 CLI 逻辑在这）。

退出码：0 成功（含 no-op 压缩）；1 校验失败；2 用法或 IO 错误。
stdout 只写机器 JSON，stderr 只写人类可读错误，二者严格分离（§11.1）。
CLI 只能用 RuleBasedSummarizer（回调无法跨进程注入）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from ucomp.pipeline import compact
from ucomp.policy import CompactionPolicy, PolicyError
from ucomp.types import InvalidTranscript, Message, estimate_message_tokens
from ucomp.validate import validate_messages

EXIT_OK = 0
EXIT_INVALID = 1
EXIT_USAGE = 2

_DEFAULT_ARTIFACT_DIR = "./ucomp-artifacts"


class _UsageError(Exception):
    """stdin/信封/文件等用法或 IO 错误 → 退出码 2。"""


def _dump(obj, indent: int | None) -> str:
    if indent is None:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(obj, ensure_ascii=False, indent=indent)


def _read_stdin_json():
    data = sys.stdin.buffer.read()
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _UsageError(f"stdin is not valid UTF-8 JSON: {exc}") from exc


def _issue_to_dict(issue) -> dict:
    return {"code": issue.code, "severity": issue.severity, "message": issue.message,
            "message_index": issue.message_index, "block_index": issue.block_index}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ucomp", description="通用上下文压缩引擎 v0")
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate", help="校验消息列表（三种方言）")
    p_validate.add_argument("--dialect", choices=["canonical", "anthropic", "openai"], default=None)
    p_validate.add_argument("--indent", type=int, default=None)
    p_validate.set_defaults(func=_cmd_validate)

    p_compact = sub.add_parser("compact", help="执行压缩管线")
    p_compact.add_argument("--policy", default=None, help="策略 JSON 文件路径")
    p_compact.add_argument("--artifact-dir", default=None, help="外置文件目录（缺省 ./ucomp-artifacts）")
    p_compact.add_argument("--dialect", choices=["canonical"], default=None)
    p_compact.add_argument("--indent", type=int, default=None)
    p_compact.set_defaults(func=_cmd_compact)

    p_policy = sub.add_parser("policy", help="输出默认策略 JSON")
    p_policy.add_argument("--indent", type=int, default=None)
    p_policy.set_defaults(func=_cmd_policy)
    return parser


def _cmd_validate(args) -> int:
    obj = _read_stdin_json()
    stdin_dialect = None
    if isinstance(obj, dict) and "dialect" in obj:
        stdin_dialect = obj["dialect"]
        if not isinstance(stdin_dialect, str):
            raise _UsageError("stdin 'dialect' must be a string")
    dialect = stdin_dialect or args.dialect or "canonical"  # 优先级：stdin 字段 > CLI 旗标 > 默认
    issues = validate_messages(obj, dialect=dialect)
    errors = [i for i in issues if i.severity == "error"]
    message_count = len(obj["messages"] if isinstance(obj, dict) else obj)
    estimated_tokens = None
    if not errors and dialect in ("canonical", "anthropic"):
        estimated_tokens = 0
        for raw in (obj["messages"] if isinstance(obj, dict) else obj):
            estimated_tokens += estimate_message_tokens(Message.from_dict(raw, dialect=dialect))
    out = {
        "ok": not errors,
        "dialect": dialect,
        "message_count": message_count,
        "estimated_tokens": estimated_tokens,
        "errors": [_issue_to_dict(i) for i in issues],
    }
    print(_dump(out, args.indent))
    return EXIT_OK if not errors else EXIT_INVALID


def _load_policy(args, stdin_obj) -> CompactionPolicy:
    # 优先级：stdin 字段 > CLI 旗标 > 默认值
    if "policy" in stdin_obj:
        raw = stdin_obj["policy"]
        if not isinstance(raw, dict):
            raise _UsageError("stdin 'policy' must be a JSON object")
    elif args.policy:
        try:
            with open(args.policy, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            raise _UsageError(f"cannot read policy file {args.policy!r}: {exc}") from exc
    else:
        raw = {}
    return CompactionPolicy.from_dict(raw, strict=True)


def _cmd_compact(args) -> int:
    obj = _read_stdin_json()
    if not isinstance(obj, dict):
        raise _UsageError("compact stdin must be a JSON object with a 'messages' key")
    raw_messages = obj.get("messages")
    if not isinstance(raw_messages, list):
        raise _UsageError("'messages' must be a list")
    if "artifact_dir" in obj and not isinstance(obj["artifact_dir"], str):
        raise _UsageError("'artifact_dir' must be a string")

    issues = validate_messages(raw_messages, dialect="canonical")
    errors = [i for i in issues if i.severity == "error"]
    if errors:
        print(_dump({"ok": False, "errors": [_issue_to_dict(i) for i in issues]}, args.indent))
        return EXIT_INVALID

    policy = _load_policy(args, obj)
    artifact_dir = obj.get("artifact_dir") or args.artifact_dir or _DEFAULT_ARTIFACT_DIR

    try:
        session = [Message.from_dict(raw) for raw in raw_messages]
    except InvalidTranscript as exc:
        print(_dump({"ok": False, "errors": [_issue_to_dict(i) for i in exc.issues]}, args.indent))
        return EXIT_INVALID

    from ucomp.externalize import FileSystemStore
    result = compact(session, policy, store=FileSystemStore(artifact_dir))

    out = {
        "ok": True,
        "messages": [m.to_dict() for m in result.messages],
        "report": result.report.to_dict(),
        "artifacts_dir": os.path.abspath(artifact_dir),
    }
    print(_dump(out, args.indent))
    return EXIT_OK


def _cmd_policy(args) -> int:
    indent = 2 if args.indent is None else args.indent
    print(json.dumps(CompactionPolicy().to_dict(), ensure_ascii=False,
                     indent=indent, sort_keys=True))
    return EXIT_OK


def main(argv=None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except InvalidTranscript as exc:
        print(f"ucomp: invalid transcript:\n{exc}", file=sys.stderr)
        return EXIT_INVALID
    except (_UsageError, PolicyError, ValueError, OSError) as exc:
        print(f"ucomp: error: {exc}", file=sys.stderr)
        return EXIT_USAGE

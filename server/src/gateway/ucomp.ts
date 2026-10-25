import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ChatMessage, ModelConfig } from "../types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  getConversationCompaction,
  upsertConversationCompaction,
} from "../db/repos/compactions.js";
import { listEnabledModels } from "../routing/index.js";
import { estimateMessagesTokens, type CompressionConfig } from "./compress.js";
import { msgSignature } from "./msgsig.js";

/** 桥接脚本输出（见 server/vendor/ucomp_bridge.py 头部注释） */
interface BridgeResult {
  ok: boolean;
  error?: string;
  skip?: "empty" | "mid_system" | "multimodal" | "invalid" | null;
  triggered?: boolean;
  messages?: ChatMessage[] | null;
  report?: {
    tokens_before: number;
    tokens_after: number;
    boundary_index: number | null;
    [k: string]: unknown;
  } | null;
  input_region_start?: number | null;
  input_tail_start?: number | null;
  summary_used?: "llm" | "rule" | null;
}

interface BridgeSummarizer {
  base_url: string;
  api_key: string;
  model: string;
}

export interface AutoCompressResult {
  messages: ChatMessage[];
  beforeTokens: number;
  afterTokens: number;
  /** 是否发生了压缩（缓存命中或本次压缩） */
  changed: boolean;
}

/** 模型的压缩参考上限：max_context_tokens 优先，回退 context_window；两者都无效返回 null */
export function autoCompressLimit(model: ModelConfig): number | null {
  const base = model.max_context_tokens ?? model.context_window;
  return base && base > 0 ? base : null;
}

/** 模型是否开启了按模型自动压缩（且配置了可用上限） */
export function modelAutoCompressEnabled(model: ModelConfig): boolean {
  return model.auto_compress === 1 && autoCompressLimit(model) !== null;
}

function prefixHash(messages: ChatMessage[], count: number): string {
  const h = createHash("sha256");
  for (let i = 0; i < count && i < messages.length; i++) {
    h.update(msgSignature(messages[i]));
    h.update("\u0001");
  }
  return h.digest("hex");
}

function runBridge(payload: unknown, timeoutMs = 120_000): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const child = spawn(config.ucompPython, [config.ucompBridge], {
      env: { ...process.env, UCOMP_HOME: config.ucompHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (r: BridgeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `ucomp bridge timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.on("error", (e) => finish({ ok: false, error: `无法启动 ucomp 桥接：${e.message}` }));
    child.on("close", () => {
      try {
        const line = stdout.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(line) as BridgeResult;
        finish(parsed);
      } catch {
        finish({ ok: false, error: `ucomp bridge 输出无法解析：${stdout.slice(0, 200)}` });
      }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/** ucomp 环境自检（设置页展示用） */
export async function ucompSelfCheck(): Promise<{
  available: boolean;
  python_version?: string;
  ucomp_version?: string | null;
  error?: string;
}> {
  const child = spawn(config.ucompPython, [config.ucompBridge, "selfcheck"], {
    env: { ...process.env, UCOMP_HOME: config.ucompHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (r: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r as never);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ available: false, error: "selfcheck timeout" });
    }, 10_000);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.on("error", (e) => resolve({ available: false, error: e.message }));
    child.on("close", () => {
      try {
        finish(JSON.parse(stdout.trim().split("\n").pop() ?? "{}"));
      } catch {
        finish({ available: false, error: `selfcheck 输出无法解析：${stdout.slice(0, 200)}` });
      }
    });
  });
}

/** 解析 ucomp 摘要模型：仅支持 OpenAI 兼容供应商（直连，不经网关自身路由） */
function resolveSummarizer(cfg: CompressionConfig): BridgeSummarizer | null {
  const name = (cfg.ucomp_summary_model ?? "").trim();
  if (!name) return null;
  const target = listEnabledModels().find(
    (m) => m.model.name === name || m.model.id === name || m.model.display_name === name,
  );
  if (!target) {
    logger.warn(`[自动压缩] 摘要模型 ${name} 不存在或未启用，回退内置规则摘要器`);
    return null;
  }
  const base = target.provider.openai_base_url || (target.provider.type === "openai" ? target.provider.base_url : "");
  if (!base) {
    logger.warn(`[自动压缩] 摘要模型 ${name} 的供应商不支持 OpenAI 兼容接口，回退内置规则摘要器`);
    return null;
  }
  return { base_url: base, api_key: target.provider.api_key, model: target.model.name };
}

/**
 * 按模型自动压缩：估算上下文 token，达到「上限 × 触发阈值%」时先查会话压缩缓存
 * （历史前缀未变直接复用摘要），未命中则交给 ucomp 桥接压缩。任何失败原样返回。
 */
export async function autoCompressIfNeeded(
  messages: ChatMessage[],
  model: ModelConfig,
  conversationId: string,
  cfg: CompressionConfig,
): Promise<AutoCompressResult> {
  const before = estimateMessagesTokens(messages);
  const unchanged: AutoCompressResult = { messages, beforeTokens: before, afterTokens: before, changed: false };
  const limit = autoCompressLimit(model);
  if (!limit) return unchanged;

  const pct = Math.min(100, Math.max(1, cfg.auto_threshold_percent ?? 80));
  const threshold = Math.floor((limit * pct) / 100);
  if (before < threshold) return unchanged;

  // 1) 会话缓存命中：前 N 条消息签名哈希一致 → 直接用上次的摘要拼接尾部
  const cached = getConversationCompaction(conversationId);
  if (cached && cached.input_region_start >= 1 && messages.length >= cached.input_boundary_index) {
    const tailStart = cached.input_boundary_index;
    if (prefixHash(messages, tailStart) === cached.prefix_hash) {
      const spliced: ChatMessage[] = [
        ...messages.slice(0, cached.input_region_start ?? 1),
        { role: "user", content: cached.summary_content },
        ...messages.slice(tailStart),
      ];
      const after = estimateMessagesTokens(spliced);
      if (after < threshold) {
        logger.info(
          `[自动压缩] 会话 ${conversationId} 缓存命中：${before} -> ${after} tokens（阈值 ${threshold}，模型 ${model.name}）`,
        );
        return { messages: spliced, beforeTokens: before, afterTokens: after, changed: true };
      }
      logger.info(`[自动压缩] 会话 ${conversationId} 缓存命中后仍超阈值（${after} >= ${threshold}），重新压缩`);
    }
  }

  // 2) 全量压缩：交给 ucomp 桥接
  const policy = {
    trigger_watermark_tokens: threshold,
    target_tokens: Math.max(1, Math.floor(threshold * 0.6)),
    // 缓存税守卫：预计节省低于阈值 10%（上限 16000、下限 512）时不压
    min_savings_tokens: Math.max(512, Math.min(16_000, Math.round(threshold * 0.1))),
  };
  const res = await runBridge({
    messages,
    policy,
    artifact_dir: config.compactionDir,
    summarizer: resolveSummarizer(cfg),
  });
  if (
    !res.ok ||
    res.skip ||
    !res.triggered ||
    !Array.isArray(res.messages) ||
    typeof res.input_tail_start !== "number" ||
    typeof res.input_region_start !== "number"
  ) {
    logger.warn(
      `[自动压缩] 会话 ${conversationId} 未压缩（${res.skip ?? res.error ?? "not triggered"}），消息原样转发`,
    );
    return unchanged;
  }

  const summaryContent = extractSummaryContent(res.messages, res.input_region_start, res.input_tail_start);
  if (summaryContent === null) {
    logger.warn(`[自动压缩] 会话 ${conversationId} 未能定位摘要消息，跳过压缩缓存写入`);
  } else {
    upsertConversationCompaction({
      conversation_id: conversationId,
      input_region_start: res.input_region_start,
      input_boundary_index: res.input_tail_start,
      prefix_hash: prefixHash(messages, res.input_tail_start),
      summary_content: summaryContent,
      tokens_before: res.report?.tokens_before ?? before,
      tokens_after: res.report?.tokens_after ?? null,
    });
  }
  logger.info(
    `[自动压缩] 会话 ${conversationId} 已压缩：${res.report?.tokens_before ?? before} -> ${res.report?.tokens_after ?? "?"} tokens` +
      `（阈值 ${threshold}，模型 ${model.name}，摘要=${res.summary_used ?? "rule"}）`,
  );
  return {
    messages: res.messages,
    beforeTokens: before,
    afterTokens: res.report?.tokens_after ?? before,
    changed: true,
  };
}

/** 从桥接输出中取摘要消息内容。输出坐标 = 输入[0, regionStart) + [摘要] + 输入[tailStart:)，
 *  摘要消息在输出下标 regionStart；找不到（结构异常）返回 null，调用方跳过缓存写入。 */
function extractSummaryContent(
  outMessages: ChatMessage[],
  regionStart: number,
  tailStart: number,
): string | null {
  const summary = outMessages[regionStart];
  if (
    summary &&
    summary.role === "user" &&
    typeof summary.content === "string" &&
    summary.content &&
    regionStart < tailStart
  ) {
    return summary.content;
  }
  return null;
}

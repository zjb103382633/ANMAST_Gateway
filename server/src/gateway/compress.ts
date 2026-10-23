import type { ChatMessage } from "../types.js";
import { getSetting, setSetting } from "../db/index.js";
import { listEnabledModels } from "../routing/index.js";
import { getAdapterForProtocol, getUpstreamProtocol } from "../providers/index.js";
import { logger } from "../logger.js";

export interface CompressionConfig {
  enabled: boolean;
  anchor_messages: number; // 头部锚点保留条数（attention sink 的 prompt 版）
  window_messages: number; // 近期保留条数
  summarize_middle: boolean; // 中间部分：true=摘要，false=直接丢弃
  summary_model: string; // 摘要模型名（留空则自动选第一个可路由模型）
  auto_threshold_percent: number; // 按模型自动压缩：触发阈值 = 上下文上限 × 该百分比
  ucomp_summary_model: string; // ucomp LLM 摘要模型名（留空=内置规则摘要器，不调模型）
}

export const DEFAULT_COMPRESSION: CompressionConfig = {
  enabled: false,
  anchor_messages: 4,
  window_messages: 20,
  summarize_middle: false,
  summary_model: "",
  auto_threshold_percent: 80,
  ucomp_summary_model: "",
};

const SETTINGS_KEY = "compression_config";

export function getCompressionConfig(): CompressionConfig {
  const raw = getSetting<Partial<CompressionConfig>>(SETTINGS_KEY, {}) ?? {};
  return { ...DEFAULT_COMPRESSION, ...raw };
}

export function saveCompressionConfig(cfg: CompressionConfig): void {
  setSetting(SETTINGS_KEY, cfg);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf-8") / 4));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content ?? "");
    for (const tc of m.tool_calls ?? []) {
      total += estimateTokens(tc.function?.name ?? "");
      total += estimateTokens(tc.function?.arguments ?? "");
    }
  }
  return total;
}

/** 用低成本模型把中间历史摘要成一段文本；失败返回空串（等价于丢弃） */
async function summarizeMiddle(messages: ChatMessage[], summaryModel: string): Promise<string> {
  const models = listEnabledModels();
  if (!models.length) return "";
  let target = models.find(
    (m) =>
      summaryModel && (m.model.name === summaryModel || m.model.id === summaryModel || m.model.display_name === summaryModel),
  );
  if (!target) {
    // 留空：使用复杂度判定模型
    const routerId = getSetting<string>("router_model_id");
    if (routerId) {
      target = models.find((m) => m.model.id === routerId || m.model.name === routerId);
    }
  }
  if (!target) target = models.find((m) => m.model.usage === "normal") ?? models[0];
  if (!target) return "";

  const text = messages
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n")
    .slice(0, 60000);
  if (!text.trim()) return "";

  try {
    const adapter = getAdapterForProtocol(getUpstreamProtocol(target.provider, "openai"));
    const res = await adapter.chat({
      model: target.model.name,
      messages: [
        {
          role: "system",
          content:
            "你是对话压缩器。请把下面的对话历史压缩成一段简洁中文摘要，保留：任务目标、已完成步骤、重要结论/数据、待办事项、关键错误信息。只输出摘要文本，不要解释。",
        },
        { role: "user", content: text },
      ],
      stream: false,
      maxTokens: 800,
      temperature: 0,
      extra: { __provider: target.provider },
    });
    return res.message.content ?? "";
  } catch (e) {
    logger.warn("上下文摘要失败，回退为丢弃中间历史", e);
    return "";
  }
}

export interface CompressResult {
  messages: ChatMessage[];
  beforeTokens: number;
  afterTokens: number;
}

/**
 * 方案 E：头部锚点 + 近期窗口 + 中间摘要/丢弃。
 * 仅压缩「历史」部分，保证 tool_use/tool_result 成对保留。
 */
export async function compressMessages(messages: ChatMessage[], cfg: CompressionConfig): Promise<CompressResult> {
  const before = estimateMessagesTokens(messages);
  if (!cfg.enabled || messages.length <= cfg.anchor_messages + cfg.window_messages) {
    return { messages, beforeTokens: before, afterTokens: before };
  }

  const anchor = messages.slice(0, Math.max(0, cfg.anchor_messages));
  const window = messages.slice(-Math.max(0, cfg.window_messages));
  const middle = messages.slice(anchor.length, messages.length - window.length);

  // 确保 tool_result 不会与 tool_use 分离：把锚点/窗口边界对齐到成对消息
  const alignedAnchor = trimToToolPair(anchor, "tail");
  const alignedWindow = trimToToolPair(window, "head");
  const middle2 = messages.slice(alignedAnchor.length, messages.length - alignedWindow.length);

  let replacement: ChatMessage[] = [];
  if (cfg.summarize_middle && middle2.length) {
    const summary = await summarizeMiddle(middle2, cfg.summary_model);
    if (summary) {
      replacement = [{ role: "user", content: `[更早的对话摘要]\n${summary}` }];
    }
  }

  const compressed = [...alignedAnchor, ...replacement, ...alignedWindow];
  const after = estimateMessagesTokens(compressed);
  return { messages: compressed, beforeTokens: before, afterTokens: after };
}

/** 对齐工具调用链：从 head/tail 方向裁掉不完整的多余消息，保证 tool_use 与 tool_result 成对 */
function trimToToolPair(msgs: ChatMessage[], side: "head" | "tail"): ChatMessage[] {
  const out = [...msgs];
  if (side === "tail") {
    // 从尾部去掉孤儿 tool_result（没有对应 tool_use 的）
    while (out.length && out[out.length - 1].role === "tool") out.pop();
  } else {
    // 从头部去掉孤儿 assistant(tool_use)（其 tool_result 已被裁掉）
    while (out.length && out[0].role === "assistant" && out[0].tool_calls?.length && !out[0].content) out.shift();
  }
  return out;
}

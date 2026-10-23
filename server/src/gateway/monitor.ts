// 请求监控：按会话 ID 聚合的实时流量追踪（内存态，不落库）。
// 数据来源为网关请求生命周期埋点与 live.ts 的流式 token 增量回调，
// 服务重启后清零；空闲会话超时后自动清理。

import { setStreamTokenListener } from "./live.js";

export interface InFlightRequest {
  id: string;
  model: string; // 已确定的上游模型（流式打开后/完成时更新，此前为首个候选）
  startedAt: number;
  streaming: boolean; // 是否有流式输出在途
}

interface MonitorSession {
  conversationId: string;
  sourceSessionId: string | null; // 客户端原始 session id（可能为空，由网关归并）
  apiKeyId: string | null;
  clientIp: string | null;
  protocol: string;
  title: string;
  modelRequested: string;
  model: string; // 最近一次正在/已经使用的模型
  requestCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  firstAt: number;
  lastAt: number;
  lastError: string | null;
  inFlight: Map<string, InFlightRequest>;
  // 最近窗口内的输出 token 采样（ts, tokens），用于实时速度
  window: { ts: number; tokens: number }[];
}

const sessions = new Map<string, MonitorSession>();
const requestSession = new Map<string, string>(); // requestId -> conversationId

// 接收 live.ts 的流式 token 增量（按会话）
setStreamTokenListener(monitorFeedTokens);

const WINDOW_MS = 10_000; // 实时速度统计窗口
const MIN_WINDOW_SPAN = 400; // 窗口跨度小于该值（毫秒）时认为样本不足
const IDLE_EXPIRE_MS = 30 * 60 * 1000; // 无在途请求的会话保留时长

function pruneWindow(s: MonitorSession, now: number): void {
  if (s.window.length === 0) return;
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < s.window.length && s.window[i].ts < cutoff) i++;
  if (i > 0) s.window.splice(0, i);
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.inFlight.size === 0 && now - s.lastAt > IDLE_EXPIRE_MS) {
      sessions.delete(id);
    }
  }
}

// 每 5 分钟清理一次空闲会话，避免长期无人查看页面时内存无界增长
setInterval(pruneExpired, 5 * 60 * 1000).unref();

/** 请求开始：登记到所属会话（会话不存在则创建），并递增在途计数 */
export function monitorBegin(req: {
  requestId: string;
  conversationId: string;
  sourceSessionId: string | null;
  apiKeyId: string | null;
  clientIp: string | null;
  protocol: string;
  modelRequested: string;
  expectedModel: string;
  title: string;
  stream: boolean;
  startedAt: number;
}): void {
  const now = req.startedAt;
  let s = sessions.get(req.conversationId);
  if (!s) {
    s = {
      conversationId: req.conversationId,
      sourceSessionId: req.sourceSessionId,
      apiKeyId: req.apiKeyId,
      clientIp: req.clientIp,
      protocol: req.protocol,
      title: req.title,
      modelRequested: req.modelRequested,
      model: req.expectedModel,
      requestCount: 0,
      errorCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
      firstAt: now,
      lastAt: now,
      lastError: null,
      inFlight: new Map(),
      window: [],
    };
    sessions.set(req.conversationId, s);
  }
  // 会话元信息以最近一次请求为准（标题可能随首轮内容变化）
  if (req.title) s.title = req.title;
  if (req.sourceSessionId) s.sourceSessionId = req.sourceSessionId;
  if (req.clientIp) s.clientIp = req.clientIp;
  if (req.modelRequested) s.modelRequested = req.modelRequested;
  if (req.expectedModel) s.model = req.expectedModel;
  s.protocol = req.protocol;
  s.apiKeyId = req.apiKeyId;
  s.lastAt = now;
  s.requestCount++;
  s.inFlight.set(req.requestId, {
    id: req.requestId,
    model: req.expectedModel,
    startedAt: now,
    streaming: false,
  });
  requestSession.set(req.requestId, req.conversationId);
}

/** 更新会话正在使用的模型（流式打开成功或请求完成时调用） */
export function monitorModel(requestId: string, model: string): void {
  const convId = requestSession.get(requestId);
  if (!convId || !model) return;
  const s = sessions.get(convId);
  if (!s) return;
  s.model = model;
  const r = s.inFlight.get(requestId);
  if (r) r.model = model;
}

/** 标记请求进入/离开流式输出状态 */
export function monitorStreaming(requestId: string, streaming: boolean): void {
  const convId = requestSession.get(requestId);
  if (!convId) return;
  const s = sessions.get(convId);
  const r = s?.inFlight.get(requestId);
  if (r) r.streaming = streaming;
}

/** 流式输出的 token 增量（估算值，来自 live.ts 回调），计入实时速度窗口 */
export function monitorFeedTokens(conversationId: string, deltaTokens: number): void {
  if (deltaTokens <= 0) return;
  const s = sessions.get(conversationId);
  if (!s) return;
  const now = Date.now();
  s.window.push({ ts: now, tokens: deltaTokens });
  pruneWindow(s, now);
}

export interface MonitorEndResult {
  status: "success" | "error";
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  cost?: number;
  error?: string | null;
}

/** 请求结束：更新聚合数据并移除在途标记（幂等，重复调用无副作用） */
export function monitorEnd(requestId: string, result: MonitorEndResult): void {
  const convId = requestSession.get(requestId);
  if (!convId) return;
  requestSession.delete(requestId);
  const s = sessions.get(convId);
  if (!s) return;
  s.inFlight.delete(requestId);
  const now = Date.now();
  s.lastAt = now;
  if (result.status === "success") {
    if (result.model) s.model = result.model;
    if (result.usage) {
      s.promptTokens += result.usage.promptTokens;
      s.completionTokens += result.usage.completionTokens;
      s.cacheReadTokens += result.usage.cacheReadTokens;
      s.cacheCreationTokens += result.usage.cacheCreationTokens;
    }
    if (result.cost) s.cost += result.cost;
  } else {
    s.errorCount++;
    s.lastError = result.error ?? "未知错误";
  }
}

export interface MonitorSessionSnapshot {
  conversationId: string;
  sourceSessionId: string | null;
  apiKeyId: string | null;
  clientIp: string | null;
  protocol: string;
  title: string;
  modelRequested: string;
  model: string;
  streaming: boolean;
  activeRequests: number;
  requestCount: number;
  errorCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
  cacheHitRate: number | null; // 0~1，无输入时为 null
  speed: number | null; // tok/s（最近 10s 输出窗口）
  firstAt: number;
  lastAt: number;
  lastError: string | null;
  inFlight: (InFlightRequest & { elapsedMs: number })[];
}

function sessionSpeed(s: MonitorSession, now: number): number | null {
  pruneWindow(s, now);
  if (s.window.length === 0) return null;
  let tokens = 0;
  for (const w of s.window) tokens += w.tokens;
  const span = now - s.window[0].ts;
  if (span < MIN_WINDOW_SPAN) return null;
  return tokens / (span / 1000);
}

/** 全量快照：活跃会话在前，其余按最近活动时间倒序 */
export function monitorSnapshot(): {
  activeRequests: number;
  sessionCount: number;
  activeSessionCount: number;
  sessions: MonitorSessionSnapshot[];
} {
  pruneExpired();
  const now = Date.now();
  const list: MonitorSessionSnapshot[] = [];
  for (const s of sessions.values()) {
    const total = s.promptTokens + s.completionTokens;
    list.push({
      conversationId: s.conversationId,
      sourceSessionId: s.sourceSessionId,
      apiKeyId: s.apiKeyId,
      clientIp: s.clientIp,
      protocol: s.protocol,
      title: s.title,
      modelRequested: s.modelRequested,
      model: s.model,
      streaming: [...s.inFlight.values()].some((r) => r.streaming),
      activeRequests: s.inFlight.size,
      requestCount: s.requestCount,
      errorCount: s.errorCount,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens: total,
      cacheReadTokens: s.cacheReadTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      cost: s.cost,
      cacheHitRate: s.promptTokens > 0 ? s.cacheReadTokens / s.promptTokens : null,
      speed: sessionSpeed(s, now),
      firstAt: s.firstAt,
      lastAt: s.lastAt,
      lastError: s.lastError,
      inFlight: [...s.inFlight.values()].map((r) => ({
        ...r,
        elapsedMs: now - r.startedAt,
      })),
    });
  }
  list.sort((a, b) => {
    if (a.activeRequests > 0 !== b.activeRequests > 0) return a.activeRequests > 0 ? -1 : 1;
    return b.lastAt - a.lastAt;
  });
  return {
    activeRequests: requestSession.size,
    sessionCount: list.length,
    activeSessionCount: list.filter((x) => x.activeRequests > 0).length,
    sessions: list,
  };
}

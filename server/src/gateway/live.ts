// 流式请求的实时状态追踪（内存态，用于「streaming」记录的实时速度展示）

export interface LiveStream {
  startedAt: number;
  firstTokenAt: number | null;
  tokens: number; // 估算的已完成输出 token
  updatedAt: number;
  owner: string | null; // 所属会话 ID（用于向监控面板回报增量）
}

const streams = new Map<string, LiveStream>();
const active = new Set<string>();

// 流式 token 增量回调（由 monitor.ts 注册，用于会话级实时速度统计）
export type StreamTokenListener = (conversationId: string, deltaTokens: number) => void;
let tokenListener: StreamTokenListener | null = null;

export function setStreamTokenListener(l: StreamTokenListener | null): void {
  tokenListener = l;
}

export function markActive(id: string): void {
  active.add(id);
}

export function markDone(id: string): void {
  active.delete(id);
}

export function startLiveStream(id: string, startedAt: number, owner: string | null = null): void {
  streams.set(id, { startedAt, firstTokenAt: null, tokens: 0, updatedAt: startedAt, owner });
}

export function updateLiveStream(id: string, contentLength: number): void {
  const s = streams.get(id);
  if (!s) return;
  const now = Date.now();
  // 粗略估算 token（约 3 字符 1 token），仅用于实时展示
  const estimated = Math.floor(contentLength / 3);
  if (estimated > s.tokens) {
    const delta = estimated - s.tokens;
    s.tokens = estimated;
    if (s.owner && tokenListener) tokenListener(s.owner, delta);
  }
  s.updatedAt = now;
  if (s.firstTokenAt === null && contentLength > 0) s.firstTokenAt = now;
}

export function finishLiveStream(id: string): { firstTokenAt: number | null } {
  const s = streams.get(id);
  streams.delete(id);
  return { firstTokenAt: s?.firstTokenAt ?? null };
}

export function getLiveStream(id: string): LiveStream | undefined {
  return streams.get(id);
}

/**
 * 全局实时速度：聚合所有在途流式请求（tokens/秒），并返回活跃请求数。
 * 透传代理下源（上游）与出口（客户端）吞吐量一致，因此仅返回单一速度。
 */
export function getGlobalLiveSpeed(): {
  speed: number | null;
  active: number;
} {
  const now = Date.now();
  let tokens = 0;
  let durationMs = 0;
  let streaming = 0;
  for (const s of streams.values()) {
    if (s.firstTokenAt) {
      tokens += s.tokens;
      durationMs += now - s.firstTokenAt;
      streaming++;
    }
  }
  const speed = streaming > 0 && durationMs > 0 ? tokens / (durationMs / 1000) : null;
  return { speed, active: active.size };
}

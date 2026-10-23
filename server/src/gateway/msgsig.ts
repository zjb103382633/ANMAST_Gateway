/** 消息去重签名：role + content + tool_call_id + 工具名列表（忽略易变的参数序列化细节）。
 * 供对话记录去重（service.ts）与压缩缓存前缀哈希（ucomp.ts）共用。 */
export function msgSignature(m: {
  role: string;
  content: string | null;
  tool_call_id?: string | null;
  tool_calls?: unknown;
}): string {
  let names = "";
  const tc = m.tool_calls;
  if (Array.isArray(tc)) {
    names = tc
      .map((t) => (t as { function?: { name?: string } }).function?.name ?? "")
      .sort()
      .join(",");
  } else if (typeof tc === "string" && tc) {
    try {
      const arr = JSON.parse(tc);
      if (Array.isArray(arr)) {
        names = arr.map((t) => t?.function?.name ?? "").sort().join(",");
      }
    } catch {
      /* ignore */
    }
  }
  return `${m.role}\u0000${m.content ?? ""}\u0000${m.tool_call_id ?? ""}\u0000${names}`;
}

import { getDb } from "../index.js";

/** 会话压缩缓存：记录上次 ucomp 压缩的区域坐标与摘要，前缀未变时直接复用，避免每请求重复压缩。
 *  坐标均为「网关输入消息」坐标系：[input_region_start, input_boundary_index) 被摘要替换，
 *  input_boundary_index 起为逐字保留的尾部。 */
export interface ConversationCompaction {
  conversation_id: string;
  input_region_start: number;
  input_boundary_index: number;
  prefix_hash: string;
  summary_content: string;
  tokens_before: number | null;
  tokens_after: number | null;
  created_at: number;
  updated_at: number;
}

export function getConversationCompaction(conversationId: string): ConversationCompaction | undefined {
  return getDb()
    .prepare("SELECT * FROM conversation_compactions WHERE conversation_id = ?")
    .get(conversationId) as ConversationCompaction | undefined;
}

export function upsertConversationCompaction(row: {
  conversation_id: string;
  input_region_start: number;
  input_boundary_index: number;
  prefix_hash: string;
  summary_content: string;
  tokens_before: number | null;
  tokens_after: number | null;
}): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO conversation_compactions (conversation_id, input_region_start, input_boundary_index, prefix_hash, summary_content, tokens_before, tokens_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         input_region_start = excluded.input_region_start,
         input_boundary_index = excluded.input_boundary_index,
         prefix_hash = excluded.prefix_hash,
         summary_content = excluded.summary_content,
         tokens_before = excluded.tokens_before,
         tokens_after = excluded.tokens_after,
         updated_at = excluded.updated_at`,
    )
    .run(
      row.conversation_id,
      row.input_region_start,
      row.input_boundary_index,
      row.prefix_hash,
      row.summary_content,
      row.tokens_before,
      row.tokens_after,
      now,
      now,
    );
}

export function clearConversationCompactions(): void {
  getDb().prepare("DELETE FROM conversation_compactions").run();
}

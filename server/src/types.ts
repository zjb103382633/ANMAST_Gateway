// 共享类型定义

export type ProviderType = "openai" | "anthropic";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  base_url: string;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  api_key: string;
  extra_headers: string; // JSON
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ModelConfig {
  id: string;
  provider_id: string;
  name: string;
  display_name: string;
  tiers: string; // JSON string[]
  capabilities: string; // JSON
  context_window: number;
  input_price: number;
  input_cache_read_price: number;
  input_cache_write_price: number;
  output_price: number;
  priority: number;
  is_router: number;
  usage: string;
  auto_compress: number;
  max_context_tokens: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface Tier {
  id: string;
  name: string;
  description: string;
  sort: number;
}

export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  enabled: number;
  monthly_limit_tokens: number | null;
  skill_ids: string;
  mcp_server_ids: string;
  compression_enabled: number;
  created_at: number;
  last_used_at: number | null;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools_config: string; // JSON
  triggers: string | null; // JSON
  enabled: number;
  created_at: number;
  updated_at: number;
}

export type McpTransport = "stdio" | "sse" | "streamable-http";

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  config: string; // JSON
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: string;
  api_key_id: string | null;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export type RequestStatus = "success" | "error" | "streaming" | "cancelled";

export interface RequestRecord {
  id: string;
  api_key_id: string | null;
  protocol: string;
  endpoint: string;
  model_requested: string;
  model_used: string;
  provider_id: string | null;
  tier_id: string | null;
  tier_source: string | null;
  conversation_id: string | null;
  status: RequestStatus;
  error: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost: number;
  latency_ms: number;
  first_token_ms: number | null;
  upstream_protocol: string | null;
  input_tokens_before: number | null;
  input_tokens_after: number | null;
  request_json: string | null;
  response_json: string | null;
  client_ip: string | null;
  created_at: number;
}

export interface MessageRecord {
  id: number;
  request_id: string;
  conversation_id: string | null;
  role: string;
  content: string | null;
  name: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: number;
}

/** 通用聊天消息（网关内部规范化表示） */
export interface ChatMessage {
  role: string;
  content: string | null;
  /** 多模态原始内容数组（如有），透传给上游 */
  contentArray?: unknown[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type TierSource = "explicit" | "auto" | "fallback";

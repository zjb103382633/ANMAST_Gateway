// 数据库迁移。每个迁移为一个 SQL 字符串，按顺序执行。
// 使用 PRAGMA user_version 跟踪版本。

export const migrations: string[] = [
  // v1 —— 初始结构
  `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'openai',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    extra_headers TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tiers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    tiers TEXT NOT NULL DEFAULT '["medium"]',
    capabilities TEXT NOT NULL DEFAULT '{"tools":true,"vision":false}',
    context_window INTEGER NOT NULL DEFAULT 128000,
    input_price REAL NOT NULL DEFAULT 0,
    output_price REAL NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 100,
    is_router INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    monthly_limit_tokens INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    tools_config TEXT NOT NULL DEFAULT '{}',
    triggers TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL DEFAULT 'stdio',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    api_key_id TEXT,
    protocol TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    model_requested TEXT NOT NULL DEFAULT '',
    model_used TEXT NOT NULL DEFAULT '',
    provider_id TEXT,
    tier_id TEXT,
    tier_source TEXT,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'success',
    error TEXT,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    request_json TEXT,
    response_json TEXT,
    client_ip TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    conversation_id TEXT,
    role TEXT NOT NULL,
    content TEXT,
    name TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_requests_conv ON requests(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_request ON messages(request_id);
  `,
  // v2 —— 缓存定价字段（输入区分命中缓存/未命中缓存）
  `
  ALTER TABLE models ADD COLUMN input_cache_read_price REAL NOT NULL DEFAULT 0;
  ALTER TABLE models ADD COLUMN input_cache_write_price REAL NOT NULL DEFAULT 0;
  `,
  // v3 —— API Key 绑定 Skill 与 MCP Server
  `
  ALTER TABLE api_keys ADD COLUMN skill_ids TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE api_keys ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]';
  `,
  // v4 —— 请求记录：首 token 耗时（用于速度统计）
  `
  ALTER TABLE requests ADD COLUMN first_token_ms INTEGER;
  `,
  // v5 —— 模型用途：normal（正常参与复杂度路由）/ router_only（仅判定）/ assistant_only（仅助手）
  `
  ALTER TABLE models ADD COLUMN usage TEXT NOT NULL DEFAULT 'normal';
  `,
  // v6 —— 供应商双协议：openai_base_url / anthropic_base_url（可空，留空表示不支持该协议）
  `
  ALTER TABLE providers ADD COLUMN openai_base_url TEXT;
  ALTER TABLE providers ADD COLUMN anthropic_base_url TEXT;
  UPDATE providers SET openai_base_url = base_url WHERE type = 'openai';
  UPDATE providers SET anthropic_base_url = base_url WHERE type = 'anthropic';
  `,
  // v7 —— 请求记录上游协议 + 用户自定义已知供应商
  `
  ALTER TABLE requests ADD COLUMN upstream_protocol TEXT;
  CREATE TABLE IF NOT EXISTS known_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    openai_base_url TEXT,
    anthropic_base_url TEXT,
    created_at INTEGER NOT NULL
  );
  `,
  // v8 —— 上下文压缩：记录压缩前/后的消息 token 估算
  `
  ALTER TABLE requests ADD COLUMN input_tokens_before INTEGER;
  ALTER TABLE requests ADD COLUMN input_tokens_after INTEGER;
  `,
  // v9 —— 按 API Key 启用/关闭上下文压缩（默认启用）
  `
  ALTER TABLE api_keys ADD COLUMN compression_enabled INTEGER NOT NULL DEFAULT 1;
  `,
  // v10 —— 按模型自动压缩：触发上下文上限（可空=用 context_window）与开关
  `
  ALTER TABLE models ADD COLUMN auto_compress INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE models ADD COLUMN max_context_tokens INTEGER;
  `,
  // v11 —— 会话压缩缓存：前缀未变时复用上次的压缩摘要，避免每次请求重复压缩
  `
  CREATE TABLE IF NOT EXISTS conversation_compactions (
    conversation_id TEXT PRIMARY KEY,
    input_region_start INTEGER NOT NULL,
    input_boundary_index INTEGER NOT NULL,
    prefix_hash TEXT NOT NULL,
    summary_content TEXT NOT NULL,
    tokens_before INTEGER,
    tokens_after INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

export const DEFAULT_TIERS: { id: string; name: string; description: string; sort: number }[] = [
  { id: "low", name: "低复杂度", description: "简单问答、分类、短文本处理等", sort: 1 },
  { id: "medium", name: "中复杂度", description: "常规对话、代码生成、文本撰写等", sort: 2 },
  { id: "high", name: "高复杂度", description: "复杂推理、长文档、多步任务等", sort: 3 },
];

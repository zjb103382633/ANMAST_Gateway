import { getDb } from "../index.js";
import type { Provider, ModelConfig, Tier } from "../../types.js";
import { encryptApiKey, decryptApiKey } from "../../secret.js";

// ---------- Providers ----------

/** 解密单个供应商的 api_key */
function withDecryptedKey(p: Provider): Provider {
  return { ...p, api_key: decryptApiKey(p.api_key) };
}

export function listProviders(): Provider[] {
  return (getDb().prepare("SELECT * FROM providers ORDER BY created_at ASC").all() as Provider[]).map(withDecryptedKey);
}

export function getProvider(id: string): Provider | undefined {
  const p = getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id) as Provider | undefined;
  return p ? withDecryptedKey(p) : undefined;
}

export interface ProviderInput {
  name: string;
  type: string;
  base_url: string;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  api_key: string;
  extra_headers: string;
  enabled: number;
}

export function createProvider(input: ProviderInput): Provider {
  const id = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  // legacy type/base_url 由双协议列自动推导
  const type = input.openai_base_url ? "openai" : "anthropic";
  const baseUrl = input.openai_base_url ?? input.anthropic_base_url ?? "";
  getDb()
    .prepare(
      `INSERT INTO providers (id, name, type, base_url, openai_base_url, anthropic_base_url, api_key, extra_headers, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      type,
      baseUrl,
      input.openai_base_url,
      input.anthropic_base_url,
      encryptApiKey(input.api_key),
      input.extra_headers,
      input.enabled,
      now,
      now,
    );
  return getProvider(id)!;
}

export function updateProvider(id: string, patch: Partial<ProviderInput>): Provider | undefined {
  const existing = getProvider(id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch };
  // 同步 legacy 字段
  next.type = next.openai_base_url ? "openai" : "anthropic";
  next.base_url = next.openai_base_url ?? next.anthropic_base_url ?? "";
  next.updated_at = Date.now();
  getDb()
    .prepare(
      `UPDATE providers SET name=?, type=?, base_url=?, openai_base_url=?, anthropic_base_url=?, api_key=?, extra_headers=?, enabled=?, updated_at=? WHERE id=?`,
    )
    .run(
      next.name,
      next.type,
      next.base_url,
      next.openai_base_url,
      next.anthropic_base_url,
      encryptApiKey(next.api_key),
      next.extra_headers,
      next.enabled,
      next.updated_at,
      id,
    );
  return getProvider(id);
}

export function deleteProvider(id: string): void {
  getDb().prepare("DELETE FROM providers WHERE id = ?").run(id);
}

// ---------- Models ----------

export function listModels(): ModelConfig[] {
  return getDb().prepare("SELECT * FROM models ORDER BY created_at ASC").all() as ModelConfig[];
}

export function getModel(id: string): ModelConfig | undefined {
  return getDb().prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelConfig | undefined;
}

export interface ModelInput {
  provider_id: string;
  name: string;
  display_name: string;
  tiers: string;
  capabilities: string;
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
}

export function createModel(input: ModelInput): ModelConfig {
  const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO models (id, provider_id, name, display_name, tiers, capabilities, context_window, input_price, input_cache_read_price, input_cache_write_price, output_price, priority, is_router, usage, auto_compress, max_context_tokens, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.provider_id,
      input.name,
      input.display_name,
      input.tiers,
      input.capabilities,
      input.context_window,
      input.input_price,
      input.input_cache_read_price,
      input.input_cache_write_price,
      input.output_price,
      input.priority,
      input.is_router,
      input.usage ?? "normal",
      input.auto_compress ?? 0,
      input.max_context_tokens ?? null,
      input.enabled,
      now,
      now,
    );
  return getModel(id)!;
}

export function updateModel(id: string, patch: Partial<ModelInput>): ModelConfig | undefined {
  const existing = getModel(id);
  if (!existing) return undefined;
  const next = { ...existing, ...patch, updated_at: Date.now() };
  getDb()
    .prepare(
      `UPDATE models SET provider_id=?, name=?, display_name=?, tiers=?, capabilities=?, context_window=?, input_price=?, input_cache_read_price=?, input_cache_write_price=?, output_price=?, priority=?, is_router=?, usage=?, auto_compress=?, max_context_tokens=?, enabled=?, updated_at=? WHERE id=?`,
    )
    .run(
      next.provider_id,
      next.name,
      next.display_name,
      next.tiers,
      next.capabilities,
      next.context_window,
      next.input_price,
      next.input_cache_read_price,
      next.input_cache_write_price,
      next.output_price,
      next.priority,
      next.is_router,
      next.usage ?? "normal",
      next.auto_compress ?? 0,
      next.max_context_tokens ?? null,
      next.enabled,
      next.updated_at,
      id,
    );
  return getModel(id);
}

export function deleteModel(id: string): void {
  getDb().prepare("DELETE FROM models WHERE id = ?").run(id);
}

// ---------- Tiers ----------

export function listTiers(): Tier[] {
  return getDb().prepare("SELECT * FROM tiers ORDER BY sort ASC, id ASC").all() as Tier[];
}

export interface TierInput {
  name: string;
  description: string;
  sort: number;
}

export function createTier(id: string, input: TierInput): Tier {
  getDb()
    .prepare("INSERT INTO tiers (id, name, description, sort) VALUES (?, ?, ?, ?)")
    .run(id, input.name, input.description, input.sort);
  return getDb().prepare("SELECT * FROM tiers WHERE id = ?").get(id) as Tier;
}

export function updateTier(id: string, input: TierInput): Tier | undefined {
  getDb()
    .prepare("UPDATE tiers SET name=?, description=?, sort=? WHERE id=?")
    .run(input.name, input.description, input.sort, id);
  return getDb().prepare("SELECT * FROM tiers WHERE id = ?").get(id) as Tier | undefined;
}

export function deleteTier(id: string): void {
  getDb().prepare("DELETE FROM tiers WHERE id = ?").run(id);
}

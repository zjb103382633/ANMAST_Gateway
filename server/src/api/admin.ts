import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { authenticate, adminLogin, adminLogout } from "../auth/index.js";
import { getDb, getSetting, setSetting, closeDb, initDb, resetToFactory, transaction } from "../db/index.js";
import { config } from "../config.js";
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  listTiers,
  createTier,
  updateTier,
  deleteTier,
} from "../db/repos/models.js";
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  getAdmin,
  updateAdminPassword,
} from "../db/repos/auth.js";
import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  listMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
} from "../db/repos/ext.js";
import {
  listRequests,
  getRequest,
  listMessagesByConversation,
  listMessagesByRequest,
  listConversations,
  getConversation,
  statsTotals,
  statsDaily,
  statsByModel,
  statsByKey,
  statsCompression,
  conversationModels,
  conversationTokens,
} from "../db/repos/logs.js";
import { generateApiKey, hashPassword, encryptBuffer, decryptBuffer } from "../lib/crypto.js";
import { listServerTools, refreshServer } from "../mcp/manager.js";
import { listProviderModelsAny, fetchModelContext, pingProvider } from "../providers/discovery.js";
import type { UpstreamProtocol } from "../providers/index.js";
import { handleAssistantChat, assistantChatStream } from "../assistant/service.js";
import { modelTestChat, modelTestStream } from "../modeltest.js";
import { importSkillFromContent, importSkillFromPath } from "../skills/importer.js";
import { openaiJson, fakeOpenAIStream, genId } from "../gateway/respond.js";
import { toReadable } from "../lib/stream.js";
import type { ChatMessage, Provider } from "../types.js";
import { getGlobalLiveSpeed } from "../gateway/live.js";
import { monitorSnapshot } from "../gateway/monitor.js";
import { getLatency, recordLatency } from "../latency.js";
import { getCompressionConfig, saveCompressionConfig, type CompressionConfig } from "../gateway/compress.js";
import { ucompSelfCheck } from "../gateway/ucomp.js";
import { clearConversationCompactions } from "../db/repos/compactions.js";
import { checkForUpdate, runUpdate, getVersion } from "../updater.js";
import {
  usageSummary,
  usageTimeseries,
  usageByModel,
  usageByKey,
  type UsageFilter,
  type Granularity,
} from "../db/repos/usage.js";
import { logger } from "../logger.js";

function maskKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

function asJsonString(v: unknown, fallback: string): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function parseUsageFilter(q: Record<string, string>): UsageFilter {
  return {
    from: q.from ? Number(q.from) : undefined,
    to: q.to ? Number(q.to) : undefined,
    model: q.model || undefined,
    api_key_id: q.api_key_id || undefined,
  };
}

/** 计算某条记录的速度（tokens/秒）：源速度=输入处理速度，出口速度=输出生成速度 */
function computeSpeed(r: {
  id: string;
  status: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  first_token_ms: number | null;
}): { source_speed: number | null; egress_speed: number | null } {
  if (r.status === "streaming") return { source_speed: null, egress_speed: null };
  const total = r.latency_ms;
  if (total <= 0) return { source_speed: null, egress_speed: null };
  const ttf = r.first_token_ms;
  // 源速度：输入处理速度（到首 token 之前，无首 token 则用整个周期）
  const srcDur = ttf != null && ttf > 0 ? ttf : total;
  const src = r.prompt_tokens / (srcDur / 1000);
  // 出口速度：输出生成速度（首 token 之后）
  const egrDur = ttf != null && total > ttf ? total - ttf : total;
  const egr = egrDur > 0 ? r.completion_tokens / (egrDur / 1000) : null;
  return { source_speed: src, egress_speed: egr };
}

/** 计算某条记录的上下文压缩率（0~1，未压缩返回 null） */
function compressionRatio(r: {
  prompt_tokens: number;
  input_tokens_before: number | null;
  input_tokens_after: number | null;
}): number | null {
  if (r.input_tokens_before == null || r.input_tokens_after == null) return null;
  const saved = Math.max(0, r.input_tokens_before - r.input_tokens_after);
  const uncompressed = r.prompt_tokens + saved;
  return uncompressed > 0 ? saved / uncompressed : 0;
}

const SETTINGS_DEFAULTS: Record<string, unknown> = {
  router_model_id: "",
  assistant_model_id: "",
  auto_detect_enabled: true,
  default_tier: "medium",
  mcp_tools_mode: "on_demand",
  max_tool_steps: 8,
  currency: "CNY",
  usd_cny_rate: 7.2,
};

export function registerAdminRoutes(app: FastifyInstance): void {
  app.register(async function (app) {
    // 认证守卫（登录接口除外）
    app.addHook("preHandler", async (req, reply) => {
      if (req.raw.url === "/api/auth/login") return;
      const auth = authenticate(req.headers.authorization);
      if (auth.kind !== "admin") {
        return reply.code(401).send({ error: "未认证或会话已过期" });
      }
    });

  // ---------- 认证 ----------
  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) {
      return reply.code(400).send({ error: "缺少用户名或密码" });
    }
    const res = await adminLogin(username, password);
    if (!res) return reply.code(401).send({ error: "用户名或密码错误" });
    return reply.send(res);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    adminLogout(req.headers.authorization);
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async () => {
    const admin = getAdmin();
    return { username: admin?.username ?? "admin" };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const { currentPassword, newPassword } = (req.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: "新密码至少 8 位" });
    }
    const admin = getAdmin();
    if (!admin) return reply.code(500).send({ error: "管理员不存在" });
    const { verifyPassword } = await import("../lib/crypto.js");
    const ok = await verifyPassword(currentPassword, admin.password_hash);
    if (!ok) return reply.code(401).send({ error: "当前密码错误" });
    updateAdminPassword(admin.username, await hashPassword(newPassword));
    return reply.send({ ok: true });
  });

  // 保存免登录时长（需验证管理员密码）
  app.put("/api/settings/session-timeout", async (req, reply) => {
    const { hours, currentPassword } = (req.body ?? {}) as {
      hours?: number;
      currentPassword?: string;
    };
    if (hours === undefined || hours === null || isNaN(Number(hours))) {
      return reply.code(400).send({ error: "缺少免登录时长" });
    }
    if (!currentPassword) return reply.code(400).send({ error: "请提供当前密码验证" });
    const admin = getAdmin();
    if (!admin) return reply.code(500).send({ error: "管理员不存在" });
    const { verifyPassword } = await import("../lib/crypto.js");
    const ok = await verifyPassword(currentPassword, admin.password_hash);
    if (!ok) return reply.code(401).send({ error: "密码错误" });
    const h = Number(hours);
    setSetting("session_timeout_hours", h);
    return reply.send({ ok: true, session_timeout_hours: h });
  });

  // ---------- 网页内 AI 配置助手（沙箱：仅内置配置 Skill，无工具/无用户 Skill） ----------
  app.post("/api/assistant/chat", async (req, reply) => {
    const b = (req.body ?? {}) as { messages?: ChatMessage[]; stream?: boolean };
    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      return reply.code(400).send({ error: "缺少 messages 字段" });
    }
    try {
      if (b.stream) {
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");
        return reply.send(toReadable(assistantChatStream(b.messages)));
      }
      const res = await handleAssistantChat(b.messages);
      const final = {
        content: res.message.content,
        toolCalls: res.message.tool_calls,
        usage: res.usage,
      };
      const meta = {
        model: res.modelName,
        id: res.id ?? genId("chatcmpl"),
        created: Math.floor(Date.now() / 1000),
        protocol: "openai" as const,
      };
      return reply.send(openaiJson(final, meta));
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // ---------- 模型对话测试 ----------
  app.post("/api/model-test/chat", async (req, reply) => {
    const b = (req.body ?? {}) as {
      model_id?: string;
      messages?: ChatMessage[];
      conversation_id?: string;
      stream?: boolean;
    };
    if (!b.model_id || !Array.isArray(b.messages) || b.messages.length === 0) {
      return reply.code(400).send({ error: "缺少 model_id 或 messages 字段" });
    }
    const conversationId = b.conversation_id || genId("conv");
    try {
      if (b.stream) {
        reply.header("Content-Type", "text/event-stream");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");
        reply.header("X-Conversation-Id", conversationId);
        return reply.send(toReadable(modelTestStream(b.model_id, b.messages, conversationId, req.ip ?? null)));
      }
      const res = await modelTestChat(b.model_id, b.messages, conversationId, req.ip ?? null);
      const final = { content: res.content, toolCalls: undefined, usage: res.usage };
      const meta = {
        model: res.modelName,
        id: res.id ?? genId("chatcmpl"),
        created: Math.floor(Date.now() / 1000),
        protocol: "openai" as const,
      };
      reply.header("X-Conversation-Id", conversationId);
      return reply.send(openaiJson(final, meta));
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // ---------- 供应商 ----------
  app.get("/api/providers", async () => {
    return listProviders().map((p) => ({ ...p, api_key: maskKey(p.api_key) }));
  });

  app.get("/api/providers/:id", async (req, reply) => {
    const p = getProvider((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "供应商不存在" });
    return p;
  });

  app.post("/api/providers", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const openaiUrl = b.openai_base_url ? String(b.openai_base_url).trim() : null;
    const anthropicUrl = b.anthropic_base_url ? String(b.anthropic_base_url).trim() : null;
    if (!b.name || (!openaiUrl && !anthropicUrl))
      return reply.code(400).send({ error: "缺少名称，且至少需填写一种协议的 Base URL" });
    const p = createProvider({
      name: String(b.name),
      type: openaiUrl ? "openai" : "anthropic",
      base_url: openaiUrl ?? anthropicUrl ?? "",
      openai_base_url: openaiUrl,
      anthropic_base_url: anthropicUrl,
      api_key: String(b.api_key ?? ""),
      extra_headers: asJsonString(b.extra_headers, "{}"),
      enabled: b.enabled === false ? 0 : 1,
    });
    return reply.code(201).send(p);
  });

  app.put("/api/providers/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.api_key !== undefined) patch.api_key = String(b.api_key);
    if (b.extra_headers !== undefined) patch.extra_headers = asJsonString(b.extra_headers, "{}");
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    if (b.openai_base_url !== undefined)
      patch.openai_base_url = b.openai_base_url ? String(b.openai_base_url).trim() : null;
    if (b.anthropic_base_url !== undefined)
      patch.anthropic_base_url = b.anthropic_base_url ? String(b.anthropic_base_url).trim() : null;
    const p = updateProvider(id, patch as never);
    if (!p) return reply.code(404).send({ error: "供应商不存在" });
    return reply.send(p);
  });

  app.delete("/api/providers/:id", async (req, reply) => {
    deleteProvider((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  // 第一步：仅测试各协议的连通性（逐协议 ping，不拉模型列表）
  const testProvider = async (p: Provider) => {
    const protocols: UpstreamProtocol[] = [];
    if (p.openai_base_url) protocols.push("openai");
    if (p.anthropic_base_url) protocols.push("anthropic");
    const results = [];
    for (const proto of protocols) {
      const ping = await pingProvider(p, proto);
      results.push({
        protocol: proto,
        ok: ping.ok,
        error: ping.ok ? null : ping.error ?? "连通性验证失败",
      });
    }
    return { results, allOk: results.length > 0 && results.every((r) => r.ok) };
  };

  app.post("/api/providers/:id/test", async (req, reply) => {
    const p = getProvider((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "供应商不存在" });
    const { results, allOk } = await testProvider(p);
    return reply.send({ ok: allOk, results });
  });

  // 测试「未保存」的供应商配置（对话框内先测试通过再保存）
  app.post("/api/providers/test", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const p = {
      id: "_t",
      name: "test",
      type: (b.type as string) || "openai",
      base_url: String(b.base_url ?? ""),
      openai_base_url: b.openai_base_url ? String(b.openai_base_url).trim() : null,
      anthropic_base_url: b.anthropic_base_url ? String(b.anthropic_base_url).trim() : null,
      api_key: String(b.api_key ?? ""),
      extra_headers: asJsonString(b.extra_headers, "{}"),
      enabled: 1,
      created_at: 0,
      updated_at: 0,
    } as Provider;
    const { results, allOk } = await testProvider(p);
    return reply.send({ ok: allOk, results });
  });

  // 第二步：获取模型列表（任一方法，两种协议共用）
  const fetchModelsAny = async (p: Provider) => {
    const models = await listProviderModelsAny(p);
    return { models };
  };

  app.post("/api/providers/models", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const p = {
      id: "_t",
      name: "test",
      type: (b.type as string) || "openai",
      base_url: String(b.base_url ?? ""),
      openai_base_url: b.openai_base_url ? String(b.openai_base_url).trim() : null,
      anthropic_base_url: b.anthropic_base_url ? String(b.anthropic_base_url).trim() : null,
      api_key: String(b.api_key ?? ""),
      extra_headers: asJsonString(b.extra_headers, "{}"),
      enabled: 1,
      created_at: 0,
      updated_at: 0,
    } as Provider;
    try {
      return reply.send(await fetchModelsAny(p));
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // 拉取某供应商的可用模型（任一方法，两种协议共用）
  app.get("/api/providers/:id/models", async (req, reply) => {
    const p = getProvider((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "供应商不存在" });
    try {
      const models = await listProviderModelsAny(p);
      return reply.send({ models });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // 尽力获取单个模型的上下文窗口（模型数据两种协议通用）
  app.get("/api/providers/:id/models/:name/context", async (req, reply) => {
    const p = getProvider((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "供应商不存在" });
    const name = decodeURIComponent((req.params as { name: string }).name);
    const context_window = await fetchModelContext(p, name);
    return reply.send({ context_window });
  });

  // ---------- 用户自定义已知供应商 ----------
  app.get("/api/known-providers", async () => {
    return getDb().prepare("SELECT id, name, openai_base_url, anthropic_base_url FROM known_providers ORDER BY created_at ASC").all();
  });

  app.post("/api/known-providers", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "").trim();
    const openai = b.openai_base_url ? String(b.openai_base_url).trim() : null;
    const anthropic = b.anthropic_base_url ? String(b.anthropic_base_url).trim() : null;
    if (!name || (!openai && !anthropic))
      return reply.code(400).send({ error: "缺少名称或至少一种协议的 Base URL" });
    const id = `kp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    getDb()
      .prepare("INSERT INTO known_providers (id, name, openai_base_url, anthropic_base_url, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, openai, anthropic, Date.now());
    return reply.code(201).send({ id, name, openai_base_url: openai, anthropic_base_url: anthropic });
  });

  app.delete("/api/known-providers/:id", async (req, reply) => {
    getDb().prepare("DELETE FROM known_providers WHERE id = ?").run((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  // ---------- 模型 ----------
  app.get("/api/models", async () => {
    const providers = listProviders();
    return listModels().map((m) => ({
      ...m,
      provider_name: providers.find((p) => p.id === m.provider_id)?.name ?? "",
    }));
  });

  app.post("/api/models", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.provider_id || !b.name) return reply.code(400).send({ error: "缺少 provider_id 或 name" });
    const m = createModel({
      provider_id: String(b.provider_id),
      name: String(b.name),
      display_name: String(b.display_name ?? b.name),
      tiers: asJsonString(b.tiers, '["medium"]'),
      capabilities: asJsonString(b.capabilities, '{"tools":true,"vision":false}'),
      context_window: Number(b.context_window ?? 128000),
      input_price: Number(b.input_price ?? 0),
      input_cache_read_price: Number(b.input_cache_read_price ?? 0),
      input_cache_write_price: Number(b.input_cache_write_price ?? 0),
      output_price: Number(b.output_price ?? 0),
      priority: Number(b.priority ?? 100),
      is_router: b.is_router ? 1 : 0,
      usage: String(b.usage ?? "normal"),
      auto_compress: b.auto_compress ? 1 : 0,
      max_context_tokens: b.max_context_tokens == null ? null : Number(b.max_context_tokens),
      enabled: b.enabled === false ? 0 : 1,
    });
    return reply.code(201).send(m);
  });

  app.put("/api/models/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const strFields = ["provider_id", "name", "display_name"] as const;
    for (const f of strFields) if (b[f] !== undefined) patch[f] = String(b[f]);
    const numFields = [
      "context_window",
      "input_price",
      "input_cache_read_price",
      "input_cache_write_price",
      "output_price",
      "priority",
    ] as const;
    for (const f of numFields) if (b[f] !== undefined) patch[f] = Number(b[f]);
    if (b.tiers !== undefined) patch.tiers = asJsonString(b.tiers, '["medium"]');
    if (b.capabilities !== undefined) patch.capabilities = asJsonString(b.capabilities, "{}");
    if (b.is_router !== undefined) patch.is_router = b.is_router ? 1 : 0;
    if (b.usage !== undefined) patch.usage = String(b.usage);
    if (b.auto_compress !== undefined) patch.auto_compress = b.auto_compress ? 1 : 0;
    if (b.max_context_tokens !== undefined)
      patch.max_context_tokens = b.max_context_tokens == null ? null : Number(b.max_context_tokens);
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    const m = updateModel(id, patch as never);
    if (!m) return reply.code(404).send({ error: "模型不存在" });
    return reply.send(m);
  });

  app.delete("/api/models/:id", async (req, reply) => {
    deleteModel((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  // ---------- 复杂度层级 ----------
  app.get("/api/tiers", async () => listTiers());
  app.post("/api/tiers", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.id || !b.name) return reply.code(400).send({ error: "缺少 id 或 name" });
    return reply.code(201).send(
      createTier(String(b.id), {
        name: String(b.name),
        description: String(b.description ?? ""),
        sort: Number(b.sort ?? 0),
      }),
    );
  });
  app.put("/api/tiers/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const t = updateTier(id, {
      name: String(b.name ?? id),
      description: String(b.description ?? ""),
      sort: Number(b.sort ?? 0),
    });
    if (!t) return reply.code(404).send({ error: "层级不存在" });
    return reply.send(t);
  });
  app.delete("/api/tiers/:id", async (req, reply) => {
    deleteTier((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  // ---------- API Keys ----------
  app.get("/api/keys", async () =>
    listApiKeys().map((k) => ({ ...k, key_hash: undefined, key_prefix: k.key_prefix })),
  );

  app.post("/api/keys", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? "默认密钥");
    const limit = b.monthly_limit_tokens ? Number(b.monthly_limit_tokens) : null;
    const skillIds = Array.isArray(b.skill_ids) ? b.skill_ids.map(String) : [];
    const mcpIds = Array.isArray(b.mcp_server_ids) ? b.mcp_server_ids.map(String) : [];
    const { key, hash, prefix } = generateApiKey();
    const row = createApiKey(
      name,
      hash,
      prefix,
      limit,
      JSON.stringify(skillIds),
      JSON.stringify(mcpIds),
    );
    return reply.code(201).send({ ...row, key });
  });

  app.put("/api/keys/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: {
      name?: string;
      enabled?: number;
      monthly_limit_tokens?: number | null;
      skill_ids?: string;
      mcp_server_ids?: string;
      compression_enabled?: number;
    } = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    if (b.monthly_limit_tokens !== undefined)
      patch.monthly_limit_tokens = b.monthly_limit_tokens ? Number(b.monthly_limit_tokens) : null;
    if (b.skill_ids !== undefined)
      patch.skill_ids = JSON.stringify(
        Array.isArray(b.skill_ids) ? b.skill_ids.map(String) : [],
      );
    if (b.mcp_server_ids !== undefined)
      patch.mcp_server_ids = JSON.stringify(
        Array.isArray(b.mcp_server_ids) ? b.mcp_server_ids.map(String) : [],
      );
    if (b.compression_enabled !== undefined)
      patch.compression_enabled = b.compression_enabled ? 1 : 0;
    const k = updateApiKey(id, patch);
    if (!k) return reply.code(404).send({ error: "密钥不存在" });
    return reply.send({ ...k, key_hash: undefined });
  });

  app.delete("/api/keys/:id", async (req, reply) => {
    deleteApiKey((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  // ---------- Skills ----------
  app.get("/api/skills", async () => listSkills());
  app.post("/api/skills", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.name) return reply.code(400).send({ error: "缺少 name" });
    const s = createSkill({
      name: String(b.name),
      description: String(b.description ?? ""),
      instructions: String(b.instructions ?? ""),
      tools_config: asJsonString(b.tools_config, "{}"),
      triggers: b.triggers ? asJsonString(b.triggers, "{}") : null,
      enabled: b.enabled ? 1 : 0,
    });
    return reply.code(201).send(s);
  });
  app.put("/api/skills/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.description !== undefined) patch.description = String(b.description);
    if (b.instructions !== undefined) patch.instructions = String(b.instructions);
    if (b.tools_config !== undefined) patch.tools_config = asJsonString(b.tools_config, "{}");
    if (b.triggers !== undefined) patch.triggers = b.triggers ? asJsonString(b.triggers, "{}") : null;
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    const s = updateSkill(id, patch as never);
    if (!s) return reply.code(404).send({ error: "Skill 不存在" });
    return reply.send(s);
  });
  app.delete("/api/skills/:id", async (req, reply) => {
    deleteSkill((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });

  // 从浏览器上传的 SKILL.md 文本导入
  app.post("/api/skills/import", async (req, reply) => {
    const b = (req.body ?? {}) as { content?: string; fileName?: string };
    if (!b.content || !b.content.trim()) {
      return reply.code(400).send({ error: "缺少文件内容" });
    }
    try {
      const skill = importSkillFromContent(b.content, b.fileName);
      return reply.code(201).send(skill);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // 从服务器本地路径导入（文件或目录）
  app.post("/api/skills/import-path", async (req, reply) => {
    const b = (req.body ?? {}) as { path?: string };
    if (!b.path) return reply.code(400).send({ error: "缺少路径" });
    try {
      const r = importSkillFromPath(b.path);
      return reply.send(r);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // ---------- MCP ----------
  app.get("/api/mcp", async () => listMcpServers());
  app.post("/api/mcp", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!b.name || !b.transport) return reply.code(400).send({ error: "缺少 name 或 transport" });
    const s = createMcpServer({
      name: String(b.name),
      transport: String(b.transport),
      config: asJsonString(b.config, "{}"),
      enabled: b.enabled ? 1 : 0,
    });
    return reply.code(201).send(s);
  });
  app.put("/api/mcp/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.transport !== undefined) patch.transport = String(b.transport);
    if (b.config !== undefined) patch.config = asJsonString(b.config, "{}");
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    const s = updateMcpServer(id, patch as never);
    if (!s) return reply.code(404).send({ error: "MCP Server 不存在" });
    return reply.send(s);
  });
  app.delete("/api/mcp/:id", async (req, reply) => {
    deleteMcpServer((req.params as { id: string }).id);
    return reply.send({ ok: true });
  });
  app.post("/api/mcp/:id/refresh", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const tools = await refreshServer(id);
      return reply.send({ ok: true, tools });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
  app.get("/api/mcp/:id/tools", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const tools = await listServerTools(id);
      return reply.send({ tools });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // ---------- 日志与对话 ----------
  app.get("/api/logs", async (req) => {
    const q = req.query as Record<string, string>;
    const res = listRequests({
      search: q.search,
      status: q.status,
      protocol: q.protocol,
      model: q.model,
      provider_id: q.provider_id,
      tier_id: q.tier_id,
      conversation_id: q.conversation_id,
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
    return {
      ...res,
      items: res.items.map((r) => ({ ...r, ...computeSpeed(r), compression_ratio: compressionRatio(r) })),
    };
  });

  app.get("/api/logs/:id", async (req, reply) => {
    const r = getRequest((req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: "记录不存在" });
    const messages = listMessagesByRequest(r.id);
    return reply.send({ ...r, messages });
  });

  app.get("/api/conversations", async (req) => {
    const q = req.query as Record<string, string>;
    const res = listConversations({
      search: q.search,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
    const modelsMap = conversationModels(res.items.map((c) => c.id));
    const tokensMap = conversationTokens(res.items.map((c) => c.id));
    return {
      ...res,
      items: res.items.map((c) => ({ ...c, models: modelsMap[c.id] ?? [], tokens: tokensMap[c.id] ?? 0 })),
    };
  });

  app.get("/api/conversations/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const conv = getConversation(id);
    if (!conv) return reply.code(404).send({ error: "对话不存在" });
    const messages = listMessagesByConversation(id);
    return reply.send({ ...conv, messages });
  });

  app.get("/api/stats", async () => {
    return {
      totals: statsTotals(),
      daily: statsDaily(30),
      byModel: statsByModel(),
      byKey: statsByKey(),
      compression: statsCompression(),
    };
  });

  // ---------- 用量详情 ----------
  app.get("/api/usage/summary", async (req) => {
    return usageSummary(parseUsageFilter(req.query as Record<string, string>));
  });

  app.get("/api/usage/timeseries", async (req) => {
    const q = req.query as Record<string, string>;
    const granularity: Granularity = ["day", "week", "month", "year"].includes(q.granularity)
      ? (q.granularity as Granularity)
      : "day";
    return usageTimeseries(granularity, parseUsageFilter(q));
  });

  app.get("/api/usage/models", async (req) => {
    return usageByModel(parseUsageFilter(req.query as Record<string, string>));
  });

  app.get("/api/usage/keys", async (req) => {
    return usageByKey(parseUsageFilter(req.query as Record<string, string>));
  });

  // 全局实时调用速度（底部状态栏每秒轮询）
  app.get("/api/usage/live", async () => {
    return getGlobalLiveSpeed();
  });

  // 请求监控：按会话聚合的实时流量快照（监控面板每秒轮询）
  app.get("/api/monitor/sessions", async () => {
    const snap = monitorSnapshot();
    const keyNames = new Map(listApiKeys().map((k) => [k.id, k.name]));
    return {
      ...snap,
      sessions: snap.sessions.map((s) => ({
        ...s,
        apiKeyName: s.apiKeyId ? keyNames.get(s.apiKeyId) ?? null : null,
      })),
    };
  });

  // ---------- 客户端延迟（按来源 IP 区分，页面刷新不丢失） ----------
  app.get("/api/latency", async (req) => {
    return getLatency(req.ip ?? "unknown");
  });

  app.post("/api/latency", async (req, reply) => {
    const b = (req.body ?? {}) as { ms?: number };
    const ms = Number(b.ms);
    if (!Number.isFinite(ms) || ms < 0) return reply.code(400).send({ error: "无效的延迟值" });
    recordLatency(req.ip ?? "unknown", ms);
    return getLatency(req.ip ?? "unknown");
  });

  // ---------- 设置 ----------
  app.get("/api/settings", async () => {
    const out: Record<string, unknown> = {};
    for (const [k, d] of Object.entries(SETTINGS_DEFAULTS)) {
      out[k] = getSetting(k, d);
    }
    return out;
  });

  app.put("/api/settings", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(b)) {
      setSetting(k, v);
    }
    logger.info("设置已更新", Object.keys(b));
    return reply.send({ ok: true });
  });

  // ---------- 上下文压缩设置 ----------
  app.get("/api/compression", async () => {
    return getCompressionConfig();
  });

  app.put("/api/compression", async (req, reply) => {
    const b = (req.body ?? {}) as Partial<CompressionConfig>;
    const cur = getCompressionConfig();
    const next: CompressionConfig = {
      enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
      anchor_messages: b.anchor_messages !== undefined ? Number(b.anchor_messages) : cur.anchor_messages,
      window_messages: b.window_messages !== undefined ? Number(b.window_messages) : cur.window_messages,
      summarize_middle: b.summarize_middle !== undefined ? !!b.summarize_middle : cur.summarize_middle,
      summary_model: b.summary_model !== undefined ? String(b.summary_model) : cur.summary_model,
      auto_threshold_percent:
        b.auto_threshold_percent !== undefined
          ? Math.min(100, Math.max(1, Number(b.auto_threshold_percent) || 80))
          : cur.auto_threshold_percent,
      ucomp_summary_model:
        b.ucomp_summary_model !== undefined ? String(b.ucomp_summary_model) : cur.ucomp_summary_model,
    };
    saveCompressionConfig(next);
    return reply.send(next);
  });

  // ucomp 桥接环境自检（python 与 ucomp 包是否可用）
  app.get("/api/compression/ucomp-status", async () => {
    return ucompSelfCheck();
  });

  // ---------- 系统更新 ----------
  app.get("/api/update/check", async () => {
    return checkForUpdate();
  });

  app.post("/api/update/run", async (req, reply) => {
    try {
      const r = await runUpdate();
      if (!r.ok) return reply.code(500).send({ error: r.error });
      // 更新成功：延迟重启（launchd KeepAlive 会自动拉起）
      setTimeout(() => process.exit(0), 1500);
      return reply.send({ ok: true, message: "更新成功，服务即将重启" });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // 重启服务（launchd KeepAlive 会自动拉起）
  app.post("/api/system/restart", async (req, reply) => {
    setTimeout(() => process.exit(0), 800);
    return reply.send({ ok: true, message: "服务即将重启" });
  });

  // 数据库文件大小等系统信息
  app.get("/api/system", async () => {
    const db = getDb();
    const requests = (db.prepare("SELECT COUNT(*) AS c FROM requests").get() as { c: number }).c;
    const conversations = (db.prepare("SELECT COUNT(*) AS c FROM conversations").get() as { c: number }).c;
    const models = (db.prepare("SELECT COUNT(*) AS c FROM models").get() as { c: number }).c;
    const mcp = (db.prepare("SELECT COUNT(*) AS c FROM mcp_servers").get() as { c: number }).c;
    const skills = (db.prepare("SELECT COUNT(*) AS c FROM skills").get() as { c: number }).c;
    return {
      requests,
      conversations,
      models,
      mcp_servers: mcp,
      skills,
      version: getVersion(),
      uptime: Math.floor(process.uptime()),
    };
  });

  // ---------- 重置数据 / 恢复出厂 ----------
  app.post("/api/system/reset-data", async (req, reply) => {
    // 重置计数器数据：清空调用记录、消息、会话（保留配置）
    try {
      const db = getDb();
      transaction(() => {
        db.exec("DELETE FROM requests");
        db.exec("DELETE FROM messages");
        db.exec("DELETE FROM conversations");
        clearConversationCompactions();
      });
      return reply.send({ ok: true });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.post("/api/system/factory-reset", async (req, reply) => {
    // 恢复出厂设置：删除所有用户数据，恢复到初始状态；可选保留用户手动添加的供应商
    const b = (req.body ?? {}) as { keep_providers?: boolean };
    try {
      await resetToFactory(!!b.keep_providers);
      return reply.send({ ok: true });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // ---------- 备份 / 恢复 ----------
  app.post("/api/system/backup", async (req, reply) => {
    const b = (req.body ?? {}) as { password?: string };
    if (!b.password) return reply.code(400).send({ error: "请提供备份密码" });
    try {
      const tmp = path.join(config.dataDir, `backup-${Date.now()}.dat`);
      getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const buf = fs.readFileSync(tmp);
      fs.rmSync(tmp, { force: true });
      const enc = encryptBuffer(buf, b.password);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="anmast-backup-${new Date().toISOString().slice(0, 10)}.bin"`);
      return reply.send(enc);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.post("/api/system/restore", { bodyLimit: 512 * 1024 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as { data?: string; password?: string };
    if (!b.data) return reply.code(400).send({ error: "缺少备份数据" });
    if (!b.password) return reply.code(400).send({ error: "请提供备份密码" });
    try {
      let buf: Buffer;
      try {
        buf = decryptBuffer(Buffer.from(b.data, "base64"), b.password);
      } catch {
        return reply.code(400).send({ error: "备份密码错误，或文件不是有效的加密备份" });
      }
      // 校验 SQLite 文件头
      if (buf.length < 16 || buf.toString("utf8", 0, 15) !== "SQLite format 3") {
        return reply.code(400).send({ error: "不是有效的 SQLite 备份文件" });
      }
      const tmp = path.join(config.dataDir, `restore-${Date.now()}.dat`);
      fs.writeFileSync(tmp, buf);
      closeDb();
      fs.copyFileSync(tmp, config.dbPath);
      fs.rmSync(tmp, { force: true });
      await initDb();
      return reply.send({ ok: true });
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });
  });
}

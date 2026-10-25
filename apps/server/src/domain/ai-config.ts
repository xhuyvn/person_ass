import type {
  AiConnection,
  AiConnectionCreate,
  AiConnectionPatch,
  AiConnectionTest,
  AiConnectionTestResult,
  AiModelList,
  AiRole,
  AiRoleBinding,
  AiRolesPut,
  StructuredOutput,
} from "@personalass/contracts";
import { ProviderError } from "../ai/errors.js";
import { normalizeBaseUrl, type Transport } from "../ai/net-policy.js";
import { OpenAiCompatibleClient, type ResolvedConnection } from "../ai/openai-compatible.js";
import type { SecretBox } from "../secrets/master-key.js";
import { maskKey } from "../secrets/master-key.js";
import {
  DomainError,
  OWNER_ID,
  newId,
  notFound,
  nowIso,
  versionConflict,
  writeAudit,
  type Ctx,
  type Row,
} from "./core.js";

/** Runtime pieces the AI layer needs besides the database. */
export type AiDeps = {
  /** null when the master key could not be loaded: keys cannot be stored or used. */
  secrets: SecretBox | null;
  transport: Transport;
};

type ConnSettings = { timeout_ms: number; structured_output: StructuredOutput };

function settingsOf(row: Row): ConnSettings {
  let s: Partial<ConnSettings> = {};
  try {
    s = JSON.parse(String(row.settings_json)) as Partial<ConnSettings>;
  } catch {
    s = {};
  }
  return { timeout_ms: s.timeout_ms ?? 120000, structured_output: s.structured_output ?? "auto" };
}

export function toConnection(row: Row): AiConnection {
  const s = settingsOf(row);
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as AiConnection["kind"],
    base_url: String(row.base_url),
    privacy_scope: row.privacy_scope as AiConnection["privacy_scope"],
    enabled: Boolean(row.enabled),
    key_configured: row.encrypted_key !== null && row.encrypted_key !== undefined,
    key_label: (row.key_label as string | null) ?? null,
    timeout_ms: s.timeout_ms,
    structured_output: s.structured_output,
    version: Number(row.version),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function getConnectionRow(ctx: Ctx, id: string): Row {
  const row = ctx.db
    .prepare("SELECT * FROM ai_connections WHERE id = ? AND owner_id = ? AND archived_at IS NULL")
    .get(id, OWNER_ID) as Row | undefined;
  if (!row) throw notFound("Kết nối AI");
  return row;
}

function endpointOrThrow(baseUrl: string, kind: AiConnection["kind"]) {
  try {
    return normalizeBaseUrl(baseUrl, kind);
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Base URL không hợp lệ.";
    throw new DomainError("UNPROCESSABLE_ENTITY", message, { base_url: message });
  }
}

function requireSecrets(ai: AiDeps): SecretBox {
  if (!ai.secrets) {
    throw new DomainError("UNPROCESSABLE_ENTITY", "Master key chưa sẵn sàng nên không thể lưu API key. Xem RUNBOOK.", {
      api_key: "Master key chưa sẵn sàng.",
    });
  }
  return ai.secrets;
}

/** Jobs parked for configuration get another chance after a config change. */
function wakeWaitingJobs(ctx: Ctx): void {
  const now = nowIso(ctx);
  ctx.db
    .prepare(
      `UPDATE jobs SET state = 'queued', run_after = ?, updated_at = ?, version = version + 1
       WHERE owner_id = ? AND state = 'waiting_configuration'`,
    )
    .run(now, now, OWNER_ID);
}

export function listConnections(ctx: Ctx): AiConnection[] {
  const rows = ctx.db
    .prepare("SELECT * FROM ai_connections WHERE owner_id = ? AND archived_at IS NULL ORDER BY created_at")
    .all(OWNER_ID) as Row[];
  return rows.map(toConnection);
}

export const getConnection = (ctx: Ctx, id: string): AiConnection => toConnection(getConnectionRow(ctx, id));

export function createConnection(ctx: Ctx, ai: AiDeps, input: AiConnectionCreate): AiConnection {
  const endpoint = endpointOrThrow(input.base_url, input.kind);
  const id = newId();
  const now = nowIso(ctx);
  const sealed = input.api_key ? requireSecrets(ai).encrypt(input.api_key, id) : null;
  ctx.db
    .prepare(
      `INSERT INTO ai_connections (id, owner_id, name, kind, base_url, encrypted_key, key_label, privacy_scope,
         enabled, allowed_hosts_json, settings_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      OWNER_ID,
      input.name,
      input.kind,
      endpoint.baseUrl,
      sealed,
      input.api_key ? maskKey(input.api_key) : null,
      input.privacy_scope,
      input.enabled ? 1 : 0,
      JSON.stringify([endpoint.allowedHost]),
      JSON.stringify({ timeout_ms: input.timeout_ms, structured_output: input.structured_output }),
      now,
      now,
    );
  const conn = getConnection(ctx, id);
  writeAudit(ctx, { action: "ai_connection.create", entityType: "ai_connection", entityId: id, after: conn });
  wakeWaitingJobs(ctx);
  return conn;
}

export function patchConnection(ctx: Ctx, ai: AiDeps, id: string, input: AiConnectionPatch): AiConnection {
  const row = getConnectionRow(ctx, id);
  if (input.api_key && input.clear_api_key) {
    throw new DomainError("BAD_REQUEST", "Không thể vừa đặt vừa xóa API key.", { api_key: "Chọn một." });
  }
  const before = toConnection(row);
  const kind = before.kind;
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.privacy_scope !== undefined) set.privacy_scope = input.privacy_scope;
  if (input.enabled !== undefined) set.enabled = input.enabled ? 1 : 0;
  if (input.base_url !== undefined) {
    const endpoint = endpointOrThrow(input.base_url, kind);
    const oldHosts = JSON.parse(String(row.allowed_hosts_json)) as string[];
    // Never forward an existing key to a different host (docs/06 §2): moving
    // the endpoint requires entering the key again or clearing it.
    if (!oldHosts.includes(endpoint.allowedHost) && before.key_configured && !input.api_key && !input.clear_api_key) {
      throw new DomainError("UNPROCESSABLE_ENTITY", "Đổi máy chủ cần nhập lại API key hoặc xóa key.", {
        api_key: "Nhập lại API key cho máy chủ mới.",
      });
    }
    set.base_url = endpoint.baseUrl;
    set.allowed_hosts_json = JSON.stringify([endpoint.allowedHost]);
  }
  if (input.api_key) {
    set.encrypted_key = requireSecrets(ai).encrypt(input.api_key, id);
    set.key_label = maskKey(input.api_key);
  } else if (input.clear_api_key) {
    set.encrypted_key = null;
    set.key_label = null;
  }
  if (input.timeout_ms !== undefined || input.structured_output !== undefined) {
    const s = settingsOf(row);
    set.settings_json = JSON.stringify({
      timeout_ms: input.timeout_ms ?? s.timeout_ms,
      structured_output: input.structured_output ?? s.structured_output,
    });
  }
  const cols = Object.keys(set);
  const res = ctx.db
    .prepare(
      `UPDATE ai_connections SET ${cols.map((c) => `${c} = ?, `).join("")}version = version + 1, updated_at = ?
       WHERE id = ? AND owner_id = ? AND version = ?`,
    )
    .run(...(Object.values(set) as never[]), nowIso(ctx), id, OWNER_ID, input.expected_version);
  if (Number(res.changes) === 0) throw versionConflict("Kết nối AI");
  const after = getConnection(ctx, id);
  writeAudit(ctx, { action: "ai_connection.update", entityType: "ai_connection", entityId: id, before, after });
  wakeWaitingJobs(ctx);
  return after;
}

/**
 * Decrypt the key for one call. A key that cannot be decrypted (other master
 * key, tampering) is reported, never replaced by an empty key (docs/06 §2).
 */
export function resolveConnection(ctx: Ctx, ai: AiDeps, id: string): ResolvedConnection & { privacyScope: "local" | "cloud"; enabled: boolean } {
  const row = getConnectionRow(ctx, id);
  const s = settingsOf(row);
  let apiKey: string | null = null;
  if (row.encrypted_key) {
    if (!ai.secrets) throw new ProviderError("not_configured", "Master key chưa sẵn sàng nên không dùng được API key.");
    try {
      apiKey = ai.secrets.decrypt(String(row.encrypted_key), id);
    } catch {
      throw new ProviderError("not_configured", "Không giải mã được API key (master key không khớp). Nhập lại key.");
    }
  }
  return {
    id,
    kind: row.kind as ResolvedConnection["kind"],
    baseUrl: String(row.base_url),
    allowedHosts: JSON.parse(String(row.allowed_hosts_json)) as string[],
    apiKey,
    timeoutMs: s.timeout_ms,
    structuredOutput: s.structured_output,
    privacyScope: row.privacy_scope as "local" | "cloud",
    enabled: Boolean(row.enabled),
  };
}

/** Connection test: never saves anything and never throws for provider errors. */
export async function testConnection(
  ctx: Ctx,
  ai: AiDeps,
  id: string,
  input: AiConnectionTest,
): Promise<AiConnectionTestResult> {
  const started = Date.now();
  const base = { kind: input.kind, models_count: null, sample: null } as const;
  try {
    const client = new OpenAiCompatibleClient(resolveConnection(ctx, ai, id), ai.transport);
    if (input.kind === "metadata") {
      const models = await client.listModels();
      return { ...base, ok: true, latency_ms: Date.now() - started, models_count: models.length, error: null };
    }
    if (!input.model_id) {
      throw new DomainError("BAD_REQUEST", "Cần model_id để test text.", { model_id: "Bắt buộc với kind=text." });
    }
    const out = await client.chat({
      model: input.model_id,
      messages: [{ role: "user", content: "Trả lời đúng một từ: OK" }],
      maxTokens: 16,
      temperature: 0,
    });
    return { ...base, ok: true, latency_ms: out.latencyMs, sample: out.content.slice(0, 100), error: null };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const pe = err instanceof ProviderError ? err : new ProviderError("unavailable", "Lỗi không xác định khi test.");
    return { ...base, ok: false, latency_ms: null, error: pe.toDto() };
  }
}

export async function listModels(ctx: Ctx, ai: AiDeps, id: string): Promise<AiModelList> {
  try {
    const client = new OpenAiCompatibleClient(resolveConnection(ctx, ai, id), ai.transport);
    return { items: await client.listModels(), error: null, manual_allowed: true };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const pe = err instanceof ProviderError ? err : new ProviderError("unavailable", "Không tải được danh sách model.");
    return { items: [], error: pe.toDto(), manual_allowed: true };
  }
}

/* ---- role bindings ---- */

export function toRoleBinding(row: Row): AiRoleBinding {
  const params = JSON.parse(String(row.params_json)) as { max_tokens?: number; temperature?: number | null };
  const fallback = JSON.parse(String(row.fallback_policy_json)) as AiRoleBinding["fallback"];
  return {
    role: row.role as AiRole,
    connection_id: String(row.connection_id),
    model_id: String(row.model_id),
    max_tokens: params.max_tokens ?? 2048,
    temperature: params.temperature === undefined ? 0.1 : params.temperature,
    fallback: { bindings: fallback.bindings ?? [], allow_cloud: Boolean(fallback.allow_cloud) },
    version: Number(row.version),
    updated_at: String(row.updated_at),
  };
}

export function listRoles(ctx: Ctx): AiRoleBinding[] {
  const rows = ctx.db.prepare("SELECT * FROM ai_role_bindings WHERE owner_id = ? ORDER BY role").all(OWNER_ID) as Row[];
  return rows.map(toRoleBinding);
}

export function getRole(ctx: Ctx, role: AiRole): AiRoleBinding | null {
  const row = ctx.db
    .prepare("SELECT * FROM ai_role_bindings WHERE owner_id = ? AND role = ?")
    .get(OWNER_ID, role) as Row | undefined;
  return row ? toRoleBinding(row) : null;
}

export function putRoles(ctx: Ctx, input: AiRolesPut): AiRoleBinding[] {
  const seen = new Set<string>();
  for (const r of input.roles) {
    if (seen.has(r.role)) throw new DomainError("BAD_REQUEST", "Mỗi role chỉ khai báo một lần.", { roles: r.role });
    seen.add(r.role);
    for (const ref of [r, ...r.fallback.bindings]) getConnectionRow(ctx, ref.connection_id);
  }
  const now = nowIso(ctx);
  for (const r of input.roles) {
    const before = getRole(ctx, r.role);
    ctx.db
      .prepare(
        `INSERT INTO ai_role_bindings (id, owner_id, role, connection_id, model_id, params_json, fallback_policy_json,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, role) DO UPDATE SET connection_id = excluded.connection_id,
           model_id = excluded.model_id, params_json = excluded.params_json,
           fallback_policy_json = excluded.fallback_policy_json, version = version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        newId(),
        OWNER_ID,
        r.role,
        r.connection_id,
        r.model_id,
        JSON.stringify({ max_tokens: r.max_tokens, temperature: r.temperature }),
        JSON.stringify(r.fallback),
        now,
        now,
      );
    writeAudit(ctx, {
      action: "ai_role.update",
      entityType: "ai_role",
      entityId: r.role,
      before: before ?? undefined,
      after: getRole(ctx, r.role),
    });
  }
  wakeWaitingJobs(ctx);
  return listRoles(ctx);
}

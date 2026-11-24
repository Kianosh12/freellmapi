/**
 * Chat-completions routing for the Workers port — Phase 3 increment.
 *
 * Serves POST /v1/chat/completions against the D1 model pool: unified-key
 * auth, auto model routing (best ranked enabled model with a usable key),
 * provider forwarding over the OpenAI-compatible surface, SSE passthrough
 * for streamed calls, rate-limit cooldowns and request logging.
 */

import { sealKey, unsealKey } from './crypto';
import { endpointFor } from './providers';

export interface Env {
  DB?: D1Database;
  CACHE?: KVNamespace;
  ENCRYPTION_KEY?: string;
  UNIFIED_API_KEY?: string;
  ADMIN_KEY?: string;
  BOOTSTRAP_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

type ModelRow = {
  id: number;
  platform: string;
  model_id: string;
  display_name: string;
};

type KeyRow = {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
};

const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 60_000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export function apiErrorResponse(message: string, type: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message, type } }), { status, headers: JSON_HEADERS });
}

function extractToken(request: Request): string | undefined {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const xApiKey = request.headers.get('x-api-key')?.trim();
  return xApiKey || undefined;
}

export function requireInferenceAuth(request: Request, env: Env): Response | null {
  if (!env.UNIFIED_API_KEY) {
    return apiErrorResponse(
      'Worker is missing the UNIFIED_API_KEY secret; inference endpoints are disabled until it is set',
      'configuration_error',
      503,
    );
  }
  if (extractToken(request) !== env.UNIFIED_API_KEY) {
    return apiErrorResponse('Invalid API key', 'authentication_error', 401);
  }
  return null;
}

export function requireAdminAuth(request: Request, env: Env): Response | null {
  if (!env.ADMIN_KEY) {
    return apiErrorResponse(
      'Worker is missing the ADMIN_KEY secret; key management endpoints are disabled until it is set',
      'configuration_error',
      503,
    );
  }
  if (extractToken(request) !== env.ADMIN_KEY) {
    return apiErrorResponse('Invalid admin key', 'authentication_error', 401);
  }
  return null;
}

interface ChatCallBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isAutoModel(modelId: unknown): boolean {
  if (typeof modelId !== 'string' || modelId.length === 0) return true;
  const lower = modelId.toLowerCase();
  return lower === 'auto' || lower.startsWith('auto:');
}

async function candidateModels(db: D1Database, requestedId: string | null): Promise<ModelRow[]> {
  if (requestedId) {
    const row = await db
      .prepare(
        `SELECT m.id, m.platform, m.model_id, m.display_name FROM models m
         WHERE m.enabled = 1 AND m.model_id = ? LIMIT 1`,
      )
      .bind(requestedId)
      .first<ModelRow>();
    return row ? [row] : [];
  }
  const { results } = await db
    .prepare(
      `SELECT m.id, m.platform, m.model_id, m.display_name FROM models m
       WHERE m.enabled = 1
         AND EXISTS (
           SELECT 1 FROM api_keys k
           WHERE k.platform = m.platform
             AND k.enabled = 1
             AND k.status != 'disabled'
             AND NOT EXISTS (
               SELECT 1 FROM rate_limit_cooldowns c
               WHERE c.platform = k.platform AND c.key_id = k.id AND c.expires_at_ms > ?
             )
         )
       ORDER BY m.intelligence_rank ASC, m.speed_rank ASC
       LIMIT 25`,
    )
    .bind(Date.now())
    .all<ModelRow>();
  return results ?? [];
}

async function keyForPlatform(db: D1Database, platform: string): Promise<KeyRow | null> {
  return db
    .prepare(
      `SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys
       WHERE platform = ? AND enabled = 1
         AND status != 'disabled'
         AND NOT EXISTS (
           SELECT 1 FROM rate_limit_cooldowns c
           WHERE c.platform = api_keys.platform AND c.key_id = api_keys.id AND c.expires_at_ms > ?
         )
       ORDER BY id LIMIT 1`,
    )
    .bind(platform, Date.now())
    .first<KeyRow>();
}

async function recordRequest(
  db: D1Database,
  platform: string,
  modelId: string,
  keyId: number | null,
  status: string,
  usage: { input: number; output: number },
  latencyMs: number,
  error: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(platform, modelId, keyId, status, usage.input, usage.output, latencyMs, error)
    .run();
  await db
    .prepare(`INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', 1, ?)`)
    .bind(platform, modelId, keyId ?? 0, Date.now())
    .run();
}

async function recordCooldown(db: D1Database, platform: string, modelId: string, keyId: number | null): Promise<void> {
  if (keyId === null) return;
  await db
    .prepare(
      `INSERT INTO rate_limit_cooldowns (platform, model_id, key_id, expires_at_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT(platform, model_id, key_id) DO UPDATE SET expires_at_ms = excluded.expires_at_ms`,
    )
    .bind(platform, modelId, keyId, Date.now() + COOLDOWN_MS)
    .run();
}

export async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  if (!env.DB) return apiErrorResponse('D1 binding (DB) is not available', 'configuration_error', 503);
  const db = env.DB;

  const body = (await readJson(request)) as ChatCallBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiErrorResponse("'messages' must be a non-empty array", 'invalid_request_error', 400);
  }
  const stream = body.stream === true;
  const requestedId = isAutoModel(body.model) ? null : String(body.model);
  const candidates = await candidateModels(db, requestedId);
  if (candidates.length === 0) {
    return apiErrorResponse(
      requestedId
        ? `Model '${requestedId}' is not enabled or does not exist`
        : 'No enabled model has a registered API key yet — add one via POST /api/keys',
      'invalid_request_error',
      404,
    );
  }

  const attempts = candidates.slice(0, MAX_ATTEMPTS);
  let lastFailure: { status: number; message: string } | null = null;

  for (const candidate of attempts) {
    const keyRow = await keyForPlatform(db, candidate.platform);
    if (!keyRow) continue;

    let providerKey: string;
    try {
      providerKey = await unsealKey(keyRow, env.ENCRYPTION_KEY);
    } catch {
      await recordRequest(db, candidate.platform, candidate.model_id, keyRow.id, 'decrypt_error', { input: 0, output: 0 }, 0, 'failed to decrypt stored key');
      lastFailure = { status: 503, message: 'Stored provider key could not be decrypted (check ENCRYPTION_KEY)' };
      continue;
    }

    const endpoint = endpointFor(candidate.platform, env.CLOUDFLARE_ACCOUNT_ID);
    if (!endpoint) {
      lastFailure = { status: 503, message: `Platform '${candidate.platform}' has no endpoint mapping` };
      continue;
    }

    const upstreamBody = JSON.stringify({ ...body, model: candidate.model_id });
    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${providerKey}`,
          ...(endpoint.extraHeaders ?? {}),
        },
        body: upstreamBody,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'network error';
      await recordRequest(db, candidate.platform, candidate.model_id, keyRow.id, 'network_error', { input: 0, output: 0 }, Date.now() - started, message);
      lastFailure = { status: 502, message: `Upstream fetch failed for ${candidate.model_id}: ${message}` };
      continue;
    }

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 500);
      const rateLimited = upstream.status === 429 || upstream.status === 402 || upstream.status >= 500;
      if (rateLimited) await recordCooldown(db, candidate.platform, candidate.model_id, keyRow.id);
      await recordRequest(
        db,
        candidate.platform,
        candidate.model_id,
        keyRow.id,
        rateLimited ? 'rate_limited' : 'upstream_error',
        { input: 0, output: 0 },
        Date.now() - started,
        `HTTP ${upstream.status}: ${detail}`,
      );
      lastFailure = { status: rateLimited ? 502 : upstream.status, message: `Provider returned HTTP ${upstream.status}` };
      continue;
    }

    const routedHeaders = {
      'x-freellm-model': candidate.model_id,
      'x-freellm-platform': candidate.platform,
      'x-freellm-key-id': String(keyRow.id),
      'access-control-allow-origin': '*',
    };

    if (stream) {
      const passthrough = new Response(upstream.body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', ...routedHeaders },
      });
      // Log once the stream is drained; keep the response flowing meanwhile.
      const { readable, writable } = new TransformStream();
      passthrough.body?.pipeTo(writable).then(
        () => recordRequest(db, candidate.platform, candidate.model_id, keyRow.id, 'ok', { input: 0, output: 0 }, Date.now() - started, null),
        () => recordRequest(db, candidate.platform, candidate.model_id, keyRow.id, 'stream_error', { input: 0, output: 0 }, Date.now() - started, 'stream aborted'),
      );
      return new Response(readable, { status: 200, headers: passthrough.headers });
    }

    const json = (await upstream.json()) as Record<string, unknown>;
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
    await recordRequest(
      db,
      candidate.platform,
      candidate.model_id,
      keyRow.id,
      'ok',
      { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 },
      Date.now() - started,
      null,
    );
    return new Response(JSON.stringify(json), { status: 200, headers: { ...JSON_HEADERS, ...routedHeaders } });
  }

  return apiErrorResponse(
    lastFailure?.message ?? 'All candidate models failed',
    'upstream_error',
    lastFailure?.status ?? 502,
  );
}

export async function createProviderKey(db: D1Database, env: Env, payload: Record<string, unknown>): Promise<Response> {
  const platform = typeof payload.platform === 'string' ? payload.platform.trim().toLowerCase() : '';
  const providerKey = typeof payload.key === 'string' ? payload.key.trim() : '';
  const label = typeof payload.label === 'string' ? payload.label.trim() : '';
  if (!platform || !providerKey) {
    return apiErrorResponse("Both 'platform' and 'key' are required", 'invalid_request_error', 400);
  }
  if (!endpointFor(platform, env.CLOUDFLARE_ACCOUNT_ID)) {
    return apiErrorResponse(`Platform '${platform}' is not supported by the Workers port`, 'invalid_request_error', 400);
  }
  const sealed = await sealKey(providerKey, env.ENCRYPTION_KEY);
  const result = await db
    .prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status) VALUES (?, ?, ?, ?, ?, 'unknown')`,
    )
    .bind(platform, label, sealed.encrypted_key, sealed.iv, sealed.auth_tag)
    .run();
  return Response.json({ id: result.meta.last_row_id, platform, label }, { status: 201, headers: JSON_HEADERS });
}

export async function listProviderKeys(db: D1Database): Promise<Response> {
  const { results } = await db
    .prepare(`SELECT id, platform, label, status, enabled, created_at, last_checked_at FROM api_keys ORDER BY id`)
    .all();
  return Response.json({ object: 'list', data: results ?? [] }, { headers: JSON_HEADERS });
}

export async function deleteProviderKey(db: D1Database, id: number): Promise<Response> {
  const result = await db.prepare(`DELETE FROM api_keys WHERE id = ?`).bind(id).run();
  if ((result.meta.changes ?? 0) === 0) return apiErrorResponse(`Key ${id} not found`, 'invalid_request_error', 404);
  return Response.json({ deleted: id }, { headers: JSON_HEADERS });
}

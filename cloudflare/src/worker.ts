/**
 * FreeLLMAPI on Cloudflare Workers — Phase 3 entrypoint.
 *
 * Live surfaces: /health, GET /v1/models (D1-backed), POST /v1/chat/completions
 * (provider routing over the OpenAI-compatible surface, SSE streaming) and the
 * admin key-management API (/api/keys) sealed with AES-256-GCM in D1.
 */

import {
  type Env,
  apiErrorResponse,
  requireAdminAuth,
  requireInferenceAuth,
  handleChatCompletions,
  createProviderKey,
  listProviderKeys,
  deleteProviderKey,
  handleBootstrap,
} from './chat';

export type { Env };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, x-admin-key',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      let db = 'pending';
      if (env.DB) {
        try {
          await env.DB.prepare('SELECT 1').first();
          db = 'ok';
        } catch {
          db = 'unavailable';
        }
      }
      return Response.json({
        status: 'ok',
        service: 'freellmapi',
        runtime: 'cloudflare-workers',
        db,
        time: new Date().toISOString(),
      }, { headers: CORS });
    }

    if (url.pathname === '/v1/models' && request.method === 'GET') {
      if (env.DB) {
        try {
          const { results } = await env.DB.prepare(
            'SELECT id, platform, model_id, display_name FROM models WHERE enabled = 1 ORDER BY platform, model_id LIMIT 1000',
          ).all<{ id: number; platform: string; model_id: string; display_name: string }>();
          return Response.json(
            {
              object: 'list',
              data: (results ?? []).map((r) => ({
                id: r.model_id,
                object: 'model',
                owned_by: r.platform,
                display_name: r.display_name,
              })),
            },
            { headers: CORS },
          );
        } catch {
          return Response.json({ object: 'list', data: [] }, { headers: CORS });
        }
      }
      return Response.json({ object: 'list', data: [] }, { headers: CORS });
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      const denied = requireInferenceAuth(request, env);
      if (denied) return denied;
      return handleChatCompletions(request, env);
    }

    if (url.pathname === '/api/keys') {
      if (!env.DB) return apiErrorResponse('D1 binding (DB) is not available', 'configuration_error', 503);
      const denied = requireAdminAuth(request, env);
      if (denied) return denied;
      if (request.method === 'POST') {
        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return apiErrorResponse('Request body must be JSON', 'invalid_request_error', 400);
        }
        return createProviderKey(env.DB, env, payload);
      }
      if (request.method === 'GET') return listProviderKeys(env.DB);
    }

    if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
      if (!env.DB) return apiErrorResponse('D1 binding (DB) is not available', 'configuration_error', 503);
      return handleBootstrap(request, env.DB, env);
    }

    const keyDelete = url.pathname.match(/^\/api\/keys\/(\d+)$/);
    if (keyDelete && request.method === 'DELETE') {
      if (!env.DB) return apiErrorResponse('D1 binding (DB) is not available', 'configuration_error', 503);
      const denied = requireAdminAuth(request, env);
      if (denied) return denied;
      return deleteProviderKey(env.DB, Number(keyDelete[1]));
    }

    return apiErrorResponse(
      `Not implemented yet in the Workers port: ${request.method} ${url.pathname}`,
      'invalid_request_error',
      404,
    );
  },
} satisfies ExportedHandler<Env>;

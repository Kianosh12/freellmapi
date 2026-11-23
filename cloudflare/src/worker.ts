/**
 * FreeLLMAPI on Cloudflare Workers — Phase 2 entrypoint.
 *
 * The full Express port lands via the shim (see
 * docs/cloudflare-migration/PHASE-1-ARCHITECTURE-REPORT.md §5); this worker
 * already serves the live health surface and the D1-backed /v1/models listing
 * so the deployment pipeline is exercised end to end.
 */

export interface Env {
  DB?: D1Database; // D1 database "freellmapi" (id 3c41b5b8-55d4-4775-9a00-b3839e913d7c)
  CACHE?: KVNamespace;
}

type ModelRow = { id: number; platform: string; model_id: string; display_name: string };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-api-key',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

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
      }, { headers: cors });
    }

    if (url.pathname === '/v1/models' && request.method === 'GET') {
      if (env.DB) {
        try {
          const { results } = await env.DB.prepare(
            'SELECT id, platform, model_id, display_name FROM models WHERE enabled = 1 ORDER BY platform, model_id LIMIT 1000',
          ).all<ModelRow>();
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
            { headers: cors },
          );
        } catch {
          return Response.json({ object: 'list', data: [] }, { headers: cors });
        }
      }
      return Response.json({ object: 'list', data: [] }, { headers: cors });
    }

    return Response.json(
      { error: { message: `Not implemented yet in the Workers port: ${request.method} ${url.pathname}`, type: 'invalid_request_error' } },
      { status: 404, headers: cors },
    );
  },
} satisfies ExportedHandler<Env>;

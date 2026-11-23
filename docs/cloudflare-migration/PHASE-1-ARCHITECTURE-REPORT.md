# FreeLLMAPI → Cloudflare Migration — Phase 1 Architecture Report

Status: **Approved baseline for Phases 2–5** · Date: 2026-11-22
Goal: run FreeLLMAPI permanently on Cloudflare (Workers + D1 + KV + R2 + Workers Assets) with **no VPS, no Docker, no dedicated server**, and **no rewrite from scratch** — code, architecture, providers, model registry, smart routing, failover and the dashboard are preserved.

## 1. Current architecture (as measured in the repo)

| Area | Implementation | Files |
|---|---|---|
| Runtime | Node.js ≥ 20, Express 5, `tsx` dev, `tsc` build | `server/src/index.ts`, `app.ts` |
| HTTP routers | 31 Express routers (`/v1/chat/completions`, `/v1/responses`, Anthropic, Gemini, Ollama, embeddings, media, search, MCP, admin…) | `server/src/routes/` |
| Providers | ~50 provider adapters, isolated from Node-only deps | `server/src/providers/*.ts` |
| Model registry / catalog | shared types + server registry, catalog sync, discovery, retirement, pricing | `shared/`, `server/src/services/model-*.ts` |
| Smart routing / failover | scoring, router, decision, cooldown-probe, fallback-loop, penalty, quota services | `server/src/services/` |
| Database | SQLite (better-sqlite3 / node:sqlite), **synchronous**, 52 TS migrations, custom migrate runner | `server/src/db/` |
| Auth | password auth + API-key management, encryption-at-rest via `node:crypto` | `server/src/services/auth.ts`, `lib/crypto.ts` |
| Rate limiting | in-process token-bucket middlewares | `server/src/middleware/rateLimit.ts` |
| Dashboard | React 19 + Vite + Tailwind + shadcn SPA | `client/` |
| Media / images | `sharp` (native), voice gateways, TTS providers | `server/src/services/media*.ts` |

## 2. Incompatibilities with Cloudflare Workers (and their replacements)

| # | Incompatible | Why | Cloudflare replacement | Phase |
|---|---|---|---|---|
| 1 | `express` + middleware chain | Node HTTP server; `req/res` objects | Worker `fetch` handler + thin Express-compatible shim so **route files stay unchanged** | 2 |
| 2 | better-sqlite3 / `node:sqlite` (sync) | no native modules, no FS | **D1** with an async `Db` adapter; migrate runner ported to D1 SQL batches | 3 |
| 3 | 52 TS migrations | run against local file | converted to D1 `migrations/*.sql`, applied with `wrangler d1 migrations` | 3 |
| 4 | `sharp` | native C++ | **Workers Images / R2 + WebP via `@cloudflare/images`**, TTS/media proxied unchanged | 4 |
| 5 | in-memory rate limits & cache | process resets, multiple isolates | **KV / Durable Objects** (DO for counters, KV for cache) | 3 |
| 6 | FS paths (db file, backups, exports) | no disk | **R2** bucket for backups/exports | 4 |
| 7 | `socks-proxy-agent` | raw sockets | not used by any provider adapter (verified); generic custom-endpoint proxying goes through Cloudflare egress | — |
| 8 | `node:crypto` in providers | partially supported | `nodejs_compat` flag covers the used subset; `lib/crypto.ts` keys move to **Workers Secrets** | 2 |
| 9 | Long-running loops (catalog sync, probes) | no setInterval | **Cron Triggers** (scheduled handler) | 4 |
| 10 | Dashboard static hosting | Express serves dist | **Workers Assets** serving `client/dist` from the same Worker | 2 |

## 3. What is preserved as-is

- **All ~50 provider adapters** (`src/providers/*.ts`) — verified imports are only `node:crypto` and `@freellmapi/shared/types.js`.
- **Model registry, catalog sync, discovery, retirement, pricing** logic (service layer is pure TS).
- **Smart routing, scoring, decision, failover/fallback loop, cooldowns, penalties, quotas** — pure TS services.
- **All 31 route definitions** — kept, via the Express shim.
- **Dashboard client** — built with Vite and served by Workers Assets, unchanged source.

## 4. Target topology

```
Client → Worker (fetch handler)
          ├─ Express shim → src/routes/* (unchanged)
          │     └─ services (router, scoring, failover) → providers/* → upstream LLMs
          ├─ D1 (freeapi database, migrations)
          ├─ KV  (cache, model-catalog snapshot)
          ├─ DO  (rate-limit counters, cooldown state)
          ├─ R2  (backups, key exports, media)
          ├─ Cron triggers (catalog sync, health probes)
          └─ Assets (client/dist dashboard, SPA fallback)
```

## 5. Phase plan

1. **Phase 1 – Analysis** (this document).
2. **Phase 2 – Runtime swap**: `cloudflare/` worker project, Express shim, `nodejs_compat`, D1/KV/R2/DO bindings, deploy + `/health` live.
3. **Phase 3 – Data**: D1 schema generated from the 52 migrations, `Db` async adapter, migrate-runner port, KV cache, DO rate limiter.
4. **Phase 4 – Features**: R2 backups, cron syncs, media, secrets/vault for provider keys.
5. **Phase 5 – Cutover**: end-to-end tests against the deployed Worker, dashboard on the same domain, docs.

## 6. Cloudflare account (connected)

- Account: `56f470e64ef4a139b78588ce5c7116c7` (verified via `POST /user/tokens/verify` → `active`).
- Token stored locally in `.env.cloudflare` (git-ignored, 0600); used as `CLOUDFLARE_API_TOKEN` for wrangler.

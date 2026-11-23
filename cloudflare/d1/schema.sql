-- FreeLLMAPI on Cloudflare D1 — Phase 2 baseline schema.
-- Ported from server/src/db/migrations/20260101_000000_legacy_baseline.ts (SQLite).
-- The full 52-migration port lands in Phase 3; this enables /health and /v1/models.

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  intelligence_rank INTEGER NOT NULL,
  speed_rank INTEGER NOT NULL,
  size_label TEXT NOT NULL DEFAULT '',
  rpm_limit INTEGER,
  rpd_limit INTEGER,
  tpm_limit INTEGER,
  tpd_limit INTEGER,
  monthly_token_budget TEXT NOT NULL DEFAULT '',
  context_window INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  UNIQUE(platform, model_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limit_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
  platform TEXT NOT NULL,
  model_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, model_id, key_id)
);

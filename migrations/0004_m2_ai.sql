-- 0004_m2_ai.sql — M2 AI text: connections, role bindings, job queue, AI runs,
-- proposals/actions, clarifications (docs/03 §2, docs/04).
-- ADDITIVE only (docs/07 DoD); never drops or rewrites existing data.

-- Memo privacy: local_only memos are never sent to a cloud connection (A20).
ALTER TABLE memos ADD COLUMN privacy TEXT NOT NULL DEFAULT 'default'
  CHECK (privacy IN ('default', 'local_only'));

-- Provider connections. The API key is stored encrypted (AES-256-GCM with the
-- master key kept OUTSIDE this database, docs/06 §2); never returned by the API.
CREATE TABLE IF NOT EXISTS ai_connections (
  id                 TEXT PRIMARY KEY NOT NULL,
  owner_id           TEXT NOT NULL,
  name               TEXT NOT NULL,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('openrouter', 'ollama_local', 'ollama_cloud', 'custom_openai')),
  base_url           TEXT NOT NULL,
  encrypted_key      TEXT,
  key_label          TEXT,
  -- Declared by the owner, independent of the hostname (docs/04 §6).
  privacy_scope      TEXT NOT NULL CHECK (privacy_scope IN ('local', 'cloud')),
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allowed_hosts_json TEXT NOT NULL,
  settings_json      TEXT NOT NULL DEFAULT '{}',
  archived_at        TEXT,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_role_bindings (
  id                   TEXT PRIMARY KEY NOT NULL,
  owner_id             TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('information', 'ocr', 'assistant')),
  connection_id        TEXT NOT NULL REFERENCES ai_connections(id),
  model_id             TEXT NOT NULL,
  params_json          TEXT NOT NULL DEFAULT '{}',
  fallback_policy_json TEXT NOT NULL DEFAULT '{"bindings":[],"allow_cloud":false}',
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (owner_id, role)
);

-- Durable job queue with leases and a fencing token (docs/02 §4, A08/A32).
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY NOT NULL,
  owner_id         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('process_memo')),
  memo_revision_id TEXT NOT NULL REFERENCES memo_revisions(id),
  previous_job_id  TEXT REFERENCES jobs(id),
  state            TEXT NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('queued', 'running', 'retry_wait', 'waiting_configuration',
                                      'succeeded', 'failed', 'cancelled')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  run_after        TEXT NOT NULL,
  lease_owner      TEXT,
  lease_expires_at TEXT,
  heartbeat_at     TEXT,
  fencing_token    INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,
  error_message    TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (state, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_revision ON jobs (memo_revision_id);

-- One row per provider call; normalized metadata only, no raw prompt/response
-- unless ENABLE_DEBUG_AI (docs/04 §6). usage/latency may be null.
CREATE TABLE IF NOT EXISTS ai_runs (
  id             TEXT PRIMARY KEY NOT NULL,
  owner_id       TEXT NOT NULL,
  job_id         TEXT NOT NULL REFERENCES jobs(id),
  role           TEXT NOT NULL,
  connection_id  TEXT,
  model_id       TEXT,
  prompt_version TEXT,
  attempt        INTEGER NOT NULL,
  purpose        TEXT NOT NULL CHECK (purpose IN ('extract', 'repair')),
  status         TEXT NOT NULL CHECK (status IN ('ok', 'provider_error', 'invalid_output')),
  error_code     TEXT,
  usage_json     TEXT,
  latency_ms     INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_job ON ai_runs (job_id);

CREATE TABLE IF NOT EXISTS proposals (
  id                 TEXT PRIMARY KEY NOT NULL,
  owner_id           TEXT NOT NULL,
  job_id             TEXT NOT NULL REFERENCES jobs(id),
  memo_revision_id   TEXT NOT NULL REFERENCES memo_revisions(id),
  schema_version     TEXT NOT NULL,
  prompt_version     TEXT NOT NULL,
  model_id           TEXT,
  connection_id      TEXT,
  payload_json       TEXT NOT NULL,
  state              TEXT NOT NULL
                       CHECK (state IN ('applied', 'partial', 'needs_clarification', 'nothing_to_apply')),
  action_group_id    TEXT REFERENCES action_groups(id),
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (job_id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_revision ON proposals (memo_revision_id);

-- stable_key is computed by the backend (operation + target + evidence +
-- normalized payload), never the model's action_id (docs/03 §5).
CREATE TABLE IF NOT EXISTS proposal_actions (
  id                 TEXT PRIMARY KEY NOT NULL,
  owner_id           TEXT NOT NULL,
  proposal_id        TEXT NOT NULL REFERENCES proposals(id),
  memo_revision_id   TEXT NOT NULL REFERENCES memo_revisions(id),
  model_action_id    TEXT NOT NULL,
  stable_key         TEXT NOT NULL,
  operation          TEXT NOT NULL,
  entity_type        TEXT NOT NULL,
  target_id          TEXT,
  expected_version   INTEGER,
  fields_json        TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  depends_on_json    TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL
                       CHECK (status IN ('applied', 'needs_clarification', 'waiting_dependency',
                                         'rejected', 'duplicate', 'dismissed')),
  reason             TEXT,
  result_entity_type TEXT,
  result_entity_id   TEXT,
  action_group_id    TEXT REFERENCES action_groups(id),
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposal_actions_proposal ON proposal_actions (proposal_id);
-- One APPLIED action per (source revision, stable key): a reprocess or a
-- retried commit can never create the same entity twice (A07/A08).
CREATE UNIQUE INDEX IF NOT EXISTS uq_proposal_actions_applied
  ON proposal_actions (memo_revision_id, stable_key) WHERE status = 'applied';

CREATE TABLE IF NOT EXISTS clarifications (
  id                 TEXT PRIMARY KEY NOT NULL,
  owner_id           TEXT NOT NULL,
  proposal_action_id TEXT NOT NULL REFERENCES proposal_actions(id),
  kind               TEXT NOT NULL CHECK (kind IN ('missing_fields', 'choose_target', 'confirm', 'revalidate')),
  field_path         TEXT,
  question           TEXT NOT NULL,
  options_json       TEXT NOT NULL DEFAULT '[]',
  answer_json        TEXT,
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'dismissed')),
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clarifications_open ON clarifications (owner_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_group ON audit_events (action_group_id);

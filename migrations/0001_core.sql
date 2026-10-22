-- 0001_core.sql — M1-ready minimal subset of docs/03 §2.
-- Rules: TEXT UUID ids, UTC ISO-8601 timestamps, date-only as YYYY-MM-DD,
-- version/created_at/updated_at on every mutable table.
-- Idempotent: all statements use IF NOT EXISTS, never drops or deletes data.

CREATE TABLE IF NOT EXISTS settings (
  id                      TEXT PRIMARY KEY NOT NULL,
  owner_id                TEXT NOT NULL,
  timezone                TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  locale                  TEXT NOT NULL DEFAULT 'vi-VN',
  reminder_defaults_json  TEXT NOT NULL DEFAULT '{}',
  schema_version          INTEGER NOT NULL DEFAULT 1,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (owner_id)
);

CREATE TABLE IF NOT EXISTS areas (
  id              TEXT PRIMARY KEY NOT NULL,
  owner_id        TEXT NOT NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  archived_at     TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (owner_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS categories (
  id              TEXT PRIMARY KEY NOT NULL,
  owner_id        TEXT NOT NULL,
  area_id         TEXT REFERENCES areas(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  archived_at     TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (owner_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY NOT NULL,
  owner_id      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  factual_notes TEXT,
  archived_at   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY NOT NULL,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'on_hold', 'done', 'archived')),
  target_date TEXT
                CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  archived_at TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memos (
  id                  TEXT PRIMARY KEY NOT NULL,
  owner_id            TEXT NOT NULL,
  client_request_id   TEXT,
  -- Single parent link to memo_revisions; FK added by a later migration to
  -- avoid a circular FK between memos and memo_revisions.
  current_revision_id TEXT,
  archived_at         TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (owner_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS memo_revisions (
  id          TEXT PRIMARY KEY NOT NULL,
  memo_id     TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  raw_text    TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  input_kind  TEXT NOT NULL DEFAULT 'text'
                CHECK (input_kind IN ('text', 'image', 'mixed')),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (memo_id, revision_no)
);

CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY NOT NULL,
  owner_id             TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT,
  status               TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'archived')),
  priority             INTEGER NOT NULL DEFAULT 0
                         CHECK (priority BETWEEN 0 AND 4),
  project_id           TEXT REFERENCES projects(id) ON DELETE SET NULL,
  area_id              TEXT REFERENCES areas(id) ON DELETE SET NULL,
  category_id          TEXT REFERENCES categories(id) ON DELETE SET NULL,
  due_date             TEXT
                         CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_at               TEXT,
  planned_at           TEXT,
  waiting_on_person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  follow_up_at         TEXT,
  completed_at         TEXT,
  recurrence_series_id TEXT,
  archived_at          TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  -- due_date and due_at are mutually exclusive (docs/03 §3)
  CHECK (due_date IS NULL OR due_at IS NULL)
);

CREATE TABLE IF NOT EXISTS appointments (
  id          TEXT PRIMARY KEY NOT NULL,
  owner_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  starts_at   TEXT,
  local_date  TEXT
                CHECK (local_date IS NULL OR local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ends_at     TEXT,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  all_day     INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
  status      TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'done', 'cancelled', 'archived')),
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  area_id     TEXT REFERENCES areas(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  archived_at TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- timed appointments require starts_at; all_day appointments require local_date
  CHECK (
    (all_day = 1 AND local_date IS NOT NULL AND starts_at IS NULL) OR
    (all_day = 0 AND local_date IS NULL AND starts_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS reminder_rules (
  id               TEXT PRIMARY KEY NOT NULL,
  owner_id         TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  anchor           TEXT NOT NULL
                     CHECK (anchor IN ('due_date', 'due_at', 'starts_at', 'local_date', 'follow_up_at')),
  offset_minutes   INTEGER NOT NULL DEFAULT 0,
  local_time       TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  schedule_revision INTEGER NOT NULL DEFAULT 1,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_links (
  id               TEXT PRIMARY KEY NOT NULL,
  owner_id         TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  memo_revision_id TEXT REFERENCES memo_revisions(id) ON DELETE SET NULL,
  attachment_id    TEXT,
  ocr_run_id       TEXT,
  quote            TEXT,
  text_start       INTEGER,
  text_end         INTEGER,
  field_path       TEXT,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entity_links (
  id         TEXT PRIMARY KEY NOT NULL,
  owner_id   TEXT NOT NULL,
  from_type  TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  relation   TEXT NOT NULL,
  to_type    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (from_type, from_id, relation, to_type, to_id)
);

CREATE TABLE IF NOT EXISTS action_groups (
  id                TEXT PRIMARY KEY NOT NULL,
  owner_id          TEXT NOT NULL,
  source_revision_id TEXT,
  schema_version    INTEGER NOT NULL DEFAULT 1,
  prompt_version    TEXT,
  payload_json      TEXT,
  state             TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (state IN ('proposed', 'applied', 'undone', 'failed')),
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT PRIMARY KEY NOT NULL,
  owner_id        TEXT NOT NULL,
  actor           TEXT NOT NULL CHECK (actor IN ('user', 'ai', 'system')),
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  action_group_id TEXT REFERENCES action_groups(id) ON DELETE SET NULL,
  before_json     TEXT,
  after_json      TEXT,
  versions_json   TEXT,
  source          TEXT,
  correlation_id  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_idempotency (
  id           TEXT PRIMARY KEY NOT NULL,
  owner_id     TEXT NOT NULL,
  key          TEXT NOT NULL,
  route_scope  TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_ref TEXT,
  expires_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (owner_id, key, route_scope)
);

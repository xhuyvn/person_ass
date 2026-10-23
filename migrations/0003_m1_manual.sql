-- 0003_m1_manual.sql — M1 manual slice: notes, occurrences, in-app notifications.
-- ADDITIVE only (docs/07 DoD); never drops or rewrites existing data.

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY NOT NULL,
  owner_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  area_id     TEXT REFERENCES areas(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  archived_at TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_owner ON notes (owner_id, archived_at);

-- One row per scheduled firing of a reminder rule (docs/03 §2, docs/05 §4).
CREATE TABLE IF NOT EXISTS occurrences (
  id                TEXT PRIMARY KEY NOT NULL,
  owner_id          TEXT NOT NULL,
  rule_id           TEXT NOT NULL REFERENCES reminder_rules(id) ON DELETE CASCADE,
  occurrence_key    TEXT NOT NULL,
  scheduled_at      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processed', 'cancelled', 'missed')),
  schedule_revision INTEGER NOT NULL,
  processed_at      TEXT,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (rule_id, occurrence_key, schedule_revision)
);

CREATE INDEX IF NOT EXISTS idx_occurrences_due ON occurrences (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_occurrences_rule ON occurrences (rule_id);

-- Persistent in-app notifications. A digest covers missed occurrences and has
-- no occurrence_id; a reminder is unique per (occurrence, channel).
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY NOT NULL,
  owner_id        TEXT NOT NULL,
  occurrence_id   TEXT REFERENCES occurrences(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app')),
  kind            TEXT NOT NULL CHECK (kind IN ('reminder', 'digest')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  entity_type     TEXT,
  entity_id       TEXT,
  scheduled_at    TEXT,
  digest_json     TEXT,
  state           TEXT NOT NULL DEFAULT 'created'
                    CHECK (state IN ('created', 'delivered', 'acknowledged')),
  delivered_at    TEXT,
  acknowledged_at TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (occurrence_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_notifications_owner ON notifications (owner_id, state, created_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id              TEXT PRIMARY KEY NOT NULL,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('created', 'delivered', 'acknowledged', 'failed')),
  error_code      TEXT,
  delivered_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_notification ON delivery_attempts (notification_id);

-- 0005_m3_images.sql — M3 images: attachments (staged upload → bound to a memo
-- revision) and immutable OCR runs (docs/03 §2, docs/04 §2).
-- ADDITIVE only (docs/07 DoD); never drops or rewrites existing data.

-- An upload is staged first (memo_revision_id NULL, short-lived token) and
-- bound to exactly one memo revision when the memo is created. Files live
-- under DATA_DIR/attachments/{original,derived}; only generated relative
-- names are stored, never an absolute path or the client's file name
-- (docs/06 §1). The original is the source; the derived copy (EXIF-stripped,
-- downscaled JPEG) is what may be sent to an OCR model (docs/04 §2).
CREATE TABLE IF NOT EXISTS attachments (
  id               TEXT PRIMARY KEY NOT NULL,
  owner_id         TEXT NOT NULL,
  memo_revision_id TEXT REFERENCES memo_revisions(id),
  position         INTEGER CHECK (position IS NULL OR position >= 0),
  -- sha256 of the upload token; the token itself is never stored.
  token_hash       TEXT NOT NULL UNIQUE,
  token_expires_at TEXT NOT NULL,
  relative_path    TEXT NOT NULL,
  derived_path     TEXT NOT NULL,
  original_name    TEXT,
  mime             TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes            INTEGER NOT NULL CHECK (bytes > 0),
  sha256           TEXT NOT NULL,
  width            INTEGER NOT NULL CHECK (width > 0),
  height           INTEGER NOT NULL CHECK (height > 0),
  derived_mime     TEXT NOT NULL DEFAULT 'image/jpeg',
  derived_bytes    INTEGER NOT NULL,
  derived_width    INTEGER NOT NULL,
  derived_height   INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (memo_revision_id, position)
);

CREATE INDEX IF NOT EXISTS idx_attachments_revision ON attachments (memo_revision_id, position);
CREATE INDEX IF NOT EXISTS idx_attachments_staged ON attachments (token_expires_at) WHERE memo_revision_id IS NULL;

-- The stored file of an attachment never changes; binding (revision,
-- position) is the only allowed update.
CREATE TRIGGER IF NOT EXISTS attachments_content_immutable
BEFORE UPDATE OF relative_path, derived_path, mime, bytes, sha256, width, height, owner_id ON attachments
BEGIN
  SELECT RAISE(ABORT, 'attachment content is immutable');
END;

-- Binding happens once: a bound attachment never moves to another revision or position.
CREATE TRIGGER IF NOT EXISTS attachments_binding_immutable
BEFORE UPDATE OF memo_revision_id, position ON attachments
WHEN OLD.memo_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'attachment binding is immutable');
END;

-- A bound attachment is a memo source and is never deleted (only expired staged uploads are purged).
CREATE TRIGGER IF NOT EXISTS attachments_bound_no_delete
BEFORE DELETE ON attachments
WHEN OLD.memo_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'bound attachments are never deleted');
END;

-- One row per OCR result, immutable (docs/04 §2). A model result has
-- author='ai' and a job; a user correction has author='user', no job, and
-- supersedes the run it corrected. The effective text of an attachment is its
-- newest run; source links keep pointing at the exact run they quoted
-- (docs/03 §3), so a later correction never rewrites an existing source.
CREATE TABLE IF NOT EXISTS ocr_runs (
  id                 TEXT PRIMARY KEY NOT NULL,
  owner_id           TEXT NOT NULL,
  attachment_id      TEXT NOT NULL REFERENCES attachments(id),
  job_id             TEXT REFERENCES jobs(id),
  author             TEXT NOT NULL CHECK (author IN ('ai', 'user')),
  supersedes_run_id  TEXT REFERENCES ocr_runs(id),
  connection_id      TEXT,
  model_id           TEXT,
  prompt_version     TEXT,
  status             TEXT NOT NULL CHECK (status IN ('readable', 'partial', 'unreadable')),
  extracted_text     TEXT NOT NULL,
  blocks_json        TEXT NOT NULL DEFAULT '[]',
  uncertainties_json TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  CHECK ((author = 'ai' AND job_id IS NOT NULL) OR (author = 'user' AND job_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_ocr_runs_attachment ON ocr_runs (attachment_id, created_at);
-- A retried or fenced commit can never store a second AI run for the same
-- (job, attachment) (A08).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ocr_runs_job_attachment
  ON ocr_runs (job_id, attachment_id) WHERE job_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS ocr_runs_immutable
BEFORE UPDATE ON ocr_runs
BEGIN
  SELECT RAISE(ABORT, 'ocr_runs are immutable');
END;

-- Runs are history that source links point at; they are never deleted.
CREATE TRIGGER IF NOT EXISTS ocr_runs_no_delete
BEFORE DELETE ON ocr_runs
BEGIN
  SELECT RAISE(ABORT, 'ocr_runs are immutable');
END;

CREATE INDEX IF NOT EXISTS idx_source_links_ocr_run ON source_links (ocr_run_id) WHERE ocr_run_id IS NOT NULL;

-- 0002_core_indexes.sql — additional indexes only, no data changes.

CREATE INDEX IF NOT EXISTS idx_areas_owner ON areas (owner_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_categories_area ON categories (area_id);
CREATE INDEX IF NOT EXISTS idx_people_owner ON people (owner_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id, status);

CREATE INDEX IF NOT EXISTS idx_memos_owner ON memos (owner_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_memos_current_revision ON memos (current_revision_id);
CREATE INDEX IF NOT EXISTS idx_memo_revisions_memo ON memo_revisions (memo_id, revision_no DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_waiting_person ON tasks (waiting_on_person_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks (due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_title ON tasks (title);

CREATE INDEX IF NOT EXISTS idx_appointments_owner_status ON appointments (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_appointments_project ON appointments (project_id);
CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments (starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_local_date ON appointments (local_date);

CREATE INDEX IF NOT EXISTS idx_reminder_rules_owner ON reminder_rules (owner_id, enabled);
CREATE INDEX IF NOT EXISTS idx_reminder_rules_entity ON reminder_rules (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_source_links_entity ON source_links (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_source_links_revision ON source_links (memo_revision_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_from ON entity_links (from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_entity_links_to ON entity_links (to_type, to_id);

CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_group ON audit_events (action_group_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS idx_action_groups_owner ON action_groups (owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_idempotency_expiry ON request_idempotency (expires_at);

-- Notifications are introduced in a later milestone; this placeholder index
-- keeps the migration numbering stable without creating any table or data.
CREATE INDEX IF NOT EXISTS idx_notifications_placeholder ON request_idempotency (route_scope);

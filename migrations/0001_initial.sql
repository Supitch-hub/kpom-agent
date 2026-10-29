PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  pending_action TEXT,
  pending_expires_at TEXT
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL, due_at TEXT, completed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tasks_due ON tasks(user_id, completed_at, due_at);
CREATE TABLE notes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX notes_user ON notes(user_id, created_at);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message TEXT NOT NULL, due_at TEXT NOT NULL,
  queued_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX reminders_due ON reminders(queued_at, due_at);
CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, value TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(user_id, key)
);
CREATE TABLE processed_line_events (
  event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','done','failed','uncertain')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX events_age ON processed_line_events(created_at);
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('reminder','briefing')),
  source_id TEXT NOT NULL, message TEXT NOT NULL, due_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','sent','failed','uncertain')),
  claim_token TEXT, claimed_at TEXT, sent_at TEXT, error_code TEXT,
  UNIQUE(kind, source_id)
);
CREATE INDEX outbox_due ON notification_outbox(state, due_at);
CREATE TABLE monthly_message_usage (
  month TEXT PRIMARY KEY, reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0)
);
CREATE TABLE agent_logs (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX logs_age ON agent_logs(created_at);

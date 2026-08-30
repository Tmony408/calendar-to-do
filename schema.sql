CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  avatar_url TEXT,
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#7c5cff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  due_at TIMESTAMPTZ,
  reminder_minutes INTEGER NOT NULL DEFAULT 30 CHECK (reminder_minutes >= 0),
  recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none','daily','weekly','monthly')),
  google_event_id TEXT,
  google_etag TEXT,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','synced','error','local')),
  sync_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks(user_id, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_google_event_idx ON tasks(user_id, google_event_id) WHERE google_event_id IS NOT NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
UPDATE tasks SET completed_at=updated_at WHERE completed=TRUE AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS subtasks (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calendar_connections (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_refresh_token TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  sync_token TEXT,
  channel_id TEXT UNIQUE,
  channel_resource_id TEXT,
  channel_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','calendar')),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS task_events (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  title_snapshot TEXT NOT NULL DEFAULT '',
  category_snapshot TEXT,
  priority_snapshot TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS task_events_user_time_idx ON task_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id);

CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_type TEXT NOT NULL CHECK (period_type IN ('day','week','month','year','custom')),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  title TEXT NOT NULL,
  reflection TEXT NOT NULL DEFAULT '',
  facts JSONB NOT NULL,
  content JSONB NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('groq','local')),
  model TEXT,
  cache_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, cache_key)
);

CREATE INDEX IF NOT EXISTS journal_entries_user_time_idx ON journal_entries(user_id, period_start DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS journal_reminders (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  day_of_week INTEGER NOT NULL DEFAULT 0 CHECK (day_of_week BETWEEN 0 AND 6),
  morning_time TIME NOT NULL DEFAULT '07:00',
  evening_time TIME NOT NULL DEFAULT '19:00',
  morning_event_id TEXT,
  evening_event_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'local' CHECK (sync_status IN ('local','pending','synced','error')),
  sync_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

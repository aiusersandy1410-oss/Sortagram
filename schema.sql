-- Stashboard sync schema (sync-code auth, no third-party login)
-- Run once against your Postgres database.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_code     TEXT UNIQUE NOT NULL,   -- shared secret; typed into a second device to link it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id            TEXT NOT NULL,          -- client-generated id (e.g. "topic_xxx"), stable across devices
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT,
  sort_order    INTEGER,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,            -- soft delete tombstone
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT,
  platform      TEXT,
  url           TEXT,
  thumb         TEXT,
  notes         TEXT,
  topic_ids     JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);

-- Fast incremental sync: fetch everything changed since a cursor
CREATE INDEX IF NOT EXISTS idx_topics_user_updated ON topics (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_items_user_updated  ON items  (user_id, updated_at);

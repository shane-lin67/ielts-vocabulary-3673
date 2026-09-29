CREATE TABLE IF NOT EXISTS sync_profiles (
  sync_id TEXT PRIMARY KEY NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  view_json TEXT NOT NULL DEFAULT '{}',
  reset_at INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_profiles_updated_at
ON sync_profiles(updated_at);

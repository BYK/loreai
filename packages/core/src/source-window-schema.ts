/** Local, disposable transcript checkpoints. Never included in sync. */
export const SOURCE_WINDOW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS source_windows (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES session_state(session_id) ON DELETE CASCADE,
    generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    revision INTEGER NOT NULL DEFAULT 0,
    payload BLOB CHECK(length(payload) <= 4000000),
    checksum TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(project_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_source_windows_updated ON source_windows(updated_at);
  CREATE TRIGGER IF NOT EXISTS source_windows_temporal_insert
  AFTER INSERT ON temporal_messages BEGIN
    UPDATE source_windows SET revision = revision + 1, payload = NULL, checksum = NULL
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS source_windows_temporal_delete
  AFTER DELETE ON temporal_messages BEGIN
    UPDATE source_windows SET revision = revision + 1, payload = NULL, checksum = NULL
      WHERE project_id = OLD.project_id AND session_id = OLD.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS source_windows_temporal_update
  AFTER UPDATE OF id, source_id, project_id, session_id, content, metadata ON temporal_messages BEGIN
    UPDATE source_windows SET revision = revision + 1, payload = NULL, checksum = NULL
      WHERE (project_id = OLD.project_id AND session_id = OLD.session_id)
         OR (project_id = NEW.project_id AND session_id = NEW.session_id);
  END;
  CREATE TRIGGER IF NOT EXISTS source_windows_session_rebind
  AFTER UPDATE OF project_path, credential_fingerprint ON session_state
  WHEN OLD.project_path IS NOT NEW.project_path
    OR OLD.credential_fingerprint IS NOT NEW.credential_fingerprint BEGIN
    DELETE FROM source_windows WHERE session_id = NEW.session_id;
  END;
  CREATE TRIGGER IF NOT EXISTS source_windows_amnesia
  AFTER UPDATE OF amnesia ON session_state WHEN NEW.amnesia != 0 BEGIN
    DELETE FROM source_windows WHERE session_id = NEW.session_id;
  END;
`;

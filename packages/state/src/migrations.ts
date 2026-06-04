import type Database from "better-sqlite3";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT    NOT NULL,
  ended_at     TEXT,
  provider_id  TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  summary      TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  recorded_at   TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target_path   TEXT,
  decision      TEXT    NOT NULL CHECK (decision IN ('allow','deny','always_file')),
  preview_hash  TEXT    NOT NULL,
  preview       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_session_idx ON approvals(session_id, recorded_at);

CREATE TABLE IF NOT EXISTS tool_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  called_at     TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  input_json    TEXT    NOT NULL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('ok','blocked','denied','error')),
  message       TEXT
);
CREATE INDEX IF NOT EXISTS tool_audit_session_idx ON tool_audit(session_id, called_at);

CREATE TABLE IF NOT EXISTS memory_compactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  recorded_at   TEXT    NOT NULL,
  file          TEXT    NOT NULL,
  cap_words     INTEGER NOT NULL,
  before_words  INTEGER NOT NULL,
  after_words   INTEGER NOT NULL,
  before_text   TEXT    NOT NULL,
  after_text    TEXT    NOT NULL
);
`;

export function migrate(db: Database.Database): void {
  const version = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  if (version >= 1) return;
  db.exec("BEGIN");
  try {
    db.exec(SCHEMA_V1);
    db.pragma("user_version = 1");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

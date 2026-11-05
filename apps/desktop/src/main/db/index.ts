import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database.Database

// TODO(sqlcipher): the database is plain SQLite for now. See db/encryption.md for the plan to move to
// SQLCipher with a DPAPI-protected key before Phase 0 closes.

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    text TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX project_files_project ON project_files(project_id);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    title_source TEXT NOT NULL DEFAULT 'none',
    model_id TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_id TEXT,
    role TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]',
    model_id TEXT,
    provider TEXT,
    status TEXT NOT NULL DEFAULT 'complete',
    usage TEXT,
    cost_usd REAL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, created_at);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    text TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    language TEXT,
    current_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_conversation ON artifacts(conversation_id);

  CREATE TABLE artifact_versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    message_id TEXT,
    source TEXT NOT NULL DEFAULT 'model',
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );

  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
  );

  CREATE TABLE models_cache (
    provider TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL
  );

  CREATE TABLE model_tags (
    model_id TEXT NOT NULL,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (model_id, tag_id)
  );

  CREATE TABLE usage_events (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    cached_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    conversation_id TEXT,
    message_id TEXT,
    estimated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_events_at ON usage_events(at);
  CREATE INDEX usage_events_message ON usage_events(message_id);

  CREATE TABLE usage_outbox (
    id TEXT PRIMARY KEY REFERENCES usage_events(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT
  );

  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v2: Wikipedia/Wikidata knowledge cards, cached so reopening an old chat does not hit the network again.
  `
  CREATE TABLE knowledge_cache (
    key TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  // v3: the server holds the data. Triggers note each local change so it can be sent; rows from the server set `applying` and are not noted.
  `
  CREATE TABLE sync_state (applying INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0);
  INSERT INTO sync_state DEFAULT VALUES;
  CREATE TABLE sync_outbox (tbl TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (tbl, id));
  CREATE TABLE sync_files (id TEXT PRIMARY KEY);
  CREATE TRIGGER sync_projects_i AFTER INSERT ON projects WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('projects', NEW.id); END;
  CREATE TRIGGER sync_projects_u AFTER UPDATE ON projects WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('projects', NEW.id); END;
  CREATE TRIGGER sync_projects_d AFTER DELETE ON projects WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('projects', OLD.id); END;
  CREATE TRIGGER sync_conversations_i AFTER INSERT ON conversations WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('conversations', NEW.id); END;
  CREATE TRIGGER sync_conversations_u AFTER UPDATE ON conversations WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('conversations', NEW.id); END;
  CREATE TRIGGER sync_conversations_d AFTER DELETE ON conversations WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('conversations', OLD.id); END;
  CREATE TRIGGER sync_memories_i AFTER INSERT ON memories WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('memories', NEW.id); END;
  CREATE TRIGGER sync_memories_u AFTER UPDATE ON memories WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('memories', NEW.id); END;
  CREATE TRIGGER sync_memories_d AFTER DELETE ON memories WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('memories', OLD.id); END;
  CREATE TRIGGER sync_project_files_i AFTER INSERT ON project_files WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('project_files', NEW.id); END;
  CREATE TRIGGER sync_project_files_u AFTER UPDATE ON project_files WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('project_files', NEW.id); END;
  CREATE TRIGGER sync_project_files_d AFTER DELETE ON project_files WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('project_files', OLD.id); END;
  CREATE TRIGGER sync_attachments_i AFTER INSERT ON attachments WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('attachments', NEW.id); END;
  CREATE TRIGGER sync_attachments_u AFTER UPDATE ON attachments WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('attachments', NEW.id); END;
  CREATE TRIGGER sync_attachments_d AFTER DELETE ON attachments WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('attachments', OLD.id); END;
  CREATE TRIGGER sync_messages_i AFTER INSERT ON messages WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('messages', NEW.id); END;
  CREATE TRIGGER sync_messages_u AFTER UPDATE ON messages WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('messages', NEW.id); END;
  CREATE TRIGGER sync_messages_d AFTER DELETE ON messages WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('messages', OLD.id); END;
  CREATE TRIGGER sync_artifacts_i AFTER INSERT ON artifacts WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('artifacts', NEW.id); END;
  CREATE TRIGGER sync_artifacts_u AFTER UPDATE ON artifacts WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('artifacts', NEW.id); END;
  CREATE TRIGGER sync_artifacts_d AFTER DELETE ON artifacts WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('artifacts', OLD.id); END;
  CREATE TRIGGER sync_av_i AFTER INSERT ON artifact_versions WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('artifact_versions', NEW.artifact_id || '|' || NEW.version); END;
  CREATE TRIGGER sync_av_u AFTER UPDATE ON artifact_versions WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('artifact_versions', NEW.artifact_id || '|' || NEW.version); END;
  CREATE TRIGGER sync_av_d AFTER DELETE ON artifact_versions WHEN (SELECT applying FROM sync_state) = 0 BEGIN INSERT OR REPLACE INTO sync_outbox (tbl, id) VALUES ('artifact_versions', OLD.artifact_id || '|' || OLD.version); END;
  `,
  // v4: an earlier build lost local messages while syncing. The server still has them, so fetch everything again.
  `UPDATE sync_state SET last_seq = 0;`
]

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 3000')
  migrate(db)
  return db
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

export const nowIso = (): string => new Date().toISOString()

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

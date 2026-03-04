import { resolve } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = resolve(
  process.env.HOME || "/home/slacker",
  ".slacker",
  "installations.db",
);

export interface SessionRecord {
  query_key: string;
  team_id: string;
  channel: string;
  thread_ts: string;
  card_ts: string;
  session_id: string | null;
  status: string;
  started_at: string;
  last_heartbeat: string;
  prompt: string | null;
  user_id: string | null;
}

export function createSessionStore() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Active session tracking — survives restarts
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      query_key TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      card_ts TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      prompt TEXT,
      user_id TEXT
    )
  `);

  // Migrate: add prompt/user_id columns if missing (existing DBs)
  try { db.exec(`ALTER TABLE sessions ADD COLUMN prompt TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN user_id TEXT`); } catch {}


  // Thread → session_id mapping for Claude session resume (persists after completion)
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_sessions (
      session_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const registerStmt = db.prepare(`
    INSERT OR REPLACE INTO sessions (query_key, team_id, channel, thread_ts, card_ts, status, started_at, last_heartbeat, prompt, user_id)
    VALUES (?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'), ?, ?)
  `);

  const heartbeatStmt = db.prepare(`
    UPDATE sessions SET last_heartbeat = datetime('now') WHERE query_key = ?
  `);

  const setSessionIdStmt = db.prepare(`
    UPDATE sessions SET session_id = ? WHERE query_key = ?
  `);

  const completeStmt = db.prepare(`
    UPDATE sessions SET status = ?, last_heartbeat = datetime('now') WHERE query_key = ?
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM sessions WHERE query_key = ?
  `);

  const getActiveStmt = db.prepare(`
    SELECT * FROM sessions WHERE status = 'active'
  `);

  const upsertThreadSessionStmt = db.prepare(`
    INSERT OR REPLACE INTO thread_sessions (session_key, session_id, updated_at)
    VALUES (?, ?, datetime('now'))
  `);

  const getThreadSessionStmt = db.prepare(`
    SELECT session_id FROM thread_sessions WHERE session_key = ?
  `);

  return {
    register(queryKey: string, teamId: string, channel: string, threadTs: string, cardTs: string, prompt?: string, userId?: string) {
      registerStmt.run(queryKey, teamId, channel, threadTs, cardTs, prompt ?? null, userId ?? null);
    },

    heartbeat(queryKey: string) {
      heartbeatStmt.run(queryKey);
    },

    setSessionId(queryKey: string, sessionId: string) {
      setSessionIdStmt.run(sessionId, queryKey);
    },

    complete(queryKey: string, status: "done" | "error") {
      completeStmt.run(status, queryKey);
    },

    delete(queryKey: string) {
      deleteStmt.run(queryKey);
    },

    getActiveSessions(): SessionRecord[] {
      return getActiveStmt.all() as SessionRecord[];
    },

    setThreadSession(sessionKey: string, sessionId: string) {
      upsertThreadSessionStmt.run(sessionKey, sessionId);
    },

    getThreadSession(sessionKey: string): string | null {
      const row = getThreadSessionStmt.get(sessionKey) as { session_id: string } | undefined;
      return row?.session_id ?? null;
    },

    close() {
      db.close();
    },
  };
}

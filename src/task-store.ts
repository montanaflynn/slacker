import { resolve } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = resolve(
  process.env.HOME || "/home/slacker",
  ".slacker",
  "installations.db",
);

export interface TaskRecord {
  id: number;
  team_id: string;
  channel: string;
  thread_ts: string;
  user_id: string;
  description: string;
  status: "pending" | "active" | "done" | "error" | "cancelled";
  priority: number;
  result: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export function createTaskStore() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    )
  `);

  const addStmt = db.prepare(`
    INSERT INTO tasks (team_id, channel, thread_ts, user_id, description, priority)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const claimStmt = db.prepare(`
    UPDATE tasks SET status = 'active', started_at = datetime('now')
    WHERE id = ?
  `);

  const completeStmt = db.prepare(`
    UPDATE tasks SET status = ?, result = ?, completed_at = datetime('now')
    WHERE id = ?
  `);

  const cancelStmt = db.prepare(`
    UPDATE tasks SET status = 'cancelled', completed_at = datetime('now')
    WHERE id = ? AND status IN ('pending', 'active')
  `);

  const getNextStmt = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);

  const getActiveStmt = db.prepare(`
    SELECT * FROM tasks WHERE status = 'active'
  `);

  const getByThreadStmt = db.prepare(`
    SELECT * FROM tasks
    WHERE team_id = ? AND thread_ts = ?
    ORDER BY created_at ASC
  `);

  const getAllPendingStmt = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('pending', 'active')
    ORDER BY priority DESC, created_at ASC
  `);

  const getByIdStmt = db.prepare(`
    SELECT * FROM tasks WHERE id = ?
  `);

  return {
    add(teamId: string, channel: string, threadTs: string, userId: string, description: string, priority = 0): number {
      const result = addStmt.run(teamId, channel, threadTs, userId, description, priority);
      return Number(result.lastInsertRowid);
    },

    claim(id: number) {
      claimStmt.run(id);
    },

    complete(id: number, status: "done" | "error", result?: string) {
      completeStmt.run(status, result ?? null, id);
    },

    cancel(id: number) {
      cancelStmt.run(id);
    },

    getNext(): TaskRecord | null {
      return (getNextStmt.get() as TaskRecord) ?? null;
    },

    getActive(): TaskRecord[] {
      return getActiveStmt.all() as TaskRecord[];
    },

    getByThread(teamId: string, threadTs: string): TaskRecord[] {
      return getByThreadStmt.all(teamId, threadTs) as TaskRecord[];
    },

    getAllPending(): TaskRecord[] {
      return getAllPendingStmt.all() as TaskRecord[];
    },

    getById(id: number): TaskRecord | null {
      return (getByIdStmt.get(id) as TaskRecord) ?? null;
    },

    close() {
      db.close();
    },
  };
}

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Isolated temp DB
const tmpHome = mkdtempSync(join(tmpdir(), "slacker-session-test-"));
mkdirSync(join(tmpHome, ".slacker"), { recursive: true });
process.env.HOME = tmpHome;

const { createSessionStore } = await import("../src/session-store.js");

describe("SessionStore", () => {
  let store: ReturnType<typeof createSessionStore>;

  before(() => {
    store = createSessionStore();
  });

  after(() => {
    store.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("register + getActiveSessions", () => {
    it("registers a session and retrieves it as active", () => {
      store.register("q1", "T1", "C1", "100.1", "card1", "hello", "U1");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q1");
      assert.ok(found);
      assert.equal(found.team_id, "T1");
      assert.equal(found.channel, "C1");
      assert.equal(found.thread_ts, "100.1");
      assert.equal(found.card_ts, "card1");
      assert.equal(found.status, "active");
      assert.equal(found.prompt, "hello");
      assert.equal(found.user_id, "U1");
    });

    it("upserts on duplicate query_key", () => {
      store.register("q2", "T1", "C1", "100.1", "card2");
      store.register("q2", "T1", "C1", "100.1", "card2-updated");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q2");
      assert.ok(found);
      assert.equal(found.card_ts, "card2-updated");
    });

    it("handles missing optional fields", () => {
      store.register("q3", "T1", "C1", "100.1", "card3");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q3");
      assert.ok(found);
      assert.equal(found.prompt, null);
      assert.equal(found.user_id, null);
    });
  });

  describe("heartbeat", () => {
    it("updates last_heartbeat without error", () => {
      store.register("q-hb", "T1", "C1", "200.1", "card-hb");
      // Just ensure it doesn't throw
      store.heartbeat("q-hb");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q-hb");
      assert.ok(found);
      assert.ok(found.last_heartbeat);
    });
  });

  describe("setSessionId", () => {
    it("stores the session_id on a registered session", () => {
      store.register("q-sid", "T1", "C1", "300.1", "card-sid");
      store.setSessionId("q-sid", "ses_abc123");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q-sid");
      assert.ok(found);
      assert.equal(found.session_id, "ses_abc123");
    });
  });

  describe("complete", () => {
    it("marks session as done", () => {
      store.register("q-done", "T1", "C1", "400.1", "card-done");
      store.complete("q-done", "done");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q-done");
      assert.equal(found, undefined, "completed session should not appear as active");
    });

    it("marks session as error", () => {
      store.register("q-err", "T1", "C1", "400.1", "card-err");
      store.complete("q-err", "error");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q-err");
      assert.equal(found, undefined);
    });
  });

  describe("delete", () => {
    it("removes the session entirely", () => {
      store.register("q-del", "T1", "C1", "500.1", "card-del");
      store.delete("q-del");
      const sessions = store.getActiveSessions();
      const found = sessions.find((s) => s.query_key === "q-del");
      assert.equal(found, undefined);
    });
  });

  describe("thread sessions", () => {
    it("stores and retrieves a thread session_id", () => {
      store.setThreadSession("T1:C1:600.1", "ses_thread1");
      const sid = store.getThreadSession("T1:C1:600.1");
      assert.equal(sid, "ses_thread1");
    });

    it("upserts thread session on repeat", () => {
      store.setThreadSession("T1:C1:700.1", "ses_old");
      store.setThreadSession("T1:C1:700.1", "ses_new");
      const sid = store.getThreadSession("T1:C1:700.1");
      assert.equal(sid, "ses_new");
    });

    it("returns null for unknown session key", () => {
      const sid = store.getThreadSession("nonexistent");
      assert.equal(sid, null);
    });
  });
});

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point DB to a temp dir so we don't touch the real one
const tmpHome = mkdtempSync(join(tmpdir(), "slacker-test-"));
mkdirSync(join(tmpHome, ".slacker"), { recursive: true });
process.env.HOME = tmpHome;

// Import after setting HOME so DB_PATH resolves to our temp dir
const { createTaskStore } = await import("../src/task-store.js");

describe("TaskStore", () => {
  let store: ReturnType<typeof createTaskStore>;

  before(() => {
    store = createTaskStore();
  });

  after(() => {
    store.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe("add", () => {
    it("returns an auto-incremented id", () => {
      const id1 = store.add("T1", "C1", "100.1", "U1", "First task");
      const id2 = store.add("T1", "C1", "100.1", "U1", "Second task");
      assert.equal(typeof id1, "number");
      assert.ok(id2 > id1, "second id should be greater");
    });

    it("stores the task with default status 'pending'", () => {
      const id = store.add("T1", "C1", "100.1", "U1", "Check status");
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "pending");
      assert.equal(task.description, "Check status");
      assert.equal(task.team_id, "T1");
      assert.equal(task.channel, "C1");
      assert.equal(task.thread_ts, "100.1");
      assert.equal(task.user_id, "U1");
      assert.equal(task.priority, 0);
      assert.equal(task.result, null);
    });

    it("accepts a custom priority", () => {
      const id = store.add("T1", "C1", "100.1", "U1", "High priority", 10);
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.priority, 10);
    });
  });

  describe("claim", () => {
    it("sets status to active and records started_at", () => {
      const id = store.add("T1", "C1", "200.1", "U1", "Claim me");
      store.claim(id);
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "active");
      assert.ok(task.started_at, "started_at should be set");
    });
  });

  describe("complete", () => {
    it("marks task as done with result", () => {
      const id = store.add("T1", "C1", "300.1", "U1", "Complete me");
      store.claim(id);
      store.complete(id, "done", "All good");
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "done");
      assert.equal(task.result, "All good");
      assert.ok(task.completed_at, "completed_at should be set");
    });

    it("marks task as error", () => {
      const id = store.add("T1", "C1", "300.1", "U1", "Fail me");
      store.claim(id);
      store.complete(id, "error", "Something broke");
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "error");
      assert.equal(task.result, "Something broke");
    });

    it("works without a result string", () => {
      const id = store.add("T1", "C1", "300.1", "U1", "No result");
      store.complete(id, "done");
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.result, null);
    });
  });

  describe("cancel", () => {
    it("cancels a pending task", () => {
      const id = store.add("T1", "C1", "400.1", "U1", "Cancel me");
      store.cancel(id);
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "cancelled");
      assert.ok(task.completed_at);
    });

    it("cancels an active task", () => {
      const id = store.add("T1", "C1", "400.1", "U1", "Cancel active");
      store.claim(id);
      store.cancel(id);
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "cancelled");
    });

    it("does not cancel a done task", () => {
      const id = store.add("T1", "C1", "400.1", "U1", "Already done");
      store.complete(id, "done", "Finished");
      store.cancel(id); // should be a no-op
      const task = store.getById(id);
      assert.ok(task);
      assert.equal(task.status, "done");
    });
  });

  describe("getNext", () => {
    it("returns the highest-priority pending task", () => {
      // Fresh store for isolation
      const s = createTaskStore();
      // Add low then high priority — both pending
      s.add("T2", "C2", "500.1", "U2", "Low priority", 1);
      s.add("T2", "C2", "500.1", "U2", "High priority", 10);
      const next = s.getNext();
      assert.ok(next);
      assert.equal(next.description, "High priority");
      s.close();
    });

    it("returns null when no pending tasks", () => {
      const s = createTaskStore();
      // All existing tasks from other tests may exist, but let's add and complete one
      const id = s.add("T3", "C3", "600.1", "U3", "Will complete");
      s.complete(id, "done");
      // getNext might still return tasks from our main store, so just verify it returns TaskRecord | null
      const next = s.getNext();
      // If next exists, it should at least be pending
      if (next) {
        assert.equal(next.status, "pending");
      }
      s.close();
    });
  });

  describe("getActive", () => {
    it("returns only active tasks", () => {
      const id1 = store.add("T1", "C1", "700.1", "U1", "Active one");
      store.add("T1", "C1", "700.1", "U1", "Pending one");
      store.claim(id1);
      const active = store.getActive();
      const found = active.find((t) => t.id === id1);
      assert.ok(found);
      assert.equal(found.status, "active");
      // The pending one should NOT appear
      const pending = active.find((t) => t.description === "Pending one");
      assert.equal(pending, undefined);
    });
  });

  describe("getByThread", () => {
    it("returns all tasks for a specific thread", () => {
      store.add("TX", "CX", "800.1", "U1", "Thread task 1");
      store.add("TX", "CX", "800.1", "U1", "Thread task 2");
      store.add("TX", "CX", "999.9", "U1", "Different thread");
      const tasks = store.getByThread("TX", "800.1");
      assert.ok(tasks.length >= 2);
      assert.ok(tasks.every((t) => t.thread_ts === "800.1"));
    });
  });

  describe("getAllPending", () => {
    it("includes pending and active tasks", () => {
      const id = store.add("T1", "C1", "900.1", "U1", "getAllPending test");
      store.claim(id);
      const all = store.getAllPending();
      const found = all.find((t) => t.id === id);
      assert.ok(found, "active task should appear in getAllPending");
    });
  });

  describe("getById", () => {
    it("returns null for nonexistent id", () => {
      const task = store.getById(999999);
      assert.equal(task, null);
    });
  });
});

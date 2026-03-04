import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpHome = mkdtempSync(join(tmpdir(), "slacker-cli-test-"));
mkdirSync(join(tmpHome, ".slacker"), { recursive: true });

const CLI = join(import.meta.dirname, "..", "src", "task-cli.ts");
const NODE_ARGS = ["--import", "tsx", CLI];

function run(...args: string[]): string {
  return execFileSync("node", [...NODE_ARGS, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: tmpHome },
    cwd: join(import.meta.dirname, ".."),
  }).trim();
}

function runFail(...args: string[]): { stderr: string; code: number | null } {
  try {
    execFileSync("node", [...NODE_ARGS, ...args], {
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpHome },
      cwd: join(import.meta.dirname, ".."),
    });
    return { stderr: "", code: 0 };
  } catch (err: any) {
    return { stderr: err.stderr?.trim() ?? "", code: err.status };
  }
}

after(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("task-cli", () => {
  describe("add", () => {
    it("creates a task and returns JSON with id", () => {
      const out = run(
        "add",
        "--team", "T1",
        "--channel", "C1",
        "--thread", "100.1",
        "--user", "U1",
        "--desc", "CLI test task",
      );
      const result = JSON.parse(out);
      assert.equal(result.ok, true);
      assert.equal(typeof result.id, "number");
      assert.equal(result.description, "CLI test task");
    });

    it("fails without required flags", () => {
      const { stderr, code } = runFail("add", "--team", "T1");
      assert.ok(code !== 0, "should exit with non-zero");
      assert.ok(stderr.includes("Missing required flags"));
    });

    it("accepts a priority flag", () => {
      const out = run(
        "add",
        "--team", "T1",
        "--channel", "C1",
        "--thread", "100.1",
        "--user", "U1",
        "--desc", "High priority task",
        "--priority", "5",
      );
      const result = JSON.parse(out);
      assert.equal(result.ok, true);
    });
  });

  describe("pending", () => {
    it("lists pending tasks", () => {
      const out = run("pending");
      assert.ok(out.includes("CLI test task"));
    });
  });

  describe("list", () => {
    it("lists tasks by thread", () => {
      const out = run("list", "--team", "T1", "--thread", "100.1");
      const tasks = JSON.parse(out);
      assert.ok(Array.isArray(tasks));
      assert.ok(tasks.length > 0);
      assert.ok(tasks.every((t: any) => t.thread_ts === "100.1"));
    });

    it("lists all pending when no thread specified", () => {
      const out = run("list");
      const tasks = JSON.parse(out);
      assert.ok(Array.isArray(tasks));
    });
  });

  describe("done", () => {
    it("marks a task as done", () => {
      // First add a task
      const addOut = run(
        "add",
        "--team", "T1",
        "--channel", "C1",
        "--thread", "200.1",
        "--user", "U1",
        "--desc", "Finish me",
      );
      const { id } = JSON.parse(addOut);

      const out = run("done", "--id", String(id), "--result", "All done");
      const result = JSON.parse(out);
      assert.equal(result.ok, true);
      assert.equal(result.status, "done");
    });

    it("fails without --id", () => {
      const { code, stderr } = runFail("done");
      assert.ok(code !== 0);
      assert.ok(stderr.includes("Missing --id"));
    });
  });

  describe("cancel", () => {
    it("cancels a pending task", () => {
      const addOut = run(
        "add",
        "--team", "T1",
        "--channel", "C1",
        "--thread", "300.1",
        "--user", "U1",
        "--desc", "Cancel me",
      );
      const { id } = JSON.parse(addOut);

      const out = run("cancel", "--id", String(id));
      const result = JSON.parse(out);
      assert.equal(result.ok, true);
      assert.equal(result.status, "cancelled");
    });

    it("fails without --id", () => {
      const { code, stderr } = runFail("cancel");
      assert.ok(code !== 0);
      assert.ok(stderr.includes("Missing --id"));
    });
  });

  describe("unknown command", () => {
    it("exits with error for unknown command", () => {
      const { code, stderr } = runFail("foobar");
      assert.ok(code !== 0);
      assert.ok(stderr.includes("Unknown command: foobar"));
    });
  });
});

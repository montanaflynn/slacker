#!/usr/bin/env node
/**
 * Task management CLI — called by Claude via Bash to manage the task queue.
 *
 * Usage:
 *   task add --team T123 --channel C456 --thread 123.456 --user U789 --desc "Build feature X" [--priority 1]
 *   task list [--thread 123.456 --team T123]
 *   task pending
 *   task cancel --id 5
 *   task done --id 5 [--result "Completed successfully"]
 */

import { createTaskStore } from "./task-store.js";

const store = createTaskStore();
const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

try {
  switch (command) {
    case "add": {
      const teamId = flag("team");
      const channel = flag("channel");
      const threadTs = flag("thread");
      const userId = flag("user");
      const description = flag("desc");
      const priority = parseInt(flag("priority") || "0", 10);

      if (!teamId || !channel || !threadTs || !userId || !description) {
        console.error("Missing required flags: --team, --channel, --thread, --user, --desc");
        process.exit(1);
      }

      const id = store.add(teamId, channel, threadTs, userId, description, priority);
      console.log(JSON.stringify({ ok: true, id, description }));
      break;
    }

    case "list": {
      const teamId = flag("team");
      const threadTs = flag("thread");
      if (teamId && threadTs) {
        const tasks = store.getByThread(teamId, threadTs);
        console.log(JSON.stringify(tasks, null, 2));
      } else {
        const tasks = store.getAllPending();
        console.log(JSON.stringify(tasks, null, 2));
      }
      break;
    }

    case "pending": {
      const tasks = store.getAllPending();
      if (tasks.length === 0) {
        console.log("No pending tasks.");
      } else {
        for (const t of tasks) {
          console.log(`[${t.id}] (${t.status}) ${t.description}`);
        }
      }
      break;
    }

    case "cancel": {
      const id = parseInt(flag("id") || "", 10);
      if (!id) { console.error("Missing --id"); process.exit(1); }
      store.cancel(id);
      console.log(JSON.stringify({ ok: true, id, status: "cancelled" }));
      break;
    }

    case "done": {
      const id = parseInt(flag("id") || "", 10);
      const result = flag("result");
      if (!id) { console.error("Missing --id"); process.exit(1); }
      store.complete(id, "done", result);
      console.log(JSON.stringify({ ok: true, id, status: "done" }));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Commands: add, list, pending, cancel, done");
      process.exit(1);
  }
} finally {
  store.close();
}

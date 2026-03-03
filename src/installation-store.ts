import { resolve } from "node:path";
import {
  existsSync,
  readdirSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { InstallationStore } from "@slack/oauth";
import type { Installation, InstallationQuery } from "@slack/oauth";

const DB_PATH = resolve(
  process.env.HOME || "/home/slacker",
  ".slacker",
  "installations.db",
);

const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return buf;
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv):base64(tag):base64(ciphertext)
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(stored: string): string {
  if (!stored.startsWith("enc:")) return stored; // plaintext
  const key = getEncryptionKey();
  if (!key) return stored; // no key, return as-is
  const [, ivB64, tagB64, dataB64] = stored.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

function teamKey(
  installation: Installation<"v1" | "v2", boolean>,
): string {
  if (
    installation.isEnterpriseInstall &&
    installation.enterprise !== undefined
  ) {
    return installation.enterprise.id;
  }
  if (installation.team !== undefined) {
    return installation.team.id;
  }
  throw new Error("Could not determine team/enterprise ID from installation");
}

export function createInstallationStore(): InstallationStore & {
  close: () => void;
} {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS installations (
      team_id TEXT PRIMARY KEY,
      enterprise_id TEXT,
      data TEXT NOT NULL,
      installed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO installations (team_id, enterprise_id, data, installed_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      enterprise_id = excluded.enterprise_id,
      data = excluded.data,
      installed_at = datetime('now')
  `);

  const fetchStmt = db.prepare(
    `SELECT data FROM installations WHERE team_id = ?`,
  );

  const deleteExec = db.prepare(
    `DELETE FROM installations WHERE team_id = ?`,
  );

  const store: InstallationStore & { close: () => void } = {
    async storeInstallation(installation) {
      const id = teamKey(installation);
      const enterpriseId =
        installation.enterprise !== undefined
          ? installation.enterprise.id
          : null;
      const json = JSON.stringify(installation);
      upsertStmt.run(id, enterpriseId, encrypt(json));
    },

    async fetchInstallation(query: InstallationQuery<boolean>) {
      const id = query.isEnterpriseInstall
        ? query.enterpriseId
        : query.teamId;
      if (!id) throw new Error("Missing team/enterprise ID in query");
      const row = fetchStmt.get(id) as { data: string } | undefined;
      if (!row) throw new Error(`No installation found for ${id}`);
      return JSON.parse(decrypt(row.data));
    },

    async deleteInstallation(query: InstallationQuery<boolean>) {
      const id = query.isEnterpriseInstall
        ? query.enterpriseId
        : query.teamId;
      if (!id) return;
      deleteExec.run(id);
    },

    close() {
      db.close();
    },
  };

  return store;
}

/**
 * Migrate workspace directories from the old flat layout to team-scoped layout.
 * Old: ~/.slacker/workspaces/<channel>/
 * New: ~/.slacker/workspaces/<teamId>/<channel>/
 *
 * Detects old-style dirs by checking if any direct child of WORKSPACES_ROOT
 * is NOT a Slack team ID (team IDs match /^T[A-Z0-9]+$/).
 */
function migrateWorkspaceDirs(teamId: string, workspacesRoot: string): void {
  if (!existsSync(workspacesRoot)) return;

  const entries = readdirSync(workspacesRoot, { withFileTypes: true }).filter(
    (d) => d.isDirectory(),
  );

  // If a teamId dir already exists and has contents, migration likely already ran
  const teamDir = resolve(workspacesRoot, teamId);
  const isSlackTeamId = /^[TE][A-Z0-9]+$/;

  // Find dirs that look like channel names (not team IDs)
  const channelDirs = entries.filter((d) => !isSlackTeamId.test(d.name));
  if (channelDirs.length === 0) return;

  mkdirSync(teamDir, { recursive: true });

  for (const dir of channelDirs) {
    const src = resolve(workspacesRoot, dir.name);
    const dest = resolve(teamDir, dir.name);
    if (existsSync(dest)) {
      console.warn(`migrateWorkspaceDirs: skipping ${dir.name}, already exists at ${dest}`);
      continue;
    }
    renameSync(src, dest);
    console.log(`migrateWorkspaceDirs: moved ${dir.name} → ${teamId}/${dir.name}`);
  }
}

/**
 * If SLACK_BOT_TOKEN exists in env:
 * 1. Resolve the team ID via auth.test
 * 2. Store the installation in SQLite (for OAuth mode)
 * 3. Migrate workspace directories from flat to team-scoped layout
 *
 * Safe to call in both OAuth and legacy modes — runs whenever SLACK_BOT_TOKEN is set.
 */
export async function migrateFromEnv(
  store: InstallationStore,
  storeInstallation: boolean,
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return;

  const workspacesRoot = resolve(
    process.env.HOME || "/home/slacker",
    ".slacker",
    "workspaces",
  );

  // Use the token to find out team info
  const { WebClient } = await import("@slack/web-api");
  const client = new WebClient(botToken);

  try {
    const auth = await client.auth.test();
    if (!auth.team_id) {
      console.warn("migrateFromEnv: auth.test did not return team_id, skipping");
      return;
    }

    // Migrate workspace directories (flat → team-scoped)
    migrateWorkspaceDirs(auth.team_id, workspacesRoot);

    // Store the installation in SQLite (only matters for OAuth mode)
    if (storeInstallation) {
      const installation: Installation<"v2", false> = {
        team: { id: auth.team_id, name: auth.team ?? undefined },
        enterprise: undefined,
        user: { token: undefined, scopes: undefined, id: auth.user_id || "unknown" },
        bot: {
          token: botToken,
          scopes: [], // we don't know the exact scopes, but the token works
          id: auth.bot_id || "unknown",
          userId: auth.user_id || "unknown",
        },
        isEnterpriseInstall: false,
        authVersion: "v2",
      };

      await store.storeInstallation(installation);
      console.log(
        `migrateFromEnv: imported existing token for team ${auth.team_id} (${auth.team})`,
      );
    }
  } catch (error) {
    console.warn("migrateFromEnv: failed to migrate:", error);
  }
}

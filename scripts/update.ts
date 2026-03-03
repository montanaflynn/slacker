import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const manifestPath = fileURLToPath(new URL("../manifest.json", import.meta.url));

let configToken = process.env.SLACK_CONFIG_TOKEN;
let refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;
const appId = process.env.SLACK_APP_ID;

if (!configToken || !refreshToken) {
  console.error(
    "Missing SLACK_CONFIG_TOKEN and/or SLACK_CONFIG_REFRESH_TOKEN in .env\n" +
      "Get them at https://api.slack.com/apps → Your App Configuration Tokens → Generate Token"
  );
  process.exit(1);
}

if (!appId) {
  console.error("Missing SLACK_APP_ID in .env — run `npm run setup` first");
  process.exit(1);
}

function readEnv(): string {
  return existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
}

function setEnvVar(content: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, `${key}=${value}`);
  }
  return content + `${content && !content.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
}

async function slackApi(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${configToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<Record<string, any>>;
}

async function rotateToken(): Promise<void> {
  console.log("Rotating config token...");
  const res = await fetch("https://slack.com/api/tooling.tokens.rotate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken!,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as Record<string, any>;

  if (!data.ok) {
    console.error("Token rotation failed:", data.error);
    process.exit(1);
  }

  configToken = data.token;
  refreshToken = data.refresh_token;

  let env = readEnv();
  env = setEnvVar(env, "SLACK_CONFIG_TOKEN", configToken!);
  env = setEnvVar(env, "SLACK_CONFIG_REFRESH_TOKEN", refreshToken!);
  writeFileSync(envPath, env);
  console.log("Tokens rotated and saved to .env");
}

const manifest = readFileSync(manifestPath, "utf-8");

async function main() {
  console.log(`Updating app ${appId}...`);

  let result = await slackApi("apps.manifest.update", {
    app_id: appId,
    manifest,
  });

  if (!result.ok && result.error === "token_expired") {
    await rotateToken();
    result = await slackApi("apps.manifest.update", {
      app_id: appId,
      manifest,
    });
  }

  if (!result.ok) {
    console.error("Manifest update failed:", result.error);
    if (result.errors) console.error("Details:", result.errors);
    process.exit(1);
  }

  console.log("Manifest updated successfully!");
}

main();

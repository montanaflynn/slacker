import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
const manifestPath = fileURLToPath(new URL("../manifest.json", import.meta.url));

let configToken = process.env.SLACK_CONFIG_TOKEN;
let refreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN;

if (!configToken || !refreshToken) {
  console.error(
    "Missing SLACK_CONFIG_TOKEN and/or SLACK_CONFIG_REFRESH_TOKEN in .env\n" +
      "Get them at https://api.slack.com/apps → Your App Configuration Tokens → Generate Token"
  );
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
    console.error("You may need to regenerate tokens at https://api.slack.com/apps");
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
  // Validate manifest — also tests if our token is still valid
  console.log("Validating manifest...");
  let validation = await slackApi("apps.manifest.validate", { manifest });

  if (!validation.ok && validation.error === "token_expired") {
    await rotateToken();
    validation = await slackApi("apps.manifest.validate", { manifest });
  }

  if (!validation.ok) {
    console.error("Manifest validation failed:", validation.errors ?? validation.error);
    process.exit(1);
  }
  console.log("Manifest is valid.");

  // Create app
  console.log("Creating Slack app...");
  let creation = await slackApi("apps.manifest.create", { manifest });

  if (!creation.ok && creation.error === "token_expired") {
    await rotateToken();
    creation = await slackApi("apps.manifest.create", { manifest });
  }

  if (!creation.ok) {
    console.error("App creation failed:", creation.error);
    if (creation.errors) console.error("Details:", creation.errors);
    process.exit(1);
  }

  const { app_id, credentials } = creation;
  const { client_id, client_secret, signing_secret } = credentials;
  const oauthUrl = `https://slack.com/oauth/v2/authorize?client_id=${client_id}&scope=chat:write,app_mentions:read,channels:history,groups:history,im:history,mpim:history,commands,files:read,files:write,reactions:write,pins:write,channels:read,users:read&redirect_uri=https://slack.com`;

  console.log("\nApp created successfully!");
  console.log(`  App ID:         ${app_id}`);
  console.log(`  Client ID:      ${client_id}`);
  console.log(`  Client Secret:  ${client_secret}`);
  console.log(`  Signing Secret: ${signing_secret}`);

  // Write credentials to .env
  let env = readEnv();
  env = setEnvVar(env, "SLACK_APP_ID", app_id);
  env = setEnvVar(env, "SLACK_SIGNING_SECRET", signing_secret);
  env = setEnvVar(env, "SLACK_CLIENT_ID", client_id);
  env = setEnvVar(env, "SLACK_CLIENT_SECRET", client_secret);
  writeFileSync(envPath, env);
  console.log("\nCredentials written to .env");

  console.log("\n--- Next Steps ---");
  console.log(`1. Install the app to your workspace:\n   ${oauthUrl}\n`);
  console.log(`2. Generate an app-level token:`);
  console.log(`   Go to https://api.slack.com/apps/${app_id}/general`);
  console.log(`   Scroll to "App-Level Tokens" → "Generate Token"`);
  console.log(`   Add the scope: connections:write`);
  console.log(`   Copy the xapp-... token\n`);
  console.log(`3. Add tokens to .env:`);
  console.log(`   SLACK_BOT_TOKEN=xoxb-...  (from the OAuth install)`);
  console.log(`   SLACK_APP_TOKEN=xapp-...  (from step 2)\n`);
  console.log(`4. Start the bot:\n   npm run dev`);
}

main();

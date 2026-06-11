#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const rl = createInterface({ input, output });
const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);
const wranglerPath = new URL("../wrangler.jsonc", import.meta.url);
const adminPath = new URL("../.quizmcp-admin.json", import.meta.url);
const deployStatePath = new URL("../.quizmcp-deploy.json", import.meta.url);

main().catch((error) => {
  console.error("");
  console.error("Deployment setup failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}).finally(() => {
  rl.close();
});

async function main() {
  banner();
  ensureModernNode();
  ensureNpm();
  ensureDependencies();

  const config = readWranglerConfig();
  config.vars = config.vars && typeof config.vars === "object" ? config.vars : {};

  const workerName = await askText("Cloudflare Worker name", String(config.name || "quiz-mcp"));
  config.name = slugifyWorkerName(workerName);

  const authMode = await askChoice("Access mode", [
    ["none", "No authentication (recommended for most quiz apps)"],
    ["oauth", "OAuth 2.1 with an identity provider (for private organizations)"],
    ["admin_token", "Private admin password gate (simple, probe-resistant)"],
  ], "none");

  config.vars.AUTH_MODE = authMode;

  let adminToken = "";
  let oauthWasAutoAudience = false;
  if (authMode === "admin_token") {
    adminToken = randomToken();
    await configureAdminToken(adminToken, config);
  } else if (authMode === "oauth") {
    oauthWasAutoAudience = await configureOAuth(config);
  } else {
    delete config.vars.ADMIN_BEARER_TOKEN;
    delete config.vars.OAUTH_AUTHORIZATION_SERVERS;
    delete config.vars.OAUTH_AUDIENCE;
    delete config.vars.OAUTH_ISSUER;
    delete config.vars.OAUTH_JWKS_URL;
    delete config.vars.OAUTH_RESOURCE;
    delete config.vars.OAUTH_RESOURCE_DOCUMENTATION;
    delete config.vars.OAUTH_SCOPES;
  }

  writeWranglerConfig(config);
  ensureCloudflareLogin();

  if (authMode === "admin_token") {
    putWranglerSecret("ADMIN_BEARER_TOKEN", adminToken);
  }

  console.log("");
  console.log("Deploying once to get the Worker URL...");
  const firstDeploy = runCapture("npm", ["run", "deploy"]);
  const deployedUrl = parseWorkerUrl(firstDeploy.stdout + "\n" + firstDeploy.stderr);
  if (!deployedUrl) {
    throw new Error("Wrangler deploy finished, but I could not find the deployed workers.dev URL in the output.");
  }

  config.vars.PUBLIC_BASE_URL = deployedUrl;
  config.vars.WIDGET_DOMAIN = deployedUrl;
  if (authMode === "oauth") {
    config.vars.OAUTH_RESOURCE = deployedUrl;
    if (oauthWasAutoAudience || !config.vars.OAUTH_AUDIENCE || config.vars.OAUTH_AUDIENCE === "auto") {
      config.vars.OAUTH_AUDIENCE = deployedUrl;
    }
  }
  writeWranglerConfig(config);

  console.log("");
  console.log("Redeploying with PUBLIC_BASE_URL and widget domain set to:");
  console.log(deployedUrl);
  run("npm", ["run", "deploy"]);

  const state = {
    workerName: config.name,
    endpoint: `${deployedUrl}/mcp`,
    publicBaseUrl: deployedUrl,
    authMode,
    updatedAt: new Date().toISOString()
  };
  writeFileSync(deployStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  if (authMode === "admin_token") {
    writeAdminFile({
      username: "admin",
      password: adminToken,
      bearerToken: adminToken,
      endpoint: `${deployedUrl}/mcp`,
      createdAt: new Date().toISOString()
    });
    copyToClipboard(adminToken);
  }

  printNextSteps(deployedUrl, authMode, config, adminToken);
}

function banner() {
  console.log("");
  console.log("Quiz MCP guided deployment");
  console.log("==========================");
  console.log("This will check dependencies, configure Cloudflare, deploy the Worker, and print the ChatGPT setup URL.");
  console.log("");
}

function ensureModernNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 20) {
    throw new Error(`Node.js 20 or newer is required. Current version: ${process.version}`);
  }
}

function ensureNpm() {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("npm was not found. Run deploy.sh on macOS/Linux or deploy.ps1 on Windows so it can help install Node.js.");
  }
}

function ensureDependencies() {
  if (existsSync(new URL("../node_modules/.bin/wrangler", import.meta.url))) {
    return;
  }

  console.log("Installing project dependencies with npm install...");
  run("npm", ["install"]);
}

function ensureCloudflareLogin() {
  const whoami = spawnSync("npx", ["wrangler", "whoami"], {
    cwd: rootPath,
    encoding: "utf8"
  });
  if (whoami.status === 0) {
    return;
  }

  console.log("");
  console.log("Cloudflare login is required. A browser window may open.");
  run("npx", ["wrangler", "login"]);
}

async function configureAdminToken(token, config) {
  console.log("");
  console.log("Private admin mode:");
  console.log("- Every route returns 404 unless the request includes the generated secret.");
  console.log("- The secret is saved only in Cloudflare as a Worker secret and locally in .quizmcp-admin.json.");
  console.log("- If ChatGPT does not offer a bearer/custom header auth setting for your app, use OAuth mode instead.");
  config.vars.AUTH_MODE = "admin_token";
  config.vars.PUBLIC_BASE_URL = String(config.vars.PUBLIC_BASE_URL || "");
  config.vars.WIDGET_DOMAIN = String(config.vars.WIDGET_DOMAIN || "");
  console.log("");
  console.log("Generated admin password:");
  console.log(token);
}

async function configureOAuth(config) {
  console.log("");
  console.log("OAuth mode:");
  console.log("- ChatGPT performs authorization-code + PKCE with your identity provider.");
  console.log("- This Worker validates Authorization: Bearer tokens on tool calls.");
  console.log("- Use Auth0, Stytch, Okta, Cognito, or another provider that supports MCP/OAuth metadata.");
  console.log("");

  const issuer = await askText("OAuth issuer URL", String(config.vars.OAUTH_ISSUER || "https://your-tenant.example.com"));
  const authServers = await askText(
    "Authorization server URL(s), comma separated",
    String(config.vars.OAUTH_AUTHORIZATION_SERVERS || issuer)
  );
  const jwksUrl = await askText(
    "JWKS URL",
    String(config.vars.OAUTH_JWKS_URL || issuer.replace(/\/$/, "") + "/.well-known/jwks.json")
  );
  const scopes = await askText("Required scope(s)", String(config.vars.OAUTH_SCOPES || "quiz:render"));
  const audience = await askText("Token audience/resource, or press Enter for deployed Worker URL", String(config.vars.OAUTH_AUDIENCE || ""));
  const docsUrl = await askText("Optional auth documentation URL", String(config.vars.OAUTH_RESOURCE_DOCUMENTATION || ""));

  config.vars.AUTH_MODE = "oauth";
  config.vars.OAUTH_ISSUER = trimTrailingSlash(issuer);
  config.vars.OAUTH_AUTHORIZATION_SERVERS = authServers;
  config.vars.OAUTH_JWKS_URL = jwksUrl;
  config.vars.OAUTH_SCOPES = scopes;
  const autoAudience = !audience || audience.toLowerCase() === "auto";
  if (!autoAudience) {
    config.vars.OAUTH_AUDIENCE = audience;
  } else {
    config.vars.OAUTH_AUDIENCE = "auto";
  }
  if (docsUrl) {
    config.vars.OAUTH_RESOURCE_DOCUMENTATION = docsUrl;
  } else {
    delete config.vars.OAUTH_RESOURCE_DOCUMENTATION;
  }

  return autoAudience;
}

function putWranglerSecret(name, value) {
  console.log("");
  console.log(`Saving ${name} to Cloudflare Worker secrets...`);
  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    cwd: rootPath,
    input: value + "\n",
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"]
  });
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${name} failed.`);
  }
}

function printNextSteps(deployedUrl, authMode, config, adminToken) {
  console.log("");
  console.log("Deployment complete");
  console.log("===================");
  console.log(`MCP endpoint: ${deployedUrl}/mcp`);
  console.log(`Widget URL:   ${deployedUrl}/widget/quiz.html`);
  console.log("");
  console.log("ChatGPT setup:");
  console.log("1. Open ChatGPT settings.");
  console.log("2. Enable Developer Mode under Apps & Connectors > Advanced settings.");
  console.log("3. Create or refresh the app using this MCP endpoint:");
  console.log(`   ${deployedUrl}/mcp`);

  if (authMode === "oauth") {
    console.log("");
    console.log("OAuth notes:");
    console.log(`- Protected resource metadata: ${deployedUrl}/.well-known/oauth-protected-resource`);
    console.log("- Add the redirect URL shown by ChatGPT to your identity provider allowlist.");
    console.log("- ChatGPT production redirects use this shape: https://chatgpt.com/connector/oauth/{callback_id}");
    console.log(`- Required scopes advertised by this Worker: ${String(config.vars.OAUTH_SCOPES || "quiz:render")}`);
    console.log("- Your identity provider must echo the resource/audience into the access token.");
  } else if (authMode === "admin_token") {
    console.log("");
    console.log("Private admin password:");
    console.log("- Saved locally in .quizmcp-admin.json and copied to the clipboard when supported.");
    console.log("- Username for Basic auth: admin");
    console.log(`- Password / bearer token: ${adminToken}`);
    console.log("- In ChatGPT, use this only if the app setup screen supports a bearer token or custom Authorization header.");
    console.log("  Header value: Authorization: Bearer <the password above>");
  } else {
    console.log("");
    console.log("No auth is enabled. Use this only for local testing or trusted private experiments.");
  }
}

function readWranglerConfig() {
  const raw = readFileSync(wranglerPath, "utf8");
  return JSON.parse(stripJsonComments(raw));
}

function writeWranglerConfig(config) {
  writeFileSync(wranglerPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function writeAdminFile(value) {
  writeFileSync(adminPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    chmodSync(adminPath, 0o600);
  } catch {
    // Best-effort on filesystems that support POSIX permissions.
  }
}

function stripJsonComments(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

async function askText(label, fallback) {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = await rl.question(`${label}${suffix}: `);
  return (answer.trim() || fallback || "").trim();
}

async function askChoice(label, choices, fallback) {
  console.log(label + ":");
  for (let index = 0; index < choices.length; index += 1) {
    const [value, description] = choices[index];
    const marker = value === fallback ? " [default]" : "";
    console.log(`  ${index + 1}. ${description}${marker}`);
  }
  while (true) {
    const answer = (await rl.question("Choose a number or value: ")).trim();
    if (!answer) return fallback;
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
      return choices[index - 1][0];
    }
    const match = choices.find(([value]) => value === answer);
    if (match) return match[0];
    console.log("Please choose one of the listed options.");
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootPath,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootPath,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed.`);
  }
  return result;
}

function parseWorkerUrl(outputText) {
  const match = outputText.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i);
  return match ? match[0].replace(/\/$/, "") : "";
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function copyToClipboard(value) {
  const platform = os.platform();
  const commands = platform === "darwin"
    ? [["pbcopy", []]]
    : platform === "win32"
      ? [["clip", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      input: value,
      encoding: "utf8",
      shell: platform === "win32"
    });
    if (result.status === 0) {
      console.log("Copied the admin password to the clipboard.");
      return;
    }
  }
  console.log("Could not copy to clipboard automatically. The password is in .quizmcp-admin.json.");
}

function slugifyWorkerName(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "quiz-mcp";
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

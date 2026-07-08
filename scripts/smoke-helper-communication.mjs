#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (name.startsWith("no-")) {
      result[name.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[name] = true;
      continue;
    }
    result[name] = next;
    i += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const token = `claudero-smoke-${Date.now()}`;
const timeoutMs = Number(
  args.timeout || process.env.CLAUDERO_SMOKE_TIMEOUT || 180000,
);
const workspacePath = path.resolve(String(args.workspace || root));
const helperPath = path.resolve(
  String(
    args.helper ||
      path.join(
        root,
        ".scaffold/build/addon/content/helper/claudero-helper.mjs",
      ),
  ),
);
const full = args.full === true;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  console.log(`[smoke] ${message}`);
}

function isExecutableFile(filePath) {
  if (!filePath) return false;
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findInPath(command) {
  const entries = (process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function firstExecutable(candidates) {
  return candidates.find(isExecutableFile) || null;
}

function resolveProviderPath(provider) {
  if (provider === "claude") {
    const configured =
      args["claude-path"] || process.env.CLAUDERO_SMOKE_CLAUDE_PATH;
    if (isExecutableFile(configured)) return configured;
    return (
      findInPath(process.platform === "win32" ? "claude.exe" : "claude") ||
      firstExecutable([
        path.join(homedir(), ".claude/local/claude"),
        path.join(homedir(), ".local/bin/claude"),
        path.join(homedir(), ".npm-global/bin/claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ])
    );
  }

  const configured =
    args["codex-path"] || process.env.CLAUDERO_SMOKE_CODEX_PATH;
  if (isExecutableFile(configured)) return configured;
  return (
    findInPath(process.platform === "win32" ? "codex.exe" : "codex") ||
    firstExecutable([
      path.join(homedir(), ".local/bin/codex"),
      path.join(homedir(), ".npm-global/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ])
  );
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function startHelper(port) {
  assert(
    existsSync(helperPath),
    `Helper not found at ${helperPath}. Run npm run build first.`,
  );
  const child = spawn(
    process.execPath,
    [
      helperPath,
      "--server",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--token",
      token,
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    output() {
      return `${stdout}${stderr ? `\n${stderr}` : ""}`;
    },
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function headers(json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function getJson(baseUrl, route, expectedStatus = 200) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    headers: headers(),
  });
  const text = await response.text();
  assert(
    response.status === expectedStatus,
    `${route} returned ${response.status}: ${text}`,
  );
  return text ? JSON.parse(text) : null;
}

async function postJson(baseUrl, route, body, expectedStatus = 200) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert(
    response.status === expectedStatus,
    `${route} returned ${response.status}: ${text}`,
  );
  return text ? JSON.parse(text) : null;
}

async function postNdjson(baseUrl, route, body) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert(
    response.status === 200,
    `${route} returned ${response.status}: ${text}`,
  );
  return text
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForHelper(baseUrl, helper) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const health = await getJson(baseUrl, "/health");
      if (health?.ok) return;
    } catch {
      // Keep polling until the server is ready or the process exits.
    }
    if (helper.child.exitCode !== null) {
      throw new Error(
        `Helper exited before becoming ready:\n${helper.output()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Helper did not become ready:\n${helper.output()}`);
}

async function assertUnauthorized(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/health`);
  const text = await response.text();
  assert(
    response.status === 401,
    `/health without token returned ${response.status}: ${text}`,
  );
}

function providerPayload(provider) {
  const executablePath = resolveProviderPath(provider);
  if (provider === "claude") {
    assert(
      executablePath,
      `${provider} CLI not found. Set --${provider}-path or CLAUDERO_SMOKE_${provider.toUpperCase()}_PATH.`,
    );
    return {
      provider,
      claudePath: executablePath,
      model: String(
        args["claude-model"] ||
          process.env.CLAUDERO_SMOKE_CLAUDE_MODEL ||
          "sonnet",
      ),
      effort: String(
        args["claude-effort"] ||
          process.env.CLAUDERO_SMOKE_CLAUDE_EFFORT ||
          "low",
      ),
    };
  }
  if (!args["codex-auto-path"]) {
    assert(
      executablePath,
      `${provider} CLI not found. Set --${provider}-path or CLAUDERO_SMOKE_${provider.toUpperCase()}_PATH.`,
    );
  }
  return {
    provider,
    codexPath: args["codex-auto-path"] ? undefined : executablePath,
    codexInstallationMethod: String(
      args["codex-installation"] ||
        process.env.CLAUDERO_SMOKE_CODEX_INSTALLATION ||
        "native",
    ),
    codexWslDistro: String(
      args["codex-wsl-distro"] ||
        process.env.CLAUDERO_SMOKE_CODEX_WSL_DISTRO ||
        "",
    ),
    codexSafeMode: String(
      args["codex-safe-mode"] ||
        process.env.CLAUDERO_SMOKE_CODEX_SAFE_MODE ||
        "workspace-write",
    ),
    model: String(
      args["codex-model"] ||
        process.env.CLAUDERO_SMOKE_CODEX_MODEL ||
        "gpt-5.5",
    ),
    effort: String(
      args["codex-effort"] || process.env.CLAUDERO_SMOKE_CODEX_EFFORT || "low",
    ),
  };
}

function textFromEvents(events) {
  return events
    .filter((event) =>
      ["text", "text_delta", "text_snapshot"].includes(event.type),
    )
    .map((event) => event.text)
    .join("")
    .trim();
}

function assertTextEvents(provider, label, events, expected) {
  const eventTypes = events.map((event) => event.type).join(", ");
  assert(
    events.some((event) => event.type === "ready"),
    `${provider} ${label} did not emit ready: ${eventTypes}`,
  );
  assert(
    events.some((event) => event.type === "done"),
    `${provider} ${label} did not emit done: ${eventTypes}`,
  );
  assert(
    !events.some((event) => event.type === "error"),
    `${provider} ${label} emitted error: ${JSON.stringify(events)}`,
  );
  const actual = textFromEvents(events);
  assert(
    actual === expected,
    `${provider} ${label} expected ${expected}, got ${JSON.stringify(actual)} from ${JSON.stringify(events)}`,
  );
}

async function runProvider(baseUrl, provider) {
  const config = providerPayload(provider);
  const initPayload = {
    workspacePath,
    ...config,
    permissionMode: "dontAsk",
  };

  log(`${provider}: init`);
  await postJson(baseUrl, "/init", initPayload);
  const health = await getJson(baseUrl, "/health");
  assert(health.active === true, `${provider}: health.active should be true`);
  assert(
    health.provider === provider,
    `${provider}: health.provider should be ${provider}`,
  );

  log(`${provider}: commands`);
  const commands = await getJson(baseUrl, "/commands");
  assert(
    Array.isArray(commands.commands),
    `${provider}: /commands did not return an array`,
  );

  const sendToken = `${provider.toUpperCase()}_SEND_OK`;
  log(`${provider}: /send message`);
  const sendEvents = await postNdjson(baseUrl, "/send", {
    prompt: `Reply with exactly this token and nothing else: ${sendToken}`,
    images: [],
    ...config,
    permissionMode: "dontAsk",
  });
  assertTextEvents(provider, "/send", sendEvents, sendToken);
  const trace = await getJson(baseUrl, "/trace/latest");
  assert(
    trace?.traceId && Array.isArray(trace.events),
    `${provider}: /trace/latest did not return a trace`,
  );
  assert(
    trace.source?.provider === provider,
    `${provider}: trace source provider mismatch`,
  );
  assert(
    trace.events?.some((event) => event.event?.type === "done"),
    `${provider}: trace did not record done event`,
  );

  if (!full) return;

  const queryToken = `${provider.toUpperCase()}_QUERY_OK`;
  log(`${provider}: legacy /query message`);
  const queryEvents = await postNdjson(baseUrl, "/query", {
    workspacePath,
    prompt: `Reply with exactly this token and nothing else: ${queryToken}`,
    images: [],
    ...config,
    permissionMode: "dontAsk",
  });
  assertTextEvents(provider, "/query", queryEvents, queryToken);

  const auxToken = `${provider.toUpperCase()}_AUX_OK`;
  log(`${provider}: /aux-query message`);
  const aux = await postJson(baseUrl, "/aux-query", {
    workspacePath,
    prompt: `Reply with exactly this token and nothing else: ${auxToken}`,
    systemPrompt: "Return only the requested token.",
    ...config,
  });
  const auxText = String(aux.text || "").trim();
  assert(
    auxText === auxToken,
    `${provider}: /aux-query expected ${auxToken}, got ${JSON.stringify(auxText)}`,
  );
}

async function main() {
  const providersValue = String(
    args.providers || args.provider || "claude,codex",
  );
  const providers = providersValue
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean);
  assert(
    providers.every(
      (provider) => provider === "claude" || provider === "codex",
    ),
    `Unsupported provider list: ${providersValue}`,
  );

  const port = Number(args.port || (await freePort()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const helper = startHelper(port);

  try {
    await waitForHelper(baseUrl, helper);
    log("auth guard");
    await assertUnauthorized(baseUrl);

    for (const provider of providers) {
      await runProvider(baseUrl, provider);
    }

    log("shutdown");
    await postJson(baseUrl, "/shutdown", {});
    console.log("[smoke] PASS helper communication");
  } finally {
    if (!helper.child.killed) helper.child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(
    `[smoke] FAIL ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exit(1);
});

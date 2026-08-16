#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args.timeout || 180_000);
const model = String(args.model || "gpt-5.5");
const effort = String(args.effort || "medium");
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
const expectedHelperVersion = Number(
  readFileSync(path.join(root, "src/shared/helperProtocol.ts"), "utf8").match(
    /CLAUDERO_HELPER_VERSION\s*=\s*(\d+)/,
  )?.[1] || 0,
);
const token = `claudero-latency-${Date.now()}`;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function executable(filePath) {
  try {
    return !!filePath && existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findExecutable(command) {
  const configured = String(args["codex-path"] || "").trim();
  if (executable(configured)) return configured;
  for (const directory of String(process.env.PATH || "").split(
    path.delimiter,
  )) {
    const candidate = path.join(directory, command);
    if (executable(candidate)) return candidate;
  }
  return [
    path.join(homedir(), ".npm-global/bin/codex"),
    path.join(homedir(), ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].find(executable);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function runVersion(command, versionArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, versionArgs, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", () => resolve(output.trim().split("\n").at(-1) || "-"));
    child.on("error", (error) => resolve(`error: ${error.message}`));
  });
}

function startHelper(port) {
  assert(existsSync(helperPath), `Helper bundle not found: ${helperPath}`);
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
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

function requestHeaders(json = false) {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function fetchTimed(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return { response, elapsedMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRequest(baseUrl, route, options = {}) {
  const { response, elapsedMs } = await fetchTimed(`${baseUrl}${route}`, {
    ...options,
    headers: {
      ...requestHeaders(options.body !== undefined),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  assert(response.ok, `${route} returned ${response.status}: ${text}`);
  return { data: text ? JSON.parse(text) : null, elapsedMs };
}

async function waitForHelper(baseUrl, helper) {
  const startedAt = performance.now();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const result = await jsonRequest(baseUrl, "/health");
      if (result.data?.ok) {
        return { ...result, startupMs: performance.now() - startedAt };
      }
    } catch {
      // The helper may not have bound its port yet.
    }
    if (helper.child.exitCode !== null) {
      throw new Error(`Helper exited early:\n${helper.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Helper did not become ready:\n${helper.output()}`);
}

function firstEventTime(events, types) {
  return events.find((entry) => types.includes(entry.event.type))?.elapsedMs;
}

function formatMs(value) {
  return typeof value === "number" ? `${Math.round(value)} ms` : "-";
}

async function streamTurn(baseUrl, payload, label) {
  const startedAt = performance.now();
  const { response, elapsedMs: headersMs } = await fetchTimed(
    `${baseUrl}/send`,
    {
      method: "POST",
      headers: requestHeaders(true),
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(
      `/send returned ${response.status}: ${await response.text()}`,
    );
  }
  assert(response.body, "/send response did not provide a readable stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const consumeLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    events.push({ event, elapsedMs: performance.now() - startedAt });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  consumeLine(buffer);

  const eventCounts = {};
  for (const { event } of events) {
    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
  }
  const result = {
    label,
    headersMs,
    readyMs: firstEventTime(events, ["ready"]),
    sessionMs: firstEventTime(events, ["session"]),
    activityMs: firstEventTime(events, [
      "thinking",
      "thinking_snapshot",
      "tool_use",
      "tool_use_delta",
      "text",
      "text_delta",
      "text_snapshot",
    ]),
    textMs: firstEventTime(events, ["text", "text_delta", "text_snapshot"]),
    doneMs: firstEventTime(events, ["done"]),
    eventCounts,
  };
  console.log(
    `[latency] ${label}: headers=${formatMs(result.headersMs)} ready=${formatMs(result.readyMs)} session=${formatMs(result.sessionMs)} firstActivity=${formatMs(result.activityMs)} firstText=${formatMs(result.textMs)} done=${formatMs(result.doneMs)}`,
  );
  return result;
}

function diagnosis(startup, init, healthMedian, cold, warm) {
  const findings = [];
  if (startup > 2_000) findings.push("helper process startup is slow");
  if (healthMedian > 100) findings.push("plugin/helper HTTP bridge is slow");
  if (init > 5_000)
    findings.push("Codex app-server or MCP initialization is slow");
  if ((cold.sessionMs || 0) > 5_000 && (warm.sessionMs || 0) < 2_000) {
    findings.push("new Codex thread creation dominates the cold request");
  }
  const warmModelWait = (warm.textMs || 0) - (warm.sessionMs || 0);
  if (warmModelWait > 10_000) {
    findings.push(
      "the main delay is after session setup, inside Codex/model processing",
    );
  }
  if ((warm.headersMs || 0) > 1_000) {
    findings.push(
      "/send is restarting or reconfiguring the runtime before streaming",
    );
  }
  return findings.length
    ? findings
    : ["no stage crossed the latency thresholds"];
}

async function main() {
  const codexPath = findExecutable(
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  assert(codexPath, "Codex CLI not found; pass --codex-path /path/to/codex");
  const codexVersion = await runVersion(codexPath, ["--version"]);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const helper = startHelper(port);

  try {
    const ready = await waitForHelper(baseUrl, helper);
    assert(
      ready.data.version === expectedHelperVersion,
      `helper version ${ready.data.version} != source protocol ${expectedHelperVersion}`,
    );
    const healthSamples = [];
    for (let sample = 0; sample < 5; sample += 1) {
      healthSamples.push((await jsonRequest(baseUrl, "/health")).elapsedMs);
    }
    healthSamples.sort((left, right) => left - right);
    const healthMedian = healthSamples[Math.floor(healthSamples.length / 2)];

    const config = {
      provider: "codex",
      workspacePath,
      codexPath,
      codexInstallationMethod: "native",
      codexSafeMode: "workspace-write",
      model,
      effort,
      permissionMode: "dontAsk",
      enableZoteroMcp: false,
      ...(args["fork-thread-id"]
        ? {
            providerState: {
              codex: {
                forkSource: { threadId: String(args["fork-thread-id"]) },
              },
            },
          }
        : {}),
    };
    const initRequest = () =>
      jsonRequest(baseUrl, "/init", {
        method: "POST",
        body: JSON.stringify(config),
      });
    const catalogRequest = () =>
      jsonRequest(baseUrl, "/models", {
        method: "POST",
        body: JSON.stringify(config),
      });
    const [init, catalog] = args["init-race"]
      ? await Promise.all([initRequest(), catalogRequest()])
      : [await initRequest(), await catalogRequest()];

    console.log(`[latency] Node: ${process.version}`);
    console.log(`[latency] Codex: ${codexVersion} (${codexPath})`);
    console.log(
      `[latency] Helper: protocol=${ready.data.version} startup=${formatMs(ready.startupMs)} healthMedian=${formatMs(healthMedian)} init=${formatMs(init.elapsedMs)}`,
    );
    console.log(`[latency] Model: ${model}, effort: ${effort}`);

    const models = Array.isArray(catalog.data?.models)
      ? catalog.data.models
      : [];
    console.log(
      `[latency] Available models (${models.length}): ${models
        .map(
          (entry) =>
            `${entry.label}=${entry.value}${entry.isDefault ? " [default]" : ""}`,
        )
        .join(", ")}`,
    );
    if (args["models-only"]) return;

    const commonSend = {
      ...config,
      images: [],
    };
    const cold = await streamTurn(
      baseUrl,
      {
        ...commonSend,
        prompt:
          "Reply with exactly COLD_OK and nothing else. Do not use tools.",
      },
      "cold turn",
    );
    const warm = await streamTurn(
      baseUrl,
      {
        ...commonSend,
        prompt:
          "Reply with exactly WARM_OK and nothing else. Do not use tools.",
      },
      "warm turn",
    );

    const diagnostics = (await jsonRequest(baseUrl, "/diagnostics")).data;
    const codexDiagnostics = diagnostics?.runtimes?.codex;
    const runtimeCommand = codexDiagnostics?.launch?.command;
    if (runtimeCommand && runtimeCommand !== codexPath) {
      console.log(`[latency] Helper selected: ${runtimeCommand}`);
    }
    console.log(
      `[latency] MCP servers: ${(codexDiagnostics?.mcpServers || []).join(", ") || "none (isolated baseline)"}`,
    );
    for (const finding of diagnosis(
      ready.startupMs,
      init.elapsedMs,
      healthMedian,
      cold,
      warm,
    )) {
      console.log(`[latency] Finding: ${finding}`);
    }
    console.log(
      `[latency] Event counts (warm): ${JSON.stringify(warm.eventCounts)}`,
    );
  } finally {
    try {
      await jsonRequest(baseUrl, "/shutdown", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch {
      // Ensure the child is still terminated if diagnostics failed midway.
    }
    if (!helper.child.killed) helper.child.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(
    `[latency] FAIL ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  process.exitCode = 1;
});

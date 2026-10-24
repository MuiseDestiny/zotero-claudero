import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const directory = path.join(
  root,
  ".scaffold/build/addon/content/helper/standalone",
);
const manifest = JSON.parse(
  await readFile(path.join(directory, "manifest.json"), "utf8"),
);
const binary = manifest.binaries.find(
  (entry) => entry.platform === process.platform && entry.arch === process.arch,
);
if (!binary)
  throw new Error("Build a standalone Helper for the current platform first");
const executable = path.join(directory, binary.file);
const bytes = await readFile(executable);
if (
  bytes.length !== binary.bytes ||
  createHash("sha256").update(bytes).digest("hex") !== binary.sha256
)
  throw new Error("Standalone Helper integrity check failed");
const temp = await mkdtemp(
  path.join(os.tmpdir(), "claudero-standalone-smoke-"),
);
const bun = process.env.CLAUDERO_BUN_PATH || "bun";
const fixture = path.join(
  temp,
  `native-agent${process.platform === "win32" ? ".exe" : ""}`,
);
const children = new Set();
const token = "fixture-standalone-helper-capability-12345";
const endpoint = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    try {
      const value = JSON.parse(body);
      assert(value.action === "get_item", "Expected Zotero read action");
      assert(
        value._clauderoToken === token,
        "Expected authenticated Zotero MCP payload",
      );
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, title: "fixture paper" }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
});
const env = {
  PATH: "",
  HOME: temp,
  USERPROFILE: temp,
  TMPDIR: temp,
  TMP: temp,
  TEMP: temp,
  // Windows needs its OS directory, not the developer's PATH or credentials.
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
};
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const track = (child) => {
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
};
const waitFor = async (check, message) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${message}`);
};
let helper;
try {
  execFileSync(
    bun,
    [
      "build",
      "test/fixtures/native-agent.ts",
      "--compile",
      `--outfile=${fixture}`,
      "--env=disable",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
    ],
    { stdio: "inherit" },
  );
  // Local workspace config must not be implicitly loaded by the compiled Helper.
  await writeFile(
    path.join(temp, ".env"),
    "CLAUDERO_FIXTURE_AUTOLOAD=must-not-load\n",
  );
  await writeFile(
    path.join(temp, "bunfig.toml"),
    'preload = ["./unexpected-preload.ts"]\n',
  );
  await writeFile(
    path.join(temp, "unexpected-preload.ts"),
    'throw new Error("Workspace bunfig was unexpectedly loaded");\n',
  );
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const zoteroUrl = `http://127.0.0.1:${endpoint.address().port}/claudero`;
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  helper = track(
    spawn(
      executable,
      [
        "--server",
        "--port",
        String(port),
        "--token",
        token,
        "--parent-pid",
        String(process.pid),
      ],
      { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  let output = "";
  helper.stdout.on("data", (chunk) => {
    output += chunk;
  });
  helper.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await waitFor(() => {
    if (helper.exitCode !== null || helper.signalCode !== null)
      throw new Error(output);
    return output.includes("Claudero helper listening");
  }, "standalone startup");
  const url = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const request = async (route, payload, expectedStatus = 200) => {
    const response = await fetch(url + route, {
      method: payload === undefined ? "GET" : "POST",
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: globalThis.AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    assert(
      response.status === expectedStatus,
      `${route}: ${response.status}: ${text}`,
    );
    return route === "/send" && response.ok
      ? text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : JSON.parse(text);
  };
  const health = await request("/health");
  assert(
    health.runtime?.kind === "standalone" && health.runtime?.engine === "bun",
    "Expected a standalone runtime",
  );
  assert(
    (await fetch(url + "/health")).status === 401,
    "Unauthenticated health must fail",
  );
  const foreign = await fetch(url + "/health", {
    headers: { ...headers, Origin: "https://foreign.example" },
  });
  assert(foreign.status === 403, "Foreign origin must fail");
  await foreign.text();
  console.log(
    "[standalone] PASS health, authentication, and origin guard with PATH empty",
  );
  for (const provider of ["claude", "codex"]) {
    for (let turn = 1; turn <= 2; turn++) {
      const events = await request("/send", {
        provider,
        requestId: `fixture-${provider}-${turn}`,
        conversationId: `fixture-${provider}`,
        prompt: "fixture prompt",
        workspacePath: temp,
        [provider === "claude" ? "claudePath" : "codexPath"]: fixture,
        ...(provider === "codex"
          ? { zoteroEndpointUrl: zoteroUrl }
          : { enableZoteroMcp: false }),
      });
      assert(events[0]?.type === "ready", `${provider} ready event missing`);
      assert(
        events.at(-1)?.outcome === "success",
        `${provider} failed: ${JSON.stringify(events)}`,
      );
      const text = events
        .filter((event) => ["text", "text_delta"].includes(event.type))
        .map((event) => event.text)
        .join("");
      assert(
        text === `${provider.toUpperCase()}_NATIVE_${turn}`,
        `${provider} native continuation mismatch: ${text}`,
      );
    }
    console.log(
      `[standalone] PASS ${provider} native fixture, two turns${provider === "codex" ? ", self-spawned MCP handshake/tools/authenticated read" : ", bundled Claude SDK"}`,
    );
  }
  // The JS CLI compatibility path must select Node, not nonexistent external Bun.
  const script = path.join(temp, "fixture-claude.mjs");
  await writeFile(script, "process.exit(2);\n");
  const scriptResult = await request(
    "/send",
    {
      requestId: "fixture-npm-claude",
      provider: "claude",
      prompt: "fixture",
      workspacePath: temp,
      claudePath: script,
      enableZoteroMcp: false,
    },
    500,
  );
  assert(
    /requires Node\.js 20\+/i.test(scriptResult.error),
    `Missing Node prerequisite must be actionable: ${JSON.stringify(scriptResult)}`,
  );
  console.log(
    "[standalone] PASS npm-based Claude reports its remaining Node dependency",
  );
  const deepseekScript = path.join(root, "test/fixtures/mock-dsh.mjs");
  const deepseek = await request("/send", {
    requestId: "fixture-deepseek-node",
    provider: "deepseek",
    prompt: "fixture",
    workspacePath: temp,
    deepseekPath: deepseekScript,
    environment: { DSH_NODE_PATH: process.execPath },
  });
  assert(
    deepseek.at(-1)?.outcome === "success" &&
      deepseek.some(
        (event) => event.type === "text" && event.text.includes("fixture"),
      ),
    `DeepSeek must keep its explicit real Node runtime: ${JSON.stringify(deepseek)}`,
  );
  console.log(
    "[standalone] PASS DeepSeek compatibility using explicitly configured Node",
  );

  const bridge = track(
    spawn(executable, ["--zotero-mcp-stdio"], {
      env,
      cwd: temp,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const lines = createInterface({ input: bridge.stdout });
  const messages = [];
  lines.on("line", (line) => messages.push(JSON.parse(line)));
  bridge.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  bridge.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await waitFor(() => messages.length === 2, "standalone MCP line framing");
  assert(
    messages[0].result?.serverInfo?.name === "zotero",
    "MCP initialize failed",
  );
  assert(messages[1].result?.tools?.length > 10, "MCP tools list failed");
  lines.close();
  bridge.kill();
  await request("/shutdown", {});
  await waitFor(() => helper.exitCode === 0, "standalone shutdown");
  console.log(
    "[standalone] PASS direct MCP stdio, graceful shutdown, and no external Node/Bun runtime",
  );
} finally {
  for (const child of children) child.kill();
  await waitFor(() => children.size === 0, "fixture cleanup");
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

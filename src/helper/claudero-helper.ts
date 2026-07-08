import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "os";
import path from "node:path";
import process from "node:process";
import { PermissionManager } from "./runtime/PermissionManager";
import {
  ClaudeRuntimeAdapter,
  CodexRuntimeAdapter,
  type AgentRuntimeAdapter,
  type AgentRuntimeRestartConfig,
} from "./runtime/AgentRuntimeAdapter";
import { testMcpServer, type McpServerConfig } from "./runtime/McpTester";
import { runZoteroMcpStdioServer } from "./runtime/ZoteroMcpBridge";
import {
  buildQueryOptions,
  normalizeEffort as normalizeClaudeEffort,
  normalizeModel as normalizeClaudeModel,
  type ClauderoPermissionMode,
} from "./runtime/QueryOptionsBuilder";
import {
  AgentEventRecorder,
  isAgentEventPayload,
  type AgentEventTrace,
} from "../shared/agentEvents";
import { CLAUDERO_HELPER_VERSION as HELPER_VERSION } from "../shared/helperProtocol";

type HelperProvider = "claude" | "codex";

interface HelperConfig {
  host: string;
  port: number;
  token: string;
}

interface ImageInput {
  media_type: string;
  data: string;
}

interface SendPayload {
  prompt: string;
  sessionId?: string;
  conversationId?: string;
  provider?: HelperProvider;
  claudePath?: string;
  codexPath?: string;
  codexInstallationMethod?: "native" | "wsl";
  codexWslDistro?: string;
  codexSafeMode?: "workspace-write" | "read-only";
  environment?: Record<string, string>;
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  permissionMode?: ClauderoPermissionMode;
  zoteroEndpointUrl?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  images?: ImageInput[];
  providerState?: HelperProviderState;
}

interface InitPayload {
  workspacePath: string;
  provider?: HelperProvider;
  claudePath?: string;
  codexPath?: string;
  codexInstallationMethod?: "native" | "wsl";
  codexWslDistro?: string;
  codexSafeMode?: "workspace-write" | "read-only";
  environment?: Record<string, string>;
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  permissionMode?: ClauderoPermissionMode;
  zoteroEndpointUrl?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  conversationId?: string;
  providerState?: HelperProviderState;
}

interface HelperProviderState {
  claude?: {
    sessionId?: string;
  };
  codex?: {
    threadId?: string;
    sessionFilePath?: string;
    forkSource?: {
      threadId: string;
      resumeAt?: string;
      sourceConversationId?: string;
    };
  };
}

interface TestMcpPayload {
  config: McpServerConfig;
}

interface RequestPermissionPayload {
  toolName: string;
  input: unknown;
}

interface AuxQueryPayload {
  prompt: string;
  systemPrompt?: string;
  workspacePath: string;
  provider?: HelperProvider;
  claudePath?: string;
  codexPath?: string;
  codexInstallationMethod?: "native" | "wsl";
  codexWslDistro?: string;
  codexSafeMode?: "workspace-write" | "read-only";
  environment?: Record<string, string>;
  model?: string;
  effort?: string;
}

// ── Helper Functions ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): HelperConfig {
  const getArg = (name: string, fallback = ""): string => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || fallback : fallback;
  };

  return {
    host: getArg("--host", "127.0.0.1"),
    port: Number(getArg("--port", "38660")),
    token: getArg("--token"),
  };
}

function normalizeProvider(value: string | undefined): HelperProvider {
  return value === "codex" ? "codex" : "claude";
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeEvent(
  res: ServerResponse,
  event: unknown,
  recorder?: AgentEventRecorder,
): void {
  if (recorder && isAgentEventPayload(event)) {
    recorder.record(event);
    latestAgentTrace = recorder.snapshot();
  }
  res.write(`${JSON.stringify(event)}\n`);
}

function isExecutableFile(filePath: string | undefined): filePath is string {
  if (!filePath) return false;
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pathEntries(pathValue: string | undefined): string[] {
  return (pathValue || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findInPath(
  command: string,
  pathValue: string | undefined,
): string | null {
  for (const entry of pathEntries(pathValue)) {
    const candidate = path.join(entry, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function findClaudeCodeEntrypoint(packageRoot: string): string | null {
  const candidates = ["cli-wrapper.cjs", "cli.js"].map((entrypoint) =>
    path.join(packageRoot, entrypoint),
  );
  return candidates.find(isExecutableFile) || null;
}

function resolveNvmDefaultBin(home: string): string | null {
  try {
    const nvmDir = path.join(home, ".nvm");
    const alias = readFileSync(path.join(nvmDir, "alias", "default"), "utf8")
      .trim()
      .replace(/^v/, "");
    if (!alias || alias.includes("/") || alias.includes("\\")) return null;
    const versionsDir = path.join(nvmDir, "versions", "node");
    const versions = readdirSync(versionsDir)
      .filter((entry) => entry.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const match =
      alias === "node" || alias === "stable"
        ? versions[0]
        : versions.find((entry) => {
            const version = entry.slice(1);
            return version === alias || version.startsWith(`${alias}.`);
          });
    return match ? path.join(versionsDir, match, "bin") : null;
  } catch {
    return null;
  }
}

function resolveClaudePath(
  configuredPath: string | undefined,
  env: Record<string, string | undefined>,
): string {
  if (isExecutableFile(configuredPath)) return configuredPath;

  const home = homedir();
  const isWindows = process.platform === "win32";
  const pathValue = env.PATH || process.env.PATH;
  const nvmBin = resolveNvmDefaultBin(home);

  const fromPath = findInPath(isWindows ? "claude.exe" : "claude", pathValue);
  if (fromPath) return fromPath;

  const commonCandidates = isWindows
    ? [
        path.join(home, ".claude", "local", "claude.exe"),
        path.join(home, "AppData", "Local", "Claude", "claude.exe"),
        path.join(
          process.env.ProgramFiles || "C:\\Program Files",
          "Claude",
          "claude.exe",
        ),
      ]
    : [
        path.join(home, ".claude", "local", "claude"),
        path.join(home, ".local", "bin", "claude"),
        path.join(home, ".npm-global", "bin", "claude"),
        path.join(home, ".bun", "bin", "claude"),
        path.join(home, ".docker", "bin", "claude"),
        path.join(home, ".volta", "bin", "claude"),
        path.join(home, ".asdf", "shims", "claude"),
        ...(nvmBin ? [path.join(nvmBin, "claude")] : []),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
      ];

  const common = commonCandidates.find(isExecutableFile);
  if (common) return common;

  const packageRoots = isWindows
    ? [
        path.join(
          home,
          "AppData",
          "Roaming",
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
        ),
      ]
    : [
        path.join(
          home,
          ".npm-global",
          "lib",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
        ),
        "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code",
        "/usr/local/lib/node_modules/@anthropic-ai/claude-code",
      ];

  for (const packageRoot of packageRoots) {
    const entrypoint = findClaudeCodeEntrypoint(packageRoot);
    if (entrypoint) return entrypoint;
  }

  throw new Error(
    "Claude Code CLI not found. Install Claude Code or set Claudero preferences -> Claude Code CLI path.",
  );
}

function resolveCodexPath(
  configuredPath: string | undefined,
  env: Record<string, string | undefined>,
  installationMethod?: "native" | "wsl",
): string {
  if (installationMethod === "wsl") {
    return configuredPath?.trim() || "codex";
  }
  if (isExecutableFile(configuredPath)) return configuredPath;

  const home = homedir();
  const isWindows = process.platform === "win32";
  const pathValue = env.PATH || process.env.PATH;
  const nvmBin = resolveNvmDefaultBin(home);

  const fromPath = findInPath(isWindows ? "codex.exe" : "codex", pathValue);
  if (fromPath) return fromPath;

  const commonCandidates = isWindows
    ? [
        path.join(
          home,
          "AppData",
          "Local",
          "Programs",
          "OpenAI",
          "Codex",
          "bin",
          "codex.exe",
        ),
        "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
      ]
    : [
        path.join(home, ".npm-global", "bin", "codex"),
        path.join(home, ".local", "bin", "codex"),
        path.join(home, ".bun", "bin", "codex"),
        path.join(home, ".docker", "bin", "codex"),
        path.join(home, ".volta", "bin", "codex"),
        path.join(home, ".asdf", "shims", "codex"),
        ...(nvmBin ? [path.join(nvmBin, "codex")] : []),
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/usr/bin/codex",
      ];

  const common = commonCandidates.find(isExecutableFile);
  if (common) return common;

  throw new Error(
    "Codex CLI not found. Install Codex or set Claudero preferences -> Codex CLI path.",
  );
}

function uniqueExistingDirectories(paths: string[] | undefined): string[] {
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const raw of paths || []) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    try {
      if (existsSync(value) && statSync(value).isDirectory()) {
        seen.add(value);
        directories.push(value);
      }
    } catch {
      // Ignore inaccessible context directories.
    }
  }
  return directories;
}

// ── HTTP Handlers ────────────────────────────────────────────────────────────

const permissionManager = new PermissionManager();
const runtimeAdapters: Record<HelperProvider, AgentRuntimeAdapter> = {
  claude: new ClaudeRuntimeAdapter(permissionManager),
  codex: new CodexRuntimeAdapter(permissionManager),
};
let activeProvider: HelperProvider = "claude";
let latestAgentTrace: AgentEventTrace | null = null;

function queryManagerFor(provider: HelperProvider) {
  return runtimeAdapters[provider];
}

function activeQueryManager() {
  return queryManagerFor(activeProvider);
}

function currentWorkspacePathFor(provider: HelperProvider): string | null {
  return (
    queryManagerFor(provider).workspacePath ||
    runtimeAdapters.claude.workspacePath ||
    runtimeAdapters.codex.workspacePath
  );
}

function traceSummary(trace: AgentEventTrace | null): unknown {
  if (!trace) return null;
  const eventCounts: Record<string, number> = {};
  for (const envelope of trace.events) {
    eventCounts[envelope.event.type] =
      (eventCounts[envelope.event.type] || 0) + 1;
  }
  const errors = trace.events
    .map((envelope) => envelope.event)
    .filter(
      (event): event is { type: "error"; error: string } =>
        event.type === "error",
    )
    .map((event) => event.error);
  return {
    traceId: trace.traceId,
    startedAt: trace.startedAt,
    source: trace.source,
    eventCount: trace.events.length,
    eventCounts,
    errors,
    lastEvent: trace.events.at(-1) || null,
  };
}

function diagnosticsPayload(): unknown {
  return {
    helper: {
      version: HELPER_VERSION,
      activeProvider,
      active: activeQueryManager().isActive,
    },
    runtimes: {
      claude: runtimeAdapters.claude.diagnostics(),
      codex: runtimeAdapters.codex.diagnostics(),
    },
    trace: traceSummary(latestAgentTrace),
  };
}

function runtimeRestartConfig(
  provider: HelperProvider,
  payload: Partial<InitPayload & SendPayload>,
): AgentRuntimeRestartConfig {
  const common = {
    model: normalizeClaudeModel(payload.model),
    effort:
      provider === "claude"
        ? normalizeClaudeEffort(payload.effort)
        : payload.effort,
    additionalDirectories: payload.additionalDirectories,
    environment: payload.environment,
    permissionMode: payload.permissionMode,
    zoteroEndpointUrl: payload.zoteroEndpointUrl,
    enableZoteroMcp: payload.enableZoteroMcp,
    mcpServers: payload.mcpServers,
    mcpDisabledTools: payload.mcpDisabledTools,
    conversationId: payload.conversationId,
  };
  if (provider === "codex") {
    return {
      ...common,
      codexPath: payload.codexPath,
      codexInstallationMethod: payload.codexInstallationMethod,
      codexWslDistro: payload.codexWslDistro,
      codexSafeMode: payload.codexSafeMode,
      providerState: payload.providerState?.codex,
    };
  }
  return {
    ...common,
    claudePath: payload.claudePath,
  };
}

function runtimeLiveUpdateConfig(
  provider: HelperProvider,
  payload: Partial<InitPayload & SendPayload>,
): AgentRuntimeRestartConfig {
  if (provider === "codex") {
    return {
      model: normalizeClaudeModel(payload.model),
      effort: payload.effort,
      additionalDirectories: payload.additionalDirectories,
      permissionMode: payload.permissionMode,
      codexSafeMode: payload.codexSafeMode,
    };
  }
  return {};
}

async function initializeProviderFromPayload(
  provider: HelperProvider,
  workspacePath: string,
  payload: Partial<InitPayload & SendPayload>,
  helperConfig?: HelperConfig,
): Promise<void> {
  const additionalDirectories = uniqueExistingDirectories(
    payload.additionalDirectories,
  );
  const manager = queryManagerFor(provider);
  if (provider === "codex") {
    const codexPath = resolveCodexPath(
      payload.codexPath,
      {
        ...process.env,
        ...(payload.environment || {}),
      },
      payload.codexInstallationMethod,
    );
    await manager.initialize({
      workspacePath,
      codexPath,
      environment: payload.environment || {},
      model: normalizeClaudeModel(payload.model),
      effort: payload.effort,
      additionalDirectories,
      permissionMode: payload.permissionMode,
      zoteroEndpointUrl: payload.zoteroEndpointUrl,
      enableZoteroMcp: payload.enableZoteroMcp,
      mcpServers: payload.mcpServers,
      mcpDisabledTools: payload.mcpDisabledTools,
      conversationId: payload.conversationId,
      codexInstallationMethod: payload.codexInstallationMethod,
      codexWslDistro: payload.codexWslDistro,
      codexSafeMode: payload.codexSafeMode,
      providerState: payload.providerState?.codex,
      helperBridge:
        helperConfig && payload.zoteroEndpointUrl
          ? {
              host: helperConfig.host,
              port: helperConfig.port,
              token: helperConfig.token,
              bundlePath: process.argv[1] || "",
            }
          : undefined,
    });
    return;
  }

  const claudePath = resolveClaudePath(payload.claudePath, {
    ...process.env,
    ...(payload.environment || {}),
  });
  await manager.initialize({
    workspacePath,
    claudePath,
    environment: payload.environment || {},
    model: normalizeClaudeModel(payload.model),
    effort: normalizeClaudeEffort(payload.effort),
    additionalDirectories,
    permissionMode: payload.permissionMode,
    zoteroEndpointUrl: payload.zoteroEndpointUrl,
    enableZoteroMcp: payload.enableZoteroMcp,
    mcpServers: payload.mcpServers,
    mcpDisabledTools: payload.mcpDisabledTools,
    conversationId: payload.conversationId,
  });
}

async function handleInit(
  req: IncomingMessage,
  res: ServerResponse,
  helperConfig: HelperConfig,
): Promise<void> {
  const payload = await readJsonBody<InitPayload>(req);

  if (!payload.workspacePath) {
    sendJson(res, 400, { error: "workspacePath is required" });
    return;
  }

  try {
    const provider = normalizeProvider(payload.provider);
    await initializeProviderFromPayload(
      provider,
      payload.workspacePath,
      payload,
      helperConfig,
    );
    activeProvider = provider;

    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  helperConfig: HelperConfig,
): Promise<void> {
  const payload = await readJsonBody<SendPayload>(req);
  await handleSendWithPayload(payload, res, helperConfig);
}

async function handleSendWithPayload(
  payload: SendPayload,
  res: ServerResponse,
  helperConfig: HelperConfig,
): Promise<void> {
  if (!payload.prompt && (!payload.images || payload.images.length === 0)) {
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }

  const provider = normalizeProvider(payload.provider);
  const manager = queryManagerFor(provider);
  activeProvider = provider;
  const currentWorkspacePath = currentWorkspacePathFor(provider);

  if (!manager.isActive) {
    if (!currentWorkspacePath) {
      sendJson(res, 400, {
        error: "Persistent query not initialized. Call /init first.",
      });
      return;
    }
    try {
      await initializeProviderFromPayload(
        provider,
        currentWorkspacePath,
        payload,
        helperConfig,
      );
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  const hasConfigUpdate =
    payload.claudePath ||
    payload.codexPath ||
    payload.codexInstallationMethod ||
    payload.codexWslDistro ||
    payload.codexSafeMode ||
    payload.model ||
    payload.effort ||
    payload.additionalDirectories ||
    payload.environment ||
    payload.permissionMode ||
    payload.zoteroEndpointUrl ||
    payload.enableZoteroMcp !== undefined ||
    payload.mcpServers ||
    payload.mcpDisabledTools ||
    payload.conversationId ||
    payload.providerState;
  const needsRestart = hasConfigUpdate
    ? manager.requiresRestart(runtimeRestartConfig(provider, payload))
    : false;

  if (needsRestart && manager.workspacePath) {
    const restartWorkspacePath = manager.workspacePath;
    try {
      manager.close();
      await initializeProviderFromPayload(
        provider,
        restartWorkspacePath,
        payload,
        helperConfig,
      );
    } catch (error) {
      sendJson(res, 500, {
        error: `Failed to restart ${provider} runtime: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  } else {
    manager.updateConfig(runtimeLiveUpdateConfig(provider, payload));
    if (payload.permissionMode !== undefined) {
      try {
        await manager.setPermissionMode(payload.permissionMode);
      } catch (error) {
        sendJson(res, 500, {
          error: `Failed to update permission mode: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const traceRecorder = new AgentEventRecorder({
    provider,
    conversationId: payload.conversationId,
    runtime: "helper",
  });
  writeEvent(res, { type: "ready" }, traceRecorder);

  try {
    for await (const event of manager.sendMessageEvents(
      payload.prompt,
      payload.images,
    )) {
      writeEvent(res, event, traceRecorder);
    }
    writeEvent(res, { type: "done" }, traceRecorder);
  } catch (error) {
    writeEvent(
      res,
      {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      },
      traceRecorder,
    );
    // The streaming query threw — its underlying CLI session may be dead.
    // Drop it so the next message re-initializes a fresh query instead of
    // reusing a broken one (which surfaces as a NetworkError client-side).
    manager.close();
  } finally {
    res.end();
  }
}

async function handleQuery(
  req: IncomingMessage,
  res: ServerResponse,
  helperConfig: HelperConfig,
): Promise<void> {
  // Legacy endpoint - read the body once, then init + send.
  const payload = await readJsonBody<
    SendPayload & { workspacePath: string; [key: string]: unknown }
  >(req);

  if (!payload.prompt || !payload.workspacePath) {
    sendJson(res, 400, { error: "prompt and workspacePath are required" });
    return;
  }

  const provider = normalizeProvider(payload.provider);
  activeProvider = provider;
  const manager = queryManagerFor(provider);

  // Initialize if not already active
  if (!manager.isActive) {
    try {
      await initializeProviderFromPayload(
        provider,
        payload.workspacePath,
        payload,
        helperConfig,
      );
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }

  // Send the message using the already-parsed payload (do NOT re-read the
  // request body — the stream has already been consumed above).
  await handleSendWithPayload(payload, res, helperConfig);
}

async function handleAuxQuery(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody<AuxQueryPayload>(req);
  if (!payload.prompt || !payload.workspacePath) {
    sendJson(res, 400, { error: "prompt and workspacePath are required" });
    return;
  }

  try {
    const provider = normalizeProvider(payload.provider);
    if (provider === "codex") {
      const codexPath = resolveCodexPath(
        payload.codexPath,
        {
          ...process.env,
          ...(payload.environment || {}),
        },
        payload.codexInstallationMethod,
      );
      const auxManager = new CodexRuntimeAdapter(new PermissionManager());
      await auxManager.initialize({
        workspacePath: payload.workspacePath,
        codexPath,
        environment: payload.environment || {},
        model: normalizeClaudeModel(payload.model) || "gpt-5.4-mini",
        effort: payload.effort || "low",
        permissionMode: "dontAsk",
        codexInstallationMethod: payload.codexInstallationMethod,
        codexWslDistro: payload.codexWslDistro,
        codexSafeMode: payload.codexSafeMode,
      });
      let text = "";
      const prompt = payload.systemPrompt
        ? `${payload.systemPrompt}\n\n${payload.prompt}`
        : payload.prompt;
      try {
        for await (const event of auxManager.sendMessageEvents(prompt)) {
          if (
            event.type === "text" ||
            event.type === "text_delta" ||
            event.type === "text_snapshot"
          ) {
            text += event.text;
          }
        }
      } finally {
        auxManager.close();
      }
      sendJson(res, 200, { text });
      return;
    }

    const claudePath = resolveClaudePath(payload.claudePath, {
      ...process.env,
      ...(payload.environment || {}),
    });
    const options = buildQueryOptions({
      workspacePath: payload.workspacePath,
      claudePath,
      environment: payload.environment || {},
      model: normalizeClaudeModel(payload.model),
      effort: normalizeClaudeEffort(payload.effort) as string | undefined,
      permissionMode: "auto",
    });
    // Auxiliary jobs such as titles are classifiers, not agent turns. Claude
    // Code runs these with its small fast model, thinking disabled and no
    // tools; loading the full agent loop here made a three-word title take as
    // long as a normal chat response.
    options.includePartialMessages = false;
    options.maxTurns = 1;
    options.tools = [];
    options.thinking = { type: "disabled" };
    if (payload.systemPrompt) {
      options.systemPrompt = payload.systemPrompt;
    }

    let text = "";
    for await (const message of query({ prompt: payload.prompt, options })) {
      const record =
        message && typeof message === "object"
          ? (message as Record<string, unknown>)
          : null;
      if (record?.type === "assistant") {
        const sdkMessage =
          record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : null;
        const content = sdkMessage?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            const block =
              part && typeof part === "object"
                ? (part as Record<string, unknown>)
                : null;
            if (block?.type === "text" && typeof block.text === "string") {
              text += block.text;
            }
          }
        }
      }
    }
    sendJson(res, 200, { text });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: HelperConfig,
): Promise<void> {
  if (!isAuthorized(req, config.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      active: activeQueryManager().isActive,
      provider: activeProvider,
      version: HELPER_VERSION,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/trace/latest") {
    if (latestAgentTrace) {
      sendJson(res, 200, latestAgentTrace);
    } else {
      sendJson(res, 204, "");
    }
    return;
  }

  if (req.method === "GET" && req.url === "/diagnostics") {
    sendJson(res, 200, diagnosticsPayload());
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50);
    return;
  }

  // Get current pending permission request
  if (req.method === "GET" && req.url === "/pending-permission") {
    const request = permissionManager.getCurrentRequest();
    if (request) {
      sendJson(res, 200, request);
    } else {
      sendJson(res, 204, ""); // No content
    }
    return;
  }

  if (req.method === "POST" && req.url === "/init") {
    await handleInit(req, res, config);
    return;
  }

  if (req.method === "POST" && req.url === "/send") {
    await handleSend(req, res, config);
    return;
  }

  if (req.method === "POST" && req.url === "/aux-query") {
    await handleAuxQuery(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/test-mcp") {
    const body = await readJsonBody<TestMcpPayload>(req);
    const result = await testMcpServer(body.config || {});
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && req.url === "/request-permission") {
    const body = await readJsonBody<RequestPermissionPayload>(req);
    const toolName = body.toolName || "Tool action";
    if (permissionManager.isRemembered(toolName)) {
      sendJson(res, 200, { allowed: true, remember: true });
      return;
    }
    const requestId = Math.random().toString(36).slice(2, 11);
    const decision = await permissionManager.request({
      id: requestId,
      toolName,
      input: body.input,
    });
    if (decision.allowed && decision.remember) {
      permissionManager.remember(toolName);
    }
    sendJson(res, 200, decision);
    return;
  }

  // Permission decision endpoint
  if (req.method === "POST" && req.url === "/permission") {
    const body = await readJsonBody<{
      requestId: string;
      allowed: boolean;
      remember?: boolean;
    }>(req);
    if (
      permissionManager.resolve(body.requestId, {
        allowed: body.allowed,
        remember: body.remember,
      })
    ) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { error: "Permission request not found or expired" });
    }
    return;
  }

  // Cancel all pending permission requests (used by stop/cancel button)
  if (req.method === "POST" && req.url === "/cancel-permission") {
    permissionManager.cancelAll();
    activeQueryManager().cancelPendingQuestion();
    activeQueryManager().cancelPendingExitPlan();
    activeQueryManager().cancelActiveTurn();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/cancel-question") {
    activeQueryManager().cancelPendingQuestion();
    activeQueryManager().cancelPendingExitPlan();
    activeQueryManager().cancelActiveTurn();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/cancel-exit-plan") {
    activeQueryManager().cancelPendingExitPlan();
    sendJson(res, 200, { ok: true });
    return;
  }

  // Get current pending AskUserQuestion request
  if (req.method === "GET" && req.url === "/pending-question") {
    const question = activeQueryManager().getPendingQuestion();
    if (question) {
      sendJson(res, 200, question);
    } else {
      sendJson(res, 204, "");
    }
    return;
  }

  if (req.method === "GET" && req.url === "/pending-exit-plan") {
    const exitPlan = activeQueryManager().getPendingExitPlan();
    if (exitPlan) {
      sendJson(res, 200, exitPlan);
    } else {
      sendJson(res, 204, "");
    }
    return;
  }

  // Answer a pending AskUserQuestion
  if (req.method === "POST" && req.url === "/answer-question") {
    const body = await readJsonBody<{
      toolUseId: string;
      answers: Record<string, string | string[]>;
      response?: string;
    }>(req);
    if (
      activeQueryManager().answerQuestion(
        body.toolUseId,
        body.answers,
        body.response,
      )
    ) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { error: "Question not found or expired" });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/answer-exit-plan") {
    const body = await readJsonBody<{
      toolUseId: string;
      decision: import("./runtime/PersistentQueryManager").ExitPlanDecision;
    }>(req);
    if (activeQueryManager().answerExitPlan(body.toolUseId, body.decision)) {
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { error: "Exit plan request not found or expired" });
    }
    return;
  }

  // Fetch supported slash commands from the active SDK session
  if (req.method === "GET" && req.url === "/commands") {
    const commands = await activeQueryManager().supportedCommands();
    sendJson(res, 200, { commands });
    return;
  }

  // Force reload skills and return the updated list (mid-session skill installs)
  if (req.method === "POST" && req.url === "/reload-skills") {
    const commands = await activeQueryManager().reloadSkills();
    sendJson(res, 200, { commands });
    return;
  }

  // Legacy /query endpoint for backward compatibility
  if (req.method === "POST" && req.url === "/query") {
    await handleQuery(req, res, config);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  if (process.argv.includes("--zotero-mcp-stdio")) {
    runZoteroMcpStdioServer(process.argv.slice(2));
    return;
  }
  if (!process.argv.includes("--server")) {
    throw new Error("Claudero helper must be started with --server");
  }
  const config = parseArgs(process.argv.slice(2));
  if (!config.token) {
    throw new Error("Missing --token");
  }

  const server = createServer((req, res) => {
    route(req, res, config).catch((error) => {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `Claudero helper listening on http://${config.host}:${config.port}`,
    );
  });
}

main();

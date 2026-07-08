import { getPref, setPref } from "../utils/prefs";
import {
  getProviderCapabilities,
  getProviderRuntimePrefs,
  normalizeProvider,
  type AiProvider,
  type CodexInstallationMethod,
  type CodexSafeMode,
} from "./providerRegistry";
import type { ConversationProviderState } from "./conversationStore";
import {
  extractMcpMentions,
  getDisabledMcpTools,
  isZoteroMcpEnabled,
  parseCustomMcpServers,
} from "./mcpSettings";
import { getZoteroEndpointBaseUrl } from "./zoteroEndpoint";
import type { AgentEventPayload } from "../shared/agentEvents";
import { CLAUDERO_HELPER_VERSION as EXPECTED_HELPER_VERSION } from "../shared/helperProtocol";

export type ClauderoQueryEvent = AgentEventPayload;

export interface ClauderoImageInput {
  media_type: string;
  data: string;
}

export interface ClauderoQueryRequest {
  prompt: string;
  workspacePath: string;
  provider?: "claude" | "codex";
  claudePath?: string;
  codexPath?: string;
  codexInstallationMethod?: CodexInstallationMethod;
  codexWslDistro?: string;
  codexSafeMode?: CodexSafeMode;
  environment?: Record<string, string>;
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  permissionMode?:
    | "auto"
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  zoteroEndpointUrl?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  images?: ClauderoImageInput[];
  conversationId?: string;
  providerState?: ConversationProviderState;
}

export interface ClauderoQueryOptions {
  provider?: "claude" | "codex";
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  signal?: AbortSignal;
  permissionMode?:
    | "auto"
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
    | "dontAsk";
  images?: ClauderoImageInput[];
  conversationId?: string;
  providerState?: ConversationProviderState;
}

let helperProcess: nsIProcess | null = null;
let persistentQueryInitialized = false;
let helperEnsurePromise: Promise<void> | null = null;

function helperLog(message: string): void {
  ztoolkit.log(`[AI Rename/helper] ${message}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? ` | ${error.stack.replace(/\s+/g, " ").slice(0, 1200)}` : ""}`;
  }
  return String(error);
}

function generateStableToken(): string {
  const data = getProfilePath() + "claudero-salt-v1";
  let h1 = 5381;
  let h2 = 5381;
  for (let i = 0; i < data.length; i++) {
    h1 = ((h1 << 5) + h1 + data.charCodeAt(i)) | 0;
    h2 = ((h2 << 3) ^ (h2 + data.charCodeAt(i) * 17)) | 0;
  }
  const a = Math.abs(h1).toString(16).padStart(8, "0");
  const b = Math.abs(h2).toString(16).padStart(8, "0");
  return (a + b + a + b).slice(0, 32);
}

async function getOrCreateHelperToken(): Promise<string> {
  const tokenPath = PathUtils.join(
    getProfilePath(),
    "claudero",
    "helper",
    ".token",
  );
  try {
    return (await IOUtils.readUTF8(tokenPath)).trim();
  } catch {
    const token = generateStableToken();
    await IOUtils.makeDirectory(
      PathUtils.join(getProfilePath(), "claudero", "helper"),
      { createAncestors: true },
    );
    await IOUtils.writeUTF8(tokenPath, token);
    return token;
  }
}

function parseEnvironmentVariables(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    const value = normalized
      .slice(equals + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) env[key] = value;
  }
  return env;
}

function getClauderoEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};

  // Direct connections to the Anthropic API are geo-blocked in some regions
  // (the CLI returns "403 Request not allowed"). The proxy preference routes
  // the Claude Code subprocess through a local/HTTP proxy. localhost is always
  // excluded so the helper's own loopback traffic is never proxied.
  const proxy = String(getPref("proxy") || "").trim();
  if (proxy) {
    env.HTTPS_PROXY = proxy;
    env.HTTP_PROXY = proxy;
    env.NO_PROXY = "localhost,127.0.0.1";
    // Proxy SSL interception — Node.js doesn't trust proxy CA certs by default.
    // User can override (set to "1") via environmentVariables preference.
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  // User-supplied variables (e.g. ANTHROPIC_API_KEY, a custom NO_PROXY)
  // override the proxy defaults above.
  return {
    ...env,
    ...parseEnvironmentVariables(String(getPref("environmentVariables") || "")),
  };
}

function getProviderEnvironment(provider: AiProvider): Record<string, string> {
  const runtime = getProviderRuntimePrefs(provider);
  return {
    ...getClauderoEnvironment(),
    ...parseEnvironmentVariables(runtime.environmentVariables),
  };
}

function normalizeProviderPref(): "claude" | "codex" {
  return normalizeProvider(getPref("provider"));
}

function buildProviderPayload(provider: AiProvider) {
  const runtime = getProviderRuntimePrefs(provider);
  return {
    provider,
    claudePath: provider === "claude" ? runtime.cliPath : undefined,
    codexPath: provider === "codex" ? runtime.cliPath : undefined,
    codexInstallationMethod: runtime.codexInstallationMethod,
    codexWslDistro: runtime.codexWslDistro,
    codexSafeMode: runtime.codexSafeMode,
    environment: getProviderEnvironment(provider),
  };
}

function buildMcpPayload(provider: AiProvider, prompt = "") {
  if (!getProviderCapabilities(provider).supportsMcpTools) {
    return {
      enableZoteroMcp: false,
      zoteroEndpointUrl: undefined,
      mcpServers: {},
      mcpDisabledTools: [],
    };
  }
  let mcpServers: Record<string, unknown> = {};
  let mcpDisabledTools: string[] = [];
  try {
    const raw = String(getPref("mcpServers") || "");
    const mentions = extractMcpMentions(prompt);
    mcpServers = parseCustomMcpServers(raw, mentions);
    mcpDisabledTools = getDisabledMcpTools(raw, mentions);
  } catch (error) {
    ztoolkit.log("[Claudero] Ignoring invalid MCP server config:", error);
  }
  return {
    enableZoteroMcp: isZoteroMcpEnabled(),
    zoteroEndpointUrl: isZoteroMcpEnabled()
      ? getZoteroEndpointBaseUrl()
      : undefined,
    mcpServers,
    mcpDisabledTools,
  };
}

function fileExists(path: string): boolean {
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile) as nsIFile;
    file.initWithPath(path);
    return file.exists() && file.isFile();
  } catch {
    return false;
  }
}

function getProfilePath(): string {
  const profile = Zotero as typeof Zotero & {
    Profile?: { dir?: string | nsIFile };
  };
  const dir = profile.Profile?.dir;
  if (typeof dir === "string") return dir;
  if (dir && typeof dir === "object" && "path" in dir) {
    return dir;
  }
  return Zotero.Profile.dir;
}

function resolveClaudePath(): string {
  const configured = getProviderRuntimePrefs("claude").cliPath || "";
  if (configured && fileExists(configured)) {
    return configured;
  }

  const profilePath = getProfilePath();
  const home =
    profilePath.split("/Library/Application Support/")[0] ||
    profilePath.split("/.zotero/")[0] ||
    "";
  const candidates =
    Zotero.isMac || Zotero.isLinux
      ? [
          `${home}/.claude/local/claude`,
          `${home}/.npm-global/bin/claude`,
          `${home}/.local/bin/claude`,
          `${home}/.bun/bin/claude`,
          `${home}/.docker/bin/claude`,
          `${home}/.volta/bin/claude`,
          `${home}/.asdf/shims/claude`,
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          "/usr/bin/claude",
        ]
      : [
          `${home}\\AppData\\Local\\Claude\\claude.exe`,
          "C:\\Program Files\\Claude\\claude.exe",
          "C:\\Program Files\\nodejs\\claude.exe",
        ];

  const found = candidates.find(fileExists);
  if (!found) {
    throw new Error(
      "Claude Code CLI not found. Set Claudero's Claude Code CLI path in the plugin preferences.",
    );
  }
  return found;
}

function resolveCodexPath(): string {
  const configured = getProviderRuntimePrefs("codex").cliPath || "";
  if (configured && fileExists(configured)) {
    return configured;
  }

  const profilePath = getProfilePath();
  const home =
    profilePath.split("/Library/Application Support/")[0] ||
    profilePath.split("/.zotero/")[0] ||
    "";
  const candidates =
    Zotero.isMac || Zotero.isLinux
      ? [
          `${home}/.npm-global/bin/codex`,
          `${home}/.local/bin/codex`,
          `${home}/.bun/bin/codex`,
          `${home}/.docker/bin/codex`,
          `${home}/.volta/bin/codex`,
          `${home}/.asdf/shims/codex`,
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
          "/usr/bin/codex",
        ]
      : [
          `${home}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`,
          "C:\\Program Files\\OpenAI\\Codex\\codex.exe",
        ];

  const found = candidates.find(fileExists);
  if (!found) {
    throw new Error(
      "Codex CLI not found. Set Claudero's Codex CLI path in the plugin preferences.",
    );
  }
  return found;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveNodePath(): string {
  const configured = String(getPref("nodePath") || "").trim();
  if (configured && fileExists(configured)) {
    return configured;
  }

  const candidates =
    Zotero.isMac || Zotero.isLinux
      ? [
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
          "/usr/bin/node",
          "/bin/node",
        ]
      : [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Program Files (x86)\\nodejs\\node.exe",
        ];

  const found = candidates.find(fileExists);
  if (!found) {
    throw new Error(
      "Node.js not found. Set Claudero's Node path in the plugin preferences.",
    );
  }
  return found;
}

async function readChromeText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to read helper bundle: ${response.status}`);
  }
  return response.text();
}

async function ensureHelperFile(): Promise<string> {
  const helperURL = `${rootURI}content/helper/claudero-helper.mjs`;
  const helperSource = await readChromeText(helperURL);
  const helperDir = PathUtils.join(getProfilePath(), "claudero", "helper");
  await IOUtils.makeDirectory(helperDir, { createAncestors: true });

  const helperPath = PathUtils.join(helperDir, "claudero-helper.mjs");
  await IOUtils.writeUTF8(helperPath, helperSource);
  return helperPath;
}

function getWorkspacePath(): string {
  const configured = String(getPref("workspacePath") || "").trim();
  if (configured) return configured;
  return PathUtils.join(getProfilePath(), "claudero", "workspace");
}

async function waitForHelper(
  port: number,
  token: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        helperLog(
          `helper ready port=${port} elapsedMs=${Date.now() - startedAt}`,
        );
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await Zotero.Promise.delay(300);
  }
  throw new Error(
    `Claudero helper did not start on port ${port}: ${
      lastError instanceof Error ? lastError.message : "timeout"
    }`,
  );
}

async function probePort(
  port: number,
  token: string,
): Promise<"reuse" | "occupied" | "free"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return "reuse";
    return "occupied";
  } catch {
    return "free";
  }
}

async function startHelperOnPort(port: number, token: string): Promise<void> {
  // Kill any helper process tracked in the current session before starting a new one.
  shutdownClaudeHelper();
  await Zotero.Promise.delay(300);

  const nodePath = resolveNodePath();
  const helperPath = await ensureHelperFile();
  helperLog(
    `starting helper port=${port} node=${nodePath} bundle=${helperPath}`,
  );
  await IOUtils.makeDirectory(getWorkspacePath(), { createAncestors: true });

  const nodeFile = (Components.classes as any)[
    "@mozilla.org/file/local;1"
  ].createInstance(Components.interfaces.nsIFile) as nsIFile;
  nodeFile.initWithPath(nodePath);

  const processInstance = (Components.classes as any)[
    "@mozilla.org/process/util;1"
  ].createInstance(Components.interfaces.nsIProcess) as nsIProcess;
  processInstance.init(nodeFile);

  const args = [
    helperPath,
    "--server",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--token",
    token,
  ];
  processInstance.runwAsync(args, args.length);
  helperProcess = processInstance;
  await waitForHelper(port, token, 15000);
  persistentQueryInitialized = false;
}

async function ensureClaudeHelperImpl(): Promise<void> {
  const preferredPort = Number(getPref("helperPort") || 38660);
  const startedAt = Date.now();
  helperLog(`ensure start preferredPort=${preferredPort}`);
  const token = await getOrCreateHelperToken();
  const candidates = [
    preferredPort,
    ...Array.from({ length: 40 }, (_, index) => 38660 + index),
  ].filter((port, index, ports) => ports.indexOf(port) === index);
  const freePorts: number[] = [];

  // First scan the complete stable range for a live helper. Starting on the
  // first free port before completing the scan leaves older helpers behind
  // and makes the saved port drift upward after every reload.
  for (const p of candidates) {
    const status = await probePort(p, token);
    if (status === "free") {
      freePorts.push(p);
      continue;
    }

    if (status === "reuse") {
      helperLog(`found helper candidate port=${p}`);
      const healthResponse = await fetch(`http://127.0.0.1:${p}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (healthResponse.ok) {
        const healthData = (await healthResponse.json()) as unknown;
        const version =
          healthData &&
          typeof healthData === "object" &&
          "version" in healthData
            ? Number((healthData as { version?: number }).version)
            : 0;
        // A helper process from an older plugin version may still be running
        // (plugin reload overwrites the .mjs but doesn't kill the process).
        // Ask it to exit, then start a fresh one with the current protocol.
        if (version !== EXPECTED_HELPER_VERSION) {
          helperLog(
            `stale helper port=${p} version=${version} expected=${EXPECTED_HELPER_VERSION}; restarting`,
          );
          try {
            await fetch(`http://127.0.0.1:${p}/shutdown`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch {
            // Old helpers without /shutdown will 404; the port simply won't
            // free below and we'll move on to start a fresh one elsewhere.
          }
          // Wait for the old process to actually exit (its port frees). Don't
          // reconnect to it — only start fresh once the port is genuinely free.
          let freed = false;
          for (let i = 0; i < 12; i++) {
            await Zotero.Promise.delay(250);
            if ((await probePort(p, token)) === "free") {
              freed = true;
              break;
            }
          }
          if (freed) {
            try {
              await startHelperOnPort(p, token);
              if (p !== preferredPort) setPref("helperPort", p);
              return;
            } catch (error) {
              helperLog(`restart failed port=${p}: ${errorMessage(error)}`);
              // Lost the bind race; fall through to scan the next port.
            }
          }
          continue; // Stale helper still holding this port; try the next one.
        }
        if (
          healthData &&
          typeof healthData === "object" &&
          "active" in healthData
        ) {
          persistentQueryInitialized =
            (healthData as { active?: boolean }).active === true;
        }
      }
      if (p !== preferredPort) {
        setPref("helperPort", p);
      }
      helperLog(
        `reusing helper port=${p} version=${EXPECTED_HELPER_VERSION} elapsedMs=${Date.now() - startedAt}`,
      );
      return;
    }

    // "occupied" → skip
  }

  for (const p of freePorts) {
    try {
      await startHelperOnPort(p, token);
      if (p !== preferredPort) setPref("helperPort", p);
      return;
    } catch (error) {
      helperLog(`start failed port=${p}: ${errorMessage(error)}`);
      // Race: port may have been taken between probe and bind. Try the next.
    }
  }

  throw new Error(
    "Claudero helper could not start. No available port in range 38660-38699.",
  );
}

export function ensureClaudeHelper(): Promise<void> {
  if (!helperEnsurePromise) {
    helperEnsurePromise = ensureClaudeHelperImpl().finally(() => {
      helperEnsurePromise = null;
    });
  } else {
    helperLog("joining in-flight ensure operation");
  }
  return helperEnsurePromise;
}

async function initializePersistentQuery(): Promise<void> {
  if (persistentQueryInitialized) return;

  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  const provider = normalizeProviderPref();

  const response = await fetch(`http://127.0.0.1:${port}/init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspacePath: getWorkspacePath(),
      ...buildProviderPayload(provider),
      model: String(getPref("model") || "haiku") || undefined,
      effort: String(getPref("effort") || "high") || undefined,
      ...buildMcpPayload(provider),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to initialize persistent query: ${error}`);
  }

  persistentQueryInitialized = true;
}

export async function* queryClaudeHelper(
  prompt: string,
  options: ClauderoQueryOptions = {},
): AsyncGenerator<ClauderoQueryEvent> {
  await ensureClaudeHelper();

  // Try to use persistent query (new fast path)
  if (!persistentQueryInitialized) {
    try {
      await initializePersistentQuery();
    } catch (error) {
      // Fall back to legacy /query endpoint if initialization fails
      ztoolkit.log(
        "Failed to initialize persistent query, falling back to legacy endpoint:",
        error,
      );
    }
  }

  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  const provider = options.provider || normalizeProviderPref();
  const providerCapabilities = getProviderCapabilities(provider);
  const images = providerCapabilities.supportsImageAttachments
    ? options.images
    : undefined;

  let response: Response;

  if (persistentQueryInitialized) {
    // Use new /send endpoint (fast path with persistent query)
    try {
      response = await fetch(`http://127.0.0.1:${port}/send`, {
        method: "POST",
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          ...buildProviderPayload(provider),
          // Always send the current claudePath/environment so the helper can
          // detect changes (e.g. a newly configured proxy) and restart the
          // persistent query instead of reusing a stale, geo-blocked session.
          model: options.model,
          effort: options.effort,
          additionalDirectories: options.additionalDirectories,
          permissionMode: options.permissionMode,
          ...buildMcpPayload(provider, prompt),
          images,
          conversationId: options.conversationId,
          providerState: options.providerState,
        }),
      });

      // If /send succeeds, use it
      if (response.ok) {
        // Stream events from /send endpoint
        yield* streamResponseEvents(response);
        return;
      }

      // Fall back to legacy /query
      ztoolkit.log(
        "Failed to use /send endpoint, falling back to legacy /query",
      );
    } catch (error) {
      ztoolkit.log(
        "Failed to use /send endpoint, falling back to legacy /query:",
        error,
      );
    }
  }

  // Use legacy /query endpoint (slow but compatible)
  response = await fetch(`http://127.0.0.1:${port}/query`, {
    method: "POST",
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      workspacePath: getWorkspacePath(),
      ...buildProviderPayload(provider),
      model: options.model,
      effort: options.effort,
      additionalDirectories: options.additionalDirectories,
      permissionMode: options.permissionMode,
      ...buildMcpPayload(provider, prompt),
      images,
      conversationId: options.conversationId,
      providerState: options.providerState,
    } satisfies ClauderoQueryRequest),
  });

  yield* streamResponseEvents(response);
}

export async function runAuxClaudeQuery(
  prompt: string,
  options: {
    systemPrompt?: string;
    model?: string;
    effort?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const requestId = `aux-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  helperLog(
    `${requestId} begin model=${options.model || "pref"} effort=${options.effort || "pref"} promptChars=${prompt.length}`,
  );
  await ensureClaudeHelper();
  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  helperLog(`${requestId} POST http://127.0.0.1:${port}/aux-query`);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/aux-query`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        systemPrompt: options.systemPrompt,
        workspacePath: getWorkspacePath(),
        ...buildProviderPayload(normalizeProviderPref()),
        model:
          options.model || String(getPref("model") || "haiku") || undefined,
        effort:
          options.effort || String(getPref("effort") || "high") || undefined,
      }),
    });
    const body = await response.text();
    helperLog(
      `${requestId} response status=${response.status} elapsedMs=${Date.now() - startedAt} bodyChars=${body.length}`,
    );
    let data: { text?: string; error?: string };
    try {
      data = JSON.parse(body) as { text?: string; error?: string };
    } catch (error) {
      throw new Error(
        `Aux query returned invalid JSON (${response.status}): ${body.slice(0, 500)}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(data.error || `Aux query failed: ${response.status}`);
    }
    helperLog(`${requestId} success textChars=${data.text?.length || 0}`);
    return data.text || "";
  } catch (error) {
    helperLog(
      `${requestId} failed elapsedMs=${Date.now() - startedAt}: ${errorMessage(error)}`,
    );
    throw error;
  }
}

async function* streamResponseEvents(
  response: Response,
): AsyncGenerator<ClauderoQueryEvent> {
  if (!response.ok) {
    throw new Error(`Claudero helper query failed: ${response.status}`);
  }

  if (!response.body) {
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as ClauderoQueryEvent;
    }
    return;
  }

  const reader = response.body.getReader() as any;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        yield JSON.parse(line) as ClauderoQueryEvent;
      }
      newline = buffer.indexOf("\n");
    }
  }

  // Flush any final multi-byte UTF-8 sequence retained by the streaming
  // decoder. Without this, a response ending on a Chinese character can lose
  // its last bytes even though the HTTP stream completed normally.
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) {
    yield JSON.parse(tail) as ClauderoQueryEvent;
  }
}

export async function fetchSlashCommands(): Promise<
  Array<{ name: string; description: string; argumentHint?: string }>
> {
  try {
    // Ensure helper process is running and session is initialized
    await ensureClaudeHelper();
    if (!persistentQueryInitialized) {
      await initializePersistentQuery();
    }
    const port = Number(getPref("helperPort") || 38660);
    const token = await getOrCreateHelperToken();
    const response = await fetch(`http://127.0.0.1:${port}/commands`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      commands?: Array<{
        name: string;
        description: string;
        argumentHint?: string;
      }>;
    };
    return Array.isArray(data.commands) ? data.commands : [];
  } catch {
    return [];
  }
}

export async function reloadSlashCommands(): Promise<
  Array<{ name: string; description: string; argumentHint?: string }>
> {
  try {
    await ensureClaudeHelper();
    if (!persistentQueryInitialized) {
      await initializePersistentQuery();
    }
    const port = Number(getPref("helperPort") || 38660);
    const token = await getOrCreateHelperToken();
    const response = await fetch(`http://127.0.0.1:${port}/reload-skills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      commands?: Array<{
        name: string;
        description: string;
        argumentHint?: string;
      }>;
    };
    return Array.isArray(data.commands) ? data.commands : [];
  } catch {
    return [];
  }
}

export function isClaudeAuthError(message: string | undefined): boolean {
  if (!message) return false;
  return /failed to authenticate|not authenticated|login|request not allowed|api error:\s*403|auth/i.test(
    message,
  );
}

export function isClaudeLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return /session limit|rate limit|quota|resets\s+/i.test(message);
}

async function runCliLogin(
  cliPath: string,
  args: string[],
  label: string,
): Promise<void> {
  if (Zotero.isMac) {
    const scriptDir = PathUtils.join(getProfilePath(), "claudero");
    await IOUtils.makeDirectory(scriptDir, { createAncestors: true });
    const scriptPath = PathUtils.join(scriptDir, `${label}-auth.command`);
    const env = getClauderoEnvironment();
    const envLines = Object.entries(env).map(
      ([key, value]) => `export ${key}=${shellQuote(value)}`,
    );

    await IOUtils.writeUTF8(
      scriptPath,
      [
        "#!/bin/zsh",
        "set -e",
        ...envLines,
        `${shellQuote(cliPath)} ${args.map(shellQuote).join(" ")}`,
        "echo",
        `echo '${label} auth finished. You can close this window.'`,
        "read -k 1 '?Press any key to close...'",
        "",
      ].join("\n"),
    );
    await Zotero.Utilities.Internal.exec("/bin/chmod", ["+x", scriptPath]);
    await Zotero.Utilities.Internal.exec("/usr/bin/open", [scriptPath]);
    return;
  }

  await Zotero.Utilities.Internal.exec(cliPath, args);
}

export async function runClaudeAuthLogin(): Promise<void> {
  await runCliLogin(resolveClaudePath(), ["auth", "login"], "claude");
}

export async function runProviderAuthLogin(): Promise<void> {
  if (normalizeProviderPref() === "codex") {
    await runCliLogin(resolveCodexPath(), ["login"], "codex");
    return;
  }
  await runClaudeAuthLogin();
}

export function shutdownClaudeHelper(): void {
  try {
    helperProcess?.kill();
  } catch {
    // Best effort.
  }
  helperProcess = null;
  persistentQueryInitialized = false;
}

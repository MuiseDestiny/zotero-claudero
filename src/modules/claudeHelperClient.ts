import { getPref, setPref } from "../utils/prefs";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getProviderCapabilities,
  getProviderRuntimePrefs,
  normalizeProvider,
  setProviderCliPath,
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
import { logDiagnostic } from "./diagnosticLog";
import { getZoteroEndpointBaseUrl } from "./zoteroEndpoint";
import type { AgentEventPayload } from "../shared/agentEvents";
import { streamResponseEvents, throwIfAborted } from "../shared/helperStream";
import { waitWithSignal, withRequestDeadline } from "../shared/requestDeadline";
import { CLAUDERO_HELPER_VERSION as EXPECTED_HELPER_VERSION } from "../shared/helperProtocol";
import type { ProviderModelDescriptor } from "../shared/providerModels";
import type { AcademicToolPolicy } from "../shared/academicToolPolicy";
import { windowsClaudeCandidates } from "../shared/windowsExecutablePaths";
import { getOrCreateHelperToken } from "./helperToken";
import { autoDetectSettings } from "./settingsAutoDetect";
import {
  buildRuntimeEnvironment,
  parseEnvironmentVariables,
} from "../shared/runtimeEnvironment";

export type ClauderoQueryEvent = AgentEventPayload;

export interface ClauderoImageInput {
  media_type: string;
  data: string;
}

export interface ClauderoQueryRequest {
  requestId: string;
  prompt: string;
  workspacePath: string;
  provider?: AiProvider;
  claudePath?: string;
  codexPath?: string;
  deepseekPath?: string;
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
  toolPolicy?: AcademicToolPolicy;
}

export interface ClauderoQueryOptions {
  requestId?: string;
  provider?: AiProvider;
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
  toolPolicy?: AcademicToolPolicy;
}

let helperProcess: nsIProcess | null = null;
let helperConnection: { port: number; token: string } | undefined;
let helperShutdown: Promise<void> | undefined;
let persistentQueryInitialized = false;
let helperEnsurePromise: Promise<void> | null = null;
// A module instance belongs to one plugin lifetime; reload creates a new one.
let helperLifetime: AbortController | undefined;

function getHelperSignal(): AbortSignal {
  // Browser globals are installed after module evaluation by src/index.ts.
  return (helperLifetime ||= new AbortController()).signal;
}

function helperLog(message: string): void {
  ztoolkit.log(`[AI Rename/helper] ${message}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? ` | ${error.stack.replace(/\s+/g, " ").slice(0, 1200)}` : ""}`;
  }
  return String(error);
}

async function getClauderoEnvironment(): Promise<Record<string, string>> {
  return buildRuntimeEnvironment(
    String(getPref("proxy") || ""),
    String(getPref("environmentVariables") || ""),
    "",
    (name) => Services.env.get(name),
  );
}

async function getProviderEnvironment(
  provider: AiProvider,
): Promise<Record<string, string>> {
  const runtime = getProviderRuntimePrefs(provider);
  const base = await getClauderoEnvironment();
  return {
    ...base,
    ...parseEnvironmentVariables(runtime.environmentVariables, base, (name) =>
      Services.env.get(name),
    ),
  };
}

function normalizeProviderPref(): AiProvider {
  return normalizeProvider(getPref("provider"));
}

async function buildProviderPayload(provider: AiProvider) {
  const runtime = getProviderRuntimePrefs(provider);
  return {
    provider,
    claudePath: provider === "claude" ? runtime.cliPath : undefined,
    codexPath: provider === "codex" ? runtime.cliPath : undefined,
    deepseekPath: provider === "deepseek" ? runtime.cliPath : undefined,
    codexInstallationMethod: runtime.codexInstallationMethod,
    codexWslDistro: runtime.codexWslDistro,
    codexSafeMode: runtime.codexSafeMode,
    environment: await getProviderEnvironment(provider),
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
    return (dir as nsIFile).path;
  }
  return Zotero.Profile.dir;
}

function getHomePath(): string {
  const fromEnv =
    Services.env.get("HOME") || Services.env.get("USERPROFILE") || "";
  if (fromEnv && (fromEnv.startsWith("/") || /^[A-Z]:\\/i.test(fromEnv))) {
    return fromEnv;
  }

  const profilePath = getProfilePath();
  return (
    profilePath.split(
      /\/Library\/Application Support\/|\/\.zotero\/|\\AppData\\/,
    )[0] || ""
  );
}

function resolveClaudePath(): string {
  const configured = getProviderRuntimePrefs("claude").cliPath || "";
  if (
    configured &&
    fileExists(configured) &&
    (!Zotero.isWin || !/\.(?:cmd|bat)$/i.test(configured))
  ) {
    return configured;
  }

  const home = getHomePath();
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
      : windowsClaudeCandidates(
          home,
          {
            appData: Services.env.get("APPDATA"),
            localAppData: Services.env.get("LOCALAPPDATA"),
            programFiles: Services.env.get("ProgramFiles"),
            programFilesX86: Services.env.get("ProgramFiles(x86)"),
          },
          [
            ...(configured ? [configured.replace(/[\\/][^\\/]+$/, "")] : []),
            ...Services.env.get("PATH").split(";").filter(Boolean),
          ],
        );

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

  const home = getHomePath();
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

  const pathEntries = Services.env
    .get("PATH")
    .split(Zotero.isWin ? ";" : ":")
    .filter(Boolean);
  const executableName = Zotero.isWin ? "node.exe" : "node";
  const candidates =
    Zotero.isMac || Zotero.isLinux
      ? [
          ...pathEntries.map((entry) => PathUtils.join(entry, executableName)),
          `${getHomePath()}/.volta/bin/node`,
          `${getHomePath()}/.asdf/shims/node`,
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
          "/usr/bin/node",
          "/bin/node",
        ]
      : [
          ...pathEntries.map((entry) => PathUtils.join(entry, executableName)),
          PathUtils.join(Services.env.get("NVM_SYMLINK"), "node.exe"),
          PathUtils.join(
            Services.env.get("ProgramFiles") || "C:\\Program Files",
            "nodejs",
            "node.exe",
          ),
          PathUtils.join(
            Services.env.get("ProgramFiles(x86)") || "C:\\Program Files (x86)",
            "nodejs",
            "node.exe",
          ),
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

async function fetchLoopbackHealth(
  port: number,
  token: string,
  timeoutMs = 1200,
): Promise<{ ok: boolean; version: number; active: boolean }> {
  return withRequestDeadline(
    async (signal) => {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, version: 0, active: false };
      }
      const data: unknown = await response.json();
      return {
        ok: true,
        version:
          data && typeof data === "object" && "version" in data
            ? Number(data.version)
            : 0,
        active:
          !!data &&
          typeof data === "object" &&
          "active" in data &&
          data.active === true,
      };
    },
    getHelperSignal(),
    timeoutMs,
  );
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
    throwIfAborted(getHelperSignal());
    try {
      const response = await fetchLoopbackHealth(port, token);
      if (response.ok) {
        helperLog(
          `helper ready port=${port} elapsedMs=${Date.now() - startedAt}`,
        );
        return;
      }
    } catch (error) {
      throwIfAborted(getHelperSignal());
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
    const response = await fetchLoopbackHealth(port, token);
    if (response.ok) return "reuse";
    return "occupied";
  } catch {
    throwIfAborted(getHelperSignal());
    return "free";
  }
}

async function startHelperOnPort(port: number, token: string): Promise<void> {
  throwIfAborted(getHelperSignal());
  // Kill any helper process tracked in the current session before starting a new one.
  const hadProcess = !!helperProcess;
  stopHelperProcess();
  if (hadProcess) await Zotero.Promise.delay(300);
  throwIfAborted(getHelperSignal());

  const nodePath = resolveNodePath();
  const helperPath = await ensureHelperFile();
  throwIfAborted(getHelperSignal());
  helperLog(
    `starting helper port=${port} node=${nodePath} bundle=${helperPath}`,
  );
  await IOUtils.makeDirectory(getWorkspacePath(), { createAncestors: true });
  throwIfAborted(getHelperSignal());

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
  const parentPid = Services.appinfo?.processID;
  if (Number.isSafeInteger(parentPid) && parentPid > 1)
    args.push("--parent-pid", String(parentPid));
  processInstance.runwAsync(args, args.length);
  helperProcess = processInstance;
  try {
    await waitForHelper(port, token, 15000);
    throwIfAborted(getHelperSignal());
  } catch (error) {
    if (helperProcess === processInstance) stopHelperProcess();
    throw error;
  }
  helperConnection = { port, token };
  persistentQueryInitialized = false;
}

async function ensureClaudeHelperImpl(): Promise<void> {
  throwIfAborted(getHelperSignal());
  // GUI-launched Zotero processes often inherit a reduced PATH. Run the same
  // cross-platform discovery used by Preferences before resolving Node so
  // NVM/Volta/custom Windows installations work without opening Preferences.
  try {
    await autoDetectSettings();
  } catch (error) {
    helperLog(`auto-detect failed: ${errorMessage(error)}`);
  }
  throwIfAborted(getHelperSignal());
  const preferredPort = Number(getPref("helperPort") || 38660);
  const startedAt = Date.now();
  helperLog(`ensure start preferredPort=${preferredPort}`);
  const token = await getOrCreateHelperToken();
  throwIfAborted(getHelperSignal());
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
      const healthResponse = await fetchLoopbackHealth(p, token);
      if (!healthResponse.ok) continue;
      if (healthResponse.ok) {
        const version = healthResponse.version;
        // A helper process from an older plugin version may still be running
        // (plugin reload overwrites the .mjs but doesn't kill the process).
        // Ask it to exit, then start a fresh one with the current protocol.
        if (version !== EXPECTED_HELPER_VERSION) {
          helperLog(
            `stale helper port=${p} version=${version} expected=${EXPECTED_HELPER_VERSION}; restarting`,
          );
          try {
            await withRequestDeadline(
              async (signal) => {
                const response = await fetch(`http://127.0.0.1:${p}/shutdown`, {
                  method: "POST",
                  headers: { Authorization: `Bearer ${token}` },
                  signal,
                });
                await response.body?.cancel();
              },
              getHelperSignal(),
              1200,
            );
          } catch {
            throwIfAborted(getHelperSignal());
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
              throwIfAborted(getHelperSignal());
              helperLog(`restart failed port=${p}: ${errorMessage(error)}`);
              // Lost the bind race; fall through to scan the next port.
            }
          }
          continue; // Stale helper still holding this port; try the next one.
        }
        persistentQueryInitialized = healthResponse.active;
      }
      throwIfAborted(getHelperSignal());
      if (p !== preferredPort) {
        setPref("helperPort", p);
      }
      helperConnection = { port: p, token };
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
      throwIfAborted(getHelperSignal());
      helperLog(`start failed port=${p}: ${errorMessage(error)}`);
      // Race: port may have been taken between probe and bind. Try the next.
    }
  }

  throw new Error(
    "Claudero helper could not start. No available port in range 38660-38699.",
  );
}

export function ensureClaudeHelper(): Promise<void> {
  if (getHelperSignal().aborted) {
    return Promise.reject(new DOMException("Plugin shut down", "AbortError"));
  }
  if (!helperEnsurePromise) {
    helperEnsurePromise = waitWithSignal(
      ensureClaudeHelperImpl(),
      getHelperSignal(),
    ).finally(() => {
      helperEnsurePromise = null;
    });
  } else {
    helperLog("joining in-flight ensure operation");
  }
  return helperEnsurePromise;
}

export async function prewarmClaudeHelper(): Promise<void> {
  try {
    await ensureClaudeHelper();
    await initializePersistentQuery();
  } catch (error) {
    helperLog(`prewarm failed: ${errorMessage(error)}`);
  }
}

/** Settings requests must resolve the port and token after helper startup. */
export async function requestHelperJson<T>(
  endpoint: string,
  init: RequestInit = {},
): Promise<T> {
  if (!/^\/[a-z-]+(?:\?[^#]*)?$/.test(endpoint))
    throw new Error("Invalid helper endpoint");
  return withRequestDeadline(async (signal) => {
    await waitWithSignal(ensureClaudeHelper(), signal);
    const port = Number(getPref("helperPort") || 38660);
    const token = await waitWithSignal(getOrCreateHelperToken(), signal);
    throwIfAborted(signal);
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      ...init,
      headers,
      signal,
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`Helper returned ${response.status}: ${text}`);
    return (response.status === 204 ? null : JSON.parse(text)) as T;
  }, init.signal);
}

export async function fetchProviderModels(
  provider: AiProvider,
  signal?: AbortSignal,
): Promise<ProviderModelDescriptor[]> {
  if (provider === "claude") return [];
  const data = await withRequestDeadline(async (requestSignal) => {
    await waitWithSignal(ensureClaudeHelper(), requestSignal);
    const port = Number(getPref("helperPort") || 38660);
    const token = await waitWithSignal(getOrCreateHelperToken(), requestSignal);
    const payload = await waitWithSignal(
      buildProviderPayload(provider),
      requestSignal,
    );
    throwIfAborted(requestSignal);
    const response = await fetch(`http://127.0.0.1:${port}/models`, {
      method: "POST",
      signal: requestSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspacePath: getWorkspacePath(),
        ...payload,
        model: defaultModelForProvider(provider),
        effort: defaultEffortForProvider(provider),
        ...buildMcpPayload(provider),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to load ${provider} models: ${response.status} ${await response.text()}`,
      );
    }
    return response.json() as Promise<{ models?: unknown }>;
  }, signal);
  const models = Array.isArray(data.models)
    ? (data.models as ProviderModelDescriptor[]).filter(
        (model) => !!model?.value && !!model?.label,
      )
    : [];
  if (models.length > 0) persistentQueryInitialized = true;
  return models;
}

export interface DeepSeekInstallResult {
  cliPath: string;
  installRoot: string;
  nodePath: string;
  version?: string;
}

export function isDeepSeekCliMissingError(
  message: string | undefined,
): boolean {
  return (
    !!message &&
    /DeepSeek Harness CLI not found|dsh(?:\.cmd)? .*not found/i.test(message)
  );
}

export async function installDeepSeekHarness(): Promise<DeepSeekInstallResult> {
  await ensureClaudeHelper();
  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  const response = await fetch(`http://127.0.0.1:${port}/install-deepseek`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const body = await response.text();
  if (!response.ok) {
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      message = parsed.error || body;
    } catch {
      // Preserve the raw helper response when it is not JSON.
    }
    throw new Error(
      message || `DeepSeek installation failed: ${response.status}`,
    );
  }
  const result = JSON.parse(body) as DeepSeekInstallResult;
  if (!result.cliPath || !result.installRoot || !result.nodePath) {
    throw new Error("DeepSeek Harness installation returned no CLI path.");
  }
  setProviderCliPath("deepseek", result.cliPath);
  persistentQueryInitialized = false;
  logDiagnostic("deepseek.install.complete", {
    cliPath: result.cliPath,
    installRoot: result.installRoot,
    nodePath: result.nodePath,
    version: result.version,
  });
  return result;
}

async function initializePersistentQuery(
  provider: AiProvider = normalizeProviderPref(),
): Promise<void> {
  if (persistentQueryInitialized) return;

  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  const startedAt = Date.now();
  logDiagnostic("helper.init.start", {
    provider,
    port,
    model: defaultModelForProvider(provider),
    effort: defaultEffortForProvider(provider),
    workspacePath: getWorkspacePath(),
    enableZoteroMcp: isZoteroMcpEnabled(),
  });

  const response = await fetch(`http://127.0.0.1:${port}/init`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      workspacePath: getWorkspacePath(),
      ...(await buildProviderPayload(provider)),
      model: defaultModelForProvider(provider),
      effort: defaultEffortForProvider(provider),
      ...buildMcpPayload(provider),
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    logDiagnostic(
      "helper.init.error",
      {
        provider,
        port,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        body: error.slice(0, 800),
      },
      "error",
    );
    throw new Error(`Failed to initialize persistent query: ${error}`);
  }

  persistentQueryInitialized = true;
  logDiagnostic("helper.init.done", {
    provider,
    port,
    elapsedMs: Date.now() - startedAt,
  });
}

export async function* queryClaudeHelper(
  prompt: string,
  options: ClauderoQueryOptions = {},
): AsyncGenerator<ClauderoQueryEvent> {
  const requestId = options.requestId || crypto.randomUUID();
  const provider = options.provider || normalizeProviderPref();
  throwIfAborted(options.signal);
  await waitWithSignal(ensureClaudeHelper(), options.signal);
  throwIfAborted(options.signal);
  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  const payload: ClauderoQueryRequest = {
    requestId,
    prompt,
    workspacePath: getWorkspacePath(),
    ...(await buildProviderPayload(provider)),
    model: options.model ?? defaultModelForProvider(provider),
    effort: options.effort ?? defaultEffortForProvider(provider),
    additionalDirectories: options.additionalDirectories || [],
    permissionMode: options.permissionMode || "auto",
    ...buildMcpPayload(provider, prompt),
    images: getProviderCapabilities(provider).supportsImageAttachments
      ? options.images
      : undefined,
    conversationId: options.conversationId,
    providerState: options.providerState,
    toolPolicy: options.toolPolicy,
  };
  throwIfAborted(options.signal);
  let terminal = false;
  let submitted = false;
  const cancelRequest = () => {
    if (submitted && !terminal)
      void cancelHelperRequest(requestId).catch(() => {});
  };
  options.signal?.addEventListener("abort", cancelRequest, { once: true });
  try {
    throwIfAborted(options.signal);
    submitted = true;
    const response = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      submitted = false;
      throw new Error(
        `Claudero helper send failed: ${response.status} ${await response.text()}`,
      );
    }
    for await (const event of streamResponseEvents(
      response,
      requestId,
      options.signal,
    )) {
      if (event.type === "done") terminal = true;
      yield event;
    }
  } finally {
    options.signal?.removeEventListener("abort", cancelRequest);
    if (submitted && !terminal)
      await cancelHelperRequest(requestId).catch(() => {});
  }
}

export async function cancelHelperRequest(
  ownerRequestId: string,
): Promise<void> {
  // Cancellation must not start a helper after the original request was aborted.
  const port = Number(getPref("helperPort") || 38660);
  const token = await getOrCreateHelperToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/cancel`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ownerRequestId }),
      signal: controller.signal,
    });
    await response.text();
    if (!response.ok && response.status !== 404) {
      throw new Error(`Helper cancellation failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
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
  return withRequestDeadline(
    async (signal) => {
      await waitWithSignal(ensureClaudeHelper(), signal);
      const port = Number(getPref("helperPort") || 38660);
      const token = await waitWithSignal(getOrCreateHelperToken(), signal);
      const providerPayload = await waitWithSignal(
        buildProviderPayload(normalizeProviderPref()),
        signal,
      );
      throwIfAborted(signal);
      helperLog(`${requestId} POST http://127.0.0.1:${port}/aux-query`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/aux-query`, {
          method: "POST",
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt,
            systemPrompt: options.systemPrompt,
            workspacePath: getWorkspacePath(),
            ...providerPayload,
            model:
              options.model || String(getPref("model") || "haiku") || undefined,
            effort:
              options.effort ||
              String(getPref("effort") || "high") ||
              undefined,
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
    },
    options.signal,
    60_000,
  );
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
  const nodeScript = /\.(?:cjs|mjs|js)$/i.test(cliPath);
  const executablePath = nodeScript ? resolveNodePath() : cliPath;
  const executableArgs = nodeScript ? [cliPath, ...args] : args;
  if (Zotero.isMac) {
    const scriptDir = PathUtils.join(getProfilePath(), "claudero");
    await IOUtils.makeDirectory(scriptDir, { createAncestors: true });
    const scriptPath = PathUtils.join(scriptDir, `${label}-auth.command`);
    const env = await getClauderoEnvironment();
    const envLines = Object.entries(env).map(
      ([key, value]) => `export ${key}=${shellQuote(value)}`,
    );

    await IOUtils.writeUTF8(
      scriptPath,
      [
        "#!/bin/zsh",
        "set -e",
        "trap 'rm -f -- \"$0\"' EXIT",
        ...envLines,
        `${shellQuote(executablePath)} ${executableArgs.map(shellQuote).join(" ")}`,
        "echo",
        `echo '${label} auth finished. You can close this window.'`,
        "read -k 1 '?Press any key to close...'",
        "",
      ].join("\n"),
    );
    await Zotero.Utilities.Internal.exec("/bin/chmod", ["700", scriptPath]);
    await Zotero.Utilities.Internal.exec("/usr/bin/open", [scriptPath]);
    return;
  }

  await Zotero.Utilities.Internal.exec(executablePath, executableArgs);
}

export async function runClaudeAuthLogin(): Promise<void> {
  await runCliLogin(resolveClaudePath(), ["auth", "login"], "claude");
}

export async function runProviderAuthLogin(
  provider: AiProvider = normalizeProviderPref(),
): Promise<void> {
  await autoDetectSettings();
  if (provider === "codex") {
    await runCliLogin(resolveCodexPath(), ["login"], "codex");
    return;
  }
  if (provider === "deepseek") {
    throw new Error(
      "DeepSeek Harness has no interactive login command. Set DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL or configure the official dsh credentials in ~/.dsh (optionally set DSH_HOME).",
    );
  }
  await runClaudeAuthLogin();
}

export function shutdownClaudeHelper(): Promise<void> {
  if (helperShutdown) return helperShutdown;
  getHelperSignal();
  helperLifetime!.abort();
  const connection = helperConnection;
  const process = helperProcess;
  helperConnection = undefined;
  helperProcess = null;
  persistentQueryInitialized = false;
  helperShutdown = (async () => {
    if (connection) {
      try {
        await withRequestDeadline(
          async (signal) => {
            const response = await fetch(
              `http://127.0.0.1:${connection.port}/shutdown`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${connection.token}` },
                signal,
              },
            );
            await response.body?.cancel();
            if (!response.ok) throw new Error("Helper shutdown rejected");
          },
          undefined,
          1_200,
        );
        return;
      } catch {
        /* Fall back to terminating only the process we started. */
      }
    }
    try {
      process?.kill();
    } catch {
      /* Already exited. */
    }
  })();
  return helperShutdown;
}

function stopHelperProcess(): void {
  try {
    helperProcess?.kill();
  } catch {
    // Best effort.
  }
  helperProcess = null;
  helperConnection = undefined;
  persistentQueryInitialized = false;
}

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "os";
import path from "node:path";
import process from "node:process";
import { PermissionManager } from "./runtime/PermissionManager";
import { collectAuxiliaryRuntime } from "./runtime/AuxiliaryQuery";
import { watchParentProcess } from "./runtime/ParentProcess";
import { throwIfAborted } from "../shared/helperStream";
import { randomUUID } from "node:crypto";
import {
  validateMcpServerConfig,
  validateMcpServers,
} from "../shared/mcpConfigValidation";
import {
  RequestBusyError,
  RequestCoordinator,
  type RequestLease,
  type RequestProvider,
} from "./runtime/RequestCoordinator";
import {
  ClaudeRuntimeAdapter,
  CodexRuntimeAdapter,
  DeepSeekRuntimeAdapter,
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
import {
  windowsClaudeNativeCandidates,
  windowsClaudePackageRoots,
} from "../shared/windowsExecutablePaths";
import {
  bundledCodexCandidates,
  modelsCacheRequiresNewerCodex,
} from "./runtime/codexCompatibility";
import {
  hasValidBearerAuthorization,
  validateHelperServerConfig,
  type HelperServerConfig,
} from "./runtime/helperServerSecurity";
import type { AcademicToolPolicy } from "../shared/academicToolPolicy";
import {
  isSensitiveDiagnosticKey,
  redactSensitiveText,
  summarizeAgentEventForDiagnostics,
} from "../shared/diagnosticPrivacy";

type HelperProvider = "claude" | "codex" | "deepseek";

type HelperConfig = HelperServerConfig & { parentPid: number };

interface ImageInput {
  media_type: string;
  data: string;
}

interface SendPayload {
  requestId?: string;
  prompt: string;
  workspacePath?: string;
  sessionId?: string;
  conversationId?: string;
  provider?: HelperProvider;
  claudePath?: string;
  codexPath?: string;
  deepseekPath?: string;
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
  toolPolicy?: AcademicToolPolicy;
}

interface InitPayload {
  workspacePath: string;
  provider?: HelperProvider;
  claudePath?: string;
  codexPath?: string;
  deepseekPath?: string;
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
  deepseek?: {
    sessionId?: string;
  };
}

interface TestMcpPayload {
  config: McpServerConfig;
}

interface DeepSeekInstallResult {
  cliPath: string;
  installRoot: string;
  nodePath: string;
  version?: string;
}

interface RequestPermissionPayload {
  toolName: string;
  input: unknown;
  /** Provider hint used by external MCP bridges (e.g. Codex). */
  provider?: HelperProvider;
  /** Optional owning request. When omitted, the active request for provider is used. */
  ownerRequestId?: string;
}

interface AuxQueryPayload {
  prompt: string;
  systemPrompt?: string;
  workspacePath: string;
  provider?: HelperProvider;
  claudePath?: string;
  codexPath?: string;
  deepseekPath?: string;
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

  const parentPid = Number(getArg("--parent-pid", String(process.ppid)));
  if (!Number.isSafeInteger(parentPid) || parentPid < 1)
    throw new Error("Invalid parent process ID");
  return {
    ...validateHelperServerConfig({
      host: getArg("--host", "127.0.0.1"),
      port: Number(getArg("--port", "38660")),
      token: getArg("--token"),
    }),
    parentPid,
  };
}

function normalizeProvider(value: string | undefined): HelperProvider {
  return value === "codex" || value === "deepseek" ? value : "claude";
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  return hasValidBearerAuthorization(req.headers.authorization, token);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 32 * 1024 * 1024) {
      throw new HttpRequestError(413, "JSON request body exceeds 32 MB");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function writeEvent(
  res: ServerResponse,
  event: unknown,
  recorder?: AgentEventRecorder,
): void {
  if (recorder && isAgentEventPayload(event)) {
    recorder.record(event);
    latestAgentTrace = recorder;
  }
  if (!res.destroyed && !res.writableEnded)
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

function findNpmPath(): string | null {
  const names =
    process.platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  const entries = pathEntries(process.env.PATH);
  const candidates = [
    ...entries.flatMap((entry) => names.map((name) => path.join(entry, name))),
    ...names.map((name) => path.join(path.dirname(process.execPath), name)),
    ...(process.platform === "win32"
      ? [
          path.join(
            process.env.ProgramFiles || "C:\\Program Files",
            "nodejs",
            "npm.cmd",
          ),
          path.join(
            process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
            "nodejs",
            "npm.cmd",
          ),
        ]
      : ["/opt/homebrew/bin/npm", "/usr/local/bin/npm", "/usr/bin/npm"]),
  ];
  return candidates.find(isExecutableFile) || null;
}

async function runCapturedProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
  });
  let stdout = "";
  let stderr = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error(`Command timed out: ${command}`));
      },
      10 * 60 * 1000,
    );
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-16_000);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function installDeepSeekHarness(): Promise<DeepSeekInstallResult> {
  const npmPath = findNpmPath();
  if (!npmPath) {
    throw new Error(
      "npm was not found. Install Node.js/npm first, then retry the DeepSeek Harness installation.",
    );
  }
  const installRoot = path.join(homedir(), ".claudero", "deepseek");
  await mkdir(installRoot, { recursive: true });
  const result = await runCapturedProcess(
    npmPath,
    [
      "install",
      "--prefix",
      installRoot,
      "@deepseek-ai/dsh@latest",
      "--no-audit",
      "--no-fund",
    ],
    installRoot,
  );
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-4000);
    throw new Error(
      `DeepSeek Harness installation failed (exit ${result.code ?? "unknown"}).${detail ? ` ${detail}` : ""}`,
    );
  }
  const cliPath = path.join(
    installRoot,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  if (!isExecutableFile(cliPath)) {
    throw new Error(
      `DeepSeek Harness installation completed, but its CLI entrypoint was not found at ${cliPath}.`,
    );
  }
  const nodePath = resolveDeepSeekNodePath(process.env);
  let version: string | undefined;
  try {
    const versionResult = await runCapturedProcess(
      nodePath,
      [cliPath, "--version"],
      installRoot,
    );
    if (versionResult.code === 0) {
      version = versionResult.stdout.trim().split(/\s+/)[0] || undefined;
    }
  } catch {
    // A working entrypoint is sufficient; version probing is diagnostic only.
  }
  return { cliPath, installRoot, nodePath, version };
}

function findClaudeCodeEntrypoint(packageRoot: string): string | null {
  const candidates = ["cli-wrapper.cjs", "cli.js"].map((entrypoint) =>
    path.join(packageRoot, entrypoint),
  );
  return candidates.find(isExecutableFile) || null;
}

function environmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const match = Object.entries(env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
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
  const home = homedir();
  const isWindows = process.platform === "win32";
  const pathValue = environmentValue(env, "PATH") || process.env.PATH;
  const nvmBin = resolveNvmDefaultBin(home);

  if (isExecutableFile(configuredPath)) {
    if (!isWindows || !configuredPath.toLowerCase().match(/\.(?:cmd|bat)$/)) {
      return configuredPath;
    }
    const packageRoot = path.join(
      path.dirname(configuredPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
    );
    const entrypoint = findClaudeCodeEntrypoint(packageRoot);
    if (entrypoint) return entrypoint;
  }

  const fromPath = findInPath(isWindows ? "claude.exe" : "claude", pathValue);
  if (fromPath) return fromPath;

  const commonCandidates = isWindows
    ? windowsClaudeNativeCandidates(home, {
        appData: environmentValue(env, "APPDATA") || process.env.APPDATA,
        localAppData:
          environmentValue(env, "LOCALAPPDATA") || process.env.LOCALAPPDATA,
        programFiles:
          environmentValue(env, "ProgramFiles") || process.env.ProgramFiles,
        programFilesX86:
          environmentValue(env, "ProgramFiles(x86)") ||
          process.env["ProgramFiles(x86)"],
      })
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
    ? windowsClaudePackageRoots(
        home,
        {
          appData: environmentValue(env, "APPDATA") || process.env.APPDATA,
          localAppData:
            environmentValue(env, "LOCALAPPDATA") || process.env.LOCALAPPDATA,
          programFiles:
            environmentValue(env, "ProgramFiles") || process.env.ProgramFiles,
          programFilesX86:
            environmentValue(env, "ProgramFiles(x86)") ||
            process.env["ProgramFiles(x86)"],
        },
        pathEntries(pathValue),
      )
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
    isWindows
      ? "Claude Code CLI not found. Restart Zotero after installing Claude Code, or set Claudero preferences -> Claude Code CLI path to claude.exe (native install) or the npm package's cli.js."
      : "Claude Code CLI not found. Install Claude Code or set Claudero preferences -> Claude Code CLI path.",
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

  const home = homedir();
  const isWindows = process.platform === "win32";
  const pathValue = env.PATH || process.env.PATH;
  const nvmBin = resolveNvmDefaultBin(home);
  const bundled = bundledCodexCandidates(process.platform, home).find(
    isExecutableFile,
  );

  let cacheNeedsNewerCodex = false;
  try {
    const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
    cacheNeedsNewerCodex = modelsCacheRequiresNewerCodex(
      readFileSync(path.join(codexHome, "models_cache.json"), "utf8"),
    );
  } catch {
    // Missing or unreadable cache should not prevent normal CLI discovery.
  }
  if (cacheNeedsNewerCodex && bundled) return bundled;
  if (isExecutableFile(configuredPath)) return configuredPath;
  if (bundled) return bundled;

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

function nvmNodeCandidates(home: string): string[] {
  if (process.platform === "win32") return [];
  try {
    return readdirSync(path.join(home, ".nvm", "versions", "node"))
      .filter((entry) => entry.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((entry) =>
        path.join(home, ".nvm", "versions", "node", entry, "bin", "node"),
      );
  } catch {
    return [];
  }
}

function supportsDeepSeekHarness(candidate: string): boolean {
  if (!isExecutableFile(candidate)) return false;
  try {
    execFileSync(
      candidate,
      [
        "-e",
        "const z=require('node:zlib');const m=require('node:module');if(typeof z.createZstdDecompress!=='function'||typeof m.stripTypeScriptTypes!=='function')process.exit(2)",
      ],
      { stdio: "ignore", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

function resolveDeepSeekNodePath(
  env: Record<string, string | undefined>,
): string {
  const home = homedir();
  const pathValue = environmentValue(env, "PATH") || process.env.PATH;
  const executable = process.platform === "win32" ? "node.exe" : "node";
  const candidates = [
    environmentValue(env, "DSH_NODE_PATH") || "",
    process.execPath,
    findInPath(executable, pathValue) || "",
    ...(process.platform === "win32"
      ? [
          path.join(environmentValue(env, "NVM_SYMLINK") || "", "node.exe"),
          path.join(
            environmentValue(env, "ProgramFiles") || "C:\\Program Files",
            "nodejs",
            "node.exe",
          ),
          path.join(
            environmentValue(env, "ProgramFiles(x86)") ||
              "C:\\Program Files (x86)",
            "nodejs",
            "node.exe",
          ),
        ]
      : [
          path.join(home, ".npm-global", "bin", "node"),
          path.join(home, ".local", "bin", "node"),
          path.join(home, ".volta", "bin", "node"),
          path.join(home, ".asdf", "shims", "node"),
          ...nvmNodeCandidates(home),
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
          "/usr/bin/node",
        ]),
  ].filter(
    (candidate, index, all) => candidate && all.indexOf(candidate) === index,
  );
  const compatible = candidates.find(supportsDeepSeekHarness);
  if (compatible) return compatible;
  throw new Error(
    `DeepSeek Harness requires Node.js 24 or newer. Claudero's helper is using ${process.version}, and no compatible Node runtime was found. Install Node.js 24+, or set DSH_NODE_PATH to its executable in the DeepSeek provider environment.`,
  );
}

function resolveDeepSeekPath(
  configuredPath: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const resolveCandidate = (candidate: string | undefined): string | null => {
    if (!isExecutableFile(candidate)) return null;
    try {
      const resolved = realpathSync(candidate);
      if (/\.(?:cjs|mjs|js)$/i.test(resolved)) return resolved;
    } catch {
      // Continue with the original candidate and platform-specific shims.
    }
    if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(candidate)) {
      return candidate;
    }
    const entrypoint = path.join(
      path.dirname(candidate),
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    );
    return isExecutableFile(entrypoint) ? entrypoint : candidate;
  };
  const configured = resolveCandidate(configuredPath);
  if (configured) return configured;
  const pathValue = environmentValue(env, "PATH") || process.env.PATH;
  const command = process.platform === "win32" ? "dsh.cmd" : "dsh";
  const fromPath = resolveCandidate(
    findInPath(command, pathValue) || undefined,
  );
  if (fromPath) return fromPath;
  const home = homedir();
  const managedEntrypoint = path.join(
    home,
    ".claudero",
    "deepseek",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  const candidates =
    process.platform === "win32"
      ? [
          managedEntrypoint,
          path.join(home, "AppData", "Roaming", "npm", "dsh.cmd"),
          path.join(home, "AppData", "Local", "npm", "dsh.cmd"),
        ]
      : [
          managedEntrypoint,
          path.join(home, ".npm-global", "bin", "dsh"),
          path.join(home, ".local", "bin", "dsh"),
          path.join(home, ".bun", "bin", "dsh"),
          path.join(home, ".volta", "bin", "dsh"),
          path.join(home, ".asdf", "shims", "dsh"),
          "/opt/homebrew/bin/dsh",
          "/usr/local/bin/dsh",
          "/usr/bin/dsh",
        ];
  const found = candidates
    .map((candidate) => resolveCandidate(candidate))
    .find((candidate): candidate is string => !!candidate);
  if (found) return found;
  throw new Error(
    "DeepSeek Harness CLI not found. `dsh web` only starts the browser UI; Claudero needs the headless CLI. Install @deepseek-ai/dsh (or use Claudero's Install DeepSeek Harness action), then set the DeepSeek Harness CLI path if needed.",
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

const permissionManagers: Record<HelperProvider, PermissionManager> = {
  claude: new PermissionManager(),
  codex: new PermissionManager(),
  deepseek: new PermissionManager(),
};
const runtimeAdapters: Record<HelperProvider, AgentRuntimeAdapter> = {
  claude: new ClaudeRuntimeAdapter(permissionManagers.claude),
  codex: new CodexRuntimeAdapter(permissionManagers.codex),
  deepseek: new DeepSeekRuntimeAdapter(permissionManagers.deepseek),
};
const coordinator = new RequestCoordinator();
interface RuntimeExecution {
  lease: RequestLease;
  ready: boolean;
  acceptingBridge: boolean;
  endpoint?: string;
  stopPromise?: Promise<void>;
  bridgeCalls: Set<Promise<unknown>>;
}
const executions = new Map<string, RuntimeExecution>();
const cancelledRequestIds = new Set<string>();

function rememberCancelledRequest(requestId: string): void {
  cancelledRequestIds.add(requestId);
  while (cancelledRequestIds.size > 1024) {
    cancelledRequestIds.delete(cancelledRequestIds.values().next().value!);
  }
}

function ownedExecution(ownerRequestId: unknown): RuntimeExecution {
  if (typeof ownerRequestId !== "string")
    throw new HttpRequestError(400, "ownerRequestId is required");
  const execution = executions.get(ownerRequestId);
  if (
    !execution ||
    !coordinator.owns(execution.lease) ||
    execution.lease.signal.aborted
  ) {
    throw new HttpRequestError(404, "Request not found or expired");
  }
  return execution;
}

function assertExecution(execution: RuntimeExecution): void {
  if (execution.lease.signal.aborted || !coordinator.owns(execution.lease)) {
    throw new DOMException("Request cancelled", "AbortError");
  }
}

function cancelExecution(execution: RuntimeExecution): Promise<void> {
  execution.acceptingBridge = false;
  execution.lease.cancel();
  const provider = execution.lease.provider;
  permissionManagers[provider].cancelAll();
  if (execution.ready && !execution.stopPromise) {
    execution.stopPromise = Promise.resolve().then(() =>
      runtimeAdapters[provider].cancelActiveTurn(),
    );
    void execution.stopPromise.catch(() => {});
  }
  return execution.stopPromise || Promise.resolve();
}

async function withRuntimeLease<T>(
  provider: HelperProvider,
  requestId: string,
  conversationId: string | undefined,
  res: ServerResponse,
  operation: (execution: RuntimeExecution) => Promise<T>,
): Promise<T> {
  const cancelledBeforeArrival = cancelledRequestIds.delete(requestId);
  if (cancelledBeforeArrival)
    throw new HttpRequestError(409, "Request was cancelled before it started.");
  const lease = coordinator.acquire(requestId, provider, conversationId);
  const execution: RuntimeExecution = {
    lease,
    ready: false,
    acceptingBridge: false,
    bridgeCalls: new Set(),
  };
  executions.set(requestId, execution);
  const onClose = () => {
    if (!res.writableEnded) void cancelExecution(execution).catch(() => {});
  };
  res.once("close", onClose);
  if (res.destroyed) onClose();
  try {
    assertExecution(execution);
    return await operation(execution);
  } finally {
    execution.acceptingBridge = false;
    res.off("close", onClose);
    permissionManagers[provider].cancelAll();
    try {
      if (lease.signal.aborted) {
        await cancelExecution(execution);
        await runtimeAdapters[provider].close();
      }
      await Promise.allSettled([...execution.bridgeCalls]);
    } finally {
      executions.delete(requestId);
      coordinator.release(lease);
    }
  }
}
let activeProvider: HelperProvider = "claude";
let latestAgentTrace: AgentEventRecorder | null = null;
type HelperDebugLevel = "info" | "warning" | "error";
interface HelperDebugEntry {
  ts: string;
  level: HelperDebugLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}
const helperDebugLog: HelperDebugEntry[] = [];
const MAX_HELPER_DEBUG_LOG = 300;

function queryManagerFor(provider: HelperProvider) {
  return runtimeAdapters[provider];
}

function activeQueryManager() {
  return queryManagerFor(activeProvider);
}

interface CachedProviderInitialization {
  workspacePath: string;
  payload: Partial<InitPayload & SendPayload>;
  helperConfig?: HelperConfig;
}

const lastProviderInitializations = new Map<
  HelperProvider,
  CachedProviderInitialization
>();

function cacheableInitializationPayload(
  payload: Partial<InitPayload & SendPayload>,
): Partial<InitPayload & SendPayload> {
  return {
    provider: payload.provider,
    claudePath: payload.claudePath,
    codexPath: payload.codexPath,
    deepseekPath: payload.deepseekPath,
    codexInstallationMethod: payload.codexInstallationMethod,
    codexWslDistro: payload.codexWslDistro,
    codexSafeMode: payload.codexSafeMode,
    environment: payload.environment,
    model: payload.model,
    effort: payload.effort,
    additionalDirectories: payload.additionalDirectories,
    permissionMode: payload.permissionMode,
    zoteroEndpointUrl: payload.zoteroEndpointUrl,
    enableZoteroMcp: payload.enableZoteroMcp,
    mcpServers: payload.mcpServers,
    mcpDisabledTools: payload.mcpDisabledTools,
    conversationId: payload.conversationId,
    providerState: payload.providerState,
  };
}

async function restartRuntimeAdapters(): Promise<Record<string, boolean>> {
  recordHelperDebug("runtime", "restart requested", {
    activeProvider,
    claudeActive: runtimeAdapters.claude.isActive,
    codexActive: runtimeAdapters.codex.isActive,
    deepseekActive: runtimeAdapters.deepseek.isActive,
  });
  const activeProviders = (["claude", "codex", "deepseek"] as const).filter(
    (provider) => runtimeAdapters[provider].isActive,
  );
  // Abort in-flight requests before tearing down their provider processes so
  // streams cannot continue against a closed runtime.
  await Promise.allSettled(
    [...executions.values()].map(async (execution) => {
      await cancelExecution(execution);
      // Wait until the request's finally block has released its lease. That
      // block may close the adapter after cancellation; reinitializing before
      // it completes could therefore close the newly initialized runtime.
      await execution.lease.released;
    }),
  );
  for (const provider of ["claude", "codex", "deepseek"] as const) {
    permissionManagers[provider].cancelAll();
    runtimeAdapters[provider].close();
  }
  latestAgentTrace = null;
  const restarted: Record<string, boolean> = {
    claude: false,
    codex: false,
    deepseek: false,
  };
  for (const provider of activeProviders) {
    const cached = lastProviderInitializations.get(provider);
    if (!cached) continue;
    await initializeProviderFromPayload(
      provider,
      cached.workspacePath,
      cached.payload,
      cached.helperConfig,
    );
    restarted[provider] = true;
  }
  return restarted;
}

function redactHelperValue(key: string, value: unknown): unknown {
  if (isSensitiveDiagnosticKey(key)) {
    return value === undefined || value === null || value === ""
      ? value
      : "[redacted]";
  }
  if (typeof value === "string") {
    const safeValue = redactSensitiveText(value);
    return safeValue.length > 700 ? `${safeValue.slice(0, 700)}...` : safeValue;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((entry) => redactHelperValue(key, entry));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[childKey] = redactHelperValue(childKey, childValue);
    }
    return output;
  }
  return value;
}

function helperDebugData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return redactHelperValue("data", data) as Record<string, unknown>;
}

function recordHelperDebug(
  scope: string,
  message: string,
  data?: Record<string, unknown>,
  level: HelperDebugLevel = "info",
): void {
  helperDebugLog.push({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    data: helperDebugData(data),
  });
  while (helperDebugLog.length > MAX_HELPER_DEBUG_LOG) {
    helperDebugLog.shift();
  }
}

function helperErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.replace(/\s+/g, " ").slice(0, 1200),
    };
  }
  return { message: String(error) };
}

function providerPayloadSummary(
  provider: HelperProvider,
  payload: Partial<InitPayload & SendPayload>,
): Record<string, unknown> {
  return {
    provider,
    model: payload.model,
    effort: payload.effort,
    permissionMode: payload.permissionMode,
    codexInstallationMethod: payload.codexInstallationMethod,
    codexSafeMode: payload.codexSafeMode,
    deepseekPath: payload.deepseekPath,
    enableZoteroMcp: payload.enableZoteroMcp,
    mcpServers: Object.keys(payload.mcpServers || {}).sort(),
    mcpDisabledTools: payload.mcpDisabledTools || [],
    additionalDirectoryCount: payload.additionalDirectories?.length || 0,
    environmentKeys: Object.keys(payload.environment || {}).sort(),
    conversationId: payload.conversationId,
  };
}

function currentWorkspacePathFor(provider: HelperProvider): string | null {
  // A provider's runtime must never inherit another provider's workspace.
  // Doing so makes /send and /models believe the requested workspace is already
  // initialized and can return data from the wrong project.
  return queryManagerFor(provider).workspacePath;
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
    .map((event) => redactSensitiveText(event.error).slice(0, 700));
  const lastEnvelope = trace.events.at(-1);
  return {
    traceId: trace.traceId,
    startedAt: trace.startedAt,
    source: trace.source,
    eventCount: trace.events.length,
    eventCounts,
    errors,
    lastEvent: lastEnvelope
      ? {
          id: lastEnvelope.id,
          sequence: lastEnvelope.sequence,
          timestamp: lastEnvelope.timestamp,
          source: lastEnvelope.source,
          event: summarizeAgentEventForDiagnostics(lastEnvelope.event),
        }
      : null,
  };
}

function diagnosticsPayload(): unknown {
  const activeRuntime = activeQueryManager();
  return redactHelperValue("diagnostics", {
    helper: {
      version: HELPER_VERSION,
      activeProvider,
      active: true,
      runtimeActive: activeRuntime.isActive,
    },
    runtimes: {
      claude: runtimeAdapters.claude.diagnostics(),
      codex: runtimeAdapters.codex.diagnostics(),
      deepseek: runtimeAdapters.deepseek.diagnostics(),
    },
    trace: traceSummary(latestAgentTrace?.snapshot() || null),
    debugLog: helperDebugLog.slice(-180),
  });
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
  if (provider === "deepseek") {
    return {
      ...common,
      deepseekPath: payload.deepseekPath,
      providerState: payload.providerState?.deepseek,
    };
  }
  return {
    ...common,
    claudePath: payload.claudePath,
    providerState: payload.providerState?.claude,
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
  if (provider === "deepseek") {
    return {
      model: payload.model,
      effort: payload.effort,
      permissionMode: payload.permissionMode,
    };
  }
  return {};
}

const providerInitializationPromises = new Map<HelperProvider, Promise<void>>();
const helperLifetime = new AbortController();

async function initializeProviderFromPayload(
  provider: HelperProvider,
  workspacePath: string,
  payload: Partial<InitPayload & SendPayload>,
  helperConfig?: HelperConfig,
): Promise<void> {
  const existing = providerInitializationPromises.get(provider);
  if (existing) {
    recordHelperDebug("runtime", "joining in-flight initialization", {
      provider,
    });
    await existing;
    return;
  }
  const task = initializeProviderNow(
    provider,
    workspacePath,
    payload,
    helperConfig,
  );
  providerInitializationPromises.set(provider, task);
  try {
    await task;
    lastProviderInitializations.set(provider, {
      workspacePath,
      payload: cacheableInitializationPayload(payload),
      helperConfig,
    });
  } finally {
    if (providerInitializationPromises.get(provider) === task) {
      providerInitializationPromises.delete(provider);
    }
  }
}

async function initializeProviderNow(
  provider: HelperProvider,
  workspacePath: string,
  payload: Partial<InitPayload & SendPayload>,
  helperConfig?: HelperConfig,
): Promise<void> {
  const startedAt = Date.now();
  recordHelperDebug("runtime", "initialize start", {
    workspacePath,
    ...providerPayloadSummary(provider, payload),
  });
  const additionalDirectories = uniqueExistingDirectories(
    payload.additionalDirectories,
  );
  const manager = queryManagerFor(provider);
  try {
    await mkdir(workspacePath, { recursive: true });
    throwIfAborted(helperLifetime.signal);
    if (provider === "codex") {
      const codexPath = resolveCodexPath(
        payload.codexPath,
        {
          ...process.env,
          ...(payload.environment || {}),
        },
        payload.codexInstallationMethod,
      );
      recordHelperDebug("runtime", "codex path resolved", {
        codexPath,
        additionalDirectories,
      });
      await manager.initialize(
        {
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
        },
        helperLifetime.signal,
      );
      recordHelperDebug("runtime", "initialize complete", {
        provider,
        elapsedMs: Date.now() - startedAt,
        active: manager.isActive,
      });
      return;
    }

    if (provider === "deepseek") {
      const deepseekEnvironment = {
        ...process.env,
        ...(payload.environment || {}),
      };
      const deepseekPath = resolveDeepSeekPath(
        payload.deepseekPath,
        deepseekEnvironment,
      );
      const nodePath = resolveDeepSeekNodePath(deepseekEnvironment);
      recordHelperDebug("runtime", "deepseek path resolved", {
        deepseekPath,
        nodePath,
        additionalDirectories,
      });
      await manager.initialize(
        {
          workspacePath,
          deepseekPath,
          nodePath,
          environment: payload.environment || {},
          model: payload.model,
          effort: payload.effort,
          permissionMode: payload.permissionMode,
          conversationId: payload.conversationId,
          providerState: payload.providerState?.deepseek,
        },
        helperLifetime.signal,
      );
      recordHelperDebug("runtime", "initialize complete", {
        provider,
        elapsedMs: Date.now() - startedAt,
        active: manager.isActive,
      });
      return;
    }

    const claudePath = resolveClaudePath(payload.claudePath, {
      ...process.env,
      ...(payload.environment || {}),
    });
    recordHelperDebug("runtime", "claude path resolved", {
      claudePath,
      additionalDirectories,
    });
    await manager.initialize(
      {
        workspacePath,
        claudePath,
        environment: payload.environment || {},
        model: normalizeClaudeModel(payload.model),
        effort: normalizeClaudeEffort(payload.effort),
        additionalDirectories,
        permissionMode: payload.permissionMode,
        zoteroEndpointUrl: payload.zoteroEndpointUrl,
        zoteroEndpointToken: helperConfig?.token,
        enableZoteroMcp: payload.enableZoteroMcp,
        mcpServers: payload.mcpServers,
        mcpDisabledTools: payload.mcpDisabledTools,
        conversationId: payload.conversationId,
        providerState: payload.providerState?.claude,
      },
      helperLifetime.signal,
    );
    recordHelperDebug("runtime", "initialize complete", {
      provider,
      elapsedMs: Date.now() - startedAt,
      active: manager.isActive,
    });
  } catch (error) {
    recordHelperDebug(
      "runtime",
      "initialize failed",
      {
        provider,
        elapsedMs: Date.now() - startedAt,
        error: helperErrorData(error),
      },
      "error",
    );
    manager.close();
    throw error;
  }
}

async function handleInit(
  req: IncomingMessage,
  res: ServerResponse,
  helperConfig: HelperConfig,
): Promise<void> {
  const payload = await readJsonBody<InitPayload>(req);
  const provider = normalizeProvider(payload.provider);
  recordHelperDebug("http", "/init request", {
    workspacePath: payload.workspacePath,
    ...providerPayloadSummary(provider, payload),
  });

  if (!payload.workspacePath) {
    recordHelperDebug(
      "http",
      "/init rejected",
      { reason: "workspacePath is required" },
      "warning",
    );
    sendJson(res, 400, { error: "workspacePath is required" });
    return;
  }

  validateRuntimePayload(payload);
  await withRuntimeLease(
    provider,
    randomUUID(),
    payload.conversationId,
    res,
    async (execution) => {
      await prepareRuntime(provider, payload, helperConfig);
      execution.ready = true;
      assertExecution(execution);
      activeProvider = provider;
      sendJson(res, 200, { ok: true });
    },
  );
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
  const provider = normalizeProvider(payload.provider);
  const requestId = payload.requestId || randomUUID();
  validateRuntimePayload(payload);
  await withRuntimeLease(
    provider,
    requestId,
    payload.conversationId,
    res,
    async (execution) => {
      await handleOwnedSend(
        { ...payload, requestId },
        res,
        helperConfig,
        execution,
      );
    },
  );
}

function validateRuntimePayload(
  payload: Partial<InitPayload & SendPayload>,
): void {
  if (
    payload.workspacePath !== undefined &&
    (typeof payload.workspacePath !== "string" ||
      !path.isAbsolute(payload.workspacePath))
  ) {
    throw new HttpRequestError(400, "Workspace path must be absolute.");
  }
  if (payload.mcpServers !== undefined) {
    const error = validateMcpServers(payload.mcpServers);
    if (error) throw new HttpRequestError(400, error);
  }
}

async function prepareRuntime(
  provider: HelperProvider,
  payload: Partial<InitPayload & SendPayload>,
  helperConfig: HelperConfig,
): Promise<void> {
  const manager = queryManagerFor(provider);
  const workspace = payload.workspacePath || manager.workspacePath;
  if (!workspace) throw new HttpRequestError(400, "workspacePath is required");
  validateRuntimePayload(payload);
  const environment = { ...process.env, ...(payload.environment || {}) };
  const resolved = { ...payload };
  if (provider === "claude" && payload.claudePath === "")
    resolved.claudePath = resolveClaudePath(undefined, environment);
  if (provider === "codex" && payload.codexPath === "")
    resolved.codexPath = resolveCodexPath(
      undefined,
      environment,
      payload.codexInstallationMethod,
    );
  if (provider === "deepseek" && payload.deepseekPath === "")
    resolved.deepseekPath = resolveDeepSeekPath(undefined, environment);
  if (
    !manager.isActive ||
    manager.workspacePath !== workspace ||
    manager.requiresRestart(runtimeRestartConfig(provider, resolved))
  ) {
    await manager.close();
    try {
      await initializeProviderFromPayload(
        provider,
        workspace,
        resolved,
        helperConfig,
      );
    } catch (error) {
      await manager.close();
      throw error;
    }
  } else {
    manager.updateConfig(runtimeLiveUpdateConfig(provider, resolved));
    if (resolved.permissionMode !== undefined)
      await manager.setPermissionMode(resolved.permissionMode);
    const previous = lastProviderInitializations.get(provider)?.payload;
    lastProviderInitializations.set(provider, {
      workspacePath: workspace,
      payload: { ...previous, ...cacheableInitializationPayload(resolved) },
      helperConfig,
    });
  }
}

async function handleOwnedSend(
  payload: SendPayload & { requestId: string },
  res: ServerResponse,
  helperConfig: HelperConfig,
  execution: RuntimeExecution,
): Promise<void> {
  const startedAt = Date.now();
  if (!payload.prompt && (!payload.images || payload.images.length === 0)) {
    recordHelperDebug(
      "http",
      "/send rejected",
      { reason: "prompt is required" },
      "warning",
    );
    sendJson(res, 400, { error: "prompt is required" });
    return;
  }

  const provider = normalizeProvider(payload.provider);
  const manager = queryManagerFor(provider);
  activeProvider = provider;
  const requestedWorkspacePath = payload.workspacePath?.trim();
  if (requestedWorkspacePath && !path.isAbsolute(requestedWorkspacePath)) {
    sendJson(res, 400, { error: "Workspace path must be absolute." });
    return;
  }
  const currentWorkspacePath =
    requestedWorkspacePath || currentWorkspacePathFor(provider);
  recordHelperDebug("http", "/send request", {
    provider,
    promptChars: payload.prompt?.length || 0,
    imageCount: payload.images?.length || 0,
    managerActive: manager.isActive,
    currentWorkspacePath,
    ...providerPayloadSummary(provider, payload),
  });

  await prepareRuntime(provider, payload, helperConfig);
  execution.ready = true;
  execution.endpoint = payload.zoteroEndpointUrl;
  assertExecution(execution);
  permissionManagers[provider].setScope(
    JSON.stringify({
      provider,
      conversationId: payload.conversationId,
      workspace: manager.workspacePath,
      cliPath:
        provider === "claude"
          ? payload.claudePath
          : provider === "codex"
            ? payload.codexPath
            : payload.deepseekPath,
      environment: payload.environment,
    }),
  );
  manager.setToolPolicy(payload.toolPolicy);
  execution.acceptingBridge = true;

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
  const eventCounts: Record<string, number> = {};
  let outcome: "success" | "error" | "cancelled" = "success";
  const countEvent = (event: unknown) => {
    const record = event && typeof event === "object" ? event : null;
    const type =
      record && "type" in record
        ? String((record as { type?: unknown }).type || "unknown")
        : "unknown";
    eventCounts[type] = (eventCounts[type] || 0) + 1;
    return type;
  };
  recordHelperDebug("http", "/send stream opened", { provider });
  writeEvent(
    res,
    { type: "ready", requestId: payload.requestId },
    traceRecorder,
  );
  countEvent({ type: "ready" });

  try {
    let firstAgentEvent = false;
    for await (const event of manager.sendMessageEvents(
      payload.prompt,
      payload.images,
    )) {
      assertExecution(execution);
      if (event.type === "error") outcome = "error";
      const type = countEvent(event);
      if (!firstAgentEvent) {
        firstAgentEvent = true;
        recordHelperDebug("http", "/send first runtime event", {
          provider,
          type,
          elapsedMs: Date.now() - startedAt,
        });
      }
      writeEvent(res, event, traceRecorder);
    }
    assertExecution(execution);
    if (outcome === "error") await manager.close();
    recordHelperDebug("http", "/send done", {
      provider,
      elapsedMs: Date.now() - startedAt,
      eventCounts,
    });
  } catch (error) {
    recordHelperDebug(
      "http",
      "/send failed",
      {
        provider,
        elapsedMs: Date.now() - startedAt,
        eventCounts,
        error: helperErrorData(error),
      },
      "error",
    );
    outcome = execution.lease.signal.aborted ? "cancelled" : "error";
    if (outcome === "error") {
      writeEvent(
        res,
        {
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        },
        traceRecorder,
      );
    }
    await cancelExecution(execution).catch(() => {});
    await manager.close();
  } finally {
    execution.acceptingBridge = false;
    if (execution.stopPromise) await execution.stopPromise;
    await Promise.allSettled([...execution.bridgeCalls]);
    if (outcome === "success" && execution.lease.signal.aborted)
      outcome = "cancelled";
    writeEvent(
      res,
      { type: "done", requestId: payload.requestId, outcome },
      traceRecorder,
    );
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

  await handleSendWithPayload(payload, res, helperConfig);
}

const auxiliaryControllers = new Set<AbortController>();

async function handleAuxQuery(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const payload = await readJsonBody<AuxQueryPayload>(req);
  if (!payload.prompt || !payload.workspacePath) {
    sendJson(res, 400, { error: "prompt and workspacePath are required" });
    return;
  }

  const controller = new AbortController();
  auxiliaryControllers.add(controller);
  const cancel = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", cancel);
  const deadline = setTimeout(() => controller.abort(), 60_000);
  if (res.destroyed) cancel();
  const prompt = payload.systemPrompt
    ? `${payload.systemPrompt}\n\n${payload.prompt}`
    : payload.prompt;
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
      const text = await collectAuxiliaryRuntime(
        auxManager,
        {
          workspacePath: payload.workspacePath,
          codexPath,
          environment: payload.environment || {},
          model: normalizeClaudeModel(payload.model) || "gpt-5.4-mini",
          effort: payload.effort || "low",
          permissionMode: "dontAsk",
          codexInstallationMethod: payload.codexInstallationMethod,
          codexWslDistro: payload.codexWslDistro,
          codexSafeMode: payload.codexSafeMode,
        },
        prompt,
        controller.signal,
      );
      sendJson(res, 200, { text });
      return;
    }

    if (provider === "deepseek") {
      const deepseekEnvironment = {
        ...process.env,
        ...(payload.environment || {}),
      };
      const deepseekPath = resolveDeepSeekPath(
        payload.deepseekPath,
        deepseekEnvironment,
      );
      const nodePath = resolveDeepSeekNodePath(deepseekEnvironment);
      const auxManager = new DeepSeekRuntimeAdapter(new PermissionManager());
      const text = await collectAuxiliaryRuntime(
        auxManager,
        {
          workspacePath: payload.workspacePath,
          deepseekPath,
          nodePath,
          environment: payload.environment || {},
          model: payload.model,
          effort: payload.effort,
          permissionMode: "dontAsk",
        },
        prompt,
        controller.signal,
      );
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
    options.abortController = controller;
    if (payload.systemPrompt) {
      options.systemPrompt = payload.systemPrompt;
    }

    let text = "";
    const session = query({ prompt: payload.prompt, options });
    const close = () => session.close();
    controller.signal.addEventListener("abort", close, { once: true });
    try {
      if (controller.signal.aborted)
        throw new DOMException("Request cancelled", "AbortError");
      for await (const message of session) {
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
    } finally {
      controller.signal.removeEventListener("abort", close);
      session.close();
    }
    sendJson(res, 200, { text });
  } catch (error) {
    if (!res.destroyed && !res.writableEnded)
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
  } finally {
    clearTimeout(deadline);
    res.off("close", cancel);
    auxiliaryControllers.delete(controller);
  }
}

async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  helperConfig: HelperConfig,
): Promise<void> {
  const payload = await readJsonBody<InitPayload>(req);
  const provider = normalizeProvider(payload.provider);
  if (provider === "claude") {
    sendJson(res, 200, { models: [] });
    return;
  }
  if (!payload.workspacePath) {
    sendJson(res, 400, { error: "workspacePath is required" });
    return;
  }
  const manager = queryManagerFor(provider);
  validateRuntimePayload(payload);
  await withRuntimeLease(
    provider,
    randomUUID(),
    payload.conversationId,
    res,
    async (execution) => {
      // Always prepare against the requested workspace. The active runtime may
      // belong to another provider/workspace, and listModels requires a live
      // manager for this exact target.
      await prepareRuntime(provider, payload, helperConfig);
      execution.ready = true;
      assertExecution(execution);
      const models = await manager.listModels();
      assertExecution(execution);
      sendJson(res, 200, { models });
    },
  );
}

async function handleInstallDeepSeek(res: ServerResponse): Promise<void> {
  try {
    const result = await installDeepSeekHarness();
    recordHelperDebug("runtime", "deepseek harness installed", {
      cliPath: result.cliPath,
      installRoot: result.installRoot,
      nodePath: result.nodePath,
      version: result.version,
    });
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    recordHelperDebug(
      "runtime",
      "deepseek harness installation failed",
      { error: helperErrorData(error) },
      "error",
    );
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

  const url = new URL(req.url || "/", "http://127.0.0.1");
  const endpoint = url.pathname;

  if (
    req.method === "GET" &&
    ["/pending-permission", "/pending-question", "/pending-exit-plan"].includes(
      endpoint,
    )
  ) {
    const execution = ownedExecution(url.searchParams.get("ownerRequestId"));
    const manager = runtimeAdapters[execution.lease.provider];
    const pending =
      endpoint === "/pending-permission"
        ? permissionManagers[execution.lease.provider].getCurrentRequest()
        : endpoint === "/pending-question"
          ? manager.getPendingQuestion()
          : manager.getPendingExitPlan();
    sendJson(
      res,
      pending ? 200 : 204,
      pending ? { ...pending, ownerRequestId: execution.lease.requestId } : "",
    );
    return;
  }

  if (
    req.method === "POST" &&
    [
      "/cancel",
      "/cancel-permission",
      "/cancel-question",
      "/cancel-exit-plan",
    ].includes(endpoint)
  ) {
    const body = await readJsonBody<{ ownerRequestId?: string }>(req);
    if (
      typeof body.ownerRequestId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(body.ownerRequestId)
    ) {
      throw new HttpRequestError(400, "ownerRequestId is required");
    }
    const execution = executions.get(body.ownerRequestId);
    if (execution) await cancelExecution(execution);
    else rememberCancelledRequest(body.ownerRequestId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (
    req.method === "POST" &&
    ["/permission", "/answer-question", "/answer-exit-plan"].includes(endpoint)
  ) {
    const body = await readJsonBody<{
      ownerRequestId?: string;
      requestId: string;
      toolUseId: string;
      allowed: boolean;
      remember?: boolean;
      answers: Record<string, string | string[]>;
      response?: string;
      decision: import("./runtime/PersistentQueryManager").ExitPlanDecision;
    }>(req);
    const execution = ownedExecution(body.ownerRequestId);
    const manager = runtimeAdapters[execution.lease.provider];
    let answered = false;
    if (endpoint === "/permission") {
      if (typeof body.allowed !== "boolean")
        throw new HttpRequestError(400, "allowed must be boolean");
      answered = permissionManagers[execution.lease.provider].resolve(
        body.requestId,
        { allowed: body.allowed, remember: body.remember === true },
      );
    } else if (endpoint === "/answer-question") {
      if (
        !body.answers ||
        typeof body.answers !== "object" ||
        Array.isArray(body.answers) ||
        !Object.values(body.answers).every(
          (value) =>
            typeof value === "string" ||
            (Array.isArray(value) &&
              value.every((entry) => typeof entry === "string")),
        )
      ) {
        throw new HttpRequestError(400, "Invalid question answers");
      }
      answered =
        manager.getPendingQuestion()?.toolUseId === body.toolUseId &&
        manager.answerQuestion(body.toolUseId, body.answers, body.response);
    } else {
      if (
        !body.decision ||
        !["approve", "approve-new-session", "feedback"].includes(
          body.decision.type,
        ) ||
        (body.decision.type === "feedback" &&
          typeof body.decision.text !== "string")
      ) {
        throw new HttpRequestError(400, "Invalid plan decision");
      }
      answered =
        manager.getPendingExitPlan()?.toolUseId === body.toolUseId &&
        manager.answerExitPlan(body.toolUseId, body.decision);
    }
    sendJson(
      res,
      answered ? 200 : 404,
      answered ? { ok: true } : { error: "Interaction not found or expired" },
    );
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
      sendJson(res, 200, latestAgentTrace.snapshot());
    } else {
      sendJson(res, 204, "");
    }
    return;
  }

  if (req.method === "GET" && req.url === "/diagnostics") {
    sendJson(res, 200, diagnosticsPayload());
    return;
  }

  if (req.method === "POST" && req.url === "/restart-runtimes") {
    const restarted = await restartRuntimeAdapters();
    sendJson(res, 200, { ok: true, restarted });
    return;
  }

  if (req.method === "POST" && req.url === "/install-deepseek") {
    await handleInstallDeepSeek(res);
    return;
  }

  if (req.method === "POST" && req.url === "/shutdown") {
    shutdownRequested = true;
    sendJson(res, 200, { ok: true });
    setTimeout(() => requestHelperShutdown(), 50);
    return;
  }

  if (req.method === "POST" && req.url === "/init") {
    await handleInit(req, res, config);
    return;
  }

  if (req.method === "POST" && req.url === "/models") {
    await handleModels(req, res, config);
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
    const error = validateMcpServerConfig(body.config);
    if (error) throw new HttpRequestError(400, error);
    const result = await testMcpServer(body.config);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && req.url === "/request-permission") {
    const body = await readJsonBody<RequestPermissionPayload>(req);
    if (
      body.provider !== undefined &&
      body.provider !== "claude" &&
      body.provider !== "codex" &&
      body.provider !== "deepseek"
    ) {
      throw new HttpRequestError(400, "Invalid permission provider");
    }
    const provider = body.provider || activeProvider;
    // External MCP bridges cannot always know the transient request id. Resolve
    // the currently leased execution for the provider while still honoring an
    // explicit owner id when supplied.
    let permissionExecution: RuntimeExecution | undefined;
    if (body.ownerRequestId !== undefined) {
      permissionExecution = ownedExecution(body.ownerRequestId);
      if (permissionExecution.lease.provider !== provider) {
        throw new HttpRequestError(
          409,
          "Permission provider does not match request",
        );
      }
    } else {
      const lease = coordinator.active(provider);
      permissionExecution = lease ? executions.get(lease.requestId) : undefined;
    }
    if (!permissionExecution || !coordinator.owns(permissionExecution.lease)) {
      sendJson(res, 404, {
        allowed: false,
        error: "No active request for provider",
      });
      return;
    }
    const toolName = body.toolName || "Tool action";
    const inputRecord =
      body.input && typeof body.input === "object"
        ? (body.input as Record<string, unknown>)
        : {};
    const action =
      typeof inputRecord.action === "string" ? inputRecord.action : "";
    const policyToolName = action ? `mcp__zotero__${action}` : toolName;
    const manager = permissionManagers[provider];
    const policyDenial = manager.getToolPolicyDenial(policyToolName);
    if (policyDenial) {
      sendJson(res, 200, { allowed: false, error: policyDenial });
      return;
    }
    if (manager.isRemembered(toolName, body.input)) {
      sendJson(res, 200, { allowed: true, remember: true });
      return;
    }
    const requestId = Math.random().toString(36).slice(2, 11);
    const decision = await manager.request({
      id: requestId,
      toolName,
      input: body.input,
    });
    if (decision.allowed && decision.remember) {
      manager.remember(toolName, body.input);
    }
    sendJson(res, 200, decision);
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

let requestHelperShutdown: () => void;
let shutdownRequested = false;

function main(): void {
  if (process.argv.includes("--zotero-mcp-stdio")) {
    runZoteroMcpStdioServer(process.argv.slice(2));
    return;
  }
  if (!process.argv.includes("--server")) {
    throw new Error("Claudero helper must be started with --server");
  }
  const config = parseArgs(process.argv.slice(2));
  let shuttingDown = false;
  const server = createServer((req, res) => {
    if (shutdownRequested || shuttingDown) {
      sendJson(res, 503, { error: "Helper is shutting down" });
      return;
    }
    route(req, res, config).catch((error) => {
      const status =
        error instanceof RequestBusyError
          ? 409
          : error instanceof HttpRequestError
            ? error.status
            : 500;
      if (!res.headersSent) {
        sendJson(res, status, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        res.end();
      }
    });
  });

  requestHelperShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    helperLifetime.abort();
    stopWatchingParent();
    for (const lease of coordinator.pause()) lease.cancel();
    for (const controller of auxiliaryControllers) controller.abort();
    for (const provider of ["claude", "codex", "deepseek"] as const) {
      permissionManagers[provider].cancelAll();
      try {
        runtimeAdapters[provider].close();
      } catch {
        /* Continue closing other providers. */
      }
    }
    server.close();
    server.closeAllConnections();
    // Let child-process cleanup and kill escalation finish before forcing exit.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  const stopWatchingParent = watchParentProcess(config.parentPid, () =>
    requestHelperShutdown(),
  );
  process.once("SIGTERM", () => requestHelperShutdown());
  process.once("SIGINT", () => requestHelperShutdown());

  server.listen(config.port, config.host, () => {
    console.log(
      `Claudero helper listening on http://${config.host}:${config.port}`,
    );
  });
}

main();

import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ImageInput } from "./MessageChannel";
import type {
  PermissionManager,
  PermissionDecision,
} from "./PermissionManager";
import type { ClauderoPermissionMode } from "./QueryOptionsBuilder";
import type {
  ExitPlanDecision,
  PendingExitPlan,
} from "./PersistentQueryManager";
import {
  buildCodexMcpConfigOverrides,
  buildCodexMcpThreadConfig,
  buildZoteroBridgeMcpServer,
} from "./CodexMcpConfig";
import type { ClauderoStreamEvent } from "../stream/types";
import {
  parseCodexModelListPage,
  type ProviderModelDescriptor,
} from "../../shared/providerModels";
import { isProcessAlive } from "./processHealth";
import {
  hasModelsCacheSchemaError,
  stripAnsi,
  userFacingCodexStderr,
} from "./codexCompatibility";
import {
  codexTurnIdleTimeoutMs,
  parseCodexReconnectStatus,
} from "./codexTurnPolicy";
import type { AcademicToolPolicy } from "../../shared/academicToolPolicy";

export interface CodexConfig {
  workspacePath: string;
  codexPath: string;
  environment: Record<string, string>;
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  permissionMode?: ClauderoPermissionMode;
  zoteroEndpointUrl?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  conversationId?: string;
  codexInstallationMethod?: "native" | "wsl";
  codexWslDistro?: string;
  codexSafeMode?: "workspace-write" | "read-only";
  providerState?: CodexProviderState;
  helperBridge?: {
    host: string;
    port: number;
    token: string;
    bundlePath: string;
  };
}

interface CodexProviderState {
  threadId?: string;
  sessionFilePath?: string;
  forkSource?: {
    threadId: string;
    resumeAt?: string;
    sourceConversationId?: string;
  };
}

type RestartConfig = Omit<Partial<CodexConfig>, "workspacePath">;

type JsonRecord = Record<string, unknown>;
type QueueItem = ClauderoStreamEvent | { type: "__done" };
const MAX_CODEX_DIAGNOSTIC_EVENTS = 240;
const CODEX_BASE_INSTRUCTIONS = [
  "You are Claudero, an academic Zotero agent embedded in Zotero.",
  "Use Zotero MCP tools first for Zotero state, selected items, annotations, item metadata, evidence lookup, and safe writes.",
  "Use shell or Python only for local files, heavy PDF extraction, or fallback cases where MCP is unavailable or insufficient.",
  "When answering academic questions, preserve citation provenance with source, page, quote, and uncertainty whenever possible.",
].join("\n");

interface PendingQuestion {
  toolUseId: string;
  questions: unknown[];
}

interface PendingQuestionResolver {
  toolUseId: string;
  resolve: (answers: Record<string, string | string[]> | null) => void;
}

interface PendingExitPlanResolver {
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (decision: ExitPlanDecision | null) => void;
}

interface PendingRpc {
  method: string;
  startedAt: number;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

type CodexDiagnosticLevel = "info" | "warning" | "error";

export interface CodexDiagnosticEvent {
  ts: string;
  level: CodexDiagnosticLevel;
  event: string;
  data?: JsonRecord;
}

type CodexDiagnosticLogger = (
  event: string,
  data?: JsonRecord,
  level?: CodexDiagnosticLevel,
) => void;

export interface CodexExecutionTarget {
  method: "host-native" | "native-windows" | "wsl";
  platformFamily: "unix" | "windows";
  platformOs: "macos" | "linux" | "windows";
  distroName?: string;
}

export interface CodexPathMapper {
  target: CodexExecutionTarget;
  toTargetPath(path: string): string | null;
  toHostPath(path: string): string | null;
}

interface CodexLaunchSpec {
  command: string;
  args: string[];
  spawnCwd: string;
  targetCwd: string;
  pathMapper: CodexPathMapper;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function textValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function stringified(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolName(rawName: string): string {
  switch (rawName) {
    case "commandExecution":
    case "command_execution":
    case "shell":
    case "exec_command":
      return "Bash";
    case "fileChange":
    case "file_change":
      return "apply_patch";
    case "webSearch":
    case "web_search":
      return "WebSearch";
    case "request_user_input":
      return "AskUserQuestion";
    case "view_image":
      return "Read";
    case "update_plan":
    case "turn_plan":
      return "TodoWrite";
    default:
      return rawName || "tool";
  }
}

function normalizeToolInput(rawName: string, input: JsonRecord): JsonRecord {
  switch (rawName) {
    case "commandExecution":
    case "command_execution":
    case "shell":
    case "exec_command":
      return { command: textValue(input.command, input.cmd) };
    case "webSearch":
    case "web_search":
      return {
        query: textValue(input.query),
        queries: Array.isArray(input.queries) ? input.queries : undefined,
        url: textValue(input.url),
        pattern: textValue(input.pattern),
        action: asRecord(input.action) || undefined,
      };
    case "update_plan":
    case "turn_plan":
      return {
        todos: Array.isArray(input.todos)
          ? input.todos
          : Array.isArray(input.plan)
            ? input.plan
            : [],
      };
    default:
      return input;
  }
}

function parseArguments(value: unknown): JsonRecord {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed) || {};
    } catch {
      return { value };
    }
  }
  return asRecord(value) || {};
}

function resolveSandboxConfig(
  permissionMode: ClauderoPermissionMode | undefined,
): {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
} {
  if (permissionMode === "bypassPermissions") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
  if (permissionMode === "dontAsk") {
    return { approvalPolicy: "never", sandbox: "read-only" };
  }
  return {
    approvalPolicy: "on-request",
    sandbox:
      permissionMode === "plan" ||
      permissionMode === "auto" ||
      permissionMode === "default" ||
      permissionMode === "acceptEdits"
        ? "workspace-write"
        : "workspace-write",
  };
}

function effectiveCodexSandbox(config: CodexConfig, sandbox: string): string {
  if (sandbox !== "workspace-write") return sandbox;
  return config.codexSafeMode === "read-only" ? "read-only" : "workspace-write";
}

function buildSandboxPolicy(
  config: CodexConfig,
  sandbox: string,
  mapper: CodexPathMapper,
): JsonRecord {
  const effectiveSandbox = effectiveCodexSandbox(config, sandbox);
  if (effectiveSandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (effectiveSandbox === "read-only") {
    return {
      type: "readOnly",
      networkAccess: false,
    };
  }
  const writableRoots = [
    mapper.toTargetPath(config.workspacePath),
    mapper.toTargetPath(os.tmpdir()),
    mapper.target.platformFamily === "unix" ? "/tmp" : null,
    process.env.TMPDIR ? mapper.toTargetPath(process.env.TMPDIR) : null,
  ].filter((value): value is string => !!value && value.trim().length > 0);
  return {
    type: "workspaceWrite",
    writableRoots: [...new Set(writableRoots)],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function normalizeWindowsPath(value: string): string {
  let normalized = value.replace(/\//g, "\\");
  if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  return path.win32.normalize(normalized);
}

function normalizePosixPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function inferWslDistroFromWindowsPath(
  hostPath: string | null | undefined,
): string | undefined {
  if (!hostPath) return undefined;
  const normalized = hostPath.replace(/\//g, "\\");
  return normalized.match(/^\\\\wsl\$\\([^\\]+)(?:\\|$)/i)?.[1];
}

function parseDefaultWslDistroListOutput(output: string): string | undefined {
  for (const line of output.replace(/\uFEFF/g, "").split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("*")) continue;
    const candidate = trimmed
      .slice(1)
      .trimStart()
      .split(/\s{2,}/)[0]
      ?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

function resolveDefaultWslDistroName(): string | undefined {
  try {
    const output = execFileSync("wsl.exe", ["--list", "--verbose"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return parseDefaultWslDistroListOutput(output);
  } catch {
    return undefined;
  }
}

function maybeMapWindowsDriveToWsl(hostPath: string): string | null {
  const match = normalizeWindowsPath(hostPath).match(
    /^([A-Za-z]):(?:\\(.*))?$/,
  );
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const tail = (match[2] || "").replace(/\\/g, "/");
  return tail ? `/mnt/${drive}/${tail}` : `/mnt/${drive}`;
}

function maybeMapWslUncToLinux(
  hostPath: string,
  distroName?: string,
): string | null {
  const match = normalizeWindowsPath(hostPath).match(
    /^\\\\wsl\$\\([^\\]+)(?:\\(.*))?$/i,
  );
  if (!match) return null;
  if (distroName && match[1].toLowerCase() !== distroName.toLowerCase())
    return null;
  const tail = match[2] ? match[2].replace(/\\/g, "/") : "";
  return tail ? `/${tail}` : "/";
}

function maybeMapLinuxToWindowsDrive(targetPath: string): string | null {
  const match = normalizePosixPath(targetPath).match(
    /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/,
  );
  if (!match) return null;
  const drive = match[1].toUpperCase();
  const tail = match[2] ? match[2].replace(/\//g, "\\") : "";
  return tail ? `${drive}:\\${tail}` : `${drive}:\\`;
}

function maybeMapLinuxToWslUnc(
  targetPath: string,
  distroName?: string,
): string | null {
  if (!distroName) return null;
  const normalized = normalizePosixPath(targetPath);
  if (!normalized.startsWith("/")) return null;
  const tail =
    normalized === "/" ? "" : normalized.slice(1).replace(/\//g, "\\");
  return tail ? `\\\\wsl$\\${distroName}\\${tail}` : `\\\\wsl$\\${distroName}`;
}

function createPathMapper(target: CodexExecutionTarget): CodexPathMapper {
  if (target.method !== "wsl") {
    const toTargetPath = (value: string) =>
      target.platformFamily === "windows"
        ? normalizeWindowsPath(value)
        : normalizePosixPath(value);
    return {
      target,
      toTargetPath,
      toHostPath: toTargetPath,
    };
  }
  return {
    target,
    toTargetPath: (value) =>
      maybeMapWslUncToLinux(value, target.distroName) ||
      maybeMapWindowsDriveToWsl(value),
    toHostPath: (value) =>
      maybeMapLinuxToWindowsDrive(value) ||
      maybeMapLinuxToWslUnc(value, target.distroName),
  };
}

function resolveCodexExecutionTarget(
  config: CodexConfig,
): CodexExecutionTarget {
  if (process.platform !== "win32") {
    return {
      method: "host-native",
      platformFamily: "unix",
      platformOs: process.platform === "darwin" ? "macos" : "linux",
    };
  }
  if (config.codexInstallationMethod === "wsl") {
    return {
      method: "wsl",
      platformFamily: "unix",
      platformOs: "linux",
      distroName:
        config.codexWslDistro ||
        inferWslDistroFromWindowsPath(config.workspacePath) ||
        resolveDefaultWslDistroName(),
    };
  }
  return {
    method: "native-windows",
    platformFamily: "windows",
    platformOs: "windows",
  };
}

function buildCodexLaunchSpec(config: CodexConfig): CodexLaunchSpec {
  const target = resolveCodexExecutionTarget(config);
  const pathMapper = createPathMapper(target);
  const targetCwd = pathMapper.toTargetPath(config.workspacePath);
  const configOverrides = buildCodexMcpConfigOverrides(
    {
      ...config,
      mcpServers: buildCodexMcpServers(config, pathMapper),
    },
    pathMapper,
  );
  if (!targetCwd) {
    throw new Error(
      "Codex WSL mode only supports Windows drive paths and \\\\wsl$ workspace paths.",
    );
  }
  if (target.method === "wsl") {
    if (!target.distroName) {
      throw new Error(
        "Unable to determine WSL distro. Set Codex WSL distro in Claudero preferences.",
      );
    }
    return {
      command: "wsl.exe",
      args: [
        "--distribution",
        target.distroName,
        "--cd",
        targetCwd,
        config.codexPath?.trim() || "codex",
        "app-server",
        ...configOverrides,
        "--listen",
        "stdio://",
      ],
      spawnCwd: config.workspacePath,
      targetCwd,
      pathMapper,
    };
  }
  return {
    command: config.codexPath?.trim() || "codex",
    args: ["app-server", ...configOverrides, "--listen", "stdio://"],
    spawnCwd: config.workspacePath,
    targetCwd,
    pathMapper,
  };
}

function buildCodexMcpServers(
  config: CodexConfig,
  mapper: CodexPathMapper,
): Record<string, unknown> {
  const servers = { ...(config.mcpServers || {}) };
  if (
    config.enableZoteroMcp !== false &&
    config.zoteroEndpointUrl &&
    config.helperBridge?.bundlePath
  ) {
    servers.zotero = buildZoteroBridgeMcpServer({
      endpoint: config.zoteroEndpointUrl,
      helperUrl: `http://${config.helperBridge.host}:${config.helperBridge.port}`,
      token: config.helperBridge.token,
      bundlePath: config.helperBridge.bundlePath,
      nodeCommand: mapper.target.method === "wsl" ? "node" : process.execPath,
      mapper,
    });
  }
  return servers;
}

function normalizeEffort(value: string | undefined): string {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
    value || "",
  )
    ? value!
    : "medium";
}

function normalizeModel(value: string | undefined): string {
  return value?.trim() || "gpt-5.5";
}

function truncateDiagnosticText(
  value: unknown,
  limit = 600,
): string | undefined {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function redactLaunchArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push("[redacted]");
      redactNext = false;
      continue;
    }
    if (["--token", "--password", "--secret", "--api-key"].includes(arg)) {
      redacted.push(arg);
      redactNext = true;
      continue;
    }
    if (
      /token|secret|password|api[_-]?key|authorization|http_headers/i.test(arg)
    ) {
      redacted.push("[redacted sensitive argument]");
      continue;
    }
    redacted.push(arg);
  }
  return redacted;
}

function diagnosticError(error: unknown): JsonRecord {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: truncateDiagnosticText(error.stack, 1200),
    };
  }
  return { message: String(error) };
}

function summarizeInputForDiagnostics(input: unknown): JsonRecord {
  if (!Array.isArray(input)) return { type: typeof input };
  let textChars = 0;
  let imageCount = 0;
  const types: string[] = [];
  for (const entry of input) {
    const record = asRecord(entry);
    const type = textValue(record?.type) || typeof entry;
    types.push(type);
    if (type === "text") textChars += textValue(record?.text).length;
    if (type === "localImage") imageCount += 1;
  }
  return { count: input.length, types, textChars, imageCount };
}

function summarizeSandboxPolicyForDiagnostics(value: unknown): JsonRecord {
  const record = asRecord(value);
  if (!record) return {};
  const writableRoots = Array.isArray(record.writableRoots)
    ? record.writableRoots
    : [];
  return {
    type: textValue(record.type),
    networkAccess: record.networkAccess,
    writableRoots: writableRoots.slice(0, 8),
    writableRootCount: writableRoots.length,
    excludeTmpdirEnvVar: record.excludeTmpdirEnvVar,
    excludeSlashTmp: record.excludeSlashTmp,
  };
}

function summarizeRpcParams(method: string, params: unknown): JsonRecord {
  const record = asRecord(params);
  if (!record) return {};
  if (method === "initialize") {
    return {
      clientInfo: record.clientInfo,
      capabilities: record.capabilities,
    };
  }
  if (method === "thread/start" || method === "thread/resume") {
    return {
      threadId: textValue(record.threadId) || undefined,
      cwd: textValue(record.cwd) || undefined,
      model: textValue(record.model),
      approvalPolicy: textValue(record.approvalPolicy),
      sandbox: textValue(record.sandbox),
      experimentalRawEvents: record.experimentalRawEvents,
      persistExtendedHistory: record.persistExtendedHistory,
      hasBaseInstructions: typeof record.baseInstructions === "string",
    };
  }
  if (method === "thread/fork") {
    return { threadId: textValue(record.threadId) };
  }
  if (method === "thread/rollback") {
    return {
      threadId: textValue(record.threadId),
      numTurns: record.numTurns,
    };
  }
  if (method === "turn/start") {
    return {
      threadId: textValue(record.threadId),
      input: summarizeInputForDiagnostics(record.input),
      approvalPolicy: textValue(record.approvalPolicy),
      model: textValue(record.model),
      effort: textValue(record.effort),
      summary: textValue(record.summary),
      sandboxPolicy: summarizeSandboxPolicyForDiagnostics(record.sandboxPolicy),
    };
  }
  if (method === "turn/interrupt") {
    return {
      threadId: textValue(record.threadId),
      turnId: textValue(record.turnId),
    };
  }
  return { keys: Object.keys(record).sort() };
}

function summarizeRpcResult(method: string, result: unknown): JsonRecord {
  const record = asRecord(result);
  if (!record) return { type: typeof result };
  const thread = asRecord(record.thread);
  const turn = asRecord(record.turn);
  if (thread || turn) {
    return {
      threadId: textValue(thread?.id),
      threadPath: textValue(thread?.path),
      turnId: textValue(turn?.id),
      turnStatus: textValue(turn?.status),
      turnItemCount: Array.isArray(turn?.items) ? turn!.items.length : 0,
    };
  }
  return { keys: Object.keys(record).sort() };
}

function summarizeNotification(method: string, params: unknown): JsonRecord {
  const record = asRecord(params);
  if (!record) return { method };
  const item = asRecord(record.item);
  const turn = asRecord(record.turn);
  const error = asRecord(record.error);
  return {
    method,
    threadId: textValue(record.threadId),
    turnId: textValue(record.turnId, record.turn_id, turn?.id),
    itemId: textValue(record.itemId, item?.id),
    itemType: textValue(item?.type, record.type),
    error: error
      ? truncateDiagnosticText(
          textValue(error.message, error.codexErrorInfo) ||
            JSON.stringify(error),
        )
      : undefined,
  };
}

function normalizeAnswers(value: string | string[]): string[] {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

class CodexRpcTransport {
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandlers = new Map<
    string,
    (id: string | number, params: unknown) => Promise<unknown>
  >();
  private stderrTail = "";

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly debug?: CodexDiagnosticLogger,
  ) {}

  start(): void {
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));
    this.proc.on("exit", (code, signal) => {
      this.debug?.(
        "process.exit",
        {
          code,
          signal,
          pendingRequests: this.pending.size,
          stderrTail: truncateDiagnosticText(this.stderrTail),
        },
        "error",
      );
      this.rejectAll(new Error("Codex app-server exited"));
    });
    this.proc.stderr.on("data", (chunk: Buffer) => {
      // Drain stderr so a noisy app-server cannot block on a full pipe, but keep
      // a small tail for diagnostics when a turn stalls before any event arrives.
      const text = stripAnsi(chunk.toString("utf8"));
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      if (text.trim()) {
        this.debug?.(
          "process.stderr",
          {
            bytes: chunk.length,
            preview: truncateDiagnosticText(text),
          },
          "warning",
        );
      }
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextId++;
    const startedAt = Date.now();
    this.debug?.("rpc.request", {
      id,
      method,
      timeoutMs,
      params: summarizeRpcParams(method, params),
    });
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              this.debug?.(
                "rpc.timeout",
                {
                  id,
                  method,
                  timeoutMs,
                  elapsedMs: Date.now() - startedAt,
                  pendingRequests: this.getPendingRequests(),
                  stderrTail: truncateDiagnosticText(this.stderrTail),
                },
                "error",
              );
              reject(new Error(`Codex request timed out: ${method}`));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        method,
        startedAt,
        timeoutMs,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.debug?.("rpc.notify", {
      method,
      params:
        params === undefined ? undefined : summarizeRpcParams(method, params),
    });
    this.send(
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params },
    );
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  onServerRequest(
    method: string,
    handler: (id: string | number, params: unknown) => Promise<unknown>,
  ): void {
    this.requestHandlers.set(method, handler);
  }

  dispose(): void {
    this.rejectAll(new Error("Codex transport disposed"));
  }

  getStderrTail(): string {
    return this.stderrTail.trim();
  }

  getPendingRequests(): JsonRecord[] {
    return [...this.pending.entries()].map(([id, pending]) => ({
      id,
      method: pending.method,
      elapsedMs: Date.now() - pending.startedAt,
      timeoutMs: pending.timeoutMs,
    }));
  }

  private send(message: unknown): void {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
  }

  private handleLine(line: string): void {
    let message: JsonRecord;
    try {
      message = JSON.parse(line) as JsonRecord;
    } catch {
      return;
    }
    const id = message.id as number | string | undefined;
    const method =
      typeof message.method === "string" ? message.method : undefined;
    if ((typeof id === "number" || typeof id === "string") && !method) {
      this.handleResponse(id, message);
      return;
    }
    if (method && id === undefined) {
      this.notificationHandlers.get(method)?.(message.params);
      return;
    }
    if (method && id !== undefined) {
      this.handleServerRequest(id, method, message.params);
    }
  }

  private handleResponse(id: number | string, message: JsonRecord): void {
    const numericId = typeof id === "number" ? id : Number(id);
    const pending = Number.isFinite(numericId)
      ? this.pending.get(numericId)
      : undefined;
    if (!pending) return;
    this.pending.delete(numericId);
    if (pending.timer) clearTimeout(pending.timer);
    const error = asRecord(message.error);
    if (error) {
      this.debug?.(
        "rpc.response.error",
        {
          id: numericId,
          method: pending.method,
          elapsedMs: Date.now() - pending.startedAt,
          error: truncateDiagnosticText(
            textValue(error.message) || JSON.stringify(error),
          ),
        },
        "error",
      );
      pending.reject(new Error(textValue(error.message) || "Codex error"));
      return;
    }
    this.debug?.("rpc.response", {
      id: numericId,
      method: pending.method,
      elapsedMs: Date.now() - pending.startedAt,
      result: summarizeRpcResult(pending.method, message.result),
    });
    pending.resolve(message.result);
  }

  private handleServerRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): void {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.debug?.("rpc.server_request.unhandled", { id, method }, "warning");
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unhandled request: ${method}` },
      });
      return;
    }
    this.debug?.("rpc.server_request", {
      id,
      method,
      params: summarizeNotification(method, params),
    });
    handler(id, params).then(
      (result) => {
        this.debug?.("rpc.server_request.response", { id, method });
        this.send({ jsonrpc: "2.0", id, result });
      },
      (error) => {
        this.debug?.(
          "rpc.server_request.error",
          { id, method, error: diagnosticError(error) },
          "error",
        );
        this.send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexPersistentQueryManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private transport: CodexRpcTransport | null = null;
  private config: CodexConfig | null = null;
  private launchSpec: CodexLaunchSpec | null = null;
  private threadId: string | null = null;
  private sessionFilePath: string | null = null;
  private pendingFork: NonNullable<CodexProviderState["forkSource"]> | null =
    null;
  private loadedThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private currentThreadId: string | null = null;
  private pendingNotifications: Array<{ method: string; params: unknown }> = [];
  private queue: QueueItem[] = [];
  private queueResolve: (() => void) | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private pendingQuestionResolver: PendingQuestionResolver | null = null;
  private pendingExitPlan: PendingExitPlanResolver | null = null;
  private latestPlanInput: Record<string, unknown> | null = null;
  private planApprovedTurnIds = new Set<string>();
  private finished = false;
  private startedToolIds = new Set<string>();
  private agentMessageDeltaIds = new Set<string>();
  private rawToolNamesById = new Map<string, string>();
  private rawToolInputsById = new Map<string, JsonRecord>();
  private streamedAssistantText = "";
  private planUpdateCounter = 0;
  private diagnosticEvents: CodexDiagnosticEvent[] = [];
  private latestMcpStatus: JsonRecord | null = null;
  private turnStreamActive = false;
  private runtimeUnhealthyReason: string | null = null;
  private contextCompactionActive = false;
  private toolPolicy: AcademicToolPolicy | undefined;

  constructor(private readonly permissionManager: PermissionManager) {}

  get isActive(): boolean {
    return (
      !this.runtimeUnhealthyReason &&
      isProcessAlive(this.proc) &&
      !!this.transport
    );
  }

  get isBusy(): boolean {
    return this.turnStreamActive;
  }

  get workspacePath(): string | null {
    return this.config?.workspacePath || null;
  }

  setToolPolicy(policy: AcademicToolPolicy | undefined): void {
    this.toolPolicy = policy;
    this.permissionManager.setToolPolicy(policy);
  }

  getMcpServerNames(): string[] {
    if (!this.config || !this.launchSpec) return [];
    return Object.keys(
      buildCodexMcpServers(this.config, this.launchSpec.pathMapper),
    ).sort();
  }

  async listModels(): Promise<ProviderModelDescriptor[]> {
    if (!this.transport || !this.isActive) {
      throw new Error("Codex runtime is not initialized.");
    }
    const models: ProviderModelDescriptor[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const response = await this.transport.request<JsonRecord>("model/list", {
        ...(cursor ? { cursor } : {}),
        includeHidden: false,
        limit: 100,
      });
      const page = parseCodexModelListPage(response);
      for (const model of page.models) {
        if (seen.has(model.value)) continue;
        seen.add(model.value);
        models.push(model);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    this.debug("models.list", {
      count: models.length,
      defaultModel: models.find((model) => model.isDefault)?.value,
    });
    return models;
  }

  getDiagnostics(): {
    events: CodexDiagnosticEvent[];
    pendingRequests: JsonRecord[];
    launch: JsonRecord | null;
    process: JsonRecord | null;
    mcpStatus: JsonRecord | null;
  } {
    return {
      events: this.diagnosticEvents.slice(-160),
      pendingRequests: this.transport?.getPendingRequests() || [],
      launch: this.launchSpec
        ? {
            command: this.launchSpec.command,
            args: redactLaunchArgs(this.launchSpec.args),
            spawnCwd: this.launchSpec.spawnCwd,
            targetCwd: this.launchSpec.targetCwd,
            target: this.launchSpec.pathMapper.target,
          }
        : null,
      process: this.proc
        ? {
            pid: this.proc.pid,
            killed: this.proc.killed,
            exitCode: this.proc.exitCode,
            signalCode: this.proc.signalCode,
            unhealthyReason: this.runtimeUnhealthyReason,
          }
        : null,
      mcpStatus: this.latestMcpStatus,
    };
  }

  async initialize(config: CodexConfig): Promise<void> {
    const startedAt = Date.now();
    await mkdir(config.workspacePath, { recursive: true });
    this.close();
    this.runtimeUnhealthyReason = null;
    this.debug("initialize.start", {
      workspacePath: config.workspacePath,
      codexPath: config.codexPath,
      installationMethod: config.codexInstallationMethod || "native",
      safeMode: config.codexSafeMode || "workspace-write",
      model: normalizeModel(config.model),
      effort: normalizeEffort(config.effort),
      enableZoteroMcp: config.enableZoteroMcp !== false,
      customMcpServerCount: Object.keys(config.mcpServers || {}).length,
      environmentKeys: Object.keys(config.environment || {}).sort(),
    });
    this.config = config;
    this.launchSpec = buildCodexLaunchSpec(config);
    this.debug("initialize.launch", {
      command: this.launchSpec.command,
      args: this.launchSpec.args,
      spawnCwd: this.launchSpec.spawnCwd,
      targetCwd: this.launchSpec.targetCwd,
      target: this.launchSpec.pathMapper.target,
      mcpServers: this.getMcpServerNames(),
    });
    this.threadId = config.providerState?.threadId || null;
    this.sessionFilePath = config.providerState?.sessionFilePath || null;
    this.pendingFork = config.providerState?.forkSource || null;
    const env = { ...process.env, ...config.environment };
    this.proc = spawn(this.launchSpec.command, this.launchSpec.args, {
      cwd: this.launchSpec.spawnCwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.debug("initialize.spawned", { pid: this.proc.pid });
    this.transport = new CodexRpcTransport(this.proc, (event, data, level) =>
      this.debug(event, data, level),
    );
    this.transport.start();
    this.wireTransportHandlers();
    await this.transport.request("initialize", {
      clientInfo: { name: "claudero", title: "Claudero", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.transport.notify("initialized", {});
    await this.refreshMcpServerStatus("initialize", true);
    const startupStderr = this.transport.getStderrTail();
    if (hasModelsCacheSchemaError(startupStderr)) {
      this.runtimeUnhealthyReason = "incompatible_models_cache";
      throw new Error(
        "This Codex CLI is older than the models cache written by Codex Desktop. Configure a newer Codex executable or use the executable bundled with ChatGPT Desktop.",
      );
    }
    this.debug("initialize.complete", {
      elapsedMs: Date.now() - startedAt,
      active: this.isActive,
    });
  }

  async *sendMessageEvents(
    prompt: string,
    images?: ImageInput[],
  ): AsyncIterable<ClauderoStreamEvent> {
    if (this.turnStreamActive) {
      throw new Error("A Codex turn is already in progress.");
    }
    if (!this.config || !this.transport || !this.launchSpec) {
      throw new Error("Codex runtime not initialized. Call /init first.");
    }
    if (!this.isActive) {
      throw new Error(
        "Codex app-server is not running. Reinitialize the runtime.",
      );
    }
    this.turnStreamActive = true;
    const startedAt = Date.now();
    this.debug("turn.stream.start", {
      promptChars: prompt.length,
      imageCount: images?.length || 0,
      threadId: this.threadId || undefined,
      loadedThreadId: this.loadedThreadId || undefined,
      model: normalizeModel(this.config.model),
      effort: normalizeEffort(this.config.effort),
    });
    this.resetTurnState();
    const tempDirs: string[] = [];
    try {
      const threadId = await this.ensureThread();
      this.currentThreadId = threadId;
      this.debug("turn.thread.ready", {
        threadId,
        sessionFilePath: this.sessionFilePath || undefined,
      });
      yield { type: "session", session: this.getSessionState() };
      if (prompt.trim() === "/compact") {
        this.debug("turn.compact.start", { threadId });
        await this.transport.request("thread/compact/start", { threadId });
        this.flushPendingNotifications();
        while (true) {
          const item = await this.nextQueueItem();
          if (item.type === "__done") break;
          yield item;
        }
        return;
      }
      const input = await this.buildInput(prompt, images, tempDirs);
      this.debug("turn.input.ready", summarizeInputForDiagnostics(input));
      const configuredSandbox = resolveSandboxConfig(
        this.config.permissionMode,
      );
      const sandboxConfig =
        this.toolPolicy && !this.toolPolicy.allowScripts
          ? {
              approvalPolicy: "on-request" as const,
              sandbox: "read-only" as const,
            }
          : configuredSandbox;
      const sandboxPolicy = buildSandboxPolicy(
        this.config,
        sandboxConfig.sandbox,
        this.launchSpec.pathMapper,
      );
      this.debug("turn.start.request", {
        threadId,
        approvalPolicy: sandboxConfig.approvalPolicy,
        model: normalizeModel(this.config.model),
        effort: normalizeEffort(this.config.effort),
        sandboxPolicy: summarizeSandboxPolicyForDiagnostics(sandboxPolicy),
      });
      const result = await this.transport.request<JsonRecord>(
        "turn/start",
        {
          threadId,
          input,
          approvalPolicy: sandboxConfig.approvalPolicy,
          model: normalizeModel(this.config.model),
          effort: normalizeEffort(this.config.effort),
          summary: "detailed",
          sandboxPolicy,
        },
        30_000,
      );
      const turn = asRecord(result.turn);
      this.currentTurnId = textValue(turn?.id);
      this.debug("turn.start.response", {
        threadId,
        turnId: this.currentTurnId || undefined,
        status: textValue(turn?.status),
        itemCount: Array.isArray(turn?.items) ? turn!.items.length : 0,
      });
      this.handleTurnSnapshot(turn);
      yield { type: "session", session: this.getSessionState() };
      this.flushPendingNotifications();

      while (true) {
        const item = await this.nextQueueItem();
        if (item.type === "__done") break;
        yield item;
      }
      this.debug("turn.stream.complete", {
        elapsedMs: Date.now() - startedAt,
        threadId,
        turnId: this.currentTurnId || undefined,
      });
    } catch (error) {
      this.debug(
        "turn.stream.error",
        {
          elapsedMs: Date.now() - startedAt,
          error: diagnosticError(error),
        },
        "error",
      );
      throw error;
    } finally {
      for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      this.resetTurnState();
      this.turnStreamActive = false;
    }
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
  }

  getSessionState(): {
    provider: "codex";
    threadId?: string;
    sessionFilePath?: string;
    turnId?: string;
    appServerStderr?: string;
  } {
    return {
      provider: "codex",
      threadId: this.threadId || undefined,
      sessionFilePath: this.sessionFilePath || undefined,
      turnId: this.currentTurnId || undefined,
      appServerStderr: this.transport?.getStderrTail() || undefined,
    };
  }

  getPendingExitPlan(): PendingExitPlan | null {
    if (!this.pendingExitPlan) return null;
    return {
      toolUseId: this.pendingExitPlan.toolUseId,
      input: this.pendingExitPlan.input,
    };
  }

  answerExitPlan(toolUseId: string, decision: ExitPlanDecision): boolean {
    if (!this.pendingExitPlan || this.pendingExitPlan.toolUseId !== toolUseId) {
      return false;
    }
    const pending = this.pendingExitPlan;
    this.pendingExitPlan = null;
    pending.resolve(decision);
    return true;
  }

  answerQuestion(
    toolUseId: string,
    answers: Record<string, string | string[]>,
  ): boolean {
    if (
      !this.pendingQuestionResolver ||
      this.pendingQuestionResolver.toolUseId !== toolUseId
    ) {
      return false;
    }
    const pending = this.pendingQuestionResolver;
    this.pendingQuestionResolver = null;
    this.pendingQuestion = null;
    pending.resolve(answers);
    return true;
  }

  cancelPendingQuestion(): boolean {
    if (!this.pendingQuestionResolver) return false;
    const pending = this.pendingQuestionResolver;
    this.pendingQuestionResolver = null;
    this.pendingQuestion = null;
    pending.resolve(null);
    return true;
  }

  cancelPendingExitPlan(): boolean {
    if (!this.pendingExitPlan) return false;
    const pending = this.pendingExitPlan;
    this.pendingExitPlan = null;
    pending.resolve(null);
    return true;
  }

  async setPermissionMode(mode: string | undefined): Promise<void> {
    if (this.config) {
      this.config.permissionMode = (mode || "auto") as ClauderoPermissionMode;
    }
  }

  async supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return [
      {
        name: "compact",
        description: "Compact the current Codex thread",
      },
    ];
  }

  async reloadSkills(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return this.supportedCommands();
  }

  cancelActiveTurn(): void {
    this.cancelPendingQuestion();
    this.cancelPendingExitPlan();
    const transport = this.transport;
    const threadId = this.currentThreadId || this.threadId;
    const turnId = this.currentTurnId;
    this.debug("turn.cancel", {
      threadId: threadId || undefined,
      turnId: turnId || undefined,
      hasTransport: !!transport,
    });
    if (transport && threadId && turnId) {
      transport
        .request("turn/interrupt", { threadId, turnId }, 1_000)
        .catch(() => {});
    }
    if (!this.finished) {
      this.finished = true;
      this.enqueue({ type: "__done" });
    }
  }

  close(): void {
    this.debug("runtime.close", {
      active: this.isActive,
      pid: this.proc?.pid,
      threadId: this.threadId || undefined,
      pendingRequests: this.transport?.getPendingRequests() || [],
    });
    this.cancelPendingQuestion();
    this.cancelPendingExitPlan();
    this.transport?.dispose();
    this.transport = null;
    const proc = this.proc;
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
        }
      }, 3000);
    }
    this.proc = null;
    this.threadId = null;
    this.sessionFilePath = null;
    this.pendingFork = null;
    this.loadedThreadId = null;
    this.launchSpec = null;
    this.config = null;
    this.runtimeUnhealthyReason = null;
    this.turnStreamActive = false;
    this.resetTurnState();
  }

  requiresRestart(newConfig: RestartConfig): boolean {
    if (!this.config) return false;
    return (
      (newConfig.codexPath !== undefined &&
        newConfig.codexPath !== this.config.codexPath) ||
      (newConfig.environment !== undefined &&
        JSON.stringify(newConfig.environment) !==
          JSON.stringify(this.config.environment)) ||
      (newConfig.mcpServers !== undefined &&
        JSON.stringify(newConfig.mcpServers || {}) !==
          JSON.stringify(this.config.mcpServers || {})) ||
      (newConfig.mcpDisabledTools !== undefined &&
        JSON.stringify([...(newConfig.mcpDisabledTools || [])].sort()) !==
          JSON.stringify([...(this.config.mcpDisabledTools || [])].sort())) ||
      (newConfig.zoteroEndpointUrl !== undefined &&
        newConfig.zoteroEndpointUrl !== this.config.zoteroEndpointUrl) ||
      (newConfig.conversationId !== undefined &&
        newConfig.conversationId !== this.config.conversationId) ||
      (newConfig.codexInstallationMethod !== undefined &&
        newConfig.codexInstallationMethod !==
          this.config.codexInstallationMethod) ||
      (newConfig.codexWslDistro !== undefined &&
        newConfig.codexWslDistro !== this.config.codexWslDistro) ||
      (newConfig.providerState !== undefined &&
        JSON.stringify(newConfig.providerState || {}) !==
          JSON.stringify(this.getComparableProviderState()))
    );
  }

  updateConfig(newConfig: RestartConfig): void {
    if (!this.config) return;
    this.config = { ...this.config, ...newConfig };
    if (newConfig.providerState)
      this.applyProviderState(newConfig.providerState);
    this.debug("config.update", {
      keys: Object.keys(newConfig).sort(),
      model: normalizeModel(this.config.model),
      effort: normalizeEffort(this.config.effort),
      safeMode: this.config.codexSafeMode || "workspace-write",
    });
  }

  private debug(
    event: string,
    data: JsonRecord = {},
    level: CodexDiagnosticLevel = "info",
  ): void {
    this.diagnosticEvents.push({
      ts: new Date().toISOString(),
      level,
      event,
      data,
    });
    while (this.diagnosticEvents.length > MAX_CODEX_DIAGNOSTIC_EVENTS) {
      this.diagnosticEvents.shift();
    }
  }

  private getComparableProviderState(): CodexProviderState {
    return {
      ...(this.threadId ? { threadId: this.threadId } : {}),
      ...(this.sessionFilePath
        ? { sessionFilePath: this.sessionFilePath }
        : {}),
      ...(this.pendingFork ? { forkSource: this.pendingFork } : {}),
    };
  }

  private applyProviderState(state: CodexProviderState): void {
    this.threadId = state.threadId || this.threadId;
    this.sessionFilePath = state.sessionFilePath || this.sessionFilePath;
    this.pendingFork = state.forkSource || null;
  }

  private async ensureThread(): Promise<string> {
    if (!this.config || !this.transport) {
      throw new Error("Codex runtime not initialized");
    }
    if (!this.launchSpec) {
      throw new Error("Codex launch spec not initialized");
    }
    const sandboxConfig = resolveSandboxConfig(this.config.permissionMode);
    this.debug("thread.ensure.start", {
      threadId: this.threadId || undefined,
      loadedThreadId: this.loadedThreadId || undefined,
      hasPendingFork: !!this.pendingFork,
    });
    if (this.pendingFork?.threadId) {
      const fork = this.pendingFork;
      this.debug("thread.fork.start", {
        sourceThreadId: fork.threadId,
        resumeAt: fork.resumeAt,
      });
      const forkResult = await this.transport.request<JsonRecord>(
        "thread/fork",
        {
          threadId: fork.threadId,
        },
      );
      const forkThread = asRecord(forkResult.thread);
      const forkThreadId = textValue(forkThread?.id);
      if (!forkThreadId) throw new Error("Codex did not return fork thread id");
      const forkThreadPath = textValue(forkThread?.path);
      this.threadId = forkThreadId;
      this.sessionFilePath = this.toHostSessionPath(forkThreadPath);

      this.debug("thread.fork.resume", {
        threadId: forkThreadId,
        sessionFilePath: this.sessionFilePath || undefined,
      });
      await this.transport.request("thread/resume", {
        threadId: forkThreadId,
        cwd: this.launchSpec.targetCwd,
        model: normalizeModel(this.config.model),
        approvalPolicy: sandboxConfig.approvalPolicy,
        sandbox: effectiveCodexSandbox(this.config, sandboxConfig.sandbox),
        config: this.buildThreadConfigOverrides(),
        baseInstructions: CODEX_BASE_INSTRUCTIONS,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      });

      const turns = Array.isArray(forkThread?.turns) ? forkThread!.turns : [];
      if (fork.resumeAt && turns.length > 0) {
        const checkpointIndex = turns.findIndex((turn) => {
          const record = asRecord(turn);
          return textValue(record?.id) === fork.resumeAt;
        });
        if (checkpointIndex >= 0) {
          const numTurns = turns.length - checkpointIndex - 1;
          if (numTurns > 0) {
            await this.transport.request("thread/rollback", {
              threadId: forkThreadId,
              numTurns,
            });
          }
        }
      }

      this.loadedThreadId = forkThreadId;
      this.pendingFork = null;
      this.debug("thread.fork.ready", { threadId: forkThreadId });
      return forkThreadId;
    }
    if (this.threadId && this.loadedThreadId === this.threadId) {
      this.debug("thread.ensure.reuse_loaded", { threadId: this.threadId });
      return this.threadId;
    }
    if (this.threadId && this.loadedThreadId !== this.threadId) {
      this.debug("thread.resume.start", { threadId: this.threadId });
      const result = await this.transport.request<JsonRecord>("thread/resume", {
        threadId: this.threadId,
        cwd: this.launchSpec.targetCwd,
        model: normalizeModel(this.config.model),
        approvalPolicy: sandboxConfig.approvalPolicy,
        sandbox: effectiveCodexSandbox(this.config, sandboxConfig.sandbox),
        config: this.buildThreadConfigOverrides(),
        baseInstructions: CODEX_BASE_INSTRUCTIONS,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      });
      const thread = asRecord(result.thread);
      this.threadId = textValue(thread?.id) || this.threadId;
      this.sessionFilePath =
        this.toHostSessionPath(textValue(thread?.path)) || this.sessionFilePath;
      this.loadedThreadId = this.threadId;
      this.debug("thread.resume.ready", {
        threadId: this.threadId,
        sessionFilePath: this.sessionFilePath || undefined,
      });
      await this.refreshMcpServerStatus("thread.resume", false);
      return this.threadId;
    }
    const threadConfig = this.buildThreadConfigOverrides();
    this.debug("thread.start.start", {
      cwd: this.launchSpec.targetCwd,
      model: normalizeModel(this.config.model),
      approvalPolicy: sandboxConfig.approvalPolicy,
      sandbox: effectiveCodexSandbox(this.config, sandboxConfig.sandbox),
      configKeys: Object.keys(threadConfig || {}).sort(),
    });
    const result = await this.transport.request<JsonRecord>("thread/start", {
      model: normalizeModel(this.config.model),
      cwd: this.launchSpec.targetCwd,
      approvalPolicy: sandboxConfig.approvalPolicy,
      sandbox: effectiveCodexSandbox(this.config, sandboxConfig.sandbox),
      config: threadConfig,
      baseInstructions: CODEX_BASE_INSTRUCTIONS,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });
    const thread = asRecord(result.thread);
    this.threadId = textValue(thread?.id);
    this.sessionFilePath = this.toHostSessionPath(textValue(thread?.path));
    if (!this.threadId) throw new Error("Codex did not return a thread id");
    this.loadedThreadId = this.threadId;
    this.debug("thread.start.ready", {
      threadId: this.threadId,
      sessionFilePath: this.sessionFilePath || undefined,
    });
    await this.refreshMcpServerStatus("thread.start", false);
    return this.threadId;
  }

  private buildThreadConfigOverrides(): JsonRecord | undefined {
    if (!this.config || !this.launchSpec) return undefined;
    const config = buildCodexMcpThreadConfig(
      {
        ...this.config,
        mcpServers: buildCodexMcpServers(
          this.config,
          this.launchSpec.pathMapper,
        ),
      },
      this.launchSpec.pathMapper,
    );
    return Object.keys(config).length ? config : undefined;
  }

  private async refreshMcpServerStatus(
    reason: string,
    reload: boolean,
  ): Promise<void> {
    if (!this.transport) return;
    const expectedServers = this.getMcpServerNames();
    if (expectedServers.length === 0) {
      this.latestMcpStatus = { reason, expectedServers, servers: [] };
      return;
    }
    const threadId = this.currentThreadId || this.threadId || undefined;
    const status: JsonRecord = { reason, expectedServers, threadId };
    if (reload) {
      try {
        this.debug("mcp.reload.start", { reason, expectedServers });
        await this.transport.request("config/mcpServer/reload", undefined);
        this.debug("mcp.reload.complete", { reason });
      } catch (error) {
        status.reloadError = diagnosticError(error);
        this.debug(
          "mcp.reload.error",
          { reason, error: diagnosticError(error) },
          "warning",
        );
      }
    }
    try {
      const response = await this.transport.request<JsonRecord>(
        "mcpServerStatus/list",
        {
          detail: "toolsAndAuthOnly",
          ...(threadId ? { threadId } : {}),
        },
      );
      const data = Array.isArray(response.data) ? response.data : [];
      const servers = data.map((entry) => {
        const server = asRecord(entry) || {};
        const tools = asRecord(server.tools) || {};
        return {
          name: textValue(server.name),
          toolCount: Object.keys(tools).length,
          toolNames: Object.keys(tools).sort(),
          authStatus: server.authStatus,
        };
      });
      status.servers = servers;
      status.serverCount = servers.length;
      status.nextCursor = response.nextCursor ?? null;
      this.latestMcpStatus = status;
      this.debug("mcp.status.loaded", {
        reason,
        threadId,
        expectedServers,
        servers,
      });
    } catch (error) {
      status.statusError = diagnosticError(error);
      this.latestMcpStatus = status;
      this.debug(
        "mcp.status.error",
        { reason, error: diagnosticError(error) },
        "warning",
      );
    }
  }

  private toHostSessionPath(targetPath: string | undefined): string | null {
    if (!targetPath || !this.launchSpec) return null;
    return this.launchSpec.pathMapper.toHostPath(targetPath) || targetPath;
  }

  private async buildInput(
    prompt: string,
    images: ImageInput[] | undefined,
    tempDirs: string[],
  ): Promise<JsonRecord[]> {
    const input: JsonRecord[] = [];
    if (images?.length) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "claudero-codex-"));
      tempDirs.push(dir);
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img?.data) continue;
        const ext =
          img.media_type === "image/jpeg" || img.media_type === "image/jpg"
            ? "jpg"
            : img.media_type === "image/webp"
              ? "webp"
              : img.media_type === "image/gif"
                ? "gif"
                : "png";
        const filePath = path.join(dir, `${i + 1}.${ext}`);
        await writeFile(filePath, Buffer.from(img.data, "base64"));
        input.push({
          type: "localImage",
          path: this.launchSpec?.pathMapper.toTargetPath(filePath) || filePath,
        });
      }
    }
    input.push({ type: "text", text: prompt, text_elements: [] });
    return input;
  }

  private wireTransportHandlers(): void {
    if (!this.transport) return;
    const methods = [
      "item/agentMessage/delta",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "item/plan/delta",
      "item/started",
      "item/completed",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/fileChange/patchUpdated",
      "rawResponseItem/completed",
      "thread/tokenUsage/updated",
      "turn/started",
      "turn/plan/updated",
      "turn/completed",
      "event_msg",
      "error",
      "serverRequest/resolved",
    ];
    for (const method of methods) {
      this.transport.onNotification(method, (params) =>
        this.handleNotification(method, params),
      );
    }
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/tool/call",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "applyPatchApproval",
      "execCommandApproval",
    ]) {
      this.transport.onServerRequest(method, (_id, params) =>
        this.handleServerRequest(method, params),
      );
    }
  }

  private handleNotification(method: string, params: unknown): void {
    this.debug("notification.received", summarizeNotification(method, params));
    if (method === "turn/started") {
      const record = asRecord(params);
      const turn = asRecord(record?.turn);
      const threadId = textValue(record?.threadId);
      const turnId = textValue(turn?.id);
      if (threadId === this.currentThreadId && !this.currentTurnId && turnId) {
        this.currentTurnId = turnId;
        this.enqueue({ type: "session", session: this.getSessionState() });
        this.flushPendingNotifications();
      }
      return;
    }
    if (method === "serverRequest/resolved") {
      this.cancelPendingQuestion();
      return;
    }
    if (!this.routeNotification(method, params)) return;

    switch (method) {
      case "item/agentMessage/delta": {
        const record = asRecord(params);
        const itemId = textValue(record?.itemId);
        if (itemId) this.agentMessageDeltaIds.add(itemId);
        const delta = textValue(record?.delta);
        this.enqueueAssistantDelta(delta);
        break;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = textValue(asRecord(params)?.delta);
        if (delta) this.enqueue({ type: "thinking", text: delta });
        break;
      }
      case "item/plan/delta": {
        const delta = textValue(asRecord(params)?.delta);
        if (delta) this.enqueue({ type: "text_delta", text: delta });
        break;
      }
      case "item/started":
        this.handleItemStarted(asRecord(asRecord(params)?.item));
        break;
      case "item/completed":
        this.handleItemCompleted(asRecord(asRecord(params)?.item));
        break;
      case "item/fileChange/patchUpdated":
        this.handleFileChangePatchUpdated(asRecord(params));
        break;
      case "rawResponseItem/completed":
        this.handleRawResponseItem(asRecord(asRecord(params)?.item));
        break;
      case "thread/tokenUsage/updated":
        this.handleUsage(asRecord(params));
        break;
      case "turn/plan/updated":
        this.handlePlanUpdated(asRecord(params));
        break;
      case "event_msg":
        this.handleEventMessage(asRecord(params));
        break;
      case "turn/completed":
        this.finishTurn();
        break;
      case "error": {
        const error = asRecord(asRecord(params)?.error);
        const message =
          textValue(error?.message, error?.codexErrorInfo) ||
          "Codex request failed.";
        const reconnect = parseCodexReconnectStatus(message);
        if (reconnect) {
          this.enqueue({
            type: "connection_status",
            status: "reconnecting",
            attempt: reconnect.attempt,
            maxAttempts: reconnect.maxAttempts,
          });
          break;
        }
        this.contextCompactionActive = false;
        this.enqueue({
          type: "error",
          error: message,
        });
        this.finishTurn();
        break;
      }
    }
  }

  private routeNotification(method: string, params: unknown): boolean {
    const record = asRecord(params);
    if (!record) return true;
    const threadId = textValue(record.threadId);
    const turnId =
      method === "turn/completed"
        ? textValue(asRecord(record.turn)?.id)
        : textValue(record.turnId, record.turn_id);
    if (!threadId || !turnId) return true;
    if (threadId !== this.currentThreadId) {
      this.debug(
        "notification.ignored_thread",
        {
          method,
          threadId,
          currentThreadId: this.currentThreadId || undefined,
          turnId,
        },
        "warning",
      );
      return false;
    }
    if (!this.currentTurnId) {
      this.pendingNotifications.push({ method, params });
      this.debug("notification.pending_before_turn_id", {
        method,
        threadId,
        turnId,
        pendingCount: this.pendingNotifications.length,
      });
      return false;
    }
    const accepted = turnId === this.currentTurnId;
    if (!accepted) {
      this.debug(
        "notification.ignored_turn",
        { method, threadId, turnId, currentTurnId: this.currentTurnId },
        "warning",
      );
    }
    return accepted;
  }

  private flushPendingNotifications(): void {
    const pending = this.pendingNotifications;
    this.pendingNotifications = [];
    if (pending.length) {
      this.debug("notification.flush_pending", { count: pending.length });
    }
    for (const entry of pending)
      this.handleNotification(entry.method, entry.params);
  }

  private handleTurnSnapshot(turn: JsonRecord | null): void {
    if (!turn) return;
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      const record = asRecord(item);
      if (!record) continue;
      this.handleItemStarted(record);
      this.handleItemCompleted(record);
    }
    const status = textValue(turn.status);
    if (status === "failed") {
      const error = asRecord(turn.error);
      this.enqueue({
        type: "error",
        error:
          textValue(error?.message, error?.additionalDetails) ||
          "Codex turn failed.",
      });
      this.finishTurn();
    } else if (status === "completed" || status === "interrupted") {
      this.finishTurn();
    }
  }

  private handleItemStarted(item: JsonRecord | null): void {
    if (!item) return;
    const type = textValue(item.type);
    const id = textValue(item.id) || `codex-tool-${Date.now()}`;
    if (this.startedToolIds.has(id)) return;
    const policyToolName =
      type === "commandExecution"
        ? "commandExecution"
        : type === "webSearch"
          ? "webSearch"
          : type === "mcpToolCall"
            ? `mcp__${textValue(item.server)}__${textValue(item.tool)}`
            : "";
    const policyDenial = policyToolName
      ? this.permissionManager.getToolPolicyDenial(policyToolName)
      : null;
    if (policyDenial) {
      this.startedToolIds.add(id);
      this.enqueue({
        type: "tool_use",
        tool: { id, name: policyToolName, input: item },
      });
      this.enqueue({
        type: "tool_result",
        result: { id, content: policyDenial, isError: true },
      });
      this.enqueue({ type: "error", error: policyDenial });
      this.cancelActiveTurn();
      return;
    }
    if (type === "contextCompaction") {
      this.startedToolIds.add(id);
      this.contextCompactionActive = true;
      this.enqueue({
        type: "context_compaction",
        phase: "started",
      });
    } else if (type === "commandExecution") {
      this.emitToolUse(id, "commandExecution", {
        command: textValue(
          item.command,
          asRecord(item.commandActions)?.command,
        ),
        cwd: textValue(item.cwd),
      });
    } else if (type === "fileChange") {
      this.emitToolUse(id, "fileChange", { changes: item.changes || [] });
    } else if (type === "webSearch") {
      this.emitToolUse(id, "webSearch", item);
    } else if (type === "imageView") {
      this.emitToolUse(id, "view_image", { path: textValue(item.path) });
    } else if (type === "collabAgentToolCall") {
      this.emitToolUse(
        id,
        textValue(item.tool) || "collabAgentToolCall",
        asRecord(item.arguments) || {},
      );
    } else if (type === "mcpToolCall") {
      this.emitToolUse(
        id,
        `mcp__${textValue(item.server)}__${textValue(item.tool)}`,
        asRecord(item.arguments) || {},
      );
    }
  }

  private handleItemCompleted(item: JsonRecord | null): void {
    if (!item) return;
    const type = textValue(item.type);
    const id = textValue(item.id);
    if (type === "contextCompaction") {
      this.contextCompactionActive = false;
      this.enqueue({ type: "context_compaction", phase: "completed" });
      return;
    }
    if (type === "agentMessage") {
      const text = textValue(item.text);
      if (this.agentMessageDeltaIds.has(textValue(item.id))) {
        this.enqueueMissingAssistantText(text);
      } else if (text) {
        this.streamedAssistantText += text;
        this.enqueue({ type: "text", text });
      }
      return;
    }
    if (!id) return;
    if (type === "commandExecution") {
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content: textValue(item.aggregatedOutput) || "Command completed",
          isError:
            typeof item.exitCode === "number" ? item.exitCode !== 0 : false,
        },
      });
    } else if (type === "fileChange") {
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content: stringified(item.changes || "File change completed"),
          isError: ["failed", "declined", "error"].includes(
            textValue(item.status),
          ),
        },
      });
    } else if (type === "webSearch") {
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content: "Search complete",
          isError: ["failed", "error"].includes(textValue(item.status)),
        },
      });
    } else if (type === "imageView") {
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content: textValue(item.path) || "Image viewed",
          isError: ["failed", "error"].includes(textValue(item.status)),
        },
      });
    } else if (type === "collabAgentToolCall") {
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content: item.result
            ? stringified(item.result)
            : textValue(item.status) || "Completed",
          isError: ["failed", "error"].includes(textValue(item.status)),
        },
      });
    } else if (type === "mcpToolCall") {
      const result = asRecord(item.result);
      const error = asRecord(item.error);
      const errorText =
        textValue(item.error, error?.message, error?.error, error?.Err) ||
        (item.error ? stringified(item.error) : "");
      const content = Array.isArray(result?.content)
        ? result!.content
            .map((part) => textValue(asRecord(part)?.text))
            .filter(Boolean)
            .join("\n")
        : errorText || textValue(item.status) || "Completed";
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content,
          isError:
            !!item.error ||
            ["failed", "error"].includes(textValue(item.status)),
        },
      });
    }
  }

  private handleRawResponseItem(item: JsonRecord | null): void {
    if (!item) return;
    const type = textValue(item.type);
    if (type === "agentMessage") {
      this.enqueueMissingAssistantText(textValue(item.text, item.message));
      return;
    }
    if (type === "message") {
      const role = textValue(item.role);
      if (role && role !== "assistant") return;
      if (!role) return;
      const content = item.content;
      const text = Array.isArray(content)
        ? content
            .map((part) => textValue(asRecord(part)?.text))
            .filter(Boolean)
            .join("")
        : textValue(item.text, item.message);
      this.enqueueMissingAssistantText(text);
      return;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const id = textValue(item.call_id, item.id) || `raw-${Date.now()}`;
      const name = textValue(item.name, item.type);
      const input = parseArguments(item.arguments || item.input);
      this.rawToolNamesById.set(id, name);
      this.rawToolInputsById.set(id, input);
      this.emitToolUse(id, name, input);
      return;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const id = textValue(item.call_id, item.id);
      if (!id) return;
      const raw = stringified(item.output);
      this.enqueue({
        type: "tool_result",
        result: {
          id,
          content: raw,
          isError: /^error:/i.test(raw.trim()),
        },
      });
    }
  }

  private handleFileChangePatchUpdated(params: JsonRecord | null): void {
    const id =
      textValue(params?.itemId, params?.item_id) ||
      `codex-file-change-${Date.now()}`;
    this.emitToolUse(id, "fileChange", { changes: params?.changes || [] });
  }

  private handlePlanUpdated(params: JsonRecord | null): void {
    const plan = Array.isArray(params?.plan) ? params!.plan : [];
    if (!plan.length) return;
    const todos = plan.map((entry) => {
      const item = asRecord(entry) || {};
      const step = textValue(item.step, item.content, item.title);
      const status = textValue(item.status) || "pending";
      return {
        id: textValue(item.id),
        content: step,
        activeForm: step,
        status: status === "inProgress" ? "in_progress" : status,
      };
    });
    const planText = todos
      .map((todo, index) => {
        const status =
          todo.status === "completed"
            ? "done"
            : todo.status === "in_progress"
              ? "doing"
              : "todo";
        return `${index + 1}. [${status}] ${todo.content || todo.activeForm || ""}`;
      })
      .join("\n");
    this.latestPlanInput = {
      plan: planText,
      planContent: planText,
      summary: "Codex prepared a plan and is ready to execute.",
      todos,
    };
    const id = `codex-plan-${++this.planUpdateCounter}`;
    this.emitToolUse(id, "update_plan", { todos });
    this.enqueue({
      type: "tool_result",
      result: {
        id,
        content: "Plan updated",
        isError: false,
      },
    });
  }

  private handleEventMessage(params: JsonRecord | null): void {
    if (textValue(params?.type) !== "agent_message") return;
    this.enqueueMissingAssistantText(textValue(params?.text, params?.message));
  }

  private handleUsage(params: JsonRecord | null): void {
    const tokenUsage = asRecord(params?.tokenUsage);
    const last = asRecord(tokenUsage?.last);
    const output = Number(last?.outputTokens ?? last?.output_tokens ?? 0);
    if (Number.isFinite(output)) {
      this.enqueue({
        type: "usage",
        usage: { outputTokens: Math.max(0, output), final: false },
      });
    }
  }

  private emitToolUse(id: string, rawName: string, input: JsonRecord): void {
    if (this.startedToolIds.has(id)) return;
    this.startedToolIds.add(id);
    this.enqueue({
      type: "tool_use",
      tool: {
        id,
        name: normalizeToolName(rawName),
        input: normalizeToolInput(rawName, input),
      },
    });
  }

  private enqueueAssistantDelta(text: string): void {
    if (!text) return;
    this.streamedAssistantText += text;
    this.enqueue({ type: "text_delta", text });
  }

  private enqueueMissingAssistantText(text: string): void {
    if (!text) return;
    let missing = text;
    if (this.streamedAssistantText) {
      if (text.startsWith(this.streamedAssistantText)) {
        missing = text.slice(this.streamedAssistantText.length);
      } else if (
        text === this.streamedAssistantText ||
        this.streamedAssistantText.endsWith(text)
      ) {
        missing = "";
      }
    }
    if (!missing) return;
    this.streamedAssistantText += missing;
    this.enqueue({ type: "text", text: missing });
  }

  private async handleServerRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    this.debug("server_request.handle", {
      method,
      params: summarizeNotification(method, params),
    });
    if (method === "item/tool/requestUserInput") {
      return this.handleUserInputRequest(asRecord(params));
    }
    if (method === "account/chatgptAuthTokens/refresh") {
      return this.handleChatgptAuthTokensRefresh(asRecord(params));
    }
    if (method === "mcpServer/elicitation/request") {
      return { action: "cancel", content: null, _meta: null };
    }
    if (method === "item/tool/call") {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Dynamic app tools are not available in Claudero.",
          },
        ],
      };
    }
    if (method === "attestation/generate") {
      return { token: "" };
    }
    if (method === "execCommandApproval") {
      return this.handleLegacyExecApproval(asRecord(params));
    }
    if (method === "applyPatchApproval") {
      return this.handleLegacyPatchApproval(asRecord(params));
    }
    if (!this.config) return {};
    const request = asRecord(params) || {};
    const toolName =
      method === "item/fileChange/requestApproval"
        ? "apply_patch"
        : method === "item/permissions/requestApproval"
          ? "permissions"
          : "Bash";
    const input =
      method === "item/commandExecution/requestApproval"
        ? {
            command: textValue(request.command),
            cwd: textValue(request.cwd),
            reason: textValue(request.reason),
            networkApprovalContext: request.networkApprovalContext,
            additionalPermissions: request.additionalPermissions,
          }
        : request;
    const policyDenial = this.permissionManager.getToolPolicyDenial(toolName);
    if (policyDenial) return this.denyDecision(method);
    const mode = this.config.permissionMode;
    if (mode === "bypassPermissions") return this.allowDecision(method, true);
    if (mode === "dontAsk") return this.denyDecision(method);
    if (
      mode === "acceptEdits" &&
      method === "item/fileChange/requestApproval"
    ) {
      return this.allowDecision(method, false);
    }
    if (!(await this.ensurePlanApprovedBeforeExecution(method, input))) {
      return this.denyDecision(method);
    }
    const decision = await this.requestPermission(toolName, input);
    if (!decision.allowed) return this.denyDecision(method);
    if (decision.remember) this.permissionManager.remember(toolName, input);
    return this.allowDecision(method, decision.remember === true);
  }

  private requestPermission(
    toolName: string,
    input: unknown,
  ): Promise<PermissionDecision> {
    if (this.permissionManager.isRemembered(toolName, input)) {
      return Promise.resolve({ allowed: true, remember: true });
    }
    const id = Math.random().toString(36).slice(2, 11);
    return this.permissionManager.request({ id, toolName, input });
  }

  private async ensurePlanApprovedBeforeExecution(
    method: string,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.config?.permissionMode !== "plan") return true;
    const planInput = this.latestPlanInput;
    if (!planInput) return true;
    const turnKey = this.currentTurnId || this.currentThreadId || "current";
    if (this.planApprovedTurnIds.has(turnKey)) return true;

    const decision = await new Promise<ExitPlanDecision | null>((resolve) => {
      const toolUseId = `codex-exit-plan-${turnKey}`;
      this.pendingExitPlan = {
        toolUseId,
        input: {
          ...planInput,
          allowedPrompts: [
            {
              prompt: this.describeApprovalRequest(method, input),
            },
          ],
        },
        resolve,
      };
    });

    if (
      decision?.type === "approve" ||
      decision?.type === "approve-new-session"
    ) {
      this.planApprovedTurnIds.add(turnKey);
      return true;
    }

    if (decision?.type === "feedback" && decision.text.trim()) {
      this.enqueue({
        type: "text",
        text: `Plan revision requested: ${decision.text.trim()}`,
      });
    } else {
      this.enqueue({ type: "text", text: "Plan approval cancelled." });
    }
    this.cancelActiveTurn();
    return false;
  }

  private describeApprovalRequest(
    method: string,
    input: Record<string, unknown>,
  ): string {
    if (method === "item/commandExecution/requestApproval") {
      const command = textValue(input.command);
      const cwd = textValue(input.cwd);
      return ["Run command", command, cwd ? `in ${cwd}` : ""]
        .filter(Boolean)
        .join(": ");
    }
    if (method === "item/fileChange/requestApproval") {
      return "Apply file changes";
    }
    if (method === "item/permissions/requestApproval") {
      return "Grant requested permissions";
    }
    return "Continue execution";
  }

  private allowDecision(method: string, remember: boolean): unknown {
    if (method === "item/fileChange/requestApproval") {
      return { decision: remember ? "acceptForSession" : "accept" };
    }
    if (method === "item/permissions/requestApproval") {
      return { permissions: {}, scope: remember ? "session" : "turn" };
    }
    return { decision: remember ? "acceptForSession" : "accept" };
  }

  private denyDecision(method: string): unknown {
    if (method === "item/fileChange/requestApproval") {
      return { decision: "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      return { permissions: {}, scope: "turn" };
    }
    return { decision: "decline" };
  }

  private handleUserInputRequest(params: JsonRecord | null): Promise<unknown> {
    const questions = Array.isArray(params?.questions) ? params!.questions : [];
    const toolUseId = textValue(params?.itemId) || `ask-${Date.now()}`;
    this.pendingQuestion = { toolUseId, questions };
    this.enqueue({
      type: "tool_use",
      tool: {
        id: toolUseId,
        name: "AskUserQuestion",
        input: { questions },
      },
    });
    return new Promise((resolve) => {
      this.pendingQuestionResolver = {
        toolUseId,
        resolve: (answers) => {
          if (!answers) {
            resolve({ answers: {} });
            return;
          }
          const normalized: Record<string, { answers: string[] }> = {};
          for (const [key, value] of Object.entries(answers)) {
            normalized[key] = { answers: normalizeAnswers(value) };
          }
          this.enqueue({
            type: "tool_result",
            result: {
              id: toolUseId,
              content: "Answered",
              isError: false,
            },
          });
          resolve({ answers: normalized });
        },
      };
    });
  }

  private async handleChatgptAuthTokensRefresh(
    params: JsonRecord | null,
  ): Promise<unknown> {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    this.debug("auth.refresh.request", {
      reason: textValue(params?.reason),
      previousAccountId: textValue(params?.previousAccountId) || undefined,
      authPath,
    });
    try {
      const auth = JSON.parse(await readFile(authPath, "utf8")) as JsonRecord;
      const tokens = asRecord(auth.tokens);
      const accessToken = textValue(tokens?.access_token);
      const accountId =
        textValue(tokens?.account_id) ||
        textValue(params?.previousAccountId) ||
        "default";
      if (!accessToken) {
        throw new Error("No access_token found in ~/.codex/auth.json");
      }
      this.debug("auth.refresh.ready", {
        authMode: textValue(auth.auth_mode),
        accountId,
        lastRefresh: textValue(auth.last_refresh),
        hasAccessToken: true,
      });
      return {
        accessToken,
        chatgptAccountId: accountId,
        chatgptPlanType: null,
      };
    } catch (error) {
      this.debug(
        "auth.refresh.failed",
        { error: diagnosticError(error) },
        "error",
      );
      throw error;
    }
  }

  private async handleLegacyExecApproval(
    params: JsonRecord | null,
  ): Promise<unknown> {
    if (!this.config) return { decision: "denied" };
    const input = {
      command: Array.isArray(params?.command)
        ? (params!.command as unknown[]).map(String).join(" ")
        : "",
      cwd: textValue(params?.cwd),
      reason: textValue(params?.reason),
      parsedCmd: params?.parsedCmd,
    };
    if (
      !(await this.ensurePlanApprovedBeforeExecution(
        "execCommandApproval",
        input,
      ))
    ) {
      return { decision: "denied" };
    }
    const mode = this.config.permissionMode;
    if (this.permissionManager.getToolPolicyDenial("Bash")) {
      return { decision: "denied" };
    }
    if (mode === "bypassPermissions")
      return { decision: "approved_for_session" };
    if (mode === "dontAsk") return { decision: "denied" };
    const decision = await this.requestPermission("Bash", input);
    if (!decision.allowed) return { decision: "denied" };
    if (decision.remember) this.permissionManager.remember("Bash", input);
    return {
      decision: decision.remember ? "approved_for_session" : "approved",
    };
  }

  private async handleLegacyPatchApproval(
    params: JsonRecord | null,
  ): Promise<unknown> {
    if (!this.config) return { decision: "denied" };
    const input = {
      changes: params?.fileChanges || {},
      reason: textValue(params?.reason),
      grantRoot: textValue(params?.grantRoot),
    };
    if (
      !(await this.ensurePlanApprovedBeforeExecution(
        "applyPatchApproval",
        input,
      ))
    ) {
      return { decision: "denied" };
    }
    const mode = this.config.permissionMode;
    if (mode === "bypassPermissions" || mode === "acceptEdits") {
      return { decision: "approved_for_session" };
    }
    if (mode === "dontAsk") return { decision: "denied" };
    const decision = await this.requestPermission("apply_patch", input);
    if (!decision.allowed) return { decision: "denied" };
    if (decision.remember) {
      this.permissionManager.remember("apply_patch", input);
    }
    return {
      decision: decision.remember ? "approved_for_session" : "approved",
    };
  }

  private enqueue(item: QueueItem): void {
    this.queue.push(item);
    if (this.queueResolve) {
      this.queueResolve();
      this.queueResolve = null;
    }
  }

  private async nextQueueItem(timeoutMs?: number): Promise<QueueItem> {
    while (this.queue.length === 0) {
      let timer: NodeJS.Timeout | null = null;
      const effectiveTimeoutMs =
        timeoutMs ?? codexTurnIdleTimeoutMs(this.contextCompactionActive);
      await new Promise<void>((resolve) => {
        this.queueResolve = resolve;
        timer = setTimeout(() => {
          const stderr = this.transport?.getStderrTail();
          const userStderr = userFacingCodexStderr(stderr || "");
          this.runtimeUnhealthyReason = hasModelsCacheSchemaError(stderr || "")
            ? "incompatible_models_cache"
            : "turn_idle_timeout";
          this.queueResolve = null;
          this.debug(
            "turn.idle_timeout",
            {
              timeoutMs: effectiveTimeoutMs,
              threadId: this.currentThreadId || this.threadId || undefined,
              turnId: this.currentTurnId || undefined,
              pendingRequests: this.transport?.getPendingRequests() || [],
              stderrTail: truncateDiagnosticText(stderr),
            },
            "error",
          );
          this.enqueue({
            type: "error",
            error:
              "Codex did not produce any events after starting the turn. Claudero has discarded this app-server and will start a fresh one on the next message." +
              (userStderr ? `\n\nApp-server stderr:\n${userStderr}` : ""),
          });
          this.finishTurn();
          const proc = this.proc;
          if (proc && isProcessAlive(proc)) proc.kill("SIGTERM");
          resolve();
        }, effectiveTimeoutMs);
      });
      if (timer) clearTimeout(timer);
    }
    return this.queue.shift()!;
  }

  private finishTurn(): void {
    if (this.finished) return;
    this.debug("turn.finish", {
      threadId: this.currentThreadId || this.threadId || undefined,
      turnId: this.currentTurnId || undefined,
    });
    this.finished = true;
    this.enqueue({ type: "__done" });
  }

  private resetTurnState(): void {
    this.currentTurnId = null;
    this.currentThreadId = null;
    this.pendingNotifications = [];
    this.pendingExitPlan = null;
    this.latestPlanInput = null;
    this.planApprovedTurnIds.clear();
    this.queue = [];
    this.queueResolve = null;
    this.finished = false;
    this.startedToolIds.clear();
    this.agentMessageDeltaIds.clear();
    this.rawToolNamesById.clear();
    this.contextCompactionActive = false;
    this.rawToolInputsById.clear();
    this.streamedAssistantText = "";
  }
}

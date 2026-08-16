import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ImageInput } from "./MessageChannel";
import type { PermissionManager } from "./PermissionManager";
import type { ClauderoPermissionMode } from "./QueryOptionsBuilder";
import type {
  ExitPlanDecision,
  PendingExitPlan,
  PendingQuestion,
} from "./PersistentQueryManager";
import type { ClauderoStreamEvent } from "../stream/types";
import type { ProviderModelDescriptor } from "../../shared/providerModels";
import type { AcademicToolPolicy } from "../../shared/academicToolPolicy";

export interface DeepSeekConfig {
  workspacePath: string;
  deepseekPath: string;
  nodePath?: string;
  environment: Record<string, string>;
  model?: string;
  effort?: string;
  permissionMode?: ClauderoPermissionMode;
  conversationId?: string;
  providerState?: { sessionId?: string };
}

type RestartConfig = Omit<Partial<DeepSeekConfig>, "workspacePath">;

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MODELS: ProviderModelDescriptor[] = [
  {
    value: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
  },
  {
    value: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
  },
];
const MAX_STDERR_CHARS = 12_000;
const MAX_STDOUT_CHARS = 4_000_000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function permissionEnvironment(
  mode: ClauderoPermissionMode | undefined,
): string | undefined {
  switch (mode) {
    case "bypassPermissions":
      return "danger-full-access";
    case "dontAsk":
      return "read-only";
    case "plan":
      return "read-only";
    default:
      return "workspace-write";
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function failureDetail(stderr: string, nodePath: string | undefined): string {
  const detail = normalizeText(stderr);
  if (/createZstdDecompress|stripTypeScriptTypes/.test(detail)) {
    return `DeepSeek Harness requires Node.js 24 or newer. The selected runtime (${nodePath || process.execPath}) is incompatible. Install Node.js 24+, or set DSH_NODE_PATH in the DeepSeek provider environment.`;
  }
  return detail.slice(-4000);
}

const DSH_STDIN_RUNNER = [
  'import { pathToFileURL } from "node:url";',
  "const chunks = [];",
  "for await (const chunk of process.stdin) chunks.push(chunk);",
  'const prompt = Buffer.concat(chunks).toString("utf8");',
  "const entrypoint = process.argv[1];",
  'if (!entrypoint) throw new Error("Missing DeepSeek Harness entrypoint");',
  'process.argv = [process.execPath, entrypoint, "--profile", "headless", prompt];',
  "await import(pathToFileURL(entrypoint).href);",
].join("\n");

export function resolveDeepSeekEntrypoint(deepseekPath: string): string {
  const command = deepseekPath.trim();
  if (!command) {
    throw new Error("Missing DeepSeek Harness CLI path");
  }

  let resolved = command;
  try {
    resolved = realpathSync(command);
  } catch {
    // Validate the original path below for a more actionable error.
  }
  if (/\.(?:cjs|mjs|js)$/i.test(resolved) && existsSync(resolved)) {
    return resolved;
  }

  if (/\.(?:cmd|bat)$/i.test(command)) {
    const binDir = path.dirname(command);
    const candidates = [
      path.join(binDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      path.resolve(binDir, "..", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    const entrypoint = candidates.find(existsSync);
    if (entrypoint) return entrypoint;
    throw new Error(
      `Cannot safely resolve the DeepSeek Harness JavaScript entrypoint from ${command}. Reinstall @deepseek-ai/dsh or select its lib/bin.js file.`,
    );
  }

  throw new Error(
    `DeepSeek Harness must resolve to its JavaScript entrypoint, but got ${command}. Reinstall @deepseek-ai/dsh or select its lib/bin.js file.`,
  );
}

export function buildDeepSeekLaunchSpec(
  deepseekPath: string,
  nodePath?: string,
): {
  command: string;
  args: string[];
  shell: boolean;
} {
  return {
    command: nodePath || process.execPath,
    args: [
      "--input-type=module",
      "--eval",
      DSH_STDIN_RUNNER,
      resolveDeepSeekEntrypoint(deepseekPath),
    ],
    shell: false,
  };
}

export class DeepSeekPersistentQueryManager {
  private config: DeepSeekConfig | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private turnStreamActive = false;
  private sessionId: string | null = null;
  private stderr = "";
  private toolPolicy: AcademicToolPolicy | undefined;
  private readonly permissionManager: PermissionManager;

  constructor(permissionManager: PermissionManager) {
    this.permissionManager = permissionManager;
  }

  get isActive(): boolean {
    return !!this.config;
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

  setPermissionMode(mode: string | undefined): Promise<void> {
    if (this.config) {
      this.config.permissionMode = mode as ClauderoPermissionMode | undefined;
    }
    return Promise.resolve();
  }

  getMcpServerNames(): string[] {
    return [];
  }

  async initialize(config: DeepSeekConfig): Promise<void> {
    await mkdir(config.workspacePath, { recursive: true });
    this.close();
    this.config = { ...config };
    this.sessionId = config.providerState?.sessionId || null;
    this.stderr = "";
  }

  async *sendMessageEvents(
    prompt: string,
    images?: ImageInput[],
  ): AsyncIterable<ClauderoStreamEvent> {
    if (this.turnStreamActive) {
      throw new Error("A DeepSeek Harness turn is already in progress.");
    }
    if (!this.config) {
      throw new Error(
        "DeepSeek Harness runtime not initialized. Call /init first.",
      );
    }
    if (images?.length) {
      throw new Error("DeepSeek Harness does not support image attachments.");
    }

    const config = this.config;
    this.turnStreamActive = true;
    this.stderr = "";
    const sessionId =
      this.sessionId ||
      `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = sessionId;
    yield { type: "session", session: { provider: "deepseek", sessionId } };

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...config.environment,
    };
    if (config.model?.trim()) env.DSH_MODEL = config.model.trim();
    const permission = permissionEnvironment(config.permissionMode);
    if (permission) env.DSH_PERMISSION_MODE = permission;
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      const launch = buildDeepSeekLaunchSpec(
        config.deepseekPath,
        config.nodePath,
      );
      child = spawn(launch.command, launch.args, {
        cwd: config.workspacePath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: launch.shell,
      });
      const spawnedChild = child;
      this.proc = spawnedChild;
      spawnedChild.stdin.on("error", (error) => {
        this.stderr = `${this.stderr}${error.message}`.slice(-MAX_STDERR_CHARS);
      });
      spawnedChild.stdin.end(prompt);
      const result = await new Promise<{
        stdout: string;
        code: number | null;
        timedOut: boolean;
        outputExceeded: boolean;
      }>((resolve, reject) => {
        let stdout = "";
        let timedOut = false;
        let outputExceeded = false;
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = setTimeout(() => {
          timedOut = true;
          if (spawnedChild.exitCode === null && !spawnedChild.killed)
            spawnedChild.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            if (spawnedChild.exitCode === null && !spawnedChild.killed)
              spawnedChild.kill("SIGKILL");
          }, 2_000);
        }, TURN_TIMEOUT_MS);
        const finish = (value: { stdout: string; code: number | null }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          resolve({ ...value, timedOut, outputExceeded });
        };
        spawnedChild.stdout.on("data", (chunk: Buffer | string) => {
          if (outputExceeded) return;
          stdout += chunk.toString();
          if (stdout.length > MAX_STDOUT_CHARS) {
            outputExceeded = true;
            stdout = stdout.slice(0, MAX_STDOUT_CHARS);
            if (spawnedChild.exitCode === null && !spawnedChild.killed)
              spawnedChild.kill("SIGTERM");
          }
        });
        spawnedChild.stderr.on("data", (chunk: Buffer | string) => {
          this.stderr = `${this.stderr}${chunk.toString()}`.slice(
            -MAX_STDERR_CHARS,
          );
        });
        spawnedChild.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          reject(error);
        });
        spawnedChild.once("close", (code) => finish({ stdout, code }));
      });
      if (result.timedOut) {
        throw new Error(
          `DeepSeek Harness timed out after ${Math.round(TURN_TIMEOUT_MS / 60_000)} minutes.`,
        );
      }
      if (result.outputExceeded) {
        throw new Error(
          `DeepSeek Harness output exceeded the ${Math.round(MAX_STDOUT_CHARS / 1_000_000)} MB limit.`,
        );
      }
      if (result.code !== 0) {
        const detail = failureDetail(this.stderr, config.nodePath);
        throw new Error(
          detail
            ? `DeepSeek Harness exited with code ${result.code ?? "unknown"}: ${detail}`
            : `DeepSeek Harness exited with code ${result.code ?? "unknown"}.`,
        );
      }
      const text = normalizeText(result.stdout);
      if (text) yield { type: "text", text };
      yield {
        type: "usage",
        usage: { outputTokens: 0, final: true },
      };
    } finally {
      if (child && child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
      this.proc = null;
      this.turnStreamActive = false;
    }
  }

  getPendingQuestion(): PendingQuestion | null {
    return null;
  }

  getPendingExitPlan(): PendingExitPlan | null {
    return null;
  }

  answerQuestion(
    _toolUseId: string,
    _answers: Record<string, string | string[]>,
    _response?: string,
  ): boolean {
    return false;
  }

  answerExitPlan(_toolUseId: string, _decision: ExitPlanDecision): boolean {
    return false;
  }

  cancelPendingQuestion(): boolean {
    return false;
  }

  cancelPendingExitPlan(): boolean {
    return false;
  }

  cancelActiveTurn(): void {
    if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
  }

  supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return Promise.resolve([]);
  }

  reloadSkills(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return Promise.resolve([]);
  }

  listModels(): Promise<ProviderModelDescriptor[]> {
    const configured = this.config?.model?.trim() || DEFAULT_MODEL;
    const models = DEFAULT_MODELS.map((model) => ({
      ...model,
      ...(model.value === configured ? { isDefault: true } : {}),
    }));
    if (!models.some((model) => model.value === configured)) {
      models.unshift({
        value: configured,
        label: configured,
        isDefault: true,
      });
    }
    return Promise.resolve(models);
  }

  getSessionState(): {
    provider: "deepseek";
    sessionId?: string;
    stderr?: string;
  } {
    return {
      provider: "deepseek",
      sessionId: this.sessionId || undefined,
      stderr: this.stderr || undefined,
    };
  }

  diagnostics(): Record<string, unknown> {
    return {
      command: this.config?.deepseekPath || "dsh",
      nodePath: this.config?.nodePath || process.execPath,
      args: [
        "--input-type=module",
        "--eval",
        "<stdin-runner>",
        "<dsh-entrypoint>",
      ],
      shell: false,
      promptTransport: "stdin",
      workspacePath: this.config?.workspacePath || null,
      process: this.proc
        ? {
            pid: this.proc.pid,
            killed: this.proc.killed,
            exitCode: this.proc.exitCode,
            stderr: this.stderr || undefined,
          }
        : null,
      toolPolicy: this.toolPolicy,
    };
  }

  close(): void {
    this.cancelActiveTurn();
    this.proc = null;
    this.turnStreamActive = false;
    this.config = null;
    this.sessionId = null;
    this.stderr = "";
  }

  requiresRestart(newConfig: RestartConfig): boolean {
    if (!this.config) return false;
    return (
      (newConfig.deepseekPath !== undefined &&
        newConfig.deepseekPath !== this.config.deepseekPath) ||
      (newConfig.nodePath !== undefined &&
        newConfig.nodePath !== this.config.nodePath) ||
      (newConfig.environment !== undefined &&
        JSON.stringify(newConfig.environment) !==
          JSON.stringify(this.config.environment)) ||
      (newConfig.conversationId !== undefined &&
        newConfig.conversationId !== this.config.conversationId)
    );
  }

  updateConfig(newConfig: RestartConfig): void {
    if (!this.config) return;
    this.config = { ...this.config, ...newConfig };
    if (newConfig.providerState?.sessionId) {
      this.sessionId = newConfig.providerState.sessionId;
    }
  }
}

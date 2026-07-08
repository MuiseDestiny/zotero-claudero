import type { ImageInput } from "./MessageChannel";
import type { PermissionManager } from "./PermissionManager";
import type { ClauderoPermissionMode } from "./QueryOptionsBuilder";
import { normalizePermissionMode } from "./QueryOptionsBuilder";
import {
  PersistentQueryManager,
  type ExitPlanDecision,
  type PendingExitPlan,
  type PendingQuestion,
  type PersistentQueryConfig,
  type RestartConfig as ClaudeRestartConfig,
} from "./PersistentQueryManager";
import {
  CodexPersistentQueryManager,
  type CodexConfig,
} from "./CodexPersistentQueryManager";
import { ToolInputStreamState } from "../stream/toolInputStreamState";
import { transformClaudeMessage } from "../stream/transformClaudeMessage";
import type { ClauderoStreamEvent } from "../stream/types";

export type AgentRuntimeProvider = "claude" | "codex";

export type AgentRuntimeConfig = PersistentQueryConfig | CodexConfig;

export type AgentRuntimeRestartConfig =
  | ClaudeRestartConfig
  | Omit<Partial<CodexConfig>, "workspacePath">;

export interface AgentRuntimeDiagnostics {
  active: boolean;
  workspacePath: string | null;
  session?: unknown;
  mcpServers?: string[];
  zoteroMcp?: boolean;
}

export interface AgentRuntimeAdapter {
  provider: AgentRuntimeProvider;
  isActive: boolean;
  workspacePath: string | null;
  initialize(config: AgentRuntimeConfig): Promise<void>;
  requiresRestart(config: AgentRuntimeRestartConfig): boolean;
  updateConfig(config: AgentRuntimeRestartConfig): void;
  setPermissionMode(mode: string | undefined): Promise<void>;
  sendMessageEvents(
    prompt: string,
    images?: ImageInput[],
  ): AsyncIterable<ClauderoStreamEvent>;
  getPendingQuestion(): PendingQuestion | null;
  getPendingExitPlan(): PendingExitPlan | null;
  answerQuestion(
    toolUseId: string,
    answers: Record<string, string | string[]>,
    response?: string,
  ): boolean;
  answerExitPlan(toolUseId: string, decision: ExitPlanDecision): boolean;
  cancelPendingQuestion(): boolean;
  cancelPendingExitPlan(): boolean;
  cancelActiveTurn(): void;
  supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  >;
  reloadSkills(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  >;
  diagnostics(): AgentRuntimeDiagnostics;
  close(): void;
}

export class ClaudeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly provider = "claude" as const;
  private readonly manager: PersistentQueryManager;

  constructor(permissionManager: PermissionManager) {
    this.manager = new PersistentQueryManager(permissionManager);
  }

  get isActive(): boolean {
    return this.manager.isActive;
  }

  get workspacePath(): string | null {
    return this.manager.workspacePath;
  }

  initialize(config: AgentRuntimeConfig): Promise<void> {
    return this.manager.initialize(config as PersistentQueryConfig);
  }

  requiresRestart(config: AgentRuntimeRestartConfig): boolean {
    return this.manager.requiresRestart(config as ClaudeRestartConfig);
  }

  updateConfig(): void {
    // Claude SDK runtime options are mutated through setPermissionMode or a restart.
  }

  setPermissionMode(mode: string | undefined): Promise<void> {
    return this.manager.setPermissionMode(normalizePermissionMode(mode));
  }

  async *sendMessageEvents(
    prompt: string,
    images?: ImageInput[],
  ): AsyncIterable<ClauderoStreamEvent> {
    const streamState = new ToolInputStreamState();
    streamState.resetTurn();
    for await (const message of this.manager.sendMessage(prompt, images)) {
      for (const event of transformClaudeMessage(message, streamState)) {
        yield event;
      }
    }
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.manager.getPendingQuestion();
  }

  getPendingExitPlan(): PendingExitPlan | null {
    return this.manager.getPendingExitPlan();
  }

  answerQuestion(
    toolUseId: string,
    answers: Record<string, string | string[]>,
    response?: string,
  ): boolean {
    return this.manager.answerQuestion(toolUseId, answers, response);
  }

  answerExitPlan(toolUseId: string, decision: ExitPlanDecision): boolean {
    return this.manager.answerExitPlan(toolUseId, decision);
  }

  cancelPendingQuestion(): boolean {
    return this.manager.cancelPendingQuestion();
  }

  cancelPendingExitPlan(): boolean {
    return this.manager.cancelPendingExitPlan();
  }

  cancelActiveTurn(): void {
    this.cancelPendingQuestion();
    this.cancelPendingExitPlan();
  }

  supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return this.manager.supportedCommands();
  }

  reloadSkills(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return this.manager.reloadSkills();
  }

  diagnostics(): AgentRuntimeDiagnostics {
    const mcpServers = this.manager.getMcpServerNames();
    return {
      active: this.isActive,
      workspacePath: this.workspacePath,
      session: this.isActive ? { provider: this.provider } : null,
      mcpServers,
      zoteroMcp: mcpServers.includes("zotero"),
    };
  }

  close(): void {
    this.manager.close();
  }
}

export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly provider = "codex" as const;
  private readonly manager: CodexPersistentQueryManager;

  constructor(permissionManager: PermissionManager) {
    this.manager = new CodexPersistentQueryManager(permissionManager);
  }

  get isActive(): boolean {
    return this.manager.isActive;
  }

  get workspacePath(): string | null {
    return this.manager.workspacePath;
  }

  initialize(config: AgentRuntimeConfig): Promise<void> {
    return this.manager.initialize(config as CodexConfig);
  }

  requiresRestart(config: AgentRuntimeRestartConfig): boolean {
    return this.manager.requiresRestart(
      config as Omit<Partial<CodexConfig>, "workspacePath">,
    );
  }

  updateConfig(config: AgentRuntimeRestartConfig): void {
    this.manager.updateConfig(
      config as Omit<Partial<CodexConfig>, "workspacePath">,
    );
  }

  setPermissionMode(mode: string | undefined): Promise<void> {
    return this.manager.setPermissionMode(mode);
  }

  sendMessageEvents(
    prompt: string,
    images?: ImageInput[],
  ): AsyncIterable<ClauderoStreamEvent> {
    return this.manager.sendMessageEvents(prompt, images);
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.manager.getPendingQuestion();
  }

  getPendingExitPlan(): PendingExitPlan | null {
    return this.manager.getPendingExitPlan();
  }

  answerQuestion(
    toolUseId: string,
    answers: Record<string, string | string[]>,
  ): boolean {
    return this.manager.answerQuestion(toolUseId, answers);
  }

  answerExitPlan(toolUseId: string, decision: ExitPlanDecision): boolean {
    return this.manager.answerExitPlan(toolUseId, decision);
  }

  cancelPendingQuestion(): boolean {
    return this.manager.cancelPendingQuestion();
  }

  cancelPendingExitPlan(): boolean {
    return this.manager.cancelPendingExitPlan();
  }

  cancelActiveTurn(): void {
    this.manager.cancelActiveTurn();
  }

  supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return this.manager.supportedCommands();
  }

  reloadSkills(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    return this.manager.reloadSkills();
  }

  diagnostics(): AgentRuntimeDiagnostics {
    const mcpServers = this.manager.getMcpServerNames();
    return {
      active: this.isActive,
      workspacePath: this.workspacePath,
      session: this.manager.getSessionState(),
      mcpServers,
      zoteroMcp: mcpServers.includes("zotero"),
    };
  }

  close(): void {
    this.manager.close();
  }
}

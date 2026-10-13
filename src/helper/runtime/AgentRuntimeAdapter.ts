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
import {
  DeepSeekPersistentQueryManager,
  type DeepSeekConfig,
} from "./DeepSeekPersistentQueryManager";
import { ToolInputStreamState } from "../stream/toolInputStreamState";
import { transformClaudeMessage } from "../stream/transformClaudeMessage";
import type { ClauderoStreamEvent } from "../stream/types";
import type { ProviderModelDescriptor } from "../../shared/providerModels";
import type { AcademicToolPolicy } from "../../shared/academicToolPolicy";

export type AgentRuntimeProvider = "claude" | "codex" | "deepseek";

export type AgentRuntimeConfig =
  | PersistentQueryConfig
  | CodexConfig
  | DeepSeekConfig;

export type AgentRuntimeRestartConfig =
  | ClaudeRestartConfig
  | Omit<Partial<CodexConfig>, "workspacePath">
  | Omit<Partial<DeepSeekConfig>, "workspacePath">;

export interface AgentRuntimeDiagnostics {
  active: boolean;
  workspacePath: string | null;
  session?: unknown;
  mcpServers?: string[];
  zoteroMcp?: boolean;
  debugEvents?: unknown[];
  pendingRequests?: unknown[];
  launch?: unknown;
  process?: unknown;
  mcpStatus?: unknown;
}

export interface AgentRuntimeAdapter {
  provider: AgentRuntimeProvider;
  isActive: boolean;
  isBusy: boolean;
  workspacePath: string | null;
  initialize(config: AgentRuntimeConfig, signal?: AbortSignal): Promise<void>;
  requiresRestart(config: AgentRuntimeRestartConfig): boolean;
  updateConfig(config: AgentRuntimeRestartConfig): void;
  setPermissionMode(mode: string | undefined): Promise<void>;
  setToolPolicy(policy: AcademicToolPolicy | undefined): void;
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
  listModels(): Promise<ProviderModelDescriptor[]>;
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

  get isBusy(): boolean {
    return this.manager.isBusy;
  }

  get workspacePath(): string | null {
    return this.manager.workspacePath;
  }

  initialize(config: AgentRuntimeConfig, signal?: AbortSignal): Promise<void> {
    return this.manager.initialize(config as PersistentQueryConfig, signal);
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

  setToolPolicy(policy: AcademicToolPolicy | undefined): void {
    this.manager.setToolPolicy(policy);
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

  async listModels(): Promise<ProviderModelDescriptor[]> {
    return [];
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

  get isBusy(): boolean {
    return this.manager.isBusy;
  }

  get workspacePath(): string | null {
    return this.manager.workspacePath;
  }

  initialize(config: AgentRuntimeConfig, signal?: AbortSignal): Promise<void> {
    return this.manager.initialize(config as CodexConfig, signal);
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

  setToolPolicy(policy: AcademicToolPolicy | undefined): void {
    this.manager.setToolPolicy(policy);
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

  listModels(): Promise<ProviderModelDescriptor[]> {
    return this.manager.listModels();
  }

  diagnostics(): AgentRuntimeDiagnostics {
    const mcpServers = this.manager.getMcpServerNames();
    const diagnostics = this.manager.getDiagnostics();
    return {
      active: this.isActive,
      workspacePath: this.workspacePath,
      session: this.manager.getSessionState(),
      mcpServers,
      zoteroMcp: mcpServers.includes("zotero"),
      debugEvents: diagnostics.events,
      pendingRequests: diagnostics.pendingRequests,
      launch: diagnostics.launch,
      process: diagnostics.process,
      mcpStatus: diagnostics.mcpStatus,
    };
  }

  close(): void {
    this.manager.close();
  }
}

export class DeepSeekRuntimeAdapter implements AgentRuntimeAdapter {
  readonly provider = "deepseek" as const;
  private readonly manager: DeepSeekPersistentQueryManager;

  constructor(permissionManager: PermissionManager) {
    this.manager = new DeepSeekPersistentQueryManager(permissionManager);
  }

  get isActive(): boolean {
    return this.manager.isActive;
  }

  get isBusy(): boolean {
    return this.manager.isBusy;
  }

  get workspacePath(): string | null {
    return this.manager.workspacePath;
  }

  initialize(config: AgentRuntimeConfig, signal?: AbortSignal): Promise<void> {
    return this.manager.initialize(config as DeepSeekConfig, signal);
  }

  requiresRestart(config: AgentRuntimeRestartConfig): boolean {
    return this.manager.requiresRestart(
      config as Omit<Partial<DeepSeekConfig>, "workspacePath">,
    );
  }

  updateConfig(config: AgentRuntimeRestartConfig): void {
    this.manager.updateConfig(
      config as Omit<Partial<DeepSeekConfig>, "workspacePath">,
    );
  }

  setPermissionMode(mode: string | undefined): Promise<void> {
    return this.manager.setPermissionMode(mode);
  }

  setToolPolicy(policy: AcademicToolPolicy | undefined): void {
    this.manager.setToolPolicy(policy);
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

  listModels(): Promise<ProviderModelDescriptor[]> {
    return this.manager.listModels();
  }

  diagnostics(): AgentRuntimeDiagnostics {
    const mcpServers = this.manager.getMcpServerNames();
    return {
      active: this.isActive,
      workspacePath: this.workspacePath,
      session: this.manager.getSessionState(),
      mcpServers,
      zoteroMcp: false,
      launch: this.manager.diagnostics(),
    };
  }

  close(): void {
    this.manager.close();
  }
}

import {
  query,
  type Options,
  type PermissionMode,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdir } from "node:fs/promises";
import { MessageChannel, type ImageInput } from "./MessageChannel";
import {
  buildQueryOptions,
  normalizePermissionMode,
  sameEnvironment,
  type ClauderoPermissionMode,
} from "./QueryOptionsBuilder";
import type {
  PermissionManager,
  ToolDecision,
  ToolOptions,
} from "./PermissionManager";
import { ToolInputStreamState } from "../stream/toolInputStreamState";
import { transformClaudeMessage } from "../stream/transformClaudeMessage";
import type { AcademicToolPolicy } from "../../shared/academicToolPolicy";

interface PersistentQueryState {
  query: Query;
  iter: AsyncIterator<unknown>;
  messageChannel: MessageChannel;
  options: Options;
  workspacePath: string;
  environment: Record<string, string>;
  zoteroEndpointUrl?: string;
  zoteroEndpointToken?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  conversationId?: string;
  providerState?: { sessionId?: string };
}

export interface PersistentQueryConfig {
  workspacePath: string;
  claudePath: string;
  environment: Record<string, string>;
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  permissionMode?: ClauderoPermissionMode;
  zoteroEndpointUrl?: string;
  zoteroEndpointToken?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  conversationId?: string;
  providerState?: { sessionId?: string };
}

export type RestartConfig = Omit<
  Partial<PersistentQueryConfig>,
  "workspacePath"
>;

export interface PendingQuestion {
  toolUseId: string;
  questions: unknown[];
}

export interface PendingExitPlan {
  toolUseId: string;
  input: Record<string, unknown>;
}

export type ExitPlanDecision =
  | { type: "approve" }
  | { type: "approve-new-session"; planContent?: string }
  | { type: "feedback"; text: string };

type PendingQuestionSource = "tool" | "dialog";

interface PendingDialogQuestion {
  toolUseId: string;
  resolve: (
    value:
      | { behavior: "completed"; result: unknown }
      | { behavior: "cancelled" },
  ) => void;
}

interface PendingCanUseQuestion {
  toolUseId: string;
  toolInput: Record<string, unknown>;
  resolve: (value: ToolDecision) => void;
}

interface AnsweredQuestion {
  answers: Record<string, string | string[]>;
  response?: string;
}

interface PendingExitPlanRequest {
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (value: ToolDecision) => void;
}

export class PersistentQueryManager {
  private state: PersistentQueryState | null = null;
  private pendingQuestion: PendingQuestion | null = null;
  private pendingQuestionSource: PendingQuestionSource | null = null;
  private pendingQuestionAnswered: {
    toolUseId: string;
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;
  private pendingDialogQuestion: PendingDialogQuestion | null = null;
  private pendingCanUseQuestion: PendingCanUseQuestion | null = null;
  private pendingExitPlan: PendingExitPlanRequest | null = null;
  private answeredExitPlanDecisions = new Map<string, ExitPlanDecision>();
  private answeredQuestionAnswers = new Map<string, AnsweredQuestion>();
  private answeredQuestionToolIds = new Set<string>();
  private turnActive = false;
  private toolPolicy: AcademicToolPolicy | undefined;

  constructor(private readonly permissionManager: PermissionManager) {}

  get isActive(): boolean {
    return this.state !== null;
  }

  get isBusy(): boolean {
    return this.turnActive;
  }

  get options(): Options | null {
    return this.state?.options || null;
  }

  get workspacePath(): string | null {
    return this.state?.workspacePath || null;
  }

  getMcpServerNames(): string[] {
    if (!this.state) return [];
    const servers = { ...(this.state.mcpServers || {}) };
    if (this.state.enableZoteroMcp !== false && this.state.zoteroEndpointUrl) {
      servers.zotero = true;
    }
    return Object.keys(servers).sort();
  }

  async initialize(config: PersistentQueryConfig): Promise<void> {
    if (this.state) {
      throw new Error("Persistent query already initialized");
    }

    await mkdir(config.workspacePath, { recursive: true });

    const messageChannel = new MessageChannel();
    const options = buildQueryOptions({
      ...config,
      permissionManager: this.permissionManager,
      resume: config.providerState?.sessionId,
    });

    const permissionHandler = this.permissionManager.createCanUseToolHandler();
    (options as Record<string, unknown>).canUseTool = (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolOptions: ToolOptions,
    ) => this.canUseTool(toolName, toolInput, toolOptions, permissionHandler);
    options.onUserDialog = (request, dialogOptions) =>
      this.handleUserDialog(request, dialogOptions.signal);
    options.supportedDialogKinds = [
      "ask_user_question",
      "askUserQuestion",
      "AskUserQuestion",
      "user_question",
      "question",
    ];

    const q = query({ prompt: messageChannel, options });

    this.state = {
      query: q,
      // Create the iterator once and reuse across turns. Using manual
      // iter.next() lets callers stop at result without closing the iterator.
      iter: q[Symbol.asyncIterator](),
      messageChannel,
      options,
      workspacePath: config.workspacePath,
      environment: config.environment,
      zoteroEndpointUrl: config.zoteroEndpointUrl,
      zoteroEndpointToken: config.zoteroEndpointToken,
      enableZoteroMcp: config.enableZoteroMcp,
      mcpServers: config.mcpServers,
      mcpDisabledTools: config.mcpDisabledTools,
      conversationId: config.conversationId,
      providerState: config.providerState,
    };
  }

  setToolPolicy(policy: AcademicToolPolicy | undefined): void {
    this.toolPolicy = policy;
    this.permissionManager.setToolPolicy(policy);
  }

  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
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
      if (!this.state) return false;
      this.answeredExitPlanDecisions.set(toolUseId, decision);
      return true;
    }
    const pending = this.pendingExitPlan;
    this.pendingExitPlan = null;
    pending.resolve(
      this.resolveExitPlanDecision(toolUseId, pending.input, decision),
    );
    return true;
  }

  answerQuestion(
    toolUseId: string,
    answers: Record<string, string | string[]>,
    response?: string,
  ): boolean {
    if (!this.state) return false;
    const answered: AnsweredQuestion = { answers, response };
    this.answeredQuestionAnswers.set(toolUseId, answered);
    if (!this.pendingQuestion || this.pendingQuestion.toolUseId !== toolUseId) {
      if (this.pendingCanUseQuestion?.toolUseId === toolUseId) {
        const toolInput = this.pendingCanUseQuestion.toolInput;
        this.pendingCanUseQuestion.resolve({
          behavior: "allow",
          updatedInput: { ...toolInput, answers },
          toolUseID: toolUseId,
        });
        this.pendingCanUseQuestion = null;
        this.resolvePendingQuestion(toolUseId);
      }
      return true;
    }
    const result = {
      questions: this.pendingQuestion.questions,
      answers,
      response,
    };
    this.pendingQuestion = null;
    const source = this.pendingQuestionSource;
    this.pendingQuestionSource = null;
    this.answeredQuestionToolIds.add(toolUseId);
    if (this.pendingCanUseQuestion?.toolUseId === toolUseId) {
      const toolInput = this.pendingCanUseQuestion.toolInput;
      this.pendingCanUseQuestion.resolve({
        behavior: "allow",
        updatedInput: { ...toolInput, answers },
        toolUseID: toolUseId,
      });
      this.pendingCanUseQuestion = null;
      this.resolvePendingQuestion(toolUseId);
      return true;
    }
    if (
      source === "dialog" &&
      this.pendingDialogQuestion?.toolUseId === toolUseId
    ) {
      this.pendingDialogQuestion.resolve({
        behavior: "completed",
        result: { answers, response },
      });
      this.pendingDialogQuestion = null;
      return true;
    }
    if (source === "tool") {
      this.resolvePendingQuestion(toolUseId);
      return true;
    }
    this.state.messageChannel.sendToolResult(toolUseId, result);
    this.resolvePendingQuestion(toolUseId);
    return true;
  }

  cancelPendingQuestion(): boolean {
    if (!this.state || !this.pendingQuestion) return false;
    const toolUseId = this.pendingQuestion.toolUseId;
    this.pendingQuestion = null;
    const source = this.pendingQuestionSource;
    this.pendingQuestionSource = null;
    this.answeredQuestionToolIds.add(toolUseId);
    if (this.pendingCanUseQuestion?.toolUseId === toolUseId) {
      this.pendingCanUseQuestion.resolve({
        behavior: "deny",
        message: "User declined to answer.",
        interrupt: true,
        toolUseID: toolUseId,
      });
      this.pendingCanUseQuestion = null;
      this.resolvePendingQuestion(toolUseId);
      return true;
    }
    if (
      source === "dialog" &&
      this.pendingDialogQuestion?.toolUseId === toolUseId
    ) {
      this.pendingDialogQuestion.resolve({ behavior: "cancelled" });
      this.pendingDialogQuestion = null;
      return true;
    }
    this.state.messageChannel.sendToolResult(
      toolUseId,
      "error: User cancelled the question.",
    );
    this.resolvePendingQuestion(toolUseId);
    return true;
  }

  cancelPendingExitPlan(): boolean {
    if (!this.pendingExitPlan) return false;
    const pending = this.pendingExitPlan;
    this.pendingExitPlan = null;
    pending.resolve({
      behavior: "deny",
      message: "User cancelled.",
      interrupt: true,
      toolUseID: pending.toolUseId,
    });
    return true;
  }

  async *sendMessage(
    prompt: string,
    images?: ImageInput[],
  ): AsyncIterable<unknown> {
    if (!this.state) {
      throw new Error("Persistent query not initialized. Call /init first.");
    }
    if (this.turnActive) {
      throw new Error("Claude already has a turn in progress.");
    }

    this.turnActive = true;
    try {
      this.state.messageChannel.send(prompt, images);
      const streamState = new ToolInputStreamState();
      streamState.resetTurn();

      while (true) {
        const { value, done } = await this.state.iter.next();
        if (done) break;
        for (const event of transformClaudeMessage(value, streamState)) {
          if (event.type === "tool_use" || event.type === "tool_use_delta") {
            this.detectAskUserQuestionTool(event.tool);
          }
        }
        this.detectAskUserQuestion(value);
        yield value;
        if (this.pendingQuestionAnswered) {
          const waiter = this.pendingQuestionAnswered;
          await waiter.promise;
        }
        if ((value as { type?: string }).type === "result") break;
      }
    } finally {
      this.turnActive = false;
    }
  }

  private detectAskUserQuestionTool(
    tool:
      | { id: string; name: string; input?: unknown; partialInput?: string }
      | undefined,
  ): void {
    if (!tool || tool.name !== "AskUserQuestion") return;
    const input =
      tool.input && typeof tool.input === "object"
        ? (tool.input as Record<string, unknown>)
        : null;
    const questions = Array.isArray(input?.questions) ? input.questions : null;
    if (!questions) return;
    this.setPendingQuestion(tool.id, questions, "tool");
  }

  private detectAskUserQuestion(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.type !== "assistant") return;
    const sdkMsg = record.message as Record<string, unknown> | undefined;
    const content = sdkMsg?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (
        b.type === "tool_use" &&
        b.name === "AskUserQuestion" &&
        typeof b.id === "string"
      ) {
        const input = b.input as Record<string, unknown> | undefined;
        const questions = Array.isArray(input?.questions)
          ? input!.questions
          : [];
        this.setPendingQuestion(b.id, questions, "tool");
      }
    }
  }

  private setPendingQuestion(
    toolUseId: string,
    questions: unknown[],
    source: PendingQuestionSource,
  ): void {
    if (this.answeredQuestionToolIds.has(toolUseId)) return;
    if (this.pendingQuestion?.toolUseId === toolUseId) return;
    this.pendingQuestion = { toolUseId, questions };
    this.pendingQuestionSource = source;
    if (source === "tool") {
      this.pendingQuestionAnswered = this.createQuestionWaiter(toolUseId);
    }
  }

  private canUseTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOptions: ToolOptions,
    permissionHandler: (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolOptions: ToolOptions,
    ) => Promise<ToolDecision>,
  ): Promise<ToolDecision> {
    const policyDenial = this.permissionManager.getToolPolicyDenial(toolName);
    if (policyDenial) {
      return Promise.resolve({
        behavior: "deny",
        message: policyDenial,
        interrupt: false,
        toolUseID: toolOptions.toolUseID,
      });
    }
    if (toolName === "ExitPlanMode") {
      return this.handleExitPlanModePermission(toolInput, toolOptions);
    }
    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestionPermission(toolInput, toolOptions);
    }
    const permissionMode = this.state?.options.permissionMode;
    if (permissionMode === "bypassPermissions") {
      return Promise.resolve({
        behavior: "allow",
        updatedInput: toolInput,
        toolUseID: toolOptions.toolUseID,
      });
    }
    if (permissionMode === "dontAsk") {
      return Promise.resolve({
        behavior: "deny",
        message: "Permission required, but current mode is Don't ask.",
        interrupt: false,
        toolUseID: toolOptions.toolUseID,
      });
    }
    return permissionHandler(toolName, toolInput, toolOptions);
  }

  private handleAskUserQuestionPermission(
    toolInput: Record<string, unknown>,
    toolOptions: ToolOptions,
  ): Promise<ToolDecision> {
    const questions = Array.isArray(toolInput.questions)
      ? toolInput.questions
      : null;
    if (!questions) {
      return Promise.resolve({
        behavior: "deny",
        message: "AskUserQuestion had no questions.",
        interrupt: true,
        toolUseID: toolOptions.toolUseID,
      });
    }
    for (const question of questions) {
      if (
        question &&
        typeof question === "object" &&
        !("isOther" in question)
      ) {
        (question as Record<string, unknown>).isOther = true;
      }
    }
    const toolUseId = toolOptions.toolUseID || `ask-${Date.now()}`;
    const storedAnswers = this.answeredQuestionAnswers.get(toolUseId);
    if (storedAnswers) {
      this.answeredQuestionAnswers.delete(toolUseId);
      this.answeredQuestionToolIds.add(toolUseId);
      return Promise.resolve({
        behavior: "allow",
        updatedInput: { ...toolInput, answers: storedAnswers.answers },
        toolUseID: toolUseId,
      });
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.pendingCanUseQuestion?.toolUseId === toolUseId) {
          this.pendingCanUseQuestion = null;
          this.pendingQuestion = null;
          this.pendingQuestionSource = null;
        }
        resolve({
          behavior: "deny",
          message: "User declined to answer.",
          interrupt: true,
          toolUseID: toolUseId,
        });
      };
      if (toolOptions.signal.aborted) {
        onAbort();
        return;
      }
      toolOptions.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingCanUseQuestion = {
        toolUseId,
        toolInput,
        resolve: (value) => {
          toolOptions.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      this.setPendingQuestion(toolUseId, questions, "tool");
    });
  }

  private handleExitPlanModePermission(
    toolInput: Record<string, unknown>,
    toolOptions: ToolOptions,
  ): Promise<ToolDecision> {
    const toolUseId = toolOptions.toolUseID || `exit-plan-${Date.now()}`;
    const storedDecision = this.answeredExitPlanDecisions.get(toolUseId);
    if (storedDecision) {
      this.answeredExitPlanDecisions.delete(toolUseId);
      return Promise.resolve(
        this.resolveExitPlanDecision(toolUseId, toolInput, storedDecision),
      );
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.pendingExitPlan?.toolUseId === toolUseId) {
          this.pendingExitPlan = null;
        }
        resolve({
          behavior: "deny",
          message: "User cancelled.",
          interrupt: true,
          toolUseID: toolUseId,
        });
      };
      if (toolOptions.signal.aborted) {
        onAbort();
        return;
      }
      toolOptions.signal.addEventListener("abort", onAbort, { once: true });
      this.pendingExitPlan = {
        toolUseId,
        input: toolInput,
        resolve: (value) => {
          toolOptions.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
    });
  }

  private resolveExitPlanDecision(
    toolUseId: string,
    input: Record<string, unknown>,
    decision: ExitPlanDecision,
  ): ToolDecision {
    if (decision.type === "feedback") {
      return {
        behavior: "deny",
        message: decision.text || "Please continue planning.",
        interrupt: false,
        toolUseID: toolUseId,
      };
    }
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [
        { type: "setMode", mode: "auto", destination: "session" },
      ],
      toolUseID: toolUseId,
    };
  }

  private handleUserDialog(
    request: {
      dialogKind: string;
      payload: Record<string, unknown>;
      toolUseID?: string;
    },
    signal: AbortSignal,
  ): Promise<
    { behavior: "completed"; result: unknown } | { behavior: "cancelled" }
  > {
    const questions = this.extractDialogQuestions(request.payload);
    if (!questions) return Promise.resolve({ behavior: "cancelled" });
    const toolUseId = request.toolUseID || `dialog-${Date.now()}`;
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.pendingDialogQuestion?.toolUseId === toolUseId) {
          this.pendingDialogQuestion = null;
          this.pendingQuestion = null;
          this.pendingQuestionSource = null;
        }
        resolve({ behavior: "cancelled" });
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingDialogQuestion = {
        toolUseId,
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      this.setPendingQuestion(toolUseId, questions, "dialog");
    });
  }

  private extractDialogQuestions(
    payload: Record<string, unknown>,
  ): unknown[] | null {
    if (Array.isArray(payload.questions)) return payload.questions;
    const input =
      payload.input && typeof payload.input === "object"
        ? (payload.input as Record<string, unknown>)
        : null;
    if (Array.isArray(input?.questions)) return input.questions;
    const toolInput =
      payload.toolInput && typeof payload.toolInput === "object"
        ? (payload.toolInput as Record<string, unknown>)
        : null;
    if (Array.isArray(toolInput?.questions)) return toolInput.questions;
    return null;
  }

  private createQuestionWaiter(toolUseId: string): {
    toolUseId: string;
    promise: Promise<void>;
    resolve: () => void;
  } {
    if (this.pendingQuestionAnswered?.toolUseId === toolUseId) {
      return this.pendingQuestionAnswered;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { toolUseId, promise, resolve };
  }

  private resolvePendingQuestion(toolUseId: string): void {
    if (this.pendingQuestionAnswered?.toolUseId !== toolUseId) return;
    this.pendingQuestionAnswered.resolve();
    this.pendingQuestionAnswered = null;
  }

  async supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    if (!this.state) return [];
    try {
      return await this.state.query.supportedCommands();
    } catch {
      return [];
    }
  }

  async reloadSkills(): Promise<
    Array<{ name: string; description: string; argumentHint?: string }>
  > {
    if (!this.state) return [];
    try {
      const result = await this.state.query.reloadSkills();
      const skills = Array.isArray(result?.skills) ? result.skills : [];
      return skills.map((s) => ({
        name: s.name || "",
        description: s.description || "",
        argumentHint: s.argumentHint,
      }));
    } catch {
      return [];
    }
  }

  async setPermissionMode(mode: string | undefined): Promise<void> {
    if (!this.state) return;
    const normalized = normalizePermissionMode(mode);
    if (this.state.options.permissionMode === normalized) return;
    await this.state.query.setPermissionMode(normalized as PermissionMode);
    this.state.options.permissionMode = normalized as PermissionMode;
  }

  cancelActiveTurn(): void {
    this.cancelPendingQuestion();
    this.cancelPendingExitPlan();
    void this.state?.query.interrupt().catch(() => {});
  }

  close(): void {
    if (!this.state) return;
    if (this.pendingQuestionAnswered) {
      this.pendingQuestionAnswered.resolve();
      this.pendingQuestionAnswered = null;
    }
    this.pendingQuestion = null;
    this.pendingQuestionSource = null;
    this.pendingCanUseQuestion?.resolve({
      behavior: "deny",
      message: "User declined to answer.",
      interrupt: true,
      toolUseID: this.pendingCanUseQuestion.toolUseId,
    });
    this.pendingCanUseQuestion = null;
    this.answeredQuestionAnswers.clear();
    this.answeredExitPlanDecisions.clear();
    this.cancelPendingExitPlan();
    this.pendingDialogQuestion?.resolve({ behavior: "cancelled" });
    this.pendingDialogQuestion = null;
    this.answeredQuestionToolIds.clear();
    this.turnActive = false;
    this.toolPolicy = undefined;
    this.permissionManager.setToolPolicy(undefined);
    void this.state.query.interrupt().catch(() => {});
    void this.state.iter.return?.().catch(() => {});
    this.state.messageChannel.close();
    this.state = null;
  }

  requiresRestart(newConfig: RestartConfig): boolean {
    if (!this.state) return false;

    const currentModel = this.state.options.model;
    const currentEffort = this.state.options.effort;
    const currentClaudePath = this.state.options.pathToClaudeCodeExecutable;
    const currentDirs = this.state.options.additionalDirectories;
    const currentZoteroEndpointUrl = this.state.zoteroEndpointUrl;
    const currentZoteroEndpointToken = this.state.zoteroEndpointToken;
    const currentEnableZoteroMcp = this.state.enableZoteroMcp;
    const currentMcpServers = this.state.mcpServers;
    const currentMcpDisabledTools = this.state.mcpDisabledTools;
    const currentConversationId = this.state.conversationId;

    return (
      (newConfig.model !== undefined && newConfig.model !== currentModel) ||
      (newConfig.effort !== undefined && newConfig.effort !== currentEffort) ||
      (newConfig.claudePath !== undefined &&
        newConfig.claudePath !== currentClaudePath) ||
      (newConfig.additionalDirectories !== undefined &&
        JSON.stringify([...newConfig.additionalDirectories].sort()) !==
          JSON.stringify([...(currentDirs || [])].sort())) ||
      (newConfig.environment !== undefined &&
        !sameEnvironment(newConfig.environment, this.state.environment)) ||
      (newConfig.zoteroEndpointUrl !== undefined &&
        newConfig.zoteroEndpointUrl !== currentZoteroEndpointUrl) ||
      (newConfig.zoteroEndpointToken !== undefined &&
        newConfig.zoteroEndpointToken !== currentZoteroEndpointToken) ||
      (newConfig.enableZoteroMcp !== undefined &&
        newConfig.enableZoteroMcp !== currentEnableZoteroMcp) ||
      (newConfig.mcpServers !== undefined &&
        JSON.stringify(newConfig.mcpServers) !==
          JSON.stringify(currentMcpServers || {})) ||
      (newConfig.mcpDisabledTools !== undefined &&
        JSON.stringify([...(newConfig.mcpDisabledTools || [])].sort()) !==
          JSON.stringify([...(currentMcpDisabledTools || [])].sort())) ||
      (newConfig.conversationId !== undefined &&
        newConfig.conversationId !== currentConversationId) ||
      (newConfig.providerState?.sessionId !== undefined &&
        newConfig.providerState.sessionId !==
          this.state.providerState?.sessionId)
    );
  }
}

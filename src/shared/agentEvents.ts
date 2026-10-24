export const AGENT_EVENT_PROTOCOL = "claudero.agent-event" as const;
export const AGENT_EVENT_PROTOCOL_VERSION = 1 as const;

export interface ToolUseEvent {
  id: string;
  name: string;
  input?: unknown;
  partialInput?: string;
}

export interface ToolResultEvent {
  id: string;
  content: string;
  isError: boolean;
}

export interface UsageEvent {
  outputTokens: number;
  final: boolean;
  durationMs?: number;
}

export interface CommandDefinition {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ProviderSessionState {
  provider: "claude" | "codex" | "deepseek";
  sessionId?: string;
  threadId?: string;
  sessionFilePath?: string;
  turnId?: string;
}

export type AgentStreamEvent =
  | { type: "session"; session: ProviderSessionState }
  | { type: "text"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "text_snapshot"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinking_snapshot"; text: string }
  | { type: "context_compaction"; phase: "started" | "completed" }
  | {
      type: "connection_status";
      status: "reconnecting";
      attempt: number;
      maxAttempts: number;
    }
  | { type: "tool_use"; tool: ToolUseEvent }
  | {
      type: "tool_use_delta";
      index?: string;
      partialInput?: string;
      input?: unknown;
      tool?: ToolUseEvent;
    }
  | { type: "tool_result"; result: ToolResultEvent }
  | { type: "usage"; usage: UsageEvent }
  | { type: "thinking_tokens"; estimatedTokens: number }
  | {
      type: "tool_progress";
      toolUseId: string;
      toolName: string;
      elapsedSeconds: number;
    }
  | { type: "error"; error: string }
  | { type: "commands_changed"; commands: CommandDefinition[] };

export type AgentRequestOutcome = "success" | "error" | "cancelled";

export type AgentControlEvent =
  | { type: "ready"; requestId: string }
  | { type: "done"; requestId: string; outcome: AgentRequestOutcome };

export type AgentEventPayload = AgentStreamEvent | AgentControlEvent;

export interface AgentEventSource {
  provider?: "claude" | "codex" | "deepseek";
  conversationId?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  runtime?: "helper" | "browser" | "test";
}

export interface AgentEventEnvelope<
  T extends AgentEventPayload = AgentEventPayload,
> {
  protocol: typeof AGENT_EVENT_PROTOCOL;
  version: typeof AGENT_EVENT_PROTOCOL_VERSION;
  id: string;
  traceId: string;
  sequence: number;
  timestamp: number;
  source: AgentEventSource;
  event: T;
}

export interface AgentEventTrace {
  traceId: string;
  startedAt: number;
  source: AgentEventSource;
  events: AgentEventEnvelope[];
  retention?: {
    totalEvents: number;
    droppedEvents: number;
    retainedBytes: number;
    maxEvents: number;
    maxBytes: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isToolUse(value: unknown): value is ToolUseEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    optionalString(value.partialInput)
  );
}

export function isAgentEventPayload(
  value: unknown,
): value is AgentEventPayload {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "ready":
    case "done":
      return (
        typeof value.requestId === "string" &&
        value.requestId.length > 0 &&
        (value.type === "ready" ||
          value.outcome === "success" ||
          value.outcome === "error" ||
          value.outcome === "cancelled")
      );
    case "session": {
      const session = value.session;
      return (
        isRecord(session) &&
        (session.provider === "claude" ||
          session.provider === "codex" ||
          session.provider === "deepseek") &&
        ["sessionId", "threadId", "sessionFilePath", "turnId"].every((key) =>
          optionalString(session[key]),
        )
      );
    }
    case "text":
    case "text_delta":
    case "text_snapshot":
    case "thinking":
    case "thinking_snapshot":
      return typeof value.text === "string";
    case "context_compaction":
      return value.phase === "started" || value.phase === "completed";
    case "connection_status":
      return (
        value.status === "reconnecting" &&
        nonnegativeNumber(value.attempt) &&
        Number.isSafeInteger(value.attempt) &&
        nonnegativeNumber(value.maxAttempts) &&
        Number.isSafeInteger(value.maxAttempts)
      );
    case "tool_use":
      return isToolUse(value.tool);
    case "tool_use_delta":
      return (
        optionalString(value.index) &&
        optionalString(value.partialInput) &&
        (value.tool === undefined || isToolUse(value.tool))
      );
    case "tool_result":
      return (
        isRecord(value.result) &&
        typeof value.result.id === "string" &&
        typeof value.result.content === "string" &&
        typeof value.result.isError === "boolean"
      );
    case "usage":
      return (
        isRecord(value.usage) &&
        nonnegativeNumber(value.usage.outputTokens) &&
        typeof value.usage.final === "boolean" &&
        (value.usage.durationMs === undefined ||
          nonnegativeNumber(value.usage.durationMs))
      );
    case "thinking_tokens":
      return nonnegativeNumber(value.estimatedTokens);
    case "tool_progress":
      return (
        typeof value.toolUseId === "string" &&
        typeof value.toolName === "string" &&
        nonnegativeNumber(value.elapsedSeconds)
      );
    case "error":
      return typeof value.error === "string";
    case "commands_changed":
      return (
        Array.isArray(value.commands) &&
        value.commands.every(
          (command) =>
            isRecord(command) &&
            typeof command.name === "string" &&
            typeof command.description === "string" &&
            optionalString(command.argumentHint),
        )
      );
    default:
      return false;
  }
}

export function createAgentEventEnvelope<T extends AgentEventPayload>(
  event: T,
  options: {
    traceId: string;
    sequence: number;
    timestamp: number;
    source?: AgentEventSource;
  },
): AgentEventEnvelope<T> {
  return {
    protocol: AGENT_EVENT_PROTOCOL,
    version: AGENT_EVENT_PROTOCOL_VERSION,
    id: `${options.traceId}:${options.sequence}`,
    traceId: options.traceId,
    sequence: options.sequence,
    timestamp: options.timestamp,
    source: options.source || {},
    event,
  };
}

export class AgentEventRecorder {
  private sequence = 0;
  private readonly trace: AgentEventTrace;
  private readonly sizes: number[] = [];
  private retainedBytes = 0;
  private droppedEvents = 0;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(
    source: AgentEventSource = {},
    options: {
      traceId?: string;
      startedAt?: number;
      maxEvents?: number;
      maxBytes?: number;
    } = {},
  ) {
    this.maxEvents = Math.max(1, options.maxEvents ?? 2048);
    this.maxBytes = Math.max(1, options.maxBytes ?? 4 * 1024 * 1024);
    const startedAt = options.startedAt ?? Date.now();
    const traceId =
      options.traceId ||
      `trace-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.trace = {
      traceId,
      startedAt,
      source,
      events: [],
    };
  }

  record(
    event: AgentEventPayload,
    source: AgentEventSource = {},
  ): AgentEventEnvelope {
    const envelope = createAgentEventEnvelope(event, {
      traceId: this.trace.traceId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      source: { ...this.trace.source, ...source },
    });
    const serialized = JSON.stringify(envelope);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > this.maxBytes) {
      this.droppedEvents++;
      return envelope;
    }
    while (
      this.trace.events.length >= this.maxEvents ||
      this.retainedBytes + bytes > this.maxBytes
    ) {
      this.trace.events.shift();
      this.retainedBytes -= this.sizes.shift()!;
      this.droppedEvents++;
    }
    this.trace.events.push(JSON.parse(serialized) as AgentEventEnvelope);
    this.sizes.push(bytes);
    this.retainedBytes += bytes;
    return envelope;
  }

  snapshot(): AgentEventTrace {
    return {
      ...this.trace,
      source: { ...this.trace.source },
      events: JSON.parse(
        JSON.stringify(this.trace.events),
      ) as AgentEventEnvelope[],
      retention: {
        totalEvents: this.sequence,
        droppedEvents: this.droppedEvents,
        retainedBytes: this.retainedBytes,
        maxEvents: this.maxEvents,
        maxBytes: this.maxBytes,
      },
    };
  }
}

export function replayAgentText(events: AgentEventPayload[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text" || event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "text_snapshot") {
      text = event.text;
    }
  }
  return text;
}

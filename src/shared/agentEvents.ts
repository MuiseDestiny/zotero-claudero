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
  provider: "claude" | "codex";
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

export type AgentControlEvent = { type: "ready" } | { type: "done" };

export type AgentEventPayload = AgentStreamEvent | AgentControlEvent;

export interface AgentEventSource {
  provider?: "claude" | "codex";
  conversationId?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  runtime?: "helper" | "browser" | "test";
}

export interface AgentEventEnvelope<T extends AgentEventPayload = AgentEventPayload> {
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
}

const EVENT_TYPES = new Set<string>([
  "ready",
  "done",
  "session",
  "text",
  "text_delta",
  "text_snapshot",
  "thinking",
  "thinking_snapshot",
  "tool_use",
  "tool_use_delta",
  "tool_result",
  "usage",
  "thinking_tokens",
  "tool_progress",
  "error",
  "commands_changed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function isAgentEventPayload(value: unknown): value is AgentEventPayload {
  return isRecord(value) && typeof value.type === "string" && EVENT_TYPES.has(value.type);
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

  constructor(
    source: AgentEventSource = {},
    options: { traceId?: string; startedAt?: number } = {},
  ) {
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

  record(event: AgentEventPayload, source: AgentEventSource = {}): AgentEventEnvelope {
    const envelope = createAgentEventEnvelope(event, {
      traceId: this.trace.traceId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      source: { ...this.trace.source, ...source },
    });
    this.trace.events.push(envelope);
    return envelope;
  }

  snapshot(): AgentEventTrace {
    return {
      ...this.trace,
      source: { ...this.trace.source },
      events: this.trace.events.map((event) => ({
        ...event,
        source: { ...event.source },
      })),
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

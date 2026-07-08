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

export type ClauderoStreamEvent =
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

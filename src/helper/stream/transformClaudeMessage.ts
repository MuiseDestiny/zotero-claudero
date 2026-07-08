import { ToolInputStreamState } from "./toolInputStreamState";
import type {
  ClauderoStreamEvent,
  CommandDefinition,
  ToolResultEvent,
  ToolUseEvent,
} from "./types";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function extractToolResultContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractToolResultContent).filter(Boolean).join("\n");
  }
  const record = recordValue(value);
  if (!record) return stringifyValue(value);
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content))
    return extractToolResultContent(record.content);
  if (typeof record.text === "string") return record.text;
  return stringifyValue(value);
}

function normalizeTool(block: Record<string, unknown>): ToolUseEvent {
  return {
    id: stringValue(block.id) || "tool-" + Date.now(),
    name: stringValue(block.name) || "unknown",
    input: block.input,
  };
}

function commandsChangedEvent(
  record: Record<string, unknown>,
): ClauderoStreamEvent | null {
  if (
    record.type !== "system" ||
    record.subtype !== "commands_changed" ||
    !Array.isArray(record.commands)
  ) {
    return null;
  }
  return {
    type: "commands_changed",
    commands: record.commands as CommandDefinition[],
  };
}

function transformAssistantMessage(
  record: Record<string, unknown>,
  state: ToolInputStreamState,
): ClauderoStreamEvent[] {
  const events: ClauderoStreamEvent[] = [];
  const sdkMessage = recordValue(record.message);
  const content = sdkMessage?.content;
  if (!Array.isArray(content)) return events;

  content.forEach((blockValue, blockIndex) => {
    const block = recordValue(blockValue);
    if (!block) return;
    const index = String(blockIndex);
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const reconciled = state.reconcileThinking(index, block.thinking);
      if (reconciled.kind === "append" && reconciled.text) {
        events.push({ type: "thinking", text: reconciled.text });
      } else if (reconciled.kind === "snapshot") {
        events.push({ type: "thinking_snapshot", text: reconciled.text });
      }
    } else if (block.type === "text" && typeof block.text === "string") {
      const reconciled = state.reconcileText(index, block.text);
      if (reconciled.kind === "append" && reconciled.text) {
        events.push({ type: "text", text: reconciled.text });
      } else if (reconciled.kind === "snapshot") {
        events.push({ type: "text_snapshot", text: reconciled.text });
      }
    } else if (block.type === "tool_use") {
      const tool = state.registerToolUse(index, normalizeTool(block));
      if (tool) events.push({ type: "tool_use", tool });
    }
  });

  const usage = recordValue(sdkMessage?.usage);
  const outputTokens = numberValue(usage?.output_tokens);
  if (outputTokens !== null) {
    events.push({
      type: "usage",
      usage: { outputTokens: Math.max(0, outputTokens), final: false },
    });
  }
  if (typeof record.error === "string" && record.error) {
    events.push({
      type: "error",
      error:
        record.error === "max_output_tokens"
          ? "Claude reached the maximum output token limit before finishing its response."
          : `Claude assistant error: ${record.error}`,
    });
  }

  return events;
}

function transformUserMessage(
  record: Record<string, unknown>,
  state: ToolInputStreamState,
): ClauderoStreamEvent[] {
  const events: ClauderoStreamEvent[] = [];
  const sdkMessage = recordValue(record.message);
  const content = sdkMessage?.content;
  if (Array.isArray(content)) {
    for (const blockValue of content) {
      const block = recordValue(blockValue);
      if (block?.type !== "tool_result") continue;
      const result: ToolResultEvent = {
        id:
          stringValue(block.tool_use_id) ||
          stringValue(record.parent_tool_use_id),
        content: extractToolResultContent(block.content),
        isError: block.is_error === true,
      };
      events.push({ type: "tool_result", result });
    }
  }

  if (
    events.length === 0 &&
    typeof record.parent_tool_use_id === "string" &&
    record.tool_use_result !== undefined
  ) {
    const resultContent = extractToolResultContent(record.tool_use_result);
    events.push({
      type: "tool_result",
      result: {
        id: record.parent_tool_use_id,
        content: resultContent,
        isError: /^error:/i.test(resultContent.trim()),
      },
    });
  }

  if (events.some((event) => event.type === "tool_result")) {
    state.markToolResult();
  }

  return events;
}

export function transformClaudeMessage(
  message: unknown,
  state: ToolInputStreamState,
): ClauderoStreamEvent[] {
  const record = recordValue(message);
  if (!record) return [];

  const commandEvent = commandsChangedEvent(record);
  if (commandEvent) return [commandEvent];

  if (record.type === "stream_event") {
    const event = recordValue(record.event);
    if (!event) return [];
    const index = String(numberValue(event.index) ?? 0);
    if (event.type === "content_block_start") {
      const block = recordValue(event.content_block);
      if (!block) return [];
      if (block.type === "tool_use") {
        const tool = state.registerToolUse(index, normalizeTool(block));
        return tool ? [{ type: "tool_use", tool }] : [];
      }
      // Claude Code intentionally ignores text/thinking attached to
      // content_block_start: some SDK transports repeat the same bytes in the
      // first delta, and there is no reliable way to distinguish the duplicate.
      return [];
    }
    if (event.type === "content_block_delta") {
      const delta = recordValue(event.delta);
      if (!delta) return [];
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        state.markTextDelta(index, delta.text);
        return delta.text ? [{ type: "text_delta", text: delta.text }] : [];
      }
      if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        state.appendThinkingDelta(index, delta.thinking);
        return delta.thinking
          ? [{ type: "thinking", text: delta.thinking }]
          : [];
      }
      if (
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        const tool = state.applyInputJsonDelta(index, delta.partial_json);
        return tool
          ? [
              {
                type: "tool_use_delta",
                index,
                partialInput: tool.partialInput,
                input: tool.input,
                tool,
              },
            ]
          : [];
      }
      return [];
    }
    if (event.type === "content_block_stop") {
      state.stopToolUse(index);
    }
    return [];
  }

  if (record.type === "assistant") {
    return transformAssistantMessage(record, state);
  }

  if (record.type === "user") {
    return transformUserMessage(record, state);
  }

  if (record.type === "system" && record.subtype === "thinking_tokens") {
    const estimatedTokens = numberValue(record.estimated_tokens);
    return estimatedTokens === null
      ? []
      : [{ type: "thinking_tokens", estimatedTokens }];
  }

  if (record.type === "tool_progress") {
    const toolUseId = stringValue(record.tool_use_id);
    const elapsedSeconds = numberValue(record.elapsed_time_seconds);
    if (!toolUseId || elapsedSeconds === null) return [];
    return [
      {
        type: "tool_progress",
        toolUseId,
        toolName: stringValue(record.tool_name) || "Tool",
        elapsedSeconds,
      },
    ];
  }

  if (record.type === "result") {
    const events: ClauderoStreamEvent[] = [];
    const resultText = stringValue(record.result);
    if (!state.hasTextDelta() && resultText) {
      state.markTextDelta();
      events.push({ type: "text", text: resultText });
    }

    const subtype = stringValue(record.subtype);
    const stopReason = stringValue(record.stop_reason);
    const errors = Array.isArray(record.errors)
      ? record.errors.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (record.is_error === true || (subtype && subtype !== "success")) {
      events.push({
        type: "error",
        error:
          errors.join("\n") ||
          `Claude ended without a final response (${subtype || "execution error"}).`,
      });
    } else if (
      stopReason === "max_tokens" ||
      stopReason === "max_output_tokens"
    ) {
      events.push({
        type: "error",
        error:
          "Claude reached the maximum output token limit before finishing its response.",
      });
    }

    const usage = recordValue(record.usage);
    const outputTokens = numberValue(usage?.output_tokens);
    if (outputTokens !== null) {
      const durationMs = numberValue(record.duration_ms);
      events.push({
        type: "usage",
        usage: {
          outputTokens: Math.max(0, outputTokens),
          final: true,
          ...(durationMs === null ? {} : { durationMs }),
        },
      });
    }
    return events;
  }

  return [];
}

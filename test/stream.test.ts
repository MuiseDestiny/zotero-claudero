import { assert } from "chai";
import { ToolInputStreamState } from "../src/helper/stream/toolInputStreamState";
import { transformClaudeMessage } from "../src/helper/stream/transformClaudeMessage";

describe("Claude stream normalization", function () {
  it("emits a resumable Claude session id from the init event", function () {
    const state = new ToolInputStreamState();
    const events = transformClaudeMessage(
      { type: "system", subtype: "init", session_id: "session-123" },
      state,
    );
    assert.deepEqual(events, [
      {
        type: "session",
        session: { provider: "claude", sessionId: "session-123" },
      },
    ]);
  });

  it("streams previews and reconciles them with the complete assistant message", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const preview = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "错乱的预览" },
        },
      },
      state,
    );

    const complete = transformClaudeMessage(
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "完整思考" },
            { type: "text", text: "完整正文" },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "echo ok" },
            },
          ],
        },
      },
      state,
    );

    assert.deepEqual(preview, [{ type: "text_delta", text: "错乱的预览" }]);
    assert.deepEqual(complete, [
      { type: "thinking", text: "完整思考" },
      { type: "text_snapshot", text: "完整正文" },
      {
        type: "tool_use",
        tool: { id: "tool-1", name: "Bash", input: { command: "echo ok" } },
      },
    ]);
  });

  it("emits real text deltas without duplicating the authoritative final block", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const first = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "实时" },
        },
      },
      state,
    );
    const second = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "正文" },
        },
      },
      state,
    );
    const complete = transformClaudeMessage(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "实时正文" }] },
      },
      state,
    );

    assert.deepEqual(first, [{ type: "text_delta", text: "实时" }]);
    assert.deepEqual(second, [{ type: "text_delta", text: "正文" }]);
    assert.deepEqual(complete, []);
  });

  it("ignores duplicated text carried by content_block_start", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const start = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "duplicate" },
        },
      },
      state,
    );
    const delta = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "duplicate" },
        },
      },
      state,
    );
    const complete = transformClaudeMessage(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "duplicate" }] },
      },
      state,
    );

    assert.deepEqual(start, []);
    assert.deepEqual(delta, [{ type: "text_delta", text: "duplicate" }]);
    assert.deepEqual(complete, []);
  });

  it("streams thinking and tool JSON deltas", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const thinking = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "分析中" },
        },
      },
      state,
    );
    const start = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-live", name: "Read" },
        },
      },
      state,
    );
    const input = transformClaudeMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"file_path":"paper.pdf"}',
          },
        },
      },
      state,
    );

    assert.deepEqual(thinking, [{ type: "thinking", text: "分析中" }]);
    assert.deepEqual(start, [
      {
        type: "tool_use",
        tool: { id: "tool-live", name: "Read", input: undefined },
      },
    ]);
    assert.deepEqual(input, [
      {
        type: "tool_use_delta",
        index: "1",
        partialInput: '{"file_path":"paper.pdf"}',
        input: { file_path: "paper.pdf" },
        tool: {
          id: "tool-live",
          name: "Read",
          input: { file_path: "paper.pdf" },
          partialInput: '{"file_path":"paper.pdf"}',
        },
      },
    ]);
  });

  it("prefers an explicit tool_result over the wrapper fallback", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const events = transformClaudeMessage(
      {
        type: "user",
        parent_tool_use_id: "parent-tool",
        tool_use_result: "wrapper result",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "actual-tool",
              content: "actual result",
            },
          ],
        },
      },
      state,
    );

    assert.deepEqual(events, [
      {
        type: "tool_result",
        result: {
          id: "actual-tool",
          content: "actual result",
          isError: false,
        },
      },
    ]);
  });

  it("emits live and final token usage for the activity indicator", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const assistant = transformClaudeMessage(
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "done" }],
          usage: { output_tokens: 744 },
        },
      },
      state,
    );
    const thinking = transformClaudeMessage(
      {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 116,
      },
      state,
    );
    const result = transformClaudeMessage(
      {
        type: "result",
        subtype: "success",
        duration_ms: 12000,
        usage: { output_tokens: 860 },
      },
      state,
    );

    assert.deepEqual(assistant, [
      { type: "text", text: "done" },
      {
        type: "usage",
        usage: { outputTokens: 744, final: false },
      },
    ]);
    assert.deepEqual(thinking, [
      { type: "thinking_tokens", estimatedTokens: 116 },
    ]);
    assert.deepEqual(result, [
      {
        type: "usage",
        usage: { outputTokens: 860, final: true, durationMs: 12000 },
      },
    ]);
  });

  it("emits tool progress without treating it as assistant text", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const events = transformClaudeMessage(
      {
        type: "tool_progress",
        tool_use_id: "tool-9",
        tool_name: "Bash",
        elapsed_time_seconds: 8.7,
      },
      state,
    );

    assert.deepEqual(events, [
      {
        type: "tool_progress",
        toolUseId: "tool-9",
        toolName: "Bash",
        elapsedSeconds: 8.7,
      },
    ]);
  });

  it("uses the SDK result text when the final assistant block is missing", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    transformClaudeMessage(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "I will inspect it." }] },
      },
      state,
    );
    transformClaudeMessage(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
        },
      },
      state,
    );

    const events = transformClaudeMessage(
      {
        type: "result",
        subtype: "success",
        result: "The complete final answer.",
        stop_reason: "end_turn",
        usage: { output_tokens: 42 },
      },
      state,
    );

    assert.deepEqual(events, [
      { type: "text", text: "The complete final answer." },
      {
        type: "usage",
        usage: { outputTokens: 42, final: true },
      },
    ]);
  });

  it("surfaces output-limit termination instead of silently completing", function () {
    const state = new ToolInputStreamState();
    state.resetTurn();

    const events = transformClaudeMessage(
      {
        type: "result",
        subtype: "success",
        result: "",
        stop_reason: "max_tokens",
        usage: { output_tokens: 4096 },
      },
      state,
    );

    assert.deepEqual(events, [
      {
        type: "error",
        error:
          "Claude reached the maximum output token limit before finishing its response.",
      },
      {
        type: "usage",
        usage: { outputTokens: 4096, final: true },
      },
    ]);
  });
});

import { assert } from "chai";
import {
  AGENT_EVENT_PROTOCOL,
  AGENT_EVENT_PROTOCOL_VERSION,
  AgentEventRecorder,
  createAgentEventEnvelope,
  isAgentEventPayload,
  replayAgentText,
} from "../src/shared/agentEvents";

describe("agent event protocol", function () {
  it("creates versioned event envelopes", function () {
    const envelope = createAgentEventEnvelope(
      { type: "text_delta", text: "hello" },
      {
        traceId: "trace-1",
        sequence: 7,
        timestamp: 1234,
        source: { provider: "codex", runtime: "helper" },
      },
    );

    assert.deepEqual(envelope, {
      protocol: AGENT_EVENT_PROTOCOL,
      version: AGENT_EVENT_PROTOCOL_VERSION,
      id: "trace-1:7",
      traceId: "trace-1",
      sequence: 7,
      timestamp: 1234,
      source: { provider: "codex", runtime: "helper" },
      event: { type: "text_delta", text: "hello" },
    });
  });

  it("records a replayable trace with stable ordering", function () {
    const recorder = new AgentEventRecorder(
      { provider: "claude", conversationId: "conv-1", runtime: "helper" },
      { traceId: "trace-2", startedAt: 100 },
    );

    recorder.record({ type: "ready", requestId: "r1" });
    recorder.record({ type: "text_delta", text: "A" });
    recorder.record({ type: "text_delta", text: "B" });
    recorder.record({ type: "done", requestId: "r1", outcome: "success" });

    const trace = recorder.snapshot();
    assert.equal(trace.traceId, "trace-2");
    assert.deepEqual(
      trace.events.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.equal(
      replayAgentText(trace.events.map((event) => event.event)),
      "AB",
    );
  });

  it("replays text snapshots as authoritative state", function () {
    assert.equal(
      replayAgentText([
        { type: "text_delta", text: "draft" },
        { type: "text_snapshot", text: "final" },
        { type: "text_delta", text: "!" },
      ]),
      "final!",
    );
  });

  it("accepts context compaction as a visible control event", function () {
    assert.isTrue(
      isAgentEventPayload({ type: "context_compaction", phase: "started" }),
    );
  });

  it("validates fields rather than trusting a recognized event type", function () {
    for (const value of [
      null,
      [],
      { type: "unknown" },
      { type: "text", text: 42 },
      { type: "session", session: { provider: "other" } },
      { type: "session", session: { provider: "codex", threadId: [] } },
      { type: "ready", requestId: "" },
      { type: "done", requestId: "r1", outcome: "maybe" },
      { type: "tool_use", tool: { id: "t1" } },
      { type: "tool_use_delta", index: 0 },
      { type: "tool_use_delta", tool: null },
      { type: "tool_result", result: { id: "t1", content: "ok" } },
      { type: "usage", usage: { outputTokens: -1, final: true } },
      { type: "usage", usage: { outputTokens: Infinity, final: true } },
      { type: "usage", usage: { outputTokens: 1, final: "yes" } },
      { type: "thinking_tokens", estimatedTokens: NaN },
      { type: "context_compaction", phase: "other" },
      { type: "connection_status", status: "reconnecting", attempt: 1 },
      { type: "tool_progress", toolUseId: "t1", elapsedSeconds: 1 },
      { type: "commands_changed", commands: [{}] },
      { type: "error", error: {} },
    ]) {
      assert.isFalse(isAgentEventPayload(value), JSON.stringify(value));
    }
    for (const value of [
      { type: "session", session: { provider: "codex", threadId: "thread" } },
      { type: "tool_use", tool: { id: "t1", name: "search", input: {} } },
      { type: "tool_use_delta", index: "0", partialInput: "{" },
      {
        type: "tool_result",
        result: { id: "t1", content: "ok", isError: false },
      },
      { type: "usage", usage: { outputTokens: 1, final: true, durationMs: 0 } },
      { type: "thinking_tokens", estimatedTokens: 0 },
      {
        type: "connection_status",
        status: "reconnecting",
        attempt: 1,
        maxAttempts: 3,
      },
      {
        type: "tool_progress",
        toolUseId: "t1",
        toolName: "search",
        elapsedSeconds: 0.5,
      },
      {
        type: "commands_changed",
        commands: [{ name: "help", description: "" }],
      },
    ]) {
      assert.isTrue(isAgentEventPayload(value), JSON.stringify(value));
    }
  });
});

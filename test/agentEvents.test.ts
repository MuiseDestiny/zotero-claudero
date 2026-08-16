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

    recorder.record({ type: "ready" });
    recorder.record({ type: "text_delta", text: "A" });
    recorder.record({ type: "text_delta", text: "B" });
    recorder.record({ type: "done" });

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
});

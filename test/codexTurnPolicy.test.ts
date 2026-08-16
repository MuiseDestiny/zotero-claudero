import { assert } from "chai";
import {
  CODEX_CONTEXT_COMPACTION_TIMEOUT_MS,
  CODEX_TURN_IDLE_TIMEOUT_MS,
  codexTurnIdleTimeoutMs,
  parseCodexReconnectStatus,
} from "../src/helper/runtime/codexTurnPolicy";

describe("Codex turn timeout policy", function () {
  it("allows context compaction to run longer than an ordinary idle turn", function () {
    assert.equal(codexTurnIdleTimeoutMs(false), CODEX_TURN_IDLE_TIMEOUT_MS);
    assert.equal(
      codexTurnIdleTimeoutMs(true),
      CODEX_CONTEXT_COMPACTION_TIMEOUT_MS,
    );
    assert.isAbove(
      CODEX_CONTEXT_COMPACTION_TIMEOUT_MS,
      CODEX_TURN_IDLE_TIMEOUT_MS,
    );
  });

  it("treats reconnect notices as transient status instead of final errors", function () {
    assert.deepEqual(parseCodexReconnectStatus("Reconnecting... 2/2"), {
      attempt: 2,
      maxAttempts: 2,
    });
    assert.isNull(parseCodexReconnectStatus("stream disconnected"));
  });
});

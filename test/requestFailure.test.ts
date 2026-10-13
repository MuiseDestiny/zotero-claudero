import { assert } from "chai";
import {
  classifyRequestFailure,
  createRecoveryAction,
  type RequestFailureKind,
} from "../src/shared/requestFailure";
import {
  captureConversationGuard,
  invalidateConversation,
} from "../src/modules/conversationTransition";

const cases: Array<[string, RequestFailureKind]> = [
  ["Node.js not found. Set Node path.", "node"],
  ["DeepSeek Harness requires Node.js 24 or newer", "node"],
  ["Set DSH_NODE_PATH to a compatible runtime", "node"],
  ["Claude Code CLI not found", "cli"],
  ["DeepSeek Harness CLI not found", "cli"],
  ["spawn /opt/bin/codex ENOENT", "cli"],
  ["Codex thread not found", "session"],
  ["Claude session expired", "session"],
  ["no rollout found for thread", "session"],
  ["Unable to resume session", "session"],
  ["dsh missing DEEPSEEK_API_KEY", "auth"],
  ["Codex authentication token missing", "auth"],
  ["Unauthorized (401)", "auth"],
  ["Please log in", "auth"],
  ["Not logged in · Please run /login", "auth"],
  ["Request not allowed", "auth"],
  ["API quota exceeded (429)", "limit"],
  ["Session limit reached", "limit"],
  ["You've hit your limit · resets 8pm", "limit"],
  ["TypeError: fetch failed", "connection"],
  ["connect ECONNREFUSED", "connection"],
  ["getaddrinfo ENOTFOUND api.example.test", "connection"],
  ["Request timed out", "connection"],
  ["Service unavailable (503)", "connection"],
  ["Unrecognized provider result", "unknown"],
];

describe("request failure recovery", function () {
  for (const [message, kind] of cases) {
    it(`classifies ${message}`, function () {
      assert.equal(classifyRequestFailure(message), kind);
    });
  }

  it("never replays automatically and rejects concurrent or repeated clicks", async function () {
    let count = 0;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const recover = createRecoveryAction(
      () => true,
      async () => {
        count++;
        await pending;
      },
    );
    assert.equal(count, 0);
    const first = recover();
    assert.isFalse(await recover());
    finish();
    assert.isTrue(await first);
    assert.isFalse(await recover());
    assert.equal(count, 1);
  });

  it("allows another click when confirmation is cancelled or saving fails", async function () {
    let count = 0;
    const recover = createRecoveryAction(
      () => true,
      async () => ++count > 1,
    );
    assert.isFalse(await recover());
    assert.isTrue(await recover());
    assert.isFalse(await recover());
    assert.equal(count, 2);
  });

  it("releases the click guard after an unexpected failure", async function () {
    let count = 0;
    const recover = createRecoveryAction(
      () => true,
      async () => {
        if (++count === 1) throw new Error("save unavailable");
      },
    );
    let error: unknown;
    try {
      await recover();
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.isTrue(await recover());
  });

  it("rejects busy, transitioning, disposed, or replaced conversation actions", async function () {
    const state = {
      conversationId: "original",
      running: true,
      disposed: false,
      conversationTransition: undefined as symbol | undefined,
      conversationGeneration: 0,
    };
    let count = 0;
    const current = captureConversationGuard(state);
    const recover = createRecoveryAction(
      () => current() && !state.running && !state.conversationTransition,
      async () => {
        count++;
      },
    );
    assert.isFalse(await recover());
    state.running = false;
    state.conversationTransition = Symbol();
    assert.isFalse(await recover());
    state.conversationTransition = undefined;
    state.disposed = true;
    assert.isFalse(await recover());
    state.disposed = false;
    state.conversationId = "another";
    assert.isFalse(await recover());
    state.conversationId = "original";
    invalidateConversation(state);
    assert.isFalse(await recover());
    assert.equal(count, 0);
  });
});

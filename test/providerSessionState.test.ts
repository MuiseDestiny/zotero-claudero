import { assert } from "chai";
import {
  applyProviderSessionEvent,
  mergeProviderSessionState,
  type ProviderSessionTarget,
} from "../src/modules/providerSessionState";
import type { ConversationProviderState } from "../src/modules/conversationStore";

describe("provider session state", function () {
  it("records Claude session ids without dropping existing Codex state", function () {
    const current: ConversationProviderState = {
      codex: {
        threadId: "thread-1",
        sessionFilePath: "/tmp/thread-1.json",
      },
    };

    const next = mergeProviderSessionState(current, {
      provider: "claude",
      sessionId: "claude-session-1",
    });

    assert.deepEqual(next, {
      claude: { sessionId: "claude-session-1" },
      codex: {
        threadId: "thread-1",
        sessionFilePath: "/tmp/thread-1.json",
      },
    });
  });

  it("records Codex threads and clears consumed fork sources", function () {
    const current: ConversationProviderState = {
      codex: {
        threadId: "parent-thread",
        sessionFilePath: "/tmp/parent.json",
        forkSource: {
          threadId: "parent-thread",
          resumeAt: "turn-2",
          sourceConversationId: "parent-conv",
        },
      },
    };

    const next = mergeProviderSessionState(current, {
      provider: "codex",
      threadId: "child-thread",
      sessionFilePath: "/tmp/child.json",
    });

    assert.deepEqual(next, {
      codex: {
        threadId: "child-thread",
        sessionFilePath: "/tmp/child.json",
      },
    });
  });

  it("applies current provider turn ids to pane-like state", function () {
    const target: ProviderSessionTarget = {};

    applyProviderSessionEvent(target, {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    assert.equal(target.providerState?.codex?.threadId, "thread-1");
    assert.equal(target.currentProviderTurnId, "turn-1");
  });
});

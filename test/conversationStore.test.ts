import { assert } from "chai";
import {
  deleteConversation,
  listConversations,
  saveConversationData,
  type ConversationProviderState,
  type ConversationTurn,
} from "../src/modules/conversationStore";

describe("conversation store provider metadata", function () {
  it("persists and preserves provider session metadata", async function () {
    const id = `provider-state-${Date.now()}`;
    const turns: ConversationTurn[] = [
      {
        role: "user",
        text: "Start a Codex task",
        ts: 100,
        provider: "codex",
      },
    ];
    const providerState: ConversationProviderState = {
      claude: { sessionId: "claude-session-1" },
      codex: {
        threadId: "codex-thread-1",
        sessionFilePath: "/tmp/codex-thread-1.json",
        forkSource: {
          threadId: "parent-thread",
          resumeAt: "turn-1",
          sourceConversationId: "parent-conv",
        },
      },
    };

    try {
      await deleteConversation(id);
      await saveConversationData(id, turns, {
        providerState,
        parentConversationId: "parent-conv",
        forkedAtTurnIndex: 0,
        compactedAt: 1234,
      });

      let saved = (await listConversations()).find((conv) => conv.id === id);
      assert.deepEqual(saved?.providerState, providerState);
      assert.equal(saved?.parentConversationId, "parent-conv");
      assert.equal(saved?.forkedAtTurnIndex, 0);
      assert.equal(saved?.compactedAt, 1234);

      await saveConversationData(id, [
        ...turns,
        {
          role: "assistant",
          text: "Done",
          ts: 200,
          provider: "codex",
        },
      ]);

      saved = (await listConversations()).find((conv) => conv.id === id);
      assert.deepEqual(saved?.providerState, providerState);
      assert.equal(saved?.parentConversationId, "parent-conv");
      assert.equal(saved?.forkedAtTurnIndex, 0);
      assert.equal(saved?.compactedAt, 1234);
    } finally {
      await deleteConversation(id);
    }
  });
});

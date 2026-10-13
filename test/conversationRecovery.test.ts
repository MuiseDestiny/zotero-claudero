import { assert } from "chai";
import {
  createRecoveryCandidate,
  planFreshReplay,
} from "../src/modules/conversationRecovery";
import type { ConversationTurn } from "../src/modules/conversationStore";
import { validateConversationData } from "../src/modules/conversationValidation";

function turn(
  index: number,
  text: string,
  role: "user" | "assistant" = "user",
): ConversationTurn {
  return { role, text, ts: index, provider: "codex", sessionId: "thread-1" };
}

describe("conversation recovery", function () {
  it("preserves validated failure details through a saved JSON round trip", function () {
    const saved = {
      turns: [
        {
          ...turn(1, "", "assistant"),
          blocks: [
            {
              type: "notice",
              kind: "warning",
              title: "Interrupted",
              text: "Retry",
              failureMessage: "fetch failed",
            },
          ],
        },
      ],
    };
    const restored = JSON.parse(JSON.stringify(saved));
    assert.isNull(validateConversationData(restored));
    assert.equal(restored.turns[0].blocks[0].failureMessage, "fetch failed");
    restored.turns[0].blocks[0].failureMessage = { message: "invalid" };
    assert.isString(validateConversationData(restored));
    delete restored.turns[0].blocks[0].failureMessage;
    assert.isNull(
      validateConversationData(restored),
      "Legacy notices remain valid",
    );
  });

  it("retains the newest turns when a fresh replay is limited", function () {
    const turns = [
      turn(0, "old-0"),
      turn(1, "old-1"),
      turn(2, "new-2"),
      turn(3, "new-3"),
    ];
    const full = planFreshReplay(turns).section;
    const maxChars =
      full.length -
      JSON.stringify({ index: 0, role: "user", text: "old-0" }).length -
      1;
    const replay = planFreshReplay(turns, true, maxChars);

    assert.equal(replay.manifest.mode, "fresh-limited");
    assert.isAtLeast(replay.manifest.includedTurns, 1);
    assert.include(replay.section, "new-3");
    assert.notInclude(replay.section, '"old-0"');
    const [start, end] = replay.manifest.includedRange;
    assert.equal(start, turns.length - replay.manifest.includedTurns);
    assert.equal(end, turns.length);
  });

  it("backfills legacy Codex turn session ids before native fork validation", function () {
    const turns: ConversationTurn[] = [
      { role: "user", text: "hello", ts: 1, provider: "codex" },
      {
        role: "assistant",
        text: "world",
        ts: 2,
        provider: "codex",
        assistantMessageId: "turn-2",
      },
    ];
    const candidate = createRecoveryCandidate(
      {
        conversationId: "parent",
        conversationTurns: turns,
        providerState: { codex: { threadId: "thread-1" } },
      },
      2,
      "codex",
      "child",
    );
    assert.deepEqual(
      candidate.turns.map((item) => item.sessionId),
      ["thread-1", "thread-1"],
    );
    assert.equal(candidate.recoveryManifest?.mode, "native");
  });
});

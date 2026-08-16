import { assert } from "chai";
import {
  buildConversationHistorySection,
  buildPromptWithConversationHistory,
  shouldReplayConversationHistory,
} from "../src/shared/promptHistory";
import type { ConversationTurn } from "../src/modules/conversationStore";

function turn(
  role: ConversationTurn["role"],
  text: string,
  index = 0,
): ConversationTurn {
  return { role, text, ts: index };
}

describe("prompt history replay", function () {
  it("leaves the first request unwrapped when there is no history", function () {
    const prompt = "我的名字是 Alice";
    assert.equal(buildPromptWithConversationHistory(prompt, []), prompt);
    assert.notInclude(prompt, "<conversation_history>");
  });

  it("replays prior user and assistant turns before the current request", function () {
    const prompt = buildPromptWithConversationHistory("我叫什么", [
      turn("user", "我的名字是 Alice"),
      turn("assistant", "好的，我记住了你的名字是 Alice。"),
    ]);

    assert.include(prompt, '<turn role="User">\n我的名字是 Alice\n</turn>');
    assert.include(
      prompt,
      '<turn role="Assistant">\n好的，我记住了你的名字是 Alice。\n</turn>',
    );
    assert.include(
      prompt,
      "<current_user_request>\n我叫什么\n</current_user_request>",
    );
    assert.isBelow(
      prompt.indexOf("<conversation_history>"),
      prompt.indexOf("<current_user_request>"),
    );
  });

  it("drops blank text and retains only the latest sixteen non-empty turns", function () {
    const turns: ConversationTurn[] = [
      turn("user", "   ", 0),
      ...Array.from({ length: 17 }, (_, index) =>
        turn("user", `turn-${index}`, index + 1),
      ),
    ];
    const history = buildConversationHistorySection(turns);

    assert.notInclude(history, "turn-0");
    assert.include(history, "turn-1");
    assert.include(history, "turn-16");
    assert.equal((history.match(/<turn role=/g) || []).length, 16);
  });

  it("always replays DeepSeek history even when a session id is recorded", function () {
    assert.isTrue(
      shouldReplayConversationHistory("deepseek", {
        deepseek: { sessionId: "dsh-session-1" },
      }),
    );
  });
});

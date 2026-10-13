import { assert } from "chai";
import { ConversationCompletion } from "../src/modules/conversationCompletion";
import { invalidateConversation } from "../src/modules/conversationTransition";
import {
  deleteConversation,
  loadConversationById,
  saveConversationData,
  type ConversationTurn,
} from "../src/modules/conversationStore";

describe("conversation close and reopen", function () {
  it("commits a partial turn before reopening and cannot overwrite a subsequent turn during late cleanup", async function () {
    const id = `close-reopen-${Date.now()}`;
    const state = {
      conversationId: id,
      disposed: false,
      finalizeRequest: undefined as (() => void) | undefined,
    };
    const turns: ConversationTurn[] = [
      { role: "user", text: "question", ts: Date.now() },
    ];
    let save: Promise<unknown> | undefined;
    const completion = new ConversationCompletion(state, () => {
      turns.push({
        role: "assistant",
        text: "partial response",
        ts: Date.now(),
      });
      save = saveConversationData(id, turns);
    });
    try {
      state.finalizeRequest!();
      state.disposed = true;
      const reopened = await loadConversationById(id);
      assert.equal(reopened?.turns.at(-1)?.text, "partial response");
      await saveConversationData(id, [
        ...reopened!.turns,
        { role: "user", text: "new request", ts: Date.now() },
      ]);
      completion.finish();
      completion.release();
      assert.equal(
        (await loadConversationById(id))?.turns.at(-1)?.text,
        "new request",
      );
      assert.isUndefined(state.finalizeRequest);
    } finally {
      await save;
      await deleteConversation(id);
    }
  });

  it("does not duplicate completed turns or commit to a different conversation generation", function () {
    const state = {
      conversationId: "fixture",
      finalizeRequest: undefined as (() => void) | undefined,
    };
    let commits = 0;
    const completed = new ConversationCompletion(state, () => {
      commits++;
    });
    completed.markRecorded();
    completed.finish();
    const stale = new ConversationCompletion(state, () => {
      commits++;
    });
    completed.release();
    assert.strictEqual(state.finalizeRequest, stale.finish);
    invalidateConversation(state);
    stale.finish();
    stale.release();
    assert.equal(commits, 0);
  });
});

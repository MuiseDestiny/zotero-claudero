import { assert } from "chai";
import { createPaneStreamingView } from "../src/modules/paneStreamingView";
import type { PaneState } from "../src/modules/paneState";

describe("extracted streaming view state", function () {
  const view = createPaneStreamingView({
    appendMessageCard: () => {
      throw new Error("Unexpected DOM creation");
    },
    getSelectedEffort: () => "medium",
  });
  function state(): PaneState {
    return {
      currentAssistantBlocks: [],
      currentSegmentText: "",
      lastAssistantText: "",
      turnResponseChars: 0,
      turnOutputTokens: 0,
      thinkingTokenEstimate: 12,
      thinkingMetaEl: null,
      thinkingWordEl: null,
      thinkingEl: { remove() {} },
      thinkingTimer: null,
      activityMode: "responding",
      activityMessage: "",
      transcript: {
        appendChild() {},
        scrollHeight: 100,
        scrollTop: 100,
        clientHeight: 100,
      },
      scrollToBottomBtn: null,
    } as unknown as PaneState;
  }

  it("keeps streamed text, segmented blocks and response counts in sync", function () {
    const current = state();
    assert.isFalse(view.mergeAssistantText(current, ""));
    assert.isTrue(view.mergeAssistantText(current, "Hello "));
    assert.isTrue(view.mergeAssistantText(current, "world"));
    view.commitCurrentAssistantTextBlock(current);
    assert.equal(current.lastAssistantText, "Hello world");
    assert.equal(current.currentSegmentText, "Hello world");
    assert.equal(current.turnResponseChars, 11);
    assert.deepEqual(current.currentAssistantBlocks, [
      { type: "text", text: "Hello world" },
    ]);
    current.currentSegmentText = "";
    view.commitCurrentAssistantTextBlock(current);
    assert.lengthOf(current.currentAssistantBlocks, 1);
  });

  it("coalesces adjacent thinking but preserves intervening response blocks", function () {
    const current = state();
    view.appendAssistantThinkingBlock(current, "first");
    view.appendAssistantThinkingBlock(current, " thought");
    view.finalizeAssistantThinkingBlock(current, 500);
    view.pushAssistantBlock(current, { type: "text", text: "response" });
    view.appendAssistantThinkingBlock(current, "next");
    view.finalizeAssistantThinkingBlock(current, 200);
    assert.deepEqual(current.currentAssistantBlocks, [
      { type: "thinking", text: "first thought", durationMs: 500 },
      { type: "text", text: "response" },
      { type: "thinking", text: "next", durationMs: 200 },
    ]);
  });

  it("replaces usage totals with final snapshots instead of double counting", function () {
    const current = state();
    view.updateTurnUsage(current, { outputTokens: 3, final: false });
    view.updateTurnUsage(current, { outputTokens: 4, final: false });
    assert.equal(current.turnOutputTokens, 7);
    view.updateTurnUsage(current, { outputTokens: 5, final: true });
    assert.equal(current.turnOutputTokens, 5);
    assert.equal(current.thinkingTokenEstimate, 0);
  });

  it("clears the owned timer and indicator exactly once", function () {
    const current = state();
    const cleared: number[] = [];
    let removed = 0;
    current.root = {
      ownerDocument: {
        defaultView: { clearInterval: (id: number) => cleared.push(id) },
      },
    } as unknown as HTMLElement;
    current.thinkingTimer = 42;
    current.thinkingEl = {
      remove: () => {
        removed++;
      },
    } as unknown as HTMLElement;
    view.stopThinkingAnimation(current);
    view.stopThinkingAnimation(current);
    assert.deepEqual(cleared, [42]);
    assert.equal(removed, 1);
    assert.isNull(current.thinkingEl);
    assert.isNull(current.thinkingTimer);
    assert.isNull(current.thinkingWordEl);
    assert.isNull(current.thinkingMetaEl);
  });
});

import { assert } from "chai";
import { createPaneStreamingView } from "../src/modules/paneStreamingView";
import { appendRequestFailure } from "../src/modules/paneServiceNotices";
import type { PaneState } from "../src/modules/paneState";
import { installUiTestContext } from "./uiTestContext";

describe("pane streaming and recovery views", function () {
  let state: PaneState;
  let restore: () => void;
  const el = (tag: string) =>
    document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElement;
  const view = createPaneStreamingView({
    appendMessageCard(current) {
      const card = el("div");
      card.className = "claudero-message";
      const body = el("div");
      card.appendChild(body);
      current.transcript.appendChild(card);
      return body;
    },
    getSelectedEffort: () => "medium",
  });

  beforeEach(function () {
    restore = installUiTestContext();
    const root = el("div");
    const transcript = el("div");
    root.appendChild(transcript);
    document.body.appendChild(root);
    state = {
      root,
      transcript,
      statusDot: el("span"),
      providerSelect: { value: "codex" },
      conversationId: "one",
      running: false,
      currentAssistantBlocks: [],
      currentAssistantBody: null,
      currentAssistantCard: null,
      currentSegmentText: "",
      lastAssistantText: "",
      lastStreamingRenderTs: 0,
      turnResponseChars: 0,
      turnOutputTokens: 0,
      thinkingTokenEstimate: 0,
      thinkingTimer: null,
      thinkingEl: null,
      thinkingMetaEl: null,
      thinkingWordEl: null,
      turnStartedTs: Date.now(),
      thinkingTs: 0,
      activityMode: "responding",
      activityMessage: "",
      activityStartedTs: Date.now(),
      recentThoughtDurationMs: 0,
      recentThoughtUntil: 0,
    } as unknown as PaneState;
  });

  afterEach(function () {
    view.stopThinkingAnimation(state);
    state.root.remove();
    restore();
  });

  it("flushes throttled final text and replaces partial snapshots without duplication", function () {
    view.ensureStreamingAssistantBody(state);
    view.mergeAssistantText(state, "Earlier. ");
    view.updateStreamingBody(state, true);
    view.commitCurrentAssistantTextBlock(state);
    state.currentSegmentText = "";
    view.mergeAssistantText(state, "Partial");
    view.reconcileAssistantTextSnapshot(state, "Final");
    assert.equal(state.lastAssistantText, "Earlier. Final");
    assert.equal(state.turnResponseChars, "Earlier. Final".length);
    state.lastStreamingRenderTs = Date.now() + 1000;
    view.mergeAssistantText(state, " answer");
    view.updateStreamingBody(state);
    assert.notInclude(state.currentAssistantBody!.textContent, "answer");
    view.finalizeAssistantBody(state);
    assert.include(state.currentAssistantBody!.textContent, "Final answer");
  });

  it("keeps retry available after cancellation but ignores stale conversation buttons", async function () {
    let attempts = 0;
    appendRequestFailure(state, "fetch failed", "codex", async () => {
      attempts++;
      return false;
    });
    const button = state.transcript.querySelector<HTMLButtonElement>("button")!;
    assert.equal(button.type, "button");
    state.running = true;
    button.click();
    assert.equal(attempts, 0);
    state.running = false;
    button.click();
    await Zotero.Promise.delay(0);
    assert.equal(attempts, 1);
    assert.isFalse(button.disabled);
    button.click();
    await Zotero.Promise.delay(0);
    assert.equal(attempts, 2);
    state.conversationId = "two";
    button.click();
    assert.equal(attempts, 2);
  });

  it("consumes a successful retry button only once", async function () {
    let attempts = 0;
    appendRequestFailure(state, "Codex thread not found", "codex", async () => {
      attempts++;
      return true;
    });
    const button = state.transcript.querySelector<HTMLButtonElement>("button")!;
    button.click();
    await Zotero.Promise.delay(0);
    assert.isTrue(button.disabled);
    button.click();
    assert.equal(attempts, 1);
  });
});

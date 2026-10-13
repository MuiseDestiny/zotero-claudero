import type { PaneState } from "../src/modules/paneState";

export function paneTestElement<K extends keyof HTMLElementTagNameMap>(tag: K) {
  return document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
}

/** Only DOM and local state: no Helper, CLI, preferences or saved history. */
export function createPaneTestState(): PaneState {
  const root = paneTestElement("div");
  const transcript = paneTestElement("div");
  const composer = paneTestElement("div");
  composer.className = "claudero-composer";
  const input = paneTestElement("textarea");
  composer.append(input);
  root.append(transcript, composer);
  document.body.append(root);
  return {
    root,
    transcript,
    input,
    statusDot: paneTestElement("span"),
    providerSelect: { value: "codex" },
    modelSelect: { value: "" },
    effortSelect: { value: "" },
    conversationId: "pane-test-original",
    conversationTurns: [
      { role: "user", text: "Question", ts: 100 },
      { role: "assistant", text: "Answer", ts: 200 },
    ],
    toolCards: new Map(),
    pendingImages: [],
    pendingImagesBar: null,
    currentAssistantBlocks: [],
    currentAssistantBody: null,
    currentAssistantCard: null,
    thinkingCard: null,
    scrollToBottomBtn: null,
    lastAssistantText: "",
    currentSegmentText: "",
    lastStreamingRenderTs: 0,
    running: false,
  } as unknown as PaneState;
}

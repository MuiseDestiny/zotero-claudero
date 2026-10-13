import type {
  PaneState,
  ActivityMode,
  MessageRenderOptions,
} from "./paneState";
import type { ConversationBlock, MessageRole } from "./conversationStore";
import { createEl, scrollTranscript, formatDuration } from "./paneDom";
import { getString } from "../utils/locale";
import { getToolActivityDescription } from "./toolCallRenderer";
import { renderMarkdown } from "./messageRenderer";
import { thinkingPresentation } from "../shared/thinkingPresentation";
interface StreamingViewHost {
  appendMessageCard: (
    state: PaneState,
    role: MessageRole,
    text: string,
    options?: MessageRenderOptions,
  ) => HTMLElement;
  getSelectedEffort: (state: PaneState) => string;
}
const STREAMING_RENDER_INTERVAL = 150;
// Rendering owns its timers and snapshots; request orchestration stays in the controller.
export function createPaneStreamingView({
  appendMessageCard,
  getSelectedEffort,
}: StreamingViewHost) {
  function pushAssistantBlock(
    state: PaneState,
    block: ConversationBlock,
  ): void {
    state.currentAssistantBlocks.push(block);
  }

  function commitCurrentAssistantTextBlock(state: PaneState): void {
    if (!state.currentSegmentText) return;
    pushAssistantBlock(state, {
      type: "text",
      text: state.currentSegmentText,
    });
  }

  function appendAssistantThinkingBlock(state: PaneState, text: string): void {
    const last =
      state.currentAssistantBlocks[state.currentAssistantBlocks.length - 1];
    if (last?.type === "thinking") {
      last.text += text;
      return;
    }
    pushAssistantBlock(state, { type: "thinking", text, durationMs: 0 });
  }

  function finalizeAssistantThinkingBlock(
    state: PaneState,
    durationMs: number,
  ): void {
    for (let i = state.currentAssistantBlocks.length - 1; i >= 0; i--) {
      const block = state.currentAssistantBlocks[i];
      if (block?.type === "thinking" && !block.durationMs) {
        block.durationMs = durationMs;
        return;
      }
    }
  }

  function pickThinkingVerb(): string {
    return getString("activity-thinking");
  }

  function formatActivityTokens(tokens: number): string {
    if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
    const value = tokens / 1000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}k`;
  }

  function compactActivityLabel(text: string, max = 46): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  }

  function activityMessageForState(state: PaneState): string {
    if (state.activityMessage)
      return compactActivityLabel(state.activityMessage);
    if (state.activityMode === "thinking")
      return getString("activity-thinking");
    if (state.activityMode === "compacting")
      return getString("activity-compacting");
    if (state.activityMode === "tool") return getString("activity-working");
    if (state.activityMode === "waiting") return getString("activity-waiting");
    if (state.activityMode === "requesting")
      return getString("activity-sending");
    if (!state.thinkingVerb) state.thinkingVerb = pickThinkingVerb();
    return state.thinkingVerb;
  }

  function setActivity(
    state: PaneState,
    mode: ActivityMode,
    message?: string,
  ): void {
    const nextMessage = compactActivityLabel(message || "");
    if (state.activityMode !== mode || state.activityMessage !== nextMessage) {
      state.activityMode = mode;
      state.activityMessage = nextMessage;
      state.activityStartedTs = Date.now();
    }
    if (mode === "thinking" && !state.thinkingTs) state.thinkingTs = Date.now();
    if (state.thinkingWordEl) {
      state.thinkingWordEl.textContent = activityMessageForState(state);
    }
    updateThinkingAnimation(state);
  }

  function updateThinkingAnimation(state: PaneState): void {
    if (!state.thinkingMetaEl) return;
    if (state.thinkingWordEl) {
      state.thinkingWordEl.textContent = activityMessageForState(state);
    }
    const elapsed = Math.max(
      0,
      Math.floor((Date.now() - state.turnStartedTs) / 1000),
    );
    // Claude Code drives its live counter from responseLength / 4, then lets
    // authoritative SDK usage catch up when a complete message arrives.
    const approximateTokens = Math.round(state.turnResponseChars / 4);
    const tokens = Math.max(
      approximateTokens,
      state.turnOutputTokens + state.thinkingTokenEstimate,
    );
    const parts = [formatDuration(elapsed)];
    if (tokens > 0) {
      parts.push(
        getString("activity-tokens", {
          args: { tokens: formatActivityTokens(tokens) },
        }),
      );
    }
    if (state.activityMode === "thinking") {
      parts.push(
        getString("activity-thinking-effort", {
          args: { effort: getSelectedEffort(state) },
        }),
      );
    } else if (state.activityMode === "compacting") {
      parts.push(getString("activity-context"));
    } else if (state.activityMode === "tool") {
      parts.push(getString("activity-tool"));
    } else if (state.activityMode === "waiting") {
      parts.push(getString("activity-input"));
    } else if (
      state.recentThoughtDurationMs > 0 &&
      Date.now() < state.recentThoughtUntil
    ) {
      parts.push(
        getString("activity-thought-for", {
          args: {
            seconds: Math.max(
              1,
              Math.round(state.recentThoughtDurationMs / 1000),
            ),
          },
        }),
      );
    }
    state.thinkingMetaEl.textContent = `(${parts.join(" · ")})`;
  }

  function startThinkingAnimation(state: PaneState): void {
    if (state.thinkingEl) {
      state.transcript.appendChild(state.thinkingEl);
      updateThinkingAnimation(state);
      scrollTranscript(state);
      return;
    }
    const doc = state.root.ownerDocument!;
    const win = doc.defaultView as Window;
    const indicator = createEl(doc, "div", "claudero-thinking-indicator");
    indicator.setAttribute("title", getString("composer-interrupt"));
    const word = createEl(doc, "span", "claudero-thinking-word");
    const meta = createEl(doc, "span", "claudero-thinking-time");
    word.textContent = activityMessageForState(state);
    indicator.append(word, doc.createTextNode("… "), meta);
    state.transcript.appendChild(indicator);
    state.thinkingEl = indicator;
    state.thinkingWordEl = word;
    state.thinkingMetaEl = meta;
    updateThinkingAnimation(state);
    state.thinkingTimer = win.setInterval(() => {
      updateThinkingAnimation(state);
    }, 1000);
    scrollTranscript(state);
  }

  function stopThinkingAnimation(state: PaneState): void {
    if (state.thinkingTimer !== null) {
      (state.root.ownerDocument!.defaultView as Window).clearInterval(
        state.thinkingTimer,
      );
      state.thinkingTimer = null;
    }
    state.thinkingEl?.remove();
    state.thinkingEl = null;
    state.thinkingWordEl = null;
    state.thinkingMetaEl = null;
  }

  function updateTurnUsage(
    state: PaneState,
    usage: { outputTokens: number; final: boolean },
  ): void {
    state.turnOutputTokens = usage.final
      ? usage.outputTokens
      : state.turnOutputTokens + usage.outputTokens;
    state.thinkingTokenEstimate = 0;
    updateThinkingAnimation(state);
  }

  function updateToolProgress(
    state: PaneState,
    toolUseId: string,
    elapsedSeconds: number,
  ): void {
    const card = state.toolCards.get(toolUseId);
    if (!card) return;
    const label = getString("tool-running", {
      args: {
        duration: formatDuration(Math.max(0, Math.floor(elapsedSeconds))),
      },
    });
    card.status.setAttribute("title", label);
    card.status.setAttribute("aria-label", label);
  }

  function updateActivityForTool(
    state: PaneState,
    tool: { name: string; input?: unknown; partialInput?: string },
  ): void {
    const input =
      tool.input &&
      typeof tool.input === "object" &&
      Object.keys(tool.input as object).length > 0
        ? tool.input
        : (tool.partialInput ?? tool.input);
    const description = getToolActivityDescription(tool.name, input);
    if (["AskUserQuestion", "ExitPlanMode", "Sleep"].includes(tool.name)) {
      setActivity(state, "waiting", description);
    } else {
      setActivity(state, "tool", description);
    }
  }

  function createThinkingChevron(doc: Document): HTMLElement {
    const span = createEl(doc, "span", "claudero-thinking-chevron");
    return span;
  }

  function updateThinkingCardPresentation(
    card: NonNullable<PaneState["thinkingCard"]>,
    fallbackLabel: string,
  ): void {
    const presentation = thinkingPresentation(card.text);
    card.labelSpan.textContent = presentation.title || fallbackLabel;
    card.body.textContent = presentation.body;
    card.el.classList.toggle("summary-only", !presentation.body);
  }

  function appendThinkingDelta(state: PaneState, text: string): void {
    if (!text) return;
    setActivity(state, "thinking", getString("activity-thinking"));
    state.turnResponseChars += text.length;
    startThinkingAnimation(state);
    let card = state.thinkingCard;
    if (!card) {
      const doc = state.root.ownerDocument!;
      const el = createEl(doc, "div", "claudero-thinking-card");
      const header = createEl(doc, "button", "claudero-thinking-header");
      header.setAttribute("tabindex", "-1");
      const labelSpan = createEl(doc, "span", "claudero-thinking-label");
      labelSpan.textContent = getString("composer-thinking");
      const durationSpan = createEl(doc, "span", "claudero-thinking-duration");
      durationSpan.textContent = "(0s)";
      const chevron = createThinkingChevron(doc);
      header.append(labelSpan, durationSpan, chevron);
      const body = createEl(doc, "div", "claudero-thinking-body");
      header.addEventListener("click", () => {
        if (!el.classList.contains("summary-only")) {
          el.classList.toggle("collapsed");
        }
      });
      el.append(header, body);
      // Insert before the current (still-empty) assistant bubble so the reasoning
      // renders ABOVE the answer, matching Claudian's layout.
      const currentStack =
        state.currentAssistantCard?.parentElement?.classList.contains(
          "claudero-message-stack",
        )
          ? state.currentAssistantCard.parentElement
          : state.currentAssistantCard;
      if (currentStack && currentStack.parentElement === state.transcript) {
        state.transcript.insertBefore(el, currentStack);
      } else {
        state.transcript.appendChild(el);
      }
      const startTs = Date.now();
      const win = doc.defaultView as Window;
      const timer = win.setInterval(() => {
        const elapsed = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
        durationSpan.textContent = `(${formatDuration(elapsed)})`;
      }, 1000);
      card = {
        el,
        header,
        labelSpan,
        durationSpan,
        body,
        startTs,
        text: "",
        timer,
      };
      state.thinkingCard = card;
    }
    card.text += text;
    updateThinkingCardPresentation(card, getString("composer-thinking"));
    scrollTranscript(state);
  }

  function reconcileThinkingSnapshot(state: PaneState, text: string): void {
    if (!text) return;
    if (!state.thinkingCard) {
      appendThinkingDelta(state, text);
      return;
    }
    state.turnResponseChars = Math.max(
      0,
      state.turnResponseChars - state.thinkingCard.text.length + text.length,
    );
    setActivity(state, "thinking", getString("activity-thinking"));
    startThinkingAnimation(state);
    state.thinkingCard.text = text;
    updateThinkingCardPresentation(
      state.thinkingCard,
      getString("composer-thinking"),
    );
    const last = state.currentAssistantBlocks.at(-1);
    if (last?.type === "thinking") last.text = text;
    else pushAssistantBlock(state, { type: "thinking", text, durationMs: 0 });
    scrollTranscript(state);
  }

  function finalizeThinkingCard(state: PaneState): void {
    const card = state.thinkingCard;
    if (!card) return;
    const sec = Math.max(0, Math.round((Date.now() - card.startTs) / 1000));
    setActivity(state, "responding");
    state.recentThoughtDurationMs = Date.now() - card.startTs;
    state.recentThoughtUntil = Date.now() + 2000;
    updateThinkingAnimation(state);
    (state.root.ownerDocument!.defaultView as Window).clearInterval(card.timer);
    updateThinkingCardPresentation(
      card,
      getString("activity-thought-for", { args: { seconds: sec } }),
    );
    card.durationSpan.textContent = thinkingPresentation(card.text).title
      ? `(${sec}s)`
      : "";
    // Auto-collapse once formal content follows
    card.el.classList.add("done", "collapsed");
    state.thinkingCard = null;
  }

  function updateStreamingBody(state: PaneState, force = false): void {
    if (!state.currentAssistantBody) return;
    const now = Date.now();
    if (
      force ||
      now - state.lastStreamingRenderTs >= STREAMING_RENDER_INTERVAL
    ) {
      state.lastStreamingRenderTs = now;
      renderMarkdown(
        state.root.ownerDocument!,
        state.currentAssistantBody,
        state.currentSegmentText,
      );
    }
    scrollTranscript(state);
  }

  function finalizeAssistantBody(state: PaneState): void {
    if (!state.currentAssistantBody) return;
    if (state.currentSegmentText) {
      renderMarkdown(
        state.root.ownerDocument!,
        state.currentAssistantBody,
        state.currentSegmentText,
      );
    } else {
      state.currentAssistantBody.textContent = "";
    }
  }

  function removeMessageCardStack(card: HTMLElement): void {
    const stack = card.parentElement;
    if (stack?.classList.contains("claudero-message-stack")) {
      stack.remove();
      return;
    }
    card.remove();
  }

  function isEmptyAssistantMessageCard(card: HTMLElement | null): boolean {
    if (
      !card?.classList.contains("claudero-message") ||
      !card.classList.contains("assistant")
    )
      return false;
    if (card.querySelector(":scope > .claudero-thinking-indicator"))
      return false;
    const body = card.querySelector(
      ":scope > .claudero-message-body",
    ) as HTMLElement | null;
    if (!body) return false;
    const hasText = !!body.textContent?.trim();
    const hasMedia = !!body.querySelector(
      "img, svg, canvas, table, pre, code, math, .katex, .katex-display",
    );
    const hasOtherContent = Array.from(card.children).some(
      (child) => child !== body,
    );
    return !hasText && !hasMedia && !hasOtherContent;
  }

  function removeEmptyCurrentAssistantMessage(state: PaneState): void {
    if (!isEmptyAssistantMessageCard(state.currentAssistantCard)) return;
    removeMessageCardStack(state.currentAssistantCard!);
    state.currentAssistantBody = null;
    state.currentAssistantCard = null;
    state.currentSegmentText = "";
    state.lastStreamingRenderTs = 0;
  }

  function syncSpinnerForStreamingText(state: PaneState): void {
    startThinkingAnimation(state);
  }

  function syncSpinnerForTool(state: PaneState, toolName: string): void {
    if (["AskUserQuestion", "ExitPlanMode", "Sleep"].includes(toolName)) {
      stopThinkingAnimation(state);
    } else {
      startThinkingAnimation(state);
    }
  }

  function mergeAssistantText(state: PaneState, text: string): boolean {
    if (!text) return false;
    setActivity(state, "responding");
    state.lastAssistantText += text;
    state.currentSegmentText += text;
    state.turnResponseChars += text.length;
    syncSpinnerForStreamingText(state);
    updateThinkingAnimation(state);
    return true;
  }

  function ensureStreamingAssistantBody(state: PaneState): void {
    if (state.currentAssistantBody?.isConnected) return;
    state.currentAssistantBody = appendMessageCard(state, "assistant", "", {
      ts: Date.now(),
    });
    state.currentAssistantCard = state.currentAssistantBody.closest(
      ".claudero-message",
    ) as HTMLElement | null;
    state.lastStreamingRenderTs = 0;
  }

  function reconcileAssistantTextSnapshot(
    state: PaneState,
    text: string,
  ): void {
    ensureStreamingAssistantBody(state);
    setActivity(state, "responding");
    const prefixLength = Math.max(
      0,
      state.lastAssistantText.length - state.currentSegmentText.length,
    );
    state.turnResponseChars = Math.max(
      0,
      state.turnResponseChars - state.currentSegmentText.length + text.length,
    );
    state.lastAssistantText = `${state.lastAssistantText.slice(0, prefixLength)}${text}`;
    state.currentSegmentText = text;
    syncSpinnerForStreamingText(state);
    updateThinkingAnimation(state);
    updateStreamingBody(state, true);
  }

  async function animateAssistantText(
    state: PaneState,
    text: string,
  ): Promise<void> {
    const units = Array.from(text);
    if (units.length === 0) return;

    // Upstream partial events are not authoritative for compatible providers.
    // Animate the complete block locally so the UI remains progressive without
    // exposing corrupted previews. Limit renders for long Markdown and tables.
    const chunkSize = Math.max(1, Math.ceil(units.length / 120));
    const delayMs = units.length <= 24 ? 28 : 16;
    const win = state.root.ownerDocument!.defaultView as Window;

    for (let index = 0; index < units.length; index += chunkSize) {
      if (state.cancelRequested) return;
      ensureStreamingAssistantBody(state);
      mergeAssistantText(state, units.slice(index, index + chunkSize).join(""));
      updateStreamingBody(state, true);
      if (index + chunkSize < units.length) {
        await new Promise<void>((resolve) => win.setTimeout(resolve, delayMs));
      }
    }
  }
  return {
    pushAssistantBlock,
    commitCurrentAssistantTextBlock,
    appendAssistantThinkingBlock,
    finalizeAssistantThinkingBlock,
    setActivity,
    updateThinkingAnimation,
    startThinkingAnimation,
    stopThinkingAnimation,
    updateTurnUsage,
    updateToolProgress,
    updateActivityForTool,
    createThinkingChevron,
    appendThinkingDelta,
    reconcileThinkingSnapshot,
    finalizeThinkingCard,
    updateStreamingBody,
    finalizeAssistantBody,
    removeEmptyCurrentAssistantMessage,
    syncSpinnerForTool,
    mergeAssistantText,
    ensureStreamingAssistantBody,
    reconcileAssistantTextSnapshot,
    animateAssistantText,
  };
}

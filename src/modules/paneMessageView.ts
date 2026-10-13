import {
  evidenceReferencesFromToolResultContent,
  restoreEvidenceReferences,
} from "../shared/evidenceLinkCodec";
import { thinkingPresentation } from "../shared/thinkingPresentation";
import { getString } from "../utils/locale";
import {
  type ConversationBlock,
  type ConversationTurn,
  type MessageRole,
} from "./conversationStore";
import { renderMarkdown } from "./messageRenderer";
import { buildMessageContextSummaryChip } from "./paneContextView";
import {
  CHECK_ICON_SVG,
  createEl,
  createToolbarLikeButton,
  forceScrollToBottom,
  scrollTranscript,
} from "./paneDom";
import { attachImagePreview, cloneImages, imageDataUrl } from "./paneImageView";
import { appendNoticeCard, appendRequestFailure } from "./paneServiceNotices";
import {
  type MessageRenderOptions,
  type NoticeKind,
  type PaneState,
  type PendingImage,
} from "./paneState";
import { getProviderCapabilities, normalizeProvider } from "./providerRegistry";
import { appendToolCard, appendToolResult } from "./toolCallRenderer";

// Message rendering; retry, edit and fork are injected commands, never controller imports.
interface PaneMessageViewHost {
  retryAssistantTurn: (
    state: PaneState,
    turnIndex?: number,
  ) => Promise<boolean>;
  forkConversationAtTurn: (
    state: PaneState,
    turnIndex?: number,
  ) => Promise<void>;
  editLastUserTurn: (state: PaneState, turnIndex?: number) => Promise<void>;
  createThinkingChevron: (doc: Document) => HTMLElement;
}

export function createPaneMessageView({
  retryAssistantTurn,
  forkConversationAtTurn,
  editLastUserTurn,
  createThinkingChevron,
}: PaneMessageViewHost) {
  // SVG icon constants - defined as template strings to avoid XML errors
  const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
  <path d="M12.668 10.667c0-.71 0-1.204-.031-1.588a2.4 2.4 0 0 0-.113-.615l-.055-.13a1.84 1.84 0 0 0-.676-.731l-.127-.072c-.158-.08-.37-.137-.745-.168-.384-.031-.877-.031-1.588-.031H6.5c-.711 0-1.204 0-1.588.031a2.4 2.4 0 0 0-.615.113l-.13.055a1.84 1.84 0 0 0-.731.676l-.07.127c-.081.158-.138.37-.169.745-.031.384-.032.877-.032 1.588V13.5c0 .711 0 1.204.032 1.588.031.376.088.587.168.745l.07.126c.177.288.43.522.732.676l.13.056c.144.052.333.089.615.112.384.031.877.032 1.588.032h2.833c.71 0 1.204 0 1.588-.032.376-.031.587-.088.745-.168l.127-.07c.287-.177.522-.43.676-.732l.055-.13c.052-.144.09-.333.113-.615.031-.384.031-.877.031-1.588zm1.33 1.998c.455-.002.803-.005 1.09-.028.376-.031.587-.088.745-.168l.126-.071c.288-.177.522-.43.676-.732l.056-.13a2.4 2.4 0 0 0 .112-.615c.031-.384.032-.877.032-1.588V6.5c0-.711 0-1.204-.032-1.588a2.4 2.4 0 0 0-.112-.615l-.056-.13a1.84 1.84 0 0 0-.676-.731l-.126-.07c-.158-.081-.37-.138-.745-.169-.384-.031-.877-.032-1.588-.032h-2.833c-.71 0-1.204.001-1.588.032-.282.023-.471.06-.615.112l-.13.056a1.84 1.84 0 0 0-.731.676l-.072.126c-.08.158-.137.37-.168.745-.023.287-.027.635-.029 1.09h1.999c.689 0 1.246 0 1.696.036.458.038.865.117 1.242.309l.217.122c.496.304.9.74 1.165 1.26l.067.143c.144.337.21.698.242 1.099.037.45.036 1.007.036 1.696zm4.167-3.332c0 .689 0 1.246-.036 1.696-.033.401-.098.762-.242 1.099l-.067.143c-.265.52-.67.956-1.165 1.26l-.219.122c-.376.192-.782.271-1.24.309-.337.027-.734.031-1.2.033-.003.467-.007.864-.034 1.201-.033.401-.098.762-.242 1.098l-.067.142c-.265.522-.669.958-1.165 1.262l-.217.122c-.377.192-.784.271-1.242.309-.45.037-1.007.036-1.696.036H6.5c-.69 0-1.246 0-1.696-.036-.4-.033-.762-.098-1.098-.242l-.143-.067a3.17 3.17 0 0 1-1.261-1.165l-.122-.219c-.192-.376-.271-.782-.309-1.24-.037-.45-.036-1.007-.036-1.696v-2.833c0-.689 0-1.246.036-1.696.038-.458.117-.865.309-1.242l.122-.217c.304-.496.74-.9 1.261-1.165l.143-.067c.336-.144.697-.21 1.098-.242.337-.027.733-.032 1.2-.034.002-.467.007-.863.034-1.2.037-.458.117-.864.309-1.24l.122-.22c.304-.495.74-.899 1.26-1.164l.143-.067c.337-.144.698-.21 1.099-.242.45-.037 1.007-.036 1.696-.036H13.5c.69 0 1.246 0 1.696.036.458.038.864.117 1.24.309l.22.122c.495.304.899.74 1.164 1.261l.067.143c.144.336.21.697.242 1.098.037.45.036 1.007.036 1.696z"/>
</svg>`;

  const RETRY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
  <path d="M3.502 16.666v-3.333c0-.367.298-.665.665-.665H7.5l.134.014a.665.665 0 0 1 0 1.303l-.134.013H5.475A6.12 6.12 0 0 0 10 16.001c3.06 0 5.586-2.29 5.955-5.25l.03-.131a.665.665 0 0 1 1.29.295l-.05.337A7.33 7.33 0 0 1 10 17.332a7.46 7.46 0 0 1-5.168-2.085v1.42a.665.665 0 0 1-1.33 0m.543-7.417a.665.665 0 0 1-1.32-.165zM10 2.67c1.994 0 3.837.797 5.178 2.093V3.333a.665.665 0 0 1 1.33 0v3.333a.665.665 0 0 1-.665.665H12.51a.665.665 0 0 1 0-1.33h2.015A6.12 6.12 0 0 0 10 3.998 6.003 6.003 0 0 0 4.045 9.25l-.66-.083-.66-.082A7.333 7.333 0 0 1 10 2.668"/>
</svg>`;

  const EDIT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
 <path d="M11.331 3.568a3.61 3.61 0 0 1 4.973.128l.128.135a3.61 3.61 0 0 1 0 4.838l-.128.135-6.292 6.29c-.324.324-.558.561-.79.752l-.235.177q-.309.21-.65.36l-.23.093c-.181.066-.369.114-.585.159l-.765.135-2.394.399c-.142.024-.294.05-.422.06-.1.007-.233.01-.378-.026l-.149-.049a1.1 1.1 0 0 1-.522-.474l-.046-.094a1.1 1.1 0 0 1-.074-.526c.01-.129.035-.28.06-.423l.398-2.394.134-.764a4 4 0 0 1 .16-.586l.093-.23q.15-.342.36-.65l.176-.235c.19-.232.429-.466.752-.79l6.291-6.292zm-5.485 7.36c-.35.35-.533.535-.66.688l-.11.147a2.7 2.7 0 0 0-.24.433l-.062.155c-.04.11-.072.225-.106.394l-.127.717-.398 2.393-.001.002h.003l2.393-.399.717-.126c.169-.034.284-.065.395-.105l.153-.062q.228-.1.433-.241l.148-.11c.153-.126.338-.31.687-.66l4.988-4.988-3.226-3.226zm9.517-6.291a2.28 2.28 0 0 0-3.053-.157l-.173.157-.364.363L15 8.226l.363-.363.157-.174a2.28 2.28 0 0 0 0-2.878z"/>
</svg>`;

  const FORK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M16 3h5v5"/>
  <path d="M8 3H3v5"/>
  <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/>
  <path d="m15 9 6-6"/>
</svg>`;

  // Re-render a restored conversation's turns into the transcript.
  function renderConversationTurns(state: PaneState): void {
    if (state.thinkingCard) {
      (state.root.ownerDocument!.defaultView as Window).clearInterval(
        state.thinkingCard.timer,
      );
    }
    state.transcript.textContent = "";
    state.toolCards.clear();
    state.currentAssistantBody = null;
    state.currentAssistantCard = null;
    state.thinkingCard = null;
    const lastEditableUserIndex = getLastEditableUserTurnIndex(state);
    state.conversationTurns.forEach((turn, index) => {
      if (turn.role === "user") {
        appendUserMessage(state, turn.text, cloneImages(turn.images), {
          ts: turn.ts,
          turnIndex: index,
          editable: index === lastEditableUserIndex,
          contextSnapshot: turn.contextSnapshot,
        });
        return;
      }
      renderAssistantTurn(state, turn, index);
    });
    forceScrollToBottom(state);
  }

  function renderRestoredThinkingBlock(
    state: PaneState,
    block: Extract<ConversationBlock, { type: "thinking" }>,
  ): void {
    if (!block.text.trim()) return;
    const doc = state.root.ownerDocument!;
    const el = createEl(doc, "div", "claudero-thinking-card done collapsed");
    const header = createEl(doc, "button", "claudero-thinking-header");
    header.setAttribute("tabindex", "-1");
    const labelSpan = createEl(doc, "span", "claudero-thinking-label");
    const sec = Math.max(0, Math.round((block.durationMs || 0) / 1000));
    const presentation = thinkingPresentation(block.text);
    labelSpan.textContent =
      presentation.title ||
      getString("activity-thought-for", { args: { seconds: sec } });
    const durationSpan = createEl(doc, "span", "claudero-thinking-duration");
    durationSpan.textContent = presentation.title ? `(${sec}s)` : "";
    const chevron = createThinkingChevron(doc);
    header.append(labelSpan, durationSpan, chevron);
    const body = createEl(doc, "div", "claudero-thinking-body");
    body.textContent = presentation.body;
    el.classList.toggle("summary-only", !presentation.body);
    header.addEventListener("click", () => {
      if (!el.classList.contains("summary-only")) {
        el.classList.toggle("collapsed");
      }
    });
    el.append(header, body);
    state.transcript.appendChild(el);
  }

  function renderAssistantTurn(
    state: PaneState,
    turn: ConversationTurn,
    index: number,
  ): void {
    restoreEvidenceReferences(turn.evidenceReferences);
    const blocks = Array.isArray(turn.blocks) ? turn.blocks : [];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      restoreEvidenceReferences(
        evidenceReferencesFromToolResultContent(block.content),
      );
    }
    const hasStructuredText = blocks.some(
      (block) => block.type === "text" && block.text.trim(),
    );
    for (const block of blocks) {
      if (block.type === "thinking") {
        renderRestoredThinkingBlock(state, block);
      } else if (block.type === "tool_use") {
        appendToolCard(state, {
          id: block.id,
          name: block.name,
          input: block.input,
          partialInput: block.partialInput,
        });
      } else if (block.type === "tool_result") {
        appendToolResult(state, {
          id: block.id,
          content: block.content,
          isError: block.isError === true,
        });
      } else if (block.type === "notice") {
        if (block.failureMessage) {
          appendRequestFailure(
            state,
            block.failureMessage,
            normalizeProvider(turn.provider || state.providerSelect.value),
            () => retryAssistantTurn(state, index),
          );
        } else {
          appendNoticeCard(
            state,
            (block.kind as NoticeKind) || "info",
            block.title,
            block.text,
          );
        }
      } else if (block.type === "text" && block.text.trim()) {
        appendMessageCard(state, "assistant", block.text, {
          ts: turn.ts,
          turnIndex: index,
          skipStreaming: true,
        });
      }
    }
    if (!hasStructuredText && turn.text.trim()) {
      appendMessageCard(state, "assistant", turn.text, {
        ts: turn.ts,
        turnIndex: index,
        skipStreaming: true,
      });
    }
  }

  function getLastEditableUserTurnIndex(state: PaneState): number {
    for (let i = state.conversationTurns.length - 1; i >= 0; i--) {
      if (state.conversationTurns[i]?.role === "user") return i;
    }
    return -1;
  }

  function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function startOfWeek(date: Date): Date {
    const d = startOfDay(date);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    return d;
  }

  function pad2(value: number): string {
    return String(value).padStart(2, "0");
  }

  function formatMessageTime(ts = Date.now()): string {
    const date = new Date(ts);
    const now = new Date();
    const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    if (date >= startOfDay(now)) return time;
    if (date >= startOfWeek(now)) {
      const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
        date.getDay()
      ];
      return `${weekday} ${time}`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`;
  }

  function createMessageActionButton(
    doc: Document,
    kind: "copy" | "retry" | "edit" | "fork",
    title: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = createToolbarLikeButton(doc, "", title, onClick);
    btn.setAttribute("data-claudero-message-action", kind);
    // Parse SVG template and add to button
    const template =
      kind === "copy"
        ? COPY_ICON_SVG
        : kind === "retry"
          ? RETRY_ICON_SVG
          : kind === "edit"
            ? EDIT_ICON_SVG
            : FORK_ICON_SVG;
    const wrapper = doc.createElement("div");
    wrapper.innerHTML = template.trim();
    const svg = wrapper.firstElementChild as SVGSVGElement;
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    btn.appendChild(svg);

    // For copy button, add feedback animation
    if (kind === "copy") {
      const originalOnClick = onClick;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Show check icon
        btn.innerHTML = "";
        const checkWrapper = doc.createElement("div");
        checkWrapper.innerHTML = CHECK_ICON_SVG.trim();
        const checkSvg = checkWrapper.firstElementChild as SVGSVGElement;
        checkSvg.setAttribute("width", "20");
        checkSvg.setAttribute("height", "20");
        btn.appendChild(checkSvg);

        // Restore original icon after 2 seconds
        setTimeout(() => {
          if (btn.isConnected) {
            btn.innerHTML = "";
            const origWrapper = doc.createElement("div");
            origWrapper.innerHTML = template.trim();
            const origSvg = origWrapper.firstElementChild as SVGSVGElement;
            origSvg.setAttribute("width", "20");
            origSvg.setAttribute("height", "20");
            btn.appendChild(origSvg);
          }
        }, 2000);

        // Execute the original click handler
        originalOnClick();
      });
    }

    return btn;
  }

  function copyText(state: PaneState, text: string): void {
    const win = state.root.ownerDocument!.defaultView as Window | null;
    const clipboard = win?.navigator?.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(text).catch(() => fallbackCopyText(state, text));
      return;
    }
    fallbackCopyText(state, text);
  }

  function fallbackCopyText(state: PaneState, text: string): void {
    const doc = state.root.ownerDocument!;
    const area = doc.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.documentElement.appendChild(area);
    area.select();
    try {
      doc.execCommand("copy");
    } catch {
      /* ignore */
    }
    area.remove();
  }

  function attachMessageActions(
    state: PaneState,
    msgEl: HTMLElement,
    role: MessageRole,
    text: string,
    options: MessageRenderOptions = {},
  ): void {
    const doc = state.root.ownerDocument!;
    const stack = msgEl.parentElement?.classList.contains(
      "claudero-message-stack",
    )
      ? (msgEl.parentElement as HTMLElement)
      : msgEl;
    // Remove existing meta if any
    stack.querySelector(":scope > .claudero-message-meta")?.remove();
    msgEl.dataset.ts = String(options.ts || Date.now());
    if (typeof options.turnIndex === "number")
      msgEl.dataset.turnIndex = String(options.turnIndex);

    // For assistant messages, don't add anything during streaming
    if (role === "assistant" && msgEl.classList.contains("streaming")) {
      return;
    }

    const meta = createEl(doc, "div", `claudero-message-meta ${role}`);
    const time = createEl(doc, "span", "claudero-message-time");
    time.textContent = formatMessageTime(options.ts);

    if (role === "assistant") {
      meta.appendChild(
        createMessageActionButton(doc, "copy", "复制", () =>
          copyText(state, text),
        ),
      );
      meta.appendChild(
        createMessageActionButton(doc, "retry", "重试", () =>
          retryAssistantTurn(state, options.turnIndex),
        ),
      );
      if (
        getProviderCapabilities(normalizeProvider(state.providerSelect.value))
          .supportsFork
      ) {
        meta.appendChild(
          createMessageActionButton(
            doc,
            "fork",
            "分叉",
            () => void forkConversationAtTurn(state, options.turnIndex),
          ),
        );
      }
      meta.appendChild(time);
    } else {
      const summaryChip = buildMessageContextSummaryChip(
        state,
        options.contextSnapshot,
      );
      if (summaryChip) meta.appendChild(summaryChip);
      meta.appendChild(time);
      meta.appendChild(
        createMessageActionButton(doc, "copy", "复制", () =>
          copyText(state, text),
        ),
      );
      if (options.editable) {
        meta.appendChild(
          createMessageActionButton(doc, "edit", "修改问题", () =>
            editLastUserTurn(state, options.turnIndex),
          ),
        );
      }
    }

    stack.appendChild(meta);
  }

  function refreshEditableMessageActions(state: PaneState): void {
    state.transcript
      .querySelectorAll('[data-claudero-message-action="edit"]')
      .forEach((el) => el.remove());
  }

  function appendMessageStack(
    state: PaneState,
    role: MessageRole,
    msgEl: HTMLElement,
  ): HTMLElement {
    const doc = state.root.ownerDocument!;
    const stack = createEl(doc, "div", `claudero-message-stack ${role}`);
    stack.appendChild(msgEl);
    state.transcript.appendChild(stack);
    return stack;
  }

  // One user bubble holding the question text and any sent images together.
  function appendUserMessage(
    state: PaneState,
    text: string,
    images: PendingImage[],
    options: MessageRenderOptions = {},
  ): HTMLElement {
    const doc = state.root.ownerDocument!;
    const msgEl = createEl(doc, "div", "claudero-message user");
    // Images appear above the text (image-first layout)
    if (images.length > 0) {
      const row = createEl(doc, "div", "claudero-img-row");
      if (text) row.style.marginBottom = "8px";
      for (const img of images) {
        const thumb = createEl(doc, "div", "claudero-img-thumb");
        const imgEl = doc.createElement("img") as HTMLImageElement;
        const dataUrl = imageDataUrl(img);
        imgEl.src = dataUrl;
        thumb.appendChild(imgEl);
        attachImagePreview(state, thumb, dataUrl);
        row.appendChild(thumb);
      }
      msgEl.appendChild(row);
    }
    if (text) {
      const body = createEl(doc, "div", "claudero-message-body");
      renderMarkdown(doc, body, text);
      msgEl.appendChild(body);
    }
    appendMessageStack(state, "user", msgEl);
    attachMessageActions(state, msgEl, "user", text || "(图片)", options);
    scrollTranscript(state);
    return msgEl;
  }

  function appendMessageCard(
    state: PaneState,
    role: MessageRole,
    text: string,
    options: MessageRenderOptions = {},
  ): HTMLElement {
    const doc = state.root.ownerDocument!;
    const msgEl = createEl(doc, "div", `claudero-message ${role}`);
    const body = createEl(doc, "div", "claudero-message-body");
    msgEl.appendChild(body);
    appendMessageStack(state, role, msgEl);
    // Add streaming class before calling attachMessageActions so buttons are not added during streaming
    // Skip streaming class for restored messages or when explicitly requested
    if (role === "assistant" && !options.skipStreaming) {
      msgEl.classList.add("streaming");
    }
    if (text) renderMarkdown(doc, body, text);
    attachMessageActions(state, msgEl, role, text, options);
    scrollTranscript(state);
    return body;
  }

  return {
    renderConversationTurns,
    getLastEditableUserTurnIndex,
    refreshEditableMessageActions,
    appendUserMessage,
    appendMessageCard,
    attachMessageActions,
  };
}

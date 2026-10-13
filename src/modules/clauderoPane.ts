import { buildAuthenticatedZoteroPayload } from "../shared/zoteroEndpointAuth";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  cancelHelperRequest,
  fetchSlashCommands,
  requestHelperJson,
  runAuxClaudeQuery,
} from "./claudeHelperClient";
import { createComposerView } from "./composerView";
import { clearConversationState } from "./conversationController";
import { showConversationHistoryPopup } from "./conversationHistoryView";
import {
  deleteAllConversations,
  deleteConversation,
  exportConversationToFile,
  getConversationTitle,
  getDefaultPrompts,
  loadConversationById,
  loadCustomPrompts,
  newConversationId,
  renameConversation,
  type ConversationIndexEntry,
  type CustomPrompt,
} from "./conversationStore";
import { logDiagnostic } from "./diagnosticLog";
import { onElementRemoved } from "./elementLifecycle";
import { getOrCreateHelperToken } from "./helperToken";
import { renderPromptIcon } from "./iconPickerView";
import { cancelImageReads, replaceImageDraft } from "./imageDraft";
import {
  closeContextDetailPopup,
  midTruncate,
  populateContextToken,
} from "./paneContextView";
import { createPaneConversationActions } from "./paneConversationActions";
import {
  CHECK_ICON_SVG,
  createEl,
  createToolbarLikeButton,
  isAtBottom,
  makeChipRemoveBtn,
  scrollTranscript,
  setStatusDot,
  smoothScrollToBottom,
  updateScrollToBottomBtn,
} from "./paneDom";
import { addPastedImageFiles, renderPendingImages } from "./paneImageView";
import { createPaneMessageView } from "./paneMessageView";
import {
  applyModelEfforts,
  effortOptionsForProvider,
  getSelectedEffort,
  normalizePermissionMode,
  permissionOptionsForProvider,
  refreshProviderModels,
} from "./paneModelControls";
import { createPanePromptRequest } from "./panePromptRequest";
import type { PaneRequestHost } from "./paneRequestHost";
import { appendNoticeCard } from "./paneServiceNotices";
import { createPaneSlashRequest } from "./paneSlashRequest";
import type { PaneState, SlashCommand } from "./paneState";
import { createPaneStreamingView } from "./paneStreamingView";
import {
  hidePermissionDialog,
  hideQuestionDialog,
  showExitPlanDialog,
  showPermissionDialog,
  showQuestionDialog,
  type PendingExitPlan,
  type PendingQuestion,
  type PermissionRequestView,
} from "./permissionDialog";
import { showPromptPopup } from "./promptPopupView";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  modelOptionsForProvider,
  normalizeProvider,
  PROVIDER_OPTIONS,
} from "./providerRegistry";
import {
  getCurrentReaderFilePath,
  getCurrentReaderItem,
  getSelectedReaderAnnotations,
  getSelectedReaderText,
} from "./zoteroContext";
import { getZoteroEndpointBaseUrl } from "./zoteroEndpoint";

// Resolve cross-boundary callbacks on demand, never during construction.
// Views, conversation actions and request executors never import this controller.
const messageView = createPaneMessageView({
  retryAssistantTurn: (...args) => retryAssistantTurn(...args),
  forkConversationAtTurn: (...args) => forkConversationAtTurn(...args),
  editLastUserTurn: (...args) => editLastUserTurn(...args),
  createThinkingChevron: (...args) => createThinkingChevron(...args),
});
const {
  renderConversationTurns,
  getLastEditableUserTurnIndex,
  appendMessageCard,
} = messageView;

const conversationActions = createPaneConversationActions({
  renderConversationTurns: (...args) => renderConversationTurns(...args),
  getLastEditableUserTurnIndex: (...args) =>
    getLastEditableUserTurnIndex(...args),
  sendPrompt: (...args) => sendPrompt(...args),
  updateSendButton: (...args) => updateSendButton(...args),
  appendWelcomeCard: (...args) => appendWelcomeCard(...args),
  pushAssistantBlock: (...args) => pushAssistantBlock(...args),
});
const {
  retryAssistantTurn,
  forkConversationAtTurn,
  editLastUserTurn,
  saveConversation,
  restoreConversation,
  startNewConversation,
  restoreLatestConversation,
} = conversationActions;

// Client-side built-in slash commands (not sent to the SDK)
const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "", isBuiltin: true },
];

function builtinSlashCommands(): SlashCommand[] {
  return BUILTIN_SLASH_COMMANDS.map((command) => ({
    ...command,
    description: getString("slash-clear"),
  }));
}

// Cache of SDK slash commands fetched from the helper
let _sdkCommandsCache: SlashCommand[] | null = null;
let _sdkCommandsFetching = false;

const streamingView = createPaneStreamingView({
  appendMessageCard,
  getSelectedEffort,
});
const {
  pushAssistantBlock,
  stopThinkingAnimation,
  createThinkingChevron,
  finalizeThinkingCard,
} = streamingView;

const requestHost: PaneRequestHost = {
  messages: messageView,
  streaming: streamingView,
  conversation: conversationActions,
  interactions: { startInteractionPolling, stopInteractionPolling },
  ui: {
    updateContext,
    setRunning,
    maybeAppendUndoCard,
    generateConversationTitle,
    setSdkCommands: (commands) => {
      _sdkCommandsCache = commands;
    },
  },
};
const sendRawSlashCommand = createPaneSlashRequest(requestHost);
const sendPrompt = createPanePromptRequest({
  ...requestHost,
  sendRawSlashCommand,
});

const ANNO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">
  <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M2 2h12v12H2zM1 1h14v14H1V2zm12 12L8.75 3h-1.5L3 13h1.63l1.275-3h4.19l1.275 3zM8 5.07 6.33 9h3.34z"/>
</svg>`;

const UNDO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="currentColor">
  <path d="M414.165333 567.168a42.624 42.624 0 1 1-60.330666 60.330667l-213.333334-213.333334-3.114666-3.498666-0.298667-0.341334-0.725333-0.938666a32.085333 32.085333 0 0 1-3.029334-4.736 49.536 49.536 0 0 1-2.304-4.821334l-0.938666-2.56-0.554667-1.92a65.621333 65.621333 0 0 1-0.682667-2.773333l-0.384-2.261333A43.52 43.52 0 0 1 128 384l0.170667 3.797333A66.261333 66.261333 0 0 1 128 384.810667V384v-0.810667c0-0.981333 0.085333-1.962667 0.170667-2.986666l0.298666-2.56 0.384-2.218667c0.170667-0.938667 0.426667-1.877333 0.64-2.773333l0.64-1.962667c0.256-0.853333 0.597333-1.664 0.896-2.517333a34.858667 34.858667 0 0 1 2.304-4.821334l0.896-1.536a40.874667 40.874667 0 0 1 6.272-7.936l-3.413333 3.84a42.112 42.112 0 0 1 3.413333-3.84l213.333334-213.333333a42.624 42.624 0 1 1 60.330666 60.330667L273.664 341.333333H682.666667a213.290667 213.290667 0 0 1 213.12 204.074667L896 554.666667v298.666666a42.666667 42.666667 0 0 1-85.333333 0v-298.666666a128 128 0 0 0-128-128H273.664l140.501333 140.501333z"/>
</svg>`;

const VIEW_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="currentColor">
  <path d="M455.68 770.56c-169.472 0-307.2-137.728-307.2-307.2s137.728-306.688 307.2-306.688 307.2 137.728 307.2 306.688c-0.512 169.472-138.24 307.2-307.2 307.2z m0-547.328c-132.608 0-240.64 108.032-240.64 240.128 0 132.608 108.032 240.64 240.64 240.64s240.64-108.032 240.64-240.64c-0.512-132.608-108.544-240.128-240.64-240.128zM855.04 888.32c-8.704 0-16.896-3.072-23.552-9.728l-113.664-113.664c-12.8-12.8-12.8-34.304 0-47.104 12.8-12.8 34.304-12.8 47.104 0l113.664 113.664c12.8 12.8 12.8 34.304 0 47.104-6.656 6.656-14.848 9.728-23.552 9.728z"/>
</svg>`;

// Context categories captured with a message, ordered by display priority.

const PANEL_ID = "claudero-side-panel";
const SPLITTER_ID = "claudero-side-splitter";
const TOOLBAR_BUTTON_ID = "claudero-toolbar-button";
const LIBRARY_ANCHOR_ID = "zotero-items-splitter";
const READER_ANCHOR_ID = "zotero-context-splitter";
const paneStates = new WeakMap<HTMLElement, PaneState>();
const mountedWindows = new WeakSet<Window>();
const windowCleanupCallbacks = new WeakMap<Window, () => void>();
// ── Font zoom (Cmd/Ctrl + - / = / 0) ───────────────────────────────────────
// Browser-like content zoom for the pane. The percentage is persisted in the
// `fontScale` pref and applied as a CSS multiplier on the pane root.

const FONT_SCALE_MIN = 70;
const FONT_SCALE_MAX = 200;
const FONT_SCALE_STEP = 10;
const FONT_SCALE_DEFAULT = 100;

function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(value)));
}

function getFontScale(): number {
  return clampFontScale(Number(getPref("fontScale")));
}

function applyFontScale(state: PaneState, scale: number): void {
  state.root.style.setProperty("--claudero-font-scale", String(scale / 100));
}

// Transient "130%" badge, mirroring the browser zoom indicator.
function showFontScaleIndicator(state: PaneState, scale: number): void {
  const doc = state.root.ownerDocument!;
  const win = doc.defaultView as Window;
  let badge = state.root.querySelector(".claudero-zoom-indicator") as
    | (HTMLElement & { _hideTimer?: number })
    | null;
  if (!badge) {
    badge = createEl(doc, "div", "claudero-zoom-indicator") as HTMLElement & {
      _hideTimer?: number;
    };
    state.root.appendChild(badge);
  }
  badge.textContent = `${scale}%`;
  if (badge._hideTimer) win.clearTimeout(badge._hideTimer);
  badge._hideTimer = win.setTimeout(() => badge?.remove(), 1200);
}

function setFontScale(state: PaneState, scale: number): void {
  const clamped = clampFontScale(scale);
  setPref("fontScale", clamped);
  applyFontScale(state, clamped);
  showFontScaleIndicator(state, clamped);
}

function adjustFontScale(state: PaneState, delta: number): void {
  setFontScale(state, getFontScale() + delta);
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function createSendArrowSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M8.3125 0.981587C8.66767 1.0545 8.97902 1.20558 9.2627 1.43374C9.48724 1.61438 9.73029 1.85933 9.97949 2.10854L14.707 6.83608L13.293 8.25014L9 3.95717V15.0431H7V3.95717L2.70703 8.25014L1.29297 6.83608L6.02051 2.10854C6.26971 1.85933 6.51277 1.61438 6.7373 1.43374C6.97662 1.24126 7.28445 1.04542 7.6875 0.981587C7.8973 0.94841 8.1031 0.956564 8.3125 0.981587Z",
  );
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

function createSendArrowSvgDown(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  // Flipped version: transform="rotate(180) translate(-16, -16)" or just flip the path
  path.setAttribute(
    "d",
    "M7.6875 15.0184C7.33233 14.9455 7.02098 14.7944 6.7373 14.5663C6.51276 14.3856 6.26971 14.1407 6.02051 13.8915L1.29297 9.16392L2.70703 7.74986L7 12.0428V0.956905H9V12.0428L13.293 7.74986L14.707 9.16392L9.97949 13.8915C9.73029 14.1407 9.48724 14.3856 9.2627 14.5663C9.02338 14.7587 8.71555 14.9546 8.3125 15.0184C8.1027 15.0516 7.8969 15.0434 7.6875 15.0184Z",
  );
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}

function createStopSquareSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("fill", "none");
  const rect = doc.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "2");
  rect.setAttribute("y", "2");
  rect.setAttribute("width", "10");
  rect.setAttribute("height", "10");
  rect.setAttribute("rx", "2");
  rect.setAttribute("fill", "currentColor");
  svg.appendChild(rect);
  return svg;
}

function updateSendButton(state: PaneState, running: boolean): void {
  const btn = state.sendButton;
  const doc = btn.ownerDocument!;
  btn.textContent = "";
  if (running) {
    btn.classList.add("stop");
    btn.appendChild(createStopSquareSvg(doc));
  } else {
    btn.classList.remove("stop");
    btn.appendChild(createSendArrowSvg(doc));
  }
}

function updatePermissionBadge(state: PaneState): void {
  (state.permissionSelect as any).value = state.permissionMode;
}

function createPanelHost(doc: Document): HTMLElement {
  const xulHost = (
    doc as Document & {
      createXULElement?: (tag: string) => HTMLElement;
    }
  ).createXULElement?.("vbox");
  const host = (xulHost ?? doc.createElement("div")) as HTMLElement;
  host.id = PANEL_ID;
  host.className = "claudero-host";
  host.setAttribute("persist", "width");
  // Reset overly-wide persisted widths on every mount
  const savedWidth = parseInt(host.getAttribute("width") || "0", 10);
  if (!savedWidth || savedWidth > 480) {
    host.setAttribute("width", "360");
  }
  return host;
}

function createPanelSplitter(doc: Document, anchor: HTMLElement): HTMLElement {
  const xulSplitter = (
    doc as Document & {
      createXULElement?: (tag: string) => HTMLElement;
    }
  ).createXULElement?.("splitter");
  const splitter = (xulSplitter ?? doc.createElement("div")) as HTMLElement;
  splitter.id = SPLITTER_ID;
  splitter.className = "claudero-splitter";
  splitter.setAttribute("resizebefore", "closest");
  splitter.setAttribute("resizeafter", "closest");
  splitter.setAttribute("orient", anchor.getAttribute("orient") || "vertical");
  return splitter;
}

function getSelectedTabID(win: Window): string {
  return (
    (win as Window & { Zotero_Tabs?: { selectedID?: string } }).Zotero_Tabs
      ?.selectedID ?? "zotero-pane"
  );
}

function getSelectedTabType(win: Window): string {
  return (
    (win as Window & { Zotero_Tabs?: { selectedType?: string } }).Zotero_Tabs
      ?.selectedType ?? "library"
  );
}

function getMountAnchor(doc: Document, win: Window): HTMLElement | null {
  const selectedID = getSelectedTabID(win);
  const anchorID =
    selectedID === "zotero-pane" ? LIBRARY_ANCHOR_ID : READER_ANCHOR_ID;
  return doc.getElementById(anchorID) as HTMLElement | null;
}

function getCurrentRegularItems(win: Window): Zotero.Item[] {
  try {
    if (getSelectedTabType(win) !== "library") return [];
    const selected = ((
      win as Window & { ZoteroPane?: { getSelectedItems?: () => unknown } }
    ).ZoteroPane?.getSelectedItems?.() ||
      Zotero.getActiveZoteroPane().getSelectedItems()) as Zotero.Item[];
    const items: Zotero.Item[] = [];
    for (const item of selected) {
      if (item.isRegularItem()) {
        items.push(item);
      } else if (item.isAttachment?.()) {
        // If an attachment is selected, use its parent (regular) item instead
        const parent = item.parentItem;
        if (
          parent &&
          parent.isRegularItem() &&
          !items.some((i) => i.id === parent.id)
        ) {
          items.push(parent);
        }
      }
    }
    return items;
  } catch {
    return [];
  }
}

function getItemTitle(item: Zotero.Item | null): string {
  if (!item) return getString("pane-no-item");
  return (item.getField("title") as string) || item.getDisplayTitle();
}

function mkItemIconEl(doc: Document, item: Zotero.Item): HTMLElement {
  // Reuse Zotero's native CSS icon: a <span> whose data-item-type drives the
  // background-image via the global .icon-item-type[data-item-type=...] rules.
  const span = createEl(
    doc,
    "span",
    "claudero-chip-icon icon icon-css icon-item-type cell-icon item-icon",
  );
  const iconName: string =
    (
      item as unknown as { getItemTypeIconName?: () => string }
    ).getItemTypeIconName?.() ?? "";
  if (iconName) span.setAttribute("data-item-type", iconName);
  return span;
}

function rebuildItemChip(state: PaneState): void {
  const doc = state.root.ownerDocument!;
  const chip = state.itemChip;
  const items = state.currentItems;
  if (items.length === 0) {
    chip.textContent = "";
    return;
  }

  if (items.length === 1) {
    const item = items[0]!;
    const fullTitle = getItemTitle(item);
    populateContextToken(chip, doc, {
      icon: mkItemIconEl(doc, item),
      label: fullTitle.slice(0, 25),
      tooltip: midTruncate(fullTitle, 140),
    });
  } else {
    const iconsWrap = createEl(doc, "div", "claudero-item-icons");
    for (const item of items.slice(0, 3)) {
      const icon = mkItemIconEl(doc, item);
      icon.classList.add("stacked");
      iconsWrap.appendChild(icon);
    }
    const titles = items.map((i) => getItemTitle(i)).join("\n");
    populateContextToken(chip, doc, {
      icon: iconsWrap,
      label: getString("pane-selected-items", {
        args: { count: items.length },
      }),
      tooltip: midTruncate(titles, 140),
    });
  }
}

function setRunning(state: PaneState, running: boolean): void {
  state.running = running;
  if (state.disposed) return;
  // Conversation no longer requires a Zotero context — the input and send
  // button stay enabled so the user can chat freely.
  state.sendButton.disabled = false;
  state.input.disabled = false;
  state.providerSelect.disabled = running;
  state.modelSelect.disabled = running;
  state.effortSelect.disabled = running;
  state.permissionSelect.disabled = running;
  setStatusDot(state, running ? "streaming" : "ready");
  updateSendButton(state, running);

  // Clear pending-interaction polling when not running.
  if (!running) {
    stopInteractionPolling(state);
    hidePermissionDialog(state);
    hideQuestionDialog(state);
  }
  if (!running) {
    const preferredProvider = normalizeProvider(getPref("provider"));
    if (preferredProvider !== normalizeProvider(state.providerSelect.value)) {
      setPaneProvider(state, preferredProvider);
    }
  }
}

function updateContext(state: PaneState): void {
  const doc = state.root.ownerDocument!;
  const win = doc.defaultView as Window;
  const selectedType = getSelectedTabType(win);
  const autoItems = getCurrentRegularItems(win);
  const autoReaderPath =
    selectedType === "reader" ? getCurrentReaderFilePath(win) : "";
  const autoText = selectedType === "reader" ? getSelectedReaderText(win) : "";
  const autoAnnotations =
    selectedType === "reader" ? getSelectedReaderAnnotations(win) : [];

  // When auto context changes to a new item/reader, reset dismissed flags
  if (autoReaderPath && autoReaderPath !== state.readerFilePath)
    state.dismissedReader = false;
  if (autoText && autoText !== state.selectedText) state.dismissedText = false;

  // Reset dismissed when the annotation selection changes
  const annoSig = autoAnnotations
    .map((a) => `${a.text}:${a.pageIndex ?? ""}`)
    .join("|");
  const prevAnnoSig = state.selectedAnnotations
    .map((a) => `${a.text}:${a.pageIndex ?? ""}`)
    .join("|");
  if (annoSig !== prevAnnoSig && autoAnnotations.length > 0)
    state.dismissedAnnotations = false;

  state.currentItems = autoItems;
  state.currentItem = state.currentItems[0] ?? null;
  state.readerFilePath = autoReaderPath;
  state.selectedText = autoText;
  state.selectedAnnotations = autoAnnotations;

  const hasItem = state.currentItems.length > 0;
  const hasReader = !!state.readerFilePath && !state.dismissedReader;
  const hasText = !!state.selectedText && !state.dismissedText;
  const hasAnnotations =
    autoAnnotations.length > 0 && !state.dismissedAnnotations;
  const hasManual = state.manualItems.length > 0;
  const hasContext =
    hasItem || hasReader || hasText || hasAnnotations || hasManual;

  // This runs once per second on a timer. Re-rendering the chips every tick
  // (clearing then re-appending DOM nodes) makes the "当前PDF" chip flicker and
  // shifts the composer height, which jolts the transcript scroll position.
  // Skip the DOM rebuild entirely when nothing that affects the UI changed.
  const signature = JSON.stringify([
    state.currentItems.map((i) => i.id),
    state.readerFilePath,
    state.selectedText,
    annoSig,
    state.manualItems.map((i) => i.id),
    state.dismissedReader,
    state.dismissedText,
    state.dismissedAnnotations,
    state.running,
    selectedType,
  ]);
  if (signature === state.lastContextSignature) return;
  state.lastContextSignature = signature;

  // Context is optional now; the composer is always usable.
  state.input.placeholder = getString("composer-ask-placeholder");
  state.input.disabled = false;
  state.sendButton.disabled = false;
  state.contextChips.style.display = hasContext ? "flex" : "none";
  state.itemChip.style.display = hasItem ? "inline-flex" : "none";
  state.readerChip.style.display = hasReader ? "inline-flex" : "none";
  state.textChip.style.display = hasText ? "inline-flex" : "none";
  state.annotationChip.style.display = hasAnnotations ? "inline-flex" : "none";
  rebuildItemChip(state);

  // Rebuild reader chip
  if (hasReader) {
    const readerItem = getCurrentReaderItem(win);
    const readerTooltip = [
      readerItem ? getItemTitle(readerItem) : "",
      state.readerFilePath,
    ]
      .filter(Boolean)
      .join("\n");
    populateContextToken(state.readerChip, doc, {
      icon: readerItem ? mkItemIconEl(doc, readerItem) : undefined,
      label: getString("context-current-pdf"),
      tooltip: readerTooltip ? midTruncate(readerTooltip, 140) : undefined,
    });
    state.readerChip.appendChild(
      makeChipRemoveBtn(doc, () => {
        state.dismissedReader = true;
        state.readerChip.style.display = "none";
        const hasCtx =
          state.currentItems.length > 0 ||
          state.selectedText.length > 0 ||
          state.selectedAnnotations.length > 0 ||
          state.manualItems.length > 0;
        state.contextChips.style.display = hasCtx ? "flex" : "none";
      }),
    );
  } else {
    state.readerChip.textContent = "";
  }

  // Rebuild text chip
  if (hasText) {
    populateContextToken(state.textChip, doc, {
      icon: createEl(doc, "div", "claudero-text-icon"),
      label: getString("context-selected-text"),
      tooltip: midTruncate(state.selectedText, 140),
    });
    state.textChip.appendChild(
      makeChipRemoveBtn(doc, () => {
        state.dismissedText = true;
        state.textChip.style.display = "none";
        const hasCtx =
          state.currentItems.length > 0 ||
          (!!state.readerFilePath && !state.dismissedReader) ||
          state.selectedAnnotations.length > 0 ||
          state.manualItems.length > 0;
        state.contextChips.style.display = hasCtx ? "flex" : "none";
      }),
    );
  } else {
    state.textChip.textContent = "";
  }

  // Rebuild annotation chip
  if (hasAnnotations) {
    const annoIconWrapper = doc.createElement("div");
    annoIconWrapper.innerHTML = ANNO_ICON_SVG.trim();
    const annoIcon = annoIconWrapper.firstElementChild as SVGSVGElement;
    annoIcon.classList.add("claudero-anno-icon");
    annoIcon.setAttribute("width", "13");
    annoIcon.setAttribute("height", "13");
    const count = state.selectedAnnotations.length;
    const annoRaw = state.selectedAnnotations
      .map((a) => {
        const page =
          typeof a.pageIndex === "number" ? `p.${a.pageIndex + 1} ` : "";
        return page + (a.text || "");
      })
      .join("\n\n");
    populateContextToken(state.annotationChip, doc, {
      icon: annoIcon as unknown as HTMLElement,
      label: getString("pane-selected-annotations", { args: { count } }),
      tooltip: annoRaw ? midTruncate(annoRaw, 140) : undefined,
    });
    state.annotationChip.appendChild(
      makeChipRemoveBtn(doc, () => {
        state.dismissedAnnotations = true;
        state.annotationChip.style.display = "none";
        const hasCtx =
          state.currentItems.length > 0 ||
          (!!state.readerFilePath && !state.dismissedReader) ||
          state.manualItems.length > 0;
        state.contextChips.style.display = hasCtx ? "flex" : "none";
      }),
    );
  } else {
    state.annotationChip.textContent = "";
  }

  rebuildManualChips(state);
}

function rebuildManualChips(state: PaneState): void {
  const doc = state.root.ownerDocument!;
  state.contextChips
    .querySelectorAll(".claudero-manual-chip")
    .forEach((el) => el.remove());
  for (const item of state.manualItems) {
    const chip = createEl(
      doc,
      "div",
      "claudero-context-token claudero-manual-chip",
    );
    chip.style.display = "inline-flex";
    const fullTitle = getItemTitle(item);
    populateContextToken(chip, doc, {
      icon: mkItemIconEl(doc, item),
      label: fullTitle.slice(0, 20),
      tooltip: midTruncate(fullTitle, 140),
    });
    chip.appendChild(
      makeChipRemoveBtn(doc, () => {
        state.manualItems = state.manualItems.filter((i) => i.id !== item.id);
        chip.remove();
        const hasCtx =
          state.currentItems.length > 0 ||
          (!!state.readerFilePath && !state.dismissedReader) ||
          (!!state.selectedText && !state.dismissedText) ||
          state.selectedAnnotations.length > 0 ||
          state.manualItems.length > 0;
        state.contextChips.style.display = hasCtx ? "flex" : "none";
      }),
    );
    state.contextChips.appendChild(chip);
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactValue(value: unknown, max = 140): string {
  const raw = stringifyValue(value).replace(/\s+/g, " ").trim();
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

// Build a short human label for a reversible write result returned by the
// Zotero endpoint. Returns null for read operations (which carry no opId).
function describeWriteResult(result: Record<string, unknown>): string | null {
  if (typeof result.added === "number" || typeof result.removed === "number") {
    const added = typeof result.added === "number" ? result.added : 0;
    const removed = typeof result.removed === "number" ? result.removed : 0;
    const parts: string[] = [];
    if (added)
      parts.push(getString("write-tags-added", { args: { count: added } }));
    if (removed)
      parts.push(getString("write-tags-removed", { args: { count: removed } }));
    return parts.length ? parts.join("  ") : getString("write-tags-updated");
  }
  if (result.noteId != null) return getString("write-note-created");
  if (typeof result.field === "string") {
    return getString("write-field-set", { args: { field: result.field } });
  }
  return null;
}

async function callZoteroEndpoint(
  action: string,
  args: Record<string, unknown>,
): Promise<{ success?: boolean; error?: string; result?: unknown }> {
  // The endpoint rejects every request without the helper capability token.
  const token = await getOrCreateHelperToken();
  const res = await fetch(getZoteroEndpointBaseUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildAuthenticatedZoteroPayload(action, args, token)),
  });
  return res.json() as Promise<{ success?: boolean; error?: string }>;
}

// When a write succeeds, render an inline "✓ +N tags  [Undo] [View]" card so the
// user can reverse it or navigate to the affected item with one click.
function maybeAppendUndoCard(
  state: PaneState,
  result: { content: string; isError: boolean },
): void {
  if (result.isError || !result.content) return;
  let parsed: { success?: boolean; result?: Record<string, unknown> };
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return;
  }
  const opId = parsed?.result?.operationId;
  if (!parsed?.success || typeof opId !== "string") return;
  const label = parsed.result ? describeWriteResult(parsed.result) : null;
  if (!label) return;
  const itemId =
    parsed.result && typeof parsed.result.itemId === "number"
      ? parsed.result.itemId
      : undefined;
  logDiagnostic("write.success", {
    operationId: opId,
    label,
    itemId,
  });
  appendUndoCard(state, opId, label, itemId);
}

function appendUndoCard(
  state: PaneState,
  operationId: string,
  label: string,
  itemId?: number,
): void {
  const doc = state.root.ownerDocument!;
  const card = createEl(doc, "div", "claudero-undo-card");

  const info = createEl(doc, "div", "claudero-undo-info");
  const icon = createEl(doc, "span", "claudero-undo-icon");
  // Use SVG check icon instead of text
  const checkWrapper = doc.createElement("div");
  checkWrapper.innerHTML = CHECK_ICON_SVG.trim();
  const checkSvg = checkWrapper.firstElementChild as SVGSVGElement;
  checkSvg.setAttribute("width", "14");
  checkSvg.setAttribute("height", "14");
  icon.appendChild(checkSvg);
  const text = createEl(doc, "span", "claudero-undo-label");
  text.textContent = label;
  info.append(icon, text);

  const btnGroup = createEl(doc, "div", "claudero-undo-btns");
  let viewBtn: HTMLButtonElement | undefined;

  // View button — select the affected item in the Zotero library tree
  if (itemId !== undefined) {
    viewBtn = createEl(
      doc,
      "button",
      "claudero-undo-btn claudero-undo-btn-icon",
    ) as HTMLButtonElement;
    viewBtn.title = getString("pane-undo-view");
    const viewWrapper = doc.createElement("div");
    viewWrapper.innerHTML = VIEW_ICON_SVG.trim();
    const viewSvg = viewWrapper.firstElementChild as SVGSVGElement;
    viewSvg.setAttribute("width", "13");
    viewSvg.setAttribute("height", "13");
    viewBtn.appendChild(viewSvg);
    viewBtn.addEventListener("click", () => {
      try {
        const mainWin = (Zotero as any).getMainWindow?.() as Window | undefined;
        if (mainWin && (mainWin as any).ZoteroPane) {
          (mainWin as any).ZoteroPane.selectItem(itemId);
        }
      } catch {
        // Silently ignore — the pane reference may not be ready
      }
    });
    btnGroup.appendChild(viewBtn);
  }

  const undoBtn = createEl(
    doc,
    "button",
    "claudero-undo-btn claudero-undo-btn-icon",
  ) as HTMLButtonElement;
  undoBtn.title = getString("pane-undo");
  const undoWrapper = doc.createElement("div");
  undoWrapper.innerHTML = UNDO_ICON_SVG.trim();
  const undoSvg = undoWrapper.firstElementChild as SVGSVGElement;
  undoSvg.setAttribute("width", "13");
  undoSvg.setAttribute("height", "13");
  undoBtn.appendChild(undoSvg);
  undoBtn.addEventListener("click", () => {
    undoBtn.disabled = true;
    logDiagnostic("write.undo.requested", { operationId, label, itemId });
    void callZoteroEndpoint("undo_last", { operationId })
      .then((res) => {
        if (res?.success) {
          logDiagnostic("write.undo.success", { operationId, label, itemId });
          card.classList.add("undone");
          icon.textContent = "↩";
          text.textContent = getString("pane-undo-success", {
            args: { label },
          });
          viewBtn?.remove();
          undoBtn.remove();
        } else {
          logDiagnostic(
            "write.undo.failed",
            { operationId, label, itemId, error: res?.error || "unknown" },
            "warning",
          );
          undoBtn.disabled = false;
          appendNoticeCard(
            state,
            "warning",
            getString("pane-undo-failed"),
            res?.error || getString("pane-undo-unavailable"),
          );
        }
      })
      .catch((e) => {
        logDiagnostic(
          "write.undo.error",
          { operationId, label, itemId, error: String(e) },
          "error",
        );
        undoBtn.disabled = false;
        appendNoticeCard(
          state,
          "warning",
          getString("pane-undo-failed"),
          String(e),
        );
      });
  });
  btnGroup.appendChild(undoBtn);

  card.append(info, btnGroup);
  state.transcript.appendChild(card);
  scrollTranscript(state);
}

function stopInteractionPolling(state: PaneState): void {
  if (state.permissionCheckTimer !== null)
    clearTimeout(state.permissionCheckTimer);
  state.permissionCheckTimer = null;
  state.permissionPollController?.abort();
  state.permissionPollController = undefined;
  state.permissionPollInFlight = false;
}

function startInteractionPolling(
  state: PaneState,
  current: () => boolean,
): void {
  stopInteractionPolling(state);
  const poll = async () => {
    if (!current() || state.cancelRequested || !state.running) return;
    await checkPendingInteractions(state, current);
    if (current() && !state.cancelRequested && state.running)
      state.permissionCheckTimer = setTimeout(
        () => void poll(),
        800,
      ) as unknown as number;
  };
  void poll();
}

async function checkPendingInteractions(
  state: PaneState,
  current: () => boolean,
): Promise<void> {
  if (!current() || state.cancelRequested || state.permissionPollInFlight)
    return;
  const ownerRequestId = state.activeRequestId!;
  const controller = new AbortController();
  state.permissionPollController = controller;
  state.permissionPollInFlight = true;
  const timer = setTimeout(() => controller.abort(), 8_000);
  const valid = () =>
    current() &&
    !controller.signal.aborted &&
    !state.cancelRequested &&
    state.running;
  const pending = <T>(kind: string) =>
    requestHelperJson<T | null>(
      `/pending-${kind}?ownerRequestId=${encodeURIComponent(ownerRequestId)}`,
      { signal: controller.signal },
    );
  try {
    const permission = await pending<PermissionRequestView>("permission");
    if (!valid()) return;
    if (permission) {
      showPermissionDialog(state, permission);
      stopThinkingAnimation(state);
    } else hidePermissionDialog(state);
    const exitPlan = await pending<PendingExitPlan>("exit-plan");
    if (!valid()) return;
    if (exitPlan) {
      showExitPlanDialog(state, exitPlan);
      stopThinkingAnimation(state);
      return;
    }
    if (state.questionDialog?.getAttribute("data-dialog-kind") === "exit-plan")
      hideQuestionDialog(state);
    const question = await pending<PendingQuestion>("question");
    if (!valid()) return;
    if (question) {
      showQuestionDialog(state, question);
      stopThinkingAnimation(state);
    } else if (
      state.questionDialog?.getAttribute("data-dialog-kind") === "question"
    )
      hideQuestionDialog(state);
  } catch (error) {
    if (valid())
      ztoolkit.log("[Claudero] Pending interaction poll failed:", error);
  } finally {
    clearTimeout(timer);
    if (state.permissionPollController === controller) {
      state.permissionPollController = undefined;
      state.permissionPollInFlight = false;
    }
  }
}

function appendWelcomeCard(state: PaneState): void {
  const doc = state.root.ownerDocument!;
  const card = createEl(doc, "div", "claudero-welcome-card redesigned");
  const header = createEl(doc, "div", "claudero-welcome-header");
  const title = createEl(doc, "strong");
  const text = createEl(doc, "p");
  const suggestions = createEl(doc, "div", "claudero-suggestions redesigned");
  title.textContent = getString("composer-paper-question");
  text.textContent = getString("composer-paper-description");
  header.append(title, text);
  card.append(header, suggestions);
  state.transcript.appendChild(card);

  // Show first 4 prompts (customs first, then defaults), skip insert-note
  void loadCustomPrompts()
    .catch((error) => {
      ztoolkit.log("[Claudero] Could not load prompt suggestions:", error);
      return [];
    })
    .then((customs) => {
      if (!card.isConnected) return;
      const defaults = getDefaultPrompts().filter(
        (p) => p.id !== "default-insert-note",
      );
      const shown = customs.slice(0, 4);
      while (shown.length < 4 && defaults.length > 0) {
        const d = defaults.shift()!;
        if (!shown.some((p) => p.id === d.id)) shown.push(d);
      }
      for (const p of shown) {
        const button = createEl(
          doc,
          "button",
          "claudero-suggestion prompt-card",
        );
        const icon = createEl(doc, "span", "claudero-prompt-icon-wrap");
        renderPromptIcon(doc, p.icon, icon);
        // Tint the wrap with the icon's own color (mirrors the Prompt Library)
        const iconColor =
          p.icon?.type === "iconify" ? p.icon.color || "#55534f" : "#55534f";
        icon.style.backgroundColor = `color-mix(in srgb, ${iconColor} 12%, transparent)`;
        const body = createEl(doc, "span", "claudero-prompt-copy");
        const name = createEl(doc, "span", "claudero-prompt-title");
        const sub = createEl(doc, "span", "claudero-prompt-desc");
        name.textContent = p.label;
        sub.textContent = p.description || getString("prompt-custom");
        body.append(name, sub);
        button.append(icon, body);
        button.addEventListener("click", () => void sendPrompt(state, p.text));
        // Hover tint derived from the icon color, matching the Prompt Library rows.
        button.addEventListener("mouseenter", () => {
          button.style.backgroundColor = `color-mix(in srgb, ${iconColor} 8%, var(--material-mix-quinary))`;
        });
        button.addEventListener("mouseleave", () => {
          button.style.backgroundColor = "";
        });
        suggestions.appendChild(button);
      }
    });
}

// ── Cancel / Stop ──────────────────────────────────────────────────────────

async function cancelPermissionRequest(state: PaneState): Promise<void> {
  const ownerRequestId = state.activeRequestId;
  if (!ownerRequestId) return;
  try {
    await cancelHelperRequest(ownerRequestId);
  } catch (e) {
    ztoolkit.log("[Claudero] Failed to cancel request:", e);
  }
}

function cancel(state: PaneState): void {
  state.cancelRequested = true;
  stopThinkingAnimation(state);
  hidePermissionDialog(state);
  hideQuestionDialog(state);
  stopInteractionPolling(state);
  if (state.requestController) state.requestController.abort();
  void cancelPermissionRequest(state);
}

async function insertAssistantNote(state: PaneState): Promise<void> {
  updateContext(state);
  const item = state.currentItem;
  const text = state.lastAssistantText.trim();
  if (!item) {
    appendNoticeCard(
      state,
      "info",
      getString("pane-no-item"),
      getString("pane-select-item"),
    );
    return;
  }
  if (!text) {
    appendNoticeCard(
      state,
      "info",
      getString("pane-no-response"),
      getString("pane-ask-before-note"),
    );
    return;
  }

  const safe = Zotero.Utilities.htmlSpecialChars(text).replace(/\n/g, "<br/>");
  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  note.parentID = item.id;
  note.setNote(`<h2>Claudero</h2><div>${safe}</div>`);
  await note.saveTx();
  appendNoticeCard(
    state,
    "success",
    getString("pane-inserted-note"),
    getString("pane-inserted-note-description"),
  );
}

// ── Panel construction ─────────────────────────────────────────────────────

function setToolbarChecked(win: Window, checked: boolean): void {
  const button = win.document.getElementById(TOOLBAR_BUTTON_ID);
  if (!button) return;
  button.setAttribute("checked", checked ? "true" : "false");
}

function hideClauderoPanel(win: Window): void {
  const doc = win.document;
  const host = doc.getElementById(PANEL_ID) as HTMLElement | null;
  const state = host ? paneStates.get(host) : undefined;
  if (state) {
    if (state.running) cancel(state);
    // Record and enqueue the partial turn before a reopened pane reads history.
    if (state.finalizeRequest) state.finalizeRequest();
    else void saveConversation(state);
    state.disposed = true;
    state.modelCatalog?.dispose();
    cancelImageReads(state);
    state.disposeComposer();
    closeContextDetailPopup(doc);
    stopInteractionPolling(state);
    stopThinkingAnimation(state);
    finalizeThinkingCard(state);
    hidePermissionDialog(state);
    hideQuestionDialog(state);
    if (state.providerPrefObserverID) {
      Zotero.Prefs.unregisterObserver(state.providerPrefObserverID);
      state.providerPrefObserverID = null;
    }
    paneStates.delete(host!);
  }
  host?.remove();
  doc.getElementById(SPLITTER_ID)?.remove();
  setToolbarChecked(win, false);
}

function createHeader(
  doc: Document,
  onClose: () => void,
  onNewChat: () => void,
  onHistory: () => void,
): { element: HTMLElement; statusDot: HTMLElement } {
  const header = createEl(doc, "header", "claudero-header");
  const brand = createEl(doc, "div", "claudero-brand");
  const icon = createEl(doc, "img", "claudero-logo");
  const title = createEl(doc, "strong");
  const statusDot = createEl(doc, "span", "claudero-status-dot");
  const tools = createEl(doc, "div", "claudero-header-tools");

  icon.setAttribute(
    "src",
    `chrome://${addon.data.config.addonRef}/content/icons/claudero.svg`,
  );
  icon.setAttribute("width", "20");
  icon.setAttribute("height", "20");
  icon.setAttribute(
    "style",
    "width:20px;height:20px;max-width:20px;max-height:20px;display:block;",
  );
  title.textContent = "Claudero";
  statusDot.setAttribute("title", getString("pane-ready"));
  statusDot.setAttribute("aria-label", getString("pane-ready"));
  const chevron = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.setAttribute("width", "10");
  chevron.setAttribute("height", "10");
  chevron.setAttribute("fill", "none");
  chevron.setAttribute("stroke", "currentColor");
  chevron.setAttribute("stroke-width", "2.5");
  chevron.setAttribute("stroke-linecap", "round");
  chevron.setAttribute("stroke-linejoin", "round");
  chevron.setAttribute("class", "chevron");
  const chevronPath = doc.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline",
  );
  chevronPath.setAttribute("points", "6 9 12 15 18 9");
  brand.append(icon, title, statusDot);

  // New conversation button — use toolbarbutton to match Zotero style
  const createToolbarBtn = (
    tooltip: string,
    onCommand: () => void,
  ): HTMLElement =>
    createToolbarLikeButton(doc, "claudero-header-action", tooltip, onCommand);

  const newChatBtn = createToolbarBtn(
    getString("toolbar-new-conversation"),
    onNewChat,
  );
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "currentColor");
  const newChatPath = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  newChatPath.setAttribute(
    "d",
    "M501.333333 181.333333v64h-298.666666A10.666667 10.666667 0 0 0 192 256v530.730667l149.674667-119.722667a74.666667 74.666667 0 0 1 39.381333-16l7.253333-0.341333h411.690667A10.666667 10.666667 0 0 0 810.666667 640v-128h64v128a74.666667 74.666667 0 0 1-74.666667 74.666667H388.266667a10.666667 10.666667 0 0 0-6.613334 2.346666l-197.376 157.866667A34.645333 34.645333 0 0 1 128 847.829333V256c0-41.216 33.450667-74.666667 74.666667-74.666667h298.666666zM821.333333 42.666667v159.957333L981.333333 202.666667v64l-160-0.042667V426.666667h-64V266.624L597.333333 266.666667v-64l160-0.042667V42.666667h64z",
  );
  svg.appendChild(newChatPath);
  newChatBtn.appendChild(svg);

  // History button — reopen a previous conversation
  const historyBtn = createToolbarBtn(getString("toolbar-history"), onHistory);
  const histSvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  histSvg.setAttribute("viewBox", "0 0 24 24");
  histSvg.setAttribute("width", "16");
  histSvg.setAttribute("height", "16");
  histSvg.setAttribute("fill", "none");
  histSvg.setAttribute("stroke", "currentColor");
  histSvg.setAttribute("stroke-width", "1.5");
  histSvg.setAttribute("stroke-linecap", "round");
  histSvg.setAttribute("stroke-linejoin", "round");
  const histPath1 = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  histPath1.setAttribute("d", "M3 3v5h5");
  const histPath2 = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  histPath2.setAttribute("d", "M3.05 13A9 9 0 1 0 6 5.3L3 8");
  const histPath3 = doc.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline",
  );
  histPath3.setAttribute("points", "12 7 12 12 15 14");
  histSvg.append(histPath1, histPath2, histPath3);
  historyBtn.appendChild(histSvg);

  // Close button
  const closeBtn = createToolbarBtn(getString("toolbar-hide"), onClose);
  const closeSvg = doc.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  ) as SVGSVGElement;
  closeSvg.setAttribute("viewBox", "0 0 24 24");
  closeSvg.setAttribute("width", "14");
  closeSvg.setAttribute("height", "14");
  closeSvg.setAttribute("fill", "none");
  closeSvg.setAttribute("stroke", "currentColor");
  closeSvg.setAttribute("stroke-width", "1.5");
  closeSvg.setAttribute("stroke-linecap", "round");
  const closeL1 = doc.createElementNS("http://www.w3.org/2000/svg", "line");
  closeL1.setAttribute("x1", "18");
  closeL1.setAttribute("y1", "6");
  closeL1.setAttribute("x2", "6");
  closeL1.setAttribute("y2", "18");
  const closeL2 = doc.createElementNS("http://www.w3.org/2000/svg", "line");
  closeL2.setAttribute("x1", "6");
  closeL2.setAttribute("y1", "6");
  closeL2.setAttribute("x2", "18");
  closeL2.setAttribute("y2", "18");
  closeSvg.append(closeL1, closeL2);
  closeBtn.appendChild(closeSvg);

  tools.append(historyBtn, newChatBtn, closeBtn);
  header.append(brand, tools);
  return { element: header, statusDot };
}

async function chooseConversationExportPath(
  doc: Document,
  title: string,
): Promise<string | null> {
  const picker = (Components.classes as any)[
    "@mozilla.org/filepicker;1"
  ].createInstance(Components.interfaces.nsIFilePicker) as nsIFilePicker;
  const win = doc.defaultView;
  if (!win?.browsingContext) return null;
  picker.init(win.browsingContext, "Export conversation", picker.modeSave!);
  picker.defaultString = `${
    title
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "claudero-conversation"
  }.json`;
  picker.defaultExtension = "json";
  picker.appendFilter("JSON", "*.json");
  const result = await new Promise<nsIFilePicker.ResultCode>((resolve) => {
    picker.open({ done: resolve });
  });
  return result === picker.returnCancel ? null : picker.file.path;
}

function showHistoryPopup(state: PaneState): void {
  showConversationHistoryPopup(state, {
    onRestore: (conv) => restoreConversation(state, conv),
    onDelete: (conv) => deleteConversationFromHistory(state, conv),
    onExport: async (conv) => {
      const destinationPath = await chooseConversationExportPath(
        state.root.ownerDocument!,
        conv.title,
      );
      if (!destinationPath) return;
      await exportConversationToFile(conv.id, destinationPath);
    },
    onDeleteAll: async () => {
      await deleteAllConversations();
      clearConversationState(state);
      renderPendingImages(state);
      appendWelcomeCard(state);
      setStatusDot(state, "ready");
    },
    onAutoRename: async (conv) => {
      const conversation = await loadConversationById(conv.id);
      if (!conversation)
        throw new Error(getString("history-conversation-missing"));
      const latestTitle = await getConversationTitle(conv.id);
      if (latestTitle && latestTitle !== conv.title) {
        ztoolkit.log(
          `[AI Rename] refreshing stale history title id=${conv.id} ui=${JSON.stringify(conv.title)} disk=${JSON.stringify(latestTitle)}`,
        );
        conv.title = latestTitle;
      }
      const firstUser =
        conversation.turns.find((t) => t.role === "user" && t.text.trim())
          ?.text ||
        conv.title ||
        "";
      const firstAssistant =
        conversation.turns.find((t) => t.role === "assistant" && t.text.trim())
          ?.text || "";
      return generateConversationTitle(
        conv.id,
        firstUser,
        firstAssistant,
        latestTitle || conv.title,
      );
    },
  });
}

async function deleteConversationFromHistory(
  state: PaneState,
  conv: ConversationIndexEntry,
): Promise<void> {
  await deleteConversation(conv.id);
  // If we just deleted the conversation that's currently open, start a fresh
  // one. Skip saveConversation here — re-saving would resurrect the deleted file.
  if (state.conversationId === conv.id) {
    clearConversationState(state);
    renderPendingImages(state);
    appendWelcomeCard(state);
    setStatusDot(state, "ready");
  }
}

async function refinePromptWithClaude(
  input: {
    label: string;
    description: string;
    text: string;
  },
  signal?: AbortSignal,
): Promise<Partial<Pick<CustomPrompt, "label" | "description" | "text">>> {
  const systemPrompt = [
    "You refine reusable prompts for an academic Zotero assistant named Claudero.",
    "Improve clarity, specificity, and reliability without making the prompt verbose.",
    "Return ONLY compact JSON with keys: label, description, text.",
    "Keep label short. Keep description under 90 characters. Preserve the user's intent.",
  ].join("\n");
  const raw = await runAuxClaudeQuery(JSON.stringify(input, null, 2), {
    signal,
    systemPrompt,
    model: String(
      defaultModelForProvider(normalizeProvider(getPref("provider"))),
    ),
    effort: "low",
  });
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<
      Pick<CustomPrompt, "label" | "description" | "text">
    >;
    return {
      label: typeof parsed.label === "string" ? parsed.label : input.label,
      description:
        typeof parsed.description === "string"
          ? parsed.description
          : input.description,
      text: typeof parsed.text === "string" ? parsed.text : input.text,
    };
  } catch {
    return { text: cleaned || input.text };
  }
}

async function generateConversationTitle(
  conversationId: string,
  firstUserText: string,
  firstAssistantText: string,
  expectedTitle?: string,
): Promise<string | null> {
  const requestId = `title-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  ztoolkit.log(
    `[AI Rename] ${requestId} start conversationId=${conversationId} expectedTitle=${JSON.stringify(expectedTitle ?? null)} userChars=${firstUserText.length} assistantChars=${firstAssistantText.length}`,
  );
  const systemPrompt = [
    "Generate a concise title that captures the main topic or goal of this Zotero research conversation.",
    "Return only the title, with no quotes, JSON, explanation, or markdown.",
    "Use the same language as the user's request when possible.",
    "Use 3-7 English words or no more than 18 Chinese characters.",
    "Avoid vague titles such as Research discussion or Paper analysis.",
  ].join("\n");
  // Claude Code titles the session from the first real user message. Use the
  // answer only as a fallback for image-only/synthetic first turns.
  const description = (firstUserText.trim() || firstAssistantText.trim()).slice(
    -1000,
  );
  const titlePrompt = [
    "Create a title for the conversation below.",
    "Reply with the title only.",
    "",
    description,
  ].join("\n");
  const win = Zotero.getMainWindow();
  const controller = new win.AbortController();
  // Auxiliary queries launch a separate provider process. A cold launch can
  // take around 20 seconds even though the model call is tiny.
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    ztoolkit.log(`[AI Rename] ${requestId} calling auxiliary query`);
    const raw = await runAuxClaudeQuery(titlePrompt, {
      systemPrompt,
      model: String(
        defaultModelForProvider(normalizeProvider(getPref("provider"))),
      ),
      effort: "low",
      signal: controller.signal,
    });
    ztoolkit.log(
      `[AI Rename] ${requestId} auxiliary query returned elapsedMs=${Date.now() - startedAt} rawChars=${raw.length}`,
    );
    let candidate = raw;
    try {
      const parsed = JSON.parse(raw) as { title?: unknown };
      if (typeof parsed.title === "string") candidate = parsed.title;
    } catch {
      // Older Claude Code versions may not support structured output.
    }
    const title = candidate
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!title) return null;
    ztoolkit.log(
      `[AI Rename] ${requestId} parsed title=${JSON.stringify(title)}`,
    );
    const persisted = await renameConversation(conversationId, title, {
      source: "ai",
      expectedTitle,
      onlyIfNoUserTitle: expectedTitle === undefined,
    });
    ztoolkit.log(
      `[AI Rename] ${requestId} persist result=${persisted} elapsedMs=${Date.now() - startedAt}`,
    );
    return persisted ? title : null;
  } catch (error) {
    // Title generation is a convenience, never block chat.
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}${error.stack ? ` | ${error.stack.replace(/\s+/g, " ").slice(0, 1400)}` : ""}`
        : String(error);
    ztoolkit.log(
      `[AI Rename] ${requestId} failed elapsedMs=${Date.now() - startedAt}: ${detail}`,
    );
    if (expectedTitle !== undefined) throw error;
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function showMagicPopup(state: PaneState, anchor: HTMLElement): void {
  showPromptPopup(state, anchor, {
    onPrompt: (prompt) => void sendPrompt(state, prompt),
    onInsertNote: () => void insertAssistantNote(state),
    onRefinePrompt: refinePromptWithClaude,
  });
}

function showItemPicker(state: PaneState): void {
  const io = {
    singleSelection: false,
    itemTreeID: "ai-columns-select-item-dialog",
  } as any;
  Zotero.getMainWindow().openDialog(
    "chrome://zotero/content/selectItemsDialog.xhtml",
    "",
    "chrome,modal",
    io,
  );
  if (!io.dataOut || !io.dataOut.length) return;
  const ids: number[] = io.dataOut;
  void (async () => {
    for (const id of ids) {
      const item = (await Zotero.Items.getAsync(id)) as Zotero.Item;
      const top = item.isTopLevelItem() ? item : item.topLevelItem;
      if (
        top &&
        top.isRegularItem() &&
        !state.manualItems.find((i) => i.id === top.id)
      ) {
        state.manualItems.push(top);
      }
    }
    if (state.manualItems.length > 0) {
      state.input.disabled = false;
      state.sendButton.disabled = false;
      state.contextChips.style.display = "flex";
    }
    rebuildManualChips(state);
  })();
}

// ── Slash commands ─────────────────────────────────────────────────────────

// Returns the filter word if the entire input value is "/word" (or just "/"),
// otherwise null (so mid-sentence slashes are ignored).
function getSlashQuery(input: HTMLTextAreaElement): string | null {
  // Command names may contain "-" (e.g. /release-notes) and ":" (namespaced).
  const match = input.value.match(/^\/([\w:-]*)$/);
  return match ? (match[1] ?? "") : null;
}

function selectSlashCmd(state: PaneState, cmd: SlashCommand): void {
  state.root.querySelector(".claudero-slash-popup")?.remove();
  if (cmd.isBuiltin) {
    state.input.value = "";
    if (cmd.name === "clear") startNewConversation(state);
    return;
  }
  // Fill the input with /cmdname + space — user adds arguments then presses Enter.
  // Never send SDK commands directly (matches Obsidian claudian behavior).
  state.input.value = `/${cmd.name} `;
  state.input.focus();
  state.input.selectionStart = state.input.selectionEnd =
    state.input.value.length;
}

function renderSlashPopup(
  state: PaneState,
  allCmds: SlashCommand[],
  query: string,
  existing:
    | (HTMLElement & { __filtered?: SlashCommand[]; __selectedIdx?: number })
    | null,
): void {
  const q = query.toLowerCase();
  const filtered = q
    ? allCmds.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.description.toLowerCase().includes(q),
      )
    : allCmds;

  const doc = state.root.ownerDocument!;

  if (filtered.length === 0) {
    existing?.remove();
    return;
  }

  let selectedIdx = existing?.__selectedIdx ?? 0;
  if (selectedIdx >= filtered.length) selectedIdx = 0;

  let popup: HTMLElement & {
    __filtered?: SlashCommand[];
    __selectedIdx?: number;
  };

  if (existing) {
    popup = existing;
  } else {
    popup = createEl(doc, "div", "claudero-slash-popup") as typeof popup;
    const composerEl = state.root.querySelector(
      ".claudero-composer",
    ) as HTMLElement | null;
    const panelRect = state.root.getBoundingClientRect();
    if (composerEl && panelRect) {
      const composerRect = composerEl.getBoundingClientRect();
      popup.style.bottom = `${panelRect.bottom - composerRect.top + 8}px`;
      popup.style.left = "12px";
      popup.style.right = "12px";
    }
    state.root.style.position = "relative";
    state.root.appendChild(popup);

    const onOutside = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) {
        popup.remove();
        doc.removeEventListener("mousedown", onOutside, true);
      }
    };
    doc.addEventListener("mousedown", onOutside, true);
    onElementRemoved(popup, () =>
      doc.removeEventListener("mousedown", onOutside, true),
    );
  }

  popup.__filtered = filtered;
  popup.__selectedIdx = selectedIdx;

  popup.textContent = "";
  filtered.forEach((cmd, i) => {
    const row = createEl(doc, "div", "claudero-slash-row");
    if (i === selectedIdx) row.classList.add("selected");
    const name = createEl(doc, "span", "claudero-slash-name");
    name.textContent = `/${cmd.name}`;
    const desc = createEl(doc, "span", "claudero-slash-desc");
    desc.textContent = cmd.description;
    row.append(name, desc);
    row.addEventListener("mouseenter", () => {
      popup.__selectedIdx = i;
      popup
        .querySelectorAll(".claudero-slash-row")
        .forEach((r, j) => r.classList.toggle("selected", j === i));
    });
    row.addEventListener("click", () => selectSlashCmd(state, cmd));
    popup.appendChild(row);
  });
}

function updateSlashPopup(state: PaneState): void {
  const query = getSlashQuery(state.input);
  const existing = state.root.querySelector(".claudero-slash-popup") as
    | (HTMLElement & {
        __filtered?: SlashCommand[];
        __selectedIdx?: number;
      })
    | null;

  if (query === null) {
    existing?.remove();
    return;
  }

  // Use cached SDK commands if available, otherwise fetch them
  if (_sdkCommandsCache !== null) {
    const allCmds = [...builtinSlashCommands(), ..._sdkCommandsCache];
    renderSlashPopup(state, allCmds, query, existing);
    return;
  }

  // Show built-ins immediately while SDK commands load
  renderSlashPopup(state, builtinSlashCommands(), query, existing);

  if (!_sdkCommandsFetching) {
    _sdkCommandsFetching = true;
    void fetchSlashCommands()
      .then((sdkCmds) => {
        // Only cache if we got real results; empty means session not ready → retry next time
        if (sdkCmds.length > 0) {
          _sdkCommandsCache = sdkCmds.map((c) => ({
            name: c.name,
            description: c.description,
            isBuiltin: false,
            argumentHint: c.argumentHint,
          }));
        }
        if (state.disposed) return;
        // Re-render with full command list if popup is still open
        const currentQuery = getSlashQuery(state.input);
        if (currentQuery !== null) {
          const currentPopup = state.root.querySelector(
            ".claudero-slash-popup",
          ) as
            | (HTMLElement & {
                __filtered?: SlashCommand[];
                __selectedIdx?: number;
              })
            | null;
          // The cache stays null when the session is not ready yet.
          const allCmds = [
            ...builtinSlashCommands(),
            ...(_sdkCommandsCache ?? []),
          ];
          renderSlashPopup(state, allCmds, currentQuery, currentPopup);
        }
      })
      .finally(() => {
        _sdkCommandsFetching = false;
      });
  }
}

function showItemPickerPopup(state: PaneState): void {
  // Close existing popup
  const existing = state.root.querySelector(".claudero-at-popup");
  if (existing) {
    existing.remove();
    return;
  }

  const doc = state.root.ownerDocument!;
  const win = doc.defaultView || window;
  const popup = createEl(doc, "div", "claudero-at-popup");

  // Search/From Library row
  const searchRow = createEl(doc, "div", "claudero-at-search-row");
  const searchInput = createEl(doc, "span", "claudero-at-search");
  searchInput.textContent = getString("pane-from-library");
  searchRow.appendChild(searchInput);
  popup.appendChild(searchRow);

  searchRow.addEventListener("click", () => {
    popup.remove();
    // Defer to avoid blocking any ongoing event
    (win as Window).setTimeout(() => showItemPicker(state), 0);
  });

  // Section header for open PDFs
  const section = createEl(doc, "div", "claudero-at-section");
  section.textContent = getString("pane-open-pdfs");
  popup.appendChild(section);

  const scroll = createEl(doc, "div", "claudero-at-scroll");

  // Get all open reader tabs from Zotero_Tabs._tabs
  // type is "reader" or "reader-unloaded"; data.itemID is the attachment ID
  const mainWin = Zotero.getMainWindow() as any;
  const readerTabs: Array<{ tabID: string; title: string; itemID?: number }> =
    [];

  const zoteroTabs = mainWin.Zotero_Tabs;
  if (zoteroTabs && Array.isArray(zoteroTabs._tabs)) {
    for (const tab of zoteroTabs._tabs) {
      if (
        tab.type &&
        tab.type.startsWith("reader") &&
        tab.data &&
        tab.data.itemID
      ) {
        readerTabs.push({
          tabID: tab.id,
          title: tab.title || "Untitled",
          itemID: tab.data.itemID,
        });
      }
    }
  }

  const ADD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>`;
  const REM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="6" x2="10" y2="6"/></svg>`;

  const addedParentIDs = new Set(state.manualItems.map((i) => i.id));

  for (const rTab of readerTabs) {
    // Resolve attachment itemID to its top-level parent
    let parentItem: Zotero.Item | null = null;
    if (rTab.itemID) {
      const attItem = Zotero.Items.get(rTab.itemID) as Zotero.Item;
      parentItem = attItem?.topLevelItem || attItem;
    }
    const parentID = parentItem?.id;
    const isAdded = parentID ? addedParentIDs.has(parentID) : false;

    const row = createEl(doc, "div", "claudero-at-row");
    if (parentItem) {
      row.appendChild(mkItemIconEl(doc, parentItem));
    }
    const title = createEl(doc, "span", "claudero-at-title");
    title.textContent = rTab.title.slice(0, 50);

    const actionBtn = createEl(doc, "button", "claudero-at-action");
    actionBtn.setAttribute("tabindex", "-1");
    actionBtn.innerHTML = isAdded ? REM_SVG : ADD_SVG;
    actionBtn.title = isAdded
      ? getString("pane-remove-context")
      : getString("pane-add-context");
    actionBtn.addEventListener("mousedown", (e) => e.preventDefault());
    actionBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isAdded) {
        // Remove
        if (parentID) {
          state.manualItems = state.manualItems.filter(
            (i) => i.id !== parentID,
          );
          rebuildManualChips(state);
          const hasCtx =
            state.currentItems.length > 0 ||
            (!!state.readerFilePath && !state.dismissedReader) ||
            (!!state.selectedText && !state.dismissedText) ||
            state.selectedAnnotations.length > 0 ||
            state.manualItems.length > 0;
          state.contextChips.style.display = hasCtx ? "flex" : "none";
          // Context is optional; the composer stays usable without it.
          state.input.disabled = false;
          state.sendButton.disabled = false;
        }
      } else {
        // Add
        if (
          parentItem &&
          parentItem.isRegularItem &&
          parentItem.isRegularItem() &&
          !state.manualItems.find((i) => i.id === parentItem!.id)
        ) {
          state.manualItems.push(parentItem);
          state.input.disabled = false;
          state.sendButton.disabled = false;
          state.contextChips.style.display = "flex";
          rebuildManualChips(state);
        }
      }
      popup.remove();
    });

    row.append(title, actionBtn);
    scroll.appendChild(row);
  }

  if (readerTabs.length === 0) {
    const empty = createEl(doc, "div", "claudero-at-empty");
    empty.textContent = getString("pane-no-open-pdfs");
    scroll.appendChild(empty);
  }

  popup.appendChild(scroll);

  // Position above composer
  const composerRect = state.root
    .querySelector(".claudero-composer")
    ?.getBoundingClientRect();
  const panelRect = state.root.getBoundingClientRect();
  if (composerRect && panelRect) {
    popup.style.position = "absolute";
    popup.style.bottom = `${panelRect.bottom - composerRect.top + 8}px`;
    popup.style.left = "12px";
    popup.style.right = "12px";
  }

  state.root.style.position = "relative";
  state.root.appendChild(popup);
  state.pickerEl = popup;

  const onOutside = (e: Event) => {
    if (!popup.contains(e.target as Node)) {
      popup.remove();
      state.pickerEl = null;
      doc.removeEventListener("mousedown", onOutside, true);
    }
  };
  doc.addEventListener("mousedown", onOutside, true);
  onElementRemoved(popup, () =>
    doc.removeEventListener("mousedown", onOutside, true),
  );
}

function hideItemPicker(state: PaneState): void {
  state.pickerEl?.remove();
  state.pickerEl = null;
}

function setPaneProvider(state: PaneState, value: string): void {
  if (state.running) return;
  const provider = normalizeProvider(value);
  state.providerSelect.value = provider;
  setPref("provider", provider);
  const model = defaultModelForProvider(provider);
  const effort = defaultEffortForProvider(provider);
  state.modelSelect.setItems?.(modelOptionsForProvider(provider), model);
  state.effortSelect.setItems?.(effortOptionsForProvider(provider), effort);
  state.permissionSelect.setItems?.(
    permissionOptionsForProvider(provider),
    state.permissionMode,
  );
  setPref("model", model);
  setPref("effort", effort);
  _sdkCommandsCache = null;
  updatePermissionBadge(state);
  setStatusDot(state, "ready");
  void refreshProviderModels(state, provider);
}

function setPanePermissionMode(
  state: PaneState,
  mode: PaneState["permissionMode"],
): void {
  if (state.running) return;
  state.permissionMode = mode;
  setPref("permissionMode", mode);
  updatePermissionBadge(state);
}

function createComposer(doc: Document) {
  const provider = normalizeProvider(getPref("provider"));
  let stateRef: PaneState | null = null;
  const view = createComposerView<PaneState>(doc, {
    providerOptions: PROVIDER_OPTIONS,
    modelOptions: modelOptionsForProvider(provider),
    effortOptions: effortOptionsForProvider(provider),
    permissionOptions: permissionOptionsForProvider(provider),
    defaultProvider: provider,
    defaultModel: defaultModelForProvider(provider),
    defaultEffort: defaultEffortForProvider(provider),
    defaultPermission: normalizePermissionMode(getPref("permissionMode")),
    onProviderChange: (value) => {
      if (stateRef) setPaneProvider(stateRef, value);
    },
    onModelChange: (value) => {
      if (!stateRef || stateRef.running) return;
      const active = normalizeProvider(stateRef.providerSelect.value);
      setPref(
        active === "codex"
          ? "codexModel"
          : active === "deepseek"
            ? "deepseekModel"
            : "claudeModel",
        value,
      );
      setPref("model", value);
      applyModelEfforts(stateRef, value);
    },
    onEffortChange: (value) => {
      if (!stateRef || stateRef.running) return;
      const active = normalizeProvider(stateRef.providerSelect.value);
      setPref(
        active === "codex"
          ? "codexEffort"
          : active === "deepseek"
            ? "deepseekEffort"
            : "claudeEffort",
        value,
      );
      setPref("effort", value);
    },
    onPermissionChange: (value) => {
      if (stateRef) {
        setPanePermissionMode(stateRef, normalizePermissionMode(value));
      }
    },
    onAtClick: (state) => showItemPickerPopup(state),
    onMagicClick: (state, anchor) => showMagicPopup(state, anchor),
    onInputChanged: (state) => updateSlashPopup(state),
    onAtTyped: (state) => {
      Zotero.getMainWindow().setTimeout(() => showItemPickerPopup(state), 0);
    },
    onPasteImages: (state, files) => void addPastedImageFiles(state, files),
  });
  return {
    ...view,
    dispose: () => {
      stateRef = null;
      view.dispose();
    },
    setStateRef: (state: PaneState) => {
      stateRef = state;
      view.setStateRef(state);
    },
  };
}

function buildPanel(doc: Document, win: Window): HTMLElement {
  const host = createPanelHost(doc);
  const root = createEl(doc, "div", "claudero-pane");
  const transcript = createEl(doc, "main", "claudero-transcript");
  // Focusable so clicking the transcript "focuses the sidebar" — the
  // Cmd/Ctrl+-/=/0 font-zoom shortcut only fires while focus is in the pane.
  transcript.setAttribute("tabindex", "-1");
  // Wrapper provides the positioned context for the scroll-to-bottom overlay
  const transcriptWrapper = createEl(doc, "div", "claudero-transcript-wrapper");
  transcriptWrapper.appendChild(transcript);
  const composer = createComposer(doc);
  const { element: headerEl, statusDot } = createHeader(
    doc,
    () => hideClauderoPanel(win),
    () => startNewConversation(state),
    () => showHistoryPopup(state),
  );

  root.append(headerEl, transcriptWrapper, composer.element);
  host.appendChild(root);

  const state: PaneState = {
    root,
    transcript,
    input: composer.input,
    sendButton: composer.sendButton,
    disposeComposer: composer.dispose,
    providerSelect: composer.providerSelect,
    modelSelect: composer.modelSelect,
    effortSelect: composer.effortSelect,
    codexModels: [],
    contextChips: composer.contextChips,
    itemChip: composer.itemChip,
    readerChip: composer.readerChip,
    textChip: composer.textChip,
    annotationChip: composer.annotationChip,
    statusDot,
    permissionSelect: composer.permissionSelect,
    customPromptsBar: createEl(doc, "span"),
    currentAssistantBody: null,
    currentAssistantCard: null,
    currentItem: null,
    currentItems: [],
    readerFilePath: "",
    selectedText: "",
    selectedAnnotations: [],
    dismissedReader: false,
    dismissedText: false,
    dismissedAnnotations: false,
    manualItems: [],
    pickerEl: null,
    toolCards: new Map(),
    lastAssistantText: "",
    currentSegmentText: "",
    lastStreamingRenderTs: 0,
    thinkingEl: null,
    thinkingMetaEl: null,
    thinkingWordEl: null,
    thinkingTimer: null,
    thinkingTs: 0,
    turnStartedTs: 0,
    turnOutputTokens: 0,
    turnResponseChars: 0,
    thinkingTokenEstimate: 0,
    thinkingVerb: "",
    activityMode: "responding",
    activityMessage: "",
    activityStartedTs: 0,
    recentThoughtDurationMs: 0,
    recentThoughtUntil: 0,
    thinkingCard: null,
    pendingImages: [],
    pendingImagesBar: null,
    conversationId: newConversationId(),
    conversationTurns: [],
    providerState: undefined,
    parentConversationId: undefined,
    forkedAtTurnIndex: undefined,
    compactedAt: undefined,
    currentProviderTurnId: undefined,
    currentAssistantBlocks: [],
    currentContextSnapshot: null,
    running: false,
    cancelRequested: false,
    permissionMode: normalizePermissionMode(getPref("permissionMode")),
    permissionDialog: null,
    questionDialog: null,
    permissionCheckTimer: null,
    questionPollingUnsupported: false,
    lastContextSignature: "",
    _savedComposerChildren: null,
    scrollToBottomBtn: null,
    inputHistory: [],
    inputHistoryIdx: -1,
    _inputHistorySavedText: "",
    _inputHistorySavedImages: [],
    _suppressText: 0,
    _activeSkillToolId: null,
    providerPrefObserverID: null,
  };
  paneStates.set(host, state);
  composer.setStateRef(state);

  // Scroll-to-bottom button — appears when user scrolls up during streaming
  const scrollToBottomBtn = createEl(
    doc,
    "button",
    "claudero-scroll-to-bottom",
  );
  scrollToBottomBtn.setAttribute("title", getString("composer-scroll-bottom"));
  // Use flipped send arrow icon
  scrollToBottomBtn.appendChild(createSendArrowSvgDown(doc));
  scrollToBottomBtn.style.display = "none";
  scrollToBottomBtn.addEventListener("click", () =>
    smoothScrollToBottom(state),
  );
  transcriptWrapper.appendChild(scrollToBottomBtn);
  state.scrollToBottomBtn = scrollToBottomBtn;
  transcript.addEventListener("scroll", () => updateScrollToBottomBtn(state));

  appendWelcomeCard(state);
  updateContext(state);
  updateSendButton(state, false);
  updatePermissionBadge(state);

  // Apply font scale from preference on mount
  applyFontScale(state, getFontScale());

  // ── Font zoom: Cmd/Ctrl + = (zoom in), - (zoom out), 0 (reset) ──────────
  // Standard browser-like zoom. Only fires when focus is inside the pane (input,
  // transcript, header — anywhere in the panel) and NOT interfered with by the
  // @ popup or permission dialogs.
  root.addEventListener("keydown", (event: KeyboardEvent) => {
    const meta = event.metaKey || event.ctrlKey;
    const key = (event as KeyboardEvent & { key: string }).key;
    // Cmd/Ctrl + = (unshifted '+') or Cmd/Ctrl + Shift+= (US keyboard '+')
    // Cmd/Ctrl + -
    // Cmd/Ctrl + 0
    const isZoom =
      meta && (key === "=" || key === "+" || key === "-" || key === "0");
    if (!isZoom) return;
    // Don't zoom when a modal or popup is visible
    if (state.permissionDialog?.isConnected) return;
    if (state.questionDialog?.isConnected) return;
    if (state.root.querySelector(".claudero-context-detail-popup")) return;

    event.preventDefault();
    event.stopPropagation();

    if (key === "=" || key === "+") {
      adjustFontScale(state, +FONT_SCALE_STEP);
    } else if (key === "-") {
      adjustFontScale(state, -FONT_SCALE_STEP);
    } else if (key === "0") {
      setFontScale(state, FONT_SCALE_DEFAULT);
    }
  });

  // Reopen the most recent conversation so history survives restarts. Replaces
  // the welcome card once loaded; if there is no history, the card stays.
  void restoreLatestConversation(state);

  const providerPrefObserverID = Zotero.Prefs.registerObserver(
    "extensions.zotero.claudero.provider",
    () =>
      setPaneProvider(
        state,
        String(getPref("provider") || state.providerSelect.value),
      ),
    true,
  );
  state.providerPrefObserverID = providerPrefObserverID;
  composer.input.addEventListener("keydown", (event: KeyboardEvent) => {
    // If @ item popup is open, intercept navigation keys
    const atPopup = state.root.querySelector(".claudero-at-popup") as
      | (HTMLElement & {
          __selectedIdx?: number;
        })
      | null;
    if (atPopup) {
      const rows = Array.from(
        atPopup.querySelectorAll(".claudero-at-row"),
      ) as HTMLElement[];
      const n = rows.length;
      if (event.key === "Escape") {
        event.preventDefault();
        atPopup.remove();
        state.pickerEl = null;
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && n > 0) {
        event.preventDefault();
        let idx = atPopup.__selectedIdx ?? -1;
        if (event.key === "ArrowDown") {
          idx = (idx + 1) % n;
        } else {
          idx = (idx - 1 + n) % n;
        }
        atPopup.__selectedIdx = idx;
        rows.forEach((r, i) => r.classList.toggle("selected", i === idx));
        (rows[idx] as HTMLElement | undefined)?.scrollIntoView({
          block: "nearest",
        });
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const idx = atPopup.__selectedIdx ?? -1;
        const row = rows[idx] as HTMLElement | undefined;
        if (idx >= 0 && row) {
          event.preventDefault();
          row.click();
          return;
        }
      }
    }

    // If slash command popup is open, intercept navigation keys
    const slashPopup = state.root.querySelector(".claudero-slash-popup") as
      | (HTMLElement & {
          __filtered?: SlashCommand[];
          __selectedIdx?: number;
        })
      | null;
    if (slashPopup) {
      const filtered = slashPopup.__filtered ?? [];
      let idx = slashPopup.__selectedIdx ?? 0;
      const rows = Array.from(
        slashPopup.querySelectorAll(".claudero-slash-row"),
      ) as HTMLElement[];
      if (event.key === "ArrowDown") {
        event.preventDefault();
        idx = (idx + 1) % filtered.length;
        slashPopup.__selectedIdx = idx;
        rows.forEach((r, i) => r.classList.toggle("selected", i === idx));
        (rows[idx] as HTMLElement | undefined)?.scrollIntoView({
          block: "nearest",
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        idx = (idx - 1 + filtered.length) % filtered.length;
        slashPopup.__selectedIdx = idx;
        rows.forEach((r, i) => r.classList.toggle("selected", i === idx));
        (rows[idx] as HTMLElement | undefined)?.scrollIntoView({
          block: "nearest",
        });
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const cmd = filtered[idx];
        if (cmd) {
          event.preventDefault();
          selectSlashCmd(state, cmd);
          return;
        }
      }
      if (event.key === "Escape") {
        slashPopup.remove();
        event.preventDefault();
        return;
      }
      if (event.key === "Tab") {
        const cmd = filtered[idx];
        if (cmd) {
          event.preventDefault();
          selectSlashCmd(state, cmd);
          return;
        }
      }
    }

    if (event.key === "Escape" && state.running) {
      event.preventDefault();
      cancel(state);
      return;
    }

    // Input history: ArrowUp cycles back (older), ArrowDown cycles forward (newer)
    if (
      event.key === "ArrowUp" &&
      !event.shiftKey &&
      state.inputHistory.length > 0
    ) {
      event.preventDefault();
      if (state.inputHistoryIdx === -1) {
        // Save current input before navigating history
        state._inputHistorySavedText = state.input.value;
        state._inputHistorySavedImages = state.pendingImages.slice();
        state.inputHistoryIdx = 0;
      } else if (state.inputHistoryIdx < state.inputHistory.length - 1) {
        state.inputHistoryIdx++;
      } else {
        return; // Already at oldest entry
      }
      const entry = state.inputHistory[state.inputHistoryIdx];
      state.input.value = entry.text;
      replaceImageDraft(
        state,
        entry.images.map((img) => ({ ...img })),
      );
      renderPendingImages(state);
      // Move cursor to end
      state.input.selectionStart = state.input.selectionEnd =
        state.input.value.length;
      return;
    }
    if (
      event.key === "ArrowDown" &&
      !event.shiftKey &&
      state.inputHistoryIdx >= 0
    ) {
      event.preventDefault();
      if (state.inputHistoryIdx === 0) {
        // Restore the saved input (or clear)
        state.input.value = state._inputHistorySavedText;
        replaceImageDraft(state, state._inputHistorySavedImages.slice());
        renderPendingImages(state);
        state.inputHistoryIdx = -1;
        state._inputHistorySavedText = "";
        state._inputHistorySavedImages = [];
      } else {
        state.inputHistoryIdx--;
        const entry = state.inputHistory[state.inputHistoryIdx];
        state.input.value = entry.text;
        replaceImageDraft(
          state,
          entry.images.map((img) => ({ ...img })),
        );
        renderPendingImages(state);
        state.input.selectionStart = state.input.selectionEnd =
          state.input.value.length;
      }
      return;
    }

    const isEnter = event.key === "Enter" || event.keyCode === 13;
    if (
      isEnter &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      if (!state.running) void sendPrompt(state);
    }
  });

  // Send button click: send or cancel
  composer.sendButton.addEventListener("click", () => {
    if (state.running) {
      cancel(state);
    } else {
      void sendPrompt(state);
    }
  });

  return host;
}

// ── Panel lifecycle ────────────────────────────────────────────────────────

function syncPanelPlacement(
  win: Window,
  createIfMissing = false,
): HTMLElement | null {
  const doc = win.document;
  const anchor = getMountAnchor(doc, win);
  if (!anchor?.parentElement) return null;

  let host = doc.getElementById(PANEL_ID) as HTMLElement | null;
  let splitter = doc.getElementById(SPLITTER_ID) as HTMLElement | null;
  if (!host) {
    if (!createIfMissing) return null;
    host = buildPanel(doc, win);
  }
  if (!splitter) {
    if (!createIfMissing) return host;
    splitter = createPanelSplitter(doc, anchor);
  }

  // Place [splitter][host] immediately *before* the anchor so the anchor stays
  // adjacent to the element it resizes. Final order (left → right) is:
  //   claudero-side-splitter, claudero-side-panel, <anchor>, <anchor's pane>
  // e.g. for the reader: …, claudero-splitter, claudero-panel,
  //   zotero-context-splitter, zotero-context-pane — so the context splitter
  //   keeps resizing the context pane instead of our panel.
  // Re-parenting the host (e.g. when a reader tab opens) resets the transcript's
  // scrollTop to 0, jumping the conversation to the first message. Capture the
  // scroll state first and restore it synchronously after the move so we stay
  // pinned to the bottom (or wherever the user was reading).
  const state = paneStates.get(host);
  const needsMove =
    host.parentElement !== anchor.parentElement ||
    anchor.previousElementSibling !== host;
  const prevScrollTop = state ? state.transcript.scrollTop : 0;
  const wasAtBottom = state ? isAtBottom(state) : false;

  if (needsMove) {
    anchor.parentElement.insertBefore(host, anchor);
  }
  if (
    splitter.parentElement !== host.parentElement ||
    host.previousElementSibling !== splitter
  ) {
    host.parentElement!.insertBefore(splitter, host);
  }

  if (state && needsMove) {
    state.transcript.scrollTop = wasAtBottom
      ? state.transcript.scrollHeight
      : prevScrollTop;
    updateScrollToBottomBtn(state);
  }

  if (state) updateContext(state);
  return host;
}

export function showClauderoPanel(win: _ZoteroTypes.MainWindow): void {
  const host = syncPanelPlacement(win, true);
  if (!host) {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("pane-attach-failed"),
        type: "fail",
      })
      .show();
    return;
  }
  const state = paneStates.get(host);
  if (state) {
    void refreshProviderModels(
      state,
      normalizeProvider(state.providerSelect.value),
    );
  }
  setToolbarChecked(win, true);
}

export function toggleClauderoPanel(win: _ZoteroTypes.MainWindow): void {
  const host = win.document.getElementById(PANEL_ID) as HTMLElement | null;
  if (host?.isConnected) {
    hideClauderoPanel(win);
    return;
  }
  showClauderoPanel(win);
}

export function registerClauderoPane(win: _ZoteroTypes.MainWindow): void {
  if (mountedWindows.has(win)) return;
  mountedWindows.add(win);

  // Refresh context on main-window interaction. Selecting items in the library
  // tree and switching tabs happen in the main window, so mouseup/keyup here is
  // enough — no constant polling for the common library-browsing case.
  const refreshContext = () => {
    const host = win.document.getElementById(PANEL_ID) as HTMLElement | null;
    if (!host?.isConnected) return;
    const state = paneStates.get(host);
    if (state) updateContext(state);
  };
  win.document.addEventListener("mouseup", refreshContext, true);
  win.document.addEventListener("keyup", refreshContext, true);

  const contextTimer = win.setInterval(() => {
    const host = win.document.getElementById(PANEL_ID) as HTMLElement | null;
    if (!host?.isConnected) return;
    // Re-anchor the panel if it drifted to a different parent (e.g. a tab switch).
    const anchor = getMountAnchor(win.document, win);
    if (
      anchor &&
      (host.parentElement !== anchor.parentElement ||
        anchor.previousElementSibling !== host)
    ) {
      syncPanelPlacement(win, false);
      return;
    }
    // Reader text/annotation selection happens inside the reader iframe, whose
    // events can't be safely hooked from chrome (cross-compartment). So only when
    // a reader tab is active do we poll the selection; the signature guard in
    // updateContext keeps this from churning the DOM.
    if (getSelectedTabType(win) === "reader") {
      const state = paneStates.get(host);
      if (state) updateContext(state);
    }
  }, 1000);
  const cleanup = () => {
    win.document.removeEventListener("mouseup", refreshContext, true);
    win.document.removeEventListener("keyup", refreshContext, true);
    win.clearInterval(contextTimer);
    hideClauderoPanel(win);
    win.document.getElementById(TOOLBAR_BUTTON_ID)?.remove();
    win.document.getElementById("claudero-stylesheet")?.remove();
    mountedWindows.delete(win);
    windowCleanupCallbacks.delete(win);
  };
  windowCleanupCallbacks.set(win, cleanup);
}

export function unregisterClauderoPane(win: Window): void {
  windowCleanupCallbacks.get(win)?.();
}

export function registerClauderoToolbarButton(
  win: _ZoteroTypes.MainWindow,
  attempt = 0,
): void {
  if (!addon.data.alive || win.closed) return;
  const doc = win.document;
  if (doc.getElementById(TOOLBAR_BUTTON_ID)) return;

  const syncButton = doc.getElementById("zotero-tb-sync");
  const parent = syncButton?.parentElement;
  if (!syncButton || !parent) {
    if (attempt < 20) {
      win.setTimeout(
        () => registerClauderoToolbarButton(win, attempt + 1),
        250,
      );
    }
    return;
  }

  const button =
    (
      doc as Document & {
        createXULElement?: (tag: string) => HTMLElement;
      }
    ).createXULElement?.("toolbarbutton") ?? doc.createElement("button");
  const isXULButton = button.localName === "toolbarbutton";
  button.id = TOOLBAR_BUTTON_ID;
  button.className = "zotero-tb-button claudero-toolbar-button";
  button.setAttribute("label", "Claudero");
  button.setAttribute("tooltiptext", getString("composer-show-hide"));
  button.setAttribute("type", "checkbox");
  button.setAttribute("tabindex", "-1");
  button.setAttribute(
    "image",
    `chrome://${addon.data.config.addonRef}/content/icons/claudero.svg`,
  );
  button.addEventListener("command", () => toggleClauderoPanel(win));
  if (!isXULButton) {
    button.addEventListener("click", () => toggleClauderoPanel(win));
  }
  parent.insertBefore(button, syncButton);
  registerClauderoPane(win);
}

export function registerClauderoStyles(win: _ZoteroTypes.MainWindow): void {
  const doc = win.document;
  if (doc.getElementById("claudero-stylesheet")) return;
  const styles = ztoolkit.UI.createElement(doc, "link", {
    properties: {
      id: "claudero-stylesheet",
      type: "text/css",
      rel: "stylesheet",
      href: `chrome://${addon.data.config.addonRef}/content/zoteroPane.css`,
    },
  });
  doc.documentElement?.appendChild(styles);
}

export function registerClauderoMenu(): void {
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "zotero-itemmenu-claudero-ask",
    label: getString("pane-ask-claudero"),
    commandListener: () => {
      const win = Zotero.getMainWindow();
      const item = getCurrentRegularItems(win)[0] ?? null;
      if (!item) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: getString("pane-select-item"), type: "fail" })
          .show();
        return;
      }
      showClauderoPanel(win);
    },
    icon: `chrome://${addon.data.config.addonRef}/content/icons/claudero.svg`,
  });
}

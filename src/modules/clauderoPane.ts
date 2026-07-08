import {
  fetchSlashCommands,
  isClaudeAuthError,
  isClaudeLimitError,
  queryClaudeHelper,
  reloadSlashCommands,
  runAuxClaudeQuery,
  runProviderAuthLogin,
} from "./claudeHelperClient";
import {
  getZoteroApiSystemPrompt,
  getZoteroEndpointBaseUrl,
} from "./zoteroEndpoint";
import {
  buildPromptWithZoteroContext,
  getCurrentReaderFilePath,
  getCurrentReaderItem,
  getSelectedReaderAnnotations,
  getSelectedReaderText,
  getSelectedZoteroContext,
  type ClauderoAnnotationContext,
  type ClauderoSelectionContext,
} from "./zoteroContext";
import { getPref, setPref } from "../utils/prefs";
import {
  newConversationId,
  type ConversationProviderState,
  type ConversationTurn,
  type ConversationBlock,
  type ConversationImage,
  type MessageRole,
  type SavedConversation,
  type CustomPrompt,
  loadCustomPrompts,
  getDefaultPrompts,
  getConversationTitle,
  renameConversation,
  deleteConversation,
} from "./conversationStore";
import {
  appendToolCard,
  appendToolResult,
  createToolIconSvg,
  getToolActivityDescription,
  type ToolCardState,
} from "./toolCallRenderer";
import {
  applyConversation,
  clearConversationState,
  loadLatestConversation,
  saveCurrentConversation,
} from "./conversationController";
import { applyProviderSessionEvent } from "./providerSessionState";
import { renderMarkdown } from "./messageRenderer";
import { renderPromptIcon } from "./iconPickerView";
import { showConversationHistoryPopup } from "./conversationHistoryView";
import { showPromptPopup } from "./promptPopupView";
import { createComposerView, type DivSelect } from "./composerView";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getProviderCapabilities,
  modelOptionsForProvider,
  normalizeProvider,
  providerLabel,
  PROVIDER_OPTIONS,
  type AiProvider,
} from "./providerRegistry";
import {
  hidePermissionDialog,
  showPermissionDialog,
  hideQuestionDialog,
  showQuestionDialog,
  showExitPlanDialog,
  type PermissionRequestView,
  type PendingQuestion,
  type PendingExitPlan,
  type QuestionDialogState,
} from "./permissionDialog";

type NoticeKind = "info" | "warning" | "auth" | "success";

interface SlashCommand {
  name: string;
  description: string;
  isBuiltin: boolean; // true = client-side action only (e.g. clear)
  argumentHint?: string;
}

// Client-side built-in slash commands (not sent to the SDK)
const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "开始新对话", isBuiltin: true },
];

// Cache of SDK slash commands fetched from the helper
let _sdkCommandsCache: SlashCommand[] | null = null;
let _sdkCommandsFetching = false;

interface PendingImage extends ConversationImage {
  data: string; // base64 (no data: prefix)
  dataUrl: string; // full data URL for preview
}

interface InputHistoryEntry {
  text: string;
  images: PendingImage[];
}

type PermissionMode =
  | "auto"
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

function normalizePermissionMode(value: unknown): PermissionMode {
  return [
    "auto",
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
  ].includes(String(value))
    ? (String(value) as PermissionMode)
    : "auto";
}

type ActivityMode =
  | "requesting"
  | "responding"
  | "thinking"
  | "tool"
  | "waiting";

function permissionModeDescription(mode: PermissionMode): string {
  const provider = normalizeProvider(getPref("provider"));
  const capabilities = getProviderCapabilities(provider);
  const agent = providerLabel(provider);
  switch (mode) {
    case "auto":
      return `${agent} will use the default approval flow.`;
    case "default":
      return `You'll be prompted for permission when ${agent} asks to use a tool.`;
    case "acceptEdits":
      return "File edits are accepted automatically; other permission prompts still ask.";
    case "plan":
      return capabilities.supportsInteractivePlanApproval
        ? `${agent} will plan first and ask before executing the plan.`
        : `${agent} will plan first, show plan updates, and ask for tool approvals when needed.`;
    case "dontAsk":
      return "Permission prompts are denied instead of shown.";
    case "bypassPermissions":
      return `${agent} skips permission checks for this session.`;
  }
}

function permissionOptionsForProvider(provider: AiProvider) {
  const capabilities = getProviderCapabilities(provider);
  const planLabel = capabilities.supportsInteractivePlanApproval
    ? "Plan approval"
    : "Plan first";
  return [
    {
      value: "auto",
      label: "Auto mode",
      description: permissionModeDescription("auto"),
    },
    {
      value: "default",
      label: "Ask permissions",
      description: permissionModeDescription("default"),
    },
    {
      value: "acceptEdits",
      label: "Accept edits",
      description: permissionModeDescription("acceptEdits"),
    },
    ...(capabilities.supportsPlanMode
      ? [
          {
            value: "plan",
            label: planLabel,
            description: permissionModeDescription("plan"),
          },
        ]
      : []),
    {
      value: "dontAsk",
      label: "Don't ask",
      description: permissionModeDescription("dontAsk"),
    },
    {
      value: "bypassPermissions",
      label: "Bypass permissions",
      description: permissionModeDescription("bypassPermissions"),
      danger: true,
    },
  ];
}

interface PaneState {
  root: HTMLElement;
  transcript: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  providerSelect: DivSelect;
  modelSelect: DivSelect;
  effortSelect: DivSelect;
  contextChips: HTMLElement;
  itemChip: HTMLElement;
  readerChip: HTMLElement;
  textChip: HTMLElement;
  annotationChip: HTMLElement;
  selectedAnnotations: ClauderoAnnotationContext[];
  dismissedAnnotations: boolean;
  statusDot: HTMLElement;
  permissionSelect: DivSelect;
  customPromptsBar: HTMLElement;
  currentAssistantBody: HTMLElement | null;
  currentAssistantCard: HTMLElement | null;
  currentItem: Zotero.Item | null;
  currentItems: Zotero.Item[];
  readerFilePath: string;
  selectedText: string;
  dismissedReader: boolean;
  dismissedText: boolean;
  manualItems: Zotero.Item[];
  pickerEl: HTMLElement | null;
  toolCards: Map<string, ToolCardState>;
  lastAssistantText: string;
  currentSegmentText: string;
  lastStreamingRenderTs: number;
  thinkingEl: HTMLElement | null;
  thinkingMetaEl: HTMLElement | null;
  thinkingTimer: number | null;
  thinkingWordEl: HTMLElement | null;
  thinkingTs: number;
  turnStartedTs: number;
  turnOutputTokens: number;
  turnResponseChars: number;
  thinkingTokenEstimate: number;
  thinkingVerb: string;
  activityMode: ActivityMode;
  activityMessage: string;
  activityStartedTs: number;
  recentThoughtDurationMs: number;
  recentThoughtUntil: number;
  thinkingCard: {
    el: HTMLElement;
    header: HTMLElement;
    labelSpan: HTMLElement;
    durationSpan: HTMLElement;
    body: HTMLElement;
    startTs: number;
    text: string;
    timer: number;
  } | null;
  pendingImages: PendingImage[];
  pendingImagesBar: HTMLElement | null;
  conversationId: string;
  conversationTurns: ConversationTurn[];
  providerState?: ConversationProviderState;
  parentConversationId?: string;
  forkedAtTurnIndex?: number;
  compactedAt?: number;
  currentProviderTurnId?: string;
  currentAssistantBlocks: ConversationBlock[];
  currentContextSnapshot: unknown | null;
  running: boolean;
  cancelRequested: boolean;
  permissionMode: PermissionMode;
  permissionDialog: HTMLElement | null;
  questionDialog: HTMLElement | null;
  permissionCheckTimer: number | null;
  questionPollingUnsupported: boolean;
  lastContextSignature: string;
  _savedComposerChildren: {
    chips: HTMLElement | null;
    inputEl: HTMLElement | null;
    toolbar: HTMLElement | null;
  } | null;
  scrollToBottomBtn: HTMLElement | null;
  inputHistory: InputHistoryEntry[];
  inputHistoryIdx: number;
  _inputHistorySavedText: string;
  _inputHistorySavedImages: PendingImage[];
  _suppressText: number; // >0 while a Skill tool is running — suppresses skill output text
  _activeSkillToolId: string | null;
}

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

const CHECK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
  <path d="M12.096 2.914a.7.7 0 0 1 1.134.772l-.069.125-6.25 9.166a.7.7 0 0 1-1.073.102l-3.75-3.75-.09-.11a.7.7 0 0 1 .97-.97l.11.09 3.153 3.152 5.774-8.469z"/>
</svg>`;

const REMOVE_X_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>`;

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
type CtxCategory = "text" | "annotations" | "items" | "reader" | "collection";

const PANEL_ID = "claudero-side-panel";
const SPLITTER_ID = "claudero-side-splitter";
const TOOLBAR_BUTTON_ID = "claudero-toolbar-button";
const LIBRARY_ANCHOR_ID = "zotero-items-splitter";
const READER_ANCHOR_ID = "zotero-context-splitter";
const paneStates = new WeakMap<HTMLElement, PaneState>();
const mountedWindows = new WeakSet<Window>();
const CLAUDE_EFFORT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
  { value: "max", label: "Max" },
];
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

// ── Conversation persistence ───────────────────────────────────────────────

async function saveConversation(state: PaneState): Promise<void> {
  await saveCurrentConversation(state);
}

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
  labelSpan.textContent = `Thought for ${sec}s`;
  const chevron = createThinkingChevron(doc);
  header.append(labelSpan, chevron);
  const body = createEl(doc, "div", "claudero-thinking-body");
  body.textContent = block.text.trim();
  header.addEventListener("click", () => el.classList.toggle("collapsed"));
  el.append(header, body);
  state.transcript.appendChild(el);
}

function renderAssistantTurn(
  state: PaneState,
  turn: ConversationTurn,
  index: number,
): void {
  const blocks = Array.isArray(turn.blocks) ? turn.blocks : [];
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
      appendNoticeCard(
        state,
        (block.kind as NoticeKind) || "info",
        block.title,
        block.text,
      );
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

function pushAssistantBlock(state: PaneState, block: ConversationBlock): void {
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

function restoreConversation(state: PaneState, conv: SavedConversation): void {
  void saveConversation(state);
  applyConversation(state, conv);
  renderConversationTurns(state);
  setStatusDot(state, "ready");
}

async function restoreLatestConversation(state: PaneState): Promise<void> {
  const latest = await loadLatestConversation();
  if (latest) restoreConversation(state, latest);
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  return el;
}

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

function getCurrentRegularItems(): Zotero.Item[] {
  try {
    if (getSelectedTabType(Zotero.getMainWindow()) !== "library") return [];
    const selected =
      Zotero.getActiveZoteroPane().getSelectedItems() as Zotero.Item[];
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
  if (!item) return "No Zotero item selected";
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
      label: `${items.length} selected items`,
      tooltip: midTruncate(titles, 140),
    });
  }
}

function isAtBottom(state: PaneState): boolean {
  const t = state.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}

function updateScrollToBottomBtn(state: PaneState): void {
  if (!state.scrollToBottomBtn) return;
  state.scrollToBottomBtn.style.display = isAtBottom(state) ? "none" : "flex";
}

function forceScrollToBottom(state: PaneState): void {
  state.transcript.scrollTop = state.transcript.scrollHeight;
  updateScrollToBottomBtn(state);
}

function smoothScrollToBottom(state: PaneState): void {
  const el = state.transcript;
  const target = el.scrollHeight - el.clientHeight;
  const start = el.scrollTop;
  const distance = target - start;
  if (distance <= 0) return;

  const duration = Math.min(400, Math.max(200, distance * 0.5));
  const win = el.ownerDocument!.defaultView!;
  const startTime = win.performance.now();

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  function step(now: number): void {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    el.scrollTop = start + distance * easeOutCubic(progress);
    if (progress < 1) {
      win.requestAnimationFrame(step);
    } else {
      updateScrollToBottomBtn(state);
    }
  }

  win.requestAnimationFrame(step);
}

function scrollTranscript(state: PaneState): void {
  if (isAtBottom(state)) {
    state.transcript.scrollTop = state.transcript.scrollHeight;
  }
  updateScrollToBottomBtn(state);
}

function setStatusDot(
  state: PaneState,
  mode: "ready" | "streaming" | "error",
): void {
  state.statusDot.className =
    `claudero-status-dot ${mode === "ready" ? "" : mode}`.trim();
  const label =
    mode === "ready"
      ? "Ready"
      : mode === "streaming"
        ? `${providerLabel(normalizeProvider(getPref("provider")))} is responding`
        : "Last request failed";
  state.statusDot.setAttribute("title", label);
  state.statusDot.setAttribute("aria-label", label);
}

function setRunning(state: PaneState, running: boolean): void {
  state.running = running;
  // Conversation no longer requires a Zotero context — the input and send
  // button stay enabled so the user can chat freely.
  state.sendButton.disabled = false;
  state.input.disabled = false;
  state.providerSelect.disabled = running;
  state.modelSelect.disabled = running;
  state.effortSelect.disabled = running;
  setStatusDot(state, running ? "streaming" : "ready");
  updateSendButton(state, running);

  // Clear pending-interaction polling when not running.
  if (!running && state.permissionCheckTimer) {
    clearInterval(state.permissionCheckTimer);
    state.permissionCheckTimer = null;
    hidePermissionDialog(state);
    hideQuestionDialog(state);
  }
}

function makeChipRemoveBtn(doc: Document, onClick: () => void): HTMLElement {
  const btn = createEl(doc, "button", "claudero-chip-remove");
  btn.setAttribute("tabindex", "-1");
  const wrapper = doc.createElement("div");
  wrapper.innerHTML = REMOVE_X_ICON_SVG.trim();
  const svg = wrapper.firstElementChild as SVGSVGElement;
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  btn.appendChild(svg);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    doc.querySelectorAll(".claudero-chip-tooltip").forEach((t) => t.remove());
    onClick();
  });
  return btn;
}

function updateContext(state: PaneState): void {
  const doc = state.root.ownerDocument!;
  const selectedType = getSelectedTabType(Zotero.getMainWindow());
  const autoItems = getCurrentRegularItems();
  const autoReaderPath =
    selectedType === "reader" ? getCurrentReaderFilePath() : "";
  const autoText = selectedType === "reader" ? getSelectedReaderText() : "";
  const autoAnnotations =
    selectedType === "reader" ? getSelectedReaderAnnotations() : [];

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
  state.input.placeholder = "Ask anything about this paper...";
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
    const readerItem = getCurrentReaderItem();
    const readerTooltip = [
      readerItem ? getItemTitle(readerItem) : "",
      state.readerFilePath,
    ]
      .filter(Boolean)
      .join("\n");
    populateContextToken(state.readerChip, doc, {
      icon: readerItem ? mkItemIconEl(doc, readerItem) : undefined,
      label: "当前PDF",
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
      label: "已选中一段文字",
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
      label: count === 1 ? "已选中 1 条标注" : `已选中 ${count} 条标注`,
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

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function getAttachmentDirectories(
  context: Awaited<ReturnType<typeof getSelectedZoteroContext>>,
): string[] {
  const directories = new Set<string>();
  for (const item of context.items) {
    for (const attachment of item.attachments) {
      if (attachment.path) directories.add(dirname(attachment.path));
    }
  }
  if (context.reader?.path) directories.add(dirname(context.reader.path));
  return [...directories];
}

function getSelectedModel(state: PaneState): string {
  const provider = normalizeProvider(state.providerSelect.value);
  return state.modelSelect.value || defaultModelForProvider(provider);
}

function getSelectedEffort(state: PaneState): string {
  const provider = normalizeProvider(state.providerSelect.value);
  return state.effortSelect.value || defaultEffortForProvider(provider);
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

const COMPLETION_FLAVOR_WORDS = [
  "Baked",
  "Brewed",
  "Crafted",
  "Forged",
  "Conjured",
  "Simmered",
  "Distilled",
  "Percolated",
  "Roasted",
  "Cogitated",
  "Steeped",
] as const;

function pickFlavorWord(): string {
  return COMPLETION_FLAVOR_WORDS[
    Math.floor(Math.random() * COMPLETION_FLAVOR_WORDS.length)
  ];
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Build a short human label for a reversible write result returned by the
// Zotero endpoint. Returns null for read operations (which carry no opId).
function describeWriteResult(result: Record<string, unknown>): string | null {
  if (typeof result.added === "number" || typeof result.removed === "number") {
    const added = typeof result.added === "number" ? result.added : 0;
    const removed = typeof result.removed === "number" ? result.removed : 0;
    const parts: string[] = [];
    if (added) parts.push(`+${added} 标签`);
    if (removed) parts.push(`−${removed} 标签`);
    return parts.length ? parts.join("  ") : "标签已更新";
  }
  if (result.noteId != null) return "已创建笔记";
  if (typeof result.field === "string") return `已设置字段 “${result.field}”`;
  return null;
}

async function callZoteroEndpoint(
  payload: Record<string, unknown>,
): Promise<{ success?: boolean; error?: string; result?: unknown }> {
  const res = await fetch(getZoteroEndpointBaseUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
    viewBtn.title = "查看条目";
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
  undoBtn.title = "撤销";
  const undoWrapper = doc.createElement("div");
  undoWrapper.innerHTML = UNDO_ICON_SVG.trim();
  const undoSvg = undoWrapper.firstElementChild as SVGSVGElement;
  undoSvg.setAttribute("width", "13");
  undoSvg.setAttribute("height", "13");
  undoBtn.appendChild(undoSvg);
  undoBtn.addEventListener("click", () => {
    undoBtn.disabled = true;
    void callZoteroEndpoint({ action: "undo_last", operationId })
      .then((res) => {
        if (res?.success) {
          card.classList.add("undone");
          icon.textContent = "↩";
          text.textContent = `已撤销 · ${label}`;
          viewBtn?.remove();
          undoBtn.remove();
        } else {
          undoBtn.disabled = false;
          appendNoticeCard(
            state,
            "warning",
            "撤销失败",
            res?.error || "无法撤销该操作",
          );
        }
      })
      .catch((e) => {
        undoBtn.disabled = false;
        appendNoticeCard(state, "warning", "撤销失败", String(e));
      });
  });
  btnGroup.appendChild(undoBtn);

  card.append(info, btnGroup);
  state.transcript.appendChild(card);
  scrollTranscript(state);
}

// ── Image paste / preview ──────────────────────────────────────────────────

function readFileAsDataURL(win: Window, file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new (
      win as unknown as { FileReader: typeof FileReader }
    ).FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addPastedImageFiles(
  state: PaneState,
  files: Blob[],
): Promise<void> {
  const win = state.root.ownerDocument!.defaultView as Window;
  for (const file of files) {
    const type = (file as { type?: string }).type || "image/png";
    if (!type.startsWith("image/")) continue;
    try {
      const dataUrl = await readFileAsDataURL(win, file);
      const comma = dataUrl.indexOf(",");
      const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
      if (!data) continue;
      state.pendingImages.push({
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        mediaType: type,
        data,
        dataUrl,
      });
    } catch {
      /* ignore unreadable image */
    }
  }
  renderPendingImages(state);
}

// Remove any orphaned hover previews. Needed because removing a thumbnail mid-
// hover (clicking its ×) detaches the element before mouseleave can fire.
function removeAllImagePreviews(state: PaneState): void {
  state.root
    .querySelectorAll(".claudero-img-preview")
    .forEach((el) => el.remove());
}

// Floating large preview shown beside the hovered thumbnail.
function attachImagePreview(
  state: PaneState,
  el: HTMLElement,
  dataUrl: string,
): void {
  const doc = state.root.ownerDocument!;
  let preview: HTMLElement | null = null;
  const hide = () => {
    preview?.remove();
    preview = null;
  };
  el.addEventListener("mouseenter", () => {
    hide();
    const win = doc.defaultView as Window;
    preview = createEl(doc, "div", "claudero-img-preview");
    const big = doc.createElement("img") as HTMLImageElement;
    big.src = dataUrl;
    preview.appendChild(big);
    preview.style.position = "fixed";
    preview.style.visibility = "hidden";
    state.root.appendChild(preview);

    const place = () => {
      if (!preview) return;
      const thumb = el.getBoundingClientRect();
      const pw = preview.offsetWidth;
      const ph = preview.offsetHeight;
      const gap = 8;
      // Prefer to the left of the thumb (the pane hugs the right screen edge);
      // fall back to the right, then clamp inside the viewport.
      let left = thumb.left - pw - gap;
      if (left < gap) left = thumb.right + gap;
      left = Math.min(left, win.innerWidth - pw - gap);
      left = Math.max(gap, left);
      let top = thumb.top + thumb.height / 2 - ph / 2;
      top = Math.max(gap, Math.min(top, win.innerHeight - ph - gap));
      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
      preview.style.visibility = "visible";
    };

    if (big.complete) place();
    else big.addEventListener("load", place, { once: true });
    place();
  });
  el.addEventListener("mouseleave", hide);
}

function ensurePendingImagesBar(state: PaneState): HTMLElement {
  if (state.pendingImagesBar && state.pendingImagesBar.isConnected) {
    return state.pendingImagesBar;
  }
  const doc = state.root.ownerDocument!;
  const composer = state.root.querySelector(
    ".claudero-composer",
  ) as HTMLElement;
  const bar = createEl(doc, "div", "claudero-pending-images");
  composer.insertBefore(bar, state.input);
  state.pendingImagesBar = bar;
  return bar;
}

function renderPendingImages(state: PaneState): void {
  const bar = ensurePendingImagesBar(state);
  removeAllImagePreviews(state);
  bar.textContent = "";
  if (state.pendingImages.length === 0) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  const doc = state.root.ownerDocument!;
  for (const img of state.pendingImages) {
    const thumb = createEl(doc, "div", "claudero-img-thumb");
    const imgEl = doc.createElement("img") as HTMLImageElement;
    imgEl.src = img.dataUrl;
    thumb.appendChild(imgEl);
    attachImagePreview(state, thumb, img.dataUrl);
    thumb.appendChild(
      makeChipRemoveBtn(doc, () => {
        state.pendingImages = state.pendingImages.filter(
          (i) => i.id !== img.id,
        );
        renderPendingImages(state);
      }),
    );
    bar.appendChild(thumb);
  }
}

interface MessageRenderOptions {
  ts?: number;
  turnIndex?: number;
  editable?: boolean;
  contextSnapshot?: unknown;
  skipStreaming?: boolean; // If true, don't add streaming class even for assistant messages
}

function cloneImages(images?: ConversationImage[]): PendingImage[] {
  return (images || []).map((img) => ({ ...img }));
}

function getLastEditableUserTurnIndex(state: PaneState): number {
  for (let i = state.conversationTurns.length - 1; i >= 0; i--) {
    if (state.conversationTurns[i]?.role === "user") return i;
  }
  return -1;
}

function asSelectionContext(value: unknown): ClauderoSelectionContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Partial<ClauderoSelectionContext>;
  if (!Array.isArray(context.items)) return null;
  return context as ClauderoSelectionContext;
}

function compactText(value: string, max = 34): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function midTruncate(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return text.slice(0, head) + "…" + text.slice(text.length - tail);
}

function makeStoredItemIconEl(doc: Document, itemType: string): HTMLElement {
  const span = createEl(
    doc,
    "span",
    "claudero-chip-icon icon icon-css icon-item-type cell-icon item-icon",
  );
  if (itemType) span.setAttribute("data-item-type", itemType);
  return span;
}

// Resolve the Zotero item-type icon name for a reader attachment.  Live
// contexts carry `_item` directly; stored (imported) contexts need to re-fetch
// the attachment via Zotero.Items.
function resolveReaderIconType(reader: {
  key: string;
  _item?: Zotero.Item;
}): string {
  const liveIcon =
    reader._item?.getItemTypeIconName?.() ??
    reader._item?.topLevelItem?.getItemTypeIconName?.();
  if (liveIcon) return liveIcon;

  const fetched = Zotero.Items.getByLibraryAndKey(1, reader.key) as
    | (Zotero.Item & { topLevelItem?: Zotero.Item })
    | false;
  if (fetched) {
    const name =
      (fetched as any).getItemTypeIconName?.() ??
      (fetched as any).topLevelItem?.getItemTypeIconName?.();
    if (name) return name;
  }
  return "attachment";
}

// Zotero native library icon, using the same style as item-type icons
function makeNativeLibraryIcon(doc: Document): HTMLElement {
  return createEl(
    doc,
    "span",
    "claudero-chip-icon icon icon-css icon-library cell-icon item-icon",
  );
}

// Zotero's native annotation highlight glyph. Used everywhere we represent
// annotations (the summary chip icon and the annotations detail header).
function makeAnnotationIcon(doc: Document): HTMLElement {
  const img = createEl(doc, "img", "claudero-chip-icon");
  img.src = "chrome://zotero/skin/16/universal/annotate-highlight.svg";
  img.setAttribute("width", "16");
  img.setAttribute("height", "16");
  return img;
}

function makePdfFallbackIcon(doc: Document): HTMLElement {
  const span = createEl(doc, "span", "claudero-pdf-chip-icon");
  span.textContent = "PDF";
  return span;
}

function selectZoteroItemsFromHistory(ids: number[]): void {
  const cleanIDs = ids.filter((id) => Number.isFinite(id) && id > 0);
  if (!cleanIDs.length) return;
  try {
    const win = Zotero.getMainWindow() as Window & {
      Zotero_Tabs?: { select?: (id: string) => void };
      ZoteroPane?: { selectItems?: (ids: number[]) => unknown };
    };
    win.Zotero_Tabs?.select?.("zotero-pane");
    const pane = Zotero.getActiveZoteroPane?.() || win.ZoteroPane;
    void pane?.selectItems?.(cleanIDs);
  } catch (error) {
    ztoolkit.log("[Claudero] Failed to select historical Zotero items:", error);
  }
}

function attachChipTooltip(el: HTMLElement, text: string): void {
  // Store the text as a data attribute so repeated calls (on rebuilt chips)
  // just update the text without adding duplicate event listeners.
  el.dataset.clauderoTooltip = text;
  if (el.dataset.clauderoTooltipBound) return;
  el.dataset.clauderoTooltipBound = "1";
  const doc = el.ownerDocument!;
  let tip: HTMLElement | null = null;
  el.addEventListener("mouseenter", () => {
    const tooltipText = el.dataset.clauderoTooltip || "";
    if (!tooltipText) return;
    tip = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    tip.className = "claudero-chip-tooltip";
    tip.textContent = tooltipText;
    // Mount hidden first so we can read its rendered size for clamping.
    tip.style.visibility = "hidden";
    doc.documentElement.appendChild(tip);
    const anchorRect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const win = doc.defaultView!;
    const margin = 8;
    const idealLeft =
      anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
    const clampedLeft = Math.max(
      margin,
      Math.min(idealLeft, win.innerWidth - tipRect.width - margin),
    );
    tip.style.left = `${clampedLeft}px`;
    tip.style.top = `${anchorRect.top - tipRect.height - 6}px`;
    tip.style.visibility = "";
  });
  el.addEventListener("mouseleave", () => {
    tip?.remove();
    tip = null;
  });
}

// Shared chip content builder — used by both composer chips and message chips
// so they render identically. The caller decides whether to add a remove button.
function populateContextToken(
  el: HTMLElement,
  doc: Document,
  options: { icon?: HTMLElement; label: string; tooltip?: string },
): void {
  el.textContent = "";
  if (options.icon) el.appendChild(options.icon);
  const span = createEl(doc, "span", "claudero-chip-label");
  span.textContent = options.label;
  el.appendChild(span);
  if (options.tooltip) attachChipTooltip(el, options.tooltip);
}

// Present context categories in priority order (selected text/annotations win
// over items/PDF, which win over the active collection).
function presentContextCategories(
  context: ClauderoSelectionContext,
): CtxCategory[] {
  const categories: CtxCategory[] = [];
  if (context.selectedText?.trim()) categories.push("text");
  if (
    Array.isArray(context.selectedAnnotations) &&
    context.selectedAnnotations.length > 0
  ) {
    categories.push("annotations");
  }
  if (Array.isArray(context.items) && context.items.length > 0)
    categories.push("items");
  if (context.reader?.id || context.reader?.path) categories.push("reader");
  if (context.activeCollection?.name || context.activeCollection?.path)
    categories.push("collection");
  return categories;
}

// A native Zotero library/collection glyph (icon-library / icon-collection),
// rendered by Zotero's own stylesheet in the main window.
function makeZoteroTreeIcon(
  doc: Document,
  kind: "library" | "collection",
): HTMLElement {
  return createEl(
    doc,
    "span",
    `icon icon-css ${kind === "library" ? "icon-library" : "icon-collection"}`,
  );
}

// The "multiple items" glyph: up to three real item-type icons, overlapped —
// the same stacked treatment the composer chip uses.
function makeStackedItemIcons(
  doc: Document,
  items: ClauderoSelectionContext["items"],
): HTMLElement {
  const wrap = createEl(doc, "div", "claudero-item-icons");
  for (const item of items.slice(0, 3)) {
    const icon = makeStoredItemIconEl(doc, item.itemType || "");
    icon.classList.add("stacked");
    wrap.appendChild(icon);
  }
  return wrap;
}

// The compact icon + label shown on the summary chip for the highest-priority
// category present in a message.
function buildSummaryPrimary(
  doc: Document,
  context: ClauderoSelectionContext,
  kind: CtxCategory,
): { icon: HTMLElement; label: string } {
  switch (kind) {
    case "text":
      return {
        icon: createEl(doc, "div", "claudero-text-icon"),
        label: compactText(context.selectedText.trim(), 22),
      };
    case "annotations":
      return {
        icon: makeAnnotationIcon(doc),
        label: `${context.selectedAnnotations?.length || 0} 条标注`,
      };
    case "items": {
      const items = context.items;
      if (items.length === 1) {
        const item = items[0];
        return {
          icon: makeStoredItemIconEl(doc, item.itemType || ""),
          label: compactText(item.title || item.key || String(item.id), 22),
        };
      }
      return {
        icon: makeStackedItemIcons(doc, items),
        label: `${items.length} items`,
      };
    }
    case "reader": {
      const reader = context.reader!;
      return {
        icon: makeStoredItemIconEl(doc, resolveReaderIconType(reader)),
        label: compactText(reader.title || "当前 PDF", 22),
      };
    }
    case "collection": {
      const collection = context.activeCollection!;
      return {
        icon: makeNativeLibraryIcon(doc),
        label: compactText(collection.path || collection.name || "", 22),
      };
    }
  }
  const exhaustive: never = kind;
  return exhaustive;
}

// A single compact pill summarising a message's captured Zotero context. Shows
// the top-priority category and a "+N" badge for the remaining categories;
// clicking it opens a categorised detail popup.
function buildMessageContextSummaryChip(
  state: PaneState,
  snapshot: unknown,
): HTMLElement | null {
  const context = asSelectionContext(snapshot);
  if (!context) return null;
  const categories = presentContextCategories(context);
  if (!categories.length) return null;

  const doc = state.root.ownerDocument!;
  const chip = createEl(doc, "button", "claudero-message-context-summary");
  chip.type = "button";
  chip.setAttribute("tabindex", "-1");
  chip.setAttribute("title", "查看上下文");
  chip.setAttribute("aria-label", "查看上下文");

  const { icon, label } = buildSummaryPrimary(doc, context, categories[0]);
  chip.appendChild(icon);
  const labelEl = createEl(doc, "span", "claudero-chip-label");
  labelEl.textContent = label;
  chip.appendChild(labelEl);

  const extra = categories.length - 1;
  if (extra > 0) {
    const badge = createEl(doc, "span", "claudero-ctx-summary-badge");
    badge.textContent = `+${extra}`;
    chip.appendChild(badge);
  }

  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showMessageContextPopup(state, chip, context);
  });
  return chip;
}

// While a detail popup is open we keep its message's hover meta (the summary
// chip + time + actions) pinned visible, and only let it fade ~1.5s after the
// popup closes — so opening details doesn't make the chip vanish under you.
let pinnedContextStack: HTMLElement | null = null;
let pinUnpinTimer: number | null = null;

function pinContextStack(anchor: HTMLElement): void {
  const stack = anchor.closest(".claudero-message-stack") as HTMLElement | null;
  const win = anchor.ownerDocument?.defaultView ?? null;
  if (pinUnpinTimer !== null && win) win.clearTimeout(pinUnpinTimer);
  pinUnpinTimer = null;
  if (pinnedContextStack && pinnedContextStack !== stack) {
    pinnedContextStack.classList.remove("claudero-context-pinned");
  }
  pinnedContextStack = stack;
  stack?.classList.add("claudero-context-pinned");
}

function unpinContextStackSoon(doc: Document): void {
  if (!pinnedContextStack) return;
  const stack = pinnedContextStack;
  const win = doc.defaultView;
  if (pinUnpinTimer !== null && win) win.clearTimeout(pinUnpinTimer);
  if (!win) {
    stack.classList.remove("claudero-context-pinned");
    pinnedContextStack = null;
    pinUnpinTimer = null;
    return;
  }
  pinUnpinTimer = win.setTimeout(() => {
    stack.classList.remove("claudero-context-pinned");
    pinnedContextStack = null;
    pinUnpinTimer = null;
  }, 1500);
}

function closeContextDetailPopup(doc: Document): HTMLElement | null {
  const existing = doc.querySelector(".claudero-context-detail-popup") as
    | (HTMLElement & { _cleanup?: () => void; _anchor?: HTMLElement })
    | null;
  if (existing) {
    existing._cleanup?.();
    existing.remove();
    unpinContextStackSoon(doc);
  }
  return existing;
}

function positionContextPopup(popup: HTMLElement, anchor: HTMLElement): void {
  const doc = anchor.ownerDocument!;
  const win = doc.defaultView!;
  const a = anchor.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const margin = 8;
  let left = a.right - p.width; // right-align with the chip
  left = Math.max(margin, Math.min(left, win.innerWidth - p.width - margin));
  let top = a.top - p.height - 6; // open upward by default
  if (top < margin) top = a.bottom + 6; // flip below when there's no room
  top = Math.max(margin, Math.min(top, win.innerHeight - p.height - margin));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function makeCtxSection(
  doc: Document,
  icon: HTMLElement,
  title: string,
): { section: HTMLElement; body: HTMLElement } {
  const section = createEl(doc, "div", "claudero-ctx-section");
  const head = createEl(doc, "div", "claudero-ctx-section-head");
  icon.classList.add("claudero-ctx-head-icon");
  const titleEl = createEl(doc, "span", "claudero-ctx-section-title");
  titleEl.textContent = title;
  head.append(icon, titleEl);
  const body = createEl(doc, "div", "claudero-ctx-section-body");
  section.append(head, body);
  return { section, body };
}

// A clickable row (icon + title + optional sub-lines). Uses a div rather than a
// native <button> so block children stack predictably instead of collapsing
// into the button's single-line box.
function makeClickableRow(
  doc: Document,
  options: {
    icon: HTMLElement;
    title: string;
    subs: string[];
    onClick: () => void;
  },
): HTMLElement {
  const row = createEl(
    doc,
    "div",
    "claudero-ctx-row claudero-ctx-row-clickable",
  );
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "-1");
  options.icon.classList.add("claudero-ctx-row-icon");
  const main = createEl(doc, "div", "claudero-ctx-row-main");
  const title = createEl(doc, "div", "claudero-ctx-row-title");
  title.textContent = options.title;
  main.appendChild(title);
  for (const sub of options.subs) {
    const subEl = createEl(doc, "div", "claudero-ctx-row-sub");
    subEl.textContent = sub;
    main.appendChild(subEl);
  }
  row.append(options.icon, main);
  row.addEventListener("click", () => {
    options.onClick();
    closeContextDetailPopup(doc);
  });
  return row;
}

function buildContextSection(
  doc: Document,
  context: ClauderoSelectionContext,
  kind: CtxCategory,
): HTMLElement {
  switch (kind) {
    case "text": {
      const { section, body } = makeCtxSection(
        doc,
        createEl(doc, "div", "claudero-text-icon"),
        "选中文本",
      );
      const text = createEl(doc, "div", "claudero-ctx-text");
      text.textContent = context.selectedText.trim();
      body.appendChild(text);
      return section;
    }
    case "annotations": {
      const annotations = context.selectedAnnotations || [];
      // Annotations always use Zotero's highlight glyph.
      const { section, body } = makeCtxSection(
        doc,
        makeAnnotationIcon(doc),
        `标注 · ${annotations.length}`,
      );
      for (const anno of annotations) {
        const row = createEl(doc, "div", "claudero-ctx-row claudero-ctx-anno");
        // The annotation's own colour shows as a left accent bar; the page badge
        // sits at the bottom-right under the text.
        if (anno.color) row.style.borderLeftColor = anno.color;
        const main = createEl(doc, "div", "claudero-ctx-row-main");
        const textEl = createEl(doc, "div", "claudero-ctx-anno-text");
        textEl.textContent = anno.text || "（无文本标注）";
        main.appendChild(textEl);
        if (anno.comment) {
          const comment = createEl(doc, "div", "claudero-ctx-anno-comment");
          comment.textContent = anno.comment;
          main.appendChild(comment);
        }
        if (typeof anno.pageIndex === "number") {
          const page = createEl(doc, "span", "claudero-ctx-page");
          page.textContent = `p.${anno.pageIndex + 1}`;
          main.appendChild(page);
        }
        row.appendChild(main);
        body.appendChild(row);
      }
      return section;
    }
    case "items": {
      const items = context.items;
      // Header shows the item's own icon (the single item's type icon, or
      // stacked type icons when several are selected); rows repeat each icon.
      const headIcon =
        items.length === 1
          ? makeStoredItemIconEl(doc, items[0].itemType || "")
          : makeStackedItemIcons(doc, items);
      const { section, body } = makeCtxSection(
        doc,
        headIcon,
        items.length === 1 ? "1 item" : `${items.length} items`,
      );
      for (const item of items) {
        const subParts = [item.creators?.[0], (item.date || "").slice(0, 4)]
          .filter(Boolean)
          .join(" · ");
        body.appendChild(
          makeClickableRow(doc, {
            icon: makeStoredItemIconEl(doc, item.itemType || ""),
            title: item.title || item.key || String(item.id),
            subs: subParts ? [subParts] : [],
            onClick: () => selectZoteroItemsFromHistory([item.id]),
          }),
        );
      }
      return section;
    }
    case "reader": {
      const reader = context.reader!;
      const rowIcon = makeStoredItemIconEl(doc, resolveReaderIconType(reader));
      const headIcon = makeStoredItemIconEl(doc, resolveReaderIconType(reader));
      const { section, body } = makeCtxSection(doc, headIcon, "1 item");
      const page =
        reader.pageLabel ||
        (reader.pageNumber ? String(reader.pageNumber) : "");
      const subs: string[] = [];
      if (page)
        subs.push(
          `第 ${page} 页${reader.pagesCount ? ` / ${reader.pagesCount}` : ""}`,
        );
      if (reader.path) subs.push(midTruncate(reader.path, 60));
      body.appendChild(
        makeClickableRow(doc, {
          icon: rowIcon,
          title: reader.title || "当前 PDF",
          subs,
          // Select the PDF attachment itself, not its parent item.
          onClick: () => selectZoteroItemsFromHistory([reader.id]),
        }),
      );
      return section;
    }
    case "collection": {
      const collection = context.activeCollection!;
      // Use Zotero native library icon style for the section header
      const { section, body } = makeCtxSection(
        doc,
        makeNativeLibraryIcon(doc),
        "所在分类",
      );
      const tree = createEl(doc, "div", "claudero-ctx-coll-tree");
      const levels: {
        label: string;
        kind: "library" | "collection";
        current: boolean;
      }[] = [
        {
          label: collection.libraryName || "我的文库",
          kind: "library",
          current: false,
        },
      ];
      const names = (collection.path || collection.name || "")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
      names.forEach((name, index) => {
        levels.push({
          label: name,
          kind: "collection",
          current: index === names.length - 1,
        });
      });
      levels.forEach((level, index) => {
        const row = createEl(
          doc,
          "div",
          `claudero-ctx-coll-row${level.current ? " current" : ""}`,
        );
        row.style.setProperty("--level", String(index));
        const label = createEl(doc, "span", "claudero-ctx-coll-label");
        label.textContent = level.label;
        row.append(makeZoteroTreeIcon(doc, level.kind), label);
        tree.appendChild(row);
      });
      body.appendChild(tree);
      return section;
    }
  }
  const exhaustive: never = kind;
  return exhaustive;
}

function showMessageContextPopup(
  state: PaneState,
  anchor: HTMLElement,
  context: ClauderoSelectionContext,
): void {
  const doc = anchor.ownerDocument!;
  const closed = closeContextDetailPopup(doc) as
    | (HTMLElement & { _anchor?: HTMLElement })
    | null;
  if (closed && closed._anchor === anchor) return; // clicking the open chip toggles it shut

  const categories = presentContextCategories(context);
  if (!categories.length) return;

  pinContextStack(anchor); // keep the chip visible while details are open

  const popup = createEl(
    doc,
    "div",
    "claudero-context-detail-popup",
  ) as HTMLElement & {
    _cleanup?: () => void;
    _anchor?: HTMLElement;
  };
  popup._anchor = anchor;
  popup.style.visibility = "hidden"; // measure before revealing to avoid a position flash
  for (const kind of categories) {
    popup.appendChild(buildContextSection(doc, context, kind));
  }
  doc.documentElement.appendChild(popup);
  positionContextPopup(popup, anchor);
  popup.style.visibility = "";

  const win = doc.defaultView!;
  const onPointerDown = (event: Event) => {
    const target = event.target as Node;
    if (!popup.contains(target) && !anchor.contains(target))
      closeContextDetailPopup(doc);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeContextDetailPopup(doc);
  };
  const onReflow = () => closeContextDetailPopup(doc);
  doc.addEventListener("mousedown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("resize", onReflow, true);
  state.transcript.addEventListener("scroll", onReflow, true);
  popup._cleanup = () => {
    doc.removeEventListener("mousedown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    win.removeEventListener("resize", onReflow, true);
    state.transcript.removeEventListener("scroll", onReflow, true);
  };
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

function createToolbarLikeButton(
  doc: Document,
  className: string,
  title: string,
  onCommand: () => void,
): HTMLElement {
  const xulBtn = (
    doc as Document & { createXULElement?: (tag: string) => HTMLElement }
  ).createXULElement?.("toolbarbutton");
  const btn = (xulBtn ?? doc.createElement("button")) as HTMLElement;
  if (className) btn.className = className;
  btn.setAttribute("tooltiptext", title);
  btn.setAttribute("title", title);
  btn.setAttribute("aria-label", title);
  btn.setAttribute("tabindex", "-1");
  btn.addEventListener("command", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCommand();
  });
  if (btn.localName !== "toolbarbutton") {
    (btn as HTMLButtonElement).type = "button";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onCommand();
    });
  }
  return btn;
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
          : RETRY_ICON_SVG;
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

async function retryAssistantTurn(
  state: PaneState,
  turnIndex?: number,
): Promise<void> {
  if (state.running) return;
  const assistantIndex =
    typeof turnIndex === "number"
      ? turnIndex
      : state.conversationTurns.length - 1;
  if (
    assistantIndex < 0 ||
    state.conversationTurns[assistantIndex]?.role !== "assistant"
  )
    return;
  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && state.conversationTurns[userIndex]?.role !== "user")
    userIndex--;
  const userTurn = state.conversationTurns[userIndex];
  if (!userTurn) return;
  state.conversationTurns = state.conversationTurns.slice(0, userIndex);
  await saveConversation(state);
  renderConversationTurns(state);
  state.pendingImages = cloneImages(userTurn.images);
  renderPendingImages(state);
  void sendPrompt(
    state,
    userTurn.text,
    state.pendingImages.slice(),
    asSelectionContext(userTurn.contextSnapshot) || undefined,
  );
}

async function forkConversationAtTurn(
  state: PaneState,
  turnIndex?: number,
): Promise<void> {
  if (state.running) return;
  const index =
    typeof turnIndex === "number"
      ? turnIndex
      : state.conversationTurns.length - 1;
  if (index < 0 || !state.conversationTurns[index]) return;
  const parentConversationId = state.conversationId;
  const turns = state.conversationTurns.slice(0, index + 1);
  const activeProvider = normalizeProvider(state.providerSelect.value);
  const codexThreadId = state.providerState?.codex?.threadId;
  const resumeAt = findLastAssistantProviderTurnId(turns);
  await saveConversation(state);
  state.conversationId = newConversationId();
  state.conversationTurns = turns.map((turn) => ({ ...turn }));
  state.providerState =
    activeProvider === "codex" && codexThreadId
      ? {
          codex: {
            forkSource: {
              threadId: codexThreadId,
              resumeAt,
              sourceConversationId: parentConversationId,
            },
          },
        }
      : undefined;
  state.parentConversationId = parentConversationId;
  state.forkedAtTurnIndex = index;
  state.compactedAt = undefined;
  state.currentProviderTurnId = undefined;
  await saveConversation(state);
  renderConversationTurns(state);
  appendNoticeCard(
    state,
    "success",
    "Forked conversation",
    "Started a new conversation branch from this point.",
  );
  setStatusDot(state, "ready");
}

function findLastAssistantProviderTurnId(
  turns: ConversationTurn[],
): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role === "assistant" && turn.assistantMessageId) {
      return turn.assistantMessageId;
    }
  }
  return undefined;
}

async function editLastUserTurn(
  state: PaneState,
  turnIndex?: number,
): Promise<void> {
  if (state.running) return;
  const userIndex =
    typeof turnIndex === "number"
      ? turnIndex
      : getLastEditableUserTurnIndex(state);
  const turn = state.conversationTurns[userIndex];
  if (!turn || turn.role !== "user") return;
  state.conversationTurns = state.conversationTurns.slice(0, userIndex);
  await saveConversation(state);
  renderConversationTurns(state);
  state.input.value = turn.text === "(图片)" ? "" : turn.text;
  state.pendingImages = cloneImages(turn.images);
  renderPendingImages(state);
  const historicalContext = asSelectionContext(turn.contextSnapshot);
  if (historicalContext?.items?.length) {
    selectZoteroItemsFromHistory(
      historicalContext.items.map((item) => item.id),
    );
  }
  state.input.focus();
  state.input.selectionStart = state.input.selectionEnd =
    state.input.value.length;
  updateSendButton(state, false);
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
      imgEl.src = img.dataUrl;
      thumb.appendChild(imgEl);
      attachImagePreview(state, thumb, img.dataUrl);
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

async function checkPendingInteractions(state: PaneState): Promise<void> {
  // If cancel was requested, do nothing (the cancel flow already cleared pending requests)
  if (state.cancelRequested) return;

  try {
    const port = Number(getPref("helperPort") || 38660);
    const token = await (async () => {
      const profilePath = Zotero.Profile.dir;
      const tokenPath = [profilePath, "claudero", "helper", ".token"].join("/");
      try {
        return (await (IOUtils as any).readUTF8(tokenPath)).trim();
      } catch {
        return "";
      }
    })();

    const permissionResponse = await fetch(
      `http://127.0.0.1:${port}/pending-permission`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (permissionResponse.status === 200) {
      const request = await permissionResponse.json();
      showPermissionDialog(state, request as unknown as PermissionRequestView);
      stopThinkingAnimation(state);
    } else if (permissionResponse.status === 204) {
      // No pending permission request.
      if (state.permissionDialog) hidePermissionDialog(state);
    }

    let hasPendingExitPlan = false;
    const exitPlanResponse = await fetch(
      `http://127.0.0.1:${port}/pending-exit-plan`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (exitPlanResponse.status === 200) {
      hasPendingExitPlan = true;
      const exitPlan = await exitPlanResponse.json();
      showExitPlanDialog(state, exitPlan as unknown as PendingExitPlan);
      stopThinkingAnimation(state);
    } else if (
      exitPlanResponse.status === 204 &&
      state.questionDialog?.getAttribute("data-dialog-kind") === "exit-plan"
    ) {
      hideQuestionDialog(state);
    }

    if (!state.questionPollingUnsupported && !hasPendingExitPlan) {
      const questionResponse = await fetch(
        `http://127.0.0.1:${port}/pending-question`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (questionResponse.status === 200) {
        const question = await questionResponse.json();
        showQuestionDialog(state, question as unknown as PendingQuestion);
        stopThinkingAnimation(state);
      } else if (questionResponse.status === 204) {
        if (
          state.questionDialog?.getAttribute("data-dialog-kind") === "question"
        )
          hideQuestionDialog(state);
      } else if (questionResponse.status === 404) {
        state.questionPollingUnsupported = true;
        if (
          state.questionDialog?.getAttribute("data-dialog-kind") === "question"
        )
          hideQuestionDialog(state);
      }
    }
  } catch (e) {
    ztoolkit.log("[Claudero] Failed to check pending interactions:", e);
  }
}

function appendNoticeCard(
  state: PaneState,
  kind: NoticeKind,
  title: string,
  text: string,
  action?: { label: string; onClick: (button: HTMLButtonElement) => void },
): void {
  const doc = state.root.ownerDocument!;
  const card = createEl(doc, "div", `claudero-notice-card ${kind}`);
  const iconPaths: Record<NoticeKind, string> = {
    info: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    warning:
      "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
    auth: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
    success: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3",
  };
  const iconEl = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  iconEl.setAttribute("viewBox", "0 0 24 24");
  iconEl.setAttribute("width", "16");
  iconEl.setAttribute("height", "16");
  iconEl.setAttribute("fill", "none");
  iconEl.setAttribute("stroke", "currentColor");
  iconEl.setAttribute("stroke-width", "2");
  iconEl.setAttribute("stroke-linecap", "round");
  iconEl.setAttribute("stroke-linejoin", "round");
  iconEl.setAttribute("class", "claudero-notice-icon");
  for (const d of iconPaths[kind].split("M").filter(Boolean)) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M" + d);
    iconEl.appendChild(path);
  }
  const content = createEl(doc, "div", "claudero-notice-content");
  const heading = createEl(doc, "strong", "claudero-notice-title");
  const body = createEl(doc, "div", "claudero-notice-body");
  heading.textContent = title;
  body.textContent = text;
  content.append(heading, body);
  card.append(iconEl as unknown as HTMLElement, content);
  if (action) {
    const button = createEl(doc, "button", "claudero-button primary-soft");
    button.textContent = action.label;
    button.addEventListener("click", () => action.onClick(button));
    content.appendChild(button);
  }
  state.transcript.appendChild(card);
  scrollTranscript(state);
}

function appendWelcomeCard(state: PaneState): void {
  const doc = state.root.ownerDocument!;
  const card = createEl(doc, "div", "claudero-welcome-card redesigned");
  const header = createEl(doc, "div", "claudero-welcome-header");
  const title = createEl(doc, "strong");
  const text = createEl(doc, "p");
  const suggestions = createEl(doc, "div", "claudero-suggestions redesigned");
  title.textContent = "What should we do with this paper?";
  text.textContent =
    "Choose a starter or ask directly. Claudero will use your selected Zotero item, open PDF, or highlighted text as context.";
  header.append(title, text);
  card.append(header, suggestions);
  state.transcript.appendChild(card);

  // Show first 4 prompts (customs first, then defaults), skip insert-note
  void loadCustomPrompts().then((customs) => {
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
      const button = createEl(doc, "button", "claudero-suggestion prompt-card");
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
      sub.textContent = p.description || "Custom prompt";
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
const STREAMING_RENDER_INTERVAL = 150;

const THINKING_WORDS = [
  "Analyzing",
  "Thinking",
  "Reading",
  "Processing",
  "Reviewing",
  "Computing",
  "Examining",
  "Evaluating",
  "Proofing",
  "Simmering",
  "Connecting dots",
  "Percolating",
  "Pondering",
];

function pickThinkingVerb(): string {
  return THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)]!;
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
  if (state.activityMessage) return compactActivityLabel(state.activityMessage);
  if (state.activityMode === "thinking") return "Thinking";
  if (state.activityMode === "tool") return "Working";
  if (state.activityMode === "waiting") return "Waiting";
  if (state.activityMode === "requesting") return "Sending";
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
  if (tokens > 0) parts.push(`↓ ${formatActivityTokens(tokens)} tokens`);
  if (state.activityMode === "thinking") {
    parts.push(`thinking with ${getSelectedEffort(state)} effort`);
  } else if (state.activityMode === "tool") {
    parts.push("tool use");
  } else if (state.activityMode === "waiting") {
    parts.push("waiting for input");
  } else if (
    state.recentThoughtDurationMs > 0 &&
    Date.now() < state.recentThoughtUntil
  ) {
    parts.push(
      `thought for ${Math.max(1, Math.round(state.recentThoughtDurationMs / 1000))}s`,
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
  indicator.setAttribute("title", "Press Esc to interrupt");
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
  const label = `Running · ${formatDuration(Math.max(0, Math.floor(elapsedSeconds)))}`;
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

// Claude's extended-thinking stream. Renders a collapsible "Thought for Ns"
// card (like Claudian) accumulating the reasoning text.
function appendThinkingDelta(state: PaneState, text: string): void {
  if (!text) return;
  setActivity(state, "thinking", "Thinking");
  state.turnResponseChars += text.length;
  startThinkingAnimation(state);
  let card = state.thinkingCard;
  if (!card) {
    const doc = state.root.ownerDocument!;
    const el = createEl(doc, "div", "claudero-thinking-card");
    const header = createEl(doc, "button", "claudero-thinking-header");
    header.setAttribute("tabindex", "-1");
    const labelSpan = createEl(doc, "span", "claudero-thinking-label");
    labelSpan.textContent = "Thinking…";
    const durationSpan = createEl(doc, "span", "claudero-thinking-duration");
    durationSpan.textContent = "(0s)";
    const chevron = createThinkingChevron(doc);
    header.append(labelSpan, durationSpan, chevron);
    const body = createEl(doc, "div", "claudero-thinking-body");
    header.addEventListener("click", () => el.classList.toggle("collapsed"));
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
  card.body.textContent = card.text.trim();
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
  setActivity(state, "thinking", "Thinking");
  startThinkingAnimation(state);
  state.thinkingCard.text = text;
  state.thinkingCard.body.textContent = text.trim();
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
  card.labelSpan.textContent = `Thought for ${sec}s`;
  card.durationSpan.textContent = "";
  // Auto-collapse once formal content follows
  card.el.classList.add("done", "collapsed");
  state.thinkingCard = null;
}

function updateStreamingBody(state: PaneState, force = false): void {
  if (!state.currentAssistantBody) return;
  const now = Date.now();
  if (force || now - state.lastStreamingRenderTs >= STREAMING_RENDER_INTERVAL) {
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
  if (card.querySelector(":scope > .claudero-thinking-indicator")) return false;
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

// Keep a Claude Code-style activity row visible even while answer text is
// streaming. In a narrow Zotero side pane the stable bottom row reassures the
// user that the turn is still alive while long Markdown is rendering.
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

function reconcileAssistantTextSnapshot(state: PaneState, text: string): void {
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

function appendAuthPrompt(state: PaneState, message: string): void {
  setStatusDot(state, "error");
  const label = providerLabel(normalizeProvider(state.providerSelect.value));
  appendNoticeCard(
    state,
    "auth",
    `${label} authentication required`,
    `${message}\n\n${label} is not authenticated or the request was rejected. You can log in, or set provider environment variables / HTTPS_PROXY in Claudero preferences.`,
    {
      label: `Login ${label}`,
      onClick: (button) => {
        button.disabled = true;
        runProviderAuthLogin()
          .then(() => {
            appendNoticeCard(
              state,
              "info",
              `${label} login opened`,
              "Complete the authentication flow in the Terminal window, then send your message again.",
            );
          })
          .catch((error: unknown) => {
            appendNoticeCard(
              state,
              "warning",
              `${label} login failed`,
              error instanceof Error ? error.message : String(error),
            );
          })
          .finally(() => {
            button.disabled = false;
          });
      },
    },
  );
}

function appendLimitPrompt(state: PaneState, message: string): void {
  setStatusDot(state, "error");
  appendNoticeCard(
    state,
    "warning",
    `${providerLabel(normalizeProvider(state.providerSelect.value))} session limit reached`,
    message,
  );
}

// ── New conversation ───────────────────────────────────────────────────────

function startNewConversation(state: PaneState): void {
  if (state.running) return;
  // Persist the current conversation before clearing the view so it stays in
  // history and can be reopened later.
  void saveConversation(state);
  clearConversationState(state);
  renderPendingImages(state);
  appendWelcomeCard(state);
  setStatusDot(state, "ready");
}

// ── Cancel / Stop ──────────────────────────────────────────────────────────

async function cancelPermissionRequest(state: PaneState): Promise<void> {
  try {
    const port = Number(getPref("helperPort") || 38660);
    const profilePath = Zotero.Profile.dir;
    const tokenPath = [profilePath, "claudero", "helper", ".token"].join("/");
    let token = "";
    try {
      token = (await (IOUtils as any).readUTF8(tokenPath)).trim();
    } catch {
      /* ignore */
    }
    await fetch(`http://127.0.0.1:${port}/cancel-permission`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    await fetch(`http://127.0.0.1:${port}/cancel-question`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    ztoolkit.log("[Claudero] Failed to cancel permission request:", e);
  }
}

function cancel(state: PaneState): void {
  state.cancelRequested = true;
  stopThinkingAnimation(state);
  hidePermissionDialog(state);
  hideQuestionDialog(state);
  if (state.permissionCheckTimer) {
    clearInterval(state.permissionCheckTimer);
    state.permissionCheckTimer = null;
  }
  void cancelPermissionRequest(state);
}

// ── Core send logic ────────────────────────────────────────────────────────

function buildHistorySection(turns: ConversationTurn[]): string {
  const trimmedTurns = turns
    .map((turn) => ({ ...turn, text: turn.text.trim() }))
    .filter((turn) => turn.text.length > 0)
    .slice(-16);
  if (trimmedTurns.length === 0) return "";
  const lines = trimmedTurns.map((turn) => {
    const role = turn.role === "user" ? "User" : "Assistant";
    return `<turn role="${role}">\n${turn.text}\n</turn>`;
  });
  return [
    "<conversation_history>",
    "The following turns are from this Claudero conversation. Use them as prior context for the current request.",
    ...lines,
    "</conversation_history>",
  ].join("\n");
}

function buildPromptWithConversationHistory(
  prompt: string,
  turns: ConversationTurn[],
): string {
  const history = buildHistorySection(turns);
  if (!history) return prompt;
  return [
    history,
    "",
    "<current_user_request>",
    prompt,
    "</current_user_request>",
  ].join("\n");
}

async function sendPrompt(
  state: PaneState,
  overridePrompt?: string,
  overrideImages?: PendingImage[],
  overrideContext?: ClauderoSelectionContext,
): Promise<void> {
  updateContext(state);
  const prompt = (overridePrompt ?? state.input.value).trim();
  const images = (overrideImages ?? state.pendingImages).map((img) => ({
    ...img,
  }));
  const provider = normalizeProvider(state.providerSelect.value);
  const capabilities = getProviderCapabilities(provider);
  if (images.length > 0 && !capabilities.supportsImageAttachments) {
    appendNoticeCard(
      state,
      "warning",
      `${providerLabel(provider)} image attachments unsupported`,
      "Switch provider or remove the images before sending.",
    );
    return;
  }
  // A Zotero context is no longer required — allow chatting with just text
  // and/or pasted images.
  if ((!prompt && images.length === 0) || state.running) return;

  state.input.value = "";
  state.pendingImages = [];
  renderPendingImages(state);
  // Save to input history
  state.inputHistory.unshift({ text: prompt, images });
  if (state.inputHistory.length > 50) state.inputHistory.length = 50;
  state.inputHistoryIdx = -1;
  state._inputHistorySavedText = "";
  state._inputHistorySavedImages = [];

  // SDK slash commands (starting with /) must be sent raw without wrapping
  // in Zotero context, or the CLI won't recognize them as commands.
  if (prompt.startsWith("/")) {
    void sendRawSlashCommand(state, prompt);
    return;
  }

  const userTs = Date.now();
  refreshEditableMessageActions(state);
  const userCard = appendUserMessage(state, prompt, images, { ts: userTs });
  state.currentAssistantBody = appendMessageCard(state, "assistant", "", {
    ts: Date.now(),
  });
  state.currentAssistantCard = state.currentAssistantBody.closest(
    ".claudero-message",
  ) as HTMLElement | null;
  state.lastAssistantText = "";
  state.currentSegmentText = "";
  state.lastStreamingRenderTs = 0;
  state.currentAssistantBlocks = [];
  state.currentProviderTurnId = undefined;
  state.currentProviderTurnId = undefined;
  state.currentContextSnapshot = null;
  state.thinkingTs = Date.now();
  state.turnStartedTs = userTs;
  state.turnOutputTokens = 0;
  state.turnResponseChars = 0;
  state.thinkingTokenEstimate = 0;
  state.thinkingVerb = "";
  state.activityMode = "requesting";
  state.activityMessage = "Sending";
  state.activityStartedTs = userTs;
  state.recentThoughtDurationMs = 0;
  state.recentThoughtUntil = 0;
  startThinkingAnimation(state);
  forceScrollToBottom(state); // always scroll to bottom when user sends a message
  state.cancelRequested = false;
  state.questionPollingUnsupported = false;
  setRunning(state, true);

  // Start permission check polling
  if (state.permissionCheckTimer) clearInterval(state.permissionCheckTimer);
  state.permissionCheckTimer = setInterval(() => {
    void checkPendingInteractions(state);
  }, 800) as unknown as number;

  let sawError = false;
  try {
    const context = overrideContext || (await getSelectedZoteroContext());
    if (!overrideContext) {
      // Apply dismissed flags and merge manually added items
      if (state.dismissedReader) context.reader = undefined;
      if (state.dismissedText) context.selectedText = "";
      if (state.dismissedAnnotations) context.selectedAnnotations = [];
      for (const mi of state.manualItems) {
        if (!context.items.find((i) => i.id === mi.id)) {
          const attIDs: number[] = (mi as any).getAttachments?.() ?? [];
          context.items.push({
            id: mi.id,
            key: mi.key,
            itemType: mi.itemType,
            title: String(mi.getField("title") || ""),
            creators: mi
              .getCreators()
              .map(
                (c: { firstName?: string; lastName?: string; name?: string }) =>
                  [c.firstName, c.lastName].filter(Boolean).join(" ") ||
                  c.name ||
                  "",
              )
              .filter(Boolean),
            date: String((mi as any).getField?.("date", true, true) || ""),
            publicationTitle: String(
              (mi as any).getField?.("publicationTitle", false, true) || "",
            ),
            abstractNote: String(mi.getField("abstractNote") || ""),
            url: String(mi.getField("url") || ""),
            DOI: String(mi.getField("DOI") || ""),
            tags: mi.getTags().map((t: { tag: string }) => t.tag),
            notes: [],
            attachments: attIDs
              .map((id) => {
                try {
                  const a = Zotero.Items.get(id);
                  return a
                    ? {
                        id: a.id,
                        key: a.key,
                        title: a.getDisplayTitle(),
                        contentType: a.attachmentContentType || "",
                      }
                    : null;
                } catch {
                  return null;
                }
              })
              .filter(
                Boolean,
              ) as import("./zoteroContext").ClauderoAttachmentContext[],
          });
        }
      }
    }
    state.currentContextSnapshot = context;
    const basePrompt = prompt || "(用户发送了图片，请查看)";
    const promptWithHistory = buildPromptWithConversationHistory(
      basePrompt,
      state.conversationTurns,
    );
    const fullPrompt = buildPromptWithZoteroContext(
      promptWithHistory,
      context,
      getZoteroApiSystemPrompt(),
    );
    const additionalDirectories = getAttachmentDirectories(context);
    for await (const event of queryClaudeHelper(fullPrompt, {
      provider,
      model: getSelectedModel(state),
      effort: getSelectedEffort(state),
      additionalDirectories,
      permissionMode: state.permissionMode,
      images: images.map((i) => ({ media_type: i.mediaType, data: i.data })),
      conversationId: state.conversationId,
      providerState: state.providerState,
    })) {
      if (state.cancelRequested) break;
      if (event.type === "session") {
        applyProviderSessionEvent(state, event.session);
      } else if (event.type === "ready") {
        setActivity(state, "responding");
      } else if (event.type === "thinking" && event.text) {
        // Lazily create assistant card so the thinking card has somewhere to
        // insert itself before (but only if one doesn't already exist).
        if (!state.currentAssistantBody) {
          state.currentAssistantBody = appendMessageCard(
            state,
            "assistant",
            "",
            { ts: Date.now() },
          );
          state.currentAssistantCard = state.currentAssistantBody.closest(
            ".claudero-message",
          ) as HTMLElement | null;
          state.currentSegmentText = "";
          state.lastStreamingRenderTs = 0;
        }
        appendThinkingDelta(state, event.text);
        appendAssistantThinkingBlock(state, event.text);
      } else if (event.type === "thinking_snapshot" && event.text) {
        reconcileThinkingSnapshot(state, event.text);
      } else if (event.type === "text_delta" && event.text) {
        if (state._suppressText > 0) continue;
        ensureStreamingAssistantBody(state);
        finalizeThinkingCard(state);
        startThinkingAnimation(state);
        mergeAssistantText(state, event.text);
        updateStreamingBody(state);
      } else if (event.type === "text_snapshot" && event.text) {
        if (state._suppressText > 0) continue;
        ensureStreamingAssistantBody(state);
        finalizeThinkingCard(state);
        startThinkingAnimation(state);
        reconcileAssistantTextSnapshot(state, event.text);
      } else if (event.type === "text" && event.text) {
        if (state._suppressText > 0) {
          // Skill output — don't render as assistant text
          continue;
        }
        // Lazily create assistant card on first text (avoids empty nodes after
        // tool results when no text ever follows).
        if (!state.currentAssistantBody) {
          state.currentAssistantBody = appendMessageCard(
            state,
            "assistant",
            "",
            { ts: Date.now() },
          );
          state.currentAssistantCard = state.currentAssistantBody.closest(
            ".claudero-message",
          ) as HTMLElement | null;
          state.currentSegmentText = "";
          state.lastStreamingRenderTs = 0;
          state.thinkingTs = Date.now();
          startThinkingAnimation(state);
        }
        if (state._suppressText > 0) continue;
        finalizeThinkingCard(state);
        startThinkingAnimation(state);
        await animateAssistantText(state, event.text);
      } else if (event.type === "tool_use" && event.tool) {
        finalizeThinkingCard(state);
        finalizeAssistantThinkingBlock(state, Date.now() - state.thinkingTs);
        const skillIntroCard = state.currentAssistantCard;
        finalizeAssistantBody(state);
        if (event.tool.name !== "Skill") commitCurrentAssistantTextBlock(state);
        removeEmptyCurrentAssistantMessage(state);
        state.currentSegmentText = "";
        appendToolCard(state, event.tool);
        updateActivityForTool(state, event.tool);
        syncSpinnerForTool(state, event.tool.name);
        pushAssistantBlock(state, {
          type: "tool_use",
          id: event.tool.id,
          name: event.tool.name,
          input: event.tool.input,
          partialInput: event.tool.partialInput,
        });
        if (event.tool.name === "Skill") {
          state._suppressText++;
          state._activeSkillToolId = event.tool.id;
          if (skillIntroCard) skillIntroCard.remove();
          state.lastAssistantText = "";
        }
        if (event.tool.name === "AskUserQuestion" && event.tool.input) {
          const input = event.tool.input as { questions?: unknown[] };
          if (Array.isArray(input.questions)) {
            showQuestionDialog(state, {
              toolUseId: event.tool.id,
              questions:
                input.questions as import("./permissionDialog").AskUserQuestionItem[],
            });
            stopThinkingAnimation(state);
          }
        }
        if (
          event.tool.name === "ExitPlanMode" &&
          event.tool.input &&
          typeof event.tool.input === "object"
        ) {
          showExitPlanDialog(state, {
            toolUseId: event.tool.id,
            input: event.tool.input as Record<string, unknown>,
          });
          stopThinkingAnimation(state);
        }
      } else if (event.type === "tool_use_delta" && event.tool) {
        finalizeAssistantBody(state);
        removeEmptyCurrentAssistantMessage(state);
        appendToolCard(state, event.tool);
        updateActivityForTool(state, event.tool);
        syncSpinnerForTool(state, event.tool.name);
        const existing = state.currentAssistantBlocks.find(
          (block) => block.type === "tool_use" && block.id === event.tool?.id,
        );
        if (existing?.type === "tool_use") {
          const previousLength = existing.partialInput?.length || 0;
          const nextLength = event.tool.partialInput?.length || 0;
          state.turnResponseChars += Math.max(0, nextLength - previousLength);
          updateThinkingAnimation(state);
          existing.input = event.tool.input;
          existing.partialInput = event.tool.partialInput;
        }
        if (event.tool.name === "AskUserQuestion" && event.tool.input) {
          const input = event.tool.input as { questions?: unknown[] };
          if (Array.isArray(input.questions)) {
            showQuestionDialog(state, {
              toolUseId: event.tool.id,
              questions:
                input.questions as import("./permissionDialog").AskUserQuestionItem[],
            });
            stopThinkingAnimation(state);
          }
        }
        if (
          event.tool.name === "ExitPlanMode" &&
          event.tool.input &&
          typeof event.tool.input === "object"
        ) {
          showExitPlanDialog(state, {
            toolUseId: event.tool.id,
            input: event.tool.input as Record<string, unknown>,
          });
          stopThinkingAnimation(state);
        }
      } else if (event.type === "tool_result" && event.result) {
        hideQuestionDialog(state);
        appendToolResult(state, event.result);
        pushAssistantBlock(state, {
          type: "tool_result",
          id: event.result.id,
          content: event.result.content,
          isError: event.result.isError,
        });
        maybeAppendUndoCard(state, event.result);
        if (
          state._activeSkillToolId === event.result.id &&
          state._suppressText > 0
        ) {
          state._suppressText = 0;
          state._activeSkillToolId = null;
        }
        removeEmptyCurrentAssistantMessage(state);
        state.currentAssistantBody = null;
        state.currentAssistantCard = null;
        state.currentSegmentText = "";
        state.lastStreamingRenderTs = 0;
        state.thinkingTs = Date.now();
        setActivity(state, "responding");
        startThinkingAnimation(state);
      } else if (event.type === "usage" && event.usage) {
        updateTurnUsage(state, event.usage);
      } else if (
        event.type === "thinking_tokens" &&
        typeof event.estimatedTokens === "number"
      ) {
        state.thinkingTokenEstimate = Math.max(0, event.estimatedTokens);
        setActivity(state, "thinking", "Thinking");
        if (!state.thinkingCard) startThinkingAnimation(state);
        else updateThinkingAnimation(state);
      } else if (
        event.type === "tool_progress" &&
        event.toolUseId &&
        typeof event.elapsedSeconds === "number"
      ) {
        updateToolProgress(state, event.toolUseId, event.elapsedSeconds);
      } else if (
        event.type === "commands_changed" &&
        Array.isArray(event.commands)
      ) {
        // Skill was installed mid-session — refresh the slash command cache
        _sdkCommandsCache = event.commands.map((c) => ({
          name: c.name,
          description: c.description,
          isBuiltin: false,
          argumentHint: c.argumentHint,
        }));
      } else if (event.type === "done") {
        stopThinkingAnimation(state);
        finalizeThinkingCard(state);
        finalizeAssistantThinkingBlock(state, Date.now() - state.thinkingTs);
        // Flush chunks skipped by the streaming render throttle before the
        // message is persisted and action buttons are attached.
        finalizeAssistantBody(state);
        removeEmptyCurrentAssistantMessage(state);
        if (
          !state.lastAssistantText.trim() &&
          state.currentAssistantBlocks.some(
            (block) => block.type === "thinking" || block.type === "tool_use",
          )
        ) {
          appendNoticeCard(
            state,
            "warning",
            "No final response",
            "Claude finished its tools and thinking without returning final text. Try sending “继续” to resume this turn.",
          );
        }
        // Remove streaming class before adding action buttons
        state.currentAssistantCard?.classList.remove("streaming");
        // Append "* Baked for Xs" footer to the last assistant card
        const durationSeconds = Math.floor((Date.now() - userTs) / 1000);
        if (durationSeconds > 0 && state.currentAssistantCard) {
          const doc = state.currentAssistantCard.ownerDocument!;
          const footer = createEl(doc, "div", "claudero-response-footer");
          footer.textContent = `* ${pickFlavorWord()} for ${formatDuration(durationSeconds)}`;
          state.currentAssistantCard.appendChild(footer);
        }
        // Record this turn and persist.
        const userTurnIndex = state.conversationTurns.length;
        state.conversationTurns.push({
          role: "user",
          text: prompt || "(图片)",
          ts: userTs,
          images: cloneImages(images),
          contextSnapshot: state.currentContextSnapshot,
          provider: normalizeProvider(state.providerSelect.value),
        });
        attachMessageActions(state, userCard, "user", prompt || "(图片)", {
          ts: userTs,
          turnIndex: userTurnIndex,
          editable: true,
          contextSnapshot: state.currentContextSnapshot,
        });
        if (state.lastAssistantText) {
          const assistantTs = Date.now();
          const assistantTurnIndex = state.conversationTurns.length;
          const blocks = state.currentAssistantBlocks.slice();
          if (state.currentSegmentText) {
            blocks.push({ type: "text", text: state.currentSegmentText });
          }
          state.conversationTurns.push({
            role: "assistant",
            text: state.lastAssistantText,
            ts: assistantTs,
            blocks,
            model: getSelectedModel(state),
            effort: getSelectedEffort(state),
            durationMs: assistantTs - userTs,
            contextSnapshot: state.currentContextSnapshot,
            assistantMessageId: state.currentProviderTurnId,
            provider: normalizeProvider(state.providerSelect.value),
          });
          if (state.currentAssistantCard) {
            attachMessageActions(
              state,
              state.currentAssistantCard,
              "assistant",
              state.lastAssistantText,
              { ts: assistantTs, turnIndex: assistantTurnIndex },
            );
          }
        } else if (state.currentAssistantBlocks.length > 0) {
          const assistantTs = Date.now();
          state.conversationTurns.push({
            role: "assistant",
            text: "",
            ts: assistantTs,
            blocks: state.currentAssistantBlocks.slice(),
            model: getSelectedModel(state),
            effort: getSelectedEffort(state),
            durationMs: assistantTs - userTs,
            contextSnapshot: state.currentContextSnapshot,
            assistantMessageId: state.currentProviderTurnId,
            provider: normalizeProvider(state.providerSelect.value),
          });
        }
        const savePromise = saveConversation(state);
        if (userTurnIndex === 0 && state.lastAssistantText) {
          void savePromise.then(() =>
            generateConversationTitle(
              state.conversationId,
              prompt || "(图片)",
              state.lastAssistantText,
            ),
          );
        }
        void reloadSlashCommands().then((cmds) => {
          if (cmds.length > 0) {
            _sdkCommandsCache = cmds.map((c) => ({
              name: c.name,
              description: c.description,
              isBuiltin: false,
              argumentHint: c.argumentHint,
            }));
          }
        });
      } else if (event.type === "error") {
        sawError = true;
        const message =
          event.error ||
          `${providerLabel(normalizeProvider(state.providerSelect.value))} query failed.`;
        if (isClaudeLimitError(message)) {
          appendLimitPrompt(state, message);
        } else if (isClaudeAuthError(message)) {
          appendAuthPrompt(state, message);
        } else {
          appendNoticeCard(
            state,
            "warning",
            `${providerLabel(normalizeProvider(state.providerSelect.value))} error`,
            message,
          );
          setStatusDot(state, "error");
        }
      }
    }
  } catch (error) {
    sawError = true;
    const message = error instanceof Error ? error.message : String(error);
    if (isClaudeLimitError(message)) {
      appendLimitPrompt(state, message);
    } else if (isClaudeAuthError(message)) {
      appendAuthPrompt(state, message);
    } else {
      appendNoticeCard(state, "warning", "Claudero error", message);
      setStatusDot(state, "error");
    }
  } finally {
    state.cancelRequested = false;
    stopThinkingAnimation(state);
    finalizeThinkingCard(state);
    finalizeAssistantBody(state);
    removeEmptyCurrentAssistantMessage(state);
    state.currentAssistantCard?.classList.remove("streaming");
    state.currentAssistantBody = null;
    state.currentAssistantCard = null;
    state.currentSegmentText = "";
    state.currentAssistantBlocks = [];
    state.currentContextSnapshot = null;
    state._suppressText = 0;
    state._activeSkillToolId = null;
    state.running = false;
    state.modelSelect.disabled = false;
    state.effortSelect.disabled = false;
    updateContext(state);
    updateSendButton(state, false);
    if (!sawError) setStatusDot(state, "ready");
  }
}

// Send a real Claude Code SDK slash command (e.g. "/compact", "/usage") without
// any context wrapping. The raw text is passed straight to the SDK so the CLI
// recognises it as a slash command rather than a user question.
async function sendRawSlashCommand(
  state: PaneState,
  command: string,
): Promise<void> {
  if (state.running) return;

  refreshEditableMessageActions(state);
  const userTs = Date.now();
  const userCard = appendUserMessage(state, command, [], { ts: userTs });
  state.currentAssistantBody = null;
  state.currentAssistantCard = null;
  state.lastAssistantText = "";
  state.currentSegmentText = "";
  state.lastStreamingRenderTs = 0;
  state.currentAssistantBlocks = [];
  state.currentContextSnapshot = null;
  state.thinkingTs = Date.now();
  state.turnStartedTs = userTs;
  state.turnOutputTokens = 0;
  state.turnResponseChars = 0;
  state.thinkingTokenEstimate = 0;
  state.thinkingVerb = "";
  state.activityMode = "requesting";
  state.activityMessage = "Sending";
  state.activityStartedTs = userTs;
  state.recentThoughtDurationMs = 0;
  state.recentThoughtUntil = 0;
  startThinkingAnimation(state);
  forceScrollToBottom(state);
  state.cancelRequested = false;
  state.questionPollingUnsupported = false;
  setRunning(state, true);

  if (state.permissionCheckTimer) clearInterval(state.permissionCheckTimer);
  state.permissionCheckTimer = setInterval(() => {
    void checkPendingInteractions(state);
  }, 800) as unknown as number;

  let sawError = false;
  try {
    for await (const event of queryClaudeHelper(command, {
      provider: normalizeProvider(state.providerSelect.value),
      model: getSelectedModel(state),
      effort: getSelectedEffort(state),
      permissionMode: state.permissionMode,
      conversationId: state.conversationId,
      providerState: state.providerState,
    })) {
      if (state.cancelRequested) break;
      if (event.type === "session") {
        applyProviderSessionEvent(state, event.session);
      } else if (event.type === "thinking" && event.text) {
        if (!state.currentAssistantBody) {
          state.currentAssistantBody = appendMessageCard(
            state,
            "assistant",
            "",
            { ts: Date.now() },
          );
          state.currentAssistantCard = state.currentAssistantBody.closest(
            ".claudero-message",
          ) as HTMLElement | null;
          state.currentSegmentText = "";
          state.lastStreamingRenderTs = 0;
        }
        appendThinkingDelta(state, event.text);
        appendAssistantThinkingBlock(state, event.text);
      } else if (event.type === "thinking_snapshot" && event.text) {
        reconcileThinkingSnapshot(state, event.text);
      } else if (event.type === "text_delta" && event.text) {
        if (state._suppressText > 0) continue;
        ensureStreamingAssistantBody(state);
        finalizeThinkingCard(state);
        startThinkingAnimation(state);
        mergeAssistantText(state, event.text);
        updateStreamingBody(state);
      } else if (event.type === "text_snapshot" && event.text) {
        if (state._suppressText > 0) continue;
        ensureStreamingAssistantBody(state);
        finalizeThinkingCard(state);
        startThinkingAnimation(state);
        reconcileAssistantTextSnapshot(state, event.text);
      } else if (event.type === "text" && event.text) {
        if (state._suppressText > 0) continue;
        if (!state.currentAssistantBody) {
          state.currentAssistantBody = appendMessageCard(
            state,
            "assistant",
            "",
            { ts: Date.now() },
          );
          state.currentAssistantCard = state.currentAssistantBody.closest(
            ".claudero-message",
          ) as HTMLElement | null;
          state.currentSegmentText = "";
          state.lastStreamingRenderTs = 0;
          state.thinkingTs = Date.now();
          startThinkingAnimation(state);
        }
        finalizeThinkingCard(state);
        startThinkingAnimation(state);
        await animateAssistantText(state, event.text);
      } else if (event.type === "tool_use" && event.tool) {
        finalizeThinkingCard(state);
        finalizeAssistantThinkingBlock(state, Date.now() - state.thinkingTs);
        const skillIntroCard = state.currentAssistantCard;
        finalizeAssistantBody(state);
        if (event.tool.name !== "Skill") commitCurrentAssistantTextBlock(state);
        removeEmptyCurrentAssistantMessage(state);
        state.currentSegmentText = "";
        appendToolCard(state, event.tool);
        updateActivityForTool(state, event.tool);
        syncSpinnerForTool(state, event.tool.name);
        pushAssistantBlock(state, {
          type: "tool_use",
          id: event.tool.id,
          name: event.tool.name,
          input: event.tool.input,
          partialInput: event.tool.partialInput,
        });
        if (event.tool.name === "Skill") {
          state._suppressText++;
          state._activeSkillToolId = event.tool.id;
          if (skillIntroCard) skillIntroCard.remove();
          state.lastAssistantText = "";
        }
        if (event.tool.name === "AskUserQuestion" && event.tool.input) {
          const input = event.tool.input as { questions?: unknown[] };
          if (Array.isArray(input.questions)) {
            showQuestionDialog(state, {
              toolUseId: event.tool.id,
              questions:
                input.questions as import("./permissionDialog").AskUserQuestionItem[],
            });
            stopThinkingAnimation(state);
          }
        }
        if (
          event.tool.name === "ExitPlanMode" &&
          event.tool.input &&
          typeof event.tool.input === "object"
        ) {
          showExitPlanDialog(state, {
            toolUseId: event.tool.id,
            input: event.tool.input as Record<string, unknown>,
          });
          stopThinkingAnimation(state);
        }
      } else if (event.type === "tool_use_delta" && event.tool) {
        finalizeAssistantBody(state);
        removeEmptyCurrentAssistantMessage(state);
        appendToolCard(state, event.tool);
        updateActivityForTool(state, event.tool);
        syncSpinnerForTool(state, event.tool.name);
        const existing = state.currentAssistantBlocks.find(
          (block) => block.type === "tool_use" && block.id === event.tool?.id,
        );
        if (existing?.type === "tool_use") {
          const previousLength = existing.partialInput?.length || 0;
          const nextLength = event.tool.partialInput?.length || 0;
          state.turnResponseChars += Math.max(0, nextLength - previousLength);
          updateThinkingAnimation(state);
          existing.input = event.tool.input;
          existing.partialInput = event.tool.partialInput;
        }
        if (event.tool.name === "AskUserQuestion" && event.tool.input) {
          const input = event.tool.input as { questions?: unknown[] };
          if (Array.isArray(input.questions)) {
            showQuestionDialog(state, {
              toolUseId: event.tool.id,
              questions:
                input.questions as import("./permissionDialog").AskUserQuestionItem[],
            });
            stopThinkingAnimation(state);
          }
        }
        if (
          event.tool.name === "ExitPlanMode" &&
          event.tool.input &&
          typeof event.tool.input === "object"
        ) {
          showExitPlanDialog(state, {
            toolUseId: event.tool.id,
            input: event.tool.input as Record<string, unknown>,
          });
          stopThinkingAnimation(state);
        }
      } else if (event.type === "tool_result" && event.result) {
        hideQuestionDialog(state);
        appendToolResult(state, event.result);
        pushAssistantBlock(state, {
          type: "tool_result",
          id: event.result.id,
          content: event.result.content,
          isError: event.result.isError,
        });
        maybeAppendUndoCard(state, event.result);
        if (
          state._activeSkillToolId === event.result.id &&
          state._suppressText > 0
        ) {
          state._suppressText = 0;
          state._activeSkillToolId = null;
        }
        removeEmptyCurrentAssistantMessage(state);
        state.currentAssistantBody = null;
        state.currentAssistantCard = null;
        state.currentSegmentText = "";
        state.lastStreamingRenderTs = 0;
        state.thinkingTs = Date.now();
        setActivity(state, "responding");
        startThinkingAnimation(state);
      } else if (event.type === "usage" && event.usage) {
        updateTurnUsage(state, event.usage);
      } else if (
        event.type === "thinking_tokens" &&
        typeof event.estimatedTokens === "number"
      ) {
        state.thinkingTokenEstimate = Math.max(0, event.estimatedTokens);
        setActivity(state, "thinking", "Thinking");
        if (!state.thinkingCard) startThinkingAnimation(state);
        else updateThinkingAnimation(state);
      } else if (
        event.type === "tool_progress" &&
        event.toolUseId &&
        typeof event.elapsedSeconds === "number"
      ) {
        updateToolProgress(state, event.toolUseId, event.elapsedSeconds);
      } else if (
        event.type === "commands_changed" &&
        Array.isArray(event.commands)
      ) {
        _sdkCommandsCache = event.commands.map((c) => ({
          name: c.name,
          description: c.description,
          isBuiltin: false,
          argumentHint: c.argumentHint,
        }));
      } else if (event.type === "done") {
        stopThinkingAnimation(state);
        finalizeThinkingCard(state);
        finalizeAssistantThinkingBlock(state, Date.now() - state.thinkingTs);
        finalizeAssistantBody(state);
        removeEmptyCurrentAssistantMessage(state);
        // Remove streaming class before adding action buttons
        state.currentAssistantCard?.classList.remove("streaming");
        const durationSeconds = Math.floor((Date.now() - userTs) / 1000);
        if (durationSeconds > 0 && state.currentAssistantCard) {
          const doc = state.currentAssistantCard.ownerDocument!;
          const footer = createEl(doc, "div", "claudero-response-footer");
          footer.textContent = `* ${pickFlavorWord()} for ${formatDuration(durationSeconds)}`;
          state.currentAssistantCard.appendChild(footer);
        }
        const userTurnIndex = state.conversationTurns.length;
        state.conversationTurns.push({
          role: "user",
          text: command,
          ts: userTs,
          provider: normalizeProvider(state.providerSelect.value),
        });
        attachMessageActions(state, userCard, "user", command, {
          ts: userTs,
          turnIndex: userTurnIndex,
          editable: true,
        });
        if (state.lastAssistantText) {
          const assistantTs = Date.now();
          const assistantTurnIndex = state.conversationTurns.length;
          const blocks = state.currentAssistantBlocks.slice();
          if (state.currentSegmentText) {
            blocks.push({ type: "text", text: state.currentSegmentText });
          }
          state.conversationTurns.push({
            role: "assistant",
            text: state.lastAssistantText,
            ts: assistantTs,
            blocks,
            model: getSelectedModel(state),
            effort: getSelectedEffort(state),
            durationMs: assistantTs - userTs,
            assistantMessageId: state.currentProviderTurnId,
            provider: normalizeProvider(state.providerSelect.value),
          });
          if (state.currentAssistantCard) {
            attachMessageActions(
              state,
              state.currentAssistantCard,
              "assistant",
              state.lastAssistantText,
              { ts: assistantTs, turnIndex: assistantTurnIndex },
            );
          }
        } else if (state.currentAssistantBlocks.length > 0) {
          const assistantTs = Date.now();
          state.conversationTurns.push({
            role: "assistant",
            text: "",
            ts: assistantTs,
            blocks: state.currentAssistantBlocks.slice(),
            model: getSelectedModel(state),
            effort: getSelectedEffort(state),
            durationMs: assistantTs - userTs,
            assistantMessageId: state.currentProviderTurnId,
            provider: normalizeProvider(state.providerSelect.value),
          });
        }
        if (command.trim() === "/compact") {
          state.compactedAt = Date.now();
        }
        const savePromise = saveConversation(state);
        if (userTurnIndex === 0 && state.lastAssistantText) {
          void savePromise.then(() =>
            generateConversationTitle(
              state.conversationId,
              command,
              state.lastAssistantText,
            ),
          );
        }
        void reloadSlashCommands().then((cmds) => {
          if (cmds.length > 0) {
            _sdkCommandsCache = cmds.map((c) => ({
              name: c.name,
              description: c.description,
              isBuiltin: false,
              argumentHint: c.argumentHint,
            }));
          }
        });
      } else if (event.type === "error") {
        sawError = true;
        const message =
          event.error ||
          `${providerLabel(normalizeProvider(state.providerSelect.value))} query failed.`;
        if (isClaudeLimitError(message)) appendLimitPrompt(state, message);
        else if (isClaudeAuthError(message)) appendAuthPrompt(state, message);
        else {
          appendNoticeCard(
            state,
            "warning",
            `${providerLabel(normalizeProvider(state.providerSelect.value))} error`,
            message,
          );
          setStatusDot(state, "error");
        }
      }
    }
  } catch (error) {
    sawError = true;
    const message = error instanceof Error ? error.message : String(error);
    if (isClaudeLimitError(message)) appendLimitPrompt(state, message);
    else if (isClaudeAuthError(message)) appendAuthPrompt(state, message);
    else {
      appendNoticeCard(state, "warning", "Claudero error", message);
      setStatusDot(state, "error");
    }
  } finally {
    state.cancelRequested = false;
    stopThinkingAnimation(state);
    finalizeThinkingCard(state);
    finalizeAssistantBody(state);
    removeEmptyCurrentAssistantMessage(state);
    state.currentAssistantCard?.classList.remove("streaming");
    state.currentAssistantBody = null;
    state.currentAssistantCard = null;
    state.currentSegmentText = "";
    state.currentAssistantBlocks = [];
    state.currentContextSnapshot = null;
    state._suppressText = 0;
    state._activeSkillToolId = null;
    state.running = false;
    state.modelSelect.disabled = false;
    state.effortSelect.disabled = false;
    updateContext(state);
    updateSendButton(state, false);
    if (!sawError) setStatusDot(state, "ready");
  }
}

async function insertAssistantNote(state: PaneState): Promise<void> {
  updateContext(state);
  const item = state.currentItem;
  const text = state.lastAssistantText.trim();
  if (!item) {
    appendNoticeCard(
      state,
      "info",
      "No Zotero item selected",
      "Select a Zotero item first.",
    );
    return;
  }
  if (!text) {
    appendNoticeCard(
      state,
      "info",
      "No response yet",
      "Ask Claudero a question before inserting a note.",
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
    "Inserted note",
    "Inserted response as a child note.",
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
  doc.getElementById(PANEL_ID)?.remove();
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
  statusDot.setAttribute("title", "Ready");
  statusDot.setAttribute("aria-label", "Ready");
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

  const newChatBtn = createToolbarBtn("New conversation", onNewChat);
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
  const historyBtn = createToolbarBtn("Conversation history", onHistory);
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
  const closeBtn = createToolbarBtn("Hide Claudero", onClose);
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

function showHistoryPopup(state: PaneState): void {
  showConversationHistoryPopup(state, {
    onRestore: (conv) => restoreConversation(state, conv),
    onDelete: (conv) => deleteConversationFromHistory(state, conv),
    onAutoRename: async (conv) => {
      const latestTitle = await getConversationTitle(conv.id);
      if (latestTitle && latestTitle !== conv.title) {
        ztoolkit.log(
          `[AI Rename] refreshing stale history title id=${conv.id} ui=${JSON.stringify(conv.title)} disk=${JSON.stringify(latestTitle)}`,
        );
        conv.title = latestTitle;
      }
      const firstUser =
        conv.turns.find((t) => t.role === "user" && t.text.trim())?.text ||
        conv.title ||
        "";
      const firstAssistant =
        conv.turns.find((t) => t.role === "assistant" && t.text.trim())?.text ||
        "";
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
  conv: SavedConversation,
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

async function refinePromptWithClaude(input: {
  label: string;
  description: string;
  text: string;
}): Promise<Partial<Pick<CustomPrompt, "label" | "description" | "text">>> {
  const systemPrompt = [
    "You refine reusable prompts for an academic Zotero assistant named Claudero.",
    "Improve clarity, specificity, and reliability without making the prompt verbose.",
    "Return ONLY compact JSON with keys: label, description, text.",
    "Keep label short. Keep description under 90 characters. Preserve the user's intent.",
  ].join("\n");
  const raw = await runAuxClaudeQuery(JSON.stringify(input, null, 2), {
    systemPrompt,
    model: String(
      normalizeProvider(getPref("provider")) === "codex"
        ? getPref("codexModel") || "gpt-5.4-mini"
        : getPref("claudeModel") || getPref("model") || "haiku",
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
        normalizeProvider(getPref("provider")) === "codex"
          ? getPref("codexModel") || "gpt-5.4-mini"
          : "haiku",
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
  const match = input.value.match(/^\/(\w*)$/);
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
        (c) => c.name.includes(q) || c.description.toLowerCase().includes(q),
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
    const allCmds = [...BUILTIN_SLASH_COMMANDS, ..._sdkCommandsCache];
    renderSlashPopup(state, allCmds, query, existing);
    return;
  }

  // Show built-ins immediately while SDK commands load
  renderSlashPopup(state, BUILTIN_SLASH_COMMANDS, query, existing);

  if (!_sdkCommandsFetching) {
    _sdkCommandsFetching = true;
    void fetchSlashCommands().then((sdkCmds) => {
      _sdkCommandsFetching = false;
      // Only cache if we got real results; empty means session not ready → retry next time
      if (sdkCmds.length > 0) {
        _sdkCommandsCache = sdkCmds.map((c) => ({
          name: c.name,
          description: c.description,
          isBuiltin: false,
          argumentHint: c.argumentHint,
        }));
      }
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
        const allCmds = [...BUILTIN_SLASH_COMMANDS, ..._sdkCommandsCache!];
        renderSlashPopup(state, allCmds, currentQuery, currentPopup);
      }
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
  searchInput.textContent = "From Library...";
  searchRow.appendChild(searchInput);
  popup.appendChild(searchRow);

  searchRow.addEventListener("click", () => {
    popup.remove();
    // Defer to avoid blocking any ongoing event
    (win as Window).setTimeout(() => showItemPicker(state), 0);
  });

  // Section header for open PDFs
  const section = createEl(doc, "div", "claudero-at-section");
  section.textContent = "Open PDFs";
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
    actionBtn.title = isAdded ? "Remove from context" : "Add to context";
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
          state.input.disabled = !hasCtx;
          state.sendButton.disabled = !state.running && !hasCtx;
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
    empty.textContent = "No open PDFs";
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
}

function hideItemPicker(state: PaneState): void {
  state.pickerEl?.remove();
  state.pickerEl = null;
}

function createComposer(doc: Document) {
  const provider = normalizeProvider(getPref("provider"));
  return createComposerView<PaneState>(doc, {
    providerOptions: PROVIDER_OPTIONS,
    modelOptions: modelOptionsForProvider(provider),
    effortOptions: CLAUDE_EFFORT_OPTIONS,
    permissionOptions: permissionOptionsForProvider(provider),
    defaultProvider: provider,
    defaultModel: defaultModelForProvider(provider),
    defaultEffort: defaultEffortForProvider(provider),
    defaultPermission: normalizePermissionMode(getPref("permissionMode")),
    onProviderChange: (value) => {
      // resolved by setProvider closure after state is built
      (createComposer as any)._onProviderChange?.(value);
    },
    onModelChange: (value) => {
      const active = normalizeProvider(getPref("provider"));
      setPref(active === "codex" ? "codexModel" : "claudeModel", value);
      setPref("model", value);
    },
    onEffortChange: (value) => {
      const active = normalizeProvider(getPref("provider"));
      setPref(active === "codex" ? "codexEffort" : "claudeEffort", value);
      setPref("effort", value);
    },
    onPermissionChange: (value) => {
      // resolved by setPermissionMode closure after state is built
      (createComposer as any)._onPermissionChange?.(value);
    },
    onAtClick: (state) => showItemPickerPopup(state),
    onMagicClick: (state, anchor) => showMagicPopup(state, anchor),
    onInputChanged: (state) => updateSlashPopup(state),
    onAtTyped: (state) => {
      Zotero.getMainWindow().setTimeout(() => showItemPickerPopup(state), 0);
    },
    onPasteImages: (state, files) => void addPastedImageFiles(state, files),
  });
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
    providerSelect: composer.providerSelect,
    modelSelect: composer.modelSelect,
    effortSelect: composer.effortSelect,
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
  };
  paneStates.set(host, state);
  composer.setStateRef(state);

  // Scroll-to-bottom button — appears when user scrolls up during streaming
  const scrollToBottomBtn = createEl(
    doc,
    "button",
    "claudero-scroll-to-bottom",
  );
  scrollToBottomBtn.setAttribute("title", "Scroll to bottom");
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

  const setProvider = (value: string) => {
    const provider = normalizeProvider(value);
    state.providerSelect.value = provider;
    setPref("provider", provider);
    const model = defaultModelForProvider(provider);
    const effort = defaultEffortForProvider(provider);
    state.modelSelect.setItems?.(modelOptionsForProvider(provider), model);
    state.effortSelect.value = effort;
    state.permissionSelect.setItems?.(
      permissionOptionsForProvider(provider),
      state.permissionMode,
    );
    setPref("model", model);
    setPref("effort", effort);
    _sdkCommandsCache = null;
    updatePermissionBadge(state);
    setStatusDot(state, "ready");
  };
  (createComposer as any)._onProviderChange = setProvider;

  // Permission mode toggle function
  const setPermissionMode = (mode: PaneState["permissionMode"]) => {
    state.permissionMode = mode;
    setPref("permissionMode", mode);
    updatePermissionBadge(state);
  };
  // Wire the permission menulist in the toolbar to setPermissionMode
  (createComposer as any)._onPermissionChange = setPermissionMode;

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
      state.pendingImages = entry.images.map((img) => ({ ...img }));
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
        state.pendingImages = state._inputHistorySavedImages.slice();
        renderPendingImages(state);
        state.inputHistoryIdx = -1;
        state._inputHistorySavedText = "";
        state._inputHistorySavedImages = [];
      } else {
        state.inputHistoryIdx--;
        const entry = state.inputHistory[state.inputHistoryIdx];
        state.input.value = entry.text;
        state.pendingImages = entry.images.map((img) => ({ ...img }));
        renderPendingImages(state);
        state.input.selectionStart = state.input.selectionEnd =
          state.input.value.length;
      }
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
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
        text: "Claudero cannot find a Zotero pane to attach to.",
        type: "fail",
      })
      .show();
    return;
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

  win.setInterval(() => {
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
}

export function registerClauderoToolbarButton(
  win: _ZoteroTypes.MainWindow,
  attempt = 0,
): void {
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
  button.setAttribute("tooltiptext", "Show or hide Claudero");
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
    label: "Ask Claudero",
    commandListener: () => {
      const item = getCurrentRegularItems()[0] ?? null;
      if (!item) {
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: "Select a regular item first.", type: "fail" })
          .show();
        return;
      }
      const win = Zotero.getMainWindow();
      showClauderoPanel(win);
    },
    icon: `chrome://${addon.data.config.addonRef}/content/icons/claudero.svg`,
  });
}

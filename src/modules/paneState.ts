import type { ProviderModelDescriptor } from "../shared/providerModels";
import type { ClauderoAnnotationContext } from "./zoteroContext";
import type {
  ConversationImage,
  ConversationTurn,
  ConversationBlock,
  ConversationProviderState,
} from "./conversationStore";
import type { ToolCardState } from "./toolCallRenderer";
import type { DivSelect } from "./composerView";
import type { ProviderModelRequest } from "./providerModelRequest";
import type { ConversationGenerationState } from "./conversationTransition";
import type { RecoveryManifest } from "./conversationRecovery";
import type { AiProvider } from "./providerRegistry";
// Shared contracts only; presentation modules never import the pane controller.
export type NoticeKind = "info" | "warning" | "auth" | "success";

export interface SlashCommand {
  name: string;
  description: string;
  isBuiltin: boolean; // true = client-side action only (e.g. clear)
  argumentHint?: string;
}

export interface PendingImage extends ConversationImage {
  data: string; // base64 (no data: prefix)
}

export interface InputHistoryEntry {
  text: string;
  images: PendingImage[];
}

export type PermissionMode =
  | "auto"
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

export type ActivityMode =
  | "requesting"
  | "responding"
  | "thinking"
  | "compacting"
  | "tool"
  | "waiting";

export interface PaneState extends ConversationGenerationState {
  root: HTMLElement;
  transcript: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  disposeComposer: () => void;
  providerSelect: DivSelect;
  modelSelect: DivSelect;
  effortSelect: DivSelect;
  codexModels: ProviderModelDescriptor[];
  modelCatalog?: ProviderModelRequest;
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
  recoveryManifest?: RecoveryManifest;
  pendingRecovery?: { conversationId: string; provider: AiProvider };
  requestController?: AbortController;
  finalizeRequest?: () => void;
  permissionPollController?: AbortController;
  permissionPollInFlight?: boolean;
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
  providerPrefObserverID: symbol | null;
}

export type CtxCategory =
  | "text"
  | "annotations"
  | "items"
  | "reader"
  | "collection";

export interface MessageRenderOptions {
  ts?: number;
  turnIndex?: number;
  editable?: boolean;
  contextSnapshot?: unknown;
  skipStreaming?: boolean; // If true, don't add streaming class even for assistant messages
}

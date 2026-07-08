import {
  listConversations,
  newConversationId,
  saveConversationData,
  type ConversationProviderState,
  type ConversationTurn,
  type SavedConversation,
} from "./conversationStore";

export interface ConversationState {
  transcript: HTMLElement;
  toolCards: Map<string, unknown>;
  conversationId: string;
  conversationTurns: ConversationTurn[];
  currentAssistantBlocks?: unknown[];
  currentContextSnapshot?: unknown | null;
  currentAssistantBody: HTMLElement | null;
  currentAssistantCard: HTMLElement | null;
  thinkingCard: unknown | null;
  lastAssistantText: string;
  pendingImages?: unknown[];
  providerState?: ConversationProviderState;
  parentConversationId?: string;
  forkedAtTurnIndex?: number;
  compactedAt?: number;
  currentProviderTurnId?: string;
}

export async function saveCurrentConversation(
  state: ConversationState,
): Promise<void> {
  await saveConversationData(state.conversationId, state.conversationTurns, {
    providerState: state.providerState,
    parentConversationId: state.parentConversationId,
    forkedAtTurnIndex: state.forkedAtTurnIndex,
    compactedAt: state.compactedAt,
  });
}

export function clearConversationState(state: ConversationState): void {
  state.transcript.textContent = "";
  state.toolCards.clear();
  state.lastAssistantText = "";
  state.conversationId = newConversationId();
  state.conversationTurns = [];
  if (state.currentAssistantBlocks) state.currentAssistantBlocks = [];
  state.currentContextSnapshot = null;
  state.currentAssistantBody = null;
  state.currentAssistantCard = null;
  state.thinkingCard = null;
  if (state.pendingImages) state.pendingImages = [];
  state.providerState = undefined;
  state.parentConversationId = undefined;
  state.forkedAtTurnIndex = undefined;
  state.compactedAt = undefined;
  state.currentProviderTurnId = undefined;
}

export function applyConversation(
  state: ConversationState,
  conv: SavedConversation,
): void {
  state.conversationId = conv.id;
  state.conversationTurns = Array.isArray(conv.turns) ? conv.turns : [];
  if (state.currentAssistantBlocks) state.currentAssistantBlocks = [];
  state.currentContextSnapshot = null;
  state.lastAssistantText = "";
  state.currentAssistantBody = null;
  state.currentAssistantCard = null;
  state.thinkingCard = null;
  state.providerState = conv.providerState;
  state.parentConversationId = conv.parentConversationId;
  state.forkedAtTurnIndex = conv.forkedAtTurnIndex;
  state.compactedAt = conv.compactedAt;
  state.currentProviderTurnId = undefined;
}

export async function loadLatestConversation(): Promise<SavedConversation | null> {
  const conversations = await listConversations();
  return conversations[0] || null;
}

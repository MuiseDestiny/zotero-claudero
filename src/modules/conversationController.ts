import {
  loadLatestSavedConversation,
  newConversationId,
  saveConversationData,
  type ConversationSaveResult,
  type ConversationProviderState,
  type ConversationTurn,
  type SavedConversation,
  type ConversationImage,
} from "./conversationStore";

import {
  invalidateConversation,
  type ConversationGenerationState,
} from "./conversationTransition";
import { snapshotConversationValue } from "./conversationSnapshot";
import type { RecoveryManifest } from "./conversationRecovery";
import { replaceImageDraft } from "./imageDraft";

export interface ConversationState extends ConversationGenerationState {
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
  pendingImages?: ConversationImage[];
  providerState?: ConversationProviderState;
  parentConversationId?: string;
  forkedAtTurnIndex?: number;
  compactedAt?: number;
  recoveryManifest?: RecoveryManifest;
  currentProviderTurnId?: string;
}

export async function saveCurrentConversation(
  state: ConversationState,
): Promise<ConversationSaveResult> {
  // Older records were written before per-turn session ids were persisted.
  // Backfill missing ids from the provider state at save time so Codex native
  // forks can verify that the retained turns belong to one thread.
  const turns = state.conversationTurns.map((turn) => {
    if (turn.sessionId || !turn.provider) return turn;
    const sessionId =
      turn.provider === "codex"
        ? state.providerState?.codex?.threadId
        : turn.provider === "deepseek"
          ? state.providerState?.deepseek?.sessionId
          : state.providerState?.claude?.sessionId;
    return sessionId ? { ...turn, sessionId } : turn;
  });
  return saveConversationData(state.conversationId, turns, {
    providerState: state.providerState,
    parentConversationId: state.parentConversationId,
    forkedAtTurnIndex: state.forkedAtTurnIndex,
    compactedAt: state.compactedAt,
    recoveryManifest: state.recoveryManifest,
  });
}

export function clearConversationState(state: ConversationState): void {
  invalidateConversation(state);
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
  if (state.pendingImages) replaceImageDraft(state);
  state.providerState = undefined;
  state.parentConversationId = undefined;
  state.forkedAtTurnIndex = undefined;
  state.compactedAt = undefined;
  state.recoveryManifest = undefined;
  state.currentProviderTurnId = undefined;
}

export function applyConversation(
  state: ConversationState,
  conv: SavedConversation,
): void {
  invalidateConversation(state);
  conv = snapshotConversationValue(conv);
  if (state.pendingImages) replaceImageDraft(state);
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
  state.recoveryManifest = conv.recoveryManifest;
  state.currentProviderTurnId = undefined;
}

export async function loadLatestConversation(): Promise<SavedConversation | null> {
  return loadLatestSavedConversation();
}

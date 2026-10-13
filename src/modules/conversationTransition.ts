export interface ConversationGenerationState {
  conversationId: string;
  conversationGeneration?: number;
  conversationTransition?: symbol;
  disposed?: boolean;
  running?: boolean;
  activeRequestId?: string;
}

export function captureConversationGuard(
  state: ConversationGenerationState,
): () => boolean {
  const id = state.conversationId;
  const generation = state.conversationGeneration || 0;
  return () =>
    !state.disposed &&
    state.conversationId === id &&
    (state.conversationGeneration || 0) === generation;
}

export function beginConversationTransition(
  state: ConversationGenerationState,
): { current: () => boolean; release: () => void } | null {
  if (state.disposed || state.running || state.conversationTransition)
    return null;
  const token = Symbol("conversation-transition");
  state.conversationTransition = token;
  const guard = captureConversationGuard(state);
  return {
    current: () => guard() && state.conversationTransition === token,
    release: () => {
      if (state.conversationTransition === token)
        state.conversationTransition = undefined;
    },
  };
}

export function invalidateConversation(
  state: ConversationGenerationState,
): void {
  state.conversationGeneration = (state.conversationGeneration || 0) + 1;
}

export function captureRequestGuard(
  state: ConversationGenerationState,
  requestId: string,
): () => boolean {
  const guard = captureConversationGuard(state);
  return () => guard() && state.activeRequestId === requestId;
}

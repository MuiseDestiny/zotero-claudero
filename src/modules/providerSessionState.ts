import type { ConversationProviderState } from "./conversationStore";

export interface ProviderSessionEvent {
  provider: "claude" | "codex" | "deepseek";
  sessionId?: string;
  threadId?: string;
  sessionFilePath?: string;
  turnId?: string;
}

export interface ProviderSessionTarget {
  providerState?: ConversationProviderState;
  currentProviderTurnId?: string;
}

export function mergeProviderSessionState(
  current: ConversationProviderState | undefined,
  session: ProviderSessionEvent | undefined,
): ConversationProviderState | undefined {
  if (!session) return current;
  const providerState: ConversationProviderState = { ...(current || {}) };
  if (session.provider === "codex") {
    const codexState = {
      ...(providerState.codex || {}),
      threadId: session.threadId || providerState.codex?.threadId,
      sessionFilePath:
        session.sessionFilePath || providerState.codex?.sessionFilePath,
    };
    if (session.threadId) delete codexState.forkSource;
    providerState.codex = codexState;
    return providerState;
  }
  if (session.sessionId) {
    if (session.provider === "deepseek") {
      providerState.deepseek = {
        ...(providerState.deepseek || {}),
        sessionId: session.sessionId,
      };
    } else {
      providerState.claude = {
        ...(providerState.claude || {}),
        sessionId: session.sessionId,
      };
    }
  }
  return providerState;
}

export function applyProviderSessionEvent(
  target: ProviderSessionTarget,
  session: ProviderSessionEvent | undefined,
): void {
  if (!session) return;
  target.providerState = mergeProviderSessionState(
    target.providerState,
    session,
  );
  if (session.turnId) target.currentProviderTurnId = session.turnId;
}

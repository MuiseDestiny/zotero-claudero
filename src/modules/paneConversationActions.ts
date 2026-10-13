import { getString } from "../utils/locale";
import {
  applyConversation,
  clearConversationState,
  loadLatestConversation,
  saveCurrentConversation,
} from "./conversationController";
import {
  createRecoveryCandidate,
  planFreshReplay,
} from "./conversationRecovery";
import {
  loadConversationById,
  newConversationId,
  saveConversationData,
  type ConversationBlock,
  type ConversationIndexEntry,
  type SavedConversation,
} from "./conversationStore";
import {
  beginConversationTransition,
  captureConversationGuard,
} from "./conversationTransition";
import { replaceImageDraft } from "./imageDraft";
import { setStatusDot } from "./paneDom";
import { cloneImages, renderPendingImages } from "./paneImageView";
import { appendNoticeCard } from "./paneServiceNotices";
import { type PaneState, type PendingImage } from "./paneState";
import { normalizeProvider, type AiProvider } from "./providerRegistry";
import { asSelectionContext } from "./selectionContextValidation";
import { type ClauderoSelectionContext } from "./zoteroContext";

// Conversation persistence, transitions and explicit recovery. Views and sending are injected.
interface PaneConversationActionsHost {
  renderConversationTurns: (state: PaneState) => void;
  getLastEditableUserTurnIndex: (state: PaneState) => number;
  sendPrompt: (
    state: PaneState,
    overridePrompt?: string,
    overrideImages?: PendingImage[],
    overrideContext?: ClauderoSelectionContext,
  ) => Promise<void>;
  updateSendButton: (state: PaneState, running: boolean) => void;
  appendWelcomeCard: (state: PaneState) => void;
  pushAssistantBlock: (state: PaneState, block: ConversationBlock) => void;
}

const conversationPersistence = {
  saveCurrentConversation,
  saveConversationData,
  loadConversationById,
  loadLatestConversation,
};

export function createPaneConversationActions(
  {
    renderConversationTurns,
    getLastEditableUserTurnIndex,
    sendPrompt,
    updateSendButton,
    appendWelcomeCard,
    pushAssistantBlock,
  }: PaneConversationActionsHost,
  persistence: typeof conversationPersistence = conversationPersistence,
) {
  const {
    saveCurrentConversation,
    saveConversationData,
    loadConversationById,
    loadLatestConversation,
  } = persistence;
  // ── Conversation persistence ───────────────────────────────────────────────

  const conversationSaveErrors = new WeakMap<PaneState, string>();

  async function saveConversation(state: PaneState): Promise<boolean> {
    const current = captureConversationGuard(state);
    if (!state.conversationTurns.length && !state.parentConversationId)
      return true;
    try {
      const result = await saveCurrentConversation(state);
      if (!current()) return true;
      if (result.warning)
        appendNoticeCard(
          state,
          "warning",
          getString("pane-saved-warning"),
          result.warning,
        );
      conversationSaveErrors.delete(state);
      return true;
    } catch (error) {
      if (!current()) return false;
      const message = error instanceof Error ? error.message : String(error);
      ztoolkit.log(`[History] conversation save failed: ${message}`);
      if (conversationSaveErrors.get(state) !== message) {
        conversationSaveErrors.set(state, message);
        appendNoticeCard(
          state,
          "warning",
          getString("pane-not-saved"),
          message,
        );
      }
      setStatusDot(state, "error");
      return false;
    }
  }

  async function restoreConversation(
    state: PaneState,
    conv: SavedConversation | ConversationIndexEntry,
  ): Promise<void> {
    const transition = beginConversationTransition(state);
    if (!transition) return;
    try {
      const loaded = await loadConversationById(conv.id);
      if (!transition.current()) return;
      if (!loaded) throw new Error(getString("history-conversation-missing"));
      if (!(await saveConversation(state)) || !transition.current()) return;
      applyConversation(state, loaded);
      renderConversationTurns(state);
      setStatusDot(state, "ready");
    } finally {
      transition.release();
    }
  }

  async function restoreLatestConversation(state: PaneState): Promise<void> {
    const transition = beginConversationTransition(state);
    if (!transition) return;
    try {
      const latest = await loadLatestConversation();
      if (
        latest &&
        transition.current() &&
        state.root.isConnected &&
        !state.conversationTurns.length
      ) {
        applyConversation(state, latest);
        renderConversationTurns(state);
        setStatusDot(state, "ready");
      }
    } finally {
      transition.release();
    }
  }

  function confirmFreshRecovery(
    state: PaneState,
    candidate: SavedConversation,
  ): boolean {
    const manifest = candidate.recoveryManifest!;
    if (manifest.mode === "native") return true;
    const replay = planFreshReplay(candidate.turns, manifest.overLimit);
    if (
      !state.root.ownerDocument?.defaultView?.confirm(
        getString("pane-recovery-confirm", {
          args: {
            total: manifest.totalTurns,
            included: replay.manifest.includedTurns,
            missing:
              replay.manifest.missingMaterials.join("; ") ||
              getString("pane-recovery-text-only"),
          },
        }),
      )
    )
      return false;
    candidate.recoveryManifest = { ...replay.manifest, confirmed: true };
    return true;
  }

  async function saveDetachedRecovery(
    state: PaneState,
    retainedCount: number,
    current: () => boolean,
  ): Promise<boolean> {
    const candidate = createRecoveryCandidate(
      state,
      retainedCount,
      normalizeProvider(state.providerSelect.value),
      newConversationId(),
    );
    if (!confirmFreshRecovery(state, candidate) || !current()) return false;
    if (!(await saveConversation(state)) || !current()) return false;
    try {
      const result = await saveConversationData(
        candidate.id,
        candidate.turns,
        candidate,
      );
      if (!current()) return false;
      applyConversation(state, candidate);
      renderConversationTurns(state);
      if (result.warning)
        appendNoticeCard(
          state,
          "warning",
          getString("pane-saved-warning"),
          result.warning,
        );
      return true;
    } catch (error) {
      if (current())
        appendNoticeCard(
          state,
          "warning",
          getString("pane-not-saved"),
          String(error),
        );
      return false;
    }
  }

  function reportRecoverySuccess(state: PaneState, provider: AiProvider): void {
    const recovery = state.pendingRecovery;
    if (
      !recovery ||
      recovery.conversationId !== state.conversationId ||
      recovery.provider !== provider ||
      !state.lastAssistantText.trim()
    )
      return;
    state.pendingRecovery = undefined;
    const notice = {
      type: "notice" as const,
      kind: "success" as const,
      title: getString("pane-recovery-complete-title"),
      text: getString("pane-recovery-complete-description"),
    };
    pushAssistantBlock(state, notice);
    appendNoticeCard(state, notice.kind, notice.title, notice.text);
  }

  async function retryAssistantTurn(
    state: PaneState,
    turnIndex?: number,
  ): Promise<boolean> {
    const transition = beginConversationTransition(state);
    if (!transition) return false;
    try {
      const assistantIndex = turnIndex ?? state.conversationTurns.length - 1;
      if (state.conversationTurns[assistantIndex]?.role !== "assistant")
        return false;
      let userIndex = assistantIndex - 1;
      while (
        userIndex >= 0 &&
        state.conversationTurns[userIndex]?.role !== "user"
      )
        userIndex--;
      const turn = state.conversationTurns[userIndex];
      if (
        !turn ||
        !(await saveDetachedRecovery(state, userIndex, transition.current))
      )
        return false;
      const recovery = {
        conversationId: state.conversationId,
        provider: normalizeProvider(state.providerSelect.value),
      };
      state.pendingRecovery = recovery;
      transition.release();
      try {
        await sendPrompt(
          state,
          turn.text,
          cloneImages(turn.images),
          asSelectionContext(turn.contextSnapshot) || undefined,
        );
      } finally {
        if (state.pendingRecovery === recovery)
          state.pendingRecovery = undefined;
      }
      return true;
    } finally {
      transition.release();
    }
  }

  async function forkConversationAtTurn(
    state: PaneState,
    turnIndex?: number,
  ): Promise<void> {
    const transition = beginConversationTransition(state);
    if (!transition) return;
    try {
      const index = turnIndex ?? state.conversationTurns.length - 1;
      if (index < 0 || !state.conversationTurns[index]) return;
      if (await saveDetachedRecovery(state, index + 1, transition.current)) {
        appendNoticeCard(
          state,
          "success",
          getString("pane-fork-title"),
          getString("pane-fork-description"),
        );
        setStatusDot(state, "ready");
      }
    } finally {
      transition.release();
    }
  }

  async function editLastUserTurn(
    state: PaneState,
    turnIndex?: number,
  ): Promise<void> {
    const transition = beginConversationTransition(state);
    if (!transition) return;
    try {
      const userIndex = turnIndex ?? getLastEditableUserTurnIndex(state);
      const turn = state.conversationTurns[userIndex];
      if (
        !turn ||
        turn.role !== "user" ||
        !(await saveDetachedRecovery(state, userIndex, transition.current))
      )
        return;
      state.input.value = turn.text === "(图片)" ? "" : turn.text;
      replaceImageDraft(state, cloneImages(turn.images));
      renderPendingImages(state);
      state.input.focus();
      state.input.selectionStart = state.input.selectionEnd =
        state.input.value.length;
      updateSendButton(state, false);
    } finally {
      transition.release();
    }
  }

  // ── New conversation ───────────────────────────────────────────────────────

  function startNewConversation(state: PaneState): void {
    const transition = beginConversationTransition(state);
    if (!transition) return;
    void (async () => {
      try {
        if (!(await saveConversation(state)) || !transition.current()) return;
        clearConversationState(state);
        state.input.value = "";
        renderPendingImages(state);
        appendWelcomeCard(state);
        setStatusDot(state, "ready");
      } finally {
        transition.release();
      }
    })();
  }

  return {
    retryAssistantTurn,
    forkConversationAtTurn,
    editLastUserTurn,
    saveConversation,
    reportRecoverySuccess,
    restoreConversation,
    startNewConversation,
    restoreLatestConversation,
  };
}

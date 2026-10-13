import {
  evidenceReferencesFromToolResultContent,
  restoreEvidenceReferences,
} from "../shared/evidenceLinkCodec";
import { getString } from "../utils/locale";
import { ConversationCompletion } from "./conversationCompletion";
import { captureRequestGuard } from "./conversationTransition";
import {
  createEl,
  forceScrollToBottom,
  formatDuration,
  setStatusDot,
} from "./paneDom";
import { getSelectedEffort, getSelectedModel } from "./paneModelControls";
import type { PaneRequestHost } from "./paneRequestHost";
import {
  paneRequestServices,
  type PaneRequestServices,
} from "./paneRequestServices";
import { dropProviderSession, pickFlavorWord } from "./paneRequestSupport";
import {
  appendRequestFailure,
  requestFailureDescription,
} from "./paneServiceNotices";
import { type PaneState } from "./paneState";
import {
  hideQuestionDialog,
  showExitPlanDialog,
  showQuestionDialog,
} from "./permissionDialog";
import { normalizeProvider, providerLabel } from "./providerRegistry";
import { applyProviderSessionEvent } from "./providerSessionState";
import { appendToolCard, appendToolResult } from "./toolCallRenderer";

/** Raw SDK commands; callbacks are captured without executing them. */
export function createPaneSlashRequest(
  host: PaneRequestHost,
  services: Pick<
    PaneRequestServices,
    "queryClaudeHelper" | "reloadSlashCommands"
  > = paneRequestServices,
) {
  const {
    refreshEditableMessageActions,
    appendUserMessage,
    appendMessageCard,
    attachMessageActions,
  } = host.messages;
  const { saveConversation, reportRecoverySuccess, retryAssistantTurn } =
    host.conversation;
  const { startInteractionPolling, stopInteractionPolling } = host.interactions;
  const {
    updateContext,
    setRunning,
    maybeAppendUndoCard,
    generateConversationTitle,
    setSdkCommands,
  } = host.ui;
  const {
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
  } = host.streaming;
  const { queryClaudeHelper, reloadSlashCommands } = services;

  // Send a real Claude Code SDK slash command (e.g. "/compact", "/usage") without
  // any context wrapping. The raw text is passed straight to the SDK so the CLI
  // recognises it as a slash command rather than a user question.
  async function sendRawSlashCommand(
    state: PaneState,
    command: string,
  ): Promise<void> {
    if (state.disposed || state.running || state.conversationTransition) return;

    const provider = normalizeProvider(state.providerSelect.value);
    const requestModel = getSelectedModel(state);
    const requestEffort = getSelectedEffort(state);
    const requestConversationId = state.conversationId;
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
    state.activityMessage = getString("activity-sending");
    state.activityStartedTs = userTs;
    state.recentThoughtDurationMs = 0;
    state.recentThoughtUntil = 0;
    startThinkingAnimation(state);
    forceScrollToBottom(state);
    state.cancelRequested = false;
    state.questionPollingUnsupported = false;
    setRunning(state, true);

    const retryTurnIndex = state.conversationTurns.length + 1;
    let sawError = false;
    let failureMessage = "";
    const completion = new ConversationCompletion(state, () => {
      if (state.cancelRequested) dropProviderSession(state, provider);
      const userTurnIndex = state.conversationTurns.length;
      state.conversationTurns.push({
        role: "user",
        text: command,
        ts: userTs,
        provider,
      });
      attachMessageActions(state, userCard, "user", command, {
        ts: userTs,
        turnIndex: userTurnIndex,
        editable: true,
      });
      const blocks = state.currentAssistantBlocks.slice();
      if (state.currentSegmentText) {
        blocks.push({ type: "text", text: state.currentSegmentText });
      }
      if (failureMessage || state.cancelRequested) {
        blocks.push({
          type: "notice",
          kind: state.cancelRequested ? "info" : "warning",
          title: state.cancelRequested
            ? getString("pane-cancelled")
            : getString("pane-request-failed"),
          text: failureMessage
            ? requestFailureDescription(failureMessage)
            : getString("pane-cancelled-description"),
          failureMessage:
            !state.cancelRequested && failureMessage
              ? failureMessage
              : undefined,
        });
      }
      if (state.lastAssistantText || blocks.length > 0) {
        state.conversationTurns.push({
          role: "assistant",
          text: state.lastAssistantText,
          ts: Date.now(),
          blocks,
          model: requestModel,
          effort: requestEffort,
          durationMs: Date.now() - userTs,
          assistantMessageId: state.currentProviderTurnId,
          provider,
        });
      }
      void saveConversation(state);
    });
    try {
      const requestId = crypto.randomUUID();
      state.activeRequestId = requestId;
      const requestController = new AbortController();
      state.requestController = requestController;
      const requestIsCurrent = captureRequestGuard(state, requestId);
      startInteractionPolling(state, requestIsCurrent);
      for await (const event of queryClaudeHelper(command, {
        requestId,
        signal: requestController.signal,
        provider,
        model: requestModel,
        effort: requestEffort,
        permissionMode: state.permissionMode,
        conversationId: requestConversationId,
        providerState: state.providerState,
      })) {
        if (state.cancelRequested || !requestIsCurrent()) break;
        if (event.type === "session") {
          applyProviderSessionEvent(state, event.session);
        } else if (event.type === "context_compaction") {
          setActivity(
            state,
            event.phase === "started" ? "compacting" : "thinking",
            event.phase === "started"
              ? getString("activity-compacting")
              : getString("activity-thinking"),
          );
          startThinkingAnimation(state);
        } else if (event.type === "connection_status") {
          setActivity(
            state,
            "waiting",
            getString("activity-reconnecting", {
              args: { attempt: event.attempt, maxAttempts: event.maxAttempts },
            }),
          );
          startThinkingAnimation(state);
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
          if (event.tool.name !== "Skill")
            commitCurrentAssistantTextBlock(state);
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
          restoreEvidenceReferences(
            evidenceReferencesFromToolResultContent(event.result.content),
          );
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
          setActivity(state, "thinking", getString("activity-thinking"));
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
          setSdkCommands(
            event.commands.map((c) => ({
              name: c.name,
              description: c.description,
              isBuiltin: false,
              argumentHint: c.argumentHint,
            })),
          );
        } else if (event.type === "done") {
          if (event.outcome !== "success") {
            if (event.outcome === "cancelled") state.cancelRequested = true;
            else {
              sawError = true;
              failureMessage ||= getString("pane-query-failed", {
                args: { agent: providerLabel(provider) },
              });
            }
            break;
          }
          stopThinkingAnimation(state);
          finalizeThinkingCard(state);
          finalizeAssistantThinkingBlock(state, Date.now() - state.thinkingTs);
          finalizeAssistantBody(state);
          removeEmptyCurrentAssistantMessage(state);
          reportRecoverySuccess(state, provider);
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
            provider,
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
              model: requestModel,
              effort: requestEffort,
              durationMs: assistantTs - userTs,
              assistantMessageId: state.currentProviderTurnId,
              provider,
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
              model: requestModel,
              effort: requestEffort,
              durationMs: assistantTs - userTs,
              assistantMessageId: state.currentProviderTurnId,
              provider,
            });
          }
          if (command.trim() === "/compact") {
            state.compactedAt = Date.now();
          }
          const savePromise = saveConversation(state);
          completion.markRecorded();
          if (userTurnIndex === 0 && state.lastAssistantText) {
            const titleAssistantText = state.lastAssistantText;
            void savePromise.then((saved) =>
              saved
                ? generateConversationTitle(
                    requestConversationId,
                    command,
                    titleAssistantText,
                  )
                : null,
            );
          }
          void reloadSlashCommands().then((cmds) => {
            if (cmds.length > 0) {
              setSdkCommands(
                cmds.map((c) => ({
                  name: c.name,
                  description: c.description,
                  isBuiltin: false,
                  argumentHint: c.argumentHint,
                })),
              );
            }
          });
        } else if (event.type === "error") {
          sawError = true;
          const message =
            event.error ||
            getString("pane-query-failed", {
              args: {
                agent: providerLabel(
                  normalizeProvider(state.providerSelect.value),
                ),
              },
            });
          failureMessage = message;
        }
      }
    } catch (error) {
      if (!state.cancelRequested && !state.disposed) {
        sawError = true;
        const message = error instanceof Error ? error.message : String(error);
        failureMessage ||= message;
      }
    } finally {
      if (
        (sawError || state.cancelRequested) &&
        state.conversationId === requestConversationId
      ) {
        dropProviderSession(state, provider);
      }
      completion.finish();
      completion.release();
      if (
        failureMessage &&
        !state.cancelRequested &&
        !state.disposed &&
        state.conversationId === requestConversationId
      ) {
        appendRequestFailure(state, failureMessage, provider, () =>
          retryAssistantTurn(state, retryTurnIndex),
        );
      }
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
      state.requestController = undefined;
      state.activeRequestId = undefined;
      stopInteractionPolling(state);
      setRunning(state, false);
      updateContext(state);
      setStatusDot(state, sawError ? "error" : "ready");
    }
  }

  return sendRawSlashCommand;
}

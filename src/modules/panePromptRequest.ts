import {
  evidenceReferencesForText,
  evidenceReferencesFromToolResultContent,
  restoreEvidenceReferences,
} from "../shared/evidenceLinkCodec";
import {
  buildPromptWithConversationHistory,
  shouldReplayConversationHistory,
} from "../shared/promptHistory";
import { getString } from "../utils/locale";
import {
  compileAcademicSkillPrompt,
  matchAcademicSkillIntent,
  resolveAcademicSkillContextStatus,
} from "./academicSkills";
import { ConversationCompletion } from "./conversationCompletion";
import { captureRequestGuard } from "./conversationTransition";
import {
  logDiagnostic,
  logToolResult,
  logToolUse,
  logTurnEnd,
  logTurnStart,
} from "./diagnosticLog";
import { replaceImageDraft, trimInputHistory } from "./imageDraft";
import {
  createEl,
  forceScrollToBottom,
  formatDuration,
  setStatusDot,
} from "./paneDom";
import { cloneImages, renderPendingImages } from "./paneImageView";
import { getSelectedEffort, getSelectedModel } from "./paneModelControls";
import type { PanePromptRequestHost } from "./paneRequestHost";
import {
  paneRequestServices,
  type PaneRequestServices,
} from "./paneRequestServices";
import {
  dropProviderSession,
  getAttachmentDirectories,
  pickFlavorWord,
} from "./paneRequestSupport";
import {
  appendNoticeCard,
  appendRequestFailure,
  requestFailureDescription,
} from "./paneServiceNotices";
import { type PaneState, type PendingImage } from "./paneState";
import {
  hideQuestionDialog,
  showExitPlanDialog,
  showQuestionDialog,
} from "./permissionDialog";
import {
  getProviderCapabilities,
  normalizeProvider,
  providerLabel,
} from "./providerRegistry";
import { applyProviderSessionEvent } from "./providerSessionState";
import { appendToolCard, appendToolResult } from "./toolCallRenderer";
import {
  buildPromptWithZoteroContext,
  type ClauderoSelectionContext,
} from "./zoteroContext";

/** Context-rich prompts; callbacks are captured without executing them. */
export function createPanePromptRequest(
  host: PanePromptRequestHost,
  services: PaneRequestServices = paneRequestServices,
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
  const { sendRawSlashCommand } = host;
  const {
    queryClaudeHelper,
    reloadSlashCommands,
    getSelectedZoteroContext,
    getEnabledAcademicSkills,
    getZoteroApiSystemPrompt,
  } = services;

  // ── Core send logic ────────────────────────────────────────────────────────

  async function sendPrompt(
    state: PaneState,
    overridePrompt?: string,
    overrideImages?: PendingImage[],
    overrideContext?: ClauderoSelectionContext,
  ): Promise<void> {
    if (state.disposed || state.running || state.conversationTransition) return;
    updateContext(state);
    const prompt = (overridePrompt ?? state.input.value).trim();
    const images = (overrideImages ?? state.pendingImages).map((img) => ({
      ...img,
    }));
    const provider = normalizeProvider(state.providerSelect.value);
    const requestModel = getSelectedModel(state);
    const requestEffort = getSelectedEffort(state);
    const requestConversationId = state.conversationId;
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
    replaceImageDraft(state);
    renderPendingImages(state);
    // Save to input history
    state.inputHistory.unshift({ text: prompt, images });
    trimInputHistory(state.inputHistory);
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
    forceScrollToBottom(state); // always scroll to bottom when user sends a message
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
        text: prompt || "(图片)",
        ts: userTs,
        images: cloneImages(images),
        contextSnapshot: state.currentContextSnapshot,
        provider,
      });
      attachMessageActions(state, userCard, "user", prompt || "(图片)", {
        ts: userTs,
        turnIndex: userTurnIndex,
        editable: true,
        contextSnapshot: state.currentContextSnapshot,
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
          contextSnapshot: state.currentContextSnapshot,
          assistantMessageId: state.currentProviderTurnId,
          provider,
          evidenceReferences: evidenceReferencesForText(
            state.lastAssistantText,
          ),
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
      const context =
        overrideContext ||
        (await getSelectedZoteroContext(
          state.root.ownerDocument?.defaultView || undefined,
        ));
      if (state.cancelRequested || !requestIsCurrent()) return;
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
                  (c: {
                    firstName?: string;
                    lastName?: string;
                    name?: string;
                  }) =>
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
      const academicMatch = matchAcademicSkillIntent(
        basePrompt,
        getEnabledAcademicSkills(),
      );
      logTurnStart({
        provider,
        model: requestModel,
        effort: requestEffort,
        permissionMode: state.permissionMode,
        conversationId: state.conversationId,
        promptLength: basePrompt.length,
        imageCount: images.length,
        academicSkill: academicMatch?.skill.id || null,
        context,
      });
      const workflowPrompt = academicMatch
        ? compileAcademicSkillPrompt({
            userPrompt: basePrompt,
            match: academicMatch,
            contextStatus: resolveAcademicSkillContextStatus(
              academicMatch.skill,
              context,
            ),
          })
        : basePrompt;
      const promptWithHistory = shouldReplayConversationHistory(
        provider,
        state.providerState,
      )
        ? buildPromptWithConversationHistory(
            workflowPrompt,
            state.conversationTurns,
            state.recoveryManifest,
          )
        : workflowPrompt;
      const fullPrompt = buildPromptWithZoteroContext(
        promptWithHistory,
        context,
        getZoteroApiSystemPrompt(),
      );
      const additionalDirectories = getAttachmentDirectories(context);
      const stream = queryClaudeHelper(fullPrompt, {
        requestId,
        signal: requestController.signal,
        provider,
        model: requestModel,
        effort: requestEffort,
        additionalDirectories,
        permissionMode: state.permissionMode,
        images: images.map((i) => ({ media_type: i.mediaType, data: i.data })),
        conversationId: requestConversationId,
        providerState: state.providerState,
        toolPolicy: academicMatch?.skill.toolPolicy,
      });
      for await (const event of stream) {
        if (state.cancelRequested || !requestIsCurrent()) break;
        if (event.type === "session") {
          logDiagnostic("provider.session", {
            provider: event.session.provider,
            sessionId: event.session.sessionId,
            threadId: event.session.threadId,
            turnId: event.session.turnId,
          });
          applyProviderSessionEvent(state, event.session);
        } else if (event.type === "ready") {
          setActivity(state, "responding");
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
          logToolUse(event.tool);
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
          logToolResult(event.result);
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
          logDiagnostic("usage", {
            outputTokens: event.usage.outputTokens,
            final: event.usage.final,
            durationMs: event.usage.durationMs,
          });
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
          // Skill was installed mid-session — refresh the slash command cache
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
          logTurnEnd({
            cancelled: false,
            durationMs: Date.now() - userTs,
            outputTokens: state.turnOutputTokens,
            responseChars: state.turnResponseChars,
            thinkingTokens: state.thinkingTokenEstimate,
          });
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
          reportRecoverySuccess(state, provider);
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
            provider,
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
              model: requestModel,
              effort: requestEffort,
              durationMs: assistantTs - userTs,
              contextSnapshot: state.currentContextSnapshot,
              assistantMessageId: state.currentProviderTurnId,
              provider,
              evidenceReferences: evidenceReferencesForText(
                state.lastAssistantText,
              ),
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
              contextSnapshot: state.currentContextSnapshot,
              assistantMessageId: state.currentProviderTurnId,
              provider,
              evidenceReferences: evidenceReferencesForText(
                state.lastAssistantText,
              ),
            });
          }
          const savePromise = saveConversation(state);
          completion.markRecorded();
          if (userTurnIndex === 0 && state.lastAssistantText) {
            const titleConversationId = requestConversationId;
            const titleAssistantText = state.lastAssistantText;
            void savePromise.then((saved) =>
              saved
                ? generateConversationTitle(
                    titleConversationId,
                    prompt || "(图片)",
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
          logTurnEnd({
            error: message,
            durationMs: Date.now() - userTs,
            outputTokens: state.turnOutputTokens,
            responseChars: state.turnResponseChars,
            thinkingTokens: state.thinkingTokenEstimate,
          });
        }
      }
    } catch (error) {
      if (!state.cancelRequested && !state.disposed) {
        sawError = true;
        const message = error instanceof Error ? error.message : String(error);
        failureMessage ||= message;
        logTurnEnd({
          error: message,
          cancelled: state.cancelRequested,
          durationMs: Date.now() - userTs,
          outputTokens: state.turnOutputTokens,
          responseChars: state.turnResponseChars,
          thinkingTokens: state.thinkingTokenEstimate,
        });
      }
    } finally {
      // A failed or cancelled provider turn may have left its native session
      // unusable. Clear only that provider's resumable state so the next request
      // starts a fresh, history-backed turn instead of resuming a dead session.
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
      if (state.cancelRequested) {
        logTurnEnd({
          cancelled: true,
          durationMs: Date.now() - userTs,
          outputTokens: state.turnOutputTokens,
          responseChars: state.turnResponseChars,
          thinkingTokens: state.thinkingTokenEstimate,
        });
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

  return sendPrompt;
}

import type {
  ClauderoQueryEvent,
  ClauderoQueryOptions,
} from "../src/modules/claudeHelperClient";
import type { ConversationTurn } from "../src/modules/conversationStore";
import { createPaneConversationActions } from "../src/modules/paneConversationActions";
import { createPaneMessageView } from "../src/modules/paneMessageView";
import { createPanePromptRequest } from "../src/modules/panePromptRequest";
import type { PaneRequestHost } from "../src/modules/paneRequestHost";
import type { PaneRequestServices } from "../src/modules/paneRequestServices";
import { createPaneSlashRequest } from "../src/modules/paneSlashRequest";
import type { SlashCommand } from "../src/modules/paneState";
import { createPaneStreamingView } from "../src/modules/paneStreamingView";
import type { ClauderoSelectionContext } from "../src/modules/zoteroContext";
import { createPaneTestState } from "./paneTestState";

export type RequestKind = "prompt" | "slash";
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createRequestFixture() {
  const state = createPaneTestState();
  Object.assign(state, {
    conversationTurns: [],
    inputHistory: [],
    inputHistoryIdx: -1,
    manualItems: [],
    permissionMode: "auto",
    cancelRequested: false,
    thinkingTimer: null,
    thinkingEl: null,
    permissionCheckTimer: null,
    _suppressText: 0,
    _activeSkillToolId: null,
  });
  const context: ClauderoSelectionContext = {
    generatedAt: "2026-09-25T00:00:00Z",
    selectedType: "reader",
    selectedTabID: "test-reader",
    items: [],
    selectedText: "Saved context excerpt",
    reader: {
      id: 1,
      key: "PDFKEY",
      title: "Test PDF",
      contentType: "application/pdf",
      path: "/test/papers/paper.pdf",
    },
  };
  const calls = {
    requests: [] as Array<{ prompt: string; options: ClauderoQueryOptions }>,
    saves: [] as ConversationTurn[][],
    retries: [] as Array<number | undefined>,
    commands: [] as SlashCommand[][],
    running: [] as boolean[],
    titles: [] as string[],
    polling: [] as string[],
    contextReads: 0,
    recovery: 0,
  };
  const control: {
    stream(options: ClauderoQueryOptions): AsyncGenerator<ClauderoQueryEvent>;
    context(): Promise<ClauderoSelectionContext>;
  } = {
    async *stream(options) {
      yield { type: "text_delta", text: "Final answer" };
      yield { type: "done", requestId: options.requestId!, outcome: "success" };
    },
    context: async () => structuredClone(context),
  };
  const services: PaneRequestServices = {
    async *queryClaudeHelper(prompt, options = {}) {
      calls.requests.push({ prompt, options });
      yield* control.stream(options);
    },
    reloadSlashCommands: async () => [],
    getSelectedZoteroContext: async () => {
      calls.contextReads++;
      return control.context();
    },
    getEnabledAcademicSkills: () => [],
    getZoteroApiSystemPrompt: () => "Test system context",
  };
  const messages = createPaneMessageView({
    retryAssistantTurn: async (_s, index) => {
      calls.retries.push(index);
      return true;
    },
    forkConversationAtTurn: async () => {},
    editLastUserTurn: async () => {},
    createThinkingChevron: (doc) => doc.createElement("span"),
  });
  const streaming = createPaneStreamingView({
    appendMessageCard: messages.appendMessageCard,
    getSelectedEffort: () => "medium",
  });
  const recovery = createPaneConversationActions({
    renderConversationTurns: messages.renderConversationTurns,
    getLastEditableUserTurnIndex: messages.getLastEditableUserTurnIndex,
    sendPrompt: async () => {},
    updateSendButton: () => {},
    appendWelcomeCard: () => {},
    pushAssistantBlock: streaming.pushAssistantBlock,
  });
  const host: PaneRequestHost = {
    messages,
    streaming,
    conversation: {
      saveConversation: async (s) => {
        calls.saves.push(structuredClone(s.conversationTurns));
        return true;
      },
      retryAssistantTurn: async (_s, index) => {
        calls.retries.push(index);
        return true;
      },
      reportRecoverySuccess: (s, provider) => {
        calls.recovery++;
        recovery.reportRecoverySuccess(s, provider);
      },
    },
    interactions: {
      startInteractionPolling: () => {
        calls.polling.push("start");
      },
      stopInteractionPolling: () => {
        calls.polling.push("stop");
      },
    },
    ui: {
      updateContext: () => {},
      setRunning: (s, running) => {
        s.running = running;
        calls.running.push(running);
      },
      maybeAppendUndoCard: () => {},
      generateConversationTitle: async (id) => {
        calls.titles.push(id);
        return null;
      },
      setSdkCommands: (commands) => {
        calls.commands.push(commands);
      },
    },
  };
  function executors() {
    const slash = createPaneSlashRequest(host, services);
    return {
      slash,
      prompt: createPanePromptRequest(
        { ...host, sendRawSlashCommand: slash },
        services,
      ),
    };
  }
  return {
    state,
    context,
    calls,
    control,
    services,
    host,
    executors,
    run(kind: RequestKind) {
      return executors()[kind](
        state,
        kind === "prompt" ? "Explain this paper" : "/compact",
      );
    },
    dispose() {
      state.requestController?.abort();
      streaming.stopThinkingAnimation(state);
      streaming.finalizeThinkingCard(state);
      state.disposed = true;
      state.root.remove();
    },
  };
}

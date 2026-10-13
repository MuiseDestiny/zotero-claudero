import type { createPaneConversationActions } from "./paneConversationActions";
import type { createPaneMessageView } from "./paneMessageView";
import type { PaneState, SlashCommand } from "./paneState";
import type { createPaneStreamingView } from "./paneStreamingView";

/** Execution depends on capabilities, never on the pane controller itself. */
export interface PaneRequestHost {
  messages: Pick<
    ReturnType<typeof createPaneMessageView>,
    | "refreshEditableMessageActions"
    | "appendUserMessage"
    | "appendMessageCard"
    | "attachMessageActions"
  >;
  streaming: ReturnType<typeof createPaneStreamingView>;
  conversation: Pick<
    ReturnType<typeof createPaneConversationActions>,
    "saveConversation" | "reportRecoverySuccess" | "retryAssistantTurn"
  >;
  interactions: {
    startInteractionPolling(state: PaneState, current: () => boolean): void;
    stopInteractionPolling(state: PaneState): void;
  };
  ui: {
    updateContext(state: PaneState): void;
    setRunning(state: PaneState, running: boolean): void;
    maybeAppendUndoCard(
      state: PaneState,
      result: { content: string; isError: boolean },
    ): void;
    generateConversationTitle(
      conversationId: string,
      firstUserText: string,
      firstAssistantText: string,
      expectedTitle?: string,
    ): Promise<string | null>;
    setSdkCommands(commands: SlashCommand[]): void;
  };
}

export interface PanePromptRequestHost extends PaneRequestHost {
  sendRawSlashCommand(state: PaneState, command: string): Promise<void>;
}

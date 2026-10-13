import {
  captureConversationGuard,
  type ConversationGenerationState,
} from "./conversationTransition";

interface CompletionState extends ConversationGenerationState {
  finalizeRequest?: () => void;
}

/** Commit a partial turn before closing its pane; late network cleanup is inert. */
export class ConversationCompletion {
  private recorded = false;
  private current: () => boolean;

  constructor(
    private state: CompletionState,
    private commit: () => void,
  ) {
    this.current = captureConversationGuard(state);
    state.finalizeRequest = this.finish;
  }

  readonly finish = (): void => {
    if (this.recorded || !this.current()) return;
    this.recorded = true;
    this.commit();
  };

  markRecorded(): void {
    this.recorded = true;
  }

  release(): void {
    if (this.state.finalizeRequest === this.finish) {
      this.state.finalizeRequest = undefined;
    }
  }
}

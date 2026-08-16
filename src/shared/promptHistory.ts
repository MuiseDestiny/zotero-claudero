import type { ConversationTurn } from "../modules/conversationStore";

export interface PromptProviderState {
  claude?: { sessionId?: string };
  codex?: { threadId?: string; forkSource?: unknown };
  deepseek?: { sessionId?: string };
}

const MAX_REPLAY_TURNS = 16;
// DeepSeek Harness is launched as an independent process, so the full
// transcript is replayed on every turn. Keep the replay bounded before it is
// combined with the current Zotero context and provider prompt.
const MAX_REPLAY_CHARS = 48_000;
const MAX_REPLAY_TOKENS = 12_000;
const MAX_TURN_CHARS = 12_000;

function estimateTokens(value: string): number {
  // This intentionally overestimates ASCII-heavy text and remains
  // conservative for CJK text where a character is often a token.
  const cjk = (value.match(/[\u3400-\u9fff\u{20000}-\u{2ffff}]/gu) || [])
    .length;
  const nonCjk = value.length - cjk;
  return cjk + Math.ceil(nonCjk / 4);
}

function truncateTurnText(value: string): string {
  if (value.length <= MAX_TURN_CHARS) return value;
  const head = Math.floor(MAX_TURN_CHARS * 0.7);
  const tail = MAX_TURN_CHARS - head;
  return `${value.slice(0, head)}\n[… earlier content omitted …]\n${value.slice(-tail)}`;
}

/**
 * Build the provider-neutral transcript that is replayed for providers whose
 * native session cannot be resumed (currently DeepSeek Harness).
 */
export function buildConversationHistorySection(
  turns: readonly ConversationTurn[],
): string {
  const candidates = turns
    .map((turn) => ({ ...turn, text: truncateTurnText(turn.text.trim()) }))
    .filter((turn) => turn.text.length > 0)
    .slice(-MAX_REPLAY_TURNS);
  const trimmedTurns: typeof candidates = [];
  let chars = 0;
  let tokens = 0;
  // Walk backwards so the latest turns are always retained. The final list is
  // reversed again to keep the original chronological order for the model.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const turn = candidates[i]!;
    const turnChars = turn.text.length;
    const turnTokens = estimateTokens(turn.text);
    if (
      trimmedTurns.length > 0 &&
      (chars + turnChars > MAX_REPLAY_CHARS ||
        tokens + turnTokens > MAX_REPLAY_TOKENS)
    ) {
      break;
    }
    trimmedTurns.push(turn);
    chars += turnChars;
    tokens += turnTokens;
  }
  trimmedTurns.reverse();
  if (trimmedTurns.length === 0) return "";
  const lines = trimmedTurns.map((turn) => {
    const role = turn.role === "user" ? "User" : "Assistant";
    return `<turn role="${role}">\n${turn.text}\n</turn>`;
  });
  return [
    "<conversation_history>",
    "The following turns are from this Claudero conversation. Use them as prior context for the current request.",
    ...lines,
    "</conversation_history>",
  ].join("\n");
}

export function buildPromptWithConversationHistory(
  prompt: string,
  turns: readonly ConversationTurn[],
): string {
  const history = buildConversationHistorySection(turns);
  if (!history) return prompt;
  return [
    history,
    "",
    "<current_user_request>",
    prompt,
    "</current_user_request>",
  ].join("\n");
}

export function shouldReplayConversationHistory(
  provider: "claude" | "codex" | "deepseek",
  providerState?: PromptProviderState,
): boolean {
  if (provider === "codex") {
    return !providerState?.codex?.threadId && !providerState?.codex?.forkSource;
  }
  if (provider === "deepseek") return true;
  return !providerState?.claude?.sessionId;
}

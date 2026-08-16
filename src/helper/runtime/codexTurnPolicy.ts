export const CODEX_TURN_IDLE_TIMEOUT_MS = 45_000;
export const CODEX_CONTEXT_COMPACTION_TIMEOUT_MS = 5 * 60_000;

export function codexTurnIdleTimeoutMs(
  contextCompactionActive: boolean,
): number {
  return contextCompactionActive
    ? CODEX_CONTEXT_COMPACTION_TIMEOUT_MS
    : CODEX_TURN_IDLE_TIMEOUT_MS;
}

export interface CodexReconnectStatus {
  attempt: number;
  maxAttempts: number;
}

export function parseCodexReconnectStatus(
  message: string,
): CodexReconnectStatus | null {
  const match = message.trim().match(/^Reconnecting\.\.\.\s*(\d+)\/(\d+)$/i);
  if (!match) return null;
  return {
    attempt: Number(match[1]),
    maxAttempts: Number(match[2]),
  };
}

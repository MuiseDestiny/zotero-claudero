export type RequestFailureKind =
  | "node"
  | "cli"
  | "auth"
  | "limit"
  | "session"
  | "connection"
  | "unknown";

/** Classify only; never replay a request that may already have run tools. */
export function classifyRequestFailure(message: string): RequestFailureKind {
  if (
    /rate.?limit|quota|session limit|usage limit|hit your[^\n]*limit|resets\s+|too many requests|\b429\b/i.test(
      message,
    )
  )
    return "limit";
  if (
    /unauthori[sz]ed|unauthenticated|not authenticated|not logged in|failed to authenticate|authentication|login required|(?:run|use) \/?login|request not allowed|invalid credentials|invalid[^\n]*(?:api.?key|token)|missing[^\n]*api.?key|DEEPSEEK_API_KEY|\b(?:401|403)\b|(?:please|must|need to) (?:log|sign) in/i.test(
      message,
    )
  )
    return "auth";
  if (
    /(?:session|thread)[^\n]*(?:not found|invalid|expired|missing|does not exist)|(?:failed|unable|cannot) to resume|no rollout found/i.test(
      message,
    )
  )
    return "session";
  if (
    /node(?:\.js)?[^\n]*(?:not found|not installed|requires|version|missing)|requires? node|DSH_NODE_PATH/i.test(
      message,
    )
  )
    return "node";
  if (
    /not found[^\n]*(?:cli|claude|codex|dsh)|(?:cli|claude|codex|dsh)[^\n]*(?:not found|not installed|missing)|spawn[^\n]*ENOENT/i.test(
      message,
    )
  )
    return "cli";
  if (
    /network|fetch failed|failed to fetch|NetworkError|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed? ?out|timeout|connection (?:ended|closed|reset|refused)|socket hang up|\b50[234]\b/i.test(
      message,
    )
  )
    return "connection";
  return "unknown";
}

/** A recovery button belongs to one conversation and can run only once. */
export function createRecoveryAction(
  canRun: () => boolean,
  action: () => Promise<boolean | void>,
): () => Promise<boolean> {
  let used = false;
  return async () => {
    if (used || !canRun()) return false;
    used = true;
    try {
      if ((await action()) === false) {
        used = false;
        return false;
      }
      return true;
    } catch (error) {
      used = false;
      throw error;
    }
  };
}

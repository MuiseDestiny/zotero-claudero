import type { AgentEventPayload } from "./agentEvents";

const INLINE_SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const ASSIGNED_SECRET_PATTERN =
  /((?:api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|secret)\s*[:=]\s*)[^\s,;]+/gi;

export function stableDiagnosticHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!normalized) return false;
  if (
    [
      "authorization",
      "cookie",
      "credentials",
      "password",
      "privatekey",
      "secret",
    ].includes(normalized)
  ) {
    return true;
  }
  if (normalized.endsWith("token") && !normalized.endsWith("tokens")) {
    return true;
  }
  return (
    normalized.endsWith("key") &&
    /api|auth|private|secret|signing/.test(normalized)
  );
}

export function redactSensitiveText(value: string): string {
  let redacted = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted.replace(ASSIGNED_SECRET_PATTERN, "$1[redacted]");
}

function sanitizeValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>,
): unknown {
  if (isSensitiveDiagnosticKey(key)) {
    return value === undefined || value === null || value === ""
      ? value
      : "[redacted]";
  }
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, key, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[childKey] = sanitizeValue(childValue, childKey, seen);
    }
    seen.delete(value);
    return output;
  }
  return value;
}

export function sanitizeDiagnosticData(value: unknown): unknown {
  return sanitizeValue(value, "", new WeakSet<object>());
}

export function summarizeAgentEventForDiagnostics(
  event: AgentEventPayload,
): Record<string, unknown> {
  if (
    event.type === "text" ||
    event.type === "text_delta" ||
    event.type === "text_snapshot" ||
    event.type === "thinking" ||
    event.type === "thinking_snapshot"
  ) {
    return {
      type: event.type,
      textLength: event.text.length,
      textHash: stableDiagnosticHash(event.text),
    };
  }
  if (event.type === "tool_use") {
    const input =
      event.tool.input && typeof event.tool.input === "object"
        ? (event.tool.input as Record<string, unknown>)
        : null;
    return {
      type: event.type,
      id: event.tool.id,
      name: event.tool.name,
      inputKeys: input ? Object.keys(input).sort() : [],
      partialInputLength: event.tool.partialInput?.length || 0,
    };
  }
  if (event.type === "tool_use_delta") {
    return {
      type: event.type,
      index: event.index,
      toolId: event.tool?.id,
      toolName: event.tool?.name,
      partialInputLength: event.partialInput?.length || 0,
      hasInput: event.input !== undefined,
    };
  }
  if (event.type === "tool_result") {
    return {
      type: event.type,
      id: event.result.id,
      isError: event.result.isError,
      contentLength: event.result.content.length,
      contentHash: stableDiagnosticHash(event.result.content),
    };
  }
  if (event.type === "session") {
    return {
      type: event.type,
      provider: event.session.provider,
      hasSessionId: !!event.session.sessionId,
      hasThreadId: !!event.session.threadId,
      hasTurnId: !!event.session.turnId,
    };
  }
  if (event.type === "commands_changed") {
    return {
      type: event.type,
      commandCount: event.commands.length,
      commandNames: event.commands.map((command) => command.name),
    };
  }
  if (event.type === "error") {
    return {
      type: event.type,
      error: redactSensitiveText(event.error).slice(0, 700),
    };
  }
  return sanitizeDiagnosticData(event) as Record<string, unknown>;
}

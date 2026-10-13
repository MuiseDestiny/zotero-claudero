import { isAgentEventPayload, type AgentEventPayload } from "./agentEvents";

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Request cancelled", "AbortError");
  }
}

export async function* streamResponseEvents(
  response: Response,
  requestId: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentEventPayload> {
  if (!response.ok) {
    throw new Error(`Claudero helper query failed: ${response.status}`);
  }
  let terminal = false;
  let sawError = false;
  const parse = (line: string): AgentEventPayload => {
    const event: unknown = JSON.parse(line);
    if (!isAgentEventPayload(event)) throw new Error("Invalid helper event");
    if (terminal)
      throw new Error("Helper sent an event after its terminal event");
    if (event.type === "error") sawError = true;
    if (event.type === "done" || event.type === "ready") {
      if (event.requestId !== requestId)
        throw new Error("Helper request ID mismatch");
    }
    if (event.type === "done") {
      if (!["success", "error", "cancelled"].includes(event.outcome)) {
        throw new Error("Missing or invalid helper request outcome");
      }
      if (sawError && event.outcome === "success") {
        throw new Error("Helper reported success after a failed response");
      }
      terminal = true;
    }
    return event;
  };
  const ensureTerminal = () => {
    throwIfAborted(signal);
    if (!terminal)
      throw new Error(
        "Helper connection ended before the response completed. Partial output may be incomplete.",
      );
  };
  if (!response.body) {
    throwIfAborted(signal);
    const text = await response.text();
    for (const line of text.split(/\r?\n/)) {
      throwIfAborted(signal);
      if (line.trim()) yield parse(line.trim());
    }
    ensureTerminal();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let naturalEnd = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        naturalEnd = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield parse(line);
        throwIfAborted(signal);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parse(buffer.trim());
    ensureTerminal();
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!naturalEnd) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

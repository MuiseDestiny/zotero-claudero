import { isAgentEventPayload, type AgentEventPayload } from "./agentEvents";
import { MAX_HELPER_EVENT_BYTES } from "./helperProtocol";

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
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = new Uint8Array(0);
  let bufferedBytes = 0;
  const append = (fragment: Uint8Array) => {
    const required = bufferedBytes + fragment.byteLength;
    if (required > MAX_HELPER_EVENT_BYTES) {
      throw new Error("Helper event exceeds the 8 MiB frame limit");
    }
    if (required > buffer.byteLength) {
      const grown = new Uint8Array(
        Math.min(
          MAX_HELPER_EVENT_BYTES,
          Math.max(4096, buffer.byteLength * 2, required),
        ),
      );
      grown.set(buffer.subarray(0, bufferedBytes));
      buffer = grown;
    }
    buffer.set(fragment, bufferedBytes);
    bufferedBytes = required;
  };
  const flush = (): AgentEventPayload | undefined => {
    if (!bufferedBytes) return;
    const line = decoder.decode(buffer.subarray(0, bufferedBytes)).trim();
    bufferedBytes = 0;
    return line ? parse(line) : undefined;
  };
  function* consume(chunk: Uint8Array): Generator<AgentEventPayload> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      throwIfAborted(signal);
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      append(chunk.subarray(offset, end));
      if (newline < 0) break;
      const event = flush();
      if (event) yield event;
      offset = newline + 1;
    }
  }
  if (!response.body) {
    throwIfAborted(signal);
    yield* consume(new TextEncoder().encode(await response.text()));
    const event = flush();
    if (event) yield event;
    ensureTerminal();
    return;
  }

  const reader = response.body.getReader();
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
      yield* consume(value);
    }
    const event = flush();
    if (event) yield event;
    ensureTerminal();
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!naturalEnd) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

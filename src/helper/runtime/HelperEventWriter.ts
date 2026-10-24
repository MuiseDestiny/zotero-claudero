import type { ServerResponse } from "node:http";
import {
  isAgentEventPayload,
  type AgentEventPayload,
} from "../../shared/agentEvents";
import { MAX_HELPER_EVENT_BYTES } from "../../shared/helperProtocol";
import { throwIfAborted } from "../../shared/helperStream";

export async function writeHelperEvent(
  response: ServerResponse,
  event: AgentEventPayload,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  if (!isAgentEventPayload(event)) throw new Error("Invalid helper event");
  const frame = JSON.stringify(event);
  if (Buffer.byteLength(frame, "utf8") > MAX_HELPER_EVENT_BYTES) {
    throw new Error("Helper event exceeds the 8 MiB frame limit");
  }
  if (response.destroyed || response.writableEnded) {
    throw new Error("Helper response is closed");
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("finish", onClose);
      response.off("error", onError);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () =>
      finish(new Error("Helper response closed while writing"));
    const onError = (error: Error) => finish(error);
    const onAbort = () => {
      finish(new DOMException("Request cancelled", "AbortError"));
      response.destroy();
    };
    const timer = setTimeout(() => {
      finish(new Error("Helper response stalled while waiting for drain"));
      response.destroy();
    }, options.timeoutMs ?? 15_000);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("finish", onClose);
    response.once("error", onError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) onAbort();
      else if (response.destroyed || response.writableEnded) onClose();
      else if (response.write(`${frame}\n`)) finish();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

import { throwIfAborted } from "../../shared/helperStream";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeConfig,
} from "./AgentRuntimeAdapter";

/** One auxiliary request owns its process, including failed initialization. */
export async function collectAuxiliaryRuntime(
  manager: Pick<
    AgentRuntimeAdapter,
    "initialize" | "sendMessageEvents" | "close"
  >,
  config: AgentRuntimeConfig,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const cancel = () => manager.close();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    throwIfAborted(signal);
    await manager.initialize(config, signal);
    throwIfAborted(signal);
    let text = "";
    for await (const event of manager.sendMessageEvents(prompt)) {
      throwIfAborted(signal);
      if (event.type === "text_snapshot") text = event.text;
      else if (event.type === "text" || event.type === "text_delta")
        text += event.text;
      else if (event.type === "error") throw new Error(event.error);
    }
    throwIfAborted(signal);
    return text;
  } finally {
    signal.removeEventListener("abort", cancel);
    manager.close();
  }
}

import { assert } from "chai";
import { collectAuxiliaryRuntime } from "../src/helper/runtime/AuxiliaryQuery";
import type { AgentRuntimeAdapter } from "../src/helper/runtime/AgentRuntimeAdapter";

describe("auxiliary query ownership", function () {
  const config = { workspacePath: "/fixture", environment: {} };

  it("closes a runtime when initialization fails", async function () {
    let closed = 0;
    const manager = {
      async initialize() {
        throw new Error("fixture startup failure");
      },
      async *sendMessageEvents() {},
      close() {
        closed++;
      },
    };
    const error = await collectAuxiliaryRuntime(
      manager,
      config,
      "title",
      new AbortController().signal,
    ).catch((error) => error);
    assert.include(error.message, "fixture startup failure");
    assert.equal(closed, 1);
  });

  it("aborts initialization, prevents sending a cancelled prompt, and removes abort listeners", async function () {
    let finish!: () => void;
    let closed = 0,
      sent = 0;
    let received: AbortSignal | undefined;
    const controller = new AbortController();
    const manager = {
      async initialize(_config: unknown, signal?: AbortSignal) {
        received = signal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      async *sendMessageEvents() {
        sent++;
        yield { type: "text" as const, text: "cancelled request" };
      },
      close() {
        closed++;
      },
    };
    const result = collectAuxiliaryRuntime(
      manager,
      config,
      "title",
      controller.signal,
    ).catch((error) => error);
    controller.abort();
    assert.isTrue(received?.aborted);
    assert.equal(closed, 1);
    finish();
    assert.equal((await result).name, "AbortError");
    assert.equal(sent, 0);
    assert.equal(closed, 2);
  });

  it("reconciles a final snapshot without duplicating streamed text", async function () {
    let closed = 0;
    const manager: Pick<
      AgentRuntimeAdapter,
      "initialize" | "sendMessageEvents" | "close"
    > = {
      async initialize() {},
      async *sendMessageEvents() {
        yield { type: "text_delta", text: "Partial" };
        yield { type: "text_snapshot", text: "Final title" };
      },
      close() {
        closed++;
      },
    };
    const controller = new AbortController();
    assert.equal(
      await collectAuxiliaryRuntime(
        manager,
        config,
        "title",
        controller.signal,
      ),
      "Final title",
    );
    controller.abort();
    assert.equal(closed, 1, "Completion removes the abort listener");
  });
});

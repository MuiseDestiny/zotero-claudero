import { assert } from "chai";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { writeHelperEvent } from "../src/helper/runtime/HelperEventWriter";
import { MAX_HELPER_EVENT_BYTES } from "../src/shared/helperProtocol";

class FixtureResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  accepts = false;
  frames: string[] = [];
  write(frame: string): boolean {
    this.frames.push(frame);
    return this.accepts;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("close");
  }
  get response(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

describe("helper writable backpressure", function () {
  const event = { type: "text_delta", text: "fixture" } as const;
  const assertDetached = (response: FixtureResponse) => {
    for (const name of ["drain", "close", "finish", "error"])
      assert.equal(response.listenerCount(name), 0, name);
  };

  it("does not advance a producer until the writable drains", async function () {
    const response = new FixtureResponse();
    let advanced = false;
    const producer = (async () => {
      await writeHelperEvent(response.response, event);
      advanced = true;
      response.accepts = true;
      await writeHelperEvent(response.response, event);
    })();
    await Promise.resolve();
    assert.isFalse(advanced);
    assert.lengthOf(response.frames, 1);
    response.emit("drain");
    await producer;
    assert.isTrue(advanced);
    assert.lengthOf(response.frames, 2);
    assertDetached(response);
  });

  it("releases waits and listeners on close, finish, error, or a thrown write", async function () {
    for (const mode of ["close", "finish", "error", "throw"]) {
      const response = new FixtureResponse();
      if (mode === "throw")
        response.write = () => {
          throw new Error("fixture write failure");
        };
      const pending = writeHelperEvent(response.response, event).catch(
        (error) => error,
      );
      if (mode === "error")
        response.emit(mode, new Error("fixture socket error"));
      else if (mode !== "throw") response.emit(mode);
      assert.instanceOf(await pending, Error);
      assertDetached(response);
    }
  });

  it("cancels a blocked response without leaking abort or writable listeners", async function () {
    const response = new FixtureResponse();
    const controller = new AbortController();
    let removed = 0;
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.removeEventListener = (...args) => {
      removed++;
      remove(...args);
    };
    const pending = writeHelperEvent(response.response, event, {
      signal: controller.signal,
    }).catch((error) => error);
    controller.abort();
    assert.equal((await pending).name, "AbortError");
    assert.isTrue(response.destroyed);
    assert.equal(removed, 1);
    assertDetached(response);
  });

  it("closes a stalled writable after a bounded wait", async function () {
    const response = new FixtureResponse();
    const error = await writeHelperEvent(response.response, event, {
      timeoutMs: 5,
    }).catch((error) => error);
    assert.match(String(error), /stalled/);
    assert.isTrue(response.destroyed);
    assertDetached(response);
  });

  it("rejects invalid or oversized events and closed or pre-cancelled responses", async function () {
    const response = new FixtureResponse();
    response.accepts = true;
    const oversized = {
      type: "text",
      text: "x".repeat(MAX_HELPER_EVENT_BYTES),
    } as const;
    assert.match(
      String(
        await writeHelperEvent(response.response, oversized).catch((e) => e),
      ),
      /frame limit/,
    );
    const invalid = { type: "text", text: 1 } as unknown as typeof event;
    assert.match(
      String(
        await writeHelperEvent(response.response, invalid).catch((e) => e),
      ),
      /Invalid helper event/,
    );
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (
        await writeHelperEvent(response.response, event, {
          signal: controller.signal,
        }).catch((e) => e)
      ).name,
      "AbortError",
    );
    response.destroy();
    assert.match(
      String(await writeHelperEvent(response.response, event).catch((e) => e)),
      /closed/,
    );
    assert.isEmpty(response.frames);
    assertDetached(response);
  });
});

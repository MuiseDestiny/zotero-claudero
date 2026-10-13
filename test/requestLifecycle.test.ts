import { assert } from "chai";
import {
  RequestBusyError,
  RequestCoordinator,
} from "../src/helper/runtime/RequestCoordinator";
import { streamResponseEvents } from "../src/shared/helperStream";
import {
  waitWithSignal,
  withRequestDeadline,
} from "../src/shared/requestDeadline";

describe("request lifecycle", function () {
  it("isolates providers and holds a cancelled lease until cleanup finishes", async function () {
    const coordinator = new RequestCoordinator();
    const claude = coordinator.acquire("claude-1", "claude");
    const codex = coordinator.acquire("codex-1", "codex");
    claude.cancel();
    assert.isTrue(claude.signal.aborted);
    assert.isFalse(codex.signal.aborted);
    assert.throws(
      () => coordinator.acquire("claude-2", "claude"),
      RequestBusyError,
    );
    coordinator.release(claude);
    await claude.released;
    const next = coordinator.acquire("claude-2", "claude");
    assert.isTrue(coordinator.owns(next));
    coordinator.release(next);
    coordinator.release(codex);
  });

  it("rejects truncated streams and accepts a matching terminal outcome", async function () {
    const read = async (body: string) => {
      const events = [];
      for await (const event of streamResponseEvents(new Response(body), "r1"))
        events.push(event);
      return events;
    };
    let failed = false;
    try {
      await read('{"type":"ready","requestId":"r1"}\n');
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "EOF without done must not appear successful");
    const events = await read(
      '{"type":"ready","requestId":"r1"}\n{"type":"done","requestId":"r1","outcome":"cancelled"}\n',
    );
    assert.equal(events.at(-1)?.type, "done");
  });

  it("aborts one initialization waiter without cancelling shared work", async function () {
    let finish!: (value: number) => void;
    const shared = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const cancelled = waitWithSignal(shared, controller.signal).then(
      () => false,
      () => true,
    );
    const retained = waitWithSignal(shared);
    controller.abort();
    assert.isTrue(await cancelled);
    finish(42);
    assert.equal(await retained, 42);
  });

  it("keeps one shared observer after repeated waiter cancellation", async function () {
    let finish!: (value: number) => void;
    const shared = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const originalThen = shared.then.bind(shared);
    let observers = 0;
    shared.then = ((...args: Parameters<typeof shared.then>) => {
      observers++;
      return originalThen(...args);
    }) as typeof shared.then;
    for (let index = 0; index < 100; index++) {
      const controller = new AbortController();
      const result = waitWithSignal(shared, controller.signal).catch(
        (error) => error,
      );
      controller.abort();
      assert.equal((await result).name, "AbortError");
    }
    const retained = waitWithSignal(shared, new AbortController().signal);
    assert.equal(
      observers,
      1,
      "Cancelled callers must not accumulate promise handlers",
    );
    finish(42);
    assert.equal(await retained, 42);
  });

  it("settles active waiters and detaches their abort listeners", async function () {
    let fail!: (error: Error) => void;
    const shared = new Promise<number>((_, reject) => {
      fail = reject;
    });
    const controllers = [new AbortController(), new AbortController()];
    let detached = 0;
    for (const { signal } of controllers) {
      const remove = signal.removeEventListener.bind(signal);
      signal.removeEventListener = (...args) => {
        detached++;
        remove(...args);
      };
    }
    const waits = controllers.map(({ signal }) =>
      waitWithSignal(shared, signal).catch((error) => error),
    );
    const error = new Error("Initialization failed");
    fail(error);
    assert.deepEqual(await Promise.all(waits), [error, error]);
    assert.equal(detached, 2);
  });

  it("handles pre-cancelled waiters and deadlines for unresponsive operations", async function () {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await waitWithSignal(
      Promise.reject(new Error("late failure")),
      controller.signal,
    ).catch((error) => error);
    assert.equal(cancelled.name, "AbortError");
    let requestSignal: AbortSignal | undefined;
    const timedOut = await withRequestDeadline(
      (signal) => {
        requestSignal = signal;
        return new Promise(() => {});
      },
      undefined,
      5,
    ).catch((error) => error);
    assert.equal(timedOut.name, "AbortError");
    assert.isTrue(requestSignal?.aborted);
    let invoked = false;
    await withRequestDeadline(async () => {
      invoked = true;
    }, controller.signal).catch(() => {});
    assert.isFalse(invoked);
  });
});

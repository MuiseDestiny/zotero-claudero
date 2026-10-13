import { assert } from "chai";
import {
  PreferenceLifetime,
  PreferenceTask,
} from "../src/modules/preferenceLifetime";

describe("preference pane lifetime", function () {
  let root: HTMLElement;
  let lifetime: PreferenceLifetime;

  beforeEach(function () {
    root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    document.body.appendChild(root);
    lifetime = new PreferenceLifetime(root, window);
  });

  afterEach(function () {
    lifetime.dispose();
    root.remove();
  });

  it("removes listeners and cancels timers and requests when the pane is removed", async function () {
    let calls = 0;
    let disposals = 0;
    const target = new EventTarget();
    lifetime.listen(target, "change", () => {
      calls++;
    });
    lifetime.defer(() => {
      calls++;
    }, 20);
    lifetime.onDispose(() => {
      disposals++;
    });
    const task = new PreferenceTask(lifetime);
    let signal!: AbortSignal;
    const pending = task.run(async (value) => {
      signal = value;
      await new Promise<void>((resolve) =>
        value.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    root.remove();
    await Zotero.Promise.delay(30);
    await pending;
    target.dispatchEvent(new Event("change"));
    assert.equal(calls, 0);
    assert.equal(disposals, 1);
    assert.isTrue(signal.aborted);
    assert.isFalse(lifetime.active);
    lifetime.dispose();
    assert.equal(disposals, 1);
  });

  it("cleans up when a containing pane is replaced without closing the window", async function () {
    const parent = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    document.body.appendChild(parent);
    parent.appendChild(root);
    let disposed = false;
    lifetime.onDispose(() => {
      disposed = true;
    });
    parent.remove();
    await Zotero.Promise.delay(0);
    assert.isTrue(disposed);
  });

  it("coalesces repeated actions and keeps a replacement request locked", async function () {
    const task = new PreferenceTask(lifetime);
    let firstDone!: () => void;
    let secondDone!: () => void;
    let calls = 0;
    const first = task.run(async () => {
      calls++;
      await new Promise<void>((resolve) => {
        firstDone = resolve;
      });
    });
    await task.run(async () => {
      calls++;
    });
    assert.equal(calls, 1);
    task.cancel();
    const second = task.run(async () => {
      calls++;
      await new Promise<void>((resolve) => {
        secondDone = resolve;
      });
    });
    firstDone();
    await first;
    assert.isTrue(
      task.pending,
      "An older completion cannot unlock the new action",
    );
    secondDone();
    await second;
    assert.isFalse(task.pending);
    lifetime.dispose();
    await task.run(async () => {
      calls++;
    });
    assert.equal(calls, 2);
  });

  it("releases the action lock when a request fails", async function () {
    const task = new PreferenceTask(lifetime);
    const error = new Error("Request failed");
    try {
      await task.run(async () => {
        throw error;
      });
      assert.fail("Expected rejection");
    } catch (caught) {
      assert.strictEqual(caught, error);
    }
    assert.isFalse(task.pending);
  });
});

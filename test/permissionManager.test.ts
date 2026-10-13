import { assert } from "chai";
import { PermissionManager } from "../src/helper/runtime/PermissionManager";

describe("permission manager", function () {
  it("queues concurrent requests instead of hiding the older request", async function () {
    const manager = new PermissionManager();
    const first = manager.request({
      id: "first",
      toolName: "Bash",
      input: { command: "one" },
    });
    const second = manager.request({
      id: "second",
      toolName: "Bash",
      input: { command: "two" },
    });

    assert.equal(manager.getCurrentRequest()?.id, "first");
    manager.resolve("first", { allowed: true });
    assert.equal((await first).allowed, true);
    assert.equal(manager.getCurrentRequest()?.id, "second");
    manager.resolve("second", { allowed: false });
    assert.equal((await second).allowed, false);
    assert.isNull(manager.getCurrentRequest());
  });

  it("remembers only the same tool input", function () {
    const manager = new PermissionManager();
    manager.remember("Bash", { command: "echo one" });
    assert.isTrue(manager.isRemembered("Bash", { command: "echo one" }));
    assert.isFalse(manager.isRemembered("Bash", { command: "echo two" }));
  });

  it("does not auto-allow Bash commands containing a read-only Zotero call", async function () {
    const manager = new PermissionManager();
    const handler = manager.createCanUseToolHandler();
    const controller = new AbortController();
    const decisionPromise = handler(
      "Bash",
      {
        command:
          'curl http://127.0.0.1:23119/claudero -d \'{"action":"get_item"}\'; echo extra-command',
      },
      { signal: controller.signal },
    );
    await Promise.resolve();
    const request = manager.getCurrentRequest();
    assert.equal(request?.toolName, "Bash");
    manager.resolve(request!.id, { allowed: false });
    assert.equal((await decisionPromise).behavior, "deny");
  });

  it("resolves an aborted tool request as a denial and clears the queue", async function () {
    const manager = new PermissionManager();
    const controller = new AbortController();
    const pending = manager.createCanUseToolHandler()(
      "Write",
      { path: "/tmp/fixture" },
      { signal: controller.signal },
    );
    await Promise.resolve();
    assert.exists(manager.getCurrentRequest());
    controller.abort();
    assert.equal((await pending).behavior, "deny");
    assert.isNull(manager.getCurrentRequest());
  });

  it("immediately denies a tool request when its signal was already aborted", async function () {
    const manager = new PermissionManager();
    const controller = new AbortController();
    controller.abort();

    const decision = await manager.createCanUseToolHandler()(
      "Write",
      { path: "/tmp/already-cancelled" },
      { signal: controller.signal },
    );

    assert.equal(decision.behavior, "deny");
    assert.equal(manager.getCurrentRequest(), null);
  });

  it("resolves every queued permission when the owning turn is cancelled", async function () {
    const manager = new PermissionManager();
    const first = manager.request({
      id: "cancel-all-first",
      toolName: "Write",
      input: { path: "/tmp/one" },
    });
    const second = manager.request({
      id: "cancel-all-second",
      toolName: "Write",
      input: { path: "/tmp/two" },
    });

    manager.cancelAll();

    assert.deepEqual(await first, { allowed: false });
    assert.deepEqual(await second, { allowed: false });
    assert.isNull(manager.getCurrentRequest());
  });
});

import { assert } from "chai";
import path from "node:path";
import {
  ensureClaudeHelper,
  runAuxClaudeQuery,
  shutdownClaudeHelper,
} from "../src/modules/claudeHelperClient";
import { CLAUDERO_HELPER_VERSION } from "../src/shared/helperProtocol";

describe("helper startup lifecycle", function () {
  it("coalesces startup and cannot spawn again after shutdown during bundle preparation", async function () {
    const globals = globalThis as unknown as Record<string, unknown>;
    const names = [
      "Zotero",
      "Services",
      "Components",
      "PathUtils",
      "IOUtils",
      "ztoolkit",
      "rootURI",
      "fetch",
    ];
    const saved = names.map((name) => globals[name]);
    const prefs = new Map<string, unknown>();
    let spawned = 0;
    let killed = 0;
    let healthy = false;
    let pauseWrite = false;
    let reportWriting!: () => void;
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      reportWriting = resolve;
    });
    const blockedWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    globals.Zotero = {
      isLinux: true,
      Profile: { dir: "/home/fixture/.zotero/profile" },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
      Promise: { delay: async () => {} },
    };
    globals.Services = { env: { get: () => "" } };
    globals.PathUtils = { join: path.posix.join };
    globals.ztoolkit = { log: () => {} };
    globals.rootURI = "file:///fixture/";
    globals.IOUtils = {
      stat: async () => ({ type: "regular" }),
      exists: async () => false,
      makeDirectory: async () => {},
      readUTF8: async () => "a".repeat(64),
      setPermissions: async () => {},
      writeUTF8: async () => {
        if (pauseWrite) {
          reportWriting();
          await blockedWrite;
        }
      },
    };
    globals.Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => ({
            initWithPath() {},
            exists: () => true,
            isFile: () => true,
          }),
        },
        "@mozilla.org/process/util;1": {
          createInstance: () => ({
            init() {},
            runwAsync() {
              spawned++;
              healthy = true;
            },
            kill() {
              killed++;
              healthy = false;
            },
          }),
        },
      },
      interfaces: { nsIFile: {}, nsIProcess: {} },
    };
    globals.fetch = async (url: string) => {
      if (url.startsWith("file:")) return new Response("// fixture bundle");
      if (healthy)
        return Response.json({
          version: CLAUDERO_HELPER_VERSION,
          active: false,
        });
      throw new Error("Connection refused");
    };
    try {
      const initial = ensureClaudeHelper();
      assert.strictEqual(ensureClaudeHelper(), initial);
      await initial;
      assert.equal(spawned, 1);
      healthy = false;
      pauseWrite = true;
      const restarting = ensureClaudeHelper().catch((error) => error);
      await writing;
      const auxiliaryController = new AbortController();
      const auxiliary = runAuxClaudeQuery("fixture", {
        signal: auxiliaryController.signal,
      }).catch((error) => error);
      auxiliaryController.abort();
      assert.equal(
        (await auxiliary).name,
        "AbortError",
        "Auxiliary cancellation must not wait for shared startup IO",
      );
      assert.equal(killed, 1, "Restart cleans up its previous process");
      shutdownClaudeHelper();
      assert.equal(
        (await restarting).name,
        "AbortError",
        "Shutdown releases callers without waiting for file IO",
      );
      releaseWrite();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        spawned,
        1,
        "The pending startup must not create an orphan process",
      );
      const afterShutdown = await ensureClaudeHelper().catch((error) => error);
      assert.equal(afterShutdown.name, "AbortError");
    } finally {
      releaseWrite();
      shutdownClaudeHelper();
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete globals[name];
        else globals[name] = saved[index];
      });
    }
  });
});

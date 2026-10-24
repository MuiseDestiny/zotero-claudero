import { assert } from "chai";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  ensureClaudeHelper,
  fetchProviderModels,
  installDeepSeekHarness,
  shutdownClaudeHelper,
} from "../src/modules/claudeHelperClient";
import { CLAUDERO_HELPER_VERSION } from "../src/shared/helperProtocol";
import { HELPER_BUN_VERSION } from "../src/shared/standaloneHelper";

describe("standalone Helper startup", function () {
  it("prefers the bundled runtime, falls back after launch or health failure, and never falls back after shutdown", async function () {
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
    const files = new Map<string, Uint8Array>();
    const bytes = new Uint8Array(1024 * 1024).fill(42);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const launched: string[] = [];
    let nodeAvailable = false;
    let healthy = false;
    let killed = 0;
    let mode: "success" | "throw" | "exit" | "shutdown" = "success";
    let providerEnvironment: Record<string, string> | undefined;
    globals.Zotero = {
      isMac: true,
      Profile: { dir: "/home/fixture/.zotero/profile" },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
      Promise: { delay: async () => {} },
    };
    globals.Services = {
      appinfo: { XPCOMABI: "aarch64-gcc3", processID: 123 },
      env: { get: (key: string) => (key === "HOME" ? "/home/fixture" : "") },
    };
    globals.PathUtils = { join: path.posix.join };
    globals.ztoolkit = { log: () => {} };
    globals.rootURI = "file:///fixture/";
    globals.IOUtils = {
      stat: async (file: string) => {
        if (files.has(file))
          return { type: "regular", size: files.get(file)!.length };
        if (nodeAvailable && file === "/fixture/node")
          return { type: "regular" };
        throw new Error("Not found");
      },
      exists: async () => false,
      makeDirectory: async () => {},
      readUTF8: async () => "a".repeat(64),
      writeUTF8: async () => {},
      setPermissions: async () => {},
      write: async (file: string, value: Uint8Array) => files.set(file, value),
      computeHexDigest: async (file: string) =>
        createHash("sha256")
          .update(files.get(file) || "")
          .digest("hex"),
    };
    globals.Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => ({
            path: "",
            initWithPath(value: string) {
              this.path = value;
            },
            exists() {
              return (
                files.has(this.path) ||
                (nodeAvailable && this.path === "/fixture/node")
              );
            },
            isFile: () => true,
          }),
        },
        "@mozilla.org/process/util;1": {
          createInstance: () => ({
            executable: "",
            isRunning: false,
            exitValue: 2,
            init(file: { path: string }) {
              this.executable = file.path;
            },
            runwAsync(args: string[]) {
              const compiled = this.executable !== "/fixture/node";
              launched.push(compiled ? "standalone" : "node");
              if (compiled) assert.equal(args[0], "--script-path");
              else assert.match(args[0], /claudero-helper\.mjs$/);
              assert.include(args, "--parent-pid");
              if (compiled && mode === "shutdown") {
                void shutdownClaudeHelper();
                throw new Error("Launch failed during plugin shutdown");
              }
              if (compiled && mode === "throw")
                throw new Error("Native loader unavailable");
              this.isRunning = !(compiled && mode === "exit");
              healthy = this.isRunning;
            },
            kill() {
              killed++;
              this.isRunning = false;
              healthy = false;
            },
          }),
        },
      },
      interfaces: { nsIFile: {}, nsIProcess: {} },
    };
    globals.fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/standalone/manifest.json"))
        return Response.json({
          schemaVersion: 1,
          helperVersion: CLAUDERO_HELPER_VERSION,
          bunVersion: HELPER_BUN_VERSION,
          binaries: [
            {
              platform: "darwin",
              arch: "arm64",
              file: "claudero-helper-darwin-arm64",
              bytes: bytes.length,
              sha256: digest,
            },
          ],
        });
      if (url.includes("/standalone/")) return new Response(bytes);
      if (url.startsWith("file:")) return new Response("// fixture bundle");
      if (
        healthy &&
        (url.endsWith("/models") || url.endsWith("/install-deepseek"))
      ) {
        providerEnvironment = JSON.parse(String(init?.body)).environment;
        if (url.endsWith("/install-deepseek"))
          return Response.json({
            cliPath: "/fixture/dsh.js",
            installRoot: "/fixture/deepseek",
            nodePath: "/fixture/node",
          });
        return Response.json({ models: [] });
      }
      if (healthy)
        return Response.json({
          version: CLAUDERO_HELPER_VERSION,
          active: false,
        });
      throw new Error("Connection refused");
    };
    try {
      await ensureClaudeHelper();
      assert.deepEqual(launched, ["standalone"], "No Node exists on the host");
      assert.equal(files.size, 1);

      nodeAvailable = true;
      prefs.set("extensions.zotero.claudero.nodePath", "/fixture/node");
      await fetchProviderModels("deepseek");
      assert.equal(providerEnvironment?.PATH, "/fixture");
      prefs.set(
        "extensions.zotero.claudero.environmentVariables",
        "PATH=/tools:$PATH",
      );
      await fetchProviderModels("codex");
      assert.equal(providerEnvironment?.PATH, "/tools:/fixture");
      prefs.set("extensions.zotero.claudero.environmentVariables", "");
      const installed = await installDeepSeekHarness();
      assert.equal(installed.nodePath, "/fixture/node");
      assert.equal(providerEnvironment?.PATH, "/fixture");
      for (const failure of ["throw", "exit"] as const) {
        mode = failure;
        healthy = false;
        launched.length = 0;
        await ensureClaudeHelper();
        assert.deepEqual(launched, ["standalone", "node"]);
      }
      assert.equal(killed, 4, "Failed and replaced processes are cleaned up");

      mode = "throw";
      healthy = false;
      nodeAvailable = false;
      launched.length = 0;
      const missing = await ensureClaudeHelper().catch((error) => error);
      assert.match(String(missing), /Node\.js not found/);
      assert.deepEqual(
        launched,
        ["standalone"],
        "No 40-port runtime retry loop",
      );

      mode = "shutdown";
      nodeAvailable = true;
      prefs.set("extensions.zotero.claudero.nodePath", "/fixture/node");
      launched.length = 0;
      const cancelled = await ensureClaudeHelper().catch((error) => error);
      assert.equal(cancelled.name, "AbortError");
      assert.deepEqual(launched, ["standalone"]);
    } finally {
      await shutdownClaudeHelper();
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete globals[name];
        else globals[name] = saved[index];
      });
    }
  });
});

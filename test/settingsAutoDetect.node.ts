import { assert } from "chai";
import path from "node:path";
import { autoDetectSettings } from "../src/modules/settingsAutoDetect";
import {
  getHostKey,
  getProviderCliPath,
  setCodexInstallationMethod,
  setProviderCliPath,
} from "../src/modules/providerRegistry";
import { getPref, setPref } from "../src/utils/prefs";

describe("settings auto-detection", function () {
  const globals = globalThis as unknown as Record<string, unknown>;
  const names = ["Zotero", "Services", "Components", "PathUtils", "IOUtils"];
  let saved: unknown[];
  let files: Set<string>;
  let environment: Record<string, string>;
  beforeEach(function () {
    saved = names.map((name) => globals[name]);
    files = new Set();
    environment = {};
    const prefs = new Map<string, unknown>();
    globals.Zotero = {
      isWin: false,
      isMac: false,
      isLinux: true,
      Profile: { dir: "/home/me/.zotero/zotero/profile" },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    };
    globals.Services = {
      env: { get: (key: string) => environment[key] || "" },
    };
    globals.PathUtils = { join: path.posix.join };
    globals.IOUtils = {
      exists: async () => false,
      stat: async (candidate: string) => {
        if (!files.has(candidate)) throw new Error("Not found");
        return { type: "regular" };
      },
    };
    globals.Components = {
      classes: {
        "@mozilla.org/file/local;1": {
          createInstance: () => {
            let filePath = "";
            return {
              initWithPath: (value: string) => {
                filePath = value;
              },
              exists: () => files.has(filePath),
              isFile: () => true,
            };
          },
        },
      },
      interfaces: { nsIFile: {} },
    };
  });
  afterEach(function () {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete globals[name];
      else globals[name] = saved[index];
    });
  });

  function useWindows(): void {
    globals.Zotero = {
      ...(globals.Zotero as object),
      isWin: true,
      isLinux: false,
      Profile: {
        dir: "C:\\Users\\reader\\AppData\\Roaming\\Zotero\\Profiles\\test",
      },
    };
    globals.PathUtils = { join: path.win32.join };
    environment.USERPROFILE = "C:\\Users\\reader";
  }

  it("repairs vanished automatically discovered Node and CLI paths after upgrades", async function () {
    files.add("/usr/bin/node");
    files.add("/usr/bin/codex");
    await autoDetectSettings();
    const host = getHostKey();
    assert.equal(
      JSON.parse(String(getPref("autoDetectedPaths")))[`${host}:codex`],
      "/usr/bin/codex",
    );
    files.delete("/usr/bin/node");
    files.delete("/usr/bin/codex");
    files.add("/usr/local/bin/node");
    files.add("/usr/local/bin/codex");
    const result = await autoDetectSettings();
    assert.equal(result.nodePath, "/usr/local/bin/node");
    assert.equal(result.codexPath, "/usr/local/bin/codex");
    assert.equal(getProviderCliPath("codex"), result.codexPath);
    assert.equal(
      JSON.parse(String(getPref("autoDetectedPaths")))[`${host}:node`],
      result.nodePath,
    );
  });

  it("does not replace a still-valid automatic path with a newly preferred program", async function () {
    files.add("/usr/bin/node");
    await autoDetectSettings();
    files.add("/usr/local/bin/node");
    const result = await autoDetectSettings();
    assert.isUndefined(result.nodePath);
    assert.equal(getPref("nodePath"), "/usr/bin/node");
  });

  it("preserves manual overrides even after an earlier automatic discovery", async function () {
    files.add("/usr/bin/node");
    files.add("/usr/bin/claude");
    await autoDetectSettings();
    setPref("nodePath", "/manual/node");
    setProviderCliPath("claude", "/manual/claude");
    const result = await autoDetectSettings();
    assert.isUndefined(result.nodePath);
    assert.isUndefined(result.claudePath);
    assert.equal(getPref("nodePath"), "/manual/node");
    assert.equal(getProviderCliPath("claude"), "/manual/claude");
  });

  it("does not trust another host's detection provenance", async function () {
    setPref("nodePath", "/old/node");
    setProviderCliPath("codex", "/old/codex");
    setPref(
      "autoDetectedPaths",
      JSON.stringify({
        "different-host:node": "/old/node",
        "different-host:codex": "/old/codex",
      }),
    );
    files.add("/usr/bin/node");
    files.add("/usr/bin/codex");
    const result = await autoDetectSettings();
    assert.isUndefined(result.nodePath);
    assert.isUndefined(result.codexPath);
  });

  it("treats corrupt provenance as unknown instead of replacing configured paths", async function () {
    setPref("nodePath", "/legacy/node");
    setPref("autoDetectedPaths", "{broken");
    files.add("/usr/bin/node");
    assert.isUndefined((await autoDetectSettings()).nodePath);
    setPref("nodePath", "");
    assert.equal((await autoDetectSettings()).nodePath, "/usr/bin/node");
    assert.equal(
      JSON.parse(String(getPref("autoDetectedPaths")))[`${getHostKey()}:node`],
      "/usr/bin/node",
    );
  });

  it("preserves a Node override edited while discovery is running", async function () {
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      stat: async (candidate: string) => {
        if (candidate === "/usr/bin/node") {
          setPref("nodePath", "/manual/node");
          return { type: "regular" };
        }
        throw new Error("Not found");
      },
    };
    assert.isUndefined((await autoDetectSettings()).nodePath);
    assert.equal(getPref("nodePath"), "/manual/node");
  });

  it("derives Linux HOME from the profile when the GUI has no HOME variable", async function () {
    files.add("/home/me/.local/bin/claude");
    await autoDetectSettings();
    assert.equal(getProviderCliPath("claude"), "/home/me/.local/bin/claude");
  });

  it("finds npm CLIs beside a detected NVM Node even with an empty PATH", async function () {
    const bin = "/home/me/.nvm/versions/node/v24.1.0/bin";
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      exists: async () => true,
      getChildren: async () => [path.posix.dirname(bin)],
    };
    files.add(`${bin}/node`);
    files.add(`${bin}/codex`);
    const result = await autoDetectSettings();
    assert.equal(result.nodePath, `${bin}/node`);
    assert.equal(result.codexPath, `${bin}/codex`);
  });

  it("finds CLIs in other NVM versions without changing the configured Node", async function () {
    const root = "/home/me/.nvm/versions/node";
    let scans = 0;
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      exists: async () => true,
      getChildren: async () => {
        scans++;
        return [`${root}/v22.0.0`, `${root}/v24.1.0`];
      },
    };
    setPref("nodePath", "/custom/node");
    files.add(`${root}/v22.0.0/bin/claude`);
    files.add(`${root}/v24.1.0/bin/codex`);
    files.add(`${root}/v22.0.0/bin/dsh`);
    const result = await autoDetectSettings();
    assert.equal(result.claudePath, `${root}/v22.0.0/bin/claude`);
    assert.equal(result.codexPath, `${root}/v24.1.0/bin/codex`);
    assert.equal(result.deepseekPath, `${root}/v22.0.0/bin/dsh`);
    assert.equal(getPref("nodePath"), "/custom/node");
    assert.equal(scans, 1, "All providers share a single NVM directory scan");
  });

  it("inherits a custom NVM_DIR without requiring a Node path", async function () {
    environment.NVM_DIR = "/custom/nvm";
    const root = `${environment.NVM_DIR}/versions/node`;
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      exists: async (candidate: string) => candidate === root,
      getChildren: async () => [`${root}/v24.1.0`],
    };
    files.add(`${root}/v24.1.0/bin/node`);
    const result = await autoDetectSettings();
    assert.equal(result.nodePath, `${root}/v24.1.0/bin/node`);
  });

  for (const app of [
    "/Applications/Codex.app",
    "/Applications/ChatGPT.app",
    "/home/me/Applications/Codex.app",
  ]) {
    it(`uses the bundled CLI from ${app} without a separate CLI install`, async function () {
      globals.Zotero = {
        ...(globals.Zotero as object),
        isMac: true,
        isLinux: false,
      };
      environment.HOME = "/home/me";
      const bundled = `${app}/Contents/Resources/codex`;
      files.add(bundled);
      const result = await autoDetectSettings();
      assert.equal(result.codexPath, bundled);
    });
  }

  it("does not detect macOS app bundles on Linux", async function () {
    files.add("/Applications/Codex.app/Contents/Resources/codex");
    const result = await autoDetectSettings();
    assert.isUndefined(result.codexPath);
  });

  it("finds Windows Node through NVM_SYMLINK with an empty PATH", async function () {
    useWindows();
    environment.NVM_SYMLINK = "D:\\nvm\\nodejs";
    files.add("D:\\nvm\\nodejs\\node.exe");
    const result = await autoDetectSettings();
    assert.equal(result.nodePath, "D:\\nvm\\nodejs\\node.exe");
  });

  for (const directory of ["ProgramFiles", "ProgramFiles(x86)"]) {
    it(`finds Windows Node under the inherited ${directory} directory`, async function () {
      useWindows();
      environment[directory] = "D:\\Applications";
      files.add("D:\\Applications\\nodejs\\node.exe");
      const result = await autoDetectSettings();
      assert.equal(result.nodePath, "D:\\Applications\\nodejs\\node.exe");
    });
  }

  it("finds a Windows Codex installation outside PATH", async function () {
    useWindows();
    environment.LOCALAPPDATA = "D:\\Profiles\\Local";
    const cli = "D:\\Profiles\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    files.add(cli);
    const result = await autoDetectSettings();
    assert.equal(result.codexPath, cli);
  });

  it("finds a globally installed Windows DeepSeek entrypoint outside PATH", async function () {
    useWindows();
    environment.APPDATA = "D:\\Profiles\\Roaming";
    const cli =
      "D:\\Profiles\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
    files.add(cli);
    const result = await autoDetectSettings();
    assert.equal(result.deepseekPath, cli);
  });

  it("leaves manual overrides untouched when other installations are available", async function () {
    setPref("nodePath", "/manual/node");
    setProviderCliPath("claude", "/manual/claude");
    setProviderCliPath("codex", "/manual/codex");
    setProviderCliPath("deepseek", "/manual/dsh");
    for (const executable of ["node", "claude", "codex", "dsh"]) {
      files.add(`/usr/bin/${executable}`);
    }
    assert.deepEqual(await autoDetectSettings(), {});
    assert.equal(getPref("nodePath"), "/manual/node");
    assert.equal(getProviderCliPath("codex"), "/manual/codex");
  });

  it("does not populate a WSL CLI setting with a native installation", async function () {
    setCodexInstallationMethod("wsl");
    files.add("/usr/bin/codex");
    await autoDetectSettings();
    assert.equal(getProviderCliPath("codex"), "");
  });

  it("preserves manual edits made while an asynchronous scan is running", async function () {
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      exists: async () => {
        setPref("nodePath", "/chosen/node");
        return false;
      },
    };
    files.add("/usr/bin/node");
    const result = await autoDetectSettings();
    assert.equal(getPref("nodePath"), "/chosen/node");
    assert.isUndefined(result.nodePath);
  });

  it("uses asynchronous file metadata instead of blocking Zotero's UI", async function () {
    globals.Components = undefined;
    files.add("/usr/bin/node");
    files.add("/usr/bin/claude");
    const result = await autoDetectSettings();
    assert.equal(result.nodePath, "/usr/bin/node");
    assert.equal(result.claudePath, "/usr/bin/claude");
  });

  it("coalesces simultaneous scans and sees installations added after a miss", async function () {
    let scans = 0;
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      exists: async () => {
        scans++;
        return false;
      },
    };
    files.add("/usr/bin/node");
    await Promise.all([
      autoDetectSettings(),
      autoDetectSettings(),
      autoDetectSettings(),
    ]);
    assert.equal(scans, 1);
    assert.equal(getProviderCliPath("claude"), "");
    files.add("/usr/bin/claude");
    await autoDetectSettings();
    assert.equal(getProviderCliPath("claude"), "/usr/bin/claude");
  });

  it("does not save native Codex discovery after the user switches to WSL", async function () {
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      stat: async (candidate: string) => {
        if (candidate === "/usr/bin/codex") {
          setCodexInstallationMethod("wsl");
          return { type: "regular" };
        }
        throw new Error("Not found");
      },
    };
    const result = await autoDetectSettings();
    assert.isUndefined(result.codexPath);
    assert.equal(getProviderCliPath("codex"), "");
  });

  it("preserves a CLI path edited while file metadata is being read", async function () {
    globals.IOUtils = {
      ...(globals.IOUtils as object),
      stat: async (candidate: string) => {
        if (candidate === "/usr/bin/claude") {
          setProviderCliPath("claude", "/manual/claude");
          return { type: "regular" };
        }
        throw new Error("Not found");
      },
    };
    const result = await autoDetectSettings();
    assert.isUndefined(result.claudePath);
    assert.equal(getProviderCliPath("claude"), "/manual/claude");
  });
});

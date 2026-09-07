import { assert } from "chai";
import path from "node:path";
import { autoDetectSettings } from "../src/modules/settingsAutoDetect";
import {
  getProviderCliPath,
  setCodexInstallationMethod,
} from "../src/modules/providerRegistry";
import { getPref, setPref } from "../src/utils/prefs";

describe("settings auto-detection", function () {
  const globals = globalThis as unknown as Record<string, unknown>;
  const names = ["Zotero", "Services", "Components", "PathUtils", "IOUtils"];
  let saved: unknown[];
  let files: Set<string>;
  beforeEach(function () {
    saved = names.map((name) => globals[name]);
    files = new Set();
    const prefs = new Map<string, unknown>();
    globals.Zotero = {
      isWin: false,
      isLinux: true,
      Profile: { dir: "/home/me/.zotero/zotero/profile" },
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    };
    globals.Services = { env: { get: () => "" } };
    globals.PathUtils = { join: path.posix.join };
    globals.IOUtils = { exists: async () => false };
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

  it("derives Linux HOME from the profile when the GUI has no HOME variable", async function () {
    files.add("/home/me/.local/bin/claude");
    await autoDetectSettings();
    assert.equal(getProviderCliPath("claude"), "/home/me/.local/bin/claude");
  });

  it("finds npm CLIs beside a detected NVM Node even with an empty PATH", async function () {
    const bin = "/home/me/.nvm/versions/node/v24.1.0/bin";
    globals.IOUtils = {
      exists: async () => true,
      getChildren: async () => [path.posix.dirname(bin)],
    };
    files.add(`${bin}/node`);
    files.add(`${bin}/codex`);
    const result = await autoDetectSettings();
    assert.equal(result.nodePath, `${bin}/node`);
    assert.equal(result.codexPath, `${bin}/codex`);
  });

  it("does not populate a WSL CLI setting with a native installation", async function () {
    setCodexInstallationMethod("wsl");
    files.add("/usr/bin/codex");
    await autoDetectSettings();
    assert.equal(getProviderCliPath("codex"), "");
  });

  it("preserves manual edits made while an asynchronous scan is running", async function () {
    globals.IOUtils = {
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
});

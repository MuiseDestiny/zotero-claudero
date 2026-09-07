import { assert } from "chai";
import { config } from "../package.json";
import {
  getProviderCliPath,
  setProviderCliPath,
  saveProviderConfigs,
  getCodexInstallationMethod,
  setCodexInstallationMethod,
  getCodexWslDistro,
  setCodexWslDistro,
  type AiProvider,
} from "../src/modules/providerRegistry";

describe("device-scoped provider settings", function () {
  const globals = globalThis as unknown as Record<string, unknown>;
  let original: unknown;
  let prefs: Map<string, unknown>;
  beforeEach(function () {
    original = globals.Zotero;
    prefs = new Map();
    globals.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
    };
  });
  afterEach(function () {
    if (original === undefined) delete globals.Zotero;
    else globals.Zotero = original;
  });

  for (const provider of ["claude", "codex", "deepseek"] as AiProvider[]) {
    it(`clears ${provider} paths without resurrecting a legacy path`, function () {
      setProviderCliPath(provider, "/old/cli", "device-a");
      setProviderCliPath(provider, "", "device-a");
      assert.equal(getProviderCliPath(provider, "device-a"), "");
    });
    it(`isolates ${provider} paths on different devices`, function () {
      setProviderCliPath(provider, "/a/cli", "device-a");
      assert.equal(getProviderCliPath(provider, "device-b"), "");
      setProviderCliPath(provider, "/b/cli", "device-b");
      assert.equal(getProviderCliPath(provider, "device-a"), "/a/cli");
    });
  }

  it("retains legacy paths before per-device configuration exists", function () {
    prefs.set(`${config.prefsPrefix}.claudePath`, "/legacy/claude");
    assert.equal(getProviderCliPath("claude", "device-a"), "/legacy/claude");
    saveProviderConfigs({ codex: { cliPath: "/legacy/codex" } });
    assert.equal(getProviderCliPath("codex", "device-a"), "/legacy/codex");
  });

  it("does not inherit WSL mode or its distribution on a new device", function () {
    setCodexInstallationMethod("wsl", "windows-a");
    setCodexWslDistro("Ubuntu", "windows-a");
    assert.equal(getCodexInstallationMethod("mac-b"), "native");
    assert.equal(getCodexWslDistro("mac-b"), "");
    setCodexWslDistro("Debian", "windows-c");
    setCodexWslDistro("", "windows-a");
    assert.equal(getCodexWslDistro("windows-a"), "");
    assert.equal(getCodexWslDistro("windows-c"), "Debian");
  });
});

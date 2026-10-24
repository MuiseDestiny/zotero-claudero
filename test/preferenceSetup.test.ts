import { assert } from "chai";
import { bindSetupWizard } from "../src/modules/preferenceSetup";
import { PreferenceLifetime } from "../src/modules/preferenceLifetime";
import {
  setProviderCliPath,
  type AiProvider,
} from "../src/modules/providerRegistry";
import { clearPref, getPref, setPref } from "../src/utils/prefs";
import { getString } from "../src/utils/locale";
import { installUiTestContext } from "./uiTestContext";

describe("Node-free preference setup", function () {
  let root: HTMLElement;
  let lifetime: PreferenceLifetime;
  let restoreContext: () => void;
  let restorePrefs: () => void;
  let standaloneReady: boolean;
  let providerNeedsNode: boolean;
  let healthChecks: number;
  const cliPath = "/fixture/native-agent";

  const button = () =>
    root.querySelector<HTMLButtonElement>("#claudero-pref-setup-run")!;
  const row = () =>
    root.querySelector<HTMLElement>(".claudero-pref-setup-row")!;
  const waitForScan = async () => {
    for (let attempt = 0; attempt < 100 && button().disabled; attempt++)
      await Zotero.Promise.delay(10);
    assert.isFalse(button().disabled, "Setup scan must settle");
    assert.lengthOf(root.querySelectorAll(".claudero-pref-setup-row"), 3);
  };
  const bind = async (provider: AiProvider) => {
    setPref("provider", provider);
    setProviderCliPath(provider, cliPath);
    bindSetupWizard(document, lifetime, {
      autoDetectSettings: async () => ({}),
      settingsFileExists: async (path: string) => path === cliPath,
      hasStandaloneHelper: async () => standaloneReady,
      providerCliNeedsNode: async () => providerNeedsNode,
      requestHelperJson: async <T>(endpoint: string) => {
        assert.equal(endpoint, "/health");
        healthChecks++;
        return {} as T;
      },
    });
    await waitForScan();
  };

  beforeEach(function () {
    restoreContext = installUiTestContext();
    const keys = [
      "provider",
      "providerConfigs",
      "nodePath",
      "setupChecked",
      "claudePath",
      "codexPath",
      "deepseekPath",
    ] as const;
    const saved = keys.map((key) => getPref(key));
    restorePrefs = () => {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) clearPref(key);
        else setPref(key, saved[index]);
      });
    };
    setPref("nodePath", "/not-installed/node");
    setPref("providerConfigs", "{}");
    standaloneReady = true;
    providerNeedsNode = false;
    healthChecks = 0;
    root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    root.className = "claudero-pref-stack";
    for (const [tag, id] of [
      ["button", "claudero-pref-setup-run"],
      ["div", "claudero-pref-setup-status"],
      ["div", "claudero-pref-setup-details"],
      ["details", "claudero-pref-setup-disclosure"],
    ]) {
      const element = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        tag,
      );
      element.id = id;
      root.append(element);
    }
    document.body.append(root);
    lifetime = new PreferenceLifetime(root, window);
  });

  afterEach(function () {
    lifetime.dispose();
    root.remove();
    restorePrefs();
    restoreContext();
  });

  const checkNative = async (provider: AiProvider) => {
    await bind(provider);
    assert.isTrue(row().classList.contains("success"));
    assert.include(row().textContent, getString("pref-setup-standalone-ready"));
    assert.isEmpty(row().querySelectorAll("button"));
    assert.notInclude(
      root.textContent,
      getString("pref-setup-action-install-node"),
    );
    assert.include(root.textContent, getString("pref-setup-action-login"));
    assert.equal(
      healthChecks,
      0,
      "Opening preferences must not start a Helper",
    );
    button().click();
    for (let attempt = 0; attempt < 100 && button().disabled; attempt++)
      await Zotero.Promise.delay(10);
    assert.isFalse(button().disabled);
    assert.equal(healthChecks, 1);
    assert.equal(
      root.querySelector("#claudero-pref-setup-status")!.textContent,
      getString("pref-setup-complete"),
    );
  };

  const checkNodeRequired = async (provider: AiProvider) => {
    providerNeedsNode = provider !== "deepseek";
    await bind(provider);
    assert.isTrue(row().classList.contains("error"));
    assert.include(
      row().textContent,
      getString("pref-setup-action-install-node"),
    );
    assert.isEmpty(
      root.querySelectorAll(".claudero-pref-setup-row:last-child button"),
    );
    assert.equal(healthChecks, 0);
  };

  it("does not request Node for native Claude and can check the Helper", async function () {
    await checkNative("claude");
  });

  it("does not request Node for native Codex and can check the Helper", async function () {
    await checkNative("codex");
  });

  it("retains the Node prerequisite for Claude scripts", async function () {
    await checkNodeRequired("claude");
  });

  it("retains the Node prerequisite for Codex scripts", async function () {
    await checkNodeRequired("codex");
  });

  it("retains the Node prerequisite for DeepSeek", async function () {
    await checkNodeRequired("deepseek");
  });

  it("retains repair guidance for an explicitly portable package", async function () {
    standaloneReady = false;
    await bind("codex");
    assert.isTrue(row().classList.contains("error"));
    assert.include(row().textContent, getString("pref-setup-node-missing"));
    assert.include(
      row().textContent,
      getString("pref-setup-action-install-node"),
    );
    assert.equal(healthChecks, 0);
  });
});

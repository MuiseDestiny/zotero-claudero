import {
  getCodexInstallationMethod,
  getProviderCliPath,
  getProviderEnvironment,
  normalizeProvider,
  providerLabel,
  type AiProvider,
} from "./providerRegistry";
import {
  fetchProviderModels,
  requestHelperJson,
  installDeepSeekHarness,
  runProviderAuthLogin,
} from "./claudeHelperClient";
import {
  autoDetectSettings,
  settingsFileExists,
  type SettingsAutoDetectResult,
} from "./settingsAutoDetect";
import { setupActions, type SetupAction } from "./setupGuide";
import { PreferenceLifetime } from "./preferenceLifetime";
import { waitWithSignal } from "../shared/requestDeadline";
import { buildRuntimeEnvironment } from "../shared/runtimeEnvironment";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";

function syncDetectedPaths(
  doc: Document,
  detected: SettingsAutoDetectResult,
): void {
  for (const provider of ["claude", "codex", "deepseek"] as AiProvider[]) {
    const input = doc.querySelector<HTMLInputElement>(
      `#claudero-pref-${provider}-path`,
    );
    if (
      input &&
      (!input.value.trim() || detected[`${provider}Path`]) &&
      doc.activeElement !== input
    ) {
      input.value = getProviderCliPath(provider);
    }
  }
  const node = doc.querySelector<HTMLInputElement>(
    "#zotero-prefpane-claudero-nodePath",
  );
  if (
    node &&
    (!node.value.trim() || detected.nodePath) &&
    doc.activeElement !== node
  ) {
    node.value = String(getPref("nodePath") || "");
  }
}

export function bindSetupWizard(
  doc: Document,
  lifetime: PreferenceLifetime,
): void {
  const root = doc.querySelector<HTMLElement>(".claudero-pref-stack");
  const win = doc.defaultView;
  const runButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-setup-run",
  );
  const status = doc.querySelector<HTMLElement>("#claudero-pref-setup-status");
  const details = doc.querySelector<HTMLElement>(
    "#claudero-pref-setup-details",
  );
  const disclosure = doc.querySelector<HTMLDetailsElement>(
    "#claudero-pref-setup-disclosure",
  );
  if (!root || !win || !runButton || !status || !details) return;

  let revision = 0;
  let cancelRefresh = () => {};
  let currentCheck: AbortController | undefined;
  const revealPath = (provider?: AiProvider, control = "path") => {
    const section = doc.querySelector<HTMLDetailsElement>(
      `#claudero-pref-${provider || "general"}-advanced`,
    );
    if (section) section.open = true;
    doc
      .querySelector<HTMLButtonElement>(
        `#claudero-pref-tab-${provider || "general"}`,
      )
      ?.click();
    doc
      .querySelector<HTMLInputElement>(
        provider
          ? `#claudero-pref-${provider}-${control}`
          : "#zotero-prefpane-claudero-nodePath",
      )
      ?.focus();
  };

  type SetupRowState = "success" | "error" | "info";
  const createRow = (
    label: string,
    rowState: SetupRowState,
    detail: string,
    actions: Array<{
      label: string;
      run: (button: HTMLButtonElement) => void;
    }> = [],
  ): HTMLElement => {
    const row = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    row.className = `claudero-pref-setup-row ${rowState}`;
    const marker = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLElement;
    marker.textContent =
      rowState === "success" ? "✓" : rowState === "error" ? "!" : "i";
    const text = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLElement;
    text.textContent = `${label}: ${detail}`;
    row.append(marker, text);
    for (const action of actions) {
      const button = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        if (lifetime.active) action.run(button);
      });
      row.appendChild(button);
    }
    return row;
  };

  const repairActions = (actions: SetupAction[], provider: AiProvider) =>
    actions.map((action) => ({
      label: getString(`pref-setup-action-${action}`),
      run: (button: HTMLButtonElement) => {
        if (action === "node-path") return revealPath();
        if (action === "cli-path") return revealPath(provider);
        if (action === "provider-settings") return revealPath(provider, "env");
        if (action === "install-node") {
          Zotero.launchURL("https://nodejs.org/en/download");
          return;
        }
        if (action === "install-provider" || action === "wsl-login") {
          Zotero.launchURL(
            `https://github.com/MuiseDestiny/zotero-claudero#${provider === "claude" ? "claude-code" : provider === "deepseek" ? "deepseek-harness" : "codex"}`,
          );
          return;
        }
        const startedAtRevision = revision;
        const current = () => lifetime.active && revision === startedAtRevision;
        button.disabled = true;
        const operation =
          action === "install-deepseek"
            ? installDeepSeekHarness()
            : runProviderAuthLogin(provider);
        void operation
          .then(() => {
            if (!current()) return;
            if (action === "install-deepseek") void run();
            else {
              status.classList.remove("error", "success");
              status.textContent = getString("pref-setup-login-opened");
            }
          })
          .catch((error: unknown) => {
            if (!current()) return;
            status.textContent = getString("pref-setup-failed", {
              args: { error: String(error) },
            });
            status.classList.add("error");
          })
          .finally(() => {
            if (lifetime.active && button.isConnected) button.disabled = false;
          });
      },
    }));

  // Opening settings only scans local files. Starting a helper and checking
  // runtime compatibility remain an explicit troubleshooting action.
  const run = async (checkRuntime = false) => {
    if (!lifetime.active) return;
    currentCheck?.abort();
    const controller = new AbortController();
    currentCheck = controller;
    const { signal } = controller;
    const release = lifetime.onDispose(() => controller.abort());
    const current = ++revision;
    const isCurrent = () =>
      current === revision && lifetime.active && !signal.aborted;
    runButton.disabled = true;
    status.classList.remove("error", "success");
    status.textContent = getString(
      checkRuntime ? "pref-setup-running" : "pref-detect-running",
    );
    details.replaceChildren();
    try {
      const detected = await waitWithSignal(autoDetectSettings(), signal);
      if (!isCurrent()) return;
      syncDetectedPaths(doc, detected);
      const providers = ["claude", "codex", "deepseek"] as const;
      const paths = Object.fromEntries(
        providers.map((provider) => [provider, getProviderCliPath(provider)]),
      );
      const [nodeOk, ...cliChecks] = await waitWithSignal(
        Promise.all([
          settingsFileExists(String(getPref("nodePath") || "")),
          ...providers.map((provider) => settingsFileExists(paths[provider])),
        ]),
        signal,
      );
      if (!isCurrent()) return;
      for (const [index, candidate] of providers.entries()) {
        const summary = doc.querySelector<HTMLElement>(
          `#claudero-pref-${candidate}-detected`,
        );
        if (!summary) continue;
        const wsl =
          candidate === "codex" && getCodexInstallationMethod() === "wsl";
        summary.textContent = getString(
          wsl
            ? "pref-setup-wsl-cli"
            : cliChecks[index]
              ? "pref-cli-detected"
              : "pref-cli-missing",
        );
      }
      const provider = normalizeProvider(getPref("provider"));
      const nodePath = String(getPref("nodePath") || "");
      const cliPath = getProviderCliPath(provider);
      const usesWsl =
        provider === "codex" && getCodexInstallationMethod() === "wsl";
      const cliOk = usesWsl || cliChecks[providers.indexOf(provider)];
      const actions = setupActions(provider, nodeOk, cliOk, usesWsl);
      details.append(
        createRow(
          getString("pref-setup-node"),
          nodeOk ? "success" : "error",
          nodeOk ? nodePath : getString("pref-setup-node-missing"),
          repairActions(actions.node, provider),
        ),
        createRow(
          getString("pref-setup-cli", { args: { provider } }),
          usesWsl ? "info" : cliOk ? "success" : "error",
          usesWsl
            ? getString("pref-setup-wsl-cli")
            : cliOk
              ? cliPath
              : getString("pref-setup-cli-missing", {
                  args: { provider: providerLabel(provider) },
                }),
          repairActions(actions.cli, provider),
        ),
        createRow(
          getString("pref-setup-auth"),
          "info",
          getString(
            provider === "deepseek"
              ? "pref-setup-auth-key"
              : usesWsl
                ? "pref-setup-auth-wsl"
                : "pref-setup-auth-login",
          ),
          repairActions(actions.auth, provider),
        ),
      );
      const pathsOk = nodeOk && cliOk;
      if (disclosure && !pathsOk) disclosure.open = true;
      if (!checkRuntime || !pathsOk) {
        status.textContent = getString(
          !pathsOk
            ? "pref-detect-action-needed"
            : usesWsl
              ? "pref-detect-wsl"
              : "pref-detect-complete",
        );
        if (!pathsOk) status.classList.add("error");
        return;
      }
      const envKeys = Object.keys(
        buildRuntimeEnvironment(
          String(getPref("proxy") || ""),
          String(getPref("environmentVariables") || ""),
          getProviderEnvironment(provider),
          (name) => Services.env.get(name),
        ),
      );
      let helperReady = false;
      let helperError = "";
      try {
        await requestHelperJson("/health", { signal });
        helperReady = true;
      } catch (error) {
        helperError = error instanceof Error ? error.message : String(error);
      }
      if (!isCurrent()) return;
      let runtimeState: SetupRowState = "info";
      let runtimeDetail = getString("pref-setup-runtime-not-checked");
      if (provider === "deepseek") {
        if (nodeOk && cliOk && helperReady) {
          try {
            // /models runs the same DeepSeek Node/entrypoint resolution used by
            // a real request, without contacting the model API.
            await fetchProviderModels("deepseek", signal);
            runtimeState = "success";
            runtimeDetail = getString("pref-setup-runtime-ready");
          } catch (error) {
            runtimeState = "error";
            runtimeDetail =
              error instanceof Error ? error.message : String(error);
          }
        }
      }
      if (!isCurrent()) return;
      details.append(
        createRow(
          getString("pref-setup-env"),
          envKeys.length > 0 ? "success" : "info",
          envKeys.length > 0
            ? envKeys.join(", ")
            : getString("pref-setup-env-empty"),
        ),
        createRow(
          getString("pref-setup-helper"),
          helperReady ? "success" : "error",
          helperReady ? getString("pref-setup-ready") : helperError,
        ),
      );
      if (provider === "deepseek") {
        details.append(
          createRow(
            getString("pref-setup-runtime"),
            runtimeState,
            runtimeDetail,
          ),
        );
      }
      const allRuntimeChecksPassed =
        provider !== "deepseek" || runtimeState === "success";
      const allOk = nodeOk && cliOk && helperReady && allRuntimeChecksPassed;
      status.textContent = allOk
        ? getString("pref-setup-complete")
        : getString("pref-setup-action-needed");
      status.classList.add(allOk ? "success" : "error");
      if (disclosure && !allOk) disclosure.open = true;
      setPref("setupChecked", true);
    } catch (error) {
      if (!isCurrent()) return;
      status.textContent = getString("pref-setup-failed", {
        args: { error: error instanceof Error ? error.message : String(error) },
      });
      status.classList.add("error");
    } finally {
      release();
      if (currentCheck === controller) currentCheck = undefined;
      if (isCurrent()) runButton.disabled = false;
    }
  };

  lifetime.listen(runButton, "click", () => void run(true));
  const relevantControl = (event: Event) => {
    // A XUL command originates at the selected menuitem, not the menulist.
    const id =
      (event.target as Element)?.closest("input, textarea, menulist")?.id || "";
    return (
      /^zotero-prefpane-claudero-(provider|nodePath|proxy|environmentVariables)$/.test(
        id,
      ) ||
      /^claudero-pref-(claude|codex|deepseek)-(path|env|installation|wsl-distro)$/.test(
        id,
      )
    );
  };
  const refresh = (event: Event) => {
    if (!relevantControl(event)) return;
    ++revision;
    currentCheck?.abort();
    cancelRefresh();
    // Let Zotero's preference bindings finish saving before re-reading them.
    cancelRefresh = lifetime.defer(() => {
      void run();
    });
  };
  lifetime.listen(root, "change", refresh);
  lifetime.listen(root, "command", refresh);
  lifetime.onDispose(() => {
    ++revision;
    currentCheck?.abort();
  });
  void run();
}

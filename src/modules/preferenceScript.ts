import {
  getCodexInstallationMethod,
  getCodexSafeMode,
  getCodexWslDistro,
  getHostKey,
  getProviderCliPath,
  getProviderEnvironment,
  setCodexInstallationMethod,
  setCodexSafeMode,
  setCodexWslDistro,
  setProviderCliPath,
  setProviderEnvironment,
  type AiProvider,
} from "./providerRegistry";
import {
  getCustomMcpServersRaw,
  parseManagedMcpServers,
  parseCustomMcpServers,
  serializeManagedMcpServers,
  setCustomMcpServersRaw,
  type ManagedMcpServerConfig,
} from "./mcpSettings";
import {
  deleteCustomAcademicSkill,
  getAcademicSkillRecords,
  importAcademicSkillFromText,
  matchAcademicSkillIntent,
  resetAcademicSkillToBuiltin,
  saveAcademicSkillOverride,
  setAcademicSkillEnabled,
  updateAcademicSkillToBuiltin,
  type AcademicSkill,
  type AcademicSkillRecord,
} from "./academicSkills";
import {
  ensureClaudeHelper,
  fetchProviderModels,
  requestHelperJson,
} from "./claudeHelperClient";
import { exportDiagnosticLog } from "./diagnosticLog";
import { autoDetectSettings } from "./settingsAutoDetect";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { initializePreferenceTabs } from "./preferenceTabs";

const initializedPreferenceRoots = new WeakSet<HTMLElement>();

type XulValueElement = HTMLElement & {
  value: string;
  disabled?: boolean;
};

type MonacoWindow = Window & {
  loadMonaco?: (options: Record<string, unknown>) => Promise<{
    editor: {
      getValue: () => string;
      setValue: (value: string) => void;
    };
  }>;
};

export async function registerPrefsScripts(window: Window) {
  const doc = window.document;
  const root = doc.querySelector<HTMLElement>(".claudero-pref-stack");
  if (!root || initializedPreferenceRoots.has(root)) return;
  initializedPreferenceRoots.add(root);

  const hostKey = getHostKey();
  doc.querySelector<HTMLElement>("#claudero-pref-host-key")!.textContent =
    hostKey;
  doc.querySelector<HTMLElement>("#claudero-pref-host-key-codex")!.textContent =
    hostKey;
  doc.querySelector<HTMLElement>(
    "#claudero-pref-host-key-deepseek",
  )!.textContent = hostKey;

  bindProviderPath(doc, "claude");
  bindProviderPath(doc, "codex");
  bindProviderPath(doc, "deepseek");
  bindProviderEnvironment(doc, "claude");
  bindProviderEnvironment(doc, "codex");
  bindProviderEnvironment(doc, "deepseek");
  bindCodexSettings(doc);
  bindMcpSettings(doc);
  bindAcademicSkills(doc);
  bindSetupWizard(doc);
  bindDiagnostics(doc);
  initializePreferenceTabs(
    root,
    window,
    String(getPref("settingsProvider") || "general"),
    (panel) => setPref("settingsProvider", panel),
  );
  // Keep navigation and manual configuration available when detection fails.
  void autoDetectSettings()
    .then(() => syncDetectedPaths(doc))
    .catch((error) => {
      ztoolkit.log("[Claudero] Settings auto-detection failed", error);
    });
}

function syncDetectedPaths(doc: Document): void {
  for (const provider of ["claude", "codex", "deepseek"] as AiProvider[]) {
    const input = doc.querySelector<HTMLInputElement>(
      `#claudero-pref-${provider}-path`,
    );
    if (input && !input.value.trim() && doc.activeElement !== input) {
      input.value = getProviderCliPath(provider);
    }
  }
  const node = doc.querySelector<HTMLInputElement>(
    "#zotero-prefpane-claudero-nodePath",
  );
  if (node && !node.value.trim() && doc.activeElement !== node) {
    node.value = String(getPref("nodePath") || "");
  }
}

function setupFileExists(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile) as nsIFile;
    file.initWithPath(candidate);
    return file.exists() && file.isFile();
  } catch {
    return false;
  }
}

function setupEnvironmentKeys(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^export\s+/, ""))
    .map((line) => {
      const equals = line.indexOf("=");
      return equals > 0 ? line.slice(0, equals).trim() : "";
    })
    .filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
}

function bindSetupWizard(doc: Document): void {
  const runButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-setup-run",
  );
  const status = doc.querySelector<HTMLElement>("#claudero-pref-setup-status");
  const details = doc.querySelector<HTMLElement>(
    "#claudero-pref-setup-details",
  );
  if (!runButton || !status || !details) return;

  type SetupRowState = "success" | "error" | "info";
  const createRow = (
    label: string,
    rowState: SetupRowState,
    detail: string,
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
    return row;
  };

  const run = async () => {
    runButton.disabled = true;
    status.classList.remove("error", "success");
    status.textContent = getString("pref-setup-running");
    details.replaceChildren();
    try {
      const detected = await autoDetectSettings();
      syncDetectedPaths(doc);
      const provider = String(getPref("provider") || "claude") as AiProvider;
      const nodePath = String(getPref("nodePath") || "");
      const cliPath = getProviderCliPath(provider);
      const envKeys = setupEnvironmentKeys(getProviderEnvironment(provider));
      let helperReady = false;
      let helperError = "";
      try {
        await ensureClaudeHelper();
        helperReady = true;
      } catch (error) {
        helperError = error instanceof Error ? error.message : String(error);
      }
      const nodeOk = setupFileExists(nodePath);
      const cliOk = setupFileExists(cliPath);
      let runtimeState: SetupRowState = "info";
      let runtimeDetail = getString("pref-setup-runtime-not-checked");
      if (provider === "deepseek") {
        if (nodeOk && cliOk && helperReady) {
          try {
            // /models runs the same DeepSeek Node/entrypoint resolution used by
            // a real request, without contacting the model API.
            await fetchProviderModels("deepseek");
            runtimeState = "success";
            runtimeDetail = getString("pref-setup-runtime-ready");
          } catch (error) {
            runtimeState = "error";
            runtimeDetail =
              error instanceof Error ? error.message : String(error);
          }
        }
      }
      details.append(
        createRow(
          getString("pref-setup-node"),
          nodeOk ? "success" : "error",
          nodeOk ? nodePath : getString("pref-setup-missing"),
        ),
        createRow(
          getString("pref-setup-cli", { args: { provider } }),
          cliOk ? "success" : "error",
          cliOk ? cliPath : getString("pref-setup-missing"),
        ),
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
      setPref("setupChecked", true);
      if (
        detected.nodePath ||
        detected.claudePath ||
        detected.codexPath ||
        detected.deepseekPath
      ) {
        status.textContent = `${status.textContent} ${getString("pref-setup-auto-detected")}`;
      }
    } catch (error) {
      status.textContent = getString("pref-setup-failed", {
        args: { error: error instanceof Error ? error.message : String(error) },
      });
      status.classList.add("error");
    } finally {
      runButton.disabled = false;
    }
  };

  runButton.addEventListener("click", () => void run());
  if (getPref("setupChecked") !== true) void run();
}

function bindProviderPath(doc: Document, provider: AiProvider): void {
  const input = doc.querySelector<HTMLInputElement>(
    `#claudero-pref-${provider}-path`,
  );
  if (!input) return;
  input.value = getProviderCliPath(provider);
  input.addEventListener("change", () => {
    setProviderCliPath(provider, input.value);
  });
  input.addEventListener("blur", () => {
    setProviderCliPath(provider, input.value);
  });
}

function bindProviderEnvironment(doc: Document, provider: AiProvider): void {
  const input = doc.querySelector<HTMLTextAreaElement>(
    `#claudero-pref-${provider}-env`,
  );
  if (!input) return;
  input.value = getProviderEnvironment(provider);
  input.addEventListener("change", () => {
    setProviderEnvironment(provider, input.value);
  });
  input.addEventListener("blur", () => {
    setProviderEnvironment(provider, input.value);
  });
}

function bindCodexSettings(doc: Document): void {
  const installation = doc.querySelector<XulValueElement>(
    "#claudero-pref-codex-installation",
  );
  const distro = doc.querySelector<HTMLInputElement>(
    "#claudero-pref-codex-wsl-distro",
  );
  const safeMode = doc.querySelector<XulValueElement>(
    "#claudero-pref-codex-safe-mode",
  );
  const bindValueCommit = (
    element: XulValueElement,
    handler: () => void,
  ): void => {
    element.addEventListener("command", handler);
    element.addEventListener("change", handler);
  };

  if (installation) {
    installation.value = getCodexInstallationMethod();
    bindValueCommit(installation, () => {
      setCodexInstallationMethod(installation.value);
      if (distro) distro.disabled = installation.value !== "wsl";
    });
  }
  if (distro) {
    distro.value = getCodexWslDistro();
    distro.disabled = installation?.value !== "wsl";
    distro.addEventListener("change", () => setCodexWslDistro(distro.value));
    distro.addEventListener("blur", () => setCodexWslDistro(distro.value));
  }
  if (safeMode) {
    safeMode.value = getCodexSafeMode();
    bindValueCommit(safeMode, () => {
      setCodexSafeMode(safeMode.value);
    });
  }
}

function bindMcpSettings(doc: Document): void {
  const servers = doc.querySelector<HTMLTextAreaElement>(
    "#claudero-pref-mcp-servers",
  );
  const list = doc.querySelector<HTMLElement>("#claudero-pref-mcp-list");
  const addStdio = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-mcp-add-stdio",
  );
  const addHttp = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-mcp-add-http",
  );
  const status = doc.querySelector<HTMLElement>("#claudero-pref-mcp-status");
  const win = doc.defaultView;
  const createHtml = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const el = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElementTagNameMap[K];
    if (className) el.className = className;
    return el;
  };

  const testMcpServer = async (
    config: ManagedMcpServerConfig,
  ): Promise<{
    success: boolean;
    serverName?: string;
    serverVersion?: string;
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      enabled: boolean;
    }>;
    error?: string;
  }> => {
    return requestHelperJson("/test-mcp", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
  };

  const renderStatus = (raw: string) => {
    if (!status) return;
    const value = raw.trim();
    status.classList.remove("error", "success");
    if (!value) {
      status.textContent = getString("mcp-no-configured");
      return;
    }
    try {
      const count = Object.keys(parseCustomMcpServers(value)).length;
      status.textContent = getString("mcp-saved", { args: { count } });
      status.classList.add("success");
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? `Invalid MCP JSON: ${error.message}`
          : getString("mcp-invalid");
      status.classList.add("error");
    }
  };

  const readManaged = (): Record<string, ManagedMcpServerConfig> => {
    try {
      return parseManagedMcpServers(servers?.value || "");
    } catch {
      return {};
    }
  };

  const saveManaged = (value: Record<string, ManagedMcpServerConfig>): void => {
    if (!servers) return;
    servers.value = serializeManagedMcpServers(value);
    setCustomMcpServersRaw(servers.value);
    renderStatus(servers.value);
    renderList();
  };

  const serverType = (config: ManagedMcpServerConfig): string => {
    if (config.command) return "stdio";
    const type = typeof config.type === "string" ? config.type : "";
    if (type) return type;
    return config.url ? "http" : "custom";
  };

  const serverPreview = (config: ManagedMcpServerConfig): string => {
    if (config.command) {
      const args = Array.isArray(config.args) ? config.args.join(" ") : "";
      return [config.command, args].filter(Boolean).join(" ");
    }
    return String(config.url || "");
  };

  const renderList = () => {
    if (!list) return;
    list.replaceChildren();
    const managed = readManaged();
    const entries = Object.entries(managed);
    if (entries.length === 0) {
      const empty = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      empty.className = "claudero-pref-mcp-empty";
      empty.textContent = getString("mcp-empty");
      list.appendChild(empty);
      return;
    }
    for (const [name, config] of entries) {
      const card = createHtml("div");
      card.className =
        "claudero-pref-mcp-card" +
        (config.enabled === false ? " disabled" : "");
      const content = createHtml("div", "claudero-pref-mcp-card-content");
      const row = createHtml("div", "claudero-pref-mcp-card-row");
      const main = createHtml("div");
      main.className = "claudero-pref-mcp-card-main";
      const title = createHtml("div");
      title.className = "claudero-pref-mcp-card-title";
      title.textContent = name;
      const meta = createHtml("div");
      meta.className = "claudero-pref-mcp-card-meta";
      meta.textContent = getString("mcp-meta", {
        args: {
          type: serverType(config),
          scope: config.contextSaving ? "@" : getString("mcp-always"),
          preview: serverPreview(config) || getString("mcp-no-command"),
        },
      });
      main.append(title, meta);

      const toolsPanel = createHtml("div", "claudero-pref-mcp-tools");
      const actions = createHtml("div");
      actions.className = "claudero-pref-mcp-card-actions";
      const makeButton = (label: string, onClick: () => void) => {
        const button = createHtml("button") as HTMLButtonElement;
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", onClick);
        return button;
      };
      actions.append(
        makeButton("Verify", () => {
          toolsPanel.textContent = getString("mcp-testing");
          void testMcpServer(config)
            .then((result) => {
              toolsPanel.replaceChildren();
              if (!result.success) {
                toolsPanel.textContent = result.error || getString("ui-failed");
                toolsPanel.classList.add("error");
                return;
              }
              toolsPanel.classList.remove("error");
              const heading = createHtml("div", "claudero-pref-mcp-tools-head");
              const label = [result.serverName, result.serverVersion]
                .filter(Boolean)
                .join(" ");
              heading.textContent = label
                ? `${label} ${getString("ui-available-tools")}`
                : getString("ui-available-tools");
              toolsPanel.appendChild(heading);
              const toolRows = result.tools || [];
              if (toolRows.length === 0) {
                const empty = createHtml("div", "claudero-pref-mcp-tool-row");
                empty.textContent = getString("mcp-no-tools");
                toolsPanel.appendChild(empty);
                return;
              }
              for (const tool of toolRows) {
                const toolRow = createHtml("div", "claudero-pref-mcp-tool-row");
                const body = createHtml("div", "claudero-pref-mcp-tool-body");
                const toolName = createHtml(
                  "div",
                  "claudero-pref-mcp-tool-name",
                );
                toolName.textContent = tool.name;
                const desc = createHtml("div", "claudero-pref-mcp-tool-desc");
                desc.textContent = tool.description || "";
                body.append(toolName, desc);
                const toggle = makeButton(
                  tool.enabled
                    ? getString("ui-disable")
                    : getString("ui-enable"),
                  () => {
                    const next = readManaged();
                    const current = next[name] || {};
                    const disabled = new Set(current.disabledTools || []);
                    if (disabled.has(tool.name)) disabled.delete(tool.name);
                    else disabled.add(tool.name);
                    next[name] = {
                      ...current,
                      disabledTools: [...disabled].sort(),
                    };
                    saveManaged(next);
                  },
                );
                toolRow.append(body, toggle);
                toolsPanel.appendChild(toolRow);
              }
            })
            .catch((error) => {
              toolsPanel.textContent =
                error instanceof Error ? error.message : String(error);
              toolsPanel.classList.add("error");
            });
        }),
        makeButton(config.enabled === false ? "Enable" : "Disable", () => {
          const next = readManaged();
          next[name] = { ...next[name], enabled: config.enabled === false };
          saveManaged(next);
        }),
        makeButton(config.contextSaving ? "Always" : "@", () => {
          const next = readManaged();
          next[name] = { ...next[name], contextSaving: !config.contextSaving };
          saveManaged(next);
        }),
        makeButton("Edit", () => {
          const raw = win?.prompt(
            getString("mcp-edit-json", { args: { name } }),
            JSON.stringify(config, null, 2),
          );
          if (raw === null || raw === undefined) return;
          try {
            const parsed = JSON.parse(raw) as ManagedMcpServerConfig;
            const next = readManaged();
            next[name] = parsed;
            saveManaged(next);
          } catch (error) {
            win?.alert(
              error instanceof Error ? error.message : getString("mcp-invalid"),
            );
          }
        }),
        makeButton("Delete", () => {
          if (
            !win?.confirm(getString("mcp-delete-confirm", { args: { name } }))
          )
            return;
          const next = readManaged();
          delete next[name];
          saveManaged(next);
        }),
      );
      row.append(main, actions);
      content.append(row, toolsPanel);
      card.appendChild(content);
      list.appendChild(card);
    }
  };

  if (servers) {
    servers.value = getCustomMcpServersRaw();
    renderStatus(servers.value);
    const save = () => {
      try {
        parseCustomMcpServers(servers.value);
        setCustomMcpServersRaw(servers.value);
      } catch {
        // Keep invalid edits visible, but don't persist them.
      }
      renderStatus(servers.value);
      renderList();
    };
    servers.addEventListener("change", save);
    servers.addEventListener("blur", save);
    servers.addEventListener("input", () => {
      renderStatus(servers.value);
      renderList();
    });
    renderList();
  }

  addStdio?.addEventListener("click", () => {
    const name = win
      ?.prompt(getString("mcp-server-name"), "filesystem")
      ?.trim();
    if (!name) return;
    const command = win?.prompt(getString("mcp-command"), "npx")?.trim();
    if (!command) return;
    const argsText =
      win?.prompt(
        getString("mcp-arguments"),
        "-y @modelcontextprotocol/server-filesystem /tmp",
      ) || "";
    const next = readManaged();
    next[name] = {
      enabled: true,
      command,
      args: argsText.split(/\s+/).filter(Boolean),
    };
    saveManaged(next);
  });

  addHttp?.addEventListener("click", () => {
    const name = win?.prompt(getString("mcp-server-name"), "remote")?.trim();
    if (!name) return;
    const url = win
      ?.prompt(getString("mcp-http-url"), "http://127.0.0.1:3000/sse")
      ?.trim();
    if (!url) return;
    const next = readManaged();
    next[name] = { enabled: true, type: "sse", url };
    saveManaged(next);
  });
}

function bindAcademicSkills(doc: Document): void {
  const list = doc.querySelector<HTMLElement>("#claudero-pref-skills-list");
  const status = doc.querySelector<HTMLElement>("#claudero-pref-skills-status");
  const testInput = doc.querySelector<HTMLInputElement>(
    "#claudero-pref-skills-test-input",
  );
  const testButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-skills-test",
  );
  const testResult = doc.querySelector<HTMLElement>(
    "#claudero-pref-skills-test-result",
  );
  const importText = doc.querySelector<HTMLTextAreaElement>(
    "#claudero-pref-skills-import",
  );
  const importButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-skills-import-button",
  );
  const win = doc.defaultView;
  if (!list) return;

  const createHtml = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const el = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElementTagNameMap[K];
    if (className) el.className = className;
    return el;
  };

  const setStatus = (message: string, kind: "success" | "error" | "" = "") => {
    if (!status) return;
    status.classList.remove("success", "error");
    if (kind) status.classList.add(kind);
    status.textContent = message;
  };

  const shortList = (values: string[] | undefined, fallback = "-") =>
    values && values.length > 0 ? values.join(", ") : fallback;

  const requirementsText = (record: AcademicSkillRecord): string => {
    const req = record.skill.contextRequirements;
    return [
      `items: ${req.selectedItems || "optional"}`,
      req.pdfText ? `pdf: ${req.pdfText}` : "",
      req.annotations ? `annotations: ${req.annotations}` : "",
      req.notes ? `notes: ${req.notes}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const toolsText = (record: AcademicSkillRecord): string => {
    const tools = record.skill.toolPolicy;
    const enabled = [
      tools.zoteroMcp ? "Zotero MCP" : "",
      tools.allowZoteroWrite ? "write notes" : "",
      tools.allowWebSearch ? "web" : "",
      tools.allowScripts ? "scripts" : "",
    ].filter(Boolean);
    return enabled.length ? enabled.join(", ") : "read-only prompt";
  };

  const waitForMonaco = async (editorWin: MonacoWindow): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (typeof editorWin.loadMonaco === "function") return;
      await new Promise<void>((resolve) => {
        win?.setTimeout(() => resolve(), 50);
      });
    }
    throw new Error("Monaco editor did not load.");
  };

  const editSkill = async (record: AcademicSkillRecord) => {
    if (!win) return;
    const editorWin = win.openDialog(
      "chrome://scaffold/content/monaco/monaco.html",
      "claudero-skill-editor",
      "chrome,centerscreen,dialog=no,resizable,scrollbars=yes,width=760,height=560",
    ) as MonacoWindow | undefined;
    if (!editorWin) return;
    let saved = false;
    try {
      await waitForMonaco(editorWin);
      const isDark = win.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
      const result = await editorWin.loadMonaco?.({
        language: "json",
        theme: `vs-${isDark ? "dark" : "light"}`,
      });
      const editor = result?.editor;
      if (!editor) throw new Error("Monaco editor is unavailable.");
      editor.setValue(JSON.stringify(record.skill, null, 2));
      editorWin.addEventListener("unload", () => {
        if (saved) return;
        saved = true;
        try {
          const parsed = JSON.parse(editor.getValue()) as AcademicSkill;
          if (!parsed.id || !parsed.title) {
            throw new Error("Skill JSON must include id and title.");
          }
          saveAcademicSkillOverride(parsed, record.enabled);
          setStatus(`Saved ${parsed.title}`, "success");
          renderList();
        } catch (error) {
          setStatus(
            error instanceof Error
              ? `Invalid skill JSON: ${error.message}`
              : "Invalid skill JSON",
            "error",
          );
        }
      });
      editorWin.focus();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Could not open skill editor: ${error.message}`
          : "Could not open skill editor",
        "error",
      );
      editorWin.close();
    }
  };

  const makeButton = (label: string, onClick: () => void) => {
    const button = createHtml("button") as HTMLButtonElement;
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  };

  const renderList = () => {
    list.replaceChildren();
    const records = getAcademicSkillRecords();
    const shell = createHtml("div", "claudero-pref-skills-table-shell");
    const headerTable = createHtml(
      "table",
      "claudero-pref-skills-table claudero-pref-skills-table-header",
    );
    const thead = createHtml("thead");
    const headRow = createHtml("tr");
    for (const label of [
      "Skill",
      "Status",
      "Category",
      "Context",
      "Output",
      "Tools",
      "Actions",
    ]) {
      const th = createHtml("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    headerTable.appendChild(thead);

    const bodyShell = createHtml(
      "div",
      "claudero-pref-skills-table-body-shell",
    );
    const bodyTable = createHtml(
      "table",
      "claudero-pref-skills-table claudero-pref-skills-table-body",
    );

    const tbody = createHtml("tbody");
    for (const record of records) {
      const row = createHtml("tr", "claudero-pref-skill-row");
      if (!record.enabled) row.classList.add("disabled");

      const titleCell = createHtml("td", "claudero-pref-skill-title-cell");
      const title = createHtml("div", "claudero-pref-skill-title");
      title.textContent = record.skill.title;
      const source = createHtml("div", "claudero-pref-skill-source");
      source.textContent = record.skill.source?.type || "custom";
      titleCell.append(title, source);

      const statusCell = createHtml("td", "claudero-pref-skill-status-cell");
      const enabledBadge = createHtml("span", "claudero-pref-skill-badge");
      enabledBadge.classList.add(record.enabled ? "enabled" : "disabled");
      enabledBadge.textContent = record.enabled ? "enabled" : "disabled";
      const badge = createHtml("span", "claudero-pref-skill-badge");
      badge.classList.add(record.status);
      badge.textContent = record.status.replace("-", " ");
      statusCell.append(enabledBadge, badge);

      const categoryCell = createHtml("td");
      categoryCell.textContent = record.skill.category;

      const contextCell = createHtml("td");
      contextCell.textContent = requirementsText(record);

      const outputCell = createHtml("td");
      outputCell.textContent = record.skill.outputContract.format;

      const toolsCell = createHtml("td");
      toolsCell.textContent = toolsText(record);

      const actionsCell = createHtml("td", "claudero-pref-skill-actions-cell");
      const actions = createHtml("div", "claudero-pref-skill-actions");
      actions.append(
        makeButton(record.enabled ? "Disable" : "Enable", () => {
          setAcademicSkillEnabled(record.id, !record.enabled);
          renderList();
        }),
        makeButton("Edit", () => editSkill(record)),
      );
      if (record.stored) {
        actions.append(
          makeButton("Reset", () => {
            if (!win?.confirm(`Reset "${record.skill.title}" to builtin?`))
              return;
            resetAcademicSkillToBuiltin(record.id);
            setStatus(`Reset ${record.skill.title}`, "success");
            renderList();
          }),
        );
      }
      if (record.updateAvailable) {
        actions.append(
          makeButton("Update", () => {
            if (
              !win?.confirm(
                `Update "${record.skill.title}" to the latest builtin template and discard local edits?`,
              )
            ) {
              return;
            }
            updateAcademicSkillToBuiltin(record.id);
            setStatus(`Updated ${record.skill.title}`, "success");
            renderList();
          }),
        );
      }
      if (!record.builtin) {
        const deleteButton = makeButton("Delete", () => {
          if (!win?.confirm(`Delete imported skill "${record.skill.title}"?`)) {
            return;
          }
          deleteCustomAcademicSkill(record.id);
          setStatus(`Deleted ${record.skill.title}`, "success");
          renderList();
        });
        deleteButton.classList.add("claudero-pref-danger-button");
        actions.append(deleteButton);
      }
      actionsCell.appendChild(actions);

      row.append(
        titleCell,
        statusCell,
        categoryCell,
        contextCell,
        outputCell,
        toolsCell,
        actionsCell,
      );
      tbody.appendChild(row);

      const detailRow = createHtml("tr", "claudero-pref-skill-detail-row");
      if (!record.enabled) detailRow.classList.add("disabled");
      const detailCell = createHtml("td", "claudero-pref-skill-detail-cell");
      detailCell.colSpan = 7;
      const desc = createHtml("div", "claudero-pref-skill-desc");
      desc.textContent = record.skill.description;
      const examples = createHtml("div", "claudero-pref-skill-meta");
      examples.textContent = getString("skills-examples", {
        args: { values: shortList(record.skill.intentExamples.slice(0, 3)) },
      });
      detailCell.append(desc, examples);
      detailRow.appendChild(detailCell);
      tbody.appendChild(detailRow);
    }
    bodyTable.appendChild(tbody);
    bodyShell.appendChild(bodyTable);
    shell.append(headerTable, bodyShell);
    list.appendChild(shell);
  };

  testButton?.addEventListener("click", () => {
    const query = testInput?.value.trim() || "";
    if (!testResult) return;
    if (!query) {
      testResult.textContent = getString("skills-test-prompt");
      return;
    }
    const skills = getAcademicSkillRecords()
      .filter((record) => record.enabled)
      .map((record) => record.skill);
    const match = matchAcademicSkillIntent(query, skills);
    testResult.classList.remove("success", "error");
    if (!match) {
      testResult.textContent =
        "No academic skill matched; this will run as normal chat.";
      return;
    }
    testResult.classList.add("success");
    testResult.textContent = getString("skills-matched", {
      args: {
        title: match.skill.title,
        confidence: match.confidence.toFixed(2),
        terms: match.matchedTerms.join(", "),
      },
    });
  });

  importButton?.addEventListener("click", () => {
    const raw = importText?.value.trim() || "";
    if (!raw) {
      setStatus("Paste skill content before importing.", "error");
      return;
    }
    try {
      const skill = importAcademicSkillFromText(raw);
      saveAcademicSkillOverride(skill, false);
      if (importText) importText.value = "";
      setStatus(
        `Imported ${skill.title}; enable it in the table when ready.`,
        "success",
      );
      renderList();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Import failed: ${error.message}`
          : "Import failed",
        "error",
      );
    }
  });

  renderList();
}

interface DiagnosticsPayload {
  helper?: {
    version?: number;
    activeProvider?: string;
    active?: boolean;
    runtimeActive?: boolean;
  };
  runtimes?: Record<
    string,
    {
      active?: boolean;
      workspacePath?: string | null;
      mcpServers?: string[];
      zoteroMcp?: boolean;
      debugEvents?: unknown[];
      pendingRequests?: unknown[];
      launch?: unknown;
      process?: unknown;
      session?: {
        threadId?: string;
        sessionFilePath?: string;
        appServerStderr?: string;
      } | null;
    }
  >;
  trace?: {
    traceId?: string;
    startedAt?: number;
    source?: {
      provider?: string;
      runtime?: string;
      conversationId?: string;
    };
    eventCount?: number;
    eventCounts?: Record<string, number>;
    errors?: string[];
    lastEvent?: {
      sequence?: number;
      event?: {
        type?: string;
      };
    } | null;
  } | null;
  debugLog?: unknown[];
}

function bindDiagnostics(doc: Document): void {
  const refresh = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-diagnostics-refresh",
  );
  const exportButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-diagnostics-export",
  );
  const restartButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-diagnostics-restart",
  );
  const status = doc.querySelector<HTMLElement>(
    "#claudero-pref-diagnostics-status",
  );
  const summary = doc.querySelector<HTMLElement>(
    "#claudero-pref-diagnostics-summary",
  );
  const trace = doc.querySelector<HTMLElement>(
    "#claudero-pref-diagnostics-trace",
  );
  if (!summary && !trace) return;

  const createHtml = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] => {
    const el = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      tag,
    ) as HTMLElementTagNameMap[K];
    if (className) el.className = className;
    return el;
  };

  const renderRow = (label: string, value: unknown): HTMLElement => {
    const row = createHtml("div", "claudero-pref-diagnostics-row");
    const key = createHtml("span");
    key.textContent = label;
    const val = createHtml("span");
    val.textContent =
      value === undefined || value === null || value === ""
        ? "-"
        : String(value);
    row.append(key, val);
    return row;
  };

  const renderCard = (
    title: string,
    rows: Array<[string, unknown]>,
  ): HTMLElement => {
    const card = createHtml("div", "claudero-pref-diagnostics-card");
    const heading = createHtml("div", "claudero-pref-diagnostics-card-title");
    heading.textContent = title;
    card.appendChild(heading);
    for (const [label, value] of rows) {
      card.appendChild(renderRow(label, value));
    }
    return card;
  };

  const load = async () => {
    if (status) {
      status.classList.remove("error", "success");
      status.textContent = getString("diagnostics-loading");
    }
    try {
      const data = await requestHelperJson<DiagnosticsPayload>("/diagnostics");
      summary?.replaceChildren(
        renderCard("Helper", [
          ["Version", data.helper?.version],
          ["Active provider", data.helper?.activeProvider],
          ["Runtime active", data.helper?.runtimeActive],
        ]),
        renderCard("Claude", [
          ["Active", data.runtimes?.claude?.active],
          ["Workspace", data.runtimes?.claude?.workspacePath],
          ["Zotero MCP", data.runtimes?.claude?.zoteroMcp],
          ["MCP servers", data.runtimes?.claude?.mcpServers?.join(", ")],
        ]),
        renderCard("Codex", [
          ["Active", data.runtimes?.codex?.active],
          ["Workspace", data.runtimes?.codex?.workspacePath],
          ["Thread", data.runtimes?.codex?.session?.threadId],
          ["App stderr", data.runtimes?.codex?.session?.appServerStderr],
          ["Zotero MCP", data.runtimes?.codex?.zoteroMcp],
          ["MCP servers", data.runtimes?.codex?.mcpServers?.join(", ")],
        ]),
        renderCard("Latest trace", [
          ["Trace ID", data.trace?.traceId],
          ["Provider", data.trace?.source?.provider],
          ["Events", data.trace?.eventCount],
          ["Last event", data.trace?.lastEvent?.event?.type],
          ["Errors", data.trace?.errors?.length || 0],
        ]),
      );
      if (trace) {
        trace.textContent = JSON.stringify(
          {
            source: data.trace?.source || null,
            eventCounts: data.trace?.eventCounts || {},
            lastEvent: data.trace?.lastEvent || null,
            errors: data.trace?.errors || [],
            helperDebugLog: data.debugLog || [],
            codex: {
              launch: data.runtimes?.codex?.launch || null,
              process: data.runtimes?.codex?.process || null,
              pendingRequests: data.runtimes?.codex?.pendingRequests || [],
              debugEvents: data.runtimes?.codex?.debugEvents || [],
            },
          },
          null,
          2,
        );
      }
      if (status) {
        status.textContent = getString("diagnostics-loaded");
        status.classList.add("success");
      }
    } catch (error) {
      summary?.replaceChildren();
      if (trace) trace.textContent = "";
      if (status) {
        status.textContent = getString("diagnostics-unavailable", {
          args: { error: error instanceof Error ? error.message : "" },
        });
        status.classList.add("error");
      }
    }
  };

  refresh?.addEventListener("click", () => void load());
  restartButton?.addEventListener("click", () => {
    if (status) {
      status.classList.remove("error", "success");
      status.textContent = getString("diagnostics-restarting");
    }
    const restart = async () => {
      await requestHelperJson("/restart-runtimes", { method: "POST" });
      if (status) {
        status.textContent = getString("diagnostics-restarted");
        status.classList.add("success");
      }
      await load();
    };
    void restart().catch((error) => {
      if (status) {
        status.textContent = getString("diagnostics-restart-failed", {
          args: { error: error instanceof Error ? error.message : "" },
        });
        status.classList.add("error");
      }
    });
  });
  exportButton?.addEventListener("click", () => {
    if (status) {
      status.classList.remove("error", "success");
      status.textContent = getString("diagnostics-exporting");
    }
    void exportDiagnosticLog()
      .then((path) => {
        if (status) {
          status.textContent = getString("diagnostics-saved", {
            args: { path },
          });
          status.classList.add("success");
        }
      })
      .catch((error) => {
        if (status) {
          status.textContent = getString("diagnostics-export-failed", {
            args: { error: error instanceof Error ? error.message : "" },
          });
          status.classList.add("error");
        }
      });
  });
  const root = doc.querySelector<HTMLElement>(".claudero-pref-stack");
  root?.addEventListener("claudero-preference-panel-selected", (event) => {
    if ((event as CustomEvent<string>).detail === "diagnostics") void load();
  });
}

import { bindSetupWizard } from "./preferenceSetup";
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
  parseMcpArguments,
  parseCustomMcpServers,
  serializeManagedMcpServers,
  setCustomMcpServersRaw,
  validateMcpServerConfig,
  type ManagedMcpServerConfig,
} from "./mcpSettings";
import {
  deleteCustomAcademicSkill,
  getAcademicSkillRecords,
  getAcademicSkillStore,
  importAcademicSkillFromText,
  matchAcademicSkillIntent,
  resetAcademicSkillToBuiltin,
  saveAcademicSkillOverride,
  setAcademicSkillEnabled,
  updateAcademicSkillToBuiltin,
  type AcademicSkillRecord,
} from "./academicSkills";
import { requestHelperJson } from "./claudeHelperClient";
import { saveAcademicSkillEdit } from "./academicSkillEditing";
import { exportDiagnosticLog } from "./diagnosticLog";
import { PreferenceLifetime, PreferenceTask } from "./preferenceLifetime";
import { getPref, setPref } from "../utils/prefs";
import { getString } from "../utils/locale";
import { initializePreferenceTabs } from "./preferenceTabs";

const initializedPreferenceRoots = new WeakSet<HTMLElement>();
const preferenceLifetimes = new Set<PreferenceLifetime>();

export function unregisterPrefsScripts(): void {
  for (const lifetime of preferenceLifetimes) lifetime.dispose();
}

type XulValueElement = HTMLElement & {
  value: string;
  disabled?: boolean;
};

export async function registerPrefsScripts(window: Window) {
  const doc = window.document;
  const root = doc.querySelector<HTMLElement>(".claudero-pref-stack");
  if (!root || initializedPreferenceRoots.has(root)) return;
  initializedPreferenceRoots.add(root);
  const lifetime = new PreferenceLifetime(root, window);
  preferenceLifetimes.add(lifetime);
  lifetime.onDispose(() => {
    preferenceLifetimes.delete(lifetime);
    initializedPreferenceRoots.delete(root);
  });

  bindProviderPath(doc, "claude", lifetime);
  bindProviderPath(doc, "codex", lifetime);
  bindProviderPath(doc, "deepseek", lifetime);
  bindProviderEnvironment(doc, "claude", lifetime);
  bindProviderEnvironment(doc, "codex", lifetime);
  bindProviderEnvironment(doc, "deepseek", lifetime);
  bindCodexSettings(doc, lifetime);
  bindMcpSettings(doc, lifetime);
  bindAcademicSkills(doc, lifetime);
  bindSetupWizard(doc, lifetime);
  bindDiagnostics(doc, lifetime);
  lifetime.onDispose(
    initializePreferenceTabs(
      root,
      window,
      String(getPref("settingsProvider") || "general"),
      (panel) => setPref("settingsProvider", panel),
    ),
  );
}

function bindProviderPath(
  doc: Document,
  provider: AiProvider,
  lifetime: PreferenceLifetime,
): void {
  const input = doc.querySelector<HTMLInputElement>(
    `#claudero-pref-${provider}-path`,
  );
  if (!input) return;
  input.value = getProviderCliPath(provider);
  lifetime.listen(input, "change", () => {
    if (input.value.trim() !== getProviderCliPath(provider))
      setProviderCliPath(provider, input.value);
  });
}

function bindProviderEnvironment(
  doc: Document,
  provider: AiProvider,
  lifetime: PreferenceLifetime,
): void {
  const input = doc.querySelector<HTMLTextAreaElement>(
    `#claudero-pref-${provider}-env`,
  );
  if (!input) return;
  input.value = getProviderEnvironment(provider);
  lifetime.listen(input, "change", () => {
    if (input.value !== getProviderEnvironment(provider))
      setProviderEnvironment(provider, input.value);
  });
}

function bindCodexSettings(doc: Document, lifetime: PreferenceLifetime): void {
  const installation = doc.querySelector<XulValueElement>(
    "#claudero-pref-codex-installation",
  );
  const distro = doc.querySelector<HTMLInputElement>(
    "#claudero-pref-codex-wsl-distro",
  );
  const safeMode = doc.querySelector<XulValueElement>(
    "#claudero-pref-codex-safe-mode",
  );
  const wslOption = doc.querySelector<XulValueElement>(
    '#claudero-pref-codex-installation menuitem[value="wsl"]',
  );
  const installationRow = doc.querySelector<HTMLElement>(
    "#claudero-pref-codex-installation-row",
  );
  const distroRow = doc.querySelector<HTMLElement>(
    "#claudero-pref-codex-wsl-distro-row",
  );
  // WSL is only available on Windows. Keep stale preferences from making the
  // setup wizard report a usable runtime on macOS/Linux.
  const isWindows = Boolean(
    typeof Zotero !== "undefined" && (Zotero as typeof Zotero).isWin,
  );
  if (wslOption) wslOption.disabled = !isWindows;
  if (installationRow) installationRow.hidden = !isWindows;
  const syncDistro = () => {
    const usesWsl = isWindows && installation?.value === "wsl";
    if (distro) distro.disabled = !usesWsl;
    if (distroRow) distroRow.hidden = !usesWsl;
  };
  const bindValueCommit = (
    element: XulValueElement,
    handler: () => void,
  ): void => {
    lifetime.listen(element, "command", handler);
    lifetime.listen(element, "change", handler);
  };

  if (installation) {
    installation.value = getCodexInstallationMethod();
    if (!isWindows && installation.value === "wsl") {
      installation.value = "native";
      setCodexInstallationMethod("native");
    }
    bindValueCommit(installation, () => {
      setCodexInstallationMethod(installation.value);
      syncDistro();
    });
  }
  if (distro) {
    distro.value = getCodexWslDistro();
    syncDistro();
    lifetime.listen(distro, "change", () => setCodexWslDistro(distro.value));
  }
  if (safeMode) {
    safeMode.value = getCodexSafeMode();
    bindValueCommit(safeMode, () => {
      setCodexSafeMode(safeMode.value);
    });
  }
}

function bindMcpSettings(doc: Document, lifetime: PreferenceLifetime): void {
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
  const addSse = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-mcp-add-sse",
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

  const connectionTest = new PreferenceTask(lifetime);
  let cancelRender = () => {};
  const setTesting = (pending: boolean) => {
    list
      ?.querySelectorAll<HTMLButtonElement>("[data-mcp-test]")
      .forEach((button) => {
        button.disabled = pending;
      });
  };

  const testMcpServer = async (
    config: ManagedMcpServerConfig,
    signal: AbortSignal,
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
    const error = validateMcpServerConfig(config);
    if (error) throw new Error(error);
    return requestHelperJson("/test-mcp", {
      method: "POST",
      body: JSON.stringify({ config }),
      signal,
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
      const advanced = doc.querySelector<HTMLDetailsElement>(
        "#claudero-pref-mcp-advanced",
      );
      if (advanced) advanced.open = true;
      status.textContent =
        error instanceof Error
          ? `${getString("mcp-invalid")}: ${error.message}`
          : getString("mcp-invalid");
      status.classList.add("error");
    }
  };

  const readManaged = (): Record<string, ManagedMcpServerConfig> | null => {
    try {
      return parseManagedMcpServers(servers?.value || "");
    } catch {
      return null;
    }
  };

  const saveManaged = (value: Record<string, ManagedMcpServerConfig>): void => {
    if (!servers) return;
    const raw = serializeManagedMcpServers(value);
    setCustomMcpServersRaw(raw);
    servers.value = raw;
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
    cancelRender();
    connectionTest.cancel();
    if (!list || !lifetime.active) return;
    list.removeAttribute("inert");
    list.replaceChildren();
    const managed = readManaged();
    if (!managed) return;
    const entries = Object.entries(managed);
    if (entries.length === 0) {
      const empty = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      empty.className = "claudero-pref-mcp-empty";
      empty.textContent = getString("mcp-empty");
      list.appendChild(empty);
      return;
    }
    for (const [name, config] of entries) {
      const renderedRaw = servers?.value;
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
        button.addEventListener("click", () => {
          if (
            lifetime.active &&
            card.isConnected &&
            servers?.value === renderedRaw
          )
            onClick();
        });
        return button;
      };
      const testButton = makeButton(getString("mcp-test-connection"), () => {
        if (connectionTest.pending) return;
        const testedRaw = servers?.value;
        toolsPanel.textContent = getString("mcp-testing");
        toolsPanel.classList.remove("error");
        setTesting(true);
        void connectionTest.run(async (signal) => {
          const isCurrent = () =>
            lifetime.active &&
            !signal.aborted &&
            card.isConnected &&
            servers?.value === testedRaw;
          try {
            const result = await testMcpServer(config, signal);
            if (!isCurrent()) return;
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
              const toolName = createHtml("div", "claudero-pref-mcp-tool-name");
              toolName.textContent = tool.name;
              const desc = createHtml("div", "claudero-pref-mcp-tool-desc");
              desc.textContent = tool.description || "";
              body.append(toolName, desc);
              const toggle = makeButton(
                tool.enabled ? getString("ui-disable") : getString("ui-enable"),
                () => {
                  const next = readManaged();
                  if (!next) return;
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
          } catch (error) {
            if (!isCurrent()) return;
            toolsPanel.textContent =
              error instanceof Error ? error.message : String(error);
            toolsPanel.classList.add("error");
          } finally {
            if (isCurrent()) setTesting(false);
          }
        });
      });
      testButton.dataset.mcpTest = "true";
      actions.append(
        testButton,
        makeButton(
          config.enabled === false
            ? getString("ui-enable")
            : getString("ui-disable"),
          () => {
            const next = readManaged();
            if (!next) return;
            next[name] = { ...next[name], enabled: config.enabled === false };
            saveManaged(next);
          },
        ),
        makeButton(config.contextSaving ? getString("mcp-always") : "@", () => {
          const next = readManaged();
          if (!next) return;
          next[name] = { ...next[name], contextSaving: !config.contextSaving };
          saveManaged(next);
        }),
        makeButton(getString("ui-edit"), () => {
          const raw = win?.prompt(
            getString("mcp-edit-json", { args: { name } }),
            JSON.stringify(config, null, 2),
          );
          if (raw === null || raw === undefined) return;
          try {
            const parsed = JSON.parse(raw) as ManagedMcpServerConfig;
            const next = readManaged();
            if (!next) return;
            next[name] = parsed;
            saveManaged(next);
          } catch (error) {
            win?.alert(
              error instanceof Error ? error.message : getString("mcp-invalid"),
            );
          }
        }),
        makeButton(getString("ui-delete"), () => {
          if (
            !win?.confirm(getString("mcp-delete-confirm", { args: { name } }))
          )
            return;
          const next = readManaged();
          if (!next) return;
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
    lifetime.listen(servers, "change", save);
    lifetime.listen(servers, "input", () => {
      connectionTest.cancel();
      setTesting(false);
      // Debounced cards must not expose actions based on the previous JSON.
      list?.setAttribute("inert", "");
      cancelRender();
      cancelRender = lifetime.defer(() => {
        renderStatus(servers.value);
        renderList();
      }, 150);
    });
    renderList();
  }

  lifetime.listen(addStdio, "click", () => {
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
    if (!next) return;
    try {
      if (Object.prototype.hasOwnProperty.call(next, name))
        throw new Error(getString("mcp-name-exists"));
      Object.defineProperty(next, name, {
        value: { enabled: true, command, args: parseMcpArguments(argsText) },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      saveManaged(next);
    } catch (error) {
      win?.alert(
        error instanceof Error ? error.message : getString("mcp-invalid"),
      );
    }
  });

  const addRemote = (type: "http" | "sse") => {
    const name = win?.prompt(getString("mcp-server-name"), "remote")?.trim();
    if (!name) return;
    const url = win
      ?.prompt(
        getString("mcp-http-url"),
        `http://127.0.0.1:3000/${type === "sse" ? "sse" : "mcp"}`,
      )
      ?.trim();
    if (!url) return;
    const next = readManaged();
    if (!next) return;
    try {
      if (Object.prototype.hasOwnProperty.call(next, name))
        throw new Error(getString("mcp-name-exists"));
      if (!/^https?:$/.test(new URL(url).protocol))
        throw new Error(getString("mcp-http-url-invalid"));
      Object.defineProperty(next, name, {
        value: { enabled: true, type, url },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      saveManaged(next);
    } catch (error) {
      win?.alert(
        error instanceof Error ? error.message : getString("mcp-invalid"),
      );
    }
  };
  lifetime.listen(addHttp, "click", () => addRemote("http"));
  lifetime.listen(addSse, "click", () => addRemote("sse"));
}

function bindAcademicSkills(doc: Document, lifetime: PreferenceLifetime): void {
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

  const editors = new Map<
    string,
    { panel: HTMLElement; input: HTMLTextAreaElement }
  >();
  lifetime.onDispose(() => {
    for (const { panel } of editors.values()) panel.remove();
    editors.clear();
  });

  const editSkill = (record: AcademicSkillRecord) => {
    const existing = editors.get(record.id);
    if (existing) {
      existing.panel.scrollIntoView({ block: "nearest" });
      existing.input.focus();
      return;
    }
    const panel = createHtml(
      "div",
      "claudero-pref-skill-editor claudero-pref-skill-import-panel",
    );
    panel.dataset.skillId = record.id;
    const heading = createHtml("label", "claudero-pref-skill-import-title");
    const input = createHtml("textarea", "claudero-pref-skill-import-textarea");
    input.id = `claudero-skill-draft-${record.id}`;
    input.rows = 16;
    input.spellcheck = false;
    heading.htmlFor = input.id;
    heading.textContent = getString("skills-editor-title", {
      args: { title: record.skill.title },
    });
    const rawStored = record.rawStored;
    const editable =
      record.validationError &&
      rawStored &&
      typeof rawStored === "object" &&
      "skill" in rawStored
        ? (rawStored as { skill: unknown }).skill
        : record.validationError && rawStored !== undefined
          ? rawStored
          : record.skill;
    input.value = JSON.stringify(editable, null, 2);
    const error = createHtml("div", "claudero-pref-status error");
    error.setAttribute("role", "status");
    error.setAttribute("aria-live", "polite");
    const actions = createHtml("div", "claudero-pref-skill-import-actions");
    const close = () => {
      editors.delete(record.id);
      panel.remove();
      const edit = Array.from<HTMLButtonElement>(
        list.querySelectorAll<HTMLButtonElement>("[data-skill-edit]"),
      ).find((button) => button.dataset.skillEdit === record.id);
      edit?.focus();
    };
    const save = makeButton(getString("ui-save"), () => {
      try {
        const skill = saveAcademicSkillEdit(record, input.value);
        setStatus(
          getString("skills-editor-saved", { args: { title: skill.title } }),
          "success",
        );
        renderList();
        close();
      } catch (cause) {
        error.textContent = getString("skills-editor-error", {
          args: {
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
    });
    save.dataset.skillSave = record.id;
    const cancel = makeButton(getString("ui-cancel"), close);
    cancel.dataset.skillCancel = record.id;
    actions.append(save, cancel);
    panel.append(heading, input, error, actions);
    list.before(panel);
    editors.set(record.id, { panel, input });
    panel.scrollIntoView({ block: "nearest" });
    input.focus();
  };

  const makeButton = (label: string, onClick: () => void) => {
    const button = createHtml("button") as HTMLButtonElement;
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (lifetime.active) onClick();
    });
    return button;
  };

  const renderList = () => {
    list.replaceChildren();
    const store = getAcademicSkillStore();
    const records = getAcademicSkillRecords(store);
    if (store.validationError) {
      setStatus(
        `Invalid skill store: ${store.validationError} Original data is preserved; repair the academicSkills preference JSON.`,
        "error",
      );
      const raw = createHtml("textarea");
      raw.readOnly = true;
      raw.value = store.rawDocument || "";
      raw.setAttribute("aria-label", "Original invalid skill store JSON");
      list.appendChild(raw);
      return;
    }
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
      badge.textContent = record.validationError
        ? "invalid — repair required"
        : record.status.replace("-", " ");
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
      const edit = makeButton(getString("ui-edit"), () => editSkill(record));
      edit.dataset.skillEdit = record.id;
      actions.append(
        makeButton(record.enabled ? "Disable" : "Enable", () => {
          if (record.validationError) {
            setStatus(
              `Repair this skill first: ${record.validationError}`,
              "error",
            );
            return;
          }
          setAcademicSkillEnabled(record.id, !record.enabled);
          renderList();
        }),
        edit,
      );
      if (record.builtin && (record.stored || record.validationError)) {
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
        const deleteButton = makeButton(getString("ui-delete"), () => {
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
      desc.textContent = record.validationError || record.skill.description;
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

  lifetime.listen(testButton, "click", () => {
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

  lifetime.listen(importButton, "click", () => {
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

function bindDiagnostics(doc: Document, lifetime: PreferenceLifetime): void {
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

  const task = new PreferenceTask(lifetime);
  const runAction = (action: (signal: AbortSignal) => Promise<void>) => {
    void task.run(async (signal) => {
      const buttons = [refresh, restartButton, exportButton];
      buttons.forEach((button) => {
        if (button) button.disabled = true;
      });
      try {
        await action(signal);
      } finally {
        if (lifetime.active && !signal.aborted)
          buttons.forEach((button) => {
            if (button) button.disabled = false;
          });
      }
    });
  };

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

  const load = async (signal: AbortSignal) => {
    if (status) {
      status.classList.remove("error", "success");
      status.textContent = getString("diagnostics-loading");
    }
    try {
      const data = await requestHelperJson<DiagnosticsPayload>("/diagnostics", {
        signal,
      });
      if (!lifetime.active || signal.aborted) return;
      summary?.replaceChildren(
        renderCard("Helper", [
          ["Device", getHostKey()],
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
      if (!lifetime.active || signal.aborted) return;
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

  lifetime.listen(refresh, "click", () => runAction(load));
  lifetime.listen(restartButton, "click", () =>
    runAction(async (signal) => {
      if (status) {
        status.classList.remove("error", "success");
        status.textContent = getString("diagnostics-restarting");
      }
      try {
        await requestHelperJson("/restart-runtimes", {
          method: "POST",
          signal,
        });
        if (!lifetime.active || signal.aborted) return;
        await load(signal);
      } catch (error) {
        if (!lifetime.active || signal.aborted) return;
        if (status) {
          status.textContent = getString("diagnostics-restart-failed", {
            args: { error: error instanceof Error ? error.message : "" },
          });
          status.classList.add("error");
        }
      }
    }),
  );
  lifetime.listen(exportButton, "click", () =>
    runAction(async (signal) => {
      if (status) {
        status.classList.remove("error", "success");
        status.textContent = getString("diagnostics-exporting");
      }
      try {
        const path = await exportDiagnosticLog(signal);
        if (!lifetime.active || signal.aborted) return;
        if (status) {
          status.textContent = getString("diagnostics-saved", {
            args: { path },
          });
          status.classList.add("success");
        }
      } catch (error) {
        if (!lifetime.active || signal.aborted) return;
        if (status) {
          status.textContent = getString("diagnostics-export-failed", {
            args: { error: error instanceof Error ? error.message : "" },
          });
          status.classList.add("error");
        }
      }
    }),
  );
  const root = doc.querySelector<HTMLElement>(".claudero-pref-stack");
  lifetime.listen(root, "claudero-preference-panel-selected", (event) => {
    if ((event as CustomEvent<string>).detail === "diagnostics")
      runAction(load);
  });
}

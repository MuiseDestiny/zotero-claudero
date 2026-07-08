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
  isZoteroMcpEnabled,
  parseManagedMcpServers,
  parseCustomMcpServers,
  serializeManagedMcpServers,
  setCustomMcpServersRaw,
  setZoteroMcpEnabled,
  type ManagedMcpServerConfig,
} from "./mcpSettings";
import {
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
import { exportDiagnosticLog } from "./diagnosticLog";
import { getPref, setPref } from "../utils/prefs";

type XulValueElement = HTMLElement & {
  value: string;
  disabled?: boolean;
};

export async function registerPrefsScripts(window: Window) {
  const doc = window.document;
  const testButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-test-helper",
  );
  testButton?.addEventListener("click", () => {
    window.alert(
      "Open the Claudero item pane, select an item, and send a prompt to start the helper.",
    );
  });

  const hostKey = getHostKey();
  doc.querySelector<HTMLElement>("#claudero-pref-host-key")!.textContent =
    hostKey;
  doc.querySelector<HTMLElement>("#claudero-pref-host-key-codex")!.textContent =
    hostKey;

  const tabs = Array.from(
    doc.querySelectorAll(".claudero-pref-tab"),
  ) as HTMLElement[];
  const panels = Array.from(
    doc.querySelectorAll(".claudero-pref-panel"),
  ) as HTMLElement[];
  const tabNav = doc.querySelector<HTMLElement>("#claudero-pref-tabs-nav");
  const tabIndicator = doc.querySelector<HTMLElement>(
    "#claudero-pref-tab-indicator",
  );
  const updateTabIndicator = () => {
    if (!tabNav || !tabIndicator) return;
    const active = tabs.find((tab) => tab.dataset.active === "true");
    if (!active) return;
    tabIndicator.style.left = `${active.offsetLeft}px`;
    tabIndicator.style.width = `${active.offsetWidth}px`;
  };
  const showPanel = (name: string) => {
    const normalized = [
      "general",
      "claude",
      "codex",
      "mcp",
      "skills",
      "diagnostics",
    ].includes(name)
      ? name
      : "general";
    setPref("settingsProvider", normalized);
    tabs.forEach((tab) => {
      const active = tab.dataset.panel === normalized;
      tab.dataset.active = active ? "true" : "false";
    });
    panels.forEach((panel) => {
      panel.hidden = panel.id !== `claudero-pref-panel-${normalized}`;
    });
    updateTabIndicator();
    window.requestAnimationFrame(updateTabIndicator);
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () =>
      showPanel(tab.dataset.panel || "general"),
    );
  });
  window.addEventListener("resize", updateTabIndicator);

  bindProviderPath(doc, "claude");
  bindProviderPath(doc, "codex");
  bindProviderEnvironment(doc, "claude");
  bindProviderEnvironment(doc, "codex");
  bindCodexSettings(doc);
  bindMcpSettings(doc);
  bindAcademicSkills(doc);
  bindDiagnostics(doc);
  showPanel(String(getPref("settingsProvider") || "general"));
  window.setTimeout(updateTabIndicator, 0);
}

async function readHelperToken(): Promise<string> {
  const tokenPath = [Zotero.Profile.dir, "claudero", "helper", ".token"].join(
    "/",
  );
  try {
    return (await (IOUtils as any).readUTF8(tokenPath)).trim();
  } catch {
    return "";
  }
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
  const zoteroMcp = doc.querySelector("#claudero-pref-enable-zotero-mcp") as
    | (HTMLElement & { checked?: boolean })
    | null;
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
    const port = Number(getPref("helperPort") || 38660);
    const token = await readHelperToken();
    const response = await fetch(`http://127.0.0.1:${port}/test-mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ config }),
    });
    if (!response.ok) {
      throw new Error(`Helper returned ${response.status}`);
    }
    return (await response.json()) as unknown as {
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
    };
  };

  if (zoteroMcp) {
    zoteroMcp.checked = isZoteroMcpEnabled();
    zoteroMcp.addEventListener("command", () => {
      setZoteroMcpEnabled(zoteroMcp.checked === true);
    });
    zoteroMcp.addEventListener("change", () => {
      setZoteroMcpEnabled(zoteroMcp.checked === true);
    });
  }

  const renderStatus = (raw: string) => {
    if (!status) return;
    const value = raw.trim();
    status.classList.remove("error", "success");
    if (!value) {
      status.textContent = "No external MCP servers configured";
      return;
    }
    try {
      const count = Object.keys(parseCustomMcpServers(value)).length;
      status.textContent = `MCP JSON saved (${count} server${count === 1 ? "" : "s"})`;
      status.classList.add("success");
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? `Invalid MCP JSON: ${error.message}`
          : "Invalid MCP JSON";
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
      empty.textContent = "No MCP servers configured.";
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
      meta.textContent = `${serverType(config)} · ${config.contextSaving ? "@" : "always"} · ${serverPreview(config) || "no command/url"}`;
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
          toolsPanel.textContent = "Testing...";
          void testMcpServer(config)
            .then((result) => {
              toolsPanel.replaceChildren();
              if (!result.success) {
                toolsPanel.textContent = result.error || "Verification failed";
                toolsPanel.classList.add("error");
                return;
              }
              toolsPanel.classList.remove("error");
              const heading = createHtml("div", "claudero-pref-mcp-tools-head");
              const label = [result.serverName, result.serverVersion]
                .filter(Boolean)
                .join(" ");
              heading.textContent = label
                ? `${label} tools`
                : "Available tools";
              toolsPanel.appendChild(heading);
              const toolRows = result.tools || [];
              if (toolRows.length === 0) {
                const empty = createHtml("div", "claudero-pref-mcp-tool-row");
                empty.textContent = "No tools reported.";
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
                  tool.enabled ? "Disable" : "Enable",
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
            `Edit MCP server "${name}" JSON`,
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
              error instanceof Error ? error.message : "Invalid MCP JSON",
            );
          }
        }),
        makeButton("Delete", () => {
          if (!win?.confirm(`Delete MCP server "${name}"?`)) return;
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
    const name = win?.prompt("MCP server name", "filesystem")?.trim();
    if (!name) return;
    const command = win?.prompt("Command", "npx")?.trim();
    if (!command) return;
    const argsText =
      win?.prompt(
        "Arguments, separated by spaces",
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
    const name = win?.prompt("MCP server name", "remote")?.trim();
    if (!name) return;
    const url = win
      ?.prompt("HTTP/SSE URL", "http://127.0.0.1:3000/sse")
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

  const editSkill = (record: AcademicSkillRecord) => {
    const raw = win?.prompt(
      `Edit academic skill "${record.skill.title}" JSON`,
      JSON.stringify(record.skill, null, 2),
    );
    if (raw === null || raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as AcademicSkill;
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
    const table = createHtml("table", "claudero-pref-skills-table");
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
    table.appendChild(thead);

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

      const statusCell = createHtml("td");
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
      examples.textContent = `Examples: ${shortList(record.skill.intentExamples.slice(0, 3))}`;
      detailCell.append(desc, examples);
      detailRow.appendChild(detailCell);
      tbody.appendChild(detailRow);
    }
    table.appendChild(tbody);
    shell.appendChild(table);
    list.appendChild(shell);
  };

  testButton?.addEventListener("click", () => {
    const query = testInput?.value.trim() || "";
    if (!testResult) return;
    if (!query) {
      testResult.textContent = "Enter a prompt to test skill routing.";
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
    testResult.textContent = `Matched ${match.skill.title} (${match.confidence.toFixed(2)}): ${match.matchedTerms.join(", ")}`;
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
      setStatus(`Imported ${skill.title} as disabled`, "success");
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
  };
  runtimes?: Record<
    string,
    {
      active?: boolean;
      workspacePath?: string | null;
      session?: {
        threadId?: string;
        sessionFilePath?: string;
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
}

function bindDiagnostics(doc: Document): void {
  const refresh = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-diagnostics-refresh",
  );
  const exportButton = doc.querySelector<HTMLButtonElement>(
    "#claudero-pref-diagnostics-export",
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
      status.textContent = "Loading helper diagnostics...";
    }
    try {
      const port = Number(getPref("helperPort") || 38660);
      const token = await readHelperToken();
      const response = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error(`Helper returned ${response.status}`);
      }
      const data = (await response.json()) as DiagnosticsPayload;
      summary?.replaceChildren(
        renderCard("Helper", [
          ["Version", data.helper?.version],
          ["Active provider", data.helper?.activeProvider],
          ["Runtime active", data.helper?.active],
        ]),
        renderCard("Claude", [
          ["Active", data.runtimes?.claude?.active],
          ["Workspace", data.runtimes?.claude?.workspacePath],
        ]),
        renderCard("Codex", [
          ["Active", data.runtimes?.codex?.active],
          ["Workspace", data.runtimes?.codex?.workspacePath],
          ["Thread", data.runtimes?.codex?.session?.threadId],
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
          },
          null,
          2,
        );
      }
      if (status) {
        status.textContent = "Helper diagnostics loaded";
        status.classList.add("success");
      }
    } catch (error) {
      summary?.replaceChildren();
      if (trace) trace.textContent = "";
      if (status) {
        status.textContent =
          error instanceof Error
            ? `Diagnostics unavailable: ${error.message}`
            : "Diagnostics unavailable";
        status.classList.add("error");
      }
    }
  };

  refresh?.addEventListener("click", () => void load());
  exportButton?.addEventListener("click", () => {
    if (status) {
      status.classList.remove("error", "success");
      status.textContent = "Exporting diagnostic log...";
    }
    void exportDiagnosticLog()
      .then((path) => {
        if (status) {
          status.textContent = `Diagnostic log saved: ${path}`;
          status.classList.add("success");
        }
      })
      .catch((error) => {
        if (status) {
          status.textContent =
            error instanceof Error
              ? `Export failed: ${error.message}`
              : "Export failed";
          status.classList.add("error");
        }
      });
  });
  void load();
}

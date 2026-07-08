import { getPref, setPref } from "../utils/prefs";

export interface ManagedMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  enabled?: boolean;
  description?: string;
  contextSaving?: boolean;
  disabledTools?: string[];
  [key: string]: unknown;
}

export function isZoteroMcpEnabled(): boolean {
  return true;
}

export function setZoteroMcpEnabled(_enabled: boolean): void {
  // Zotero MCP is a core Claudero capability and is always exposed when the
  // helper/runtime supports MCP tools.
}

export function getCustomMcpServersRaw(): string {
  return String(getPref("mcpServers") || "").trim();
}

export function setCustomMcpServersRaw(raw: string): void {
  setPref("mcpServers", raw.trim());
}

export function parseCustomMcpServers(
  raw = getCustomMcpServersRaw(),
  mentionedServers?: Set<string>,
): Record<string, ManagedMcpServerConfig> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  const root =
    parsed &&
    typeof parsed === "object" &&
    "mcpServers" in parsed &&
    (parsed as Record<string, unknown>).mcpServers &&
    typeof (parsed as Record<string, unknown>).mcpServers === "object"
      ? ((parsed as Record<string, unknown>).mcpServers as Record<
          string,
          unknown
        >)
      : (parsed as Record<string, unknown>);
  const servers: Record<string, ManagedMcpServerConfig> = {};
  for (const [name, config] of Object.entries(root || {})) {
    if (!name.trim() || !config || typeof config !== "object") continue;
    const managed = config as ManagedMcpServerConfig;
    if (managed.enabled === false) continue;
    if (managed.contextSaving && !mentionedServers?.has(name.trim())) continue;
    servers[name.trim()] = toRuntimeMcpConfig(managed);
  }
  return servers;
}

export function extractMcpMentions(
  text: string,
  servers: Record<string, ManagedMcpServerConfig> = parseManagedMcpServers(),
): Set<string> {
  const names = Object.entries(servers)
    .filter(([, config]) => config.enabled !== false && config.contextSaving)
    .map(([name]) => name);
  const mentions = new Set<string>();
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\s)@${escaped}(?=\\s|$|[.,;:!?])`, "i");
    if (pattern.test(text)) mentions.add(name);
  }
  return mentions;
}

export function getDisabledMcpTools(
  raw = getCustomMcpServersRaw(),
  mentionedServers?: Set<string>,
): string[] {
  const servers = parseManagedMcpServers(raw);
  const disabled = new Set<string>();
  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled === false) continue;
    if (config.contextSaving && !mentionedServers?.has(name)) continue;
    for (const tool of config.disabledTools || []) {
      const trimmed = String(tool).trim();
      if (trimmed) disabled.add(`mcp__${name}__${trimmed}`);
    }
  }
  return [...disabled].sort();
}

export function parseManagedMcpServers(
  raw = getCustomMcpServersRaw(),
): Record<string, ManagedMcpServerConfig> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  const root =
    parsed &&
    typeof parsed === "object" &&
    "mcpServers" in parsed &&
    (parsed as Record<string, unknown>).mcpServers &&
    typeof (parsed as Record<string, unknown>).mcpServers === "object"
      ? ((parsed as Record<string, unknown>).mcpServers as Record<
          string,
          unknown
        >)
      : (parsed as Record<string, unknown>);
  const servers: Record<string, ManagedMcpServerConfig> = {};
  for (const [name, config] of Object.entries(root || {})) {
    if (!name.trim() || !config || typeof config !== "object") continue;
    servers[name.trim()] = config as ManagedMcpServerConfig;
  }
  return servers;
}

export function serializeManagedMcpServers(
  servers: Record<string, ManagedMcpServerConfig>,
): string {
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

function toRuntimeMcpConfig(
  config: ManagedMcpServerConfig,
): ManagedMcpServerConfig {
  const {
    enabled: _enabled,
    description: _description,
    contextSaving: _contextSaving,
    disabledTools: _disabledTools,
    ...runtime
  } = config;
  return runtime;
}

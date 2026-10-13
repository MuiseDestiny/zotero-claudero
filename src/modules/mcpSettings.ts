import { getPref, setPref } from "../utils/prefs";
import {
  parseMcpServersJson,
  validateMcpServers,
} from "../shared/mcpConfigValidation";

export {
  validateMcpServerConfig,
  validateMcpServers,
} from "../shared/mcpConfigValidation";
import type { ManagedMcpServerConfig } from "../shared/mcpConfigValidation";
export type { ManagedMcpServerConfig } from "../shared/mcpConfigValidation";

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
  parseMcpServersJson(raw);
  setPref("mcpServers", raw.trim());
}

export function parseCustomMcpServers(
  raw = getCustomMcpServersRaw(),
  mentionedServers?: Set<string>,
): Record<string, ManagedMcpServerConfig> {
  const root = parseManagedMcpServers(raw);
  const servers: Record<string, ManagedMcpServerConfig> = {};
  for (const [name, config] of Object.entries(root || {})) {
    if (!name.trim() || !config || typeof config !== "object") continue;
    const managed = config as ManagedMcpServerConfig;
    if (managed.enabled === false) continue;
    if (managed.contextSaving && !mentionedServers?.has(name.trim())) continue;
    Object.defineProperty(servers, name.trim(), {
      value: toRuntimeMcpConfig(managed),
      enumerable: true,
      configurable: true,
      writable: true,
    });
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
  return parseMcpServersJson(raw);
}

/** Parse CLI arguments without invoking a shell, preserving quoted paths. */
export function parseMcpArguments(text: string): string[] {
  const args: string[] = [];
  let value = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (
      char === "\\" &&
      ((quote && text[i + 1] === quote) ||
        (!quote && /[\s"']/.test(text[i + 1] || "")))
    ) {
      value += text[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(value);
      value = "";
      started = false;
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error("Close the quote in the MCP arguments.");
  if (started) args.push(value);
  return args;
}

export function serializeManagedMcpServers(
  servers: Record<string, ManagedMcpServerConfig>,
): string {
  const error = validateMcpServers(servers);
  if (error) throw new Error(error);
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

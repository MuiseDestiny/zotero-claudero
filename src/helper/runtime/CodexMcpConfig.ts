export interface CodexMcpConfig {
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
}

export interface CodexMcpExecutionTarget {
  method: "host-native" | "native-windows" | "wsl";
  platformFamily: "unix" | "windows";
  platformOs: "macos" | "linux" | "windows";
  distroName?: string;
}

export interface CodexMcpPathMapper {
  target: CodexMcpExecutionTarget;
  toTargetPath(path: string): string | null;
  toHostPath(path: string): string | null;
}

export interface ZoteroBridgeMcpConfig {
  endpoint: string;
  helperUrl: string;
  token: string;
  bundlePath: string;
  nodeCommand: string;
  mapper: CodexMcpPathMapper;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function tomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlInlineValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlInlineValue(item)).join(", ")}]`;
  }
  if (isPlainRecord(value)) {
    return `{ ${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(
        ([key, entry]) => `${tomlKeySegment(key)} = ${tomlInlineValue(entry)}`,
      )
      .join(", ")} }`;
  }
  return tomlString(String(value ?? ""));
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function shouldMapMcpArgument(
  value: string,
  mapper: CodexMcpPathMapper,
): boolean {
  if (mapper.target.method !== "wsl") return false;
  return (
    isWindowsAbsolutePath(value) ||
    value.startsWith("\\\\wsl$\\") ||
    value.startsWith("/")
  );
}

function mapMcpPath(value: unknown, mapper: CodexMcpPathMapper): unknown {
  if (typeof value !== "string") return value;
  if (!shouldMapMcpArgument(value, mapper)) return value;
  return mapper.toTargetPath(value) || value;
}

function disabledToolsForServer(
  serverName: string,
  disabledTools: string[] | undefined,
): string[] {
  const prefix = `mcp__${serverName}__`;
  return [
    ...new Set(
      (disabledTools || [])
        .map(String)
        .filter((tool) => tool.startsWith(prefix))
        .map((tool) => tool.slice(prefix.length))
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeCodexMcpServerConfig(
  serverName: string,
  rawConfig: unknown,
  config: CodexMcpConfig,
  mapper: CodexMcpPathMapper,
): JsonRecord | null {
  const raw = asRecord(rawConfig);
  if (!raw) return null;
  const next: JsonRecord = {};
  const command = textValue(raw.command);
  const url = textValue(raw.url);
  if (command) next.command = command;
  if (url) next.url = url;
  if (!next.command && !next.url) return null;
  if (Array.isArray(raw.args)) {
    next.args = raw.args.map((arg) => mapMcpPath(arg, mapper));
  }
  if (isPlainRecord(raw.env)) next.env = raw.env;
  if (typeof raw.cwd === "string") next.cwd = mapMcpPath(raw.cwd, mapper);
  if (isPlainRecord(raw.http_headers)) next.http_headers = raw.http_headers;
  if (isPlainRecord(raw.headers)) next.http_headers = raw.headers;
  if (isPlainRecord(raw.env_http_headers)) {
    next.env_http_headers = raw.env_http_headers;
  }
  if (typeof raw.bearer_token_env_var === "string") {
    next.bearer_token_env_var = raw.bearer_token_env_var;
  }
  if (typeof raw.startup_timeout_sec === "number") {
    next.startup_timeout_sec = raw.startup_timeout_sec;
  }
  if (typeof raw.tool_timeout_sec === "number") {
    next.tool_timeout_sec = raw.tool_timeout_sec;
  }
  if (raw.enabled === false) next.enabled = false;
  if (raw.required === true) next.required = true;
  if (Array.isArray(raw.enabled_tools)) next.enabled_tools = raw.enabled_tools;
  const disabledTools = [
    ...(Array.isArray(raw.disabled_tools)
      ? raw.disabled_tools.map(String)
      : []),
    ...disabledToolsForServer(serverName, config.mcpDisabledTools),
  ];
  if (disabledTools.length > 0) {
    next.disabled_tools = [...new Set(disabledTools)].sort();
  }
  if (typeof raw.default_tools_approval_mode === "string") {
    next.default_tools_approval_mode = raw.default_tools_approval_mode;
  }

  return next;
}

export function buildCodexMcpConfigOverrides(
  config: CodexMcpConfig,
  mapper: CodexMcpPathMapper,
): string[] {
  const threadConfig = buildCodexMcpThreadConfig(config, mapper);
  const args: string[] = [];
  const appendOverride = (keyPath: string, value: unknown): void => {
    if (value === undefined) return;
    if (isPlainRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        appendOverride(`${keyPath}.${tomlKeySegment(key)}`, entry);
      }
      return;
    }
    args.push("--config", `${keyPath}=${tomlInlineValue(value)}`);
  };
  for (const [key, value] of Object.entries(threadConfig)) {
    appendOverride(tomlKeySegment(key), value);
  }
  return args;
}

export function buildCodexMcpThreadConfig(
  config: CodexMcpConfig,
  mapper: CodexMcpPathMapper,
): JsonRecord {
  const servers = config.mcpServers || {};
  const mcpServers: JsonRecord = {};
  for (const [name, rawServer] of Object.entries(servers)) {
    const serverName = name.trim();
    if (!serverName) continue;
    const server = normalizeCodexMcpServerConfig(
      serverName,
      rawServer,
      config,
      mapper,
    );
    if (!server) continue;
    mcpServers[serverName] = server;
  }
  return Object.keys(mcpServers).length ? { mcp_servers: mcpServers } : {};
}

export function buildZoteroBridgeMcpServer(
  config: ZoteroBridgeMcpConfig,
): JsonRecord {
  const bundlePath =
    config.mapper.target.method === "wsl"
      ? config.mapper.toTargetPath(config.bundlePath) || config.bundlePath
      : config.bundlePath;
  return {
    command: config.nodeCommand,
    args: [
      bundlePath,
      "--zotero-mcp-stdio",
      "--endpoint",
      config.endpoint,
      "--helper-url",
      config.helperUrl,
      "--token",
      config.token,
    ],
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
    // Match Claude SDK mode: Zotero read tools run directly, while write tools
    // are still protected inside ZoteroMcpBridge by Claudero's permission dialog.
    default_tools_approval_mode: "approve",
  };
}

import {
  isConfigRecord,
  isJsonConfigValue,
  isStringArray,
} from "./configValidation";

export interface ManagedMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  description?: string;
  contextSaving?: boolean;
  disabledTools?: string[];
  [key: string]: unknown;
}

/** Returns the first validation error, or null; does not mutate the input. */
export function validateMcpServerConfig(value: unknown): string | null {
  if (!isConfigRecord(value))
    return "MCP server configuration must be an object.";
  for (const key of ["command", "url", "type", "cwd", "description"]) {
    if (key in value && typeof value[key] !== "string")
      return `MCP ${key} must be a string.`;
  }
  for (const key of ["enabled", "contextSaving"]) {
    if (key in value && typeof value[key] !== "boolean")
      return `MCP ${key} must be a boolean.`;
  }
  for (const key of ["args", "disabledTools"]) {
    if (key in value && !isStringArray(value[key]))
      return `MCP ${key} must be an array of strings.`;
  }
  for (const key of ["env", "headers"]) {
    if (
      key in value &&
      (!isConfigRecord(value[key]) ||
        !Object.values(value[key]).every((entry) => typeof entry === "string"))
    ) {
      return `MCP ${key} must be an object of string values.`;
    }
  }
  if (
    value.type !== undefined &&
    !["stdio", "http", "sse"].includes(value.type as string)
  ) {
    return "MCP type must be stdio, http, or sse.";
  }
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const url = typeof value.url === "string" ? value.url.trim() : "";
  if (!command && !url) return "Missing MCP command or URL.";
  if (command && url)
    return "MCP configuration must use either command or URL, not both.";
  if (value.type === "stdio" && !command)
    return "MCP stdio requires a command.";
  if ((value.type === "http" || value.type === "sse") && !url)
    return "MCP HTTP/SSE requires a URL.";
  if (url) {
    try {
      if (!/^https?:$/.test(new URL(url).protocol))
        return "MCP URL must use HTTP or HTTPS.";
    } catch {
      return "MCP URL must be a valid HTTP or HTTPS URL.";
    }
  }
  if (!isJsonConfigValue(value))
    return "MCP configuration must contain only JSON data.";
  return null;
}

/** Validates a bare server map (runtime payload), not an mcpServers wrapper. */
export function validateMcpServers(value: unknown): string | null {
  if (!isConfigRecord(value)) return "mcpServers must be a JSON object.";
  const names = new Set<string>();
  for (const [name, config] of Object.entries(value)) {
    if (!name.trim()) return "Each MCP server needs a name.";
    if (names.has(name.trim()))
      return "MCP server names must be unique after trimming.";
    names.add(name.trim());
    const error = validateMcpServerConfig(config);
    if (error) return `MCP server ${JSON.stringify(name)}: ${error}`;
  }
  return null;
}

export function parseMcpServersJson(
  raw: string,
): Record<string, ManagedMcpServerConfig> {
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isConfigRecord(parsed))
    throw new Error("MCP configuration must be a JSON object.");
  const root = Object.prototype.hasOwnProperty.call(parsed, "mcpServers")
    ? parsed.mcpServers
    : parsed;
  const error = validateMcpServers(root);
  if (error) throw new Error(error);
  return Object.fromEntries(
    Object.entries(root as Record<string, ManagedMcpServerConfig>).map(
      ([name, config]) => [name.trim(), config],
    ),
  );
}

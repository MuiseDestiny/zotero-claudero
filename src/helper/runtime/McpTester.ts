import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  disabledTools?: string[];
  [key: string]: unknown;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  enabled: boolean;
}

export interface McpTestResult {
  success: boolean;
  serverName?: string;
  serverVersion?: string;
  tools: McpToolInfo[];
  error?: string;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function disabledToolSet(config: McpServerConfig): Set<string> {
  return new Set(
    Array.isArray(config.disabledTools) ? config.disabledTools.map(String) : [],
  );
}

function normalizeTools(value: unknown, disabled: Set<string>): McpToolInfo[] {
  const record = asRecord(value);
  const rawTools = Array.isArray(record?.tools) ? record.tools : [];
  return rawTools
    .map((raw): McpToolInfo | null => {
      const tool = asRecord(raw);
      if (!tool) return null;
      const name = typeof tool.name === "string" ? tool.name : "";
      if (!name) return null;
      return {
        name,
        description:
          typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: asRecord(tool.inputSchema) || undefined,
        enabled: !disabled.has(name),
      };
    })
    .filter((tool): tool is McpToolInfo => !!tool);
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function extractFrames(buffer: Buffer<ArrayBufferLike>): {
  messages: JsonRpcResponse[];
  rest: Buffer<ArrayBufferLike>;
} {
  const messages: JsonRpcResponse[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = rest.slice(0, headerEnd).toString("utf8");
    const match = header.match(/content-length:\s*(\d+)/i);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    try {
      messages.push(JSON.parse(rest.slice(bodyStart, bodyEnd).toString("utf8")));
    } catch {
      // Skip malformed frames.
    }
    rest = rest.slice(bodyEnd);
  }
  return { messages, rest };
}

async function testStdioMcpServer(
  config: McpServerConfig,
  timeoutMs: number,
): Promise<McpTestResult> {
  const command = config.command?.trim();
  if (!command) {
    return { success: false, tools: [], error: "Missing MCP stdio command" };
  }
  const disabled = disabledToolSet(config);
  let proc: ChildProcessWithoutNullStreams | null = null;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  let nextId = 1;

  const request = (method: string, params?: unknown) => {
    const id = nextId++;
    const message =
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params };
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) {
          reject(new Error(response.error.message || `${method} failed`));
          return;
        }
        resolve(response);
      });
      proc?.stdin.write(frame(message));
    });
  };

  try {
    proc = spawn(command, Array.isArray(config.args) ? config.args : [], {
      cwd: typeof config.cwd === "string" ? config.cwd : undefined,
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = extractFrames(buffer);
      buffer = parsed.rest;
      for (const message of parsed.messages) {
        if (typeof message.id === "number") {
          const resolve = pending.get(message.id);
          if (resolve) {
            pending.delete(message.id);
            resolve(message);
          }
        }
      }
    });
    proc.stderr.resume();

    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claudero-mcp-tester", version: "0.1.0" },
    });
    proc.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const tools = await request("tools/list");
    const serverInfo = asRecord(asRecord(init.result)?.serverInfo);
    return {
      success: true,
      serverName:
        typeof serverInfo?.name === "string" ? serverInfo.name : undefined,
      serverVersion:
        typeof serverInfo?.version === "string"
          ? serverInfo.version
          : undefined,
      tools: normalizeTools(tools.result, disabled),
    };
  } catch (error) {
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    proc?.kill("SIGTERM");
  }
}

function parseHttpRpcResponse(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.match(/^data:\s*(.*)$/)?.[1]?.trim();
    if (data && data !== "[DONE]") return JSON.parse(data) as JsonRpcResponse;
  }
  return {};
}

async function postJsonRpc(
  url: string,
  headers: Record<string, string> | undefined,
  message: unknown,
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(headers || {}),
      },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `HTTP ${response.status}`);
    }
    const parsed = parseHttpRpcResponse(text);
    if (parsed.error) {
      throw new Error(parsed.error.message || "MCP HTTP request failed");
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function testHttpMcpServer(
  config: McpServerConfig,
  timeoutMs: number,
): Promise<McpTestResult> {
  const url = typeof config.url === "string" ? config.url.trim() : "";
  if (!url) return { success: false, tools: [], error: "Missing MCP URL" };
  const disabled = disabledToolSet(config);
  try {
    const init = await postJsonRpc(
      url,
      config.headers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "claudero-mcp-tester", version: "0.1.0" },
        },
      },
      timeoutMs,
    );
    await postJsonRpc(
      url,
      config.headers,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      timeoutMs,
    ).catch(() => {});
    const tools = await postJsonRpc(
      url,
      config.headers,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      timeoutMs,
    );
    const serverInfo = asRecord(asRecord(init.result)?.serverInfo);
    return {
      success: true,
      serverName:
        typeof serverInfo?.name === "string" ? serverInfo.name : undefined,
      serverVersion:
        typeof serverInfo?.version === "string"
          ? serverInfo.version
          : undefined,
      tools: normalizeTools(tools.result, disabled),
    };
  } catch (error) {
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function testMcpServer(
  config: McpServerConfig,
  timeoutMs = 12_000,
): Promise<McpTestResult> {
  return config.command
    ? testStdioMcpServer(config, timeoutMs)
    : testHttpMcpServer(config, timeoutMs);
}

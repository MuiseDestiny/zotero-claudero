import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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

function createTransport(config: McpServerConfig): Transport {
  if (config.command?.trim()) {
    const transport = new StdioClientTransport({
      command: config.command.trim(),
      args: config.args,
      cwd: config.cwd,
      env: { ...process.env, ...config.env } as Record<string, string>,
      stderr: "pipe",
    });
    // Drain diagnostics without exposing environment values or credentials.
    transport.stderr?.on("data", () => {});
    return transport;
  }
  if (!config.url?.trim()) throw new Error("Missing MCP command or URL");
  const url = new URL(config.url.trim());
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("MCP URL must use HTTP or HTTPS");
  }
  const requestInit = { headers: config.headers };
  return config.type === "sse"
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

export async function testMcpServer(
  config: McpServerConfig,
  timeoutMs = 12_000,
): Promise<McpTestResult> {
  const client = new Client({ name: "claudero-mcp-tester", version: "0.1.0" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const transport = createTransport(config);
    const inspect = async (): Promise<McpTestResult> => {
      await client.connect(transport, { timeout: timeoutMs });
      const server = client.getServerVersion();
      const disabled = new Set(config.disabledTools || []);
      const tools: McpToolInfo[] = [];
      if (client.getServerCapabilities()?.tools) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, {
            timeout: timeoutMs,
          });
          tools.push(
            ...page.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              enabled: !disabled.has(tool.name),
            })),
          );
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) {
            throw new Error("MCP tools/list returned a repeated cursor");
          }
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      return {
        success: true,
        serverName: server?.name,
        serverVersion: server?.version,
        tools,
      };
    };
    // Bound the entire handshake (including opening a legacy SSE connection)
    // and pagination, not just each individual JSON-RPC request.
    return await Promise.race([
      inspect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("MCP connection test timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    return {
      success: false,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

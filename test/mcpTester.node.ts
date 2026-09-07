import { assert } from "chai";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import process from "node:process";
import { testMcpServer } from "../src/helper/runtime/McpTester";

const serverInfo = { name: "fixture", version: "1.0.0" };
const tool = (name: string) => ({ name, inputSchema: { type: "object" } });
const initResult = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: {} },
  serverInfo,
};
async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  run: (url: string) => Promise<void>,
) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500).end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("MCP connection tests", function () {
  this.timeout(10_000);

  it("reports missing executables instead of crashing the helper", async function () {
    const result = await testMcpServer(
      { command: "claudero-nonexistent-mcp-executable" },
      1500,
    );
    assert.isFalse(result.success);
    assert.match(result.error || "", /ENOENT|not found/i);
  });

  it("reports a stdio process that exits during initialization", async function () {
    const result = await testMcpServer(
      { command: process.execPath, args: ["-e", "process.exit(7)"] },
      1500,
    );
    assert.isFalse(result.success);
    assert.match(result.error || "", /closed/i);
  });

  it("reads all stdio tool pages and preserves disabled tools", async function () {
    const script = `
      const readline = require('node:readline');
      readline.createInterface({ input: process.stdin }).on('line', line => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        const result = m.method === 'initialize' ? ${JSON.stringify(initResult)}
          : m.params?.cursor ? { tools: [${JSON.stringify(tool("second"))}] }
          : { tools: [${JSON.stringify(tool("first"))}], nextCursor: 'page2' };
        process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result}) + '\\n');
      });`;
    const result = await testMcpServer(
      {
        command: process.execPath,
        args: ["-e", script],
        disabledTools: ["second"],
      },
      1500,
    );
    assert.isTrue(result.success, result.error);
    assert.equal(result.serverName, "fixture");
    assert.deepEqual(
      result.tools.map(({ name, enabled }) => ({ name, enabled })),
      [
        { name: "first", enabled: true },
        { name: "second", enabled: false },
      ],
    );
  });

  it("correlates SSE replies after notifications without waiting for EOF", async function () {
    const seen: Array<{ method: string; session?: string; protocol?: string }> =
      [];
    await withServer(
      async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const message = await body(req);
        seen.push({
          method: message.method,
          session: req.headers["mcp-session-id"] as string,
          protocol: req.headers["mcp-protocol-version"] as string,
        });
        assert.equal(req.headers.authorization, "Bearer fixture-token");
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "fixture-session",
        });
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "starting" } })}\n\n`,
        );
        const result =
          message.method === "initialize"
            ? initResult
            : { tools: [tool("search")] };
        const reply = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`;
        res.write(reply.slice(0, 27));
        res.write(reply.slice(27));
        // Leave the stream open, as a real MCP server is allowed to do.
      },
      async (url) => {
        const result = await testMcpServer(
          { url, headers: { Authorization: "Bearer fixture-token" } },
          1500,
        );
        assert.isTrue(result.success, result.error);
        assert.equal(result.tools[0]?.name, "search");
        assert.deepInclude(seen, {
          method: "tools/list",
          session: "fixture-session",
          protocol: "2025-03-26",
        });
      },
    );
  });

  it("supports legacy SSE endpoints with authorization on GET and POST", async function () {
    let events: ServerResponse | undefined;
    await withServer(
      async (req, res) => {
        assert.equal(req.headers.authorization, "Bearer fixture-token");
        if (req.method === "GET") {
          events = res;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("event: endpoint\ndata: /messages\n\n");
          return;
        }
        const message = await body(req);
        res.writeHead(202).end();
        if (message.id === undefined) return;
        const result =
          message.method === "initialize"
            ? initResult
            : { tools: [tool("legacy")] };
        events?.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        );
      },
      async (url) => {
        const result = await testMcpServer(
          {
            type: "sse",
            url,
            headers: { Authorization: "Bearer fixture-token" },
          },
          1500,
        );
        assert.isTrue(result.success, result.error);
        assert.equal(result.tools[0]?.name, "legacy");
      },
    );
  });

  it("does not report a successful connection for invalid JSON-RPC responses", async function () {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      },
      async (url) => {
        const result = await testMcpServer({ url }, 100);
        assert.isFalse(result.success);
        assert.isNotEmpty(result.error);
      },
    );
  });

  it("bounds a legacy SSE handshake that never announces its endpoint", async function () {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": keepalive\n\n");
      },
      async (url) => {
        const result = await testMcpServer({ type: "sse", url }, 100);
        assert.isFalse(result.success);
        assert.match(result.error || "", /timed out/i);
      },
    );
  });

  it("accepts a server offering resources but no tools", async function () {
    await withServer(
      async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        const message = await body(req);
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        assert.equal(message.method, "initialize");
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { ...initResult, capabilities: { resources: {} } },
            }),
          );
      },
      async (url) => {
        const result = await testMcpServer({ url }, 1500);
        assert.isTrue(result.success, result.error);
        assert.isEmpty(result.tools);
      },
    );
  });
});

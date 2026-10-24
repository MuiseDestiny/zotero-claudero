import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

const codex = process.argv.includes("app-server");
if (process.env.CLAUDERO_FIXTURE_AUTOLOAD)
  throw new Error("Workspace .env was unexpectedly loaded");
const write = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const lineReader = createInterface({ input: process.stdin });
let turn = 0;

async function checkBridge(server: any): Promise<void> {
  if (!server || server.args[0] !== "--zotero-mcp-stdio")
    throw new Error("Fixture expected a standalone self-spawn MCP bridge");
  const child = spawn(server.command, server.args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  child.once("error", (error) => {
    for (const wait of pending.values()) wait.reject(error);
  });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.resolve(message);
  });
  const request = (id: number, method: string, params = {}) =>
    new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const timer = setTimeout(() => {
    for (const wait of pending.values())
      wait.reject(new Error("Fixture MCP bridge timed out"));
  }, 5000);
  try {
    const init = await request(1, "initialize");
    if (init.result?.serverInfo?.name !== "zotero")
      throw new Error("Fixture MCP initialize failed");
    const list = await request(2, "tools/list");
    if (!list.result?.tools?.some((tool: any) => tool.name === "get_item"))
      throw new Error("Fixture MCP tools missing");
    const result = await request(3, "tools/call", {
      name: "get_item",
      arguments: { itemId: 1 },
    });
    if (
      result.result?.isError ||
      !result.result?.content?.[0]?.text?.includes("fixture paper")
    )
      throw new Error("Fixture MCP read failed");
  } finally {
    clearTimeout(timer);
    lines.close();
    child.kill();
  }
}

lineReader.on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(String(error) + "\n");
    process.exit(2);
  });
});

async function handle(message: any): Promise<void> {
  if (!codex) {
    if (message.type === "control_request") {
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { commands: [], models: [], account: {} },
        },
      });
    } else if (message.type === "user") {
      const text = `CLAUDE_NATIVE_${++turn}`;
      write({
        type: "system",
        subtype: "init",
        session_id: "fixture-claude",
        tools: [],
        mcp_servers: [],
      });
      write({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          usage: { output_tokens: 3 },
        },
      });
      write({
        type: "result",
        subtype: "success",
        result: text,
        is_error: false,
        session_id: "fixture-claude",
        usage: { output_tokens: 3 },
        duration_ms: 1,
      });
    }
    return;
  }
  if (message.id === undefined) return;
  let result: any = {};
  if (message.method === "thread/start") {
    await checkBridge(message.params?.config?.mcp_servers?.zotero);
    result = {
      thread: { id: "fixture-codex", path: "/fixture/session.jsonl" },
    };
  } else if (message.method === "mcpServerStatus/list") {
    result = {
      data: [
        { name: "zotero", tools: { get_item: {} }, authStatus: "notLoggedIn" },
      ],
    };
  } else if (message.method === "model/list") {
    result = {
      data: [
        {
          id: "fixture",
          model: "fixture",
          displayName: "Fixture",
          isDefault: true,
        },
      ],
      nextCursor: null,
    };
  } else if (message.method === "turn/start") {
    const id = `fixture-turn-${++turn}`;
    result = { turn: { id, items: [], status: "inProgress" } };
    write({ id: message.id, result });
    const params = {
      threadId: "fixture-codex",
      turnId: id,
      itemId: `message-${turn}`,
      delta: `CODEX_NATIVE_${turn}`,
    };
    write({ method: "item/agentMessage/delta", params });
    write({
      method: "turn/completed",
      params: { threadId: "fixture-codex", turn: { id, status: "completed" } },
    });
    return;
  }
  write({ id: message.id, result });
}

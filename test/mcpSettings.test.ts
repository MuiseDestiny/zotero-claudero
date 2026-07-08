import { assert } from "chai";
import {
  extractMcpMentions,
  getDisabledMcpTools,
  parseCustomMcpServers,
  parseManagedMcpServers,
  serializeManagedMcpServers,
} from "../src/modules/mcpSettings";

describe("MCP settings", function () {
  it("filters disabled servers and strips UI-only fields for runtime config", function () {
    const raw = JSON.stringify({
        mcpServers: {
          filesystem: {
            enabled: true,
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            description: "Local files",
            contextSaving: true,
            disabledTools: ["write_file"],
          },
          off: {
            enabled: false,
            command: "node",
            args: ["server.js"],
          },
        },
      });
    const mentions = extractMcpMentions("use @filesystem", parseManagedMcpServers(raw));
    const runtime = parseCustomMcpServers(raw, mentions);

    assert.deepEqual(runtime, {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      },
    });
    assert.deepEqual(getDisabledMcpTools(raw, mentions), [
      "mcp__filesystem__write_file",
    ]);
  });

  it("round-trips managed server JSON", function () {
    const raw = serializeManagedMcpServers({
      remote: { enabled: true, type: "sse", url: "http://127.0.0.1:3000/sse" },
    });

    assert.deepEqual(parseManagedMcpServers(raw), {
      remote: {
        enabled: true,
        type: "sse",
        url: "http://127.0.0.1:3000/sse",
      },
    });
  });
});

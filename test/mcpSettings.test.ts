import { assert } from "chai";
import {
  extractMcpMentions,
  getDisabledMcpTools,
  parseCustomMcpServers,
  parseManagedMcpServers,
  parseMcpArguments,
  serializeManagedMcpServers,
} from "../src/modules/mcpSettings";

describe("MCP settings", function () {
  it("keeps quoted paths and empty CLI arguments intact", function () {
    assert.deepEqual(parseMcpArguments('-y server "/Users/me/My Papers" ""'), [
      "-y",
      "server",
      "/Users/me/My Papers",
      "",
    ]);
    assert.deepEqual(
      parseMcpArguments(String.raw`server "C:\Users\me\My Papers"`),
      ["server", String.raw`C:\Users\me\My Papers`],
    );
    assert.deepEqual(
      parseMcpArguments(String.raw`server /my\ papers '$VALUE'`),
      ["server", "/my papers", "$VALUE"],
    );
    assert.throws(() => parseMcpArguments('"unfinished'), /quote/);
  });

  it("rejects invalid configuration shapes instead of silently erasing them", function () {
    for (const raw of [
      "[]",
      "null",
      '"text"',
      '{"mcpServers":null}',
      '{"remote":[]}',
      '{"remote":{"args":"-y server"}}',
    ]) {
      assert.throws(() => parseManagedMcpServers(raw));
      assert.throws(() => parseCustomMcpServers(raw));
    }
  });

  it("preserves server names that match object prototype properties", function () {
    const raw = '{"__proto__":{"command":"node"}}';
    assert.isTrue(
      Object.prototype.hasOwnProperty.call(
        parseManagedMcpServers(raw),
        "__proto__",
      ),
    );
    assert.isTrue(
      Object.prototype.hasOwnProperty.call(
        parseCustomMcpServers(raw),
        "__proto__",
      ),
    );
  });

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
    const mentions = extractMcpMentions(
      "use @filesystem",
      parseManagedMcpServers(raw),
    );
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

import { assert } from "chai";
import {
  buildCodexMcpConfigOverrides,
  buildZoteroBridgeMcpServer,
  type CodexMcpConfig,
  type CodexMcpPathMapper,
} from "../src/helper/runtime/CodexMcpConfig";

function baseConfig(overrides: Partial<CodexMcpConfig> = {}): CodexMcpConfig {
  return {
    ...overrides,
  };
}

function mapper(
  overrides: Partial<CodexMcpPathMapper> = {},
): CodexMcpPathMapper {
  return {
    target: {
      method: "host-native",
      platformFamily: "unix",
      platformOs: "macos",
    },
    toTargetPath: (value) => value,
    toHostPath: (value) => value,
    ...overrides,
  };
}

describe("Codex MCP config overrides", function () {
  it("serializes stdio and HTTP MCP servers for Codex app-server", function () {
    const args = buildCodexMcpConfigOverrides(
      baseConfig({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { FOO: "bar" },
          },
          remote: {
            url: "https://example.test/mcp",
            headers: { "X-Test": "1" },
          },
        },
        mcpDisabledTools: ["mcp__filesystem__write_file"],
      }),
      mapper(),
    );

    assert.deepEqual(
      args.filter((arg) => arg === "--config"),
      ["--config", "--config"],
    );
    assert.include(
      args,
      'mcp_servers.filesystem={ command = "npx", args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], env = { FOO = "bar" }, disabled_tools = ["write_file"] }',
    );
    assert.include(
      args,
      'mcp_servers.remote={ url = "https://example.test/mcp", http_headers = { X-Test = "1" } }',
    );
  });

  it("maps WSL cwd and absolute path arguments into the Codex target", function () {
    const args = buildCodexMcpConfigOverrides(
      baseConfig({
        mcpServers: {
          files: {
            command: "node",
            args: ["C:\\Users\\me\\repo", "--flag"],
            cwd: "C:\\Users\\me\\repo",
          },
        },
      }),
      mapper({
        target: {
          method: "wsl",
          platformFamily: "unix",
          platformOs: "linux",
          distroName: "Ubuntu",
        },
        toTargetPath: (value) =>
          value.replace(/^C:\\Users\\me\\repo$/, "/mnt/c/Users/me/repo"),
      }),
    );

    assert.include(
      args,
      'mcp_servers.files={ command = "node", args = ["/mnt/c/Users/me/repo", "--flag"], cwd = "/mnt/c/Users/me/repo" }',
    );
  });

  it("builds a stdio Zotero bridge server for Codex", function () {
    const server = buildZoteroBridgeMcpServer({
      endpoint: "http://127.0.0.1:23119/claudero",
      helperUrl: "http://127.0.0.1:38660",
      token: "secret",
      bundlePath: "C:\\Users\\me\\helper\\claudero-helper.mjs",
      nodeCommand: "node",
      mapper: mapper({
        target: {
          method: "wsl",
          platformFamily: "unix",
          platformOs: "linux",
          distroName: "Ubuntu",
        },
        toTargetPath: (value) =>
          value.replace(
            /^C:\\Users\\me\\helper\\claudero-helper\.mjs$/,
            "/mnt/c/Users/me/helper/claudero-helper.mjs",
          ),
      }),
    });

    assert.deepEqual(server, {
      command: "node",
      args: [
        "/mnt/c/Users/me/helper/claudero-helper.mjs",
        "--zotero-mcp-stdio",
        "--endpoint",
        "http://127.0.0.1:23119/claudero",
        "--helper-url",
        "http://127.0.0.1:38660",
        "--token",
        "secret",
      ],
      startup_timeout_sec: 20,
      tool_timeout_sec: 120,
      default_tools_approval_mode: "prompt",
    });
  });
});

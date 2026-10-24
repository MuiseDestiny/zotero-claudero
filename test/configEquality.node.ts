import { assert } from "chai";
import { canonicalJson, sameJsonValue } from "../src/shared/canonicalJson";
import { PersistentQueryManager } from "../src/helper/runtime/PersistentQueryManager";
import { CodexPersistentQueryManager } from "../src/helper/runtime/CodexPersistentQueryManager";
import { DeepSeekPersistentQueryManager } from "../src/helper/runtime/DeepSeekPersistentQueryManager";
import { PermissionManager } from "../src/helper/runtime/PermissionManager";

describe("semantic runtime configuration", function () {
  const environment = { FIRST: "one", SECOND: "two" };
  const reorderedEnvironment = { SECOND: "two", FIRST: "one" };
  const servers = {
    files: { command: "fixture", args: ["first", "second"], env: environment },
    remote: { url: "https://example.test/mcp", headers: { B: "2", A: "1" } },
  };
  const reorderedServers = {
    remote: { headers: { A: "1", B: "2" }, url: "https://example.test/mcp" },
    files: {
      env: reorderedEnvironment,
      args: ["first", "second"],
      command: "fixture",
    },
  };

  it("ignores nested object-key order but preserves JSON value and array semantics", function () {
    assert.isTrue(sameJsonValue(servers, reorderedServers));
    assert.isTrue(sameJsonValue({}, { optional: undefined }));
    assert.isFalse(sameJsonValue(["a", "b"], ["b", "a"]));
    assert.isFalse(sameJsonValue({ value: 1 }, { value: "1" }));
    assert.isFalse(sameJsonValue({ value: null }, {}));
    assert.equal(canonicalJson(undefined), "undefined");
    assert.isTrue(
      sameJsonValue(
        JSON.parse('{"__proto__":{"safe":true},"b":2}'),
        JSON.parse('{"b":2,"__proto__":{"safe":true}}'),
      ),
    );
  });

  it("does not restart Claude for reordered MCP maps or environments", function () {
    const manager = new PersistentQueryManager(new PermissionManager());
    Object.assign(manager, {
      state: { options: {}, environment, mcpServers: servers },
    });
    assert.isFalse(
      manager.requiresRestart({
        environment: reorderedEnvironment,
        mcpServers: reorderedServers,
      }),
    );
    assert.isTrue(
      manager.requiresRestart({
        mcpServers: {
          ...servers,
          files: { ...servers.files, args: ["second", "first"] },
        },
      }),
    );
    assert.isTrue(
      manager.requiresRestart({
        environment: { ...environment, FIRST: "changed" },
      }),
    );
  });

  it("keeps Codex sessions on key reordering while detecting real changes", function () {
    const manager = new CodexPersistentQueryManager(new PermissionManager());
    Object.assign(manager, {
      config: { environment, mcpServers: servers },
      threadId: "thread-1",
      sessionFilePath: "/fixture/session.jsonl",
      pendingFork: { threadId: "source", resumeAt: "turn-1" },
    });
    const providerState = {
      forkSource: { resumeAt: "turn-1", threadId: "source" },
      sessionFilePath: "/fixture/session.jsonl",
      threadId: "thread-1",
    };
    assert.isFalse(
      manager.requiresRestart({
        environment: reorderedEnvironment,
        mcpServers: reorderedServers,
        providerState,
        model: "live-update-model",
        effort: "high",
      }),
    );
    assert.isTrue(
      manager.requiresRestart({
        environment: { ...environment, FIRST: "changed" },
      }),
    );
    assert.isTrue(
      manager.requiresRestart({
        providerState: { ...providerState, threadId: "thread-2" },
      }),
    );
    assert.isTrue(
      manager.requiresRestart({
        mcpServers: { remote: { url: "https://other.test/mcp" } },
      }),
    );
  });

  it("does not restart DeepSeek for environment key order alone", function () {
    const manager = new DeepSeekPersistentQueryManager(new PermissionManager());
    Object.assign(manager, { config: { environment } });
    assert.isFalse(
      manager.requiresRestart({ environment: reorderedEnvironment }),
    );
    assert.isTrue(
      manager.requiresRestart({
        environment: { ...environment, SECOND: "changed" },
      }),
    );
  });

  it("preserves remembered approvals only in the same semantic scope", function () {
    const manager = new PermissionManager();
    manager.setScope(canonicalJson({ provider: "codex", environment }));
    manager.remember("fixture", { first: 1, nested: { a: 1, b: 2 } });
    manager.setScope(
      canonicalJson({ environment: reorderedEnvironment, provider: "codex" }),
    );
    assert.isTrue(
      manager.isRemembered("fixture", { nested: { b: 2, a: 1 }, first: 1 }),
    );
    manager.setScope(
      canonicalJson({ provider: "codex", environment: { FIRST: "changed" } }),
    );
    assert.isFalse(
      manager.isRemembered("fixture", { first: 1, nested: { a: 1, b: 2 } }),
    );
  });
});

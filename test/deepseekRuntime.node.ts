import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assert } from "chai";
import {
  buildDeepSeekLaunchSpec,
  DeepSeekPersistentQueryManager,
} from "../src/helper/runtime/DeepSeekPersistentQueryManager";
import { PermissionManager } from "../src/helper/runtime/PermissionManager";
import { buildPromptWithConversationHistory } from "../src/shared/promptHistory";

describe("DeepSeek Harness runtime", function () {
  this.timeout(10_000);

  it("runs the official headless command shape and emits the final answer", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "claudero-dsh-"));
    const script = path.join(root, "mock-dsh.mjs");
    const canonicalRoot = await realpath(root);
    const realRoot =
      process.platform === "win32"
        ? canonicalRoot.toLowerCase()
        : canonicalRoot;
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        "import { realpathSync } from 'node:fs';",
        "const canonicalCwd = realpathSync.native(process.cwd());",
        "const cwd = process.platform === 'win32' ? canonicalCwd.toLowerCase() : canonicalCwd;",
        "if (process.argv.slice(2, 4).join(' ') !== '--profile headless') process.exit(3);",
        "if (cwd !== process.env.EXPECTED_CWD) process.exit(4);",
        "process.stdout.write(JSON.stringify({ model: process.env.DSH_MODEL || '', dshHome: process.env.DSH_HOME || '', cwd, prompt: process.argv.at(-1) || '' }));",
      ].join("\n"),
    );
    const manager = new DeepSeekPersistentQueryManager(new PermissionManager());
    try {
      await manager.initialize({
        workspacePath: root,
        deepseekPath: script,
        environment: { EXPECTED_CWD: realRoot },
        model: "deepseek-v4-flash",
      });
      assert.deepEqual(await manager.listModels(), [
        {
          value: "deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          isDefault: true,
        },
        {
          value: "deepseek-v4-pro",
          label: "DeepSeek V4 Pro",
        },
      ]);
      const events = [];
      for await (const event of manager.sendMessageEvents("hello")) {
        events.push(event);
      }
      assert.equal(events[0]?.type, "session");
      assert.equal(
        events.find((event) => event.type === "text")?.text,
        JSON.stringify({
          model: "deepseek-v4-flash",
          dshHome: process.env.DSH_HOME || "",
          cwd: realRoot,
          prompt: "hello",
        }),
      );
      assert.equal(events.at(-1)?.type, "usage");
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces a non-zero headless exit with stderr", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "claudero-dsh-"));
    const script = path.join(root, "mock-dsh-fail.mjs");
    await writeFile(
      script,
      "#!/usr/bin/env node\nprocess.stderr.write('missing DEEPSEEK_API_KEY'); process.exit(7);",
    );
    const manager = new DeepSeekPersistentQueryManager(new PermissionManager());
    try {
      await manager.initialize({
        workspacePath: root,
        deepseekPath: script,
        environment: {},
      });
      const run = (async () => {
        for await (const _event of manager.sendMessageEvents("hello")) {
          // Drain the stream.
        }
      })();
      let error: unknown;
      try {
        await run;
      } catch (caught) {
        error = caught;
      }
      assert.match(String(error), /missing DEEPSEEK_API_KEY/);
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears busy state when launch path validation fails", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "claudero-dsh-"));
    const manager = new DeepSeekPersistentQueryManager(new PermissionManager());
    try {
      await manager.initialize({
        workspacePath: root,
        deepseekPath: path.join(root, "missing-entrypoint.mjs"),
        environment: {},
      });
      let error: unknown;
      try {
        for await (const _event of manager.sendMessageEvents("hello")) {
          // Drain the stream.
        }
      } catch (caught) {
        error = caught;
      }
      assert.match(String(error), /must resolve to its JavaScript entrypoint/);
      assert.isFalse(manager.isBusy);
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves an npm Windows shim without a shell and transports long prompts through stdin", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "claudero-dsh-"));
    const binDir = path.join(root, "node_modules", ".bin");
    const packageBinDir = path.join(
      root,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
    );
    const shim = path.join(binDir, "dsh.cmd");
    const entrypoint = path.join(packageBinDir, "bin.js");
    await mkdir(binDir, { recursive: true });
    await mkdir(packageBinDir, { recursive: true });
    await writeFile(shim, "@echo off\r\nnode fake-entrypoint %*\r\n");
    await writeFile(
      entrypoint,
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));",
    );

    const prompt = `${"very long prompt ".repeat(5_000)}\n& | > < ^ % ! " ' 结束`;
    const launch = buildDeepSeekLaunchSpec(shim, process.execPath);
    assert.isFalse(launch.shell);
    assert.equal(launch.command, process.execPath);
    assert.notInclude(launch.args, prompt);
    assert.equal(launch.args.at(-1), entrypoint);

    const manager = new DeepSeekPersistentQueryManager(new PermissionManager());
    try {
      await manager.initialize({
        workspacePath: root,
        deepseekPath: shim,
        nodePath: process.execPath,
        environment: {},
      });
      let received: string[] | undefined;
      for await (const event of manager.sendMessageEvents(prompt)) {
        if (event.type === "text") {
          received = (JSON.parse(event.text) as { argv: string[] }).argv;
        }
      }
      assert.deepEqual(received, ["--profile", "headless", prompt]);
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("receives the replayed conversation on a second independent process", async function () {
    const root = await mkdtemp(path.join(os.tmpdir(), "claudero-dsh-"));
    const script = path.join(root, "mock-dsh-history.mjs");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ prompt: process.argv.at(-1) || '' }));",
      ].join("\n"),
    );
    const manager = new DeepSeekPersistentQueryManager(new PermissionManager());
    const collectPrompt = async (prompt: string): Promise<string> => {
      for await (const event of manager.sendMessageEvents(prompt)) {
        if (event.type === "text") {
          return (JSON.parse(event.text) as { prompt: string }).prompt;
        }
      }
      throw new Error("mock DeepSeek Harness did not return a prompt");
    };

    try {
      await manager.initialize({
        workspacePath: root,
        deepseekPath: script,
        environment: {},
      });
      const firstPrompt = buildPromptWithConversationHistory(
        "我的名字是 Alice",
        [],
      );
      assert.equal(await collectPrompt(firstPrompt), "我的名字是 Alice");

      const secondPrompt = buildPromptWithConversationHistory("我叫什么", [
        { role: "user", text: "我的名字是 Alice", ts: 1 },
        {
          role: "assistant",
          text: "好的，我记住了你的名字是 Alice。",
          ts: 2,
        },
      ]);
      const received = await collectPrompt(secondPrompt);
      assert.include(received, "我的名字是 Alice");
      assert.include(received, "好的，我记住了你的名字是 Alice。");
      assert.include(received, "<current_user_request>\n我叫什么\n");
    } finally {
      manager.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds replayed history while retaining the latest request", async function () {
    const turns = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${index}: ${"long context ".repeat(2_000)}`,
      ts: index,
    }));
    const prompt = buildPromptWithConversationHistory("latest", turns);
    assert.include(prompt, "<current_user_request>\nlatest\n");
    assert.isAtMost(prompt.length, 50_000);
    assert.include(prompt, "29:");
    assert.notInclude(prompt, "0: long context");
  });
});

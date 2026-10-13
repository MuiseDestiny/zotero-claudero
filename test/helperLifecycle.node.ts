import { assert } from "chai";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire as createTestRequire } from "node:module";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";

describe("helper process lifecycle", function () {
  this.timeout(20_000);
  let root: string, bundle: string;
  const children = new Set<ChildProcess>();
  const token = "fixture-helper-lifetime-0123456789";
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    description: string,
    timeout = 8_000,
  ) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${description}`);
  };
  const track = (child: ChildProcess) => {
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };

  before(async function () {
    root = await mkdtemp(path.join(os.tmpdir(), "claudero-helper-lifetime-"));
    bundle = path.join(root, "helper.mjs");
    const { build } = createTestRequire(
      path.join(process.cwd(), "package.json"),
    )("esbuild");
    await build({
      entryPoints: ["src/helper/claudero-helper.ts"],
      outfile: bundle,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
      logLevel: "silent",
    });
  });

  afterEach(async function () {
    for (const child of children) child.kill("SIGKILL");
    await waitFor(() => children.size === 0, "fixture process cleanup");
  });
  after(async function () {
    await rm(root, { recursive: true, force: true });
  });

  async function start(parentPid = process.pid) {
    const portServer = createServer();
    await new Promise<void>((resolve) =>
      portServer.listen(0, "127.0.0.1", resolve),
    );
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const child = track(
      spawn(
        process.execPath,
        [
          bundle,
          "--server",
          "--port",
          String(port),
          "--token",
          token,
          "--parent-pid",
          String(parentPid),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(output);
      return output.includes("Claudero helper listening");
    }, "helper listening");
    return { child, url: `http://127.0.0.1:${port}` };
  }

  it("exits when its owning process disappears", async function () {
    const parent = track(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      }),
    );
    const helper = await start(parent.pid!);
    assert.isNull(helper.child.exitCode);
    parent.kill("SIGTERM");
    await waitFor(
      () => helper.child.exitCode !== null,
      "helper exit after parent death",
    );
    assert.equal(helper.child.exitCode, 0);
  });

  it("terminates auxiliary subprocesses on HTTP cancellation and graceful helper shutdown", async function () {
    const helper = await start();
    const script = path.join(root, "fixture-dsh.mjs");
    await writeFile(
      script,
      'import { writeFileSync } from "node:fs"; writeFileSync(process.env.FIXTURE_PID, String(process.pid)); setInterval(() => {}, 1000);',
    );
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    for (const mode of ["cancel", "shutdown"] as const) {
      const pidFile = path.join(root, `auxiliary-${mode}.pid`);
      const controller = new AbortController();
      let runtimePid: number | undefined;
      const result = fetch(`${helper.url}/aux-query`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: "deepseek",
          workspacePath: root,
          deepseekPath: script,
          prompt: "fixture",
          environment: {
            FIXTURE_PID: pidFile,
            DSH_NODE_PATH: process.execPath,
          },
        }),
        signal: controller.signal,
      })
        .then(async (response) => ({
          status: response.status,
          text: await response.text(),
        }))
        .catch((error) => ({ status: 0, text: String(error) }));
      try {
        await waitFor(
          () =>
            access(pidFile).then(
              () => true,
              () => false,
            ),
          "auxiliary process start",
        );
        runtimePid = Number(await readFile(pidFile, "utf8"));
        assert.isTrue(alive(runtimePid));
        if (mode === "cancel") controller.abort();
        else {
          const response = await fetch(`${helper.url}/shutdown`, {
            method: "POST",
            headers,
          });
          assert.equal(response.status, 200);
          await response.text();
        }
        await waitFor(
          () => !alive(runtimePid!),
          `auxiliary process exit on ${mode}`,
        );
        if (mode === "shutdown")
          await waitFor(
            () => helper.child.exitCode !== null,
            "graceful helper exit",
          );
      } finally {
        controller.abort();
        const response = await result;
        if (runtimePid === undefined)
          assert.fail(
            `Auxiliary request failed before startup: ${response.status} ${response.text}`,
          );
        if (alive(runtimePid!)) process.kill(runtimePid!, "SIGKILL");
      }
    }
  });
});

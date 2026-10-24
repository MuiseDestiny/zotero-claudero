import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import { buildStandaloneHelper } from "./build-standalone-helper.mjs";
import {
  helperBunVersion,
  helperCompileTargets,
  shouldBundleStandaloneHelper,
  standaloneCompilerPath,
  standaloneHelperTargets,
  verifyStandaloneTargetCoverage,
} from "./helper-build-config.mjs";

const allTargets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

test("ordinary production packages bundle all supported targets", () => {
  assert.equal(shouldBundleStandaloneHelper({ NODE_ENV: "production" }), true);
  assert.equal(shouldBundleStandaloneHelper({}), true);
  assert.deepEqual(standaloneHelperTargets({}), allTargets);
  assert.deepEqual(
    standaloneHelperTargets({ CLAUDERO_HELPER_TARGETS: "  " }),
    allTargets,
  );
  assert.equal(helperCompileTargets["linux-x64"], "bun-linux-x64-baseline");
  assert.equal(helperCompileTargets["win32-x64"], "bun-windows-x64-baseline");
});

test("development and browser tests do not compile native runtimes by default", () => {
  for (const NODE_ENV of ["development", "test"])
    assert.equal(shouldBundleStandaloneHelper({ NODE_ENV }), false);
  assert.equal(
    shouldBundleStandaloneHelper({
      NODE_ENV: "test",
      CLAUDERO_STANDALONE_HELPER: "1",
    }),
    true,
  );
});

test("portable packages require an explicit opt-out", () => {
  assert.equal(
    shouldBundleStandaloneHelper({
      NODE_ENV: "production",
      CLAUDERO_STANDALONE_HELPER: "0",
    }),
    false,
  );
  for (const enabled of ["", "false", "true", "yes", "2"])
    assert.throws(
      () =>
        shouldBundleStandaloneHelper({ CLAUDERO_STANDALONE_HELPER: enabled }),
      /must be 0 or 1/,
    );
});

test("targeted packages and host-only smoke tests stay explicit", () => {
  assert.deepEqual(
    standaloneHelperTargets({ CLAUDERO_HELPER_TARGETS: "host" }, "win32-arm64"),
    ["win32-arm64"],
  );
  assert.deepEqual(
    standaloneHelperTargets({
      CLAUDERO_HELPER_TARGETS: " darwin-arm64, darwin-x64 ",
    }),
    ["darwin-arm64", "darwin-x64"],
  );
  for (const target of [
    "linux-ia32",
    "host,linux-x64",
    ",",
    "linux-x64,",
    "linux-x64,linux-x64",
  ])
    assert.throws(
      () => standaloneHelperTargets({ CLAUDERO_HELPER_TARGETS: target }),
      /Unsupported or duplicate/,
    );
  assert.throws(
    () =>
      standaloneHelperTargets({ CLAUDERO_HELPER_TARGETS: "host" }, "aix-ppc64"),
    /Unsupported or duplicate/,
  );
});

test("package checks reject missing, extra, duplicate, or host-only coverage", () => {
  verifyStandaloneTargetCoverage([...allTargets].reverse(), allTargets);
  verifyStandaloneTargetCoverage(["darwin-arm64"], ["darwin-arm64"]);
  for (const actual of [
    [],
    ["darwin-arm64"],
    [...allTargets, "linux-ia32"],
    [...allTargets.slice(1), "darwin-x64"],
  ])
    assert.throws(
      () => verifyStandaloneTargetCoverage(actual, allTargets),
      /targets must match this build/,
    );
});

test("the compiler is pinned and resolved locally without a global Bun install", async () => {
  assert.equal(
    standaloneCompilerPath({ CLAUDERO_BUN_PATH: "/isolated tools/bun" }),
    "/isolated tools/bun",
  );
  const executable = standaloneCompilerPath({});
  const compiler = JSON.parse(
    await readFile(
      new URL("../node_modules/bun/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(compiler.version, helperBunVersion);
  assert.equal(
    execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim(),
    helperBunVersion,
  );
});

test("build hooks skip compilation only in explicit portable or development/test modes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "claudero-build-mode-"),
  );
  try {
    for (const environment of [
      { NODE_ENV: "production", CLAUDERO_STANDALONE_HELPER: "0" },
      { NODE_ENV: "development" },
      { NODE_ENV: "test" },
    ])
      await buildStandaloneHelper(directory, {
        ...environment,
        CLAUDERO_BUN_PATH: path.join(directory, "missing-compiler"),
      });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing and unpinned compilers fail a standard build instead of silently omitting runtimes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claudero-compiler-"));
  try {
    await assert.rejects(
      buildStandaloneHelper(directory, {
        NODE_ENV: "production",
        CLAUDERO_BUN_PATH: path.join(directory, "missing-compiler"),
      }),
      /Cannot run the Helper compiler/,
    );
    await assert.rejects(
      buildStandaloneHelper(directory, {
        NODE_ENV: "production",
        CLAUDERO_BUN_PATH: process.execPath,
      }),
      /Standalone Helper requires Bun 1\.4\.2/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

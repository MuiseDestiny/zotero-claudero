#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const entries = process.argv.slice(2);
if (entries.length === 0) {
  console.error("Usage: node scripts/run-node-tests.mjs <test.ts> [...]");
  process.exit(2);
}

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "claudero-node-tests-"));

try {
  const outputFiles = [];
  for (const [index, entry] of entries.entries()) {
    const outputFile = path.join(outputDir, `test-${index}.mjs`);
    await build({
      entryPoints: [path.resolve(root, entry)],
      outfile: outputFile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      sourcemap: "inline",
      logLevel: "warning",
    });
    outputFiles.push(outputFile);
  }

  const mochaPath = path.resolve(root, "node_modules/mocha/bin/mocha.js");
  const child = spawn(process.execPath, [mochaPath, ...outputFiles], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    shell: false,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

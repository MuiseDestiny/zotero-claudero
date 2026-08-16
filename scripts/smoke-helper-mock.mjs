#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const fixtureDir = await mkdtemp(
  path.join(os.tmpdir(), "claudero-helper-mock-"),
);
const deepseekEntrypoint = path.join(fixtureDir, "mock-dsh.mjs");

try {
  await writeFile(
    deepseekEntrypoint,
    [
      'const prompt = process.argv.at(-1) || "";',
      "const match = prompt.match(/Reply with exactly this token and nothing else:\\s*([A-Z0-9_]+)/);",
      'process.stdout.write(match?.[1] || "MOCK_DSH_OK");',
    ].join("\n"),
    "utf8",
  );

  const smokeScript = path.join(
    root,
    "scripts",
    "smoke-helper-communication.mjs",
  );
  const child = spawn(
    process.execPath,
    [
      smokeScript,
      "--full",
      "--providers",
      "deepseek",
      "--deepseek-path",
      deepseekEntrypoint,
    ],
    {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    },
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(fixtureDir, { recursive: true, force: true });
}

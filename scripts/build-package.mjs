import { spawn } from "node:child_process";
import process from "node:process";

const [mode, ...extra] = process.argv.slice(2);
if (!["--standalone", "--portable"].includes(mode) || extra.length)
  throw new Error("Use --standalone or --portable to select a package mode");

const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "build"],
  {
    env: {
      ...process.env,
      CLAUDERO_STANDALONE_HELPER: mode === "--standalone" ? "1" : "0",
    },
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});

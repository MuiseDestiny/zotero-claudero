import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "build"],
  {
    env: { ...process.env, CLAUDERO_STANDALONE_HELPER: "1" },
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

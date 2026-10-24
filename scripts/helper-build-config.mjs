import { createRequire } from "node:module";
import process from "node:process";

export const helperBunVersion = "1.4.2";
export const helperCompileTargets = Object.freeze({
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "win32-arm64": "bun-windows-arm64",
  "win32-x64": "bun-windows-x64-baseline",
});

export function standaloneHelperTargets(
  environment = process.env,
  host = `${process.platform}-${process.arch}`,
) {
  const configured = environment.CLAUDERO_HELPER_TARGETS?.trim();
  const selected = !configured
    ? Object.keys(helperCompileTargets)
    : configured === "host"
      ? [host]
      : configured.split(",").map((target) => target.trim());
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((target) => !Object.hasOwn(helperCompileTargets, target))
  )
    throw new Error("Unsupported or duplicate standalone Helper targets");
  return selected;
}

export function shouldBundleStandaloneHelper(environment = process.env) {
  const enabled = environment.CLAUDERO_STANDALONE_HELPER;
  if (enabled !== undefined && enabled !== "0" && enabled !== "1")
    throw new Error("CLAUDERO_STANDALONE_HELPER must be 0 or 1");
  if (enabled !== undefined) return enabled === "1";
  return !environment.NODE_ENV || environment.NODE_ENV === "production";
}

export function standaloneCompilerPath(environment = process.env) {
  if (environment.CLAUDERO_BUN_PATH?.trim())
    return environment.CLAUDERO_BUN_PATH.trim();
  try {
    return createRequire(import.meta.url).resolve("bun/bin/bun.exe");
  } catch {
    throw new Error(
      `Run npm ci to install the pinned Helper compiler, or set CLAUDERO_BUN_PATH to Bun ${helperBunVersion}.`,
    );
  }
}

export function verifyStandaloneTargetCoverage(actual, expected) {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((target) => !actual.includes(target))
  )
    throw new Error(
      `Standalone Helper targets must match this build: ${expected.join(", ")}`,
    );
}

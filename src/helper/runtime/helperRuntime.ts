import process from "node:process";

declare const __CLAUDERO_STANDALONE__: boolean;

export function isStandaloneHelper(): boolean {
  return (
    typeof __CLAUDERO_STANDALONE__ !== "undefined" && __CLAUDERO_STANDALONE__
  );
}

export function helperRuntimeInfo() {
  return {
    kind: isStandaloneHelper() ? "standalone" : "script",
    engine: process.versions.bun ? "bun" : "node",
    version: process.versions.bun || process.versions.node,
  };
}

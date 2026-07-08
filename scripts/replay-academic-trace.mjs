#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/replay-academic-trace.mjs --file academic-trace.json",
    "",
    "Options:",
    "  --file <path>  Read a saved Claudero Academic Trace JSON artifact",
    "  --json         Print the parsed trace JSON",
    "  --markdown     Print the trace markdown section when present",
  ].join("\n");
}

async function loadTrace(args) {
  if (typeof args.file !== "string") {
    throw new Error("--file is required.");
  }
  const trace = JSON.parse(await readFile(args.file, "utf8"));
  if (trace?.protocol !== "claudero.academic-trace") {
    throw new Error("File is not a Claudero Academic Trace artifact.");
  }
  return trace;
}

function printSummary(trace) {
  const summary = trace.trustReport?.summary || {};
  console.log(`traceId: ${trace.traceId || "-"}`);
  console.log(`createdAt: ${trace.createdAt || "-"}`);
  console.log(`protocol: ${trace.protocol || "-"}@${trace.version || "-"}`);
  console.log(`itemId: ${trace.source?.itemId || "-"}`);
  console.log(`attachmentId: ${trace.source?.attachmentId || "-"}`);
  console.log(`claims: ${summary.totalClaims ?? 0}`);
  console.log(`verified: ${summary.verified ?? 0}`);
  console.log(`weak: ${summary.weak ?? 0}`);
  console.log(`unverified: ${summary.unverified ?? 0}`);
  console.log(
    `visualInspectionRequired: ${summary.visualInspectionRequired ?? 0}`,
  );

  const failures = trace.failures || [];
  if (failures.length) {
    console.log("");
    console.log("failures:");
    for (const failure of failures) {
      console.log(
        `- ${failure.status || "unknown"}: ${failure.claim || ""} -> ${
          failure.fix || ""
        }`,
      );
    }
  }

  const replayPlan = trace.replayPlan || [];
  if (replayPlan.length) {
    console.log("");
    console.log("replayPlan:");
    for (const [index, step] of replayPlan.entries()) {
      console.log(
        `${index + 1}. ${step.tool || "-"} ${JSON.stringify(
          step.arguments || {},
        )}`,
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  const trace = await loadTrace(args);
  if (args.json) {
    console.log(JSON.stringify(trace, null, 2));
    return;
  }
  if (args.markdown) {
    console.log(trace.markdown || "");
    return;
  }
  printSummary(trace);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
});

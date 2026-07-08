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
    "  node scripts/replay-agent-trace.mjs --file trace.json",
    "  node scripts/replay-agent-trace.mjs --port 38660 --token-file /path/to/.token",
    "",
    "Options:",
    "  --file <path>        Read a saved AgentEventTrace JSON file",
    "  --url <url>          Read trace JSON from a custom helper URL",
    "  --port <port>        Read http://127.0.0.1:<port>/trace/latest",
    "  --token <token>      Bearer token for helper trace requests",
    "  --token-file <path>  File containing the helper bearer token",
    "  --json              Print the parsed trace JSON",
  ].join("\n");
}

async function readToken(args) {
  if (typeof args.token === "string") return args.token.trim();
  if (typeof args["token-file"] === "string") {
    return (await readFile(args["token-file"], "utf8")).trim();
  }
  return "";
}

async function loadTrace(args) {
  if (typeof args.file === "string") {
    return JSON.parse(await readFile(args.file, "utf8"));
  }

  const url =
    typeof args.url === "string"
      ? args.url
      : `http://127.0.0.1:${Number(args.port || 38660)}/trace/latest`;
  const token = await readToken(args);
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 204) {
    throw new Error("Helper has no trace yet.");
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function eventCounts(trace) {
  const counts = {};
  for (const envelope of trace.events || []) {
    const type = envelope?.event?.type || "unknown";
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function replayText(trace) {
  let text = "";
  for (const envelope of trace.events || []) {
    const event = envelope?.event;
    if (!event) continue;
    if (event.type === "text_snapshot") text = String(event.text || "");
    else if (event.type === "text" || event.type === "text_delta") {
      text += String(event.text || "");
    }
  }
  return text;
}

function latestError(trace) {
  const errors = (trace.events || [])
    .map((envelope) => envelope?.event)
    .filter((event) => event?.type === "error")
    .map((event) => event.error)
    .filter(Boolean);
  return errors.at(-1) || "";
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

  const counts = eventCounts(trace);
  const replay = replayText(trace).trim();
  const source = trace.source || {};
  console.log(`traceId: ${trace.traceId || "-"}`);
  console.log(`protocol: ${trace.protocol || "-"}@${trace.version || "-"}`);
  console.log(`source: ${source.provider || "-"} ${source.runtime || "-"}`);
  console.log(`events: ${(trace.events || []).length}`);
  console.log(`counts: ${JSON.stringify(counts)}`);
  const error = latestError(trace);
  if (error) console.log(`latestError: ${error}`);
  console.log("");
  console.log(replay || "(no replayable text)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage());
  process.exit(1);
});

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tools = [
  "build_academic_trace",
  "build_trust_report",
  "expand_evidence_range",
  "get_evidence_pack",
  "get_numbered_evidence_pack",
  "inspect_figure_table_page",
  "locate_quote",
  "verify_citations",
];
const checks = [
  [
    "src/shared/agentEvidencePolicy.ts",
    [
      "Claudero Default Agent Evidence Policy",
      "get_evidence_pack",
      "locate_quote",
      "verify_citations",
      "build_trust_report",
      "build_academic_trace",
      "inspect_figure_table_page",
      "includePageImages=false",
      "Never invent page numbers",
    ],
  ],
  [
    "src/modules/evidence.ts",
    [
      "EvidencePack",
      "EvidenceLocator",
      "EvidencePageImage",
      "EvidenceTrustReport",
      "AcademicTraceArtifact",
      "FigureTablePageInspection",
      "CitationVisualInspectionHint",
      "buildAcademicTrace",
      "buildEvidenceTrustReport",
      "evidenceUri",
      "imageInput",
      "pageImage",
      "visualInspection",
      "includePageImages",
      "inspectFigureTablePage",
      "verifyCitationClaims",
    ],
  ],
  ["src/modules/zoteroEndpoint.ts", tools],
  [
    "src/modules/zoteroContext.ts",
    ["AGENT_EVIDENCE_POLICY", "agentEvidencePolicy"],
  ],
  ["src/helper/runtime/ZoteroMcpServer.ts", tools],
  [
    "src/helper/runtime/ZoteroMcpServer.ts",
    ["AGENT_EVIDENCE_POLICY_MCP_INSTRUCTIONS"],
  ],
  ["src/helper/runtime/ZoteroMcpBridge.ts", tools],
  [
    "src/helper/runtime/ZoteroMcpBridge.ts",
    ["AGENT_EVIDENCE_POLICY_MCP_INSTRUCTIONS"],
  ],
  [
    "src/modules/academicSkills.ts",
    ["verify-citations", "Evidence Trust Report", "Academic Trace", ...tools],
  ],
  [
    "src/helper/runtime/ZoteroMcpServer.ts",
    ['type: "image"', "toolContentFromOutput", "inspect_figure_table_page"],
  ],
  [
    "src/helper/runtime/ZoteroMcpBridge.ts",
    ['type: "image"', "toolContentFromOutput", "inspect_figure_table_page"],
  ],
  [
    "src/modules/messageRenderer.ts",
    ["claudero-evidence-chip", "claudero-evidence:", "zotero://"],
  ],
  ["addon/content/zoteroPane.css", ["claudero-evidence-chip"]],
];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const [relativePath, needles] of checks) {
  const source = read(relativePath);
  for (const needle of needles) {
    assert(
      source.includes(needle),
      `${relativePath} is missing evidence contract marker: ${needle}`,
    );
  }
}

const permissionManager = read("src/helper/runtime/PermissionManager.ts");
assert(
  !permissionManager.includes("isReadOnlyZoteroCall") &&
    !permissionManager.includes("READ_ONLY_ZOTERO_ACTIONS"),
  "PermissionManager must not auto-allow compound Bash commands based on embedded Zotero action text",
);
const protocol = read("src/shared/helperProtocol.ts");
const version = Number(
  protocol.match(/CLAUDERO_HELPER_VERSION\s*=\s*(\d+)/)?.[1] || 0,
);
assert(version >= 23, `HELPER_VERSION should be >= 23, got ${version}`);

process.stdout.write("[evidence] PASS contract smoke\n");

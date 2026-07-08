export const AGENT_EVIDENCE_POLICY_TITLE =
  "Claudero Default Agent Evidence Policy";

export const AGENT_EVIDENCE_POLICY_LINES = [
  "Use this evidence policy by default for Zotero academic work; the user should not need to ask for it explicitly.",
  "Treat the lightweight Zotero context as a hint, not as proof. If the answer makes factual claims about selected papers, PDFs, annotations, figures, tables, methods, results, limitations, page numbers, or citations, ground the answer in Zotero evidence.",
  "Start cheap: use the included context first, then get_current_context only when the target is stale or unclear.",
  "Zotero MCP tools may appear as plain names such as get_evidence_pack or provider-prefixed names such as mcp__zotero__get_evidence_pack; treat both forms as the same Zotero evidence tools.",
  "Use get_evidence_pack for paper-specific claims that go beyond title/metadata/selected text. Keep includePageImages=false by default.",
  "Use locate_quote before presenting verbatim quotes or page-specific quoted wording. If the quote cannot be located, label it as a paraphrase or unsupported.",
  "Use verify_citations for claim-heavy answers, citation audits, draft review, literature comparison, generated notes, and any answer that maps claims to sources.",
  "Use build_trust_report before finalizing claim-heavy academic output. Mention weak or unsupported claims instead of smoothing them over.",
  "Use build_academic_trace only when the user asks for reproducibility/auditability, when creating durable academic artifacts such as notes or review text, or when the answer contains many claim-to-source mappings.",
  "Use inspect_figure_table_page only for visual claims about a figure/table/page, caption verification, or when text evidence says a visual must be inspected. Do not attach page images for ordinary text questions.",
  "Never invent page numbers, direct quotes, figure/table references, claim-source mappings, DOI/reference facts, or Zotero item metadata. If evidence is unavailable, say what is missing and what tool/action would resolve it.",
  "Prefer concise evidence locations in final prose: evidence id, page/pageNumber, openUri, or Zotero evidence chip when available.",
];

export const AGENT_EVIDENCE_POLICY = [
  `<agent_evidence_policy title="${AGENT_EVIDENCE_POLICY_TITLE}">`,
  ...AGENT_EVIDENCE_POLICY_LINES.map((line, index) => `${index + 1}. ${line}`),
  "</agent_evidence_policy>",
].join("\n");

export const AGENT_EVIDENCE_POLICY_MCP_INSTRUCTIONS =
  AGENT_EVIDENCE_POLICY_LINES.join("\n");

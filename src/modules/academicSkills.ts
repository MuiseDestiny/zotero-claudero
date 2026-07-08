import { getPref, setPref } from "../utils/prefs";
import type { ClauderoSelectionContext } from "./zoteroContext";

export type AcademicSkillCategory =
  | "reading"
  | "extraction"
  | "comparison"
  | "writing"
  | "verification";

export type AcademicContextNeed =
  | "none"
  | "optional"
  | "preferred"
  | "required";

export interface AcademicSkillContextRequirements {
  selectedItems?: "none" | "one" | "many" | "optional";
  pdfText?: AcademicContextNeed;
  annotations?: AcademicContextNeed;
  notes?: AcademicContextNeed;
}

export interface AcademicSkillToolPolicy {
  zoteroMcp: boolean;
  allowZoteroRead: boolean;
  allowZoteroWrite: boolean;
  allowWebSearch: boolean;
  allowScripts: boolean;
}

export interface AcademicSkillOutputContract {
  format: "markdown" | "markdown-table" | "json" | "zotero-note";
  target: "chat" | "zotero-note-preview" | "zotero-note";
  language?: "auto" | "zh-CN" | "en-US";
  sections?: string[];
  columns?: string[];
}

export interface AcademicSkillPromptTemplate {
  system: string;
  task: string;
}

export interface AcademicSkillSource {
  type: "builtin" | "clauskill" | "agent-skill" | "mcp-prompt" | "markdown";
  url?: string;
  importedAt?: number;
  sourceHash?: string;
}

export interface AcademicSkill {
  id: string;
  title: string;
  description: string;
  routingGuidance: string;
  category: AcademicSkillCategory;
  builtinVersion?: number;
  intentExamples: string[];
  negativeExamples?: string[];
  keywords: string[];
  contextRequirements: AcademicSkillContextRequirements;
  toolPolicy: AcademicSkillToolPolicy;
  outputContract: AcademicSkillOutputContract;
  promptTemplate: AcademicSkillPromptTemplate;
  source?: AcademicSkillSource;
}

export interface StoredAcademicSkill {
  id: string;
  enabled: boolean;
  basedOnBuiltinHash?: string;
  skill: AcademicSkill;
  updatedAt: number;
  source?: AcademicSkillSource;
}

export interface AcademicSkillStore {
  version: 1;
  skills: Record<string, StoredAcademicSkill>;
}

export type AcademicSkillStatus =
  | "builtin"
  | "custom"
  | "modified"
  | "disabled"
  | "update-available";

export interface AcademicSkillRecord {
  id: string;
  skill: AcademicSkill;
  builtin?: AcademicSkill;
  stored?: StoredAcademicSkill;
  enabled: boolean;
  builtinHash?: string;
  effectiveHash: string;
  status: AcademicSkillStatus;
  updateAvailable: boolean;
  modified: boolean;
}

export interface AcademicSkillMatch {
  skill: AcademicSkill;
  confidence: number;
  matchedTerms: string[];
  reason: string;
}

export interface AcademicSkillContextStatus {
  missing: string[];
  warnings: string[];
}

const DEFAULT_TOOL_POLICY: AcademicSkillToolPolicy = {
  zoteroMcp: true,
  allowZoteroRead: true,
  allowZoteroWrite: false,
  allowWebSearch: false,
  allowScripts: false,
};

export const BUILTIN_ACADEMIC_SKILLS: AcademicSkill[] = [
  {
    id: "summarize-paper",
    title: "Summarize Paper",
    description:
      "Summarizes the selected paper with research question, contribution, method, findings, limitations, and useful follow-up questions.",
    routingGuidance:
      "Use when the user asks to summarize, digest, outline, or understand one selected paper or the current PDF.",
    category: "reading",
    builtinVersion: 2,
    intentExamples: [
      "summarize this paper",
      "帮我总结这篇论文",
      "概括当前 PDF",
      "what is this article about",
    ],
    negativeExamples: ["compare these papers", "做文献矩阵"],
    keywords: ["summarize", "summary", "概括", "总结", "梳理", "digest"],
    contextRequirements: {
      selectedItems: "one",
      pdfText: "preferred",
      annotations: "optional",
      notes: "optional",
    },
    toolPolicy: DEFAULT_TOOL_POLICY,
    outputContract: {
      format: "markdown",
      target: "chat",
      language: "auto",
      sections: [
        "Citation",
        "Research question",
        "Core contribution",
        "Method",
        "Key findings",
        "Limitations",
        "Questions to follow up",
      ],
    },
    promptTemplate: {
      system:
        "You are running Claudero's summarize-paper academic workflow. Ground the answer in Zotero metadata, PDF text, selected text, annotations, and get_evidence_pack results when available. Do not invent details that are not present in the context.",
      task: "Summarize the paper using the output sections exactly. Include evidence locations for key findings and limitations. If evidence is missing, say what is missing instead of guessing.",
    },
    source: { type: "builtin" },
  },
  {
    id: "extract-methods",
    title: "Extract Methods",
    description:
      "Extracts research design, sample or dataset, variables, procedure, measures, analysis strategy, and methodological limitations.",
    routingGuidance:
      "Use when the user asks about methods, methodology, experiment design, sample, dataset, variables, measures, procedure, or analysis strategy.",
    category: "extraction",
    builtinVersion: 2,
    intentExamples: [
      "extract the methods",
      "提取方法部分",
      "这篇文章的数据和样本是什么",
      "summarize the methodology",
    ],
    negativeExamples: ["帮我写一段方法论章节", "compare methods across papers"],
    keywords: [
      "method",
      "methods",
      "methodology",
      "sample",
      "dataset",
      "procedure",
      "方法",
      "研究设计",
      "样本",
      "数据",
      "变量",
      "测量",
    ],
    contextRequirements: {
      selectedItems: "one",
      pdfText: "preferred",
      annotations: "optional",
    },
    toolPolicy: DEFAULT_TOOL_POLICY,
    outputContract: {
      format: "markdown",
      target: "chat",
      language: "auto",
      sections: [
        "Study design",
        "Sample or dataset",
        "Variables and measures",
        "Procedure",
        "Analysis strategy",
        "Methodological limitations",
        "Evidence locations",
      ],
    },
    promptTemplate: {
      system:
        "You are running Claudero's extract-methods academic workflow. Extract methods from the provided Zotero/PDF context and get_evidence_pack results, and keep claims tied to evidence.",
      task: "Return the method extraction using the output sections exactly. Include page, quote, annotation, paragraph id, or metadata clues when available. Use locate_quote before direct quotes.",
    },
    source: { type: "builtin" },
  },
  {
    id: "literature-matrix",
    title: "Literature Matrix",
    description:
      "Builds a comparison matrix for multiple selected papers, covering research questions, methods, samples, measures, findings, limitations, and relevance.",
    routingGuidance:
      "Use when the user asks to compare multiple papers, build a literature matrix, synthesize selected references, or contrast methods/findings.",
    category: "comparison",
    builtinVersion: 2,
    intentExamples: [
      "compare these papers",
      "做一个文献矩阵",
      "对比这几篇文章的方法和样本",
      "build a literature matrix",
    ],
    negativeExamples: ["summarize this paper", "提取这一篇的方法"],
    keywords: [
      "compare",
      "comparison",
      "matrix",
      "literature matrix",
      "synthesis",
      "对比",
      "比较",
      "矩阵",
      "文献矩阵",
      "综述",
    ],
    contextRequirements: {
      selectedItems: "many",
      pdfText: "preferred",
      annotations: "optional",
      notes: "optional",
    },
    toolPolicy: DEFAULT_TOOL_POLICY,
    outputContract: {
      format: "markdown-table",
      target: "chat",
      language: "auto",
      columns: [
        "Paper",
        "Research question",
        "Method/design",
        "Sample/dataset",
        "Measures/variables",
        "Key findings",
        "Limitations",
        "Relevance to my project",
      ],
    },
    promptTemplate: {
      system:
        "You are running Claudero's literature-matrix academic workflow. Compare selected Zotero items using only available context and get_evidence_pack results, clearly marking missing evidence.",
      task: "Create a Markdown table using the output columns exactly, followed by a concise synthesis of patterns, disagreements, and gaps. Add compact evidence locations for high-value claims, and use verify_citations when claims are citation-heavy.",
    },
    source: { type: "builtin" },
  },
  {
    id: "verify-citations",
    title: "Verify Citations",
    description:
      "Checks direct quotes, factual claims, page references, figure/table references, and claim-to-source support against Zotero evidence.",
    routingGuidance:
      "Use when the user asks to verify citations, check quotes, validate page references, audit evidence, map claims to sources, or inspect figure/table references.",
    category: "verification",
    builtinVersion: 1,
    intentExamples: [
      "verify these citations",
      "检查这些引用是否可靠",
      "核查这段综述的来源",
      "map claims to sources",
      "check this quote and page number",
    ],
    negativeExamples: ["summarize this paper", "compare these papers"],
    keywords: [
      "verify",
      "verification",
      "citation",
      "citations",
      "quote",
      "provenance",
      "claim",
      "source",
      "page",
      "figure",
      "table",
      "核查",
      "验证",
      "引用",
      "引文",
      "来源",
      "证据",
      "页码",
      "图表",
    ],
    contextRequirements: {
      selectedItems: "optional",
      pdfText: "preferred",
      annotations: "optional",
      notes: "optional",
    },
    toolPolicy: DEFAULT_TOOL_POLICY,
    outputContract: {
      format: "markdown-table",
      target: "chat",
      language: "auto",
      columns: ["Claim", "Status", "Evidence", "Location", "Issue", "Fix"],
    },
    promptTemplate: {
      system:
        "You are running Claudero's verify-citations academic workflow. Use get_evidence_pack, locate_quote, inspect_figure_table_page, verify_citations, build_trust_report, and build_academic_trace to audit claims against Zotero evidence. Never invent page numbers, quotes, or sources.",
      task: "Return a verification table plus the Evidence Trust Report summary and, for claim-heavy answers, an Academic Trace summary with replayable next steps. Mark each claim as verified, weak, or unverified. Include evidence id, page/openUri when available, quote provenance for direct quotes, and a concrete fix for weak or unsupported claims. For figure/table claims, call inspect_figure_table_page when possible and treat its rendered page image as the visual source of truth.",
    },
    source: { type: "builtin" },
  },
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const nested = input[key];
      if (nested !== undefined) output[key] = stableValue(nested);
    }
    return output;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function hashText(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function academicSkillHash(skill: AcademicSkill): string {
  return hashText(stableStringify({ ...skill, source: undefined }));
}

function normalizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `skill-${Date.now()}`
  );
}

export function parseAcademicSkillStore(raw = ""): AcademicSkillStore {
  if (!raw.trim()) return { version: 1, skills: {} };
  try {
    const parsed = JSON.parse(raw) as Partial<AcademicSkillStore>;
    return {
      version: 1,
      skills:
        parsed.skills && typeof parsed.skills === "object"
          ? (parsed.skills as Record<string, StoredAcademicSkill>)
          : {},
    };
  } catch {
    return { version: 1, skills: {} };
  }
}

export function serializeAcademicSkillStore(store: AcademicSkillStore): string {
  return JSON.stringify({ version: 1, skills: store.skills }, null, 2);
}

export function getAcademicSkillStore(): AcademicSkillStore {
  return parseAcademicSkillStore(String(getPref("academicSkills") || ""));
}

export function saveAcademicSkillStore(store: AcademicSkillStore): void {
  setPref("academicSkills", serializeAcademicSkillStore(store));
}

export function getAcademicSkillRecords(
  store = getAcademicSkillStore(),
  builtins = BUILTIN_ACADEMIC_SKILLS,
): AcademicSkillRecord[] {
  const builtinById = new Map(builtins.map((skill) => [skill.id, skill]));
  const records: AcademicSkillRecord[] = [];

  for (const builtin of builtins) {
    const stored = store.skills[builtin.id];
    const builtinHash = academicSkillHash(builtin);
    const effective = stored?.skill || builtin;
    const effectiveHash = academicSkillHash(effective);
    const enabled = stored ? stored.enabled !== false : true;
    const modified = !!stored && effectiveHash !== builtinHash;
    const updateAvailable =
      !!stored?.basedOnBuiltinHash &&
      stored.basedOnBuiltinHash !== builtinHash &&
      modified;
    const status: AcademicSkillStatus = !enabled
      ? "disabled"
      : updateAvailable
        ? "update-available"
        : modified
          ? "modified"
          : "builtin";
    records.push({
      id: builtin.id,
      skill: effective,
      builtin,
      stored,
      enabled,
      builtinHash,
      effectiveHash,
      status,
      updateAvailable,
      modified,
    });
  }

  for (const stored of Object.values(store.skills)) {
    if (builtinById.has(stored.id)) continue;
    records.push({
      id: stored.id,
      skill: stored.skill,
      stored,
      enabled: stored.enabled !== false,
      effectiveHash: academicSkillHash(stored.skill),
      status: stored.enabled === false ? "disabled" : "custom",
      updateAvailable: false,
      modified: true,
    });
  }

  return records.sort((a, b) => a.skill.title.localeCompare(b.skill.title));
}

export function getEnabledAcademicSkills(): AcademicSkill[] {
  return getAcademicSkillRecords()
    .filter((record) => record.enabled)
    .map((record) => record.skill);
}

export function saveAcademicSkillOverride(
  skill: AcademicSkill,
  enabled = true,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const builtin = BUILTIN_ACADEMIC_SKILLS.find((item) => item.id === skill.id);
  const basedOnBuiltinHash = builtin ? academicSkillHash(builtin) : undefined;
  const now = Date.now();
  const next: AcademicSkillStore = {
    version: 1,
    skills: {
      ...store.skills,
      [skill.id]: {
        id: skill.id,
        enabled,
        basedOnBuiltinHash,
        skill,
        updatedAt: now,
        source: skill.source,
      },
    },
  };
  saveAcademicSkillStore(next);
  return next;
}

export function setAcademicSkillEnabled(
  id: string,
  enabled: boolean,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const record = getAcademicSkillRecords(store).find((item) => item.id === id);
  if (!record) return store;
  const next: AcademicSkillStore = { version: 1, skills: { ...store.skills } };
  next.skills[id] = {
    id,
    enabled,
    basedOnBuiltinHash: record.builtinHash,
    skill: record.skill,
    updatedAt: Date.now(),
    source: record.skill.source,
  };
  saveAcademicSkillStore(next);
  return next;
}

export function resetAcademicSkillToBuiltin(
  id: string,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const next: AcademicSkillStore = { version: 1, skills: { ...store.skills } };
  delete next.skills[id];
  saveAcademicSkillStore(next);
  return next;
}

export function updateAcademicSkillToBuiltin(
  id: string,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const builtin = BUILTIN_ACADEMIC_SKILLS.find((skill) => skill.id === id);
  if (!builtin) return store;
  const next: AcademicSkillStore = { version: 1, skills: { ...store.skills } };
  const previousEnabled = next.skills[id]?.enabled !== false;
  if (previousEnabled) {
    delete next.skills[id];
  } else {
    next.skills[id] = {
      id,
      enabled: false,
      basedOnBuiltinHash: academicSkillHash(builtin),
      skill: builtin,
      updatedAt: Date.now(),
      source: builtin.source,
    };
  }
  saveAcademicSkillStore(next);
  return next;
}

function termMatches(prompt: string, term: string): boolean {
  const normalized = term.trim().toLowerCase();
  if (!normalized) return false;
  if (/^[a-z0-9 -]+$/.test(normalized)) {
    return new RegExp(
      `\\b${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    ).test(prompt);
  }
  return prompt.includes(normalized);
}

export function matchAcademicSkillIntent(
  prompt: string,
  skills = getEnabledAcademicSkills(),
): AcademicSkillMatch | null {
  const normalizedPrompt = prompt.toLowerCase();
  let best: AcademicSkillMatch | null = null;

  for (const skill of skills) {
    const negativeHits = (skill.negativeExamples || []).filter((example) =>
      termMatches(normalizedPrompt, example.toLowerCase()),
    );
    if (negativeHits.length > 0) continue;

    const terms = [...skill.keywords, ...skill.intentExamples];
    const matchedTerms = terms.filter((term) =>
      termMatches(normalizedPrompt, term.toLowerCase()),
    );
    if (matchedTerms.length === 0) continue;
    const confidence = Math.min(
      0.95,
      0.45 +
        matchedTerms.length * 0.16 +
        (skill.keywords.some((term) =>
          termMatches(normalizedPrompt, term.toLowerCase()),
        )
          ? 0.12
          : 0),
    );
    const match: AcademicSkillMatch = {
      skill,
      confidence,
      matchedTerms: [...new Set(matchedTerms)].slice(0, 6),
      reason: `Matched ${skill.title} from ${matchedTerms.length} routing term${matchedTerms.length === 1 ? "" : "s"}.`,
    };
    if (!best || match.confidence > best.confidence) best = match;
  }

  return best && best.confidence >= 0.55 ? best : null;
}

export function resolveAcademicSkillContextStatus(
  skill: AcademicSkill,
  context: ClauderoSelectionContext,
): AcademicSkillContextStatus {
  const missing: string[] = [];
  const warnings: string[] = [];
  const itemCount = context.items.length;
  const selectedItems = skill.contextRequirements.selectedItems || "optional";

  if (selectedItems === "one" && itemCount < 1) {
    missing.push("Select one Zotero item or open a paper PDF.");
  } else if (selectedItems === "many" && itemCount < 2) {
    missing.push("Select at least two Zotero items.");
  }

  if (
    skill.contextRequirements.pdfText === "preferred" &&
    !context.reader &&
    !context.selectedText
  ) {
    warnings.push("PDF text is preferred; results may rely on metadata only.");
  }

  if (
    skill.contextRequirements.annotations === "preferred" &&
    (context.selectedAnnotations || []).length === 0
  ) {
    warnings.push("Annotations are preferred but none are selected.");
  }

  return { missing, warnings };
}

export function compileAcademicSkillPrompt(options: {
  userPrompt: string;
  match: AcademicSkillMatch;
  contextStatus: AcademicSkillContextStatus;
}): string {
  const { skill } = options.match;
  const contract = skill.outputContract;
  const outputShape = contract.columns?.length
    ? `Columns: ${contract.columns.join(" | ")}`
    : contract.sections?.length
      ? `Sections: ${contract.sections.join(" | ")}`
      : `Format: ${contract.format}`;
  return [
    `<claudero_academic_skill id="${skill.id}" title="${skill.title}">`,
    `Description: ${skill.description}`,
    `Routing guidance: ${skill.routingGuidance}`,
    `Matched terms: ${options.match.matchedTerms.join(", ") || "none"}`,
    `Confidence: ${options.match.confidence.toFixed(2)}`,
    "",
    "Context requirements:",
    JSON.stringify(skill.contextRequirements, null, 2),
    "",
    "Context status:",
    `Missing: ${options.contextStatus.missing.join("; ") || "none"}`,
    `Warnings: ${options.contextStatus.warnings.join("; ") || "none"}`,
    "",
    "Tool policy:",
    JSON.stringify(skill.toolPolicy, null, 2),
    "",
    "Output contract:",
    outputShape,
    `Target: ${contract.target}`,
    `Language: ${contract.language || "auto"}`,
    "",
    "System instruction:",
    skill.promptTemplate.system,
    "",
    "Workflow task:",
    skill.promptTemplate.task,
    "",
    "User request:",
    options.userPrompt,
    "</claudero_academic_skill>",
  ].join("\n");
}

function parseFrontmatter(raw: string): {
  metadata: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: raw.trim() };
  const metadata: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    metadata[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { metadata, body: match[2].trim() };
}

export function importAcademicSkillFromText(
  raw: string,
  options: { idHint?: string; sourceType?: AcademicSkillSource["type"] } = {},
): AcademicSkill {
  const text = raw.trim();
  if (!text) throw new Error("Skill content is empty.");

  try {
    const parsed = JSON.parse(text) as
      | AcademicSkill
      | { skill?: AcademicSkill }
      | {
          name?: string;
          title?: string;
          description?: string;
          messages?: unknown[];
        };
    if ("skill" in parsed && parsed.skill) return parsed.skill;
    if ("id" in parsed && typeof parsed.id === "string") {
      return parsed as AcademicSkill;
    }
    if ("name" in parsed && typeof parsed.name === "string") {
      const promptMessages = Array.isArray(parsed.messages)
        ? parsed.messages.map((message) => stableStringify(message)).join("\n")
        : "";
      return createImportedSkill({
        id: parsed.name,
        title: parsed.title || parsed.name,
        description: parsed.description || `Imported prompt ${parsed.name}`,
        body: promptMessages || parsed.description || "",
        sourceType: "mcp-prompt",
      });
    }
  } catch {
    // Fall through to Markdown/SKILL.md parsing.
  }

  const { metadata, body } = parseFrontmatter(text);
  const id = normalizeId(
    options.idHint ||
      metadata.name ||
      metadata.title ||
      metadata.description ||
      "imported-skill",
  );
  return createImportedSkill({
    id,
    title: metadata.title || metadata.name || id,
    description:
      metadata.description ||
      body.split(/\r?\n/).find((line) => line.trim()) ||
      "Imported academic skill",
    body,
    sourceType: options.sourceType || "agent-skill",
  });
}

function createImportedSkill(options: {
  id: string;
  title: string;
  description: string;
  body: string;
  sourceType: AcademicSkillSource["type"];
}): AcademicSkill {
  const id = normalizeId(options.id);
  return {
    id,
    title: options.title.trim() || id,
    description: options.description.trim(),
    routingGuidance: options.description.trim(),
    category: "reading",
    intentExamples: [options.title, options.description].filter(Boolean),
    negativeExamples: [],
    keywords: options.title.split(/\s+/).filter(Boolean),
    contextRequirements: { selectedItems: "optional" },
    toolPolicy: {
      zoteroMcp: false,
      allowZoteroRead: true,
      allowZoteroWrite: false,
      allowWebSearch: false,
      allowScripts: false,
    },
    outputContract: {
      format: "markdown",
      target: "chat",
      language: "auto",
    },
    promptTemplate: {
      system:
        "You are running an imported Claudero academic skill. Follow the imported instructions, but do not execute scripts or write Zotero data unless the user explicitly confirms and the tool policy allows it.",
      task: options.body || options.description,
    },
    source: {
      type: options.sourceType,
      importedAt: Date.now(),
      sourceHash: hashText(options.body),
    },
  };
}

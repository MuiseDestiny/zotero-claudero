import { getPref, setPref } from "../utils/prefs";
import { isConfigRecord } from "../shared/configValidation";
import {
  validateAcademicSkill,
  validateStoredAcademicSkill,
} from "../shared/academicSkillValidation";
export { validateAcademicSkill } from "../shared/academicSkillValidation";
import type { AcademicToolPolicy } from "../shared/academicToolPolicy";
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

export type AcademicSkillToolPolicy = AcademicToolPolicy;

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
  invalidSkills?: Record<string, AcademicSkillInvalidRecord>;
  /** Unreadable/unsupported document: block writes until explicitly repaired. */
  rawDocument?: string;
  validationError?: string;
}

export interface AcademicSkillInvalidRecord {
  raw: unknown;
  error: string;
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
  validationError?: string;
  rawStored?: unknown;
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
        "You are running Claudero's summarize-paper academic workflow. Ground the answer in Zotero metadata, PDF text, selected text, annotations, and get_numbered_evidence_pack/expand_evidence_range results when available. Do not invent details that are not present in the context.",
      task: "Summarize the paper using the output sections exactly. Copy tool-provided citationMarkdown markers before sentence-ending punctuation without adding URLs. Do not create a separate Evidence, Source, References, or 证据 section unless the user explicitly asks for an audit.",
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
      ],
    },
    promptTemplate: {
      system:
        "You are running Claudero's extract-methods academic workflow. Extract methods from the provided Zotero/PDF context and get_numbered_evidence_pack/expand_evidence_range results, and keep claims tied to source material.",
      task: "Return the method extraction using the output sections exactly. Copy tool-provided citationMarkdown markers before sentence-ending punctuation without adding URLs. Use locate_quote before direct quotes.",
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
        "You are running Claudero's literature-matrix academic workflow. Compare selected Zotero items using only available context and get_numbered_evidence_pack, expand_evidence_range, or get_evidence_pack results, clearly marking missing source support.",
      task: "Create a Markdown table using the output columns exactly, followed by a concise synthesis of patterns, disagreements, and gaps. Add quiet inline source markers before sentence-ending punctuation for high-value claims, and use verify_citations when claims are citation-heavy.",
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
    builtinVersion: 2,
    intentExamples: [
      "verify these citations",
      "检查这些引用是否可靠",
      "核查这段综述的来源",
      "map claims to sources",
      "check this quote and page number",
      "这句话在本文吗",
      "这句话在论文中吗",
      "这段话是否出现在原文",
      "这句引文是否出现在文中",
      "does this sentence appear in the paper",
      "is this quote in the article",
    ],
    negativeExamples: [
      "summarize this paper",
      "compare these papers",
      "explain figure 1",
      "what does figure 1 show",
      "图1讲了什么",
      "解释图1",
    ],
    keywords: [
      "verify",
      "verification",
      "citation",
      "citations",
      "quote",
      "provenance",
      "claim",
      "source",
      "核查",
      "验证",
      "引用",
      "引文",
      "来源",
      "证据",
      "是否出现在",
      "出现在本文",
      "出现在论文",
      "在本文吗",
      "在论文吗",
      "在原文吗",
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
      columns: ["Claim", "Status", "Support", "Location", "Issue", "Fix"],
    },
    promptTemplate: {
      system:
        "You are running Claudero's verify-citations academic workflow. This workflow is tool-grounded: selected text and lightweight context are search hints, not proof. For explicit quote/existence/page verification, call locate_quote (or mcp__zotero__locate_quote) before answering, even if the selected text looks exact. Use get_numbered_evidence_pack, expand_evidence_range, get_evidence_pack, verify_citations, build_trust_report, inspect_figure_table_page, and build_academic_trace as needed to audit claims against Zotero source material. Never invent page numbers, quotes, or sources.",
      task: "Return a verification table plus the Evidence Trust Report summary and, for claim-heavy answers, an Academic Trace summary with replayable next steps. Mark each claim as verified, weak, or unverified. Include source id and page, copying the tool-provided citationMarkdown marker without adding a URL; include quote provenance for direct quotes and a concrete fix for weak or unsupported claims. For direct quote checks, use the locate_quote result as the source of truth; do not treat selected text alone as verification. For figure/table claims, call inspect_figure_table_page when possible and treat its rendered page image as the visual source of truth.",
    },
    source: { type: "builtin" },
  },
];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null);
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
    const parsed: unknown = JSON.parse(raw);
    if (
      !isConfigRecord(parsed) ||
      (parsed.version !== undefined && parsed.version !== 1) ||
      !isConfigRecord(parsed.skills)
    ) {
      throw new Error("Skill store must contain a version 1 skills object.");
    }
    const skills: Record<string, StoredAcademicSkill> = {};
    const invalidSkills: Record<string, AcademicSkillInvalidRecord> = {};
    for (const [id, candidate] of Object.entries(parsed.skills)) {
      const error = validateStoredAcademicSkill(candidate, id);
      if (error) {
        Object.defineProperty(invalidSkills, id, {
          value: { raw: candidate, error },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        Object.defineProperty(skills, id, {
          value: candidate,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return {
      version: 1,
      skills,
      ...(Object.keys(invalidSkills).length ? { invalidSkills } : {}),
    };
  } catch (error) {
    return {
      version: 1,
      skills: {},
      rawDocument: raw,
      validationError:
        error instanceof Error ? error.message : "Invalid skill store.",
    };
  }
}

export function serializeAcademicSkillStore(store: AcademicSkillStore): string {
  if (store.rawDocument !== undefined) return store.rawDocument;
  for (const [id, skill] of Object.entries(store.skills)) {
    const error = validateStoredAcademicSkill(skill, id);
    if (error) throw new Error(error);
  }
  const rawInvalid = Object.fromEntries(
    Object.entries(store.invalidSkills || {}).map(([id, invalid]) => [
      id,
      invalid.raw,
    ]),
  );
  return JSON.stringify(
    { version: 1, skills: { ...rawInvalid, ...store.skills } },
    null,
    2,
  );
}

export function getAcademicSkillStore(): AcademicSkillStore {
  return parseAcademicSkillStore(String(getPref("academicSkills") || ""));
}

export function saveAcademicSkillStore(store: AcademicSkillStore): void {
  if (store.rawDocument !== undefined)
    throw new Error(
      "Repair the invalid skill store before saving; original data has been preserved.",
    );
  setPref("academicSkills", serializeAcademicSkillStore(store));
}

function editableSkillStore(store: AcademicSkillStore): AcademicSkillStore {
  if (store.rawDocument !== undefined)
    throw new Error(
      "Repair the invalid skill store before saving; original data has been preserved.",
    );
  return {
    ...store,
    skills: { ...store.skills },
    invalidSkills: { ...store.invalidSkills },
  };
}

export function getAcademicSkillRecords(
  store = getAcademicSkillStore(),
  builtins = BUILTIN_ACADEMIC_SKILLS,
): AcademicSkillRecord[] {
  // Callers may supply an in-memory store too; apply the same read boundary.
  if (store.rawDocument === undefined) {
    store = parseAcademicSkillStore(
      JSON.stringify({
        version: 1,
        skills: {
          ...Object.fromEntries(
            Object.entries(store.invalidSkills || {}).map(([id, entry]) => [
              id,
              entry.raw,
            ]),
          ),
          ...store.skills,
        },
      }),
    );
  }
  const builtinById = new Map(builtins.map((skill) => [skill.id, skill]));
  const records: AcademicSkillRecord[] = [];

  for (const builtin of builtins) {
    const stored = Object.prototype.hasOwnProperty.call(
      store.skills,
      builtin.id,
    )
      ? store.skills[builtin.id]
      : undefined;
    const invalid = store.invalidSkills?.[builtin.id];
    const builtinHash = academicSkillHash(builtin);
    const effective = stored?.skill || builtin;
    const effectiveHash = academicSkillHash(effective);
    const enabled =
      !invalid && !store.validationError && (stored ? stored.enabled : true);
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
      ...(invalid
        ? { validationError: invalid.error, rawStored: invalid.raw }
        : {}),
      ...(store.validationError
        ? { validationError: store.validationError }
        : {}),
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

  for (const [id, invalid] of Object.entries(store.invalidSkills || {})) {
    if (builtinById.has(id)) continue;
    const placeholder = createImportedSkill({
      id,
      title: id,
      description: invalid.error,
      body: "",
      sourceType: "markdown",
    });
    placeholder.id = id;
    records.push({
      id,
      skill: placeholder,
      enabled: false,
      effectiveHash: "",
      status: "disabled",
      updateAvailable: false,
      modified: true,
      validationError: invalid.error,
      rawStored: invalid.raw,
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
  const error = validateAcademicSkill(skill);
  if (error) throw new Error(error);
  if (typeof enabled !== "boolean")
    throw new Error("Skill enabled must be a boolean.");
  const next = editableSkillStore(store);
  const builtin = BUILTIN_ACADEMIC_SKILLS.find((item) => item.id === skill.id);
  Object.defineProperty(next.skills, skill.id, {
    value: {
      id: skill.id,
      enabled,
      skill,
      ...(builtin ? { basedOnBuiltinHash: academicSkillHash(builtin) } : {}),
      updatedAt: Date.now(),
      ...(skill.source ? { source: skill.source } : {}),
    },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  delete next.invalidSkills?.[skill.id];
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
  if (record.validationError)
    throw new Error("Repair this skill before enabling it.");
  return saveAcademicSkillOverride(record.skill, enabled, store);
}

export function resetAcademicSkillToBuiltin(
  id: string,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const next = editableSkillStore(store);
  delete next.skills[id];
  delete next.invalidSkills?.[id];
  saveAcademicSkillStore(next);
  return next;
}

export function deleteCustomAcademicSkill(
  id: string,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const hasBuiltin = BUILTIN_ACADEMIC_SKILLS.some((skill) => skill.id === id);
  if (hasBuiltin) return store;
  const next = editableSkillStore(store);
  delete next.skills[id];
  delete next.invalidSkills?.[id];
  saveAcademicSkillStore(next);
  return next;
}

export function updateAcademicSkillToBuiltin(
  id: string,
  store = getAcademicSkillStore(),
): AcademicSkillStore {
  const builtin = BUILTIN_ACADEMIC_SKILLS.find((skill) => skill.id === id);
  if (!builtin) return store;
  const next = editableSkillStore(store);
  const previousEnabled =
    !next.invalidSkills?.[id] && next.skills[id]?.enabled !== false;
  delete next.invalidSkills?.[id];
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
  const metadata: Record<string, string> = Object.create(null);
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

  let parsed: unknown;
  let json = false;
  try {
    parsed = JSON.parse(text);
    json = true;
  } catch (error) {
    // JSON-looking input must not silently become a Markdown prompt.
    if (/^[{[]/.test(text)) throw error;
  }
  if (json) {
    if (!isConfigRecord(parsed))
      throw new Error("Skill JSON must be an object.");
    if ("skill" in parsed || "id" in parsed) {
      const input = "skill" in parsed ? parsed.skill : parsed;
      const error = validateAcademicSkill(input, true);
      if (error) throw new Error(error);
      return sanitizeImportedAcademicSkill(
        input as AcademicSkill,
        options.sourceType,
      );
    }
    if (typeof parsed.name === "string") {
      for (const key of ["title", "description"]) {
        if (key in parsed && typeof parsed[key] !== "string")
          throw new Error(`Prompt ${key} must be a string.`);
      }
      if ("messages" in parsed && !Array.isArray(parsed.messages))
        throw new Error("Prompt messages must be an array.");
      return createImportedSkill({
        id: parsed.name,
        title: (parsed.title as string) || parsed.name,
        description:
          (parsed.description as string) || `Imported prompt ${parsed.name}`,
        body: Array.isArray(parsed.messages)
          ? parsed.messages
              .map((message) => stableStringify(message))
              .join("\n")
          : (parsed.description as string) || "",
        sourceType: "mcp-prompt",
      });
    }
    throw new Error("Skill JSON must contain a skill, id, or prompt name.");
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

function sanitizeImportedAcademicSkill(
  input: AcademicSkill,
  sourceType: AcademicSkillSource["type"] = "markdown",
): AcademicSkill {
  const fallback = createImportedSkill({
    id: input.id || input.title || "imported-skill",
    title: input.title || input.id || "Imported skill",
    description: input.description || "Imported academic skill",
    body: input.promptTemplate?.task || input.description || "",
    sourceType,
  });
  const skill: AcademicSkill = {
    ...fallback,
    ...input,
    id: normalizeId(input.id || fallback.id),
    title: String(input.title || fallback.title).trim(),
    description: String(input.description || fallback.description).trim(),
    intentExamples: Array.isArray(input.intentExamples)
      ? input.intentExamples.map(String)
      : fallback.intentExamples,
    negativeExamples: Array.isArray(input.negativeExamples)
      ? input.negativeExamples.map(String)
      : [],
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map(String)
      : fallback.keywords,
    toolPolicy: {
      zoteroMcp: false,
      allowZoteroRead: true,
      allowZoteroWrite: false,
      allowWebSearch: false,
      allowScripts: false,
    },
    source: {
      type: sourceType === "builtin" ? "markdown" : sourceType,
      importedAt: Date.now(),
      sourceHash: hashText(stableStringify(input)),
    },
  };
  const error = validateAcademicSkill(skill);
  if (error) throw new Error(error);
  return skill;
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
      type: options.sourceType === "builtin" ? "markdown" : options.sourceType,
      importedAt: Date.now(),
      sourceHash: hashText(options.body),
    },
  };
}

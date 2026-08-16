import {
  encodeEvidenceMarker,
  encodeEvidenceReference,
} from "../shared/evidenceLinkCodec";
import { detectEvidenceContradiction } from "../shared/evidenceSemantics";
import {
  figurePageViewBox,
  figureInspectionSearchPlan,
  isRenderableCanvasLike,
  selectFigurePageCandidate,
} from "../shared/figureInspectionPolicy";

export interface EvidenceLocator {
  itemId: number;
  itemKey: string;
  attachmentId?: number;
  attachmentKey?: string;
  title: string;
  excerpt?: string;
  sourceType: "metadata" | "fulltext" | "pdfjs" | "annotation";
  pageIndex?: number;
  pageNumber?: number;
  paragraphIndex?: number;
  annotationId?: number;
  annotationKey?: string;
  position?: EvidencePosition;
  openUri?: string;
  evidenceUri?: string;
}

export interface EvidencePosition {
  pageIndex: number;
  rects?: number[][];
  nextPageRects?: number[][];
  lines?: EvidenceLine[];
}

export interface EvidenceLine {
  text: string;
  rects: number[][];
  pageIndex: number;
}

export interface EvidenceParagraph {
  id: string;
  text: string;
  locator: EvidenceLocator;
  markdownLink?: string;
  score?: number;
  matchReason?: string;
}

export interface NumberedEvidenceSource {
  sourceId: string;
  kind: "paragraph" | "annotation" | "metadata";
  text: string;
  locator: EvidenceLocator;
  citationMarkdown: string;
  pageNumber?: number;
  paragraphIndex?: number;
}

export interface DocumentMapSection {
  id: string;
  title: string;
  pageStart?: number;
  pageEnd?: number;
  printedPageStart?: number;
  printedPageEnd?: number;
  mapSource?: "pdf-outline" | "text-toc" | "page-chunk" | "annotations";
  sourceStart: string;
  sourceEnd: string;
  paragraphCount: number;
  samples: Array<{
    sourceId: string;
    pageNumber?: number;
    excerpt: string;
  }>;
}

export interface NumberedEvidencePack {
  item: EvidencePack["item"];
  attachment?: EvidencePack["attachment"];
  mode: "full" | "map";
  contextText: string;
  sources: NumberedEvidenceSource[];
  documentMap?: DocumentMapSection[];
  warnings: string[];
  citationGuidance: string[];
}

export interface EvidenceFigureTableCandidate {
  kind: "figure" | "table";
  label: string;
  caption: string;
  locator: EvidenceLocator;
  pageImage?: EvidencePageImage;
  pageContext?: EvidenceFigureTableContext;
}

export interface EvidencePageImage {
  pageIndex: number;
  pageNumber: number;
  source: "pdfjs-canvas" | "open-pdf-uri";
  openUri?: string;
  dataUrl?: string;
  mediaType?: "image/jpeg" | "image/png";
  width?: number;
  height?: number;
  warning?: string;
}

export interface EvidenceFigureTableContext {
  before: string[];
  after: string[];
  samePageEvidenceIds: string[];
  rects?: number[][];
}

export interface EvidencePack {
  item: {
    id: number;
    key: string;
    title: string;
    creators: string[];
    year: string;
    DOI: string;
  };
  attachment?: {
    id: number;
    key: string;
    title: string;
    path?: string;
    cachePath?: string;
    indexState?: number;
  };
  query?: string;
  paragraphs: EvidenceParagraph[];
  annotations: EvidenceParagraph[];
  figuresTables: EvidenceFigureTableCandidate[];
  warnings: string[];
  citationGuidance: string[];
}

export interface EvidenceImageInput {
  media_type: "image/jpeg" | "image/png";
  data: string;
}

export interface FigureTablePageInspection {
  status: "candidate_found" | "not_found" | "page_needs_inspection";
  found: boolean;
  searchComplete: boolean;
  terminal: boolean;
  recommendedAction: string;
  target: {
    itemId?: number;
    attachmentId?: number;
    pageIndex?: number;
    pageNumber?: number;
    label?: string;
    caption?: string;
    claim?: string;
  };
  candidate?: EvidenceFigureTableCandidate;
  pageImage?: EvidencePageImage;
  imageInput?: EvidenceImageInput;
  inspectionPrompt: string;
  expectedOutput: {
    format: "json";
    fields: string[];
  };
  warnings: string[];
}

export interface LocatedQuote {
  quote: string;
  matches: EvidenceParagraph[];
  warnings: string[];
}

export interface CitationClaimInput {
  claim: string;
  quote?: string;
  itemId?: number;
  attachmentId?: number;
  pageIndex?: number;
}

export interface CitationVerification {
  claim: string;
  quote?: string;
  status: "verified" | "weak" | "unverified";
  confidence: number;
  evidence?: EvidenceParagraph;
  visualInspection?: CitationVisualInspectionHint;
  warnings: string[];
}

export interface CitationVisualInspectionHint {
  required: boolean;
  reason: string;
  tool: "inspect_figure_table_page";
  arguments: {
    itemId?: number;
    attachmentId?: number;
    pageIndex?: number;
    pageNumber?: number;
    label?: string;
    caption?: string;
    claim: string;
  };
}

export interface EvidenceTrustReport {
  summary: {
    totalClaims: number;
    verified: number;
    weak: number;
    unverified: number;
    visualInspectionRequired: number;
  };
  verifications: CitationVerification[];
  claimSourceMap: Record<string, EvidenceLocator | null>;
  nextActions: EvidenceTrustReportAction[];
  markdown: string;
  warnings: string[];
}

export interface EvidenceTrustReportAction {
  kind: "inspect_figure_table_page" | "revise_or_find_source";
  claim: string;
  reason: string;
  arguments?: CitationVisualInspectionHint["arguments"];
}

export interface AcademicTraceToolCall {
  tool: string;
  arguments?: unknown;
  status?: "planned" | "called" | "succeeded" | "failed" | "skipped";
  summary?: string;
  error?: string;
}

export interface AcademicTraceEvidenceRecord {
  claim: string;
  status: CitationVerification["status"];
  confidence: number;
  quote?: string;
  evidenceId?: string;
  excerpt?: string;
  locator?: EvidenceLocator;
  warnings: string[];
}

export interface AcademicTraceReplayStep {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
  required: boolean;
}

export interface AcademicTraceFailure {
  claim: string;
  status: CitationVerification["status"];
  reason: string;
  fix: string;
}

export interface AcademicTraceArtifact {
  protocol: "claudero.academic-trace";
  version: 1;
  traceId: string;
  createdAt: string;
  source: {
    itemId?: number;
    attachmentId?: number;
    query?: string;
  };
  answer?: string;
  claims: CitationClaimInput[];
  trustReport: EvidenceTrustReport;
  evidence: AcademicTraceEvidenceRecord[];
  toolCalls: AcademicTraceToolCall[];
  replayPlan: AcademicTraceReplayStep[];
  visualInspectionQueue: EvidenceTrustReportAction[];
  failures: AcademicTraceFailure[];
  markdown: string;
  warnings: string[];
}

interface TextPage {
  pageIndex?: number;
  text: string;
}

interface DocumentOutlineEntry {
  title: string;
  pageNumber?: number;
  level: number;
}

interface TocEntry {
  title: string;
  printedPage: number;
  pageNumber?: number;
  level: number;
}

interface PdfJsTextItem {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

interface ZoteroReaderChar {
  c?: string;
  rect?: number[];
  inlineRect?: number[];
  lineBreakAfter?: boolean;
  spaceAfter?: boolean;
  paragraphBreakAfter?: boolean;
  ignorable?: boolean;
}

interface PdfJsLine {
  text: string;
  items: PdfJsTextItem[];
  rects: number[][];
  pageIndex: number;
}

interface PdfJsAppContext {
  app: any;
  pages: any[];
  internalReader?: any;
  view?: any;
  primaryView?: any;
}

interface EvidenceCorpus {
  item: Zotero.Item;
  attachment?: Zotero.Item;
  paragraphs: EvidenceParagraph[];
  annotations: EvidenceParagraph[];
  pageTexts: TextPage[];
  outline: DocumentOutlineEntry[];
  warnings: string[];
  cachePath?: string;
  indexState?: number;
  path?: string;
  pageCount?: number;
}

type CreatorLike = {
  fieldMode?: number;
  firstName?: string;
  lastName?: string;
  name?: string;
};

function creatorName(creator: CreatorLike): string {
  if (creator.fieldMode === 1) return creator.name || "";
  return `${creator.firstName || ""} ${creator.lastName || ""}`.trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeMapText(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mapTitleKey(value: string): string {
  return normalizeMapText(value)
    .replace(/\s+/g, "")
    .replace(/[：:]/g, ":")
    .replace(/[—–－-]+/g, "-")
    .toLowerCase();
}

function cleanMapTitle(value: string): string {
  return normalizeMapText(value)
    .replace(/\s+/g, "")
    .replace(/(?:\.|·|…|．)+$/g, "")
    .trim();
}

function inferMapLevel(title: string): number {
  if (/^第[一二三四五六七八九十百]+章/.test(title)) return 1;
  if (/^第[一二三四五六七八九十百]+节/.test(title)) return 2;
  if (/^[一二三四五六七八九十]+、/.test(title)) return 3;
  if (/^本章小结$/.test(title)) return 2;
  return 1;
}

function tocPageScore(text: string): number {
  const value = normalizeMapText(text);
  const titleHit = /目\s*录/.test(value) ? 8 : 0;
  const chapterHits = (value.match(/第[一二三四五六七八九十百]+[章节]/g) || [])
    .length;
  const leaderHits = (value.match(/(?:\.|·|…|．){3,}/g) || []).length;
  const trailingPageHits = (
    value.match(
      /[^\d](?:\d{1,3})(?=\s+(?:第|[一二三四五六七八九十]、|本章|参考|致|攻读|$))/g,
    ) || []
  ).length;
  return titleHit + chapterHits + leaderHits + trailingPageHits;
}

function parseTocEntries(pageTexts: TextPage[]): TocEntry[] {
  const tocPages = pageTexts
    .filter((page) => typeof page.pageIndex !== "number" || page.pageIndex < 40)
    .map((page) => ({ ...page, score: tocPageScore(page.text) }))
    .filter((page) => page.score >= 8)
    .slice(0, 8);
  if (!tocPages.length) return [];

  const joined = normalizeMapText(tocPages.map((page) => page.text).join(" "));
  const pattern =
    /(引\s*言|绪\s*论|结\s*论|第[一二三四五六七八九十百]+章\s*[^.…·．]{2,80}|第[一二三四五六七八九十百]+节\s*[^.…·．]{2,100}|[一二三四五六七八九十]+、\s*[^.…·．]{2,100}|本章小结|参考文献|致\s*谢|攻读学位期间研究成果|附\s*录)\s*(?:\.|·|…|．|\s){2,}\s*(\d{1,4})/g;
  const entries: TocEntry[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(joined))) {
    const title = cleanMapTitle(match[1]);
    const printedPage = Number(match[2]);
    const key = `${title}:${printedPage}`;
    if (!title || !Number.isFinite(printedPage) || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      title,
      printedPage,
      level: inferMapLevel(title),
    });
  }
  return entries;
}

function matchingOutlineOffsets(
  entries: TocEntry[],
  outline: DocumentOutlineEntry[],
): number[] {
  const outlineByTitle = new Map<string, DocumentOutlineEntry[]>();
  for (const entry of outline) {
    if (!entry.pageNumber) continue;
    const key = mapTitleKey(entry.title);
    const list = outlineByTitle.get(key) || [];
    list.push(entry);
    outlineByTitle.set(key, list);
  }
  return entries.flatMap((entry) =>
    (outlineByTitle.get(mapTitleKey(entry.title)) || []).map(
      (outlineEntry) => Number(outlineEntry.pageNumber) - entry.printedPage,
    ),
  );
}

function textHeadingOffsets(
  entries: TocEntry[],
  pageTexts: TextPage[],
): number[] {
  const candidates = entries
    .filter((entry) => entry.title.length >= 2)
    .slice(0, 40);
  const offsets: number[] = [];
  for (const entry of candidates) {
    const key = mapTitleKey(entry.title);
    if (!key) continue;
    for (const page of pageTexts) {
      if (typeof page.pageIndex !== "number") continue;
      const pageKey = mapTitleKey(compact(page.text, 260));
      if (!pageKey.includes(key.slice(0, Math.min(key.length, 18)))) continue;
      offsets.push(page.pageIndex + 1 - entry.printedPage);
      break;
    }
  }
  return offsets;
}

function dominantOffset(offsets: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const offset of offsets.filter(Number.isFinite)) {
    counts.set(offset, (counts.get(offset) || 0) + 1);
  }
  const [offset, count] =
    [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return typeof offset === "number" && Number(count) >= 2 ? offset : undefined;
}

function resolveTocPages(
  entries: TocEntry[],
  outline: DocumentOutlineEntry[],
  pageTexts: TextPage[],
): TocEntry[] {
  if (!entries.length) return [];
  const offset =
    dominantOffset(matchingOutlineOffsets(entries, outline)) ??
    dominantOffset(textHeadingOffsets(entries, pageTexts));
  if (typeof offset !== "number") return [];

  const outlineByTitle = new Map<string, DocumentOutlineEntry[]>();
  for (const entry of outline) {
    if (!entry.pageNumber) continue;
    const key = mapTitleKey(entry.title);
    const list = outlineByTitle.get(key) || [];
    list.push(entry);
    outlineByTitle.set(key, list);
  }

  return entries.map((entry) => {
    const expectedPage = entry.printedPage + offset;
    const closest = (outlineByTitle.get(mapTitleKey(entry.title)) || [])
      .map((candidate) => ({
        candidate,
        distance: Math.abs(Number(candidate.pageNumber) - expectedPage),
      }))
      .sort((a, b) => a.distance - b.distance)[0];
    return {
      ...entry,
      pageNumber:
        closest && closest.distance <= 2
          ? closest.candidate.pageNumber
          : expectedPage,
    };
  });
}

function dataUrlToImageInput(dataUrl?: string): EvidenceImageInput | undefined {
  const match = String(dataUrl || "").match(
    /^data:(image\/(?:jpeg|png));base64,(.+)$/i,
  );
  if (!match) return undefined;
  return {
    media_type: match[1].toLowerCase() as EvidenceImageInput["media_type"],
    data: match[2],
  };
}

const SEARCH_STOPWORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "among",
  "article",
  "because",
  "before",
  "being",
  "below",
  "between",
  "could",
  "does",
  "doing",
  "during",
  "find",
  "from",
  "give",
  "given",
  "have",
  "having",
  "into",
  "main",
  "more",
  "most",
  "only",
  "original",
  "paper",
  "paragraph",
  "quote",
  "sentence",
  "should",
  "source",
  "study",
  "such",
  "than",
  "that",
  "their",
  "then",
  "there",
  "these",
  "this",
  "those",
  "through",
  "using",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function cjkSearchTerms(sequence: string): string[] {
  if (sequence.length <= 4) return [sequence];
  const terms: string[] = [];
  for (let index = 0; index < sequence.length - 1; index += 1) {
    terms.push(sequence.slice(index, index + 2));
  }
  return terms;
}

function tokenize(value: string): string[] {
  const normalized = normalizeForMatch(value);
  const latin = Array.from(
    normalized.matchAll(/[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}-]*/gu),
  )
    .map((match) => match[0])
    .filter(
      (term) => term.length > 2 && !SEARCH_STOPWORDS.has(term.toLowerCase()),
    );
  const cjk = Array.from(normalized.matchAll(/[\p{Script=Han}]{2,}/gu))
    .flatMap((match) => cjkSearchTerms(match[0]))
    .filter((term) => term.length > 1);
  return [...new Set([...latin, ...cjk])].slice(0, 80);
}

function minimumMatchScore(query: string): number {
  const terms = tokenize(query);
  if (!terms.length) return 1;
  if (terms.length === 1) return 1;
  if (terms.length === 2) return 0.5;
  return Math.min(0.4, 2 / terms.length);
}

function scoreText(
  text: string,
  query: string,
): { score: number; reason: string } {
  const q = normalizeForMatch(query);
  const t = normalizeForMatch(text);
  if (!q || !t) return { score: 0, reason: "empty query" };
  const contradiction = detectEvidenceContradiction(t, q);
  if (contradiction) {
    return { score: 0, reason: `possible contradiction: ${contradiction}` };
  }
  if (t.includes(q)) return { score: 1, reason: "exact normalized match" };

  const terms = tokenize(q);
  if (terms.length === 0) return { score: 0, reason: "no comparable terms" };
  const hits = terms.filter((term) => t.includes(term));
  const score = hits.length / Math.max(terms.length, 1);
  return {
    score,
    reason: hits.length
      ? `term overlap: ${hits.slice(0, 8).join(", ")}`
      : "no term overlap",
  };
}

function getItem(itemId: number): Zotero.Item | null {
  try {
    return Zotero.Items.get(itemId) || null;
  } catch {
    return null;
  }
}

async function getItemAsync(itemId: number): Promise<Zotero.Item | null> {
  try {
    return ((await Zotero.Items.getAsync(itemId)) as Zotero.Item) || null;
  } catch {
    return null;
  }
}

function isPdfAttachment(item: Zotero.Item): boolean {
  return (
    item.isAttachment?.() === true &&
    (item.attachmentContentType === "application/pdf" ||
      (
        item as unknown as { isPDFAttachment?: () => boolean }
      ).isPDFAttachment?.() === true)
  );
}

async function resolveEvidenceTarget(payload: {
  itemId?: number;
  attachmentId?: number;
}): Promise<{
  item: Zotero.Item;
  attachment?: Zotero.Item;
  warnings: string[];
} | null> {
  const warnings: string[] = [];
  const attachmentId = Number(payload.attachmentId || 0);
  if (attachmentId) {
    const attachment = await getItemAsync(attachmentId);
    if (!attachment?.isAttachment?.()) return null;
    return {
      item: attachment.parentItem || attachment,
      attachment,
      warnings,
    };
  }

  const itemId = Number(payload.itemId || 0);
  if (!itemId) return null;
  const item = await getItemAsync(itemId);
  if (!item) return null;
  if (item.isAttachment?.()) {
    return { item: item.parentItem || item, attachment: item, warnings };
  }

  if (!item.isRegularItem?.()) return { item, warnings };
  const best = await (
    item as unknown as { getBestAttachment?: () => Promise<Zotero.Item> }
  ).getBestAttachment?.();
  if (best?.isAttachment?.()) return { item, attachment: best, warnings };

  const attachments = await Promise.all(
    item.getAttachments().map((id) => getItemAsync(id)),
  );
  const pdf = attachments.find(
    (attachment): attachment is Zotero.Item =>
      !!attachment && isPdfAttachment(attachment),
  );
  const anyAttachment = attachments.find(
    (attachment): attachment is Zotero.Item => !!attachment?.isAttachment?.(),
  );
  if (!pdf && anyAttachment) {
    warnings.push(
      "No PDF attachment found; using the first attachment for available evidence.",
    );
  }
  return { item, attachment: pdf || anyAttachment, warnings };
}

async function attachmentPath(item: Zotero.Item): Promise<string | undefined> {
  try {
    return (
      (await item.getFilePathAsync()) ||
      (item as unknown as { getFilePath?: () => string }).getFilePath?.() ||
      undefined
    );
  } catch {
    try {
      return (
        (item as unknown as { getFilePath?: () => string }).getFilePath?.() ||
        undefined
      );
    } catch {
      return undefined;
    }
  }
}

async function readFulltextCache(attachment: Zotero.Item): Promise<{
  text: string;
  cachePath?: string;
  indexState?: number;
  warning?: string;
}> {
  const fulltext =
    (
      Zotero as unknown as {
        Fulltext?: _ZoteroTypes.FullText;
        FullText?: _ZoteroTypes.FullText;
      }
    ).Fulltext ||
    (Zotero as unknown as { FullText?: _ZoteroTypes.FullText }).FullText;
  if (!fulltext?.getItemCacheFile) {
    return { text: "", warning: "Zotero full-text cache API is unavailable." };
  }

  let indexState: number | undefined;
  try {
    indexState = await fulltext.getIndexedState(attachment);
  } catch {
    indexState = undefined;
  }

  try {
    const cacheFile = fulltext.getItemCacheFile(attachment) as unknown as {
      path?: string;
      exists?: () => boolean;
    };
    if (cacheFile.exists && !cacheFile.exists()) {
      return {
        text: "",
        cachePath: cacheFile.path,
        indexState,
        warning:
          "No Zotero full-text cache exists for this attachment. Open/index the PDF in Zotero first, or let the agent read the PDF file directly.",
      };
    }
    const cachePath = cacheFile.path;
    if (!cachePath)
      return {
        text: "",
        indexState,
        warning: "Full-text cache path is unavailable.",
      };
    const text = await (
      IOUtils as unknown as { readUTF8: (path: string) => Promise<string> }
    ).readUTF8(cachePath);
    return { text, cachePath, indexState };
  } catch (error) {
    return {
      text: "",
      indexState,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

function splitPages(raw: string): TextPage[] {
  const text = raw
    .replace(/\r/g, "")
    .split(String.fromCharCode(0))
    .join("")
    .trim();
  if (!text) return [];
  if (text.includes("\f")) {
    return text
      .split(/\f+/)
      .map((pageText, index) => ({
        pageIndex: index,
        text: pageText.trim(),
      }))
      .filter((page) => page.text);
  }

  const marker =
    /(?:^|\n)\s*(?:---\s*)?(?:page|p\.|第)\s*([0-9ivxlcdm一二三四五六七八九十百]+)\s*(?:页)?\s*(?:---)?\s*(?=\n)/giu;
  const matches = Array.from(text.matchAll(marker));
  if (matches.length > 1) {
    const pages: TextPage[] = [];
    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const next = matches[i + 1];
      if (current.index === undefined) continue;
      const start = current.index + current[0].length;
      const end = next?.index ?? text.length;
      const pageNo = Number(current[1]);
      pages.push({
        pageIndex: Number.isFinite(pageNo) ? Math.max(0, pageNo - 1) : i,
        text: text.slice(start, end).trim(),
      });
    }
    return pages.filter((page) => page.text);
  }

  return [{ text }];
}

function isCaption(text: string): boolean {
  return /^(?:fig(?:ure)?\.?|table|图|表)\s*[0-9ivxlcdm一二三四五六七八九十百]+[\s:：.-]/i.test(
    text.trim(),
  );
}

function splitParagraphText(text: string): string[] {
  const blocks = text
    .replace(/-\n(?=[a-z])/g, "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length > 1) return blocks;

  const paragraphs: string[] = [];
  let current = "";
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current.trim()) paragraphs.push(current.trim());
      current = "";
      continue;
    }
    if (current && isCaption(line)) {
      paragraphs.push(current.trim());
      current = line;
      continue;
    }
    const joiner = current && !/[。！？.!?:：;；]$/.test(current) ? " " : "\n";
    current = current ? `${current}${joiner}${line}` : line;
    if (current.length > 1200 && /[。！？.!?]$/.test(line)) {
      paragraphs.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs;
}

function itemRect(item: PdfJsTextItem): number[] | null {
  const transform = item.transform || [];
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  const width = Number(item.width || 0);
  const height = Number(
    item.height || Math.abs(transform[3] || transform[0]) || 0,
  );
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const yPadding = Math.max(1.5, height * 0.35);
  return [
    x,
    y - yPadding,
    x + Math.max(width, 0),
    y + Math.max(height, 0) + yPadding,
  ];
}

function compactRects(rects: number[][]): number[][] {
  return rects
    .filter((rect) => rect.length === 4 && rect.every(Number.isFinite))
    .map((rect) => rect.map((value) => Number(value.toFixed(3))));
}

function boundingRect(rects: number[][]): number[] | null {
  const valid = compactRects(rects);
  if (!valid.length) return null;
  return [
    Math.min(...valid.map((rect) => rect[0])),
    Math.min(...valid.map((rect) => rect[1])),
    Math.max(...valid.map((rect) => rect[2])),
    Math.max(...valid.map((rect) => rect[3])),
  ];
}

function flushPdfJsLine(
  lines: PdfJsLine[],
  pageIndex: number,
  line: { text: string; items: PdfJsTextItem[]; rects: number[][] },
): void {
  const text = line.text.replace(/\s+/g, " ").trim();
  if (!text) return;
  lines.push({
    text,
    items: [...line.items],
    rects: compactRects(line.rects),
    pageIndex,
  });
  line.text = "";
  line.items = [];
  line.rects = [];
}

function flushReaderCharLine(
  lines: PdfJsLine[],
  pageIndex: number,
  line: { text: string; rects: number[][] },
): void {
  const text = line.text.replace(/\s+/g, " ").trim();
  const rect = boundingRect(line.rects);
  if (text && rect) {
    lines.push({
      text,
      items: [],
      rects: compactRects([rect]),
      pageIndex,
    });
  }
  line.text = "";
  line.rects = [];
}

function readerCharsToLines(
  chars: ZoteroReaderChar[] | undefined,
  pageIndex: number,
): PdfJsLine[] {
  if (!Array.isArray(chars) || !chars.length) return [];
  const lines: PdfJsLine[] = [];
  const line = { text: "", rects: [] as number[][] };
  for (const char of chars) {
    if (!char.ignorable) {
      const text = String(char.c || "");
      if (text) line.text += text;
      const rect = Array.isArray(char.inlineRect) ? char.inlineRect : char.rect;
      if (
        Array.isArray(rect) &&
        rect.length === 4 &&
        rect.every((value) => Number.isFinite(Number(value)))
      ) {
        line.rects.push(rect.map((value) => Number(value)));
      }
      if (char.spaceAfter) line.text += " ";
    }
    if (char.lineBreakAfter || char.paragraphBreakAfter) {
      flushReaderCharLine(lines, pageIndex, line);
    }
    if (char.paragraphBreakAfter) {
      lines.push({ text: "", items: [], rects: [], pageIndex });
    }
  }
  flushReaderCharLine(lines, pageIndex, line);
  return lines;
}

function linesToParagraphs(lines: PdfJsLine[]): Array<{
  text: string;
  lines: EvidenceLine[];
  rects: number[][];
  pageIndex: number;
}> {
  const paragraphs: Array<{
    text: string;
    lines: EvidenceLine[];
    rects: number[][];
    pageIndex: number;
  }> = [];
  let current: PdfJsLine[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current
      .map((line) => line.text)
      .join("\n")
      .trim();
    if (text.length >= 40 || isCaption(text)) {
      paragraphs.push({
        text,
        lines: current.map((line) => ({
          text: line.text,
          rects: line.rects,
          pageIndex: line.pageIndex,
        })),
        rects: compactRects(current.flatMap((line) => line.rects)),
        pageIndex: current[0].pageIndex,
      });
    }
    current = [];
  };

  for (const line of lines) {
    if (!line.text.trim()) {
      flush();
      continue;
    }
    if (current.length && isCaption(line.text)) flush();
    current.push(line);
    const text = current.map((entry) => entry.text).join(" ");
    if (
      text.length > 900 ||
      (text.length > 260 && /[。！？.!?]$/.test(line.text))
    ) {
      flush();
    }
  }
  flush();
  return paragraphs;
}

function getReaderForAttachment(attachmentId: number): any | null {
  try {
    const mainWin = Zotero.getMainWindow() as any;
    const readerApi = mainWin?.Zotero?.Reader || (Zotero as any).Reader;
    const selectedID = mainWin?.Zotero_Tabs?.selectedID;
    const selectedReader = selectedID
      ? readerApi?.getByTabID?.(selectedID)
      : null;
    if (selectedReader?._item?.id === attachmentId) return selectedReader;
    const readers = readerApi?._readers;
    if (Array.isArray(readers)) {
      return (
        readers.find(
          (reader: any) =>
            reader?._item?.id === attachmentId ||
            reader?.itemID === attachmentId,
        ) || null
      );
    }
  } catch {
    return null;
  }
  return null;
}

function getPdfJsAppContext(attachmentId: number): PdfJsAppContext | null {
  const reader = getReaderForAttachment(attachmentId);
  if (!reader) return null;
  try {
    const Cu = (globalThis as any).Components?.utils;
    const rawInternal = reader._internalReader;
    const internal =
      Cu?.waiveXrays && rawInternal ? Cu.waiveXrays(rawInternal) : rawInternal;
    const view = internal?._lastView || internal?._primaryView;
    const iframeWin = view?._iframeWindow;
    const app =
      iframeWin?.wrappedJSObject?.PDFViewerApplication ||
      iframeWin?.PDFViewerApplication;
    const pages = app?.pdfViewer?._pages;
    if (!app || !Array.isArray(pages) || pages.length === 0) return null;
    return {
      app,
      pages,
      internalReader: internal,
      view,
      primaryView: internal?._primaryView,
    };
  } catch {
    return null;
  }
}

async function waitForPdfJsPages(context: PdfJsAppContext): Promise<void> {
  await context.app.pdfLoadingTask?.promise;
  await context.app.pdfViewer?.pagesPromise;
}

async function extractPdfJsOutline(
  attachment: Zotero.Item | undefined,
): Promise<DocumentOutlineEntry[]> {
  if (!attachment) return [];
  const context = getPdfJsAppContext(attachment.id);
  if (!context) return [];
  try {
    await waitForPdfJsPages(context);
    const pdfDocument =
      context.app.pdfDocument ||
      (context.app.pdfLoadingTask?.promise
        ? await context.app.pdfLoadingTask.promise
        : undefined);
    const outline = await pdfDocument?.getOutline?.();
    if (!Array.isArray(outline)) return [];

    const destinationPageNumber = async (
      dest: unknown,
    ): Promise<number | undefined> => {
      try {
        const resolved =
          typeof dest === "string"
            ? await pdfDocument.getDestination(dest)
            : dest;
        if (!Array.isArray(resolved) || !resolved[0]) return undefined;
        const pageIndex = await pdfDocument.getPageIndex(resolved[0]);
        return typeof pageIndex === "number" ? pageIndex + 1 : undefined;
      } catch {
        return undefined;
      }
    };

    const out: DocumentOutlineEntry[] = [];
    const walk = async (items: any[], level: number): Promise<void> => {
      for (const item of items) {
        const title = normalizeMapText(String(item?.title || ""));
        if (title) {
          out.push({
            title,
            pageNumber: await destinationPageNumber(item.dest),
            level,
          });
        }
        if (Array.isArray(item?.items) && item.items.length) {
          await walk(item.items, level + 1);
        }
      }
    };
    await walk(outline, 1);
    return out.filter((entry) => entry.title);
  } catch {
    return [];
  }
}

function canvasFromPageView(pageView: any): HTMLCanvasElement | null {
  const canvas =
    pageView?.canvas ||
    pageView?.div?.querySelector?.("canvas") ||
    pageView?.canvasWrapper?.querySelector?.("canvas");
  // Reader canvases belong to the PDF iframe's realm, so checking them with
  // the plugin window's HTMLCanvasElement rejects valid rendered pages.
  return isRenderableCanvasLike(canvas) ? (canvas as HTMLCanvasElement) : null;
}

function pageImageFallback(
  attachment: Zotero.Item | undefined,
  pageIndex: number,
  warning?: string,
): EvidencePageImage {
  return {
    pageIndex,
    pageNumber: pageIndex + 1,
    source: "open-pdf-uri",
    openUri: makeOpenPdfUri(attachment, pageIndex),
    warning,
  };
}

function scaledCanvasDataUrl(
  canvas: HTMLCanvasElement,
  maxWidth: number,
): {
  dataUrl: string;
  width: number;
  height: number;
  mediaType: "image/jpeg";
} | null {
  const width = Number(canvas.width || 0);
  const height = Number(canvas.height || 0);
  if (!width || !height) return null;

  const targetWidth = Math.min(Math.max(320, maxWidth), width);
  const scale = targetWidth / width;
  const targetHeight = Math.max(1, Math.round(height * scale));
  const doc = canvas.ownerDocument || globalThis.document;
  const out = doc.createElement("canvas");
  out.width = Math.round(targetWidth);
  out.height = targetHeight;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return {
    dataUrl: out.toDataURL("image/jpeg", 0.82),
    width: out.width,
    height: out.height,
    mediaType: "image/jpeg",
  };
}

async function pdfJsPageViewBox(
  context: PdfJsAppContext,
  pageIndex: number,
): Promise<[number, number, number, number] | null> {
  const pageView = context.pages[pageIndex];
  const cached =
    figurePageViewBox(context.view?._pdfPages?.[pageIndex]?.viewBox) ||
    figurePageViewBox(pageView?.pdfPage?._pageInfo?.view) ||
    figurePageViewBox(pageView?.pdfPage?.view);
  if (cached) return cached;

  const pdfDocument =
    context.app.pdfDocument ||
    (context.app.pdfLoadingTask?.promise
      ? await context.app.pdfLoadingTask.promise
      : undefined);
  const pdfPage = await pdfDocument?.getPage?.(pageIndex + 1);
  return figurePageViewBox(pdfPage?.view);
}

async function scaledImageDataUrl(
  dataUrl: string,
  doc: Document,
  maxWidth: number,
): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  mediaType: "image/jpeg";
} | null> {
  const image = doc.createElement("img");
  await new Promise<void>((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("Rendered PDF page image could not be decoded.")),
      { once: true },
    );
    image.src = dataUrl;
  });

  const sourceWidth = Number(image.naturalWidth || image.width || 0);
  const sourceHeight = Number(image.naturalHeight || image.height || 0);
  if (!sourceWidth || !sourceHeight) return null;
  const targetWidth = Math.min(Math.max(320, maxWidth), sourceWidth);
  const scale = targetWidth / sourceWidth;
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
  const out = doc.createElement("canvas");
  out.width = Math.round(targetWidth);
  out.height = targetHeight;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(image, 0, 0, out.width, out.height);
  return {
    dataUrl: out.toDataURL("image/jpeg", 0.82),
    width: out.width,
    height: out.height,
    mediaType: "image/jpeg",
  };
}

async function renderPdfJsPageImage(
  context: PdfJsAppContext,
  pageIndex: number,
  maxWidth: number,
): Promise<{
  dataUrl: string;
  width: number;
  height: number;
  mediaType: "image/jpeg";
} | null> {
  const renderer = context.view?._pdfRenderer;
  if (typeof renderer?._renderAnnotationImage !== "function") return null;
  const viewBox = await pdfJsPageViewBox(context, pageIndex);
  if (!viewBox) return null;

  const request = {
    position: { pageIndex, rects: [viewBox] },
    // Required by Zotero's annotation-image renderer; this is not a UI color.
    color: "#eee",
  };
  const Cu = (globalThis as any).Components?.utils;
  const clonedRequest =
    Cu?.cloneInto && context.primaryView
      ? Cu.cloneInto(request, context.primaryView)
      : request;
  const rawDataUrl = await renderer._renderAnnotationImage(clonedRequest);
  if (typeof rawDataUrl !== "string" || !rawDataUrl.startsWith("data:image/")) {
    return null;
  }
  const doc =
    context.primaryView?._iframeWindow?.document ||
    context.view?._iframeWindow?.document ||
    globalThis.document;
  return doc ? scaledImageDataUrl(rawDataUrl, doc, maxWidth) : null;
}

async function capturePdfJsPageImage(options: {
  attachment?: Zotero.Item;
  pageIndex: number;
  includeDataUrl: boolean;
  maxWidth: number;
}): Promise<EvidencePageImage | undefined> {
  const { attachment, pageIndex } = options;
  if (!attachment || typeof pageIndex !== "number" || pageIndex < 0) {
    return undefined;
  }
  if (!options.includeDataUrl) {
    return pageImageFallback(attachment, pageIndex);
  }

  const context = getPdfJsAppContext(attachment.id);
  if (!context) {
    return pageImageFallback(
      attachment,
      pageIndex,
      "PDF.js page screenshot is available only when the attachment is open in Zotero Reader.",
    );
  }

  try {
    await waitForPdfJsPages(context);
    const pageView = context.pages[pageIndex];
    const canvas = canvasFromPageView(pageView);
    const failures: string[] = [];
    let image: ReturnType<typeof scaledCanvasDataUrl> = null;
    if (canvas) {
      try {
        image = scaledCanvasDataUrl(canvas, options.maxWidth);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!image) {
      try {
        image = await renderPdfJsPageImage(
          context,
          pageIndex,
          options.maxWidth,
        );
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!image) {
      return pageImageFallback(
        attachment,
        pageIndex,
        `Zotero could not render the requested PDF page as a screenshot.${
          failures.length ? ` ${failures.join("; ")}` : ""
        }`,
      );
    }
    return {
      pageIndex,
      pageNumber: pageIndex + 1,
      source: "pdfjs-canvas",
      openUri: makeOpenPdfUri(attachment, pageIndex),
      ...image,
    };
  } catch (error) {
    return pageImageFallback(
      attachment,
      pageIndex,
      `PDF.js page screenshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function makeOpenPdfUri(
  attachment: Zotero.Item | undefined,
  pageIndex?: number,
  annotationKey?: string,
): string | undefined {
  if (!attachment?.key) return undefined;
  const params = new URLSearchParams();
  if (typeof pageIndex === "number") params.set("page", String(pageIndex + 1));
  if (annotationKey) params.set("annotation", annotationKey);
  const suffix = params.toString();
  return `zotero://open-pdf/library/items/${attachment.key}${suffix ? `?${suffix}` : ""}`;
}

function makeEvidenceUri(
  locator: Omit<EvidenceLocator, "evidenceUri">,
): string | undefined {
  if (!locator.attachmentId) return undefined;
  const compactLocator = {
    itemId: locator.itemId,
    itemKey: locator.itemKey,
    attachmentId: locator.attachmentId,
    attachmentKey: locator.attachmentKey,
    title: locator.title,
    excerpt: locator.excerpt ? compact(locator.excerpt, 520) : undefined,
    sourceType: locator.sourceType,
    pageIndex: locator.pageIndex,
    pageNumber: locator.pageNumber,
    paragraphIndex: locator.paragraphIndex,
    annotationId: locator.annotationId,
    annotationKey: locator.annotationKey,
    openUri: locator.openUri,
    position: locator.position
      ? {
          pageIndex: locator.position.pageIndex,
          rects: locator.position.rects?.slice(0, 48),
          nextPageRects: locator.position.nextPageRects?.slice(0, 48),
        }
      : undefined,
  };
  return `claudero-evidence:${encodeEvidenceReference(compactLocator)}`;
}

function evidenceMarkdownLink(
  locator: EvidenceLocator | undefined,
  label: string,
): string {
  return locator
    ? encodeEvidenceMarker(locator as unknown as Record<string, unknown>)
    : markdownCell(label);
}

function normalizeEvidencePosition(
  position: EvidencePosition | undefined,
): EvidencePosition | undefined {
  if (!position || typeof position.pageIndex !== "number") return position;
  if (!position.lines?.length) {
    return {
      ...position,
      rects: compactRects(position.rects || []),
      nextPageRects: compactRects(position.nextPageRects || []),
    };
  }
  const rects = compactRects(
    position.lines
      .filter((line) => line.pageIndex === position.pageIndex)
      .flatMap((line) => line.rects),
  );
  const nextPageRects = compactRects(
    position.lines
      .filter((line) => line.pageIndex === position.pageIndex + 1)
      .flatMap((line) => line.rects),
  );
  return {
    ...position,
    rects,
    nextPageRects,
  };
}

function itemMetadata(item: Zotero.Item): EvidencePack["item"] {
  return {
    id: item.id,
    key: item.key,
    title: item.getDisplayTitle?.() || String(item.getField("title") || ""),
    creators: item.getCreators().map(creatorName).filter(Boolean).slice(0, 8),
    year: (String(item.getField("date") || "").match(/\d{4}/) || [])[0] || "",
    DOI: String(item.getField("DOI") || ""),
  };
}

function paragraphEvidence(options: {
  text: string;
  item: Zotero.Item;
  attachment?: Zotero.Item;
  sourceType: EvidenceLocator["sourceType"];
  pageIndex?: number;
  paragraphIndex: number;
  idPrefix: string;
  position?: EvidencePosition;
}): EvidenceParagraph {
  const locator: Omit<EvidenceLocator, "evidenceUri"> = {
    itemId: options.item.id,
    itemKey: options.item.key,
    attachmentId: options.attachment?.id,
    attachmentKey: options.attachment?.key,
    title:
      options.item.getDisplayTitle?.() ||
      String(options.item.getField("title") || ""),
    excerpt: compact(options.text, 520),
    sourceType: options.sourceType,
    pageIndex: options.pageIndex,
    pageNumber:
      typeof options.pageIndex === "number" ? options.pageIndex + 1 : undefined,
    paragraphIndex: options.paragraphIndex,
    position: normalizeEvidencePosition(options.position),
    openUri: makeOpenPdfUri(options.attachment, options.pageIndex),
  };
  const id = `${options.idPrefix}-${options.paragraphIndex + 1}`;
  const evidenceLocator = {
    ...locator,
    evidenceUri: makeEvidenceUri(locator),
  };
  return {
    id,
    text: compact(options.text, 2400),
    locator: evidenceLocator,
    markdownLink: evidenceMarkdownLink(evidenceLocator, id),
  };
}

async function extractPdfJsParagraphEvidence(
  item: Zotero.Item,
  attachment: Zotero.Item,
  maxPages: number,
): Promise<{
  paragraphs: EvidenceParagraph[];
  warnings: string[];
  pageTexts: TextPage[];
  pageCount?: number;
}> {
  const context = getPdfJsAppContext(attachment.id);
  if (!context) return { paragraphs: [], warnings: [], pageTexts: [] };

  try {
    await waitForPdfJsPages(context);

    const warnings: string[] = [];
    const pageLimit = Math.max(
      1,
      Math.min(Number(maxPages || 120), context.pages.length),
    );
    if (pageLimit < context.pages.length) {
      warnings.push(
        `PDF.js evidence extraction limited to ${pageLimit}/${context.pages.length} pages.`,
      );
    }

    const lines: PdfJsLine[] = [];
    const pageTexts: TextPage[] = [];
    for (let pageIndex = 0; pageIndex < pageLimit; pageIndex += 1) {
      try {
        await context.internalReader?._ensureBasicPageData?.(pageIndex);
        const readerLines = readerCharsToLines(
          context.internalReader?._pdfPages?.[pageIndex]?.chars,
          pageIndex,
        );
        if (readerLines.length) {
          lines.push(...readerLines);
          pageTexts.push({
            pageIndex,
            text: readerLines.map((line) => line.text).join("\n"),
          });
          continue;
        }
      } catch {
        // Fall back to PDF.js text content below when Reader char data is unavailable.
      }

      const pageView = context.pages[pageIndex];
      const textContent = await pageView?.pdfPage?.getTextContent?.();
      const rawItems = Array.isArray(textContent?.items)
        ? (textContent.items as PdfJsTextItem[])
        : [];
      const pageLines: PdfJsLine[] = [];
      const line = {
        text: "",
        items: [] as PdfJsTextItem[],
        rects: [] as number[][],
      };
      for (const textItem of rawItems) {
        const str = String(textItem.str || "");
        if (str) {
          line.text += str;
          line.items.push(textItem);
          const rect = itemRect(textItem);
          if (rect) line.rects.push(rect);
        }
        if (textItem.hasEOL) flushPdfJsLine(lines, pageIndex, line);
      }
      flushPdfJsLine(lines, pageIndex, line);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const candidate = lines[index];
        if (candidate.pageIndex !== pageIndex) break;
        pageLines.unshift(candidate);
      }
      pageTexts.push({
        pageIndex,
        text: pageLines.map((entry) => entry.text).join("\n"),
      });
    }

    return {
      paragraphs: linesToParagraphs(lines).map((paragraph, index) =>
        paragraphEvidence({
          text: paragraph.text,
          item,
          attachment,
          sourceType: "pdfjs",
          pageIndex: paragraph.pageIndex,
          paragraphIndex: index,
          idPrefix: "para",
          position: {
            pageIndex: paragraph.pageIndex,
            rects: paragraph.rects,
            lines: paragraph.lines,
          },
        }),
      ),
      warnings,
      pageTexts,
      pageCount: context.pages.length,
    };
  } catch (error) {
    return {
      paragraphs: [],
      warnings: [
        `PDF.js evidence extraction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      pageTexts: [],
      pageCount: context.pages.length,
    };
  }
}

function rankParagraphs(
  paragraphs: EvidenceParagraph[],
  query = "",
  maxParagraphs = 12,
): EvidenceParagraph[] {
  const trimmedQuery = query.trim();
  const minimumScore = trimmedQuery ? minimumMatchScore(trimmedQuery) : 0;
  const scored = paragraphs.map((paragraph) => {
    const score = trimmedQuery
      ? scoreText(paragraph.text, trimmedQuery)
      : { score: 0.5, reason: "document order" };
    return { ...paragraph, score: score.score, matchReason: score.reason };
  });
  const ranked = trimmedQuery
    ? scored.filter((paragraph) => (paragraph.score || 0) >= minimumScore)
    : scored;
  ranked.sort((a, b) => {
    if (trimmedQuery && (b.score || 0) !== (a.score || 0))
      return (b.score || 0) - (a.score || 0);
    return (a.locator.paragraphIndex || 0) - (b.locator.paragraphIndex || 0);
  });
  return ranked
    .slice(0, Math.max(1, Math.min(maxParagraphs, 50)))
    .map((paragraph) =>
      trimmedQuery ? focusParagraphOnQuery(paragraph, trimmedQuery) : paragraph,
    );
}

function figureTablePageContext(
  paragraphs: EvidenceParagraph[],
  index: number,
): EvidenceFigureTableContext | undefined {
  const paragraph = paragraphs[index];
  const pageIndex = paragraph.locator.pageIndex;
  if (typeof pageIndex !== "number") return undefined;
  const samePage = paragraphs.filter(
    (entry) => entry.locator.pageIndex === pageIndex,
  );
  const before = paragraphs
    .slice(Math.max(0, index - 2), index)
    .filter((entry) => entry.locator.pageIndex === pageIndex)
    .map((entry) => compact(entry.text, 420));
  const after = paragraphs
    .slice(index + 1, index + 3)
    .filter((entry) => entry.locator.pageIndex === pageIndex)
    .map((entry) => compact(entry.text, 420));

  return {
    before,
    after,
    samePageEvidenceIds: samePage.map((entry) => entry.id).slice(0, 16),
    rects: paragraph.locator.position?.rects?.slice(0, 48),
  };
}

function extractFigureTableCandidates(
  paragraphs: EvidenceParagraph[],
  pageImages = new Map<number, EvidencePageImage>(),
): EvidenceFigureTableCandidate[] {
  const candidates: EvidenceFigureTableCandidate[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    const firstLine =
      paragraph.text
        .split(/\n/)
        .map((line) => line.trim())
        .find(Boolean) || "";
    const match = firstLine.match(
      /^(fig(?:ure)?\.?|table|图|表)\s*([0-9ivxlcdm一二三四五六七八九十百]+)[\s:：.-]*/i,
    );
    if (!match) continue;
    const rawKind = match[1].toLowerCase();
    candidates.push({
      kind: rawKind.startsWith("tab") || rawKind === "表" ? "table" : "figure",
      label: `${match[1]} ${match[2]}`,
      caption: compact(paragraph.text, 900),
      locator: paragraph.locator,
      pageImage:
        typeof paragraph.locator.pageIndex === "number"
          ? pageImages.get(paragraph.locator.pageIndex)
          : undefined,
      pageContext: figureTablePageContext(paragraphs, index),
    });
  }
  return candidates.slice(0, 20);
}

async function figureTablePageImages(options: {
  candidates: EvidenceFigureTableCandidate[];
  attachment?: Zotero.Item;
  includeDataUrls: boolean;
  maxPageImages: number;
  maxWidth: number;
}): Promise<Map<number, EvidencePageImage>> {
  const out = new Map<number, EvidencePageImage>();
  const pageIndexes = [
    ...new Set(
      options.candidates
        .map((candidate) => candidate.locator.pageIndex)
        .filter(
          (pageIndex): pageIndex is number => typeof pageIndex === "number",
        ),
    ),
  ];
  let dataUrlCount = 0;
  for (const pageIndex of pageIndexes) {
    const includeDataUrl =
      options.includeDataUrls && dataUrlCount < options.maxPageImages;
    const image = await capturePdfJsPageImage({
      attachment: options.attachment,
      pageIndex,
      includeDataUrl,
      maxWidth: options.maxWidth,
    });
    if (image) out.set(pageIndex, image);
    if (includeDataUrl && image?.dataUrl) dataUrlCount += 1;
  }
  return out;
}

function parseAnnotationPosition(
  position: unknown,
): EvidencePosition | undefined {
  if (typeof position !== "string" || !position) return undefined;
  try {
    const parsed = JSON.parse(position) as EvidencePosition;
    return typeof parsed.pageIndex === "number"
      ? {
          pageIndex: parsed.pageIndex,
          rects: Array.isArray(parsed.rects)
            ? compactRects(parsed.rects)
            : undefined,
          lines: Array.isArray(parsed.lines) ? parsed.lines : undefined,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function annotationEvidence(
  item: Zotero.Item,
  attachment?: Zotero.Item,
): Promise<EvidenceParagraph[]> {
  const attachments = attachment
    ? [attachment]
    : item.isRegularItem?.()
      ? (
          await Promise.all(item.getAttachments().map((id) => getItemAsync(id)))
        ).filter((att): att is Zotero.Item => !!att?.isAttachment?.())
      : [];
  const out: EvidenceParagraph[] = [];
  for (const att of attachments) {
    let annotations: any[] = [];
    try {
      const raw = await (
        att as unknown as { getAnnotations?: () => Promise<any[]> }
      ).getAnnotations?.();
      annotations = Array.isArray(raw)
        ? typeof raw[0] === "number"
          ? ((await Zotero.Items.getAsync(raw as number[])) as any[]).filter(
              Boolean,
            )
          : raw.filter(Boolean)
        : [];
    } catch {
      annotations = [];
    }
    for (const annotation of annotations) {
      const page = parseAnnotationPosition(annotation.annotationPosition);
      const text = [
        String(annotation.annotationText || "").trim(),
        annotation.annotationComment
          ? `Comment: ${annotation.annotationComment}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (!text) continue;
      const locator: Omit<EvidenceLocator, "evidenceUri"> = {
        itemId: item.id,
        itemKey: item.key,
        attachmentId: att.id,
        attachmentKey: att.key,
        title: item.getDisplayTitle?.() || String(item.getField("title") || ""),
        excerpt: compact(text, 520),
        sourceType: "annotation",
        pageIndex: page?.pageIndex,
        pageNumber:
          typeof page?.pageIndex === "number" ? page.pageIndex + 1 : undefined,
        annotationId: annotation.id,
        annotationKey: annotation.key,
        position: page,
        openUri: makeOpenPdfUri(att, page?.pageIndex, annotation.key),
      };
      const id = `anno-${annotation.id}`;
      const evidenceLocator = {
        ...locator,
        evidenceUri: makeEvidenceUri(locator),
      };
      out.push({
        id,
        text: compact(text, 1800),
        locator: evidenceLocator,
        markdownLink: evidenceMarkdownLink(evidenceLocator, id),
      });
    }
  }
  return out;
}

async function collectEvidenceCorpus(payload: {
  itemId?: number;
  attachmentId?: number;
  maxPages?: number;
  includeAnnotations?: boolean;
}): Promise<EvidenceCorpus | { error: string }> {
  const target = await resolveEvidenceTarget(payload);
  if (!target)
    return {
      error: "Pass itemId or attachmentId for a Zotero item with evidence.",
    };

  const { item, attachment } = target;
  const warnings = [...target.warnings];
  const annotations =
    payload.includeAnnotations === false
      ? []
      : await annotationEvidence(item, attachment);
  const paragraphs: EvidenceParagraph[] = [];
  let pageTexts: TextPage[] = [];
  let outline: DocumentOutlineEntry[] = [];
  let cachePath: string | undefined;
  let indexState: number | undefined;
  let pageCount: number | undefined;

  if (attachment) {
    outline = await extractPdfJsOutline(attachment);
    const precise = await extractPdfJsParagraphEvidence(
      item,
      attachment,
      Number(payload.maxPages || 120),
    );
    paragraphs.push(...precise.paragraphs);
    warnings.push(...precise.warnings);
    pageTexts = precise.pageTexts;
    pageCount = precise.pageCount;

    if (paragraphs.length === 0) {
      const cache = await readFulltextCache(attachment);
      cachePath = cache.cachePath;
      indexState = cache.indexState;
      if (cache.warning) warnings.push(cache.warning);
      const pages = splitPages(cache.text);
      pageTexts = pages;
      if (pages.length) pageCount = pages.length;
      let paragraphIndex = 0;
      for (const page of pages) {
        for (const text of splitParagraphText(page.text)) {
          if (text.length < 40) continue;
          paragraphs.push(
            paragraphEvidence({
              text,
              item,
              attachment,
              sourceType: "fulltext",
              pageIndex: page.pageIndex,
              paragraphIndex,
              idPrefix: "para",
            }),
          );
          paragraphIndex += 1;
        }
      }
    }
  }

  if (paragraphs.length === 0) {
    const metadataText = [
      item.getDisplayTitle?.() || item.getField("title"),
      stripHtml(String(item.getField("abstractNote") || "")),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (metadataText.trim()) {
      paragraphs.push(
        paragraphEvidence({
          text: metadataText,
          item,
          attachment,
          sourceType: "metadata",
          paragraphIndex: 0,
          idPrefix: "meta",
        }),
      );
    }
  }

  const path = attachment ? await attachmentPath(attachment) : undefined;
  return {
    item,
    attachment,
    paragraphs,
    annotations,
    pageTexts,
    outline,
    warnings,
    cachePath,
    indexState,
    path,
    pageCount,
  };
}

export async function buildEvidencePack(payload: {
  itemId?: number;
  attachmentId?: number;
  query?: string;
  maxParagraphs?: number;
  maxPages?: number;
  includeAnnotations?: boolean;
  includePageImages?: boolean;
  maxPageImages?: number;
  pageImageMaxWidth?: number;
}): Promise<EvidencePack | { error: string }> {
  const corpus = await collectEvidenceCorpus({
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
    maxPages: payload.maxPages,
    includeAnnotations: payload.includeAnnotations,
  });
  if ("error" in corpus) return corpus;

  const {
    item,
    attachment,
    paragraphs,
    annotations,
    warnings,
    cachePath,
    indexState,
    path,
  } = corpus;

  const rankedParagraphs = rankParagraphs(
    paragraphs,
    String(payload.query || ""),
    Number(payload.maxParagraphs || 12),
  );
  const rankedAnnotations = rankParagraphs(
    annotations,
    String(payload.query || ""),
    Math.min(Number(payload.maxParagraphs || 12), 20),
  );
  if (
    String(payload.query || "").trim() &&
    rankedParagraphs.length === 0 &&
    rankedAnnotations.length === 0
  ) {
    warnings.push(
      "No reliable lexical evidence match found for the query. Use more specific source-language terms or call locate_quote with an exact quote before citing.",
    );
  }
  const figureTableQuery = /(?:\bfig(?:ure)?\b|\btable\b|图|表)/i.test(
    String(payload.query || ""),
  );
  const figureTableCandidates =
    payload.includePageImages === true || figureTableQuery
      ? extractFigureTableCandidates(paragraphs)
      : [];
  const figureTableImages = await figureTablePageImages({
    candidates: figureTableCandidates,
    attachment,
    includeDataUrls: payload.includePageImages === true,
    maxPageImages: Math.max(
      0,
      Math.min(Number(payload.maxPageImages || 3), 12),
    ),
    maxWidth: Math.max(
      640,
      Math.min(Number(payload.pageImageMaxWidth || 1200), 1800),
    ),
  });

  return {
    item: itemMetadata(item),
    attachment: attachment
      ? {
          id: attachment.id,
          key: attachment.key,
          title: attachment.getDisplayTitle?.() || "",
          path,
          cachePath,
          indexState,
        }
      : undefined,
    query: payload.query,
    paragraphs: rankedParagraphs,
    annotations: rankedAnnotations,
    figuresTables:
      figureTableCandidates.length > 0
        ? extractFigureTableCandidates(paragraphs, figureTableImages)
        : [],
    warnings,
    citationGuidance: [
      "Copy each markdownLink marker exactly before sentence-ending punctuation, for example: 支持的句子[Eabc123]。 Do not expand it into a URI or Markdown link; the UI resolves the marker to a quiet clickable number. Avoid labels such as Evidence:, Source:, References:, or 证据: unless the user explicitly asks for an audit table.",
      "Direct quotes must appear verbatim in an evidence paragraph or annotation; otherwise label them as paraphrases.",
      "Prefer paragraph or annotation evidence over item-level metadata for empirical claims.",
      "For figure/table claims, inspect the candidate pageImage when available; treat the full rendered page as the visual source of truth for captions, figures, tables, and surrounding interpretation.",
      "If pageImage contains only an openUri, open that PDF page or request includePageImages=true while the attachment is open in Zotero Reader.",
    ],
  };
}

function sourceId(prefix: string, index: number): string {
  return `${prefix}${String(index + 1).padStart(4, "0")}`;
}

function sourceKind(
  paragraph: EvidenceParagraph,
): NumberedEvidenceSource["kind"] {
  if (paragraph.locator.sourceType === "annotation") return "annotation";
  if (paragraph.locator.sourceType === "metadata") return "metadata";
  return "paragraph";
}

function numberEvidenceSources(
  corpus: EvidenceCorpus,
): NumberedEvidenceSource[] {
  let paragraphIndex = 0;
  let annotationIndex = 0;
  let metadataIndex = 0;
  const toSource = (paragraph: EvidenceParagraph): NumberedEvidenceSource => {
    const kind = sourceKind(paragraph);
    const id =
      kind === "annotation"
        ? sourceId("A", annotationIndex++)
        : kind === "metadata"
          ? sourceId("M", metadataIndex++)
          : sourceId("P", paragraphIndex++);
    return {
      sourceId: id,
      kind,
      text: paragraph.text,
      locator: paragraph.locator,
      citationMarkdown: evidenceMarkdownLink(paragraph.locator, id),
      pageNumber: paragraph.locator.pageNumber,
      paragraphIndex: paragraph.locator.paragraphIndex,
    };
  };
  return [...corpus.paragraphs, ...corpus.annotations].map(toSource);
}

function sourceLocationLabel(source: NumberedEvidenceSource): string {
  return [
    source.pageNumber ? `p. ${source.pageNumber}` : "",
    typeof source.paragraphIndex === "number"
      ? `para ${source.paragraphIndex + 1}`
      : "",
    source.kind === "annotation" ? "annotation" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function numberedContextLine(source: NumberedEvidenceSource): string {
  const location = sourceLocationLabel(source);
  return [
    `${source.citationMarkdown}${location ? ` ${location}` : ""}`,
    compact(source.text, 2400),
  ].join("\n");
}

function numberedContextText(sources: NumberedEvidenceSource[]): string {
  return sources.map(numberedContextLine).join("\n\n");
}

function lineQueryScore(line: EvidenceLine, query: string): number {
  return scoreText(line.text, query).score;
}

function focusedLinesForQuery(
  lines: EvidenceLine[] | undefined,
  query: string,
): EvidenceLine[] {
  if (!Array.isArray(lines) || !lines.length || !query.trim()) return [];
  const threshold = Math.max(0.18, minimumMatchScore(query) * 0.65);
  const scored = lines.map((line, index) => ({
    line,
    index,
    score: lineQueryScore(line, query),
  }));
  const matching = scored.filter((entry) => entry.score >= threshold);
  const selected = matching.length
    ? matching
    : scored.filter((entry) => entry.score > 0);
  if (!selected.length) return [];

  const best = selected.reduce((winner, entry) =>
    entry.score > winner.score ? entry : winner,
  );
  const bestScoreFloor = Math.max(threshold, best.score * 0.72);
  const selectedIndexes = new Set<number>([best.index]);
  for (let index = best.index - 1; index >= 0; index -= 1) {
    const entry = scored[index];
    if (!entry || entry.score < bestScoreFloor) break;
    selectedIndexes.add(index);
    if (selectedIndexes.size >= 3) break;
  }
  for (let index = best.index + 1; index < scored.length; index += 1) {
    const entry = scored[index];
    if (!entry || entry.score < bestScoreFloor) break;
    selectedIndexes.add(index);
    if (selectedIndexes.size >= 3) break;
  }

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter(Boolean);
}

function focusParagraphOnQuery(
  paragraph: EvidenceParagraph,
  query: string,
): EvidenceParagraph {
  const paragraphLines = paragraph.locator.position?.lines;
  const focusedLines = focusedLinesForQuery(paragraphLines, query);
  if (!focusedLines.length) return paragraph;

  const pageIndex = focusedLines[0].pageIndex;
  const focusedLineSet = new Set(focusedLines);
  const currentPageLines = (paragraphLines || []).filter(
    (line) => line.pageIndex === pageIndex,
  );
  const orderedCurrentPageLines = [
    ...focusedLines.filter((line) => line.pageIndex === pageIndex),
    ...currentPageLines.filter((line) => !focusedLineSet.has(line)),
  ];
  const nextPageLines = (paragraphLines || []).filter(
    (line) => line.pageIndex === pageIndex + 1,
  );
  const lineRects = (lines: EvidenceLine[]): number[][] =>
    lines.flatMap((line) => {
      const rect = boundingRect(line.rects);
      return rect ? [rect] : [];
    });
  const locator: Omit<EvidenceLocator, "evidenceUri"> = {
    ...paragraph.locator,
    pageIndex,
    pageNumber: pageIndex + 1,
    excerpt: compact(paragraph.text, 520),
    position: normalizeEvidencePosition({
      pageIndex,
      // Keep the paragraph as the evidence unit, but put the best-matching
      // line first so Zotero centers the reader on the actual hit.
      rects: lineRects(orderedCurrentPageLines),
      nextPageRects: lineRects(nextPageLines),
    }),
  };
  const evidenceLocator = {
    ...locator,
    evidenceUri: makeEvidenceUri(locator),
  };
  return {
    ...paragraph,
    locator: evidenceLocator,
    markdownLink: evidenceMarkdownLink(evidenceLocator, paragraph.id),
  };
}

function sourceSortIndex(source: NumberedEvidenceSource): number {
  const match = source.sourceId.match(/[A-Z](\d+)/);
  return match ? Number(match[1]) : 0;
}

function parseSourceId(
  value: unknown,
): { prefix: string; index: number } | null {
  const match = String(value || "")
    .trim()
    .match(/^([PAM])0*([1-9]\d*)$/i);
  if (!match) return null;
  return {
    prefix: match[1].toUpperCase(),
    index: Number(match[2]),
  };
}

function sectionId(index: number): string {
  return `S${String(index + 1).padStart(3, "0")}`;
}

function sectionSamples(
  sources: NumberedEvidenceSource[],
): DocumentMapSection["samples"] {
  return sources
    .filter((_, index) =>
      sources.length <= 3
        ? true
        : index === 0 ||
          index === Math.floor(sources.length / 2) ||
          index === sources.length - 1,
    )
    .map((source) => ({
      sourceId: source.sourceId,
      pageNumber: source.pageNumber,
      excerpt: compact(source.text, 220),
    }));
}

function pageRangeSources(
  sources: NumberedEvidenceSource[],
  pageStart: number,
  pageEnd: number,
): NumberedEvidenceSource[] {
  return sources.filter(
    (source) =>
      source.kind !== "annotation" &&
      typeof source.pageNumber === "number" &&
      source.pageNumber >= pageStart &&
      source.pageNumber <= pageEnd,
  );
}

function entryEndPage<T extends { level: number; pageNumber?: number }>(
  entries: T[],
  index: number,
  pageCount?: number,
): number | undefined {
  const entry = entries[index];
  if (!entry.pageNumber) return undefined;
  const next = entries
    .slice(index + 1)
    .find(
      (candidate) => candidate.pageNumber && candidate.level <= entry.level,
    );
  const endPage = next?.pageNumber
    ? Math.max(entry.pageNumber, next.pageNumber - 1)
    : pageCount;
  return typeof endPage === "number"
    ? Math.max(entry.pageNumber, endPage)
    : undefined;
}

function buildSectionsFromOutline(
  outline: DocumentOutlineEntry[],
  sources: NumberedEvidenceSource[],
  pageCount?: number,
): DocumentMapSection[] {
  const entries = outline.filter(
    (entry) => entry.title && typeof entry.pageNumber === "number",
  );
  if (entries.length < 3) return [];
  const sections: DocumentMapSection[] = [];
  for (const [index, entry] of entries.entries()) {
    const pageStart = Number(entry.pageNumber);
    const pageEnd = entryEndPage(entries, index, pageCount) || pageStart;
    const matching = pageRangeSources(sources, pageStart, pageEnd);
    if (!matching.length) continue;
    sections.push({
      id: sectionId(sections.length),
      title: entry.title,
      pageStart,
      pageEnd,
      mapSource: "pdf-outline",
      sourceStart: matching[0].sourceId,
      sourceEnd: matching[matching.length - 1].sourceId,
      paragraphCount: matching.length,
      samples: sectionSamples(matching),
    });
  }
  return sections;
}

function buildSectionsFromToc(
  corpus: EvidenceCorpus,
  sources: NumberedEvidenceSource[],
): DocumentMapSection[] {
  const entries = resolveTocPages(
    parseTocEntries(corpus.pageTexts),
    corpus.outline,
    corpus.pageTexts,
  ).filter((entry) => typeof entry.pageNumber === "number");
  if (entries.length < 3) return [];
  const sections: DocumentMapSection[] = [];
  for (const [index, entry] of entries.entries()) {
    const pageStart = Number(entry.pageNumber);
    const pageEnd = entryEndPage(entries, index, corpus.pageCount) || pageStart;
    const matching = pageRangeSources(sources, pageStart, pageEnd);
    if (!matching.length) continue;
    const next = entries
      .slice(index + 1)
      .find(
        (candidate) => candidate.printedPage && candidate.level <= entry.level,
      );
    sections.push({
      id: sectionId(sections.length),
      title: entry.title,
      pageStart,
      pageEnd,
      printedPageStart: entry.printedPage,
      printedPageEnd: next
        ? Math.max(entry.printedPage, next.printedPage - 1)
        : undefined,
      mapSource: "text-toc",
      sourceStart: matching[0].sourceId,
      sourceEnd: matching[matching.length - 1].sourceId,
      paragraphCount: matching.length,
      samples: sectionSamples(matching),
    });
  }
  return sections;
}

function buildDocumentMapFromSources(
  sources: NumberedEvidenceSource[],
  options: {
    corpus?: EvidenceCorpus;
    targetChars?: number;
    targetPages?: number;
  } = {},
): DocumentMapSection[] {
  const outlineSections = options.corpus
    ? buildSectionsFromOutline(
        options.corpus.outline,
        sources,
        options.corpus.pageCount,
      )
    : [];
  if (outlineSections.length >= 3) return outlineSections;

  const tocSections = options.corpus
    ? buildSectionsFromToc(options.corpus, sources)
    : [];
  if (tocSections.length >= 3) return tocSections;

  const paragraphSources = sources.filter(
    (source) => source.kind !== "annotation",
  );
  const targetChars = Math.max(4000, Number(options.targetChars || 9000));
  const targetPages = Math.max(4, Number(options.targetPages || 8));
  const sections: DocumentMapSection[] = [];
  let current: NumberedEvidenceSource[] = [];
  let currentChars = 0;
  let currentPageStart: number | undefined;

  const flush = () => {
    if (!current.length) return;
    const pageNumbers = current
      .map((source) => source.pageNumber)
      .filter((page): page is number => typeof page === "number");
    const pageStart = pageNumbers.length ? Math.min(...pageNumbers) : undefined;
    const pageEnd = pageNumbers.length ? Math.max(...pageNumbers) : undefined;
    const id = sectionId(sections.length);
    sections.push({
      id,
      title:
        typeof pageStart === "number" && typeof pageEnd === "number"
          ? pageStart === pageEnd
            ? `Page ${pageStart}`
            : `Pages ${pageStart}-${pageEnd}`
          : `Sources ${current[0].sourceId}-${current[current.length - 1].sourceId}`,
      pageStart,
      pageEnd,
      mapSource: "page-chunk",
      sourceStart: current[0].sourceId,
      sourceEnd: current[current.length - 1].sourceId,
      paragraphCount: current.length,
      samples: sectionSamples(current),
    });
    current = [];
    currentChars = 0;
    currentPageStart = undefined;
  };

  for (const source of paragraphSources) {
    const pageNumber = source.pageNumber;
    if (current.length && typeof pageNumber === "number") {
      const pageSpan =
        typeof currentPageStart === "number"
          ? pageNumber - currentPageStart + 1
          : 1;
      if (pageSpan > targetPages || currentChars > targetChars) flush();
    } else if (current.length && currentChars > targetChars) {
      flush();
    }
    if (!current.length) currentPageStart = pageNumber;
    current.push(source);
    currentChars += source.text.length;
  }
  flush();

  const annotationSources = sources.filter(
    (source) => source.kind === "annotation",
  );
  if (annotationSources.length) {
    sections.push({
      id: sectionId(sections.length),
      title: "Annotations",
      mapSource: "annotations",
      sourceStart: annotationSources[0].sourceId,
      sourceEnd: annotationSources[annotationSources.length - 1].sourceId,
      paragraphCount: annotationSources.length,
      samples: annotationSources.slice(0, 5).map((source) => ({
        sourceId: source.sourceId,
        pageNumber: source.pageNumber,
        excerpt: compact(source.text, 220),
      })),
    });
  }
  return sections;
}

function numberedEvidenceGuidance(
  mode: NumberedEvidencePack["mode"],
): string[] {
  return [
    mode === "full"
      ? "Read the numbered source paragraphs below and choose the paragraph ids that directly support your answer."
      : "This response is a document map, not the full paper. Choose relevant sections/pages and call expand_evidence_range before making page-specific or claim-specific answers.",
    "When citing a supported sentence, copy the source citationMarkdown marker exactly before sentence-ending punctuation. Do not add a URL; the UI resolves it to a quiet clickable number.",
    "Do not cite a source id unless that paragraph directly supports the sentence. If the provided context is insufficient, say which section/page range should be expanded.",
    "Use locate_quote only for exact source-language quotations, not broad questions or paraphrases.",
  ];
}

export async function buildNumberedEvidencePack(payload: {
  itemId?: number;
  attachmentId?: number;
  maxPages?: number;
  includeAnnotations?: boolean;
  maxContextChars?: number;
  forceFull?: boolean;
}): Promise<NumberedEvidencePack | { error: string }> {
  const corpus = await collectEvidenceCorpus({
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
    maxPages: payload.maxPages || 500,
    includeAnnotations: payload.includeAnnotations,
  });
  if ("error" in corpus) return corpus;

  const warnings = [...corpus.warnings];
  const sources = numberEvidenceSources(corpus);
  const maxContextChars = Math.max(
    8000,
    Number(payload.maxContextChars || 60000),
  );
  const estimatedChars = sources.reduce(
    (sum, source) => sum + source.text.length + 40,
    0,
  );
  const tooLong =
    payload.forceFull !== true &&
    (estimatedChars > maxContextChars ||
      Number(corpus.pageCount || 0) > 60 ||
      sources.length > 220);
  if (tooLong) {
    warnings.push(
      `Document is too long for a single evidence prompt (${sources.length} sources, ${corpus.pageCount || "unknown"} pages). Returned a map; call expand_evidence_range for relevant sections/pages.`,
    );
  }
  const selectedSources = tooLong
    ? []
    : sources.filter(
        (source) =>
          source.kind !== "annotation" || payload.includeAnnotations !== false,
      );
  const documentMap = buildDocumentMapFromSources(sources, { corpus });
  return {
    item: itemMetadata(corpus.item),
    attachment: corpus.attachment
      ? {
          id: corpus.attachment.id,
          key: corpus.attachment.key,
          title: corpus.attachment.getDisplayTitle?.() || "",
          path: corpus.path,
          cachePath: corpus.cachePath,
          indexState: corpus.indexState,
        }
      : undefined,
    mode: tooLong ? "map" : "full",
    contextText: tooLong ? "" : numberedContextText(selectedSources),
    sources: tooLong ? sources.slice(0, 24) : selectedSources,
    documentMap,
    warnings,
    citationGuidance: numberedEvidenceGuidance(tooLong ? "map" : "full"),
  };
}

export async function expandEvidenceRange(payload: {
  itemId?: number;
  attachmentId?: number;
  pageStart?: number;
  pageEnd?: number;
  sourceStart?: string;
  sourceEnd?: string;
  sourceIds?: string[];
  maxPages?: number;
  includeAnnotations?: boolean;
  maxContextChars?: number;
}): Promise<NumberedEvidencePack | { error: string }> {
  const corpus = await collectEvidenceCorpus({
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
    maxPages: payload.maxPages || 500,
    includeAnnotations: payload.includeAnnotations,
  });
  if ("error" in corpus) return corpus;

  const allSources = numberEvidenceSources(corpus);
  const requestedIds = Array.isArray(payload.sourceIds)
    ? new Set(payload.sourceIds.map((id) => String(id).toUpperCase()))
    : undefined;
  const start = parseSourceId(payload.sourceStart);
  const end = parseSourceId(payload.sourceEnd);
  const pageStart = Number(payload.pageStart || 0) || undefined;
  const pageEnd = Number(payload.pageEnd || 0) || pageStart;
  const filtered = allSources.filter((source) => {
    if (requestedIds?.has(source.sourceId.toUpperCase())) return true;
    if (start && end && source.sourceId[0].toUpperCase() === start.prefix) {
      const parsed = parseSourceId(source.sourceId);
      if (parsed && parsed.index >= start.index && parsed.index <= end.index) {
        return true;
      }
    }
    if (pageStart && pageEnd && source.pageNumber) {
      return source.pageNumber >= pageStart && source.pageNumber <= pageEnd;
    }
    return false;
  });
  const sorted = filtered.sort((a, b) => {
    const pageA = a.pageNumber || 0;
    const pageB = b.pageNumber || 0;
    if (pageA !== pageB) return pageA - pageB;
    return sourceSortIndex(a) - sourceSortIndex(b);
  });
  const maxContextChars = Math.max(
    8000,
    Number(payload.maxContextChars || 60000),
  );
  const selected: NumberedEvidenceSource[] = [];
  let charCount = 0;
  for (const source of sorted) {
    const nextCount = charCount + source.text.length + 40;
    if (selected.length && nextCount > maxContextChars) break;
    selected.push(source);
    charCount = nextCount;
  }
  const warnings = [...corpus.warnings];
  if (!selected.length) {
    warnings.push(
      "No evidence sources matched the requested range. Use get_numbered_evidence_pack to inspect valid source ids and page ranges.",
    );
  } else if (selected.length < sorted.length) {
    warnings.push(
      `Expanded range was truncated from ${sorted.length} to ${selected.length} sources to fit the context budget.`,
    );
  }

  return {
    item: itemMetadata(corpus.item),
    attachment: corpus.attachment
      ? {
          id: corpus.attachment.id,
          key: corpus.attachment.key,
          title: corpus.attachment.getDisplayTitle?.() || "",
          path: corpus.path,
          cachePath: corpus.cachePath,
          indexState: corpus.indexState,
        }
      : undefined,
    mode: "full",
    contextText: numberedContextText(selected),
    sources: selected,
    documentMap: buildDocumentMapFromSources(allSources, { corpus }),
    warnings,
    citationGuidance: numberedEvidenceGuidance("full"),
  };
}

export async function locateQuote(payload: {
  quote: string;
  itemId?: number;
  attachmentId?: number;
  maxMatches?: number;
}): Promise<LocatedQuote | { error: string }> {
  const quote = String(payload.quote || "").trim();
  if (!quote) return { error: "quote is required" };
  const pack = await buildEvidencePack({
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
    query: quote,
    maxParagraphs: 50,
  });
  if ("error" in pack) return pack;
  const normalizedQuote = normalizeForMatch(quote);
  const minimumScore = minimumMatchScore(quote);
  const scoredMatches = [...pack.paragraphs, ...pack.annotations]
    .map((paragraph) => {
      const result = scoreText(paragraph.text, quote);
      const exact = normalizeForMatch(paragraph.text).includes(normalizedQuote);
      return {
        ...paragraph,
        score: result.score,
        matchReason: exact ? "exact normalized quote match" : result.reason,
      };
    })
    .filter((paragraph) => (paragraph.score || 0) >= minimumScore)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const exactMatches = scoredMatches.filter(
    (paragraph) => paragraph.matchReason === "exact normalized quote match",
  );
  const matches = (exactMatches.length ? exactMatches : scoredMatches).slice(
    0,
    Math.max(1, Math.min(Number(payload.maxMatches || 5), 20)),
  );
  return {
    quote,
    matches,
    warnings: [
      ...pack.warnings,
      ...(matches.length
        ? exactMatches.length
          ? []
          : [
              "No exact normalized quote match found; returned lexical candidates only. Do not present the quote as verified unless the user accepts a paraphrase.",
            ]
        : ["No quote match found in available Zotero evidence."]),
    ],
  };
}

function scoreFigureTableCandidate(
  candidate: EvidenceFigureTableCandidate,
  target: {
    pageIndex?: number;
    pageNumber?: number;
    label?: string;
    caption?: string;
    query?: string;
    claim?: string;
  },
): number {
  let score = 0;
  const pageIndex =
    typeof target.pageIndex === "number"
      ? target.pageIndex
      : typeof target.pageNumber === "number"
        ? target.pageNumber - 1
        : undefined;
  if (
    typeof pageIndex === "number" &&
    candidate.locator.pageIndex === pageIndex
  ) {
    score += 4;
  }
  if (target.label) {
    score += scoreText(candidate.label, target.label).score * 3;
  }
  if (target.caption) {
    score += scoreText(candidate.caption, target.caption).score * 2;
  }
  if (target.query) {
    score += scoreText(candidate.caption, target.query).score;
  }
  if (target.claim) {
    score += scoreText(candidate.caption, target.claim).score;
  }
  return score;
}

function visualInspectionPrompt(options: {
  candidate?: EvidenceFigureTableCandidate;
  pageImage?: EvidencePageImage;
  claim?: string;
  query?: string;
  warnings: string[];
}): string {
  const candidate = options.candidate;
  const pageImage = options.pageImage;
  const targetLines = [
    "You are auditing figure/table evidence from a Zotero PDF page.",
    "Use the attached rendered page screenshot as the primary source of truth.",
    "Do not rely on the extracted caption if the screenshot contradicts it.",
    "",
    "Target:",
    `- Page: ${pageImage?.pageNumber || candidate?.locator.pageNumber || "unknown"}`,
    `- Label: ${candidate?.label || "unknown"}`,
    `- Candidate caption: ${candidate?.caption || "none"}`,
    options.claim ? `- Claim to verify: ${options.claim}` : "",
    options.query ? `- Query: ${options.query}` : "",
    "",
    "Tasks:",
    "1. Decide whether the candidate is a true figure/table caption on this page or merely a body-text reference.",
    "2. Briefly describe what the visible figure/table/page evidence shows.",
    "3. If a claim is provided, decide whether the visible page supports it.",
    "4. Report concrete visual evidence such as labels, caption text, axes, table headings, or nearby paragraph cues.",
    "",
    "Return strict JSON with fields: verdict, isTrueCaption, visualSummary, claimSupport, evidence, confidence, warnings.",
  ].filter(Boolean);
  if (options.warnings.length) {
    targetLines.push(
      "",
      "Known warnings:",
      ...options.warnings.map((w) => `- ${w}`),
    );
  }
  return targetLines.join("\n");
}

export async function inspectFigureTablePage(payload: {
  itemId?: number;
  attachmentId?: number;
  pageIndex?: number;
  pageNumber?: number;
  label?: string;
  caption?: string;
  query?: string;
  claim?: string;
  maxPages?: number;
  pageImageMaxWidth?: number;
}): Promise<FigureTablePageInspection | { error: string }> {
  const searchPlan = figureInspectionSearchPlan(payload);
  const pack = await buildEvidencePack({
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
    query: payload.query || payload.caption || payload.label || payload.claim,
    maxParagraphs: 12,
    maxPages: searchPlan.maxPages,
    includeAnnotations: false,
    includePageImages: true,
    maxPageImages: 4,
    pageImageMaxWidth: Number(payload.pageImageMaxWidth || 1200),
  });
  if ("error" in pack) return pack;

  const scored = pack.figuresTables
    .map((candidate) => ({
      candidate,
      score: scoreFigureTableCandidate(candidate, payload),
    }))
    .sort((a, b) => b.score - a.score);
  const requestedPageIndex = searchPlan.requestedPageIndex;
  const candidate = selectFigurePageCandidate(
    scored.map((entry) => entry.candidate),
    requestedPageIndex,
  );
  let pageImage = candidate?.pageImage;
  if (
    typeof requestedPageIndex === "number" &&
    (pageImage?.pageIndex !== requestedPageIndex || !pageImage.dataUrl)
  ) {
    const attachmentId = pack.attachment?.id || payload.attachmentId;
    const attachment = attachmentId
      ? Zotero.Items.get(Number(attachmentId))
      : undefined;
    pageImage = await capturePdfJsPageImage({
      attachment,
      pageIndex: requestedPageIndex,
      includeDataUrl: true,
      maxWidth: Math.max(
        640,
        Math.min(Number(payload.pageImageMaxWidth || 1200), 1800),
      ),
    });
  }
  const imageInput = dataUrlToImageInput(pageImage?.dataUrl);
  const warnings = [
    ...pack.warnings,
    ...(pageImage?.warning ? [pageImage.warning] : []),
    ...(imageInput
      ? []
      : [
          "No screenshot imageInput is available. Open the PDF page in Zotero Reader, ensure the page is rendered, then call inspect_figure_table_page again.",
        ]),
    ...(candidate ? [] : ["No matching figure/table caption candidate found."]),
  ];
  const searchComplete = !warnings.some((warning) =>
    /extraction limited to/i.test(warning),
  );
  const terminalNotFound =
    !candidate && typeof requestedPageIndex !== "number" && searchComplete;
  const status = candidate
    ? ("candidate_found" as const)
    : terminalNotFound
      ? ("not_found" as const)
      : ("page_needs_inspection" as const);
  const recommendedAction = terminalNotFound
    ? "Tell the user that the requested figure/table was not found in this PDF. Do not call locate_quote, shell/Python, or unrelated evidence tools. If the user expects a visual, ask for a page number or screenshot."
    : candidate
      ? "Inspect the returned rendered page and answer only the current figure/table request."
      : "Inspect the explicitly requested page. If no visual is visible, report that it could not be confirmed.";

  return {
    status,
    found: !!candidate,
    searchComplete,
    terminal: terminalNotFound,
    recommendedAction,
    target: {
      itemId: payload.itemId,
      attachmentId: payload.attachmentId,
      pageIndex: requestedPageIndex ?? candidate?.locator.pageIndex,
      pageNumber:
        typeof requestedPageIndex === "number"
          ? requestedPageIndex + 1
          : candidate?.locator.pageNumber,
      label: payload.label,
      caption: payload.caption,
      claim: payload.claim,
    },
    candidate,
    pageImage,
    imageInput,
    inspectionPrompt: terminalNotFound
      ? `No matching figure/table was found. ${recommendedAction}`
      : visualInspectionPrompt({
          candidate,
          pageImage,
          claim: payload.claim,
          query: payload.query,
          warnings,
        }),
    expectedOutput: {
      format: "json",
      fields: [
        "verdict",
        "isTrueCaption",
        "visualSummary",
        "claimSupport",
        "evidence",
        "confidence",
        "warnings",
      ],
    },
    warnings,
  };
}

function extractClaimsFromText(text: string): CitationClaimInput[] {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/\[[^\]]+\]\([^)]*\)/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .trim();
  if (!stripped) return [];

  const candidates = stripped
    .split(/(?<=[。！？.!?])\s+|\n+/u)
    .map((sentence) => sentence.replace(/^\s*[-*|>\d.]+\s*/, "").trim())
    .filter((sentence) => {
      if (sentence.length < 35 || sentence.length > 420) return false;
      if (/^(claim|status|evidence|location|issue|fix)\b/i.test(sentence)) {
        return false;
      }
      if (/^\|/.test(sentence)) return false;
      return /[。！？.!?]$/.test(sentence) || /[，,;；:：]/.test(sentence);
    });

  const seen = new Set<string>();
  const claims: CitationClaimInput[] = [];
  for (const sentence of candidates) {
    const normalized = normalizeForMatch(sentence);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const quote = sentence.match(/["“](.{12,240}?)[”"]/u)?.[1];
    claims.push({ claim: sentence, quote });
  }
  return claims.slice(0, 30);
}

function figureTableReference(
  text: string,
): { label: string; kind: string } | null {
  const match = String(text || "").match(
    /\b((?:fig(?:ure)?\.?|table|图|表)\s*[0-9ivxlcdm一二三四五六七八九十百]+)\b/iu,
  );
  if (!match) return null;
  const kind = /^tab|^表/i.test(match[1]) ? "table" : "figure";
  return {
    label: match[1].replace(/\s+/g, " ").trim(),
    kind,
  };
}

function bestFigureTableCandidate(
  pack: EvidencePack,
  ref: { label: string; kind: string },
  claimInput: CitationClaimInput,
  claim: string,
): EvidenceFigureTableCandidate | undefined {
  return [...pack.figuresTables]
    .map((candidate) => ({
      candidate,
      score:
        scoreFigureTableCandidate(candidate, {
          label: ref.label,
          claim,
          pageIndex: claimInput.pageIndex,
        }) + (candidate.kind === ref.kind ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.candidate;
}

function visualInspectionHint(options: {
  pack: EvidencePack;
  claimInput: CitationClaimInput;
  claim: string;
  ref: { label: string; kind: string };
}): CitationVisualInspectionHint {
  const candidate = bestFigureTableCandidate(
    options.pack,
    options.ref,
    options.claimInput,
    options.claim,
  );
  return {
    required: true,
    reason:
      "Claim references a figure/table; verify the rendered PDF page visually before treating the claim as fully supported.",
    tool: "inspect_figure_table_page",
    arguments: {
      itemId: options.claimInput.itemId || options.pack.item.id,
      attachmentId:
        options.claimInput.attachmentId || options.pack.attachment?.id,
      pageIndex:
        typeof options.claimInput.pageIndex === "number"
          ? options.claimInput.pageIndex
          : candidate?.locator.pageIndex,
      pageNumber:
        typeof options.claimInput.pageIndex === "number"
          ? options.claimInput.pageIndex + 1
          : candidate?.locator.pageNumber,
      label: options.ref.label,
      caption: candidate?.caption,
      claim: options.claim,
    },
  };
}

export async function verifyCitationClaims(payload: {
  claims: CitationClaimInput[];
  text?: string;
  itemId?: number;
  attachmentId?: number;
}): Promise<
  | {
      verifications: CitationVerification[];
      claimSourceMap: Record<string, EvidenceLocator | null>;
      warnings: string[];
    }
  | { error: string }
> {
  const claims = Array.isArray(payload.claims) ? payload.claims : [];
  const extractedClaims =
    claims.length > 0
      ? claims
      : extractClaimsFromText(String(payload.text || ""));
  if (extractedClaims.length === 0) {
    return { error: "claims array or verifiable text is required" };
  }
  const verifications: CitationVerification[] = [];
  const claimSourceMap: Record<string, EvidenceLocator | null> = {};
  const warnings = new Set<string>();

  for (const claimInput of extractedClaims.slice(0, 30)) {
    const claim = String(claimInput.claim || "").trim();
    const quote = String(claimInput.quote || "").trim();
    if (!claim) continue;
    const targetItemId = claimInput.itemId || payload.itemId;
    const targetAttachmentId = claimInput.attachmentId || payload.attachmentId;
    const query = quote || claim;
    const pack = await buildEvidencePack({
      itemId: targetItemId,
      attachmentId: targetAttachmentId,
      query,
      maxParagraphs: 8,
    });
    if ("error" in pack) {
      verifications.push({
        claim,
        quote: quote || undefined,
        status: "unverified",
        confidence: 0,
        warnings: [pack.error],
      });
      claimSourceMap[claim] = null;
      continue;
    }
    pack.warnings.forEach((warning) => warnings.add(warning));
    const visualRef = figureTableReference(claim);
    const visualInspection = visualRef
      ? visualInspectionHint({
          pack,
          claimInput,
          claim,
          ref: visualRef,
        })
      : undefined;
    const candidates = [...pack.paragraphs, ...pack.annotations]
      .map((paragraph) => {
        const score = scoreText(paragraph.text, query);
        const pageBonus =
          typeof claimInput.pageIndex === "number" &&
          paragraph.locator.pageIndex === claimInput.pageIndex
            ? 0.12
            : 0;
        return {
          ...paragraph,
          score: Math.min(1, score.score + pageBonus),
          matchReason: pageBonus
            ? `${score.reason}; requested page match`
            : score.reason,
        };
      })
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const evidence = candidates[0];
    const confidence = evidence?.score || 0;
    const exactClaimMatch =
      !!evidence?.text &&
      normalizeForMatch(evidence.text).includes(normalizeForMatch(query));
    const contradictory = evidence?.matchReason?.startsWith(
      "possible contradiction:",
    );
    const status: CitationVerification["status"] = contradictory
      ? "unverified"
      : quote
        ? confidence >= 0.75
          ? "verified"
          : confidence >= 0.25
            ? "weak"
            : "unverified"
        : exactClaimMatch && confidence >= 0.9
          ? "verified"
          : confidence >= 0.16
            ? "weak"
            : "unverified";
    verifications.push({
      claim,
      quote: quote || undefined,
      status,
      confidence: Number(confidence.toFixed(3)),
      evidence: evidence && confidence > 0 ? evidence : undefined,
      visualInspection,
      warnings:
        status === "verified" && !visualInspection
          ? []
          : [
              ...(status === "verified"
                ? []
                : [
                    contradictory
                      ? "The closest evidence may contradict this claim."
                      : "Available lexical evidence does not establish that this claim is supported.",
                  ]),
              ...(visualInspection
                ? [
                    "Figure/table claim requires visual inspection before final acceptance.",
                  ]
                : []),
            ],
    });
    claimSourceMap[claim] =
      evidence && confidence > 0 ? evidence.locator : null;
  }

  return { verifications, claimSourceMap, warnings: [...warnings] };
}

function markdownCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function verificationLocation(verification: CitationVerification): string {
  const evidence = verification.evidence;
  const locator = evidence?.locator;
  if (!locator) return "";
  const locationLink = evidenceMarkdownLink(
    locator,
    evidence?.id || "evidence",
  );
  return [
    locator.pageNumber ? `p. ${locator.pageNumber}` : "",
    locationLink,
    !locator.evidenceUri ? locator.openUri : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function trustReportActions(
  verifications: CitationVerification[],
): EvidenceTrustReportAction[] {
  const actions: EvidenceTrustReportAction[] = [];
  for (const verification of verifications) {
    if (verification.visualInspection) {
      actions.push({
        kind: "inspect_figure_table_page",
        claim: verification.claim,
        reason: verification.visualInspection.reason,
        arguments: verification.visualInspection.arguments,
      });
    }
    if (verification.status === "unverified") {
      actions.push({
        kind: "revise_or_find_source",
        claim: verification.claim,
        reason:
          "No sufficiently supporting text evidence was found; revise the claim, add a source, or inspect additional evidence.",
      });
    }
  }
  return actions;
}

function trustReportMarkdown(options: {
  summary: EvidenceTrustReport["summary"];
  verifications: CitationVerification[];
  nextActions: EvidenceTrustReportAction[];
  warnings: string[];
}): string {
  const lines = [
    "# Evidence Trust Report",
    "",
    `Claims: ${options.summary.totalClaims}`,
    `Verified: ${options.summary.verified}`,
    `Weak: ${options.summary.weak}`,
    `Unverified: ${options.summary.unverified}`,
    `Needs visual inspection: ${options.summary.visualInspectionRequired}`,
    "",
    "| Claim | Status | Confidence | Evidence | Next step |",
    "| --- | --- | ---: | --- | --- |",
  ];

  for (const verification of options.verifications) {
    const nextStep = verification.visualInspection
      ? `Call ${verification.visualInspection.tool}`
      : verification.status === "unverified"
        ? "Revise claim or find stronger source"
        : "";
    lines.push(
      [
        markdownCell(verification.claim),
        markdownCell(verification.status),
        markdownCell(verification.confidence),
        markdownCell(verificationLocation(verification)),
        markdownCell(nextStep),
      ].join(" | "),
    );
  }

  if (options.nextActions.length) {
    lines.push("", "## Next Actions");
    for (const action of options.nextActions) {
      lines.push(
        `- ${action.kind}: ${action.reason} Claim: ${markdownCell(action.claim)}`,
      );
    }
  }

  if (options.warnings.length) {
    lines.push("", "## Warnings");
    for (const warning of options.warnings) {
      lines.push(`- ${markdownCell(warning)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function buildEvidenceTrustReport(payload: {
  claims?: CitationClaimInput[];
  text?: string;
  itemId?: number;
  attachmentId?: number;
}): Promise<EvidenceTrustReport | { error: string }> {
  const verification = await verifyCitationClaims({
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    text: payload.text,
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
  });
  if ("error" in verification) return verification;

  const verifications = verification.verifications;
  const summary: EvidenceTrustReport["summary"] = {
    totalClaims: verifications.length,
    verified: verifications.filter((entry) => entry.status === "verified")
      .length,
    weak: verifications.filter((entry) => entry.status === "weak").length,
    unverified: verifications.filter((entry) => entry.status === "unverified")
      .length,
    visualInspectionRequired: verifications.filter(
      (entry) => entry.visualInspection?.required,
    ).length,
  };
  const nextActions = trustReportActions(verifications);
  const warnings = [...verification.warnings];
  return {
    summary,
    verifications,
    claimSourceMap: verification.claimSourceMap,
    nextActions,
    markdown: trustReportMarkdown({
      summary,
      verifications,
      nextActions,
      warnings,
    }),
    warnings,
  };
}

function academicTraceId(createdAt: Date): string {
  return `academic-trace-${createdAt.getTime().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function compactEvidenceExcerpt(text: string | undefined): string | undefined {
  const compact = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return undefined;
  return compact.length > 480 ? `${compact.slice(0, 477)}...` : compact;
}

function academicTraceEvidence(
  verifications: CitationVerification[],
): AcademicTraceEvidenceRecord[] {
  return verifications.map((verification) => ({
    claim: verification.claim,
    status: verification.status,
    confidence: verification.confidence,
    quote: verification.quote,
    evidenceId: verification.evidence?.id,
    excerpt: compactEvidenceExcerpt(verification.evidence?.text),
    locator: verification.evidence?.locator,
    warnings: [...verification.warnings],
  }));
}

function academicTraceFailures(
  verifications: CitationVerification[],
): AcademicTraceFailure[] {
  return verifications
    .filter((verification) => verification.status !== "verified")
    .map((verification) => ({
      claim: verification.claim,
      status: verification.status,
      reason:
        verification.warnings[0] ||
        "The current evidence does not fully support this claim.",
      fix:
        verification.status === "unverified"
          ? "Remove or rewrite the claim, then search for a stronger Zotero source."
          : "Narrow the wording or add a stronger quote/page locator.",
    }));
}

function academicTraceReplayPlan(options: {
  itemId?: number;
  attachmentId?: number;
  query?: string;
  claims: CitationClaimInput[];
  trustReport: EvidenceTrustReport;
}): AcademicTraceReplayStep[] {
  const baseArgs: Record<string, unknown> = {};
  if (options.itemId) baseArgs.itemId = options.itemId;
  if (options.attachmentId) baseArgs.attachmentId = options.attachmentId;
  if (options.query) baseArgs.query = options.query;

  const steps: AcademicTraceReplayStep[] = [];
  if (options.itemId || options.attachmentId) {
    steps.push({
      tool: "get_evidence_pack",
      arguments: {
        ...baseArgs,
        includeAnnotations: true,
        includePageImages: false,
      },
      reason: "Rebuild the text evidence pack without page screenshots.",
      required: true,
    });
  }
  for (const claim of options.claims) {
    if (claim.quote) {
      steps.push({
        tool: "locate_quote",
        arguments: {
          quote: claim.quote,
          itemId: claim.itemId || options.itemId,
          attachmentId: claim.attachmentId || options.attachmentId,
        },
        reason: "Recheck direct quote provenance and page locator.",
        required: true,
      });
    }
  }
  steps.push({
    tool: "verify_citations",
    arguments: {
      itemId: options.itemId,
      attachmentId: options.attachmentId,
      claims: options.claims,
    },
    reason: "Recompute claim-to-source support statuses.",
    required: true,
  });
  steps.push({
    tool: "build_trust_report",
    arguments: {
      itemId: options.itemId,
      attachmentId: options.attachmentId,
      claims: options.claims,
    },
    reason: "Regenerate the Evidence Trust Report summary.",
    required: true,
  });
  for (const action of options.trustReport.nextActions) {
    if (action.kind !== "inspect_figure_table_page") continue;
    steps.push({
      tool: "inspect_figure_table_page",
      arguments: action.arguments || { claim: action.claim },
      reason: action.reason,
      required: true,
    });
  }
  return steps;
}

function academicTraceMarkdown(
  trace: Omit<AcademicTraceArtifact, "markdown">,
): string {
  const lines = [
    "# Academic Trace",
    "",
    `Trace ID: ${trace.traceId}`,
    `Created: ${trace.createdAt}`,
    `Claims: ${trace.trustReport.summary.totalClaims}`,
    `Verified: ${trace.trustReport.summary.verified}`,
    `Weak: ${trace.trustReport.summary.weak}`,
    `Unverified: ${trace.trustReport.summary.unverified}`,
    `Needs visual inspection: ${trace.trustReport.summary.visualInspectionRequired}`,
    "",
    "## Evidence",
    "",
    "| Claim | Status | Support | Location |",
    "| --- | --- | --- | --- |",
  ];

  for (const record of trace.evidence) {
    lines.push(
      [
        markdownCell(record.claim),
        markdownCell(record.status),
        record.locator ? "Source paragraph" : "No source located",
        markdownCell(
          record.locator
            ? [
                record.locator.pageNumber
                  ? `p. ${record.locator.pageNumber}`
                  : "",
                evidenceMarkdownLink(
                  record.locator,
                  record.evidenceId || "evidence",
                ),
                !record.locator.evidenceUri ? record.locator.openUri || "" : "",
              ]
                .filter(Boolean)
                .join(" ")
            : "",
        ),
      ].join(" | "),
    );
  }

  if (trace.failures.length) {
    lines.push("", "## Failures");
    for (const failure of trace.failures) {
      lines.push(
        `- ${failure.status}: ${markdownCell(failure.reason)} Claim: ${markdownCell(
          failure.claim,
        )} Fix: ${markdownCell(failure.fix)}`,
      );
    }
  }

  if (trace.visualInspectionQueue.length) {
    lines.push("", "## Visual Inspection Queue");
    for (const action of trace.visualInspectionQueue) {
      lines.push(
        `- inspect_figure_table_page: ${markdownCell(action.reason)} Claim: ${markdownCell(
          action.claim,
        )}`,
      );
    }
  }

  lines.push("", "## Replay Plan");
  for (const [index, step] of trace.replayPlan.entries()) {
    lines.push(
      `${index + 1}. ${step.tool}: ${markdownCell(step.reason)} ${JSON.stringify(
        step.arguments,
      )}`,
    );
  }

  if (trace.toolCalls.length) {
    lines.push("", "## Tool Calls");
    for (const call of trace.toolCalls) {
      lines.push(
        `- ${call.tool}: ${call.status || "called"} ${markdownCell(
          call.summary || call.error || "",
        )}`,
      );
    }
  }

  if (trace.warnings.length) {
    lines.push("", "## Warnings");
    for (const warning of trace.warnings)
      lines.push(`- ${markdownCell(warning)}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function buildAcademicTrace(payload: {
  answer?: string;
  claims?: CitationClaimInput[];
  text?: string;
  itemId?: number;
  attachmentId?: number;
  query?: string;
  toolCalls?: AcademicTraceToolCall[];
}): Promise<AcademicTraceArtifact | { error: string }> {
  const trustReport = await buildEvidenceTrustReport({
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    text: payload.text || payload.answer,
    itemId: payload.itemId,
    attachmentId: payload.attachmentId,
  });
  if ("error" in trustReport) return trustReport;

  const createdAt = new Date();
  const claims = Array.isArray(payload.claims) ? payload.claims : [];
  const baseTrace = {
    protocol: "claudero.academic-trace" as const,
    version: 1 as const,
    traceId: academicTraceId(createdAt),
    createdAt: createdAt.toISOString(),
    source: {
      itemId: payload.itemId,
      attachmentId: payload.attachmentId,
      query: payload.query,
    },
    answer: payload.answer,
    claims,
    trustReport,
    evidence: academicTraceEvidence(trustReport.verifications),
    toolCalls: Array.isArray(payload.toolCalls) ? payload.toolCalls : [],
    replayPlan: academicTraceReplayPlan({
      itemId: payload.itemId,
      attachmentId: payload.attachmentId,
      query: payload.query,
      claims,
      trustReport,
    }),
    visualInspectionQueue: trustReport.nextActions.filter(
      (action) => action.kind === "inspect_figure_table_page",
    ),
    failures: academicTraceFailures(trustReport.verifications),
    warnings: [...trustReport.warnings],
  };

  return {
    ...baseTrace,
    markdown: academicTraceMarkdown(baseTrace),
  };
}

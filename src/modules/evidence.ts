export interface EvidenceLocator {
  itemId: number;
  itemKey: string;
  attachmentId?: number;
  attachmentKey?: string;
  title: string;
  sourceType: "metadata" | "fulltext" | "annotation";
  pageIndex?: number;
  pageNumber?: number;
  paragraphIndex?: number;
  annotationId?: number;
  annotationKey?: string;
  openUri?: string;
}

export interface EvidenceParagraph {
  id: string;
  text: string;
  locator: EvidenceLocator;
  score?: number;
  matchReason?: string;
}

export interface EvidenceFigureTableCandidate {
  kind: "figure" | "table";
  label: string;
  caption: string;
  locator: EvidenceLocator;
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
  warnings: string[];
}

interface TextPage {
  pageIndex?: number;
  text: string;
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

function tokenize(value: string): string[] {
  const normalized = normalizeForMatch(value);
  const latin = normalized.split(/\s+/).filter((term) => term.length > 2);
  const cjk = Array.from(normalized.matchAll(/[\p{Script=Han}]{2,}/gu)).map(
    (match) => match[0],
  );
  return [...new Set([...latin, ...cjk])].slice(0, 80);
}

function scoreText(
  text: string,
  query: string,
): { score: number; reason: string } {
  const q = normalizeForMatch(query);
  const t = normalizeForMatch(text);
  if (!q || !t) return { score: 0, reason: "empty query" };
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
}): EvidenceParagraph {
  return {
    id: `${options.idPrefix}-${options.paragraphIndex + 1}`,
    text: compact(options.text, 2400),
    locator: {
      itemId: options.item.id,
      itemKey: options.item.key,
      attachmentId: options.attachment?.id,
      attachmentKey: options.attachment?.key,
      title:
        options.item.getDisplayTitle?.() ||
        String(options.item.getField("title") || ""),
      sourceType: options.sourceType,
      pageIndex: options.pageIndex,
      pageNumber:
        typeof options.pageIndex === "number"
          ? options.pageIndex + 1
          : undefined,
      paragraphIndex: options.paragraphIndex,
      openUri: makeOpenPdfUri(options.attachment, options.pageIndex),
    },
  };
}

function rankParagraphs(
  paragraphs: EvidenceParagraph[],
  query = "",
  maxParagraphs = 12,
): EvidenceParagraph[] {
  const scored = paragraphs.map((paragraph) => {
    const score = query
      ? scoreText(paragraph.text, query)
      : { score: 0.5, reason: "document order" };
    return { ...paragraph, score: score.score, matchReason: score.reason };
  });
  scored.sort((a, b) => {
    if (query && (b.score || 0) !== (a.score || 0))
      return (b.score || 0) - (a.score || 0);
    return (a.locator.paragraphIndex || 0) - (b.locator.paragraphIndex || 0);
  });
  return scored.slice(0, Math.max(1, Math.min(maxParagraphs, 50)));
}

function extractFigureTableCandidates(
  paragraphs: EvidenceParagraph[],
): EvidenceFigureTableCandidate[] {
  const candidates: EvidenceFigureTableCandidate[] = [];
  for (const paragraph of paragraphs) {
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
    });
  }
  return candidates.slice(0, 20);
}

function parseAnnotationPosition(position: unknown): { pageIndex?: number } {
  if (typeof position !== "string" || !position) return {};
  try {
    const parsed = JSON.parse(position) as { pageIndex?: number };
    return typeof parsed.pageIndex === "number"
      ? { pageIndex: parsed.pageIndex }
      : {};
  } catch {
    return {};
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
      out.push({
        id: `anno-${annotation.id}`,
        text: compact(text, 1800),
        locator: {
          itemId: item.id,
          itemKey: item.key,
          attachmentId: att.id,
          attachmentKey: att.key,
          title:
            item.getDisplayTitle?.() || String(item.getField("title") || ""),
          sourceType: "annotation",
          pageIndex: page.pageIndex,
          pageNumber:
            typeof page.pageIndex === "number" ? page.pageIndex + 1 : undefined,
          annotationId: annotation.id,
          annotationKey: annotation.key,
          openUri: makeOpenPdfUri(att, page.pageIndex, annotation.key),
        },
      });
    }
  }
  return out;
}

export async function buildEvidencePack(payload: {
  itemId?: number;
  attachmentId?: number;
  query?: string;
  maxParagraphs?: number;
  includeAnnotations?: boolean;
}): Promise<EvidencePack | { error: string }> {
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
  let cachePath: string | undefined;
  let indexState: number | undefined;

  if (attachment) {
    const cache = await readFulltextCache(attachment);
    cachePath = cache.cachePath;
    indexState = cache.indexState;
    if (cache.warning) warnings.push(cache.warning);
    let paragraphIndex = 0;
    for (const page of splitPages(cache.text)) {
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
  const path = attachment ? await attachmentPath(attachment) : undefined;

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
    figuresTables: extractFigureTableCandidates(paragraphs),
    warnings,
    citationGuidance: [
      "Use evidence ids such as [para-3] or [anno-ABC] while drafting, then cite the locator page/openUri in final prose.",
      "Direct quotes must appear verbatim in an evidence paragraph or annotation; otherwise label them as paraphrases.",
      "Prefer paragraph or annotation evidence over item-level metadata for empirical claims.",
      "For figure/table claims, cite a figure/table candidate caption and verify the surrounding PDF page when possible.",
    ],
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
    maxParagraphs: Math.max(Number(payload.maxMatches || 5), 5),
  });
  if ("error" in pack) return pack;
  const matches = [...pack.paragraphs, ...pack.annotations]
    .map((paragraph) => {
      const result = scoreText(paragraph.text, quote);
      return { ...paragraph, score: result.score, matchReason: result.reason };
    })
    .filter((paragraph) => (paragraph.score || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, Math.max(1, Math.min(Number(payload.maxMatches || 5), 20)));
  return {
    quote,
    matches,
    warnings: matches.length
      ? pack.warnings
      : [
          ...pack.warnings,
          "No quote match found in available Zotero evidence.",
        ],
  };
}

export async function verifyCitationClaims(payload: {
  claims: CitationClaimInput[];
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
  if (claims.length === 0) return { error: "claims array is required" };
  const verifications: CitationVerification[] = [];
  const claimSourceMap: Record<string, EvidenceLocator | null> = {};
  const warnings = new Set<string>();

  for (const claimInput of claims.slice(0, 30)) {
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
    const status: CitationVerification["status"] =
      confidence >= (quote ? 0.75 : 0.32)
        ? "verified"
        : confidence >= (quote ? 0.25 : 0.16)
          ? "weak"
          : "unverified";
    verifications.push({
      claim,
      quote: quote || undefined,
      status,
      confidence: Number(confidence.toFixed(3)),
      evidence: evidence && confidence > 0 ? evidence : undefined,
      warnings:
        status === "verified"
          ? []
          : ["Available evidence does not strongly support this claim."],
    });
    claimSourceMap[claim] =
      evidence && confidence > 0 ? evidence.locator : null;
  }

  return { verifications, claimSourceMap, warnings: [...warnings] };
}

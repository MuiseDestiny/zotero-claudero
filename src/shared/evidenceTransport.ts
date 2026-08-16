type JsonRecord = Record<string, any>;

function compactAttachment(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const attachment = value as JsonRecord;
  return {
    id: attachment.id,
    key: attachment.key,
    title: attachment.title,
  };
}

export function evidenceSourceForAgent(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as JsonRecord;
  const locator = (source.locator || {}) as JsonRecord;
  return {
    id: source.id || source.sourceId,
    kind: source.kind,
    text: source.text,
    pageNumber: source.pageNumber ?? locator.pageNumber,
    paragraphIndex: source.paragraphIndex ?? locator.paragraphIndex,
    annotationKey: locator.annotationKey,
    score: source.score,
    matchReason: source.matchReason,
    citationMarkdown: source.citationMarkdown || source.markdownLink,
  };
}

export function evidencePackForAgent(value: unknown): unknown {
  if (!value || typeof value !== "object" || "error" in value) return value;
  const pack = value as JsonRecord;
  return {
    item: pack.item,
    attachment: compactAttachment(pack.attachment),
    query: pack.query,
    paragraphs: Array.isArray(pack.paragraphs)
      ? pack.paragraphs.map(evidenceSourceForAgent)
      : [],
    annotations: Array.isArray(pack.annotations)
      ? pack.annotations.map(evidenceSourceForAgent)
      : [],
    figuresTables: pack.figuresTables,
    warnings: pack.warnings,
    citationGuidance: pack.citationGuidance,
  };
}

export function numberedEvidencePackForAgent(value: unknown): unknown {
  if (!value || typeof value !== "object" || "error" in value) return value;
  const pack = value as JsonRecord;
  const sources = Array.isArray(pack.sources) ? pack.sources : [];
  return {
    item: pack.item,
    attachment: compactAttachment(pack.attachment),
    mode: pack.mode,
    contextText: pack.contextText,
    sourceCount: sources.length,
    sourceIds: sources
      .map((source: JsonRecord) => source.sourceId)
      .filter(Boolean),
    documentMap: pack.documentMap,
    warnings: pack.warnings,
    citationGuidance: pack.citationGuidance,
  };
}

export function locatedQuoteForAgent(value: unknown): unknown {
  if (!value || typeof value !== "object" || "error" in value) return value;
  const result = value as JsonRecord;
  return {
    quote: result.quote,
    matches: Array.isArray(result.matches)
      ? result.matches.map(evidenceSourceForAgent)
      : [],
    warnings: result.warnings,
  };
}

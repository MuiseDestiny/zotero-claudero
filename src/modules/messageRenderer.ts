import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";
import {
  decodeEvidenceReference,
  hydrateEvidenceMarkers,
  sanitizeEvidencePresentation,
} from "../shared/evidenceLinkCodec";
import { getString } from "../utils/locale";

const escapeHtml = new MarkdownIt().utils.escapeHtml;

const markdownRenderer: MarkdownIt = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: true,
  xhtmlOut: true,
  highlight(code, language): string {
    const lang = language?.trim();
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${
          hljs.highlight(code, {
            language: lang,
            ignoreIllegals: true,
          }).value
        }</code></pre>`;
      } catch {
        // Fall back to escaped plain code below.
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
}).use(markdownItKatex, {
  throwOnError: false,
  errorColor: "#be4246",
});

const evidenceScheme = "claudero-evidence:";

interface EvidenceLinkLocator {
  itemId?: number;
  itemKey?: string;
  attachmentId?: number;
  title?: string;
  excerpt?: string;
  sourceType?: string;
  pageIndex?: number;
  pageNumber?: number;
  paragraphIndex?: number;
  annotationId?: number;
  annotationKey?: string;
  openUri?: string;
  position?: {
    pageIndex?: number;
    rects?: number[][];
    nextPageRects?: number[][];
  };
}

interface EvidenceElementData {
  href: string;
  locator: EvidenceLinkLocator;
  marker: string;
  displayLabel: string;
}

interface ZoteroRuntime {
  Reader?: {
    open?: (
      attachmentId: number,
      options?: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    getByTabID?: (tabID: unknown) => unknown;
  };
  getMainWindow?: () => unknown;
  launchURL?: (url: string) => void;
}

interface EvidencePopoverOptions {
  onOpen?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

interface ReaderChar {
  c?: string;
  rect?: number[];
  inlineRect?: number[];
  lineBreakAfter?: boolean;
  spaceAfter?: boolean;
  paragraphBreakAfter?: boolean;
  ignorable?: boolean;
}

interface ReaderLine {
  text: string;
  rects: number[][];
  pageIndex: number;
}

function getZoteroRuntime(doc?: Document): ZoteroRuntime | undefined {
  const globalZotero = (globalThis as unknown as { Zotero?: ZoteroRuntime })
    .Zotero;
  const documentZotero = (
    doc?.defaultView as unknown as { Zotero?: ZoteroRuntime } | null
  )?.Zotero;
  if (globalZotero?.Reader || globalZotero?.launchURL) return globalZotero;
  return documentZotero || globalZotero;
}

function normalizeMathDelimiters(text: string): string {
  // Protect code blocks and inline code from conversion.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\\\((.+?)\\\)/g, (_m, formula) => `$${formula.trim()}$`)
        .replace(
          /\\\[([\s\S]*?)\\\]/g,
          (_m, formula) => `
$$
${formula.trim()}
$$
`,
        );
    })
    .join("");
}

function hideIncompleteEvidenceLinks(text: string): string {
  const pattern = /\[[^\]\n]{1,80}\]\(claudero-evidence:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const closingParen = text.indexOf(")", pattern.lastIndex);
    if (closingParen < 0) {
      const labelEnd = text.indexOf("]", match.index) + 1;
      return text.slice(0, Math.max(match.index, labelEnd)).trimEnd();
    }
    pattern.lastIndex = closingParen + 1;
  }
  return text;
}

function evidenceMarkerLabel(value: string): string | null {
  const match = value
    .trim()
    .match(
      /^\[?((?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+|[PAME]\d{4,}|E[A-Za-z0-9]+)\]?$/i,
    );
  return match ? `[${match[1]}]` : null;
}

function displayEvidenceLabel(index: number): string {
  return String(index);
}

function splitTrailingSentencePunctuation(text: string):
  | {
      body: string;
      punctuation: string;
      trailingWhitespace: string;
    }
  | undefined {
  const match = text.match(/([。！？!?.;；])(\s*)$/);
  if (!match) return undefined;
  const body = text.slice(0, text.length - match[0].length);
  if (!body) return undefined;
  return {
    body,
    punctuation: match[1],
    trailingWhitespace: match[2] || "",
  };
}

function appendTextWithMarkerBeforePunctuation(
  doc: Document,
  fragment: DocumentFragment,
  text: string,
  marker: Node,
): void {
  const split = splitTrailingSentencePunctuation(text);
  if (!split) {
    if (text) fragment.appendChild(doc.createTextNode(text));
    fragment.appendChild(marker);
    return;
  }
  fragment.appendChild(doc.createTextNode(split.body));
  fragment.appendChild(marker);
  fragment.appendChild(
    doc.createTextNode(split.punctuation + split.trailingWhitespace),
  );
}

function isEvidenceMarker(value: string): boolean {
  return !!evidenceMarkerLabel(value);
}

function createEvidenceChip(
  doc: Document,
  marker: string,
  displayLabel?: string,
): HTMLElement {
  const chip = doc.createElement("span");
  chip.className = "claudero-evidence-chip";
  chip.textContent = displayLabel || marker;
  chip.setAttribute("role", "note");
  chip.setAttribute(
    "title",
    `${marker} reference. Open cited location when available.`,
  );
  chip.dataset.evidenceMarker = marker.slice(1, -1);
  return chip;
}

function parseEvidenceLocator(href: string): EvidenceLinkLocator | null {
  if (!href.startsWith(evidenceScheme)) return null;
  try {
    const encoded = href.slice(evidenceScheme.length);
    const parsed = decodeEvidenceReference(encoded);
    return parsed && typeof parsed === "object"
      ? (parsed as EvidenceLinkLocator)
      : null;
  } catch {
    return null;
  }
}

function evidenceLocatorTitle(
  marker: string,
  locator?: EvidenceLinkLocator | null,
): string {
  if (!locator) {
    return `${marker} reference. Open cited location when available.`;
  }
  const parts = [
    marker,
    locator.sourceType ? sourceTypeLabel(locator.sourceType) : "",
    typeof locator.pageNumber === "number"
      ? `page: ${locator.pageNumber}`
      : typeof locator.pageIndex === "number"
        ? `page: ${locator.pageIndex + 1}`
        : "",
    typeof locator.paragraphIndex === "number"
      ? `paragraph: ${locator.paragraphIndex + 1}`
      : "",
    locator.annotationKey ? `annotation: ${locator.annotationKey}` : "",
  ].filter(Boolean);
  return `${parts.join("\n")}\nOpen cited location.`;
}

function sourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case "pdfjs":
    case "fulltext":
      return "PDF";
    case "annotation":
      return "Annotation";
    case "metadata":
      return "Metadata";
    default:
      return sourceType;
  }
}

function removeEvidencePopover(doc: Document): void {
  doc.querySelector(".claudero-evidence-popover")?.remove();
}

function evidenceLogString(
  message: string,
  data?: Record<string, unknown>,
): string {
  if (!data) return `[Claudero/evidence] ${message}`;
  try {
    return `[Claudero/evidence] ${message} ${JSON.stringify(data)}`;
  } catch {
    return `[Claudero/evidence] ${message} ${String(data)}`;
  }
}

function logEvidenceNavigation(
  message: string,
  data?: Record<string, unknown>,
): void {
  try {
    const payload = data || {};
    const line = evidenceLogString(message, payload);
    if (typeof ztoolkit !== "undefined" && ztoolkit?.log) {
      ztoolkit.log(line);
    } else {
      (
        globalThis as unknown as {
          ztoolkit?: { log?: (...args: unknown[]) => void };
        }
      ).ztoolkit?.log?.(line);
    }
    console.log(line);
    (
      globalThis as unknown as {
        Zotero?: { debug?: (...args: unknown[]) => void };
      }
    ).Zotero?.debug?.(line);
  } catch {
    // Logging should never break evidence navigation.
  }
}

function normalizeNavigationRect(rect: unknown): number[] | null {
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const values = rect.map((value) => Number(value));
  if (!values.every(Number.isFinite)) return null;
  return [
    Math.min(values[0], values[2]),
    Math.min(values[1], values[3]),
    Math.max(values[0], values[2]),
    Math.max(values[1], values[3]),
  ].map((value) => Number(value.toFixed(3)));
}

function compactNavigationRects(rects: unknown): number[][] {
  return Array.isArray(rects)
    ? rects
        .map((rect) => normalizeNavigationRect(rect))
        .filter((rect): rect is number[] => !!rect)
    : [];
}

function boundingNavigationRect(rects: number[][]): number[] | null {
  const valid = compactNavigationRects(rects);
  if (!valid.length) return null;
  return [
    Math.min(...valid.map((rect) => rect[0])),
    Math.min(...valid.map((rect) => rect[1])),
    Math.max(...valid.map((rect) => rect[2])),
    Math.max(...valid.map((rect) => rect[3])),
  ].map((value) => Number(value.toFixed(3)));
}

function flushReaderLine(
  lines: ReaderLine[],
  pageIndex: number,
  line: { text: string; rects: number[][] },
): void {
  const text = line.text.replace(/\s+/g, " ").trim();
  const rect = boundingNavigationRect(line.rects);
  if (text && rect) lines.push({ text, rects: [rect], pageIndex });
  line.text = "";
  line.rects = [];
}

function readerCharsToLines(
  chars: ReaderChar[] | undefined,
  pageIndex: number,
): ReaderLine[] {
  if (!Array.isArray(chars) || !chars.length) return [];
  const lines: ReaderLine[] = [];
  const line = { text: "", rects: [] as number[][] };
  for (const char of chars) {
    if (!char.ignorable) {
      const text = String(char.c || "");
      if (text) line.text += text;
      const rect = normalizeNavigationRect(
        Array.isArray(char.inlineRect) ? char.inlineRect : char.rect,
      );
      if (rect) line.rects.push(rect);
      if (char.spaceAfter) line.text += " ";
    }
    if (char.lineBreakAfter || char.paragraphBreakAfter) {
      flushReaderLine(lines, pageIndex, line);
    }
    if (char.paragraphBreakAfter) {
      lines.push({ text: "", rects: [], pageIndex });
    }
  }
  flushReaderLine(lines, pageIndex, line);
  return lines;
}

function pdfTextItemRect(item: {
  transform?: number[];
  width?: number;
  height?: number;
}): number[] | null {
  const transform = item.transform || [];
  const x = Number(transform[4]);
  const y = Number(transform[5]);
  const width = Number(item.width || 0);
  const height = Number(
    item.height || Math.abs(transform[3] || transform[0]) || 0,
  );
  if (![x, y, width, height].every(Number.isFinite)) return null;
  const yPadding = Math.max(1.5, height * 0.35);
  return normalizeNavigationRect([
    x,
    y - yPadding,
    x + Math.max(width, 0),
    y + Math.max(height, 0) + yPadding,
  ]);
}

function pdfTextItemsToLines(
  items: Array<{
    str?: string;
    hasEOL?: boolean;
    transform?: number[];
    width?: number;
    height?: number;
  }>,
  pageIndex: number,
): ReaderLine[] {
  const lines: ReaderLine[] = [];
  const line = { text: "", rects: [] as number[][] };
  for (const item of items) {
    const text = String(item.str || "");
    if (text.trim()) {
      line.text += text;
      const rect = pdfTextItemRect(item);
      if (rect) line.rects.push(rect);
    }
    if (item.hasEOL) flushReaderLine(lines, pageIndex, line);
  }
  flushReaderLine(lines, pageIndex, line);
  return lines;
}

function isEvidenceCaption(text: string): boolean {
  return /^(?:fig(?:ure)?\.?|table|图|表)\s*[0-9ivxlcdm一二三四五六七八九十百]+[\s:：.-]/i.test(
    text.trim(),
  );
}

function linesToReaderParagraphs(lines: ReaderLine[]): Array<{
  pageIndex: number;
  text: string;
  lines: ReaderLine[];
}> {
  const paragraphs: Array<{
    pageIndex: number;
    text: string;
    lines: ReaderLine[];
  }> = [];
  let current: ReaderLine[] = [];
  const flush = () => {
    if (!current.length) return;
    const text = current
      .map((line) => line.text)
      .join("\n")
      .trim();
    if (text.length >= 40 || isEvidenceCaption(text)) {
      paragraphs.push({
        pageIndex: current[0].pageIndex,
        text,
        lines: [...current],
      });
    }
    current = [];
  };
  for (const line of lines) {
    if (!line.text.trim()) {
      flush();
      continue;
    }
    if (current.length && isEvidenceCaption(line.text)) flush();
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

function getReaderForEvidenceAttachment(
  zotero: ZoteroRuntime | undefined,
  attachmentId: number,
): {
  navigate?: (
    location: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  _item?: { id?: number };
  itemID?: number;
  _internalReader?: unknown;
} | null {
  try {
    const mainWindow = zotero?.getMainWindow?.() as
      | {
          Zotero?: ZoteroRuntime;
          Zotero_Tabs?: { selectedID?: unknown };
        }
      | undefined;
    const readerApi = (mainWindow?.Zotero?.Reader || zotero?.Reader) as
      | {
          getByTabID?: (tabID: unknown) => unknown;
          _readers?: unknown[];
        }
      | undefined;
    const selectedID =
      mainWindow?.Zotero_Tabs?.selectedID ||
      (
        globalThis as unknown as {
          Zotero_Tabs?: { selectedID?: unknown };
        }
      ).Zotero_Tabs?.selectedID;
    const selectedReader = selectedID
      ? (readerApi?.getByTabID?.(selectedID) as {
          _item?: { id?: number };
          itemID?: number;
          _internalReader?: unknown;
        } | null)
      : null;
    if (
      selectedReader?._item?.id === attachmentId ||
      selectedReader?.itemID === attachmentId
    ) {
      return selectedReader;
    }
    if (Array.isArray(readerApi?._readers)) {
      return (
        (readerApi._readers.find((reader) => {
          const entry = reader as {
            _item?: { id?: number };
            itemID?: number;
          };
          return (
            entry?._item?.id === attachmentId || entry?.itemID === attachmentId
          );
        }) as ReturnType<typeof getReaderForEvidenceAttachment>) || null
      );
    }
  } catch (error) {
    logEvidenceNavigation("reader lookup failed", {
      attachmentId,
      error: String(error),
    });
  }
  return null;
}

function getInternalReaderView(reader: { _internalReader?: unknown } | null): {
  _ensureBasicPageData?: (pageIndex: number) => Promise<unknown> | unknown;
  _pdfPages?: Record<number, { chars?: ReaderChar[] }>;
  _iframeWindow?: {
    PDFViewerApplication?: {
      pdfViewer?: { _pages?: unknown[] };
    };
  };
} | null {
  try {
    const rawInternal = reader?._internalReader as
      | {
          _lastView?: unknown;
          _primaryView?: unknown;
        }
      | undefined;
    const Cu = (globalThis as unknown as { Components?: any }).Components
      ?.utils;
    const internal =
      Cu?.waiveXrays && rawInternal ? Cu.waiveXrays(rawInternal) : rawInternal;
    const view = (internal?._lastView || internal?._primaryView || internal) as
      | {
          _ensureBasicPageData?: (
            pageIndex: number,
          ) => Promise<unknown> | unknown;
          _pdfPages?: Record<number, { chars?: ReaderChar[] }>;
          _iframeWindow?: {
            PDFViewerApplication?: {
              pdfViewer?: { _pages?: unknown[] };
            };
          };
        }
      | undefined;
    return view || null;
  } catch {
    return null;
  }
}

async function resolveEvidencePositionFromOpenReader(options: {
  zotero?: ZoteroRuntime;
  attachmentId: number;
  paragraphIndex?: number;
  pageIndex?: number;
}): Promise<EvidenceLinkLocator["position"] | undefined> {
  const { attachmentId, pageIndex, paragraphIndex, zotero } = options;
  if (!attachmentId || typeof paragraphIndex !== "number") return undefined;
  const reader = getReaderForEvidenceAttachment(zotero, attachmentId);
  const view = getInternalReaderView(reader);
  const pdfPages = view?._pdfPages;
  if (!view || !pdfPages) {
    logEvidenceNavigation("live position skipped: reader chars unavailable", {
      attachmentId,
      pageIndex,
      paragraphIndex,
      foundReader: !!reader,
      hasView: !!view,
      hasPdfPages: !!pdfPages,
    });
    return undefined;
  }

  const pageCount =
    view._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages?.length ||
    Math.max(
      pageIndex ?? 0,
      ...Object.keys(pdfPages)
        .map((key) => Number(key))
        .filter(Number.isFinite),
    ) + 1;
  const maxPageIndex =
    typeof pageIndex === "number"
      ? Math.min(Math.max(0, pageIndex), Math.max(0, pageCount - 1))
      : Math.max(0, pageCount - 1);
  const lines: ReaderLine[] = [];
  for (
    let currentPageIndex = 0;
    currentPageIndex <= maxPageIndex;
    currentPageIndex += 1
  ) {
    try {
      await view._ensureBasicPageData?.(currentPageIndex);
    } catch (error) {
      logEvidenceNavigation("live position page data failed", {
        attachmentId,
        pageIndex: currentPageIndex,
        error: String(error),
      });
    }
    const charLines = readerCharsToLines(
      pdfPages[currentPageIndex]?.chars,
      currentPageIndex,
    );
    if (charLines.length) {
      lines.push(...charLines);
      continue;
    }
    try {
      const pageView = view._iframeWindow?.PDFViewerApplication?.pdfViewer
        ?._pages?.[currentPageIndex] as
        | {
            pdfPage?: {
              getTextContent?: () => Promise<{
                items?: Array<{
                  str?: string;
                  hasEOL?: boolean;
                  transform?: number[];
                  width?: number;
                  height?: number;
                }>;
              }>;
            };
          }
        | undefined;
      const textContent = await pageView?.pdfPage?.getTextContent?.();
      const items = Array.isArray(textContent?.items) ? textContent.items : [];
      const pdfLines = pdfTextItemsToLines(items, currentPageIndex);
      if (pdfLines.length) lines.push(...pdfLines);
    } catch (error) {
      logEvidenceNavigation("live position textContent fallback failed", {
        attachmentId,
        pageIndex: currentPageIndex,
        error: String(error),
      });
    }
  }

  const paragraphs = linesToReaderParagraphs(lines);
  const indexed = paragraphs.map((paragraph, index) => ({ index, paragraph }));
  const exact = indexed[paragraphIndex];
  const samePage =
    typeof pageIndex === "number"
      ? indexed
          .filter((entry) => entry.paragraph.pageIndex === pageIndex)
          .sort(
            (a, b) =>
              Math.abs(a.index - paragraphIndex) -
              Math.abs(b.index - paragraphIndex),
          )[0]
      : undefined;
  const selected =
    exact &&
    (typeof pageIndex !== "number" || exact.paragraph.pageIndex === pageIndex)
      ? exact
      : samePage || exact;
  if (!selected) {
    logEvidenceNavigation("live position failed: paragraph not found", {
      attachmentId,
      pageIndex,
      paragraphIndex,
      paragraphCount: paragraphs.length,
      lineCount: lines.length,
    });
    return undefined;
  }

  const basePageIndex = selected.paragraph.pageIndex;
  const rects = compactNavigationRects(
    selected.paragraph.lines
      .filter((line) => line.pageIndex === basePageIndex)
      .flatMap((line) => line.rects),
  );
  const nextPageRects = compactNavigationRects(
    selected.paragraph.lines
      .filter((line) => line.pageIndex === basePageIndex + 1)
      .flatMap((line) => line.rects),
  );
  if (!rects.length && !nextPageRects.length) {
    logEvidenceNavigation("live position failed: no rects", {
      attachmentId,
      pageIndex,
      paragraphIndex,
      resolvedParagraphIndex: selected.index,
      resolvedPageIndex: basePageIndex,
    });
    return undefined;
  }

  logEvidenceNavigation("live position resolved", {
    attachmentId,
    pageIndex,
    paragraphIndex,
    resolvedParagraphIndex: selected.index,
    resolvedPageIndex: basePageIndex,
    rectCount: rects.length,
    nextPageRectCount: nextPageRects.length,
    firstRect: rects[0],
    text: selected.paragraph.text.slice(0, 180),
  });
  return {
    pageIndex: basePageIndex,
    ...(rects.length ? { rects } : {}),
    ...(nextPageRects.length ? { nextPageRects } : {}),
  };
}

function showEvidencePopover(
  doc: Document,
  trigger: Element,
  marker: string,
  locator: EvidenceLinkLocator,
  displayLabel?: string,
  options?: EvidencePopoverOptions,
): void {
  logEvidenceNavigation("popover shown", {
    displayLabel,
    marker,
    attachmentId: locator.attachmentId,
    pageIndex: locator.pageIndex,
    rectCount: Array.isArray(locator.position?.rects)
      ? locator.position.rects.length
      : 0,
  });
  removeEvidencePopover(doc);
  const card = doc.createElement("div");
  card.className = "claudero-evidence-popover";
  if (options?.onOpen) {
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onOpen?.();
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      options.onOpen?.();
    });
  }
  if (options?.onPointerEnter) {
    card.addEventListener("mouseenter", options.onPointerEnter);
    card.addEventListener("focus", options.onPointerEnter);
  }
  if (options?.onPointerLeave) {
    card.addEventListener("mouseleave", options.onPointerLeave);
    card.addEventListener("blur", options.onPointerLeave);
  }

  const label = doc.createElement("div");
  label.className = "claudero-evidence-popover-label";
  label.textContent = displayLabel || marker;
  card.appendChild(label);

  const details = doc.createElement("div");
  details.className = "claudero-evidence-popover-details";
  const page =
    typeof locator.pageNumber === "number"
      ? locator.pageNumber
      : typeof locator.pageIndex === "number"
        ? locator.pageIndex + 1
        : undefined;
  details.textContent = [
    locator.sourceType ? sourceTypeLabel(locator.sourceType) : "",
    typeof page === "number" ? `Page: ${page}` : "",
    typeof locator.paragraphIndex === "number"
      ? `Paragraph: ${locator.paragraphIndex + 1}`
      : "",
    locator.annotationKey ? `Annotation: ${locator.annotationKey}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  card.appendChild(details);

  const preview = String(locator.excerpt || locator.title || "").trim();
  if (preview) {
    const title = doc.createElement("div");
    title.className = "claudero-evidence-popover-title";
    title.textContent = preview;
    title.setAttribute("title", preview);
    card.appendChild(title);
  }

  const hint = doc.createElement("div");
  hint.className = "claudero-evidence-popover-hint";
  hint.textContent = getString("evidence-open-reader");
  card.appendChild(hint);

  const mount = doc.documentElement || doc.body;
  if (!mount) return;
  mount.appendChild(card);
  const rect = trigger.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const view = doc.defaultView;
  const maxLeft = Math.max(8, (view?.innerWidth || 0) - cardRect.width - 8);
  const left = Math.min(Math.max(8, rect.left), maxLeft);
  const top =
    rect.top > cardRect.height + 16
      ? rect.top - cardRect.height - 8
      : rect.bottom + 8;
  card.style.left = `${left}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

async function openEvidenceLocator(
  doc: Document,
  locator: EvidenceLinkLocator,
  href: string,
): Promise<void> {
  const zotero = getZoteroRuntime(doc);
  const attachmentId = Number(locator.attachmentId || 0);
  let rawPosition =
    locator.position && typeof locator.position.pageIndex === "number"
      ? locator.position
      : typeof locator.pageIndex === "number"
        ? { pageIndex: locator.pageIndex }
        : undefined;
  let rects = compactNavigationRects(rawPosition?.rects);
  let nextPageRects = compactNavigationRects(rawPosition?.nextPageRects);
  let position =
    rawPosition && (rects?.length || nextPageRects?.length)
      ? {
          pageIndex: rawPosition.pageIndex,
          ...(rects?.length ? { rects } : {}),
          ...(nextPageRects?.length ? { nextPageRects } : {}),
        }
      : undefined;
  const adoptLivePosition = (
    livePosition: EvidenceLinkLocator["position"] | undefined,
  ): void => {
    if (!livePosition) return;
    rawPosition = livePosition;
    rects = compactNavigationRects(rawPosition.rects);
    nextPageRects = compactNavigationRects(rawPosition.nextPageRects);
    position =
      rects.length || nextPageRects.length
        ? {
            pageIndex: rawPosition.pageIndex,
            ...(rects.length ? { rects } : {}),
            ...(nextPageRects.length ? { nextPageRects } : {}),
          }
        : undefined;
  };

  if (!position && attachmentId && typeof locator.paragraphIndex === "number") {
    const livePosition = await resolveEvidencePositionFromOpenReader({
      zotero,
      attachmentId,
      paragraphIndex: locator.paragraphIndex,
      pageIndex:
        typeof rawPosition?.pageIndex === "number"
          ? rawPosition.pageIndex
          : locator.pageIndex,
    });
    adoptLivePosition(livePosition);
  }

  const pageOnlyOptions =
    typeof rawPosition?.pageIndex === "number"
      ? { pageIndex: rawPosition.pageIndex }
      : undefined;
  logEvidenceNavigation("open requested", {
    attachmentId,
    itemId: locator.itemId,
    itemKey: locator.itemKey,
    pageIndex: rawPosition?.pageIndex,
    pageNumber: locator.pageNumber,
    paragraphIndex: locator.paragraphIndex,
    rectCount: rects?.length || 0,
    nextPageRectCount: nextPageRects?.length || 0,
    firstRect: rects?.[0],
    secondRect: rects?.[1],
    lastRect: rects?.[rects.length - 1],
    rects,
    nextPageRects,
    position,
    hasZoteroReaderOpen: !!zotero?.Reader?.open,
  });
  const getActiveReaderForAttachment = (): {
    navigate?: (
      location: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    _item?: { id?: number };
  } | null => {
    try {
      const mainWindow = zotero?.getMainWindow?.() as
        | {
            Zotero?: typeof zotero;
            Zotero_Tabs?: { selectedID?: unknown };
          }
        | undefined;
      const readerApi = mainWindow?.Zotero?.Reader || zotero?.Reader;
      const selectedID =
        mainWindow?.Zotero_Tabs?.selectedID ||
        (
          globalThis as unknown as {
            Zotero_Tabs?: { selectedID?: unknown };
          }
        ).Zotero_Tabs?.selectedID;
      const reader = readerApi?.getByTabID?.(selectedID) as
        | {
            navigate?: (
              location: Record<string, unknown>,
              options?: Record<string, unknown>,
            ) => Promise<unknown> | unknown;
            _item?: { id?: number };
          }
        | undefined;
      logEvidenceNavigation("active reader lookup", {
        selectedID: String(selectedID || ""),
        foundReader: !!reader,
        readerItemId: reader?._item?.id,
        expectedAttachmentId: attachmentId,
        hasNavigate: !!reader?.navigate,
      });
      return reader?._item?.id === attachmentId ? reader : null;
    } catch (error) {
      logEvidenceNavigation("active reader lookup failed", {
        error: String(error),
      });
      return null;
    }
  };
  const navigateToPosition = async (): Promise<boolean> => {
    if (!position) {
      logEvidenceNavigation("navigate skipped: no position", {
        pageOnlyOptions,
      });
      return false;
    }
    const reader = getActiveReaderForAttachment();
    if (!reader?.navigate) {
      logEvidenceNavigation("navigate skipped: active reader unavailable", {
        attachmentId,
      });
      return false;
    }
    try {
      logEvidenceNavigation("reader.navigate start", {
        attachmentId,
        pageIndex: position.pageIndex,
        rectCount: Array.isArray(position.rects) ? position.rects.length : 0,
        nextPageRectCount: Array.isArray(position.nextPageRects)
          ? position.nextPageRects.length
          : 0,
        position,
        readerNavigatePayload: { position },
      });
      await reader.navigate({ position }, { block: "center", ifNeeded: false });
      logEvidenceNavigation("reader.navigate success", {
        attachmentId,
        pageIndex: position.pageIndex,
      });
      return true;
    } catch (error) {
      logEvidenceNavigation("reader.navigate failed", {
        error: String(error),
        attachmentId,
        pageIndex: position.pageIndex,
        rectCount: Array.isArray(position.rects) ? position.rects.length : 0,
      });
      return false;
    }
  };

  if (attachmentId && zotero?.Reader?.open) {
    if (await navigateToPosition()) return;
    try {
      logEvidenceNavigation("Zotero.Reader.open start", {
        attachmentId,
        mode: position ? "position" : "page",
        pageIndex: rawPosition?.pageIndex,
        readerOpenOptions: position ? { position } : pageOnlyOptions,
      });
      await zotero.Reader.open(
        attachmentId,
        position ? { position } : pageOnlyOptions,
      );
      logEvidenceNavigation("Zotero.Reader.open success", {
        attachmentId,
        mode: position ? "position" : "page",
      });
      await new Promise<void>((resolve) =>
        (doc.defaultView || globalThis).setTimeout(resolve, 80),
      );
      if (
        !position &&
        attachmentId &&
        typeof locator.paragraphIndex === "number"
      ) {
        adoptLivePosition(
          await resolveEvidencePositionFromOpenReader({
            zotero,
            attachmentId,
            paragraphIndex: locator.paragraphIndex,
            pageIndex: locator.pageIndex,
          }),
        );
      }
      if (await navigateToPosition()) return;
    } catch (error) {
      logEvidenceNavigation("Zotero.Reader.open failed", {
        error: String(error),
        attachmentId,
        hasPageFallback: !!pageOnlyOptions,
        hadPosition: !!position,
      });
      if (!pageOnlyOptions || !position) throw error;
      logEvidenceNavigation("Zotero.Reader.open page fallback", {
        attachmentId,
        pageOnlyOptions,
      });
      await zotero.Reader.open(attachmentId, pageOnlyOptions);
    }
    return;
  }
  if (locator.openUri && zotero?.launchURL) {
    zotero.launchURL(locator.openUri);
    return;
  }
  doc.defaultView?.open(locator.openUri || href);
}

function moveMarkerBeforePreviousSentencePunctuation(marker: Element): void {
  const parent = marker.parentNode;
  if (!parent) return;
  let previous = marker.previousSibling;
  while (
    previous?.nodeType === Node.TEXT_NODE &&
    !/\S/.test(previous.textContent || "")
  ) {
    previous = previous.previousSibling;
  }
  if (!previous || previous.nodeType !== Node.TEXT_NODE) return;

  const textNode = previous as Text;
  const split = splitTrailingSentencePunctuation(textNode.nodeValue || "");
  if (!split) return;

  textNode.nodeValue = split.body;
  parent.insertBefore(marker, textNode.nextSibling);
  parent.insertBefore(
    marker.ownerDocument.createTextNode(
      split.punctuation + split.trailingWhitespace,
    ),
    marker.nextSibling,
  );
}

function enhanceEvidenceMarkers(container: HTMLElement): void {
  const doc = container.ownerDocument;
  const markerDisplayNumbers = new Map<string, number>();
  const locatorByElement = new WeakMap<Element, EvidenceElementData>();
  let popoverCloseTimer: ReturnType<typeof setTimeout> | undefined;
  const locatorDisplayKey = (
    marker: string,
    locator?: EvidenceLinkLocator | null,
  ): string => {
    if (!locator) return marker.slice(1, -1);
    return [
      locator.attachmentId || locator.itemKey || locator.itemId || "",
      locator.sourceType || "",
      typeof locator.pageIndex === "number" ? locator.pageIndex : "",
      typeof locator.paragraphIndex === "number" ? locator.paragraphIndex : "",
      locator.annotationKey || locator.annotationId || "",
      marker.slice(1, -1),
    ].join(":");
  };
  const evidenceDisplayLabel = (
    marker: string,
    locator?: EvidenceLinkLocator | null,
  ): string => {
    const id = locatorDisplayKey(marker, locator);
    if (!markerDisplayNumbers.has(id)) {
      markerDisplayNumbers.set(id, markerDisplayNumbers.size + 1);
    }
    return displayEvidenceLabel(markerDisplayNumbers.get(id) || 1);
  };
  const clearPopoverCloseTimer = (): void => {
    if (!popoverCloseTimer) return;
    (doc.defaultView || globalThis).clearTimeout(popoverCloseTimer);
    popoverCloseTimer = undefined;
  };
  const scheduleRemoveEvidencePopover = (): void => {
    clearPopoverCloseTimer();
    popoverCloseTimer = (doc.defaultView || globalThis).setTimeout(() => {
      popoverCloseTimer = undefined;
      removeEvidencePopover(doc);
    }, 120);
  };
  const openEvidence = (chip: Element, evidence: EvidenceElementData): void => {
    const { displayLabel, href, locator, marker } = evidence;
    logEvidenceNavigation("chip click captured", {
      displayLabel,
      marker,
      hrefLength: href.length,
      attachmentId: locator.attachmentId,
      itemId: locator.itemId,
      itemKey: locator.itemKey,
      pageIndex: locator.pageIndex,
      pageNumber: locator.pageNumber,
      paragraphIndex: locator.paragraphIndex,
      position: locator.position,
      rectCount: Array.isArray(locator.position?.rects)
        ? locator.position.rects.length
        : 0,
      nextPageRectCount: Array.isArray(locator.position?.nextPageRects)
        ? locator.position.nextPageRects.length
        : 0,
      tagName: chip.tagName,
    });
    void openEvidenceLocator(doc, locator, href);
  };
  const openEvidenceFromEvent = (
    event: Event,
    chip: Element,
    evidence: EvidenceElementData | undefined,
  ): void => {
    if (!evidence) {
      logEvidenceNavigation("chip click captured without locator", {
        text: chip.textContent,
        href: chip.getAttribute("href"),
      });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openEvidence(chip, evidence);
  };
  const showEvidenceForLink = (
    link: Element,
    marker: string,
    locator: EvidenceLinkLocator,
    displayLabel: string,
    evidence: EvidenceElementData,
  ): void => {
    clearPopoverCloseTimer();
    showEvidencePopover(doc, link, marker, locator, displayLabel, {
      onOpen: () => openEvidence(link, evidence),
      onPointerEnter: clearPopoverCloseTimer,
      onPointerLeave: scheduleRemoveEvidencePopover,
    });
  };

  container.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const locator = parseEvidenceLocator(href);
    if (href.startsWith(evidenceScheme)) {
      link.removeAttribute("target");
      link.removeAttribute("rel");
    }
    const text = link.textContent || "";
    const markerLabel = evidenceMarkerLabel(text);
    const marker = markerLabel || "[evidence]";
    const displayLabel = evidenceDisplayLabel(marker, locator);
    if (markerLabel || locator) {
      link.classList.add("claudero-evidence-chip", "linked");
      link.textContent = displayLabel;
      link.setAttribute("title", evidenceLocatorTitle(marker, locator));
      link.setAttribute("aria-label", `Reference ${displayLabel} ${marker}`);
      moveMarkerBeforePreviousSentencePunctuation(link);
    }
    if (locator) {
      const evidence = { href, locator, marker, displayLabel };
      locatorByElement.set(link, evidence);
      (link as HTMLElement).dataset.clauderoEvidenceLink = "true";
      link.addEventListener("mouseenter", () =>
        showEvidenceForLink(link, marker, locator, displayLabel, evidence),
      );
      link.addEventListener("mouseleave", scheduleRemoveEvidencePopover);
      link.addEventListener("focus", () =>
        showEvidenceForLink(link, marker, locator, displayLabel, evidence),
      );
      link.addEventListener("blur", scheduleRemoveEvidencePopover);
      link.addEventListener("click", (event) =>
        openEvidenceFromEvent(event, link, evidence),
      );
      return;
    }
    if (href.startsWith(evidenceScheme)) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        logEvidenceNavigation("evidence link decode failed", {
          hrefLength: href.length,
          prefix: href.slice(0, 48),
        });
      });
      return;
    }
    if (href.startsWith("zotero://")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const launcher = getZoteroRuntime(doc)?.launchURL;
        if (launcher) {
          launcher(href);
        } else {
          doc.defaultView?.open(href);
        }
      });
    }
  });

  const targetElement = (target: EventTarget | null): Element | null => {
    const maybeElement = target as Partial<Element> | null;
    if (maybeElement && typeof maybeElement.closest === "function") {
      return maybeElement as Element;
    }
    const maybeNode = target as Partial<Node> | null;
    return maybeNode?.parentElement || null;
  };
  const findEvidenceTarget = (target: EventTarget | null): Element | null => {
    const element = targetElement(target);
    if (!element) return null;
    const chip = element.closest("[data-claudero-evidence-link='true']");
    return chip && container.contains(chip) ? chip : null;
  };
  container.addEventListener(
    "pointerdown",
    (event) => {
      const chip = findEvidenceTarget(event.target);
      if (!chip) return;
      const evidence = locatorByElement.get(chip);
      logEvidenceNavigation("chip pointerdown captured", {
        hasEvidence: !!evidence,
        text: chip.textContent,
        tagName: chip.tagName,
        className: chip.getAttribute("class"),
      });
    },
    true,
  );
  container.addEventListener(
    "click",
    (event) => {
      const chip = findEvidenceTarget(event.target);
      if (!chip) return;
      openEvidenceFromEvent(event, chip, locatorByElement.get(chip));
    },
    true,
  );

  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("code, pre, a, button, .claudero-evidence-chip")) {
        return NodeFilter.FILTER_REJECT;
      }
      return /\[(?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+\]/i.test(
        node.nodeValue || "",
      ) || /\[(?:[PAM]\d{4,}|E[A-Za-z0-9]+)\]/i.test(node.nodeValue || "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  const markerPattern =
    /\[(?:(?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+|[PAM]\d{4,}|E[A-Za-z0-9]+)\]/gi;
  for (const node of textNodes) {
    const text = node.nodeValue || "";
    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(markerPattern)) {
      const marker = match[0];
      const index = match.index ?? 0;
      const chip = createEvidenceChip(
        doc,
        marker,
        evidenceDisplayLabel(marker),
      );
      if (index > lastIndex) {
        appendTextWithMarkerBeforePunctuation(
          doc,
          fragment,
          text.slice(lastIndex, index),
          chip,
        );
      } else {
        fragment.appendChild(chip);
      }
      lastIndex = index + marker.length;
    }
    if (lastIndex < text.length) {
      fragment.appendChild(doc.createTextNode(text.slice(lastIndex)));
    }
    node.replaceWith(fragment);
  }
}

export function renderMarkdown(
  doc: Document,
  container: HTMLElement,
  text: string,
): void {
  // Evidence links carry an encoded locator. During streaming Markdown can see
  // the label before the closing parenthesis arrives and expose that locator as
  // plain text. Hold the incomplete link back until it is syntactically whole.
  const normalized = normalizeMathDelimiters(
    hydrateEvidenceMarkers(
      sanitizeEvidencePresentation(hideIncompleteEvidenceLinks(text)),
    ),
  );
  const html = markdownRenderer.render(normalized);
  const parsed = new DOMParser().parseFromString(
    `<main>${html}</main>`,
    "text/html",
  );
  const body = parsed.body.firstElementChild;
  container.textContent = "";
  if (!body) {
    container.textContent = text;
    return;
  }
  for (const child of Array.from(body.childNodes)) {
    if (!child) continue;
    container.appendChild(doc.importNode(child, true));
  }
  container.querySelectorAll("a[href]").forEach((link) => {
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
  enhanceEvidenceMarkers(container);
}

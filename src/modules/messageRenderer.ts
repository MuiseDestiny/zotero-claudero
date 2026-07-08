import hljs from "highlight.js/lib/common";
import MarkdownIt from "markdown-it";
import markdownItKatex from "markdown-it-katex";

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
  attachmentId?: number;
  title?: string;
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
  };
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

function evidenceMarkerLabel(value: string): string | null {
  const match = value
    .trim()
    .match(
      /^\[?((?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+)\]?$/i,
    );
  return match ? `[${match[1]}]` : null;
}

function isEvidenceMarker(value: string): boolean {
  return !!evidenceMarkerLabel(value);
}

function createEvidenceChip(doc: Document, marker: string): HTMLElement {
  const chip = doc.createElement("span");
  chip.className = "claudero-evidence-chip";
  chip.textContent = marker;
  chip.setAttribute("role", "note");
  chip.setAttribute(
    "title",
    `${marker} evidence marker. Use the cited evidence tool output for provenance.`,
  );
  chip.dataset.evidenceMarker = marker.slice(1, -1);
  return chip;
}

function parseEvidenceLocator(href: string): EvidenceLinkLocator | null {
  if (!href.startsWith(evidenceScheme)) return null;
  try {
    const encoded = href.slice(evidenceScheme.length);
    const parsed = JSON.parse(decodeURIComponent(encoded));
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
    return `${marker} evidence marker. Use the cited evidence tool output for provenance.`;
  }
  const parts = [
    marker,
    locator.sourceType ? `source: ${locator.sourceType}` : "",
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
  return `${parts.join("\n")}\nClick to open the source location.`;
}

function removeEvidencePopover(doc: Document): void {
  doc.querySelector(".claudero-evidence-popover")?.remove();
}

function showEvidencePopover(
  doc: Document,
  trigger: Element,
  marker: string,
  locator: EvidenceLinkLocator,
): void {
  removeEvidencePopover(doc);
  const card = doc.createElement("div");
  card.className = "claudero-evidence-popover";

  const label = doc.createElement("div");
  label.className = "claudero-evidence-popover-label";
  label.textContent = marker;
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
    locator.sourceType ? `Source: ${locator.sourceType}` : "",
    typeof page === "number" ? `Page: ${page}` : "",
    typeof locator.paragraphIndex === "number"
      ? `Paragraph: ${locator.paragraphIndex + 1}`
      : "",
    locator.annotationKey ? `Annotation: ${locator.annotationKey}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  card.appendChild(details);

  if (locator.title) {
    const title = doc.createElement("div");
    title.className = "claudero-evidence-popover-title";
    title.textContent = locator.title;
    card.appendChild(title);
  }

  const hint = doc.createElement("div");
  hint.className = "claudero-evidence-popover-hint";
  hint.textContent = "Click to open in Zotero Reader";
  card.appendChild(hint);

  doc.body.appendChild(card);
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
  const zotero = (
    globalThis as unknown as {
      Zotero?: {
        Reader?: {
          open?: (
            attachmentId: number,
            options?: Record<string, unknown>,
          ) => Promise<unknown> | unknown;
        };
        launchURL?: (url: string) => void;
      };
    }
  ).Zotero;
  const attachmentId = Number(locator.attachmentId || 0);
  const position =
    locator.position && typeof locator.position.pageIndex === "number"
      ? locator.position
      : typeof locator.pageIndex === "number"
        ? { pageIndex: locator.pageIndex }
        : undefined;

  if (attachmentId && zotero?.Reader?.open) {
    await zotero.Reader.open(attachmentId, position ? { position } : undefined);
    return;
  }
  if (locator.openUri && zotero?.launchURL) {
    zotero.launchURL(locator.openUri);
    return;
  }
  doc.defaultView?.open(locator.openUri || href);
}

function enhanceEvidenceMarkers(container: HTMLElement): void {
  const doc = container.ownerDocument;
  container.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    const locator = parseEvidenceLocator(href);
    const text = link.textContent || "";
    const markerLabel = evidenceMarkerLabel(text);
    const marker = markerLabel || "[evidence]";
    if (markerLabel || locator) {
      link.classList.add("claudero-evidence-chip", "linked");
      link.setAttribute("title", evidenceLocatorTitle(marker, locator));
    }
    if (locator) {
      link.addEventListener("mouseenter", () =>
        showEvidencePopover(doc, link, marker, locator),
      );
      link.addEventListener("mouseleave", () => removeEvidencePopover(doc));
      link.addEventListener("focus", () =>
        showEvidencePopover(doc, link, marker, locator),
      );
      link.addEventListener("blur", () => removeEvidencePopover(doc));
      link.addEventListener("click", (event) => {
        event.preventDefault();
        void openEvidenceLocator(doc, locator, href);
      });
      return;
    }
    if (href.startsWith("zotero://")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const launcher = (
          globalThis as unknown as {
            Zotero?: { launchURL?: (url: string) => void };
          }
        ).Zotero?.launchURL;
        if (launcher) {
          launcher(href);
        } else {
          doc.defaultView?.open(href);
        }
      });
    }
  });

  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest("code, pre, a, button, .claudero-evidence-chip")) {
        return NodeFilter.FILTER_REJECT;
      }
      return /\[(?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+\]/i.test(
        node.nodeValue || "",
      )
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  const markerPattern =
    /\[(?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+\]/gi;
  for (const node of textNodes) {
    const text = node.nodeValue || "";
    const fragment = doc.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(markerPattern)) {
      const marker = match[0];
      const index = match.index ?? 0;
      if (index > lastIndex) {
        fragment.appendChild(doc.createTextNode(text.slice(lastIndex, index)));
      }
      fragment.appendChild(createEvidenceChip(doc, marker));
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
  const normalized = normalizeMathDelimiters(text);
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

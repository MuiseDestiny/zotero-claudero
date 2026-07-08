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

function isEvidenceMarker(value: string): boolean {
  return /^\[(?:para|anno|fig|figure|table|claim|evidence)-[A-Za-z0-9_.:-]+\]$/i.test(
    value.trim(),
  );
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

function enhanceEvidenceMarkers(container: HTMLElement): void {
  const doc = container.ownerDocument;
  container.querySelectorAll("a[href]").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (isEvidenceMarker(link.textContent || "")) {
      link.classList.add("claudero-evidence-chip", "linked");
    }
    if (href.startsWith("zotero://")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        try {
          (
            globalThis as unknown as {
              Zotero?: { launchURL?: (url: string) => void };
            }
          ).Zotero?.launchURL?.(href);
        } catch {
          // Fall back to the default browser handling if Zotero.launchURL is unavailable.
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

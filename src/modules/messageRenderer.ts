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
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/\\\((.+?)\\\)/g, (_m, formula) => `$${formula.trim()}$`)
      .replace(/\\\[([\s\S]*?)\\\]/g, (_m, formula) => `
$$
${formula.trim()}
$$
`);
  }).join("");
}

export function renderMarkdown(doc: Document, container: HTMLElement, text: string): void {
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
}

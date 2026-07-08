#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import MarkdownIt from "markdown-it";

const root = process.cwd();

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const locator = {
  itemId: 11,
  itemKey: "ITEMKEY",
  attachmentId: 22,
  attachmentKey: "ATTACHKEY",
  title: "Golden Evidence Fixture",
  sourceType: "pdfjs",
  pageIndex: 2,
  pageNumber: 3,
  paragraphIndex: 4,
  position: {
    pageIndex: 2,
    rects: [
      [10.1, 20.2, 30.3, 40.4],
      [50.5, 60.6, 70.7, 80.8],
    ],
  },
};

const href = `claudero-evidence:${encodeURIComponent(JSON.stringify(locator))}`;
const decoded = JSON.parse(
  decodeURIComponent(href.slice("claudero-evidence:".length)),
);
assert(decoded.attachmentId === 22, "locator attachmentId should round-trip");
assert(decoded.position.rects.length === 2, "locator rects should round-trip");
assert(decoded.pageNumber === 3, "locator pageNumber should round-trip");

const markdown = new MarkdownIt({ html: false, linkify: true });
const html = markdown.render(`[para-5](${href})`);
assert(
  html.includes('href="claudero-evidence:'),
  "markdown-it should preserve claudero-evidence links",
);
assert(html.includes(">para-5</a>"), "markdown label should survive");

const renderer = read("src/modules/messageRenderer.ts");
assert(
  renderer.includes("Zotero?:") && renderer.includes("Reader?:"),
  "message renderer should retain Zotero Reader opener contract",
);
assert(
  renderer.includes("mouseenter") && renderer.includes("focus"),
  "message renderer should expose hover and keyboard evidence details",
);

const evidence = read("src/modules/evidence.ts");
for (const marker of [
  "EvidenceFigureTableContext",
  "EvidencePageImage",
  "FigureTablePageInspection",
  "pageImage?: EvidencePageImage",
  "imageInput?: EvidenceImageInput",
  "inspectFigureTablePage",
  "includePageImages?: boolean",
  'source: "pdfjs-canvas" | "open-pdf-uri"',
  "Use the attached rendered page screenshot as the primary source of truth.",
  "pageContext",
  "samePageEvidenceIds",
  "rects: paragraph.locator.position?.rects?.slice",
  "treat the full rendered page as the visual source of truth",
]) {
  assert(evidence.includes(marker), `evidence source missing ${marker}`);
}

process.stdout.write("[evidence-golden] PASS locator and context fixture\n");

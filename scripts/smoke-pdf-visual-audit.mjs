#!/usr/bin/env node
import process from "node:process";
import {
  buildVisualAuditPack,
  selectVisualAuditItems,
} from "./build-pdf-visual-audit-pack.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function item(id, autoCategories, categories = []) {
  return {
    id,
    name: `${id}.pdf`,
    path: `/tmp/${id}.pdf`,
    pdfUrl: `file:///tmp/${id}.pdf`,
    categories,
    figureTableCaptionCount: autoCategories.includes("caption-risk") ? 4 : 0,
    tableCount: 0,
    autoReview: {
      verdict: autoCategories.includes("metadata-mismatch")
        ? "exclude-review"
        : autoCategories.length
          ? "needs-review"
          : "golden-candidate",
      categories: autoCategories,
      renderedTextChars: autoCategories.includes("ocr-candidate") ? 0 : 1200,
      captionReview: {
        candidates: [
          {
            pageNumber: 2,
            label: "figure 1",
            text: "Figure 1 shows a body-reference candidate.",
            risk: "review",
            reasons: ["body reference"],
          },
        ],
      },
    },
    pageImages: [
      {
        pageNumber: 1,
        src: "assets/page-1.png",
        text: autoCategories.includes("ocr-candidate") ? "" : "Readable text",
      },
    ],
    tasks: [{ id: "weak-text" }],
  };
}

const sourceItems = [
  item("plain", [], ["modern"]),
  item("caption", ["caption-risk"], ["caption"]),
  item("ocr", ["ocr-candidate"], ["weak-text"]),
  item("mismatch", ["metadata-mismatch"], ["quote"]),
];

const selected = selectVisualAuditItems(sourceItems, 3).map(
  (entry) => entry.id,
);
assert(selected.includes("mismatch"), "metadata mismatch should be selected");
assert(selected.includes("ocr"), "OCR candidate should be selected");
assert(selected.includes("caption"), "caption risk should be selected");

const pack = buildVisualAuditPack(
  { reviewId: "fixture", items: sourceItems },
  { reviewPath: "/tmp/review/data.js", limit: 4, pagesPerItem: 1 },
);
assert(pack.summary.auditItems === 4, "audit item count should match limit");
assert(pack.summary.auditPages === 4, "audit page count should match pages");
assert(
  pack.items.find((entry) => entry.id === "mismatch")?.checks[0]?.id ===
    "title-metadata-match",
  "metadata mismatch should produce title check",
);
assert(
  pack.items.find((entry) => entry.id === "ocr")?.checks[0]?.id ===
    "ocr-needed",
  "OCR candidate should produce OCR check",
);
assert(
  pack.items
    .find((entry) => entry.id === "caption")
    ?.checks.some((check) => check.id === "caption-boundary"),
  "caption risk should produce caption boundary check",
);

process.stdout.write("[pdf-visual-audit] PASS smoke\n");

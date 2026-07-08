#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaultReviewData = path.join(
  repoRoot,
  ".claudero-eval",
  "review-site",
  "data.js",
);
const defaultOut = path.join(
  repoRoot,
  ".claudero-eval",
  "pdf-visual-audit-manifest.json",
);

function parseArgs(argv) {
  const args = {
    review: process.env.CLAUDERO_PDF_REVIEW_DATA || defaultReviewData,
    out: process.env.CLAUDERO_PDF_VISUAL_AUDIT_OUT || defaultOut,
    limit: Number(process.env.CLAUDERO_PDF_VISUAL_AUDIT_LIMIT || 10),
    pagesPerItem: Number(
      process.env.CLAUDERO_PDF_VISUAL_AUDIT_PAGES_PER_ITEM || 4,
    ),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--review" && next) {
      args.review = next;
      i += 1;
    } else if (arg === "--out" && next) {
      args.out = next;
      i += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg === "--pages-per-item" && next) {
      args.pagesPerItem = Number(next);
      i += 1;
    }
  }
  return args;
}

export function parseReviewData(source) {
  const text = String(source || "").trim();
  const json = text
    .replace(/^window\.__CLAUDERO_REVIEW_DATA__\s*=\s*/, "")
    .replace(/;\s*$/, "");
  return JSON.parse(json);
}

function riskScore(item) {
  const categories = new Set(item.autoReview?.categories || []);
  let score = 0;
  if (categories.has("metadata-mismatch")) score += 100;
  if (categories.has("ocr-candidate")) score += 90;
  if (categories.has("caption-risk")) score += 70;
  if ((item.categories || []).includes("quote")) score += 20;
  if ((item.categories || []).includes("classic")) score += 12;
  if ((item.categories || []).includes("modern")) score += 8;
  score += Math.min(12, Number(item.figureTableCaptionCount || 0));
  score += Math.min(8, Number(item.tableCount || 0));
  return score;
}

function uniquePush(map, item) {
  if (!item?.id || map.has(item.id)) return;
  map.set(item.id, item);
}

export function selectVisualAuditItems(items, limit) {
  const selected = new Map();
  const buckets = [
    (item) => item.autoReview?.categories?.includes("metadata-mismatch"),
    (item) => item.autoReview?.categories?.includes("ocr-candidate"),
    (item) => item.autoReview?.categories?.includes("caption-risk"),
    (item) => (item.categories || []).includes("quote"),
    (item) => (item.categories || []).includes("classic"),
    (item) => (item.categories || []).includes("modern"),
  ];

  for (const bucket of buckets) {
    const candidates = items
      .filter(bucket)
      .sort((a, b) => riskScore(b) - riskScore(a));
    for (const candidate of candidates.slice(0, 2)) {
      uniquePush(selected, candidate);
      if (selected.size >= limit) return [...selected.values()];
    }
  }

  for (const candidate of [...items].sort(
    (a, b) => riskScore(b) - riskScore(a),
  )) {
    uniquePush(selected, candidate);
    if (selected.size >= limit) break;
  }
  return [...selected.values()];
}

function visualChecksFor(item) {
  const checks = [];
  const autoCategories = item.autoReview?.categories || [];
  if (autoCategories.includes("metadata-mismatch")) {
    checks.push({
      id: "title-metadata-match",
      instruction:
        "Compare the filename/title metadata with the rendered first page title. Mark as exclude if they describe different papers.",
      expected: item.name,
    });
  }
  if (autoCategories.includes("ocr-candidate")) {
    checks.push({
      id: "ocr-needed",
      instruction:
        "Inspect whether the rendered page contains readable text while extracted text is empty or tiny. Mark as OCR candidate if yes.",
      expected: `rendered text chars: ${item.autoReview?.renderedTextChars || 0}`,
    });
  }
  if (autoCategories.includes("caption-risk")) {
    checks.push({
      id: "caption-boundary",
      instruction:
        "Inspect figure/table candidates and decide which are true captions versus body references such as 'Figure 1 shows...'.",
      expected: (item.autoReview?.captionReview?.candidates || [])
        .filter((candidate) => candidate.risk === "review")
        .slice(0, 6)
        .map(
          (candidate) =>
            `page ${candidate.pageNumber}: ${candidate.label || "caption"} - ${
              candidate.text
            }`,
        ),
    });
  }
  if (item.quoteFixture) {
    checks.push({
      id: "quote-page",
      instruction:
        "Verify visually that the quoted content belongs to the expected rendered page or flag if text extraction appears unrelated.",
      expected: {
        pageNumber: item.quoteFixture.expectedPageNumber,
        quote: item.quoteFixture.quote,
      },
    });
  }
  return checks;
}

function pageImagePath(reviewPath, src) {
  return path.resolve(path.dirname(reviewPath), src);
}

function auditItemFromReviewItem(item, reviewPath, pagesPerItem) {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    riskScore: riskScore(item),
    autoReview: item.autoReview || null,
    categories: item.categories || [],
    checks: visualChecksFor(item),
    pageImages: (item.pageImages || []).slice(0, pagesPerItem).map((page) => ({
      pageNumber: page.pageNumber,
      imagePath: pageImagePath(reviewPath, page.src),
      extractedTextChars: String(page.text || "").length,
      extractedTextPreview: String(page.text || "").slice(0, 700),
    })),
    modelReviewTemplate: {
      verdict: "undecided",
      confidence: 0,
      findings: [],
      fixtureUse: "undecided",
    },
  };
}

export function buildVisualAuditPack(reviewData, options = {}) {
  const reviewPath = options.reviewPath || defaultReviewData;
  const limit = Number(options.limit || 10);
  const pagesPerItem = Number(options.pagesPerItem || 4);
  const items = selectVisualAuditItems(reviewData.items || [], limit).map(
    (item) => auditItemFromReviewItem(item, reviewPath, pagesPerItem),
  );
  const counts = items.reduce(
    (acc, item) => {
      for (const category of item.autoReview?.categories || []) {
        acc.autoCategories[category] = (acc.autoCategories[category] || 0) + 1;
      }
      acc.checks += item.checks.length;
      acc.pages += item.pageImages.length;
      return acc;
    },
    { checks: 0, pages: 0, autoCategories: {} },
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceReviewId: reviewData.reviewId || "",
    sourceReport: reviewData.sourceReport || "",
    sourceRoot: reviewData.sourceRoot || "",
    reviewDataPath: reviewPath,
    instructions: [
      "Use rendered page images as the primary source of truth.",
      "Do not trust extracted text when it conflicts with the screenshot.",
      "Mark metadata mismatches as negative fixtures.",
      "Mark readable screenshots with empty extracted text as OCR fixtures.",
      "Separate true figure/table captions from body references.",
    ],
    summary: {
      sourceItems: (reviewData.items || []).length,
      auditItems: items.length,
      auditPages: counts.pages,
      auditChecks: counts.checks,
      autoCategories: counts.autoCategories,
    },
    items,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.review)) {
    throw new Error(
      `Review data not found: ${args.review}. Run npm run eval:pdf:review first.`,
    );
  }
  const reviewData = parseReviewData(readFileSync(args.review, "utf8"));
  const pack = buildVisualAuditPack(reviewData, {
    reviewPath: args.review,
    limit: args.limit,
    pagesPerItem: args.pagesPerItem,
  });
  mkdirSync(path.dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(pack, null, 2)}\n`);
  process.stdout.write(
    [
      `[pdf-visual-audit] review ${args.review}`,
      `[pdf-visual-audit] items ${pack.summary.auditItems}, pages ${pack.summary.auditPages}, checks ${pack.summary.auditChecks}`,
      `[pdf-visual-audit] out ${args.out}`,
    ].join("\n") + "\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[pdf-visual-audit] FAIL ${
        error instanceof Error ? error.stack || error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}

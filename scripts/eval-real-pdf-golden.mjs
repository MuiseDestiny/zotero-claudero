#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    root: process.env.CLAUDERO_PDF_FIXTURE_ROOT || "",
    limit: Number(process.env.CLAUDERO_PDF_EVAL_LIMIT || 12),
    maxPages: Number(process.env.CLAUDERO_PDF_EVAL_MAX_PAGES || 6),
    python: process.env.PYTHON || "python3",
    report: path.join(repoRoot, ".claudero-eval", "pdf-golden-report.json"),
    minQuoteFixtures: 3,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--root" && next) {
      args.root = next;
      i += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg === "--max-pages" && next) {
      args.maxPages = Number(next);
      i += 1;
    } else if (arg === "--python" && next) {
      args.python = next;
      i += 1;
    } else if (arg === "--report" && next) {
      args.report = next;
      i += 1;
    } else if (arg === "--min-quote-fixtures" && next) {
      args.minQuoteFixtures = Number(next);
      i += 1;
    }
  }
  return args;
}

function walkPdfFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        out.push(fullPath);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function stableHash(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectDiverse(files, limit) {
  if (!Number.isFinite(limit) || limit <= 0 || files.length <= limit) {
    return files;
  }
  const selected = new Map();
  const buckets = [
    (file) => /\.zh\.|no_watermark|magic|dual|mono/i.test(file),
    (file) => Array.from(file).some((char) => char.charCodeAt(0) > 127),
    (file) => /(?:^|[^\d])202[0-9](?:[^\d]|$)/.test(file),
    (file) => /(?:^|[^\d])19[0-9]{2}(?:[^\d]|$)/.test(file),
    () => true,
  ];
  for (const bucket of buckets) {
    const candidates = files
      .filter(bucket)
      .sort((a, b) => stableHash(a) - stableHash(b));
    for (const file of candidates) {
      selected.set(file, file);
      if (selected.size >= limit) return [...selected.values()];
      if (
        selected.size % Math.max(1, Math.floor(limit / buckets.length)) ===
        0
      ) {
        break;
      }
    }
  }
  for (const file of files.sort((a, b) => stableHash(a) - stableHash(b))) {
    selected.set(file, file);
    if (selected.size >= limit) break;
  }
  return [...selected.values()];
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value, maxLength = 260) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sentenceCandidates(text) {
  const pieces = String(text || "")
    .replace(/\[[0-9,\s-]+\]/g, " ")
    .split(/(?<=[。！？.!?])\s+|(?<=\.)\s+(?=[A-Z])|\n+/u)
    .map((entry) => entry.replace(/^\s*[-*|>\d.]+\s*/, "").trim())
    .filter((entry) => {
      if (entry.length < 80 || entry.length > 260) return false;
      if (/^(references|acknowledg|appendix|figure|table)\b/i.test(entry)) {
        return false;
      }
      return /[A-Za-z\u4e00-\u9fff]/.test(entry);
    });
  return [...new Set(pieces)];
}

function chooseQuoteFixture(extraction) {
  for (const page of extraction.pages || []) {
    const candidates = sentenceCandidates(page.text);
    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      const aScore = Math.abs(a.length - 150);
      const bScore = Math.abs(b.length - 150);
      return aScore - bScore;
    });
    return {
      quote: candidates[0],
      expectedPageIndex: page.pageIndex,
      expectedPageNumber: page.pageIndex + 1,
      snippet: compact(page.text, 360),
    };
  }
  return null;
}

function locateQuotePage(extraction, quote) {
  const needle = normalize(quote);
  if (!needle) return null;
  for (const page of extraction.pages || []) {
    if (normalize(page.text).includes(needle)) {
      return page.pageIndex;
    }
  }
  return null;
}

function figureTableCaptions(extraction) {
  const captions = [];
  const pattern =
    /(?:^|\s)((?:fig(?:ure)?\.?|table|图|表)\s*[0-9ivxlcdm一二三四五六七八九十百]+[\s:：.-][^。！？.!?\n]{12,260})/giu;
  for (const page of extraction.pages || []) {
    for (const match of String(page.text || "").matchAll(pattern)) {
      captions.push({
        pageIndex: page.pageIndex,
        pageNumber: page.pageIndex + 1,
        caption: compact(match[1], 320),
      });
      if (captions.length >= 12) return captions;
    }
  }
  return captions;
}

function extractPdf(file, args) {
  const extractor = path.join(__dirname, "pdf-eval-extract.py");
  const started = Date.now();
  const result = spawnSync(
    args.python,
    [extractor, file, String(args.maxPages)],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const elapsedMs = Date.now() - started;
  if (result.error) {
    return {
      error: result.error.message,
      path: file,
      elapsedMs,
      stderr: result.stderr || "",
    };
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    return {
      ...parsed,
      elapsedMs,
      exitCode: result.status,
      stderr: result.stderr || "",
    };
  } catch (error) {
    return {
      error: `extractor returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path: file,
      elapsedMs,
      stderr: result.stderr || "",
      stdout: result.stdout?.slice(0, 1000),
    };
  }
}

function fileInfo(file) {
  const stat = statSync(file);
  return {
    path: file,
    name: path.basename(file),
    relativePath: file,
    bytes: stat.size,
  };
}

function evaluateFile(file, args) {
  const base = fileInfo(file);
  const extraction = extractPdf(file, args);
  if (extraction.error) {
    return {
      ...base,
      status: "error",
      error: extraction.error,
      stderr: extraction.stderr,
      elapsedMs: extraction.elapsedMs,
    };
  }
  const quoteFixture = chooseQuoteFixture(extraction);
  const locatedPage =
    quoteFixture && locateQuotePage(extraction, quoteFixture.quote);
  const captions = figureTableCaptions(extraction);
  const textChars = (extraction.pages || []).reduce(
    (sum, page) => sum + String(page.text || "").length,
    0,
  );

  return {
    ...base,
    status: "ok",
    pageCount: extraction.pageCount,
    sampledPages: extraction.pages?.length || 0,
    textChars,
    encrypted: extraction.encrypted,
    metadata: extraction.metadata,
    tableCount: extraction.tableCount || 0,
    figureTableCaptionCount: captions.length,
    figureTableCaptions: captions,
    quoteFixture,
    quoteLocator: quoteFixture
      ? {
          expectedPageIndex: quoteFixture.expectedPageIndex,
          actualPageIndex: locatedPage,
          pass: locatedPage === quoteFixture.expectedPageIndex,
        }
      : null,
    warnings: extraction.warnings || [],
    elapsedMs: extraction.elapsedMs,
  };
}

function summarize(results, totalPdfCount) {
  const ok = results.filter((result) => result.status === "ok");
  const quoteFixtures = ok.filter((result) => result.quoteFixture);
  const quotePasses = ok.filter((result) => result.quoteLocator?.pass);
  return {
    totalPdfCount,
    sampledPdfCount: results.length,
    okPdfCount: ok.length,
    errorPdfCount: results.length - ok.length,
    quoteFixtureCount: quoteFixtures.length,
    quotePassCount: quotePasses.length,
    quotePassRate: quoteFixtures.length
      ? Number((quotePasses.length / quoteFixtures.length).toFixed(4))
      : 0,
    figureTablePdfCount: ok.filter(
      (result) =>
        result.figureTableCaptionCount > 0 ||
        Number(result.tableCount || 0) > 0,
    ).length,
    totalFigureTableCaptions: ok.reduce(
      (sum, result) => sum + Number(result.figureTableCaptionCount || 0),
      0,
    ),
    totalExtractedTables: ok.reduce(
      (sum, result) => sum + Number(result.tableCount || 0),
      0,
    ),
    totalTextChars: ok.reduce(
      (sum, result) => sum + Number(result.textChars || 0),
      0,
    ),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) {
    throw new Error(
      "Provide --root <PDF directory> or set CLAUDERO_PDF_FIXTURE_ROOT.",
    );
  }
  if (!existsSync(args.root)) {
    throw new Error(`PDF fixture root does not exist: ${args.root}`);
  }

  const allFiles = walkPdfFiles(args.root);
  if (!allFiles.length)
    throw new Error(`No PDF files found under ${args.root}`);
  const selected = selectDiverse(allFiles, args.limit);
  const results = selected.map((file) => evaluateFile(file, args));
  const summary = summarize(results, allFiles.length);
  const report = {
    generatedAt: new Date().toISOString(),
    root: args.root,
    options: {
      limit: args.limit,
      maxPages: args.maxPages,
      minQuoteFixtures: args.minQuoteFixtures,
      python: args.python,
    },
    summary,
    results,
  };

  mkdirSync(path.dirname(args.report), { recursive: true });
  writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(
    [
      `[pdf-eval] root ${args.root}`,
      `[pdf-eval] pdfs ${summary.totalPdfCount}, sampled ${summary.sampledPdfCount}, ok ${summary.okPdfCount}`,
      `[pdf-eval] quote fixtures ${summary.quoteFixtureCount}, pass ${summary.quotePassCount}, rate ${summary.quotePassRate}`,
      `[pdf-eval] figure/table PDFs ${summary.figureTablePdfCount}, captions ${summary.totalFigureTableCaptions}, extracted tables ${summary.totalExtractedTables}`,
      `[pdf-eval] report ${args.report}`,
    ].join("\n") + "\n",
  );

  if (summary.okPdfCount === 0) {
    throw new Error("No sampled PDFs could be extracted");
  }
  if (summary.quoteFixtureCount < args.minQuoteFixtures) {
    throw new Error(
      `Expected at least ${args.minQuoteFixtures} quote fixtures, got ${summary.quoteFixtureCount}`,
    );
  }
  if (summary.quotePassCount !== summary.quoteFixtureCount) {
    throw new Error("One or more generated quote locators failed");
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[pdf-eval] FAIL ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exit(1);
}

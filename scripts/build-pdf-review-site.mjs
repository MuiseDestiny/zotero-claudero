#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaultReport = path.join(
  repoRoot,
  ".claudero-eval",
  "pdf-golden-report.json",
);
const defaultOutDir = path.join(repoRoot, ".claudero-eval", "review-site");
const defaultPdftoppm =
  "/Users/muisedestiny/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/pdftoppm";
const defaultPython =
  "/Users/muisedestiny/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

function parseArgs(argv) {
  const args = {
    report: process.env.CLAUDERO_PDF_REVIEW_REPORT || defaultReport,
    outDir: process.env.CLAUDERO_PDF_REVIEW_OUT || defaultOutDir,
    limit: Number(process.env.CLAUDERO_PDF_REVIEW_LIMIT || 18),
    pdftoppm:
      process.env.PDFTOPPM ||
      (existsSync(defaultPdftoppm) ? defaultPdftoppm : "pdftoppm"),
    python:
      process.env.PYTHON ||
      (existsSync(defaultPython) ? defaultPython : "python3"),
    scale: Number(process.env.CLAUDERO_PDF_REVIEW_SCALE || 1200),
    maxPages: Number(process.env.CLAUDERO_PDF_REVIEW_MAX_PAGES || 8),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--report" && next) {
      args.report = next;
      i += 1;
    } else if (arg === "--out" && next) {
      args.outDir = next;
      i += 1;
    } else if (arg === "--limit" && next) {
      args.limit = Number(next);
      i += 1;
    } else if (arg === "--pdftoppm" && next) {
      args.pdftoppm = next;
      i += 1;
    } else if (arg === "--scale" && next) {
      args.scale = Number(next);
      i += 1;
    } else if (arg === "--max-pages" && next) {
      args.maxPages = Number(next);
      i += 1;
    } else if (arg === "--python" && next) {
      args.python = next;
      i += 1;
    }
  }
  return args;
}

function safeId(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `pdf-${(hash >>> 0).toString(36)}`;
}

function yearFromName(name) {
  const match = String(name || "").match(
    /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/,
  );
  return match ? Number(match[1]) : null;
}

function hasNonAscii(value) {
  return Array.from(String(value || "")).some(
    (char) => char.charCodeAt(0) > 127,
  );
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const filenameStopwords = new Set([
  "article",
  "based",
  "between",
  "from",
  "into",
  "journal",
  "paper",
  "study",
  "using",
  "with",
  "without",
]);

function filenameTitlePart(name) {
  const withoutExt = String(name || "").replace(/\.pdf$/i, "");
  const parts = withoutExt.split(/\s+-\s+/);
  if (parts.length >= 3) return parts.slice(2).join(" ");
  if (parts.length === 2) return parts[1];
  return withoutExt;
}

function titleSignalTokens(name) {
  return normalizeForMatch(filenameTitlePart(name))
    .split(" ")
    .filter((token) => {
      if (token.length < 4) return false;
      if (/^\d+$/.test(token)) return false;
      return !filenameStopwords.has(token);
    })
    .slice(0, 18);
}

function titleCoverage(name, firstPageText) {
  const tokens = titleSignalTokens(name);
  const haystack = normalizeForMatch(firstPageText);
  if (!tokens.length || !haystack) {
    return {
      ratio: null,
      matched: [],
      missing: tokens,
      tokenCount: tokens.length,
    };
  }
  const matched = tokens.filter((token) => haystack.includes(token));
  return {
    ratio: matched.length / tokens.length,
    matched,
    missing: tokens.filter((token) => !matched.includes(token)),
    tokenCount: tokens.length,
  };
}

function isTranslatedPdfArtifact(result) {
  const value = `${result.name || ""}\n${result.path || ""}`;
  return /(?:\.zh\.|\.mono\.pdf$|\.dual\.pdf$|\.zh\.mono|\.zh\.dual|no_watermark\.zh|debug\.no_watermark\.zh)/i.test(
    value,
  );
}

function categoriesFor(result) {
  const categories = [];
  const name = result.name || result.path || "";
  const year = yearFromName(name);
  if (result.quoteFixture) categories.push("quote");
  if (Number(result.figureTableCaptionCount || 0) > 0)
    categories.push("caption");
  if (Number(result.tableCount || 0) > 0) categories.push("table");
  if (Number(result.textChars || 0) < 2000 || !result.quoteFixture) {
    categories.push("weak-text");
  }
  if (isTranslatedPdfArtifact(result)) {
    categories.push("translated");
  }
  if (hasNonAscii(name)) categories.push("non-ascii-path");
  if (year && year <= 2000) categories.push("classic");
  if (year && year >= 2024) categories.push("modern");
  if (/magic/i.test(name)) categories.push("magic");
  return [...new Set(categories)];
}

function scoreResult(result) {
  const categories = categoriesFor(result);
  let score = 0;
  score += result.quoteFixture ? 4 : 0;
  score += Math.min(6, Number(result.figureTableCaptionCount || 0));
  score += Math.min(5, Number(result.tableCount || 0));
  score += categories.includes("weak-text") ? 6 : 0;
  score += categories.includes("translated") ? 5 : 0;
  score += categories.includes("classic") ? 3 : 0;
  score += categories.includes("modern") ? 3 : 0;
  score += categories.includes("non-ascii-path") ? 2 : 0;
  return score;
}

function selectReviewItems(results, limit) {
  const ok = results.filter(
    (result) => result.status === "ok" && !isTranslatedPdfArtifact(result),
  );
  const buckets = [
    (result) => categoriesFor(result).includes("weak-text"),
    (result) => Number(result.tableCount || 0) >= 5,
    (result) => Number(result.figureTableCaptionCount || 0) >= 5,
    (result) => categoriesFor(result).includes("classic"),
    (result) => categoriesFor(result).includes("modern"),
    (result) => Boolean(result.quoteFixture),
  ];
  const selected = new Map();
  for (const bucket of buckets) {
    const candidates = ok
      .filter(bucket)
      .sort((a, b) => scoreResult(b) - scoreResult(a));
    for (const candidate of candidates.slice(0, 3)) {
      selected.set(candidate.path, candidate);
      if (selected.size >= limit) return [...selected.values()];
    }
  }
  for (const candidate of ok.sort((a, b) => scoreResult(b) - scoreResult(a))) {
    selected.set(candidate.path, candidate);
    if (selected.size >= limit) break;
  }
  return [...selected.values()];
}

function pageNumbersFor(result) {
  const pages = new Set([1]);
  if (result.quoteFixture?.expectedPageNumber) {
    pages.add(result.quoteFixture.expectedPageNumber);
  }
  for (const caption of (result.figureTableCaptions || []).slice(0, 4)) {
    if (caption.pageNumber) pages.add(caption.pageNumber);
  }
  return [...pages]
    .filter((page) => Number.isFinite(page) && page > 0)
    .slice(0, 6);
}

function renderPageThumb(pdfPath, pageNumber, outPrefix, args) {
  const outDir = path.dirname(outPrefix);
  const outBase = path.basename(outPrefix);
  const result = spawnSync(
    args.pdftoppm,
    [
      "-f",
      String(pageNumber),
      "-l",
      String(pageNumber),
      "-png",
      "-scale-to",
      String(args.scale),
      pdfPath,
      outPrefix,
    ],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const imageName = readdirSync(outDir)
    .filter((name) => name.startsWith(`${outBase}-`) && name.endsWith(".png"))
    .sort()
    .at(0);
  const imagePath = imageName ? path.join(outDir, imageName) : "";
  if (result.error || result.status !== 0 || !existsSync(imagePath)) {
    return {
      ok: false,
      error:
        result.error?.message ||
        result.stderr ||
        `pdftoppm exited with ${result.status}`,
    };
  }
  return { ok: true, imagePath };
}

function extractPageTextMap(pdfPath, args) {
  const extractor = path.join(__dirname, "pdf-eval-extract.py");
  const result = spawnSync(
    args.python,
    [extractor, pdfPath, String(args.maxPages)],
    {
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    return {
      pages: new Map(),
      warning:
        result.error?.message ||
        result.stderr ||
        `text extractor exited with ${result.status}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    const pages = new Map(
      (parsed.pages || []).map((page) => [
        Number(page.pageIndex) + 1,
        String(page.text || ""),
      ]),
    );
    return { pages, warning: null };
  } catch (error) {
    return {
      pages: new Map(),
      warning: `text extractor returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function buildTasks(result) {
  const tasks = [];
  if (result.quoteFixture) {
    tasks.push({
      id: "quote-page",
      title: "引文页码定位",
      prompt: "确认这段引文确实出现在预期页码，并且不是文本抽取造成的假内容。",
      expected: `第 ${result.quoteFixture.expectedPageNumber} 页`,
      evidence: result.quoteFixture.quote,
    });
  }
  if (
    Number(result.figureTableCaptionCount || 0) > 0 ||
    Number(result.tableCount || 0) > 0
  ) {
    tasks.push({
      id: "figure-table",
      title: "图表证据来源",
      prompt: "确认 caption 和表格抽取信号确实对应渲染页上的真实图/表证据。",
      expected: `${result.figureTableCaptionCount || 0} 个 caption，${
        result.tableCount || 0
      } 个抽取表格`,
      evidence: (result.figureTableCaptions || [])
        .slice(0, 5)
        .map((caption) => `第 ${caption.pageNumber} 页：${caption.caption}`)
        .join("\n"),
    });
  }
  if (Number(result.textChars || 0) < 2000 || !result.quoteFixture) {
    tasks.push({
      id: "weak-text",
      title: "弱文本或扫描 PDF",
      prompt: "确认该 PDF 是否为扫描件、图片较多、翻译版，或文本抽取质量较弱。",
      expected: `样本页抽取出 ${result.textChars || 0} 个字符`,
      evidence:
        "如果渲染页上文字可读，但抽取文本为空或很少，请标记“需要修复”，后续用于 OCR/版面处理。",
    });
  }
  return tasks;
}

function captionLabel(caption) {
  const match = String(caption || "").match(
    /\b((?:fig(?:ure)?\.?|table|图|表)\s*[0-9ivxlcdm一二三四五六七八九十百]+)/iu,
  );
  return match ? normalizeForMatch(match[1]).replace(/\s+/g, " ") : "";
}

function captionRiskReasons(caption, duplicateCount) {
  const text = String(caption || "");
  const normalized = normalizeForMatch(text);
  const reasons = [];
  if (duplicateCount > 1) {
    reasons.push("同页同编号出现多个候选，可能混入正文引用或重复抽取。");
  }
  if (
    /\b(?:fig(?:ure)?\.?|table)\s*[0-9ivxlcdm]+\.?\s+(?:shows?|illustrates?|reports?|presents?|displays?|depicts?|summari[sz]es?|lists?|is|are|was|were)\b/i.test(
      text,
    ) ||
    /\b(?:shown|listed|reported|given|presented|illustrated)\s+in\s+(?:fig(?:ure)?\.?|table)\b/i.test(
      text,
    ) ||
    /\b(?:see|according to)\s+(?:fig(?:ure)?\.?|table)\b/i.test(text)
  ) {
    reasons.push("措辞像正文中的图表引用，不一定是真实 caption。");
  }
  if (
    text.length >= 250 ||
    /\b(?:and|as|by|for|from|in|of|the|to|with)$/i.test(normalized)
  ) {
    reasons.push("候选文本较长或像被截断的句子，需要人工确认边界。");
  }
  if (!/[.:：。]\s*/u.test(text.slice(0, 28))) {
    reasons.push("编号后缺少明显 caption 分隔符，可能是正文句子。");
  }
  return reasons;
}

function analyzeCaptionCandidates(captions) {
  const counts = new Map();
  for (const caption of captions || []) {
    const label = captionLabel(caption.caption);
    if (!label) continue;
    const key = `${caption.pageNumber}:${label}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const candidates = (captions || []).slice(0, 12).map((caption) => {
    const label = captionLabel(caption.caption);
    const key = `${caption.pageNumber}:${label}`;
    const reasons = captionRiskReasons(caption.caption, counts.get(key) || 0);
    return {
      pageNumber: caption.pageNumber,
      label,
      text: caption.caption,
      risk: reasons.length ? "review" : "likely-caption",
      reasons,
    };
  });

  return {
    total: candidates.length,
    reviewCount: candidates.filter((candidate) => candidate.risk === "review")
      .length,
    candidates,
  };
}

function buildAutoReview(result, pageImages, textMap) {
  const issues = [];
  const categories = [];
  const renderedTextChars = pageImages.reduce(
    (sum, page) => sum + String(page.text || "").trim().length,
    0,
  );
  const hasRenderedPages = pageImages.length > 0;
  const firstPageText =
    textMap.pages.get(1) ||
    pageImages.find((page) => String(page.text || "").trim())?.text ||
    "";
  const coverage = titleCoverage(result.name, firstPageText);

  if (hasRenderedPages && renderedTextChars < 120) {
    categories.push("ocr-candidate");
    issues.push({
      kind: "ocr-candidate",
      severity: "high",
      title: "渲染页存在，但可搜索文本几乎为空",
      detail:
        "这通常说明 PDF 有可见文字但文本层缺失或不可抽取，适合进入 OCR/版面理解回归集。",
    });
  }

  if (
    coverage.ratio !== null &&
    coverage.tokenCount >= 4 &&
    coverage.ratio < 0.25
  ) {
    categories.push("metadata-mismatch");
    issues.push({
      kind: "metadata-mismatch",
      severity: "high",
      title: "文件名标题与首页文本高度不匹配",
      detail: `标题关键词命中 ${coverage.matched.length}/${coverage.tokenCount}。缺失关键词：${coverage.missing
        .slice(0, 8)
        .join("，")}`,
    });
  }

  const captionReview = analyzeCaptionCandidates(
    result.figureTableCaptions || [],
  );
  if (captionReview.reviewCount > 0) {
    categories.push("caption-risk");
    issues.push({
      kind: "caption-risk",
      severity: "medium",
      title: "部分图表候选可能是正文引用",
      detail: `${captionReview.reviewCount}/${captionReview.total} 个候选需要确认 caption 边界或去重。`,
    });
  }

  const verdict = categories.includes("metadata-mismatch")
    ? "exclude-review"
    : issues.length
      ? "needs-review"
      : "golden-candidate";

  return {
    verdict,
    categories,
    renderedTextChars,
    titleCoverage: coverage,
    captionReview,
    issues,
  };
}

function itemFromResult(result, args, assetsDir) {
  const id = safeId(result.path);
  const baseCategories = categoriesFor(result);
  const pageImages = [];
  const renderWarnings = [];
  const textMap = extractPageTextMap(result.path, args);
  if (textMap.warning) {
    renderWarnings.push(`text extraction: ${textMap.warning}`);
  }
  for (const pageNumber of pageNumbersFor(result)) {
    const outPrefix = path.join(assetsDir, `${id}-p${pageNumber}`);
    const rendered = renderPageThumb(result.path, pageNumber, outPrefix, args);
    if (rendered.ok) {
      pageImages.push({
        pageNumber,
        src: path.relative(args.outDir, rendered.imagePath),
        text: textMap.pages.get(pageNumber) || "",
      });
    } else {
      renderWarnings.push(`page ${pageNumber}: ${rendered.error}`);
    }
  }
  const autoReview = buildAutoReview(result, pageImages, textMap);
  const categories = [
    ...new Set([...baseCategories, ...autoReview.categories]),
  ];
  return {
    id,
    name: result.name,
    path: result.path,
    pdfUrl: pathToFileURL(result.path).href,
    pageCount: result.pageCount,
    sampledPages: result.sampledPages,
    textChars: result.textChars,
    tableCount: result.tableCount,
    figureTableCaptionCount: result.figureTableCaptionCount,
    categories,
    quoteFixture: result.quoteFixture
      ? {
          quote: result.quoteFixture.quote,
          expectedPageNumber: result.quoteFixture.expectedPageNumber,
          snippet: result.quoteFixture.snippet,
          locator: result.quoteLocator,
        }
      : null,
    figureTableCaptions: (result.figureTableCaptions || []).slice(0, 12),
    autoReview,
    warnings: [...(result.warnings || []), ...renderWarnings],
    pageImages,
    tasks: buildTasks(result),
    fixtureCandidate: {
      id,
      pdfPath: result.path,
      categories,
      quote: result.quoteFixture
        ? {
            text: result.quoteFixture.quote,
            pageNumber: result.quoteFixture.expectedPageNumber,
          }
        : null,
      figureTableCaptions: (result.figureTableCaptions || []).slice(0, 5),
      textQuality:
        Number(result.textChars || 0) < 2000 ? "weak-text" : "extractable-text",
      autoReview,
    },
  };
}

function htmlTemplate() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claudero PDF Golden 人工确认</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #667085;
      --line: #d8dee8;
      --blue: #2563eb;
      --green: #16803c;
      --red: #be3434;
      --amber: #9a6400;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 5;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(12px);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      letter-spacing: 0;
    }
    .sub {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    .shell {
      display: grid;
      grid-template-columns: 310px minmax(0, 1fr);
      min-height: calc(100vh - 64px);
    }
    aside {
      border-right: 1px solid var(--line);
      background: var(--panel);
      padding: 14px;
      overflow: auto;
    }
    main {
      padding: 18px;
      overflow: auto;
    }
    .controls, .summary, .item, .task, .page {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
    }
    .controls, .summary {
      padding: 12px;
      margin-bottom: 12px;
    }
    .filter-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    button, .pill, input, textarea, select {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      padding: 6px 9px;
      cursor: pointer;
    }
    button:hover { border-color: var(--blue); }
    button.active {
      border-color: var(--blue);
      background: #eff5ff;
      color: var(--blue);
    }
    button.good.active { border-color: var(--green); color: var(--green); background: #edf8f1; }
    button.bad.active { border-color: var(--red); color: var(--red); background: #fff0f0; }
    button.warn.active { border-color: var(--amber); color: var(--amber); background: #fff8e8; }
    .item-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .nav-item {
      width: 100%;
      text-align: left;
      padding: 9px;
      border-radius: 7px;
    }
    .nav-item .name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    .nav-item .meta {
      display: block;
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      height: 22px;
      padding: 0 7px;
      border: 1px solid #d7dce4;
      border-radius: 999px;
      background: #f9fafb;
      color: #3b4555;
      font-size: 12px;
      white-space: nowrap;
    }
    .item {
      padding: 16px;
    }
    .item-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      margin-bottom: 14px;
    }
    .item h2 {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }
    .path {
      margin-top: 6px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(5, minmax(88px, 1fr));
      gap: 8px;
      margin-bottom: 14px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px;
      background: #fbfcfe;
    }
    .stat b {
      display: block;
      font-size: 16px;
    }
    .stat span {
      color: var(--muted);
      font-size: 11px;
    }
    .review-grid {
      display: grid;
      grid-template-columns: minmax(0, 0.92fr) minmax(360px, 1.08fr);
      gap: 14px;
      align-items: start;
    }
    .task {
      padding: 12px;
      margin-bottom: 10px;
    }
    .precheck {
      padding: 12px;
      margin-bottom: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
    }
    .precheck h3 {
      margin: 0 0 8px;
      font-size: 14px;
    }
    .precheck-head {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
    }
    .issue-list {
      display: grid;
      gap: 7px;
      margin-top: 8px;
    }
    .issue {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px;
      background: #fff;
    }
    .issue.high {
      border-color: #f1b7b7;
      background: #fff8f8;
    }
    .issue.medium {
      border-color: #edd28c;
      background: #fffaf0;
    }
    .issue b {
      display: block;
      margin-bottom: 2px;
      font-size: 12px;
    }
    .issue span {
      color: var(--muted);
      font-size: 12px;
    }
    .caption-risk-list {
      max-height: 180px;
      overflow: auto;
      display: grid;
      gap: 6px;
      margin-top: 8px;
    }
    .caption-risk {
      padding: 7px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      font-size: 12px;
    }
    .caption-risk .why {
      margin-top: 4px;
      color: var(--amber);
    }
    .task h3 {
      margin: 0 0 4px;
      font-size: 14px;
    }
    .task p {
      margin: 0 0 8px;
      color: var(--muted);
    }
    .evidence {
      max-height: 170px;
      overflow: auto;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcfe;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    .decision-row {
      display: flex;
      gap: 6px;
      margin-top: 9px;
      flex-wrap: wrap;
    }
    textarea {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      margin-top: 8px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      margin-bottom: 14px;
    }
    .search-row input {
      width: 100%;
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
    }
    .search-row span {
      align-self: center;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .pages {
      display: grid;
      gap: 12px;
    }
    .page {
      overflow: hidden;
    }
    .page-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
    }
    .page img {
      display: block;
      width: 100%;
      height: auto;
      background: #fff;
    }
    .page-text {
      max-height: 260px;
      overflow: auto;
      margin: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcfe;
      color: #303846;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    mark {
      padding: 0 2px;
      border-radius: 3px;
      background: #fff09a;
      color: inherit;
    }
    .empty {
      padding: 18px;
      color: var(--muted);
      text-align: center;
    }
    .export-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .progress {
      color: var(--muted);
      font-size: 12px;
    }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 1040px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; border-right: 0; border-bottom: 1px solid var(--line); }
      .review-grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Claudero PDF Golden 人工确认</h1>
      <div class="sub" id="subtitle"></div>
    </div>
    <div class="export-row">
      <button id="exportBtn">导出确认 JSON</button>
      <button id="resetBtn">重置标记</button>
    </div>
  </header>
  <div class="shell">
    <aside>
      <div class="summary" id="summary"></div>
      <div class="controls">
        <b>筛选</b>
        <div class="filter-grid" id="filters"></div>
      </div>
      <div class="progress" id="progress"></div>
      <div class="item-list" id="itemList"></div>
    </aside>
    <main>
      <section id="detail" class="item"></section>
    </main>
  </div>
  <script src="data.js"></script>
  <script>
    const data = window.__CLAUDERO_REVIEW_DATA__;
    const storageKey = "claudero-pdf-review:" + data.reviewId;
    let state = JSON.parse(localStorage.getItem(storageKey) || "{}");
    let selectedId = data.items[0]?.id || null;
    let activeFilter = "all";

    const labels = {
      all: "全部",
      pending: "待确认",
      quote: "引文",
      caption: "图表标题",
      table: "表格",
      "weak-text": "弱文本",
      translated: "翻译版",
      "non-ascii-path": "中文/非 ASCII 路径",
      classic: "经典论文",
      modern: "近年论文",
      magic: "Magic 版",
      "ocr-candidate": "OCR 候选",
      "metadata-mismatch": "元数据错配",
      "caption-risk": "Caption 风险",
      accept: "通过",
      "needs-fix": "需要修复",
      reject: "驳回",
      "golden-candidate": "Golden 候选",
      "needs-review": "需要预审",
      "exclude-review": "建议排除",
    };

    function label(value) {
      return labels[value] || value;
    }

    function save() {
      localStorage.setItem(storageKey, JSON.stringify(state));
      render();
    }

    function decision(itemId, taskId) {
      return state[itemId]?.tasks?.[taskId]?.status || "";
    }

    function setDecision(itemId, taskId, status) {
      state[itemId] ||= { tasks: {}, note: "" };
      state[itemId].tasks[taskId] ||= {};
      state[itemId].tasks[taskId].status = status;
      state[itemId].tasks[taskId].updatedAt = new Date().toISOString();
      save();
    }

    function setNote(itemId, value) {
      state[itemId] ||= { tasks: {}, note: "" };
      state[itemId].note = value;
      state[itemId].updatedAt = new Date().toISOString();
      localStorage.setItem(storageKey, JSON.stringify(state));
      renderProgress();
    }

    function setSearch(itemId, value) {
      state[itemId] ||= { tasks: {}, note: "" };
      state[itemId].search = value;
      localStorage.setItem(storageKey, JSON.stringify(state));
      renderDetail();
    }

    function filteredItems() {
      if (activeFilter === "all") return data.items;
      if (activeFilter === "pending") {
        return data.items.filter(item => item.tasks.some(task => !decision(item.id, task.id)));
      }
      return data.items.filter(item => item.categories.includes(activeFilter));
    }

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function highlightText(value, query) {
      const raw = String(value || "");
      const q = String(query || "").trim();
      if (!raw) return "该页没有可搜索文本。";
      if (!q) return escapeHtml(raw);
      const lower = raw.toLowerCase();
      const needle = q.toLowerCase();
      let html = "";
      let index = 0;
      while (index < raw.length) {
        const hit = lower.indexOf(needle, index);
        if (hit < 0) {
          html += escapeHtml(raw.slice(index));
          break;
        }
        html += escapeHtml(raw.slice(index, hit));
        html += \`<mark>\${escapeHtml(raw.slice(hit, hit + q.length))}</mark>\`;
        index = hit + q.length;
      }
      return html;
    }

    function searchHitCount(item, query) {
      const q = String(query || "").trim().toLowerCase();
      if (!q) return 0;
      return item.pageImages.reduce((sum, page) => {
        const text = String(page.text || "").toLowerCase();
        return sum + (text.split(q).length - 1);
      }, 0);
    }

    function renderSummary() {
      const autoCounts = data.items.reduce((acc, item) => {
        const verdict = item.autoReview?.verdict || "unknown";
        acc[verdict] = (acc[verdict] || 0) + 1;
        return acc;
      }, {});
      document.getElementById("subtitle").textContent =
        data.generatedAt + " · " + data.sourceReport;
      document.getElementById("summary").innerHTML = \`
        <b>\${data.items.length} 个待确认样本</b>
        <div class="chips">
          <span class="pill">\${data.summary.totalPdfCount} 个 PDF</span>
          <span class="pill">\${data.summary.sampledPdfCount} 个样本</span>
          <span class="pill">\${data.summary.quoteFixtureCount} 条引文</span>
          <span class="pill">\${data.summary.totalFigureTableCaptions} 个 caption</span>
          <span class="pill">\${data.summary.totalExtractedTables} 个表格</span>
          <span class="pill">已排除 \${data.filteredOutTranslated || 0} 个翻译/双语工件</span>
          <span class="pill">\${autoCounts["golden-candidate"] || 0} 个 Golden 候选</span>
          <span class="pill">\${autoCounts["needs-review"] || 0} 个需预审</span>
          <span class="pill">\${autoCounts["exclude-review"] || 0} 个建议排除</span>
        </div>\`;
    }

    function renderFilters() {
      const categories = [...new Set(data.items.flatMap(item => item.categories))].sort();
      const filters = ["all", "pending", ...categories];
      document.getElementById("filters").innerHTML = filters.map(filter => {
        const active = filter === activeFilter ? "active" : "";
        return \`<button class="\${active}" data-filter="\${escapeHtml(filter)}">\${escapeHtml(label(filter))}</button>\`;
      }).join("");
      document.querySelectorAll("[data-filter]").forEach(button => {
        button.onclick = () => {
          activeFilter = button.dataset.filter;
          const items = filteredItems();
          if (!items.some(item => item.id === selectedId)) selectedId = items[0]?.id || null;
          render();
        };
      });
    }

    function taskTotals() {
      let total = 0;
      let done = 0;
      for (const item of data.items) {
        for (const task of item.tasks) {
          total += 1;
          if (decision(item.id, task.id)) done += 1;
        }
      }
      return { total, done };
    }

    function renderProgress() {
      const totals = taskTotals();
      document.getElementById("progress").textContent =
        \`人工确认进度：\${totals.done}/\${totals.total}\`;
    }

    function renderList() {
      const items = filteredItems();
      document.getElementById("itemList").innerHTML = items.map(item => {
        const active = item.id === selectedId ? "active" : "";
        const done = item.tasks.filter(task => decision(item.id, task.id)).length;
        return \`<button class="nav-item \${active}" data-item="\${item.id}">
          <span class="name">\${escapeHtml(item.name)}</span>
          <span class="meta">\${done}/\${item.tasks.length} 项 · \${item.categories.map(label).join("，")}</span>
        </button>\`;
      }).join("") || '<div class="empty">没有符合筛选条件的样本。</div>';
      document.querySelectorAll("[data-item]").forEach(button => {
        button.onclick = () => {
          selectedId = button.dataset.item;
          render();
        };
      });
    }

    function renderDecisionButtons(item, task) {
      const current = decision(item.id, task.id);
      const buttons = [
        ["accept", "通过", "good"],
        ["needs-fix", "需要修复", "warn"],
        ["reject", "驳回", "bad"],
      ];
      return buttons.map(([status, label, cls]) =>
        \`<button class="\${cls} \${current === status ? "active" : ""}" data-decision="\${status}" data-task="\${task.id}">\${label}</button>\`
      ).join("");
    }

    function renderAutoReview(item) {
      const review = item.autoReview || { verdict: "needs-review", issues: [] };
      const issueHtml = (review.issues || []).map(issue => \`
        <div class="issue \${escapeHtml(issue.severity || "")}">
          <b>\${escapeHtml(issue.title)}</b>
          <span>\${escapeHtml(issue.detail)}</span>
        </div>\`
      ).join("") || '<div class="issue"><b>未发现自动预审风险</b><span>仍建议人工核对引文页码和图表来源。</span></div>';
      const riskyCaptions = (review.captionReview?.candidates || [])
        .filter(candidate => candidate.risk === "review")
        .slice(0, 6);
      const captionHtml = riskyCaptions.length ? \`
        <div class="caption-risk-list">
          \${riskyCaptions.map(candidate => \`
            <div class="caption-risk">
              <b>第 \${candidate.pageNumber} 页 · \${escapeHtml(candidate.label || "caption")}</b>
              <div>\${escapeHtml(candidate.text)}</div>
              <div class="why">\${escapeHtml((candidate.reasons || []).join("；"))}</div>
            </div>\`
          ).join("")}
        </div>\` : "";
      const coverage = review.titleCoverage?.ratio;
      const coverageText = coverage === null || coverage === undefined
        ? "标题覆盖率：无可比对文本"
        : "标题覆盖率：" + Math.round(coverage * 100) + "%";
      return \`
        <section class="precheck">
          <h3>自动预审</h3>
          <div class="precheck-head">
            <span class="pill">\${escapeHtml(label(review.verdict))}</span>
            <span class="pill">\${escapeHtml(coverageText)}</span>
            <span class="pill">渲染页文本 \${review.renderedTextChars || 0} 字符</span>
          </div>
          <div class="issue-list">\${issueHtml}</div>
          \${captionHtml}
        </section>\`;
    }

    function renderDetail() {
      const item = data.items.find(entry => entry.id === selectedId);
      const detail = document.getElementById("detail");
      if (!item) {
        detail.innerHTML = '<div class="empty">请选择一个待确认样本。</div>';
        return;
      }
      detail.innerHTML = \`
        <div class="item-head">
          <div>
            <h2>\${escapeHtml(item.name)}</h2>
            <div class="path">\${escapeHtml(item.path)}</div>
            <div class="chips">\${item.categories.map(cat => \`<span class="pill">\${escapeHtml(label(cat))}</span>\`).join("")}</div>
          </div>
          <a href="\${item.pdfUrl}" target="_blank" rel="noreferrer">打开 PDF</a>
        </div>
        <div class="stats">
          <div class="stat"><b>\${item.pageCount || "-"}</b><span>总页数</span></div>
          <div class="stat"><b>\${item.textChars || 0}</b><span>样本页字符数</span></div>
          <div class="stat"><b>\${item.figureTableCaptionCount || 0}</b><span>caption 数</span></div>
          <div class="stat"><b>\${item.tableCount || 0}</b><span>表格数</span></div>
          <div class="stat"><b>\${item.pageImages.length}</b><span>已渲染页</span></div>
        </div>
        <div class="search-row">
          <input id="pdfTextSearch" value="\${escapeHtml(state[item.id]?.search || "")}" placeholder="在当前 PDF 已抽取文本中搜索，例如方法名、引文片段、Figure 1..." />
          <span>\${searchHitCount(item, state[item.id]?.search || "")} 处命中</span>
        </div>
        <div class="review-grid">
          <div>
            \${renderAutoReview(item)}
            \${item.tasks.map(task => \`
              <section class="task">
                <h3>\${escapeHtml(task.title)}</h3>
                <p>\${escapeHtml(task.prompt)}</p>
                <div class="pill">\${escapeHtml(task.expected)}</div>
                <div class="evidence">\${escapeHtml(task.evidence)}</div>
                <div class="decision-row">\${renderDecisionButtons(item, task)}</div>
              </section>
            \`).join("")}
            <section class="task">
              <h3>人工备注</h3>
              <textarea id="noteBox" placeholder="记录人工修正、准确页码、OCR 问题、caption 不匹配，或作为 fixture 的备注。">\${escapeHtml(state[item.id]?.note || "")}</textarea>
            </section>
            \${item.warnings.length ? \`<section class="task"><h3>警告</h3><div class="evidence">\${escapeHtml(item.warnings.join("\\n"))}</div></section>\` : ""}
          </div>
          <div class="pages">
            \${item.pageImages.map(page => \`
              <figure class="page">
                <div class="page-title"><span>渲染页 \${page.pageNumber}</span><a href="\${item.pdfUrl}" target="_blank" rel="noreferrer">PDF</a></div>
                <img src="\${page.src}" alt="渲染页 \${page.pageNumber}" />
                <figcaption class="page-text">\${highlightText(page.text, state[item.id]?.search || "")}</figcaption>
              </figure>
            \`).join("") || '<div class="empty">没有渲染页，请直接打开 PDF。</div>'}
          </div>
        </div>\`;
      document.querySelectorAll("[data-decision]").forEach(button => {
        button.onclick = () => setDecision(item.id, button.dataset.task, button.dataset.decision);
      });
      const noteBox = document.getElementById("noteBox");
      if (noteBox) noteBox.oninput = () => setNote(item.id, noteBox.value);
      const searchBox = document.getElementById("pdfTextSearch");
      if (searchBox) searchBox.oninput = () => setSearch(item.id, searchBox.value);
    }

    function exportReview() {
      const payload = {
        reviewId: data.reviewId,
        generatedAt: new Date().toISOString(),
        sourceReport: data.sourceReport,
        decisions: state,
        fixtureCandidates: data.items.map(item => ({
          ...item.fixtureCandidate,
          decisions: state[item.id] || null,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2) + "\\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "claudero-pdf-review-decisions.json";
      link.click();
      URL.revokeObjectURL(url);
    }

    function render() {
      renderSummary();
      renderFilters();
      renderProgress();
      renderList();
      renderDetail();
    }

    document.getElementById("exportBtn").onclick = exportReview;
    document.getElementById("resetBtn").onclick = () => {
      if (confirm("确定要重置所有本地人工确认标记吗？")) {
        state = {};
        localStorage.removeItem(storageKey);
        render();
      }
    };
    render();
  </script>
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.report)) {
    throw new Error(
      `Report not found: ${args.report}. Run npm run eval:pdf:golden first.`,
    );
  }
  const report = JSON.parse(readFileSync(args.report, "utf8"));
  const items = selectReviewItems(report.results || [], args.limit);
  const filteredOutTranslated = (report.results || []).filter(
    (result) => result.status === "ok" && isTranslatedPdfArtifact(result),
  ).length;

  rmSync(args.outDir, { recursive: true, force: true });
  const assetsDir = path.join(args.outDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const reviewItems = items.map((result) =>
    itemFromResult(result, args, assetsDir),
  );
  const reviewData = {
    reviewId: `${report.generatedAt || "report"}:${reviewItems.length}`,
    generatedAt: new Date().toISOString(),
    sourceReport: path.relative(repoRoot, args.report),
    sourceRoot: report.root,
    summary: report.summary,
    filteredOutTranslated,
    items: reviewItems,
  };

  writeFileSync(
    path.join(args.outDir, "data.js"),
    `window.__CLAUDERO_REVIEW_DATA__ = ${JSON.stringify(reviewData, null, 2)};\n`,
  );
  writeFileSync(path.join(args.outDir, "index.html"), htmlTemplate());
  copyFileSync(args.report, path.join(args.outDir, "source-report.json"));

  const renderedPages = reviewItems.reduce(
    (sum, item) => sum + item.pageImages.length,
    0,
  );
  process.stdout.write(
    [
      `[pdf-review] items ${reviewItems.length}`,
      `[pdf-review] rendered pages ${renderedPages}`,
      `[pdf-review] site ${path.join(args.outDir, "index.html")}`,
    ].join("\n") + "\n",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[pdf-review] FAIL ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exit(1);
}

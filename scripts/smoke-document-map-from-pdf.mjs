#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const pdfPath = process.argv[2];
const maxPages = Number(process.argv[3] || 24);

if (!pdfPath || !existsSync(pdfPath)) {
  console.error(
    "Usage: node scripts/smoke-document-map-from-pdf.mjs <pdf> [maxPages]",
  );
  process.exit(2);
}

function runPython(code, args = []) {
  const result = spawnSync("python3", ["-c", code, ...args], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `python exited ${result.status}`,
    );
  }
  return JSON.parse(result.stdout);
}

const extraction = runPython(
  String.raw`
import json
import re
import sys
from pypdf import PdfReader

path = sys.argv[1]
max_pages = int(sys.argv[2])
reader = PdfReader(path)

def compact(text):
    return re.sub(r"\s+", " ", text or "").strip()

def flatten_outline(items, level=1):
    out = []
    for item in items or []:
        if isinstance(item, list):
            out.extend(flatten_outline(item, level + 1))
            continue
        try:
            page = reader.get_destination_page_number(item) + 1
        except Exception:
            page = None
        title = str(item.get("/Title", "")).strip() if hasattr(item, "get") else str(item)
        if title:
            out.append({"title": title, "page": page, "level": level})
    return out

pages = []
for index, page in enumerate(reader.pages[:max_pages]):
    try:
        text = compact(page.extract_text() or "")
    except Exception as exc:
        text = ""
    pages.append({"pageIndex": index, "pdfPage": index + 1, "text": text})

payload = {
    "pageCount": len(reader.pages),
    "encrypted": bool(reader.is_encrypted),
    "outline": flatten_outline(getattr(reader, "outline", [])),
    "pages": pages,
}
print(json.dumps(payload, ensure_ascii=False))
`,
  [pdfPath, String(maxPages)],
);

function normalizeText(text) {
  return (text || "")
    .replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10))
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tocScore(text) {
  const value = normalizeText(text);
  const titleHit = /目\s*录/.test(value) ? 8 : 0;
  const chapterHits = (value.match(/第[一二三四五六七八九十百]+[章节]/g) || [])
    .length;
  const leaderHits = (value.match(/(?:\.|·|…|．){3,}/g) || []).length;
  const trailingPageHits = (
    value.match(
      /[^\d](?:\d{1,3})(?=\s+(?:第|[一二三四五六七八九十]、|本章|参考|致|攻读|$))/g,
    ) || []
  ).length;
  return titleHit + chapterHits + leaderHits + trailingPageHits;
}

function cleanTitle(value) {
  return value
    .replace(/\s+/g, "")
    .replace(/(?:\.|·|…|．)+$/g, "")
    .trim();
}

function titleKey(value) {
  return cleanTitle(value)
    .replace(/[：:]/g, ":")
    .replace(/[——－-]+/g, "-")
    .toLowerCase();
}

function inferLevel(title) {
  if (/^第[一二三四五六七八九十百]+章/.test(title)) return 1;
  if (/^第[一二三四五六七八九十百]+节/.test(title)) return 2;
  if (/^[一二三四五六七八九十]+、/.test(title)) return 3;
  if (/^本章小结$/.test(title)) return 2;
  return 1;
}

function parseTocEntries(pages) {
  const tocPages = pages
    .map((page) => ({ ...page, score: tocScore(page.text) }))
    .filter((page) => page.score >= 8);

  const joined = normalizeText(tocPages.map((page) => page.text).join(" "));
  const entryPattern =
    /(引\s*言|第[一二三四五六七八九十百]+章\s*[^.…·．]{2,80}|第[一二三四五六七八九十百]+节\s*[^.…·．]{2,100}|[一二三四五六七八九十]+、\s*[^.…·．]{2,100}|本章小结|参考文献|致\s*谢|攻读学位期间研究成果)\s*(?:\.|·|…|．|\s){2,}\s*(\d{1,3})/g;
  const seen = new Set();
  const entries = [];
  let match;
  while ((match = entryPattern.exec(joined))) {
    const title = cleanTitle(match[1]);
    const page = Number(match[2]);
    const key = `${title}:${page}`;
    if (!title || !page || seen.has(key)) continue;
    seen.add(key);
    entries.push({ title, page, level: inferLevel(title) });
  }
  return { tocPages, entries };
}

function buildSections(entries) {
  return entries.map((entry, index) => {
    const next = entries
      .slice(index + 1)
      .find((candidate) => candidate.level <= entry.level);
    return {
      ...entry,
      endPrintedPage: next
        ? Math.max(
            entry.printedPage ?? entry.page,
            (next.printedPage ?? next.page) - 1,
          )
        : null,
      endPdfPage:
        entry.pdfPage && next?.pdfPage
          ? Math.max(entry.pdfPage, next.pdfPage - 1)
          : null,
    };
  });
}

const parsed = parseTocEntries(extraction.pages);
const outlineByTitle = new Map();
for (const outlineEntry of extraction.outline) {
  if (!outlineEntry.page) continue;
  const key = titleKey(outlineEntry.title);
  const list = outlineByTitle.get(key) || [];
  list.push(outlineEntry);
  outlineByTitle.set(key, list);
}
const offsets = parsed.entries
  .flatMap((entry) =>
    (outlineByTitle.get(titleKey(entry.title)) || []).map(
      (outlineEntry) => outlineEntry.page - entry.page,
    ),
  )
  .filter((offset) => Number.isFinite(offset));
const offsetCounts = new Map();
for (const offset of offsets)
  offsetCounts.set(offset, (offsetCounts.get(offset) || 0) + 1);
const dominantOffset =
  [...offsetCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const resolvedEntries = parsed.entries.map((entry) => {
  const expectedPdfPage =
    dominantOffset === null ? null : entry.page + dominantOffset;
  const candidates = outlineByTitle.get(titleKey(entry.title)) || [];
  const outlineEntry =
    expectedPdfPage === null
      ? candidates[0]
      : candidates
          .map((candidate) => ({
            candidate,
            distance: Math.abs(candidate.page - expectedPdfPage),
          }))
          .sort((a, b) => a.distance - b.distance)[0]?.candidate;
  const useOutline = Boolean(
    outlineEntry &&
    expectedPdfPage !== null &&
    Math.abs(outlineEntry.page - expectedPdfPage) <= 2,
  );
  const pdfPage = useOutline ? outlineEntry.page : expectedPdfPage;
  return {
    ...entry,
    printedPage: entry.page,
    pdfPage,
    source: useOutline ? "outline-title-and-offset" : "toc-offset",
  };
});
const sections = buildSections(resolvedEntries);

console.log(
  JSON.stringify(
    {
      pdfPath,
      pageCount: extraction.pageCount,
      encrypted: extraction.encrypted,
      outlineCount: extraction.outline.length,
      outlinePreview: extraction.outline.slice(0, 40),
      tocPageCandidates: parsed.tocPages.map((page) => ({
        pdfPage: page.pdfPage,
        pageIndex: page.pageIndex,
        score: page.score,
        preview: normalizeText(page.text).slice(0, 180),
      })),
      tocEntryCount: parsed.entries.length,
      tocToPdfPageOffset: dominantOffset,
      tocOffsetSupport: offsets.length,
      tocPreview: parsed.entries.slice(0, 80),
      resolvedTocPreview: resolvedEntries.slice(0, 80),
      sectionPreview: sections.slice(0, 80),
    },
    null,
    2,
  ),
);

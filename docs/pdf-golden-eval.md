# Real PDF Golden Eval

Claudero's academic-agent quality depends on real PDF behavior, not only static
contracts. This eval samples local Zotero PDF files, extracts the first pages,
generates quote-location fixtures, detects figure/table evidence hints, and
writes a local report.

The PDF files are not copied into the repository. Reports are written under
`.claudero-eval/`, which is ignored by git.

## Run

```bash
npm run eval:pdf:golden
```

By default the script reads:

```text
/Users/muisedestiny/Documents/Zotero
```

Override it when needed:

```bash
CLAUDERO_PDF_FIXTURE_ROOT=/path/to/Zotero npm run eval:pdf:golden
```

Useful options:

```bash
node scripts/eval-real-pdf-golden.mjs --limit 24 --max-pages 8
node scripts/eval-real-pdf-golden.mjs --root /path/to/pdfs --report .claudero-eval/custom.json
```

## What It Checks

- Real PDF discovery under a Zotero-style attachment directory.
- Text extraction with the bundled Python runtime and `pypdf`.
- Table extraction smoke with `pdfplumber`.
- Deterministic quote fixtures generated from extracted page text.
- Quote-to-page locator correctness.
- Figure/table caption candidates such as `Figure 1`, `Table 2`, `图 1`, and
  `表 1`.

## Output

The default report is:

```text
.claudero-eval/pdf-golden-report.json
```

The report includes:

- `summary.totalPdfCount`
- `summary.sampledPdfCount`
- `summary.quoteFixtureCount`
- `summary.quotePassRate`
- `summary.figureTablePdfCount`
- per-PDF quote fixture, expected page, detected page, captions, extracted
  table count, warnings, and extraction timing.

## Why This Exists

Static tests prove that the evidence contracts are present. This eval proves
that the evidence pipeline can survive real scholarly PDFs: long filenames,
Chinese paths, translated PDFs, scanned or weak-text PDFs, old papers, modern
papers, and figure/table-heavy papers.

The next step is to promote selected report entries into hand-reviewed golden
fixtures for citation verification, figure/table provenance, and PDF rectangle
jump accuracy.

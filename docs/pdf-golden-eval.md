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

## Manual Review Site

Generate an interactive local review site from the latest report:

```bash
npm run eval:pdf:review
```

The site is written to:

```text
.claudero-eval/review-site/index.html
```

Open that HTML file in a browser. The site includes:

- selected review candidates from the real PDF report
- rendered PDF page images for quote and figure/table pages
- searchable extracted page text beside rendered pages
- quote locator checks
- figure/table caption checks
- weak-text/scanned-PDF checks
- default exclusion of obvious translated/bilingual artifacts such as `.zh.*`,
  `.mono.pdf`, and `.dual.pdf`
- local manual decisions: `Accept`, `Needs fix`, `Reject`
- free-form notes
- export of `claudero-pdf-review-decisions.json`

Useful options:

```bash
node scripts/build-pdf-review-site.mjs --limit 20
node scripts/build-pdf-review-site.mjs --report .claudero-eval/pdf-golden-report.json --out .claudero-eval/review-site
```

The exported review JSON is the bridge from human review to committed golden
fixtures. After enough items are accepted, promote the accepted candidates into
small checked-in fixture metadata while continuing to keep the PDFs themselves
outside git.

You can also serve the generated site locally:

```bash
npm run eval:pdf:review:serve
```

Then open:

```text
http://127.0.0.1:4177/
```

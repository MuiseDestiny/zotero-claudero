#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


def compact_text(value):
    return re.sub(r"\s+", " ", value or "").strip()


def main():
    if len(sys.argv) < 2:
        emit({"error": "pdf path is required"})
        return 2

    pdf_path = Path(sys.argv[1])
    max_pages = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    if not pdf_path.exists():
        emit({"error": f"pdf not found: {pdf_path}"})
        return 2

    try:
        from pypdf import PdfReader
    except Exception as exc:
        emit({"error": f"pypdf unavailable: {exc}"})
        return 2

    result = {
        "path": str(pdf_path),
        "pages": [],
        "pageCount": 0,
        "encrypted": False,
        "metadata": {},
        "tableCount": 0,
        "warnings": [],
    }

    try:
        reader = PdfReader(str(pdf_path))
        result["encrypted"] = bool(reader.is_encrypted)
        result["pageCount"] = len(reader.pages)
        result["metadata"] = {
            str(key).lstrip("/"): str(value)
            for key, value in (reader.metadata or {}).items()
            if value is not None
        }
        for index, page in enumerate(reader.pages[:max_pages]):
            try:
                text = compact_text(page.extract_text() or "")
            except Exception as exc:
                text = ""
                result["warnings"].append(f"page {index + 1} text failed: {exc}")
            result["pages"].append({"pageIndex": index, "text": text})
    except Exception as exc:
        emit({"error": f"pypdf extraction failed: {exc}", **result})
        return 1

    try:
        import pdfplumber

        with pdfplumber.open(str(pdf_path)) as pdf:
            for page in pdf.pages[:max_pages]:
                try:
                    result["tableCount"] += len(page.extract_tables() or [])
                except Exception as exc:
                    result["warnings"].append(f"table extraction failed: {exc}")
    except Exception as exc:
        result["warnings"].append(f"pdfplumber unavailable: {exc}")

    emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

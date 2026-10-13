const markdownCodePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/** Repair model output like `**Label: **value` without touching code. */
export function normalizeMarkdownStrongSpacing(text: string): string {
  return text
    .split(markdownCodePattern)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(
        /(^|[^\\])\*\*([^\n*]*?\S)([ \t]+)\*\*/gm,
        "$1**$2**$3",
      );
    })
    .join("");
}

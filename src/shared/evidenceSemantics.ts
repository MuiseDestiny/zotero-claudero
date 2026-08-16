function hasNegation(value: string): boolean {
  return /(?:\b(?:no|not|never|neither|without|cannot|can't|doesn't|didn't|isn't|aren't|wasn't|weren't)\b|(?:不|无|未|没有|并非|不能|不会|并未))/i.test(
    value,
  );
}

const OPPOSING_TERM_PAIRS: Array<[RegExp, RegExp]> = [
  [
    /\b(?:increase|increases|increased|higher|improve|improves|improved)\b/i,
    /\b(?:decrease|decreases|decreased|lower|worsen|worsens|worsened)\b/i,
  ],
  [/\bpositive\b/i, /\bnegative\b/i],
  [/(?:增加|升高|改善|提高)/, /(?:减少|降低|恶化|下降)/],
  [/(?:正相关|正向)/, /(?:负相关|负向)/],
];

export function detectEvidenceContradiction(
  text: string,
  query: string,
): string | null {
  if (hasNegation(text) !== hasNegation(query)) {
    return "negation polarity mismatch";
  }
  for (const [positive, negative] of OPPOSING_TERM_PAIRS) {
    if (
      (positive.test(text) && negative.test(query)) ||
      (negative.test(text) && positive.test(query))
    ) {
      return "opposing directional terms";
    }
  }
  return null;
}

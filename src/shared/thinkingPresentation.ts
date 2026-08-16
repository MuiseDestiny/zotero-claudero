export interface ThinkingPresentation {
  title: string | null;
  body: string;
}

/** Promote a standalone leading bold line emitted by reasoning summaries. */
export function thinkingPresentation(text: string): ThinkingPresentation {
  const trimmed = text.trim();
  const titles: string[] = [];
  let offset = 0;
  let bodyOffset = 0;
  while (trimmed.startsWith("**", offset)) {
    const closing = trimmed.indexOf("**", offset + 2);
    if (closing < 0) break;
    const title = trimmed.slice(offset + 2, closing).trim();
    if (!title || /[\r\n]/.test(title)) break;
    titles.push(title);
    bodyOffset = closing + 2;

    const whitespace = trimmed.slice(bodyOffset).match(/^\s*/)?.[0] || "";
    const nextOffset = bodyOffset + whitespace.length;
    if (!trimmed.startsWith("**", nextOffset)) break;
    offset = nextOffset;
  }

  const remainder = trimmed.slice(bodyOffset);
  const isStandalone = !remainder.trim() || /^[ \t]*\r?\n/.test(remainder);
  if (!titles.length || !isStandalone) return { title: null, body: trimmed };
  return {
    title: titles[titles.length - 1],
    body: remainder.trim(),
  };
}

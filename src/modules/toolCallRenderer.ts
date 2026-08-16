export type ToolStatus = "running" | "completed" | "error";

export interface ToolCardState {
  element: HTMLElement;
  summary: HTMLElement;
  status: HTMLElement;
  content: HTMLElement;
  name: string;
  input?: unknown;
  result?: string;
}

export interface ToolPaneState {
  root: HTMLElement;
  transcript: HTMLElement;
  toolCards: Map<string, ToolCardState>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  return el;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactValue(value: unknown, max = 140): string {
  const raw = stringifyValue(value).replace(/\s+/g, " ").trim();
  return raw.length > max ? raw.slice(0, max - 1) + "..." : raw;
}

function basename(value: unknown): string {
  const raw = stringifyValue(value)
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || raw;
}

function compactActivityValue(value: unknown, max = 28): string {
  let raw = stringifyValue(value).replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (/^(~|\/|[A-Za-z]:[\\/])/.test(raw)) raw = basename(raw);
  return raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
}

function summarizeCommand(command: unknown): string {
  let raw = stringifyValue(command).replace(/\s+/g, " ").trim();
  if (!raw) return "command";
  raw = raw.replace(/^cd\s+("[^"]+"|'[^']+'|`[^`]+`|\S+)\s*&&\s*/i, "");
  const pythonMatch = raw.match(/\b(python3?|uv\s+run\s+python3?)\b/i);
  if (pythonMatch) return pythonMatch[1].replace(/\s+/g, " ");
  const npmMatch = raw.match(/\b(npm|pnpm|yarn|bun)\s+(run\s+)?([^\s;&|]+)/i);
  if (npmMatch)
    return `${npmMatch[1]} ${npmMatch[2] || ""}${npmMatch[3]}`.trim();
  const gitMatch = raw.match(/\bgit\s+([^\s;&|]+)/i);
  if (gitMatch) return `git ${gitMatch[1]}`;
  const first = raw.match(/^[^\s;&|]+/);
  return (
    compactActivityValue(first ? basename(first[0]) : raw, 22) || "command"
  );
}

function questionSummary(input: unknown, max = 160): string {
  const record =
    recordValue(input) ??
    (typeof input === "string" ? recordFromString(input) : null);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const labels: string[] = [];
  for (const value of questions) {
    const question = recordValue(value);
    if (typeof question?.question === "string" && question.question.trim()) {
      labels.push(question.question.trim());
    }
  }
  if (!labels.length) return "Waiting for your answer";
  const text =
    labels.length === 1 ? labels[0] : `${labels[0]} (+${labels.length - 1})`;
  return compactValue(text, max);
}

function questionTooltip(input: unknown): string {
  const record =
    recordValue(input) ??
    (typeof input === "string" ? recordFromString(input) : null);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const labels: string[] = [];
  for (const value of questions) {
    const question = recordValue(value);
    if (typeof question?.question === "string" && question.question.trim()) {
      labels.push(question.question.trim());
    }
  }
  return labels.join("\n\n");
}

function renderQuestionInput(input: unknown): string {
  const record =
    recordValue(input) ??
    (typeof input === "string" ? recordFromString(input) : null);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const blocks: string[] = [];
  questions.forEach((value, index) => {
    const question = recordValue(value);
    if (!question) return;
    const title =
      typeof question.question === "string" && question.question.trim()
        ? question.question.trim()
        : `Question ${index + 1}`;
    const options = Array.isArray(question.options)
      ? question.options
          .map((raw) =>
            typeof raw === "string"
              ? raw.trim()
              : typeof recordValue(raw)?.label === "string"
                ? String(recordValue(raw)?.label).trim()
                : "",
          )
          .filter(Boolean)
      : [];
    blocks.push([title, ...options.map((label) => `- ${label}`)].join("\n"));
  });
  return blocks.join("\n\n") || "Waiting for your answer...";
}

function stringifyAnswer(answer: unknown): string {
  if (Array.isArray(answer)) {
    return answer.map(stringifyAnswer).filter(Boolean).join(", ");
  }
  const record = recordValue(answer);
  if (record) {
    const nested =
      record.answers ?? record.answer ?? record.value ?? record.label;
    if (nested !== undefined) return stringifyAnswer(nested);
  }
  if (typeof answer === "string") return answer.trim();
  if (answer === undefined || answer === null) return "";
  return String(answer).trim();
}

interface QuestionEntry {
  keys: string[];
  text: string;
}

interface QuestionAnswerLine {
  question: string;
  answer: string;
  order: number;
}

function questionEntriesFromInput(input: unknown): QuestionEntry[] {
  const record =
    recordValue(input) ??
    (typeof input === "string" ? recordFromString(input) : null);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  const entries: QuestionEntry[] = [];
  questions.forEach((value, index) => {
    const question = recordValue(value);
    const text =
      typeof question?.question === "string" && question.question.trim()
        ? question.question.trim()
        : `Question ${index + 1}`;
    const keys = [text];
    if (typeof question?.id === "string" && question.id.trim())
      keys.unshift(question.id.trim());
    entries.push({ keys, text });
  });
  return entries;
}

function mergeQuestionEntries(...sources: unknown[]): QuestionEntry[] {
  const merged: QuestionEntry[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const entry of questionEntriesFromInput(source)) {
      const signature = entry.keys.join("\u0000");
      if (seen.has(signature)) continue;
      seen.add(signature);
      merged.push(entry);
    }
  }
  return merged;
}

function findQuestionEntry(
  key: string,
  entries: QuestionEntry[],
): { entry: QuestionEntry; index: number } | null {
  const normalized = key.trim();
  const index = entries.findIndex((entry) =>
    entry.keys.some((candidate) => candidate.trim() === normalized),
  );
  return index >= 0 ? { entry: entries[index], index } : null;
}

function formatQuestionAnswerLines(lines: QuestionAnswerLine[]): string {
  const ordered = [...lines]
    .filter((line) => line.question && line.answer)
    .sort((a, b) => a.order - b.order);
  if (!ordered.length) return "";
  return `Answered:\n${ordered.map((line, index) => `${index + 1}. ${line.question}\n${line.answer}`).join("\n\n")}`;
}

function linesFromAnswerRecord(
  answers: Record<string, unknown>,
  entries: QuestionEntry[],
): QuestionAnswerLine[] {
  return Object.entries(answers).map(([key, value], index) => {
    const found = findQuestionEntry(key, entries);
    return {
      question: found?.entry.text || key,
      answer: stringifyAnswer(value),
      order: found?.index ?? entries.length + index,
    };
  });
}

function linesFromQuotedPairs(
  result: string,
  entries: QuestionEntry[],
): QuestionAnswerLine[] {
  const lines: QuestionAnswerLine[] = [];
  const pairPattern = /["“]([^"”]+)["”]\s*=\s*["“]([^"”]*)["”]/g;
  let match: RegExpExecArray | null;
  while ((match = pairPattern.exec(result)) !== null) {
    const key = match[1].trim();
    const found = findQuestionEntry(key, entries);
    lines.push({
      question: found?.entry.text || key,
      answer: match[2].trim(),
      order: found?.index ?? entries.length + lines.length,
    });
  }
  return lines;
}

function renderQuestionResult(result: string, input?: unknown): string {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const answers = recordValue(parsed.answers);
    if (!answers) return result;
    const entries = mergeQuestionEntries(input, parsed);
    return (
      formatQuestionAnswerLines(linesFromAnswerRecord(answers, entries)) ||
      result
    );
  } catch {
    const entries = mergeQuestionEntries(input);
    return (
      formatQuestionAnswerLines(linesFromQuotedPairs(result, entries)) || result
    );
  }
}

function isBashTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("bash") || n.includes("shell") || n.includes("terminal");
}

function truncateLines(text: string, max = 60): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= max) return text;
  return [
    ...lines.slice(0, max),
    "... " + (lines.length - max) + " more lines",
  ].join("\n");
}

// Pull a record out of a (possibly partial/streaming) JSON string. The model
// can emit a stray leading "{}" token before the real object, so strip that and
// fall back to a regex that grabs the first interesting field from partial JSON.
function recordFromString(value: string): Record<string, unknown> | null {
  const cleaned = value.replace(/^\s*\{\}\s*/, "").trim();
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object")
      return parsed as Record<string, unknown>;
  } catch {
    /* partial JSON — fall through to regex */
  }
  const m = cleaned.match(
    /"(command|file_path|pattern|query|prompt|skill|action)"\s*:\s*"((?:[^"\\]|\\.)*)"?/,
  );
  if (m) {
    try {
      return { [m[1]]: JSON.parse(`"${m[2]}"`) };
    } catch {
      return { [m[1]]: m[2] };
    }
  }
  return null;
}

function toolSummary(name: string, input: unknown): string {
  const n = name.toLowerCase();
  if (n === "askuserquestion") return questionSummary(input);
  const record =
    recordValue(input) ??
    (typeof input === "string" ? recordFromString(input) : null);
  if (n === "skill" && record) {
    const cmd =
      record.command ||
      record.skill ||
      record.name ||
      record.skill_name ||
      record.skillName;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
  }
  if (record) {
    const candidate =
      record.file_path ||
      record.command ||
      record.pattern ||
      record.query ||
      record.prompt ||
      record.action ||
      record.itemId ||
      record.attachmentId;
    if (candidate !== undefined && candidate !== null)
      return compactValue(candidate);
  }
  if (typeof input === "string")
    return compactValue(input.replace(/^\s*\{\}\s*/, ""));
  return name;
}

export function getToolActivityDescription(
  name: string,
  input: unknown,
): string {
  const displayName = toolDisplayName(name || "Tool");
  const n = name.toLowerCase();
  const record =
    recordValue(input) ??
    (typeof input === "string" ? recordFromString(input) : null);
  if (n === "askuserquestion") return "Waiting for your answer";
  if (n === "exitplanmode") return "Waiting for plan approval";
  if (n === "sleep") return "Waiting";
  if (isBashTool(n)) {
    return `Running ${summarizeCommand(record?.command ?? input)}`;
  }
  const target = record
    ? record.file_path ||
      record.path ||
      record.pattern ||
      record.query ||
      record.prompt ||
      record.action ||
      record.itemId ||
      record.attachmentId
    : input;
  const suffix = compactActivityValue(target);
  const withSuffix = (verb: string) => (suffix ? `${verb} ${suffix}` : verb);
  if (n.includes("read") || n.includes("get_current_context"))
    return withSuffix("Reading");
  if (n.includes("search") || n.includes("grep") || n.includes("find"))
    return withSuffix("Searching");
  if (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("note") ||
    n.includes("field") ||
    n.includes("tag")
  )
    return withSuffix("Writing");
  if (n.includes("skill")) return withSuffix("Using skill");
  if (n.includes("zotero")) return withSuffix("Checking Zotero");
  const summary = compactActivityValue(toolSummary(name || displayName, input));
  return summary && summary !== name
    ? `${displayName} ${summary}`
    : displayName;
}

function scrollTranscript(state: ToolPaneState): void {
  const t = state.transcript;
  if (t.scrollHeight - t.scrollTop - t.clientHeight < 120)
    t.scrollTop = t.scrollHeight;
}

function attachToolTooltip(el: HTMLElement, text: string): void {
  el.dataset.clauderoTooltip = text;
  if (el.dataset.clauderoTooltipBound) return;
  el.dataset.clauderoTooltipBound = "1";
  const doc = el.ownerDocument!;
  let tip: HTMLElement | null = null;
  el.addEventListener("mouseenter", () => {
    const tooltipText = el.dataset.clauderoTooltip || "";
    if (!tooltipText) return;
    tip = createEl(doc, "div", "claudero-chip-tooltip");
    tip.textContent = tooltipText;
    tip.style.visibility = "hidden";
    doc.documentElement.appendChild(tip);
    const anchorRect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const win = doc.defaultView!;
    const margin = 8;
    const idealLeft =
      anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
    const clampedLeft = Math.max(
      margin,
      Math.min(idealLeft, win.innerWidth - tipRect.width - margin),
    );
    const aboveTop = anchorRect.top - tipRect.height - 6;
    const belowTop = anchorRect.bottom + 6;
    tip.style.left = `${clampedLeft}px`;
    tip.style.top = `${aboveTop >= margin ? aboveTop : belowTop}px`;
    tip.style.visibility = "";
  });
  el.addEventListener("mouseleave", () => {
    tip?.remove();
    tip = null;
  });
}

export function createToolIconSvg(
  doc: Document,
  toolName: string,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = (d: string) => {
    const el = doc.createElementNS(SVG_NS, "path");
    el.setAttribute("d", d);
    svg.appendChild(el);
  };
  const ln = (x1: string, y1: string, x2: string, y2: string) => {
    const el = doc.createElementNS(SVG_NS, "line");
    el.setAttribute("x1", x1);
    el.setAttribute("y1", y1);
    el.setAttribute("x2", x2);
    el.setAttribute("y2", y2);
    svg.appendChild(el);
  };
  const c = (cx: string, cy: string, r: string) => {
    const el = doc.createElementNS(SVG_NS, "circle");
    el.setAttribute("cx", cx);
    el.setAttribute("cy", cy);
    el.setAttribute("r", r);
    svg.appendChild(el);
  };
  const n = toolName.toLowerCase();
  if (n === "askuserquestion") {
    c("12", "12", "9");
    p("M9.1 9a3 3 0 0 1 5.82 1c0 2-3 2.25-3 4");
    const dot = doc.createElementNS(SVG_NS, "path");
    dot.setAttribute("d", "M12 17h.01");
    svg.appendChild(dot);
  } else if (
    n.includes("zotero") ||
    [
      "get_current_context",
      "get_item",
      "search_items",
      "get_annotations",
      "get_attachment_path",
      "write_tags",
      "create_note",
      "set_field",
      "undo_last",
      "list_history",
    ].some((x) => n.includes(x))
  ) {
    // Zotero's filled "Z" mark; keep its brand red and ignore the shared stroke
    // styling by switching this icon to its own 1024 viewBox.
    svg.setAttribute("viewBox", "0 0 1024 1024");
    const z = doc.createElementNS(SVG_NS, "path");
    z.setAttribute(
      "d",
      "M774.570667 240.682667L374.912 765.866667h414.250667V853.333333H234.837333v-70.016L634.538667 258.133333H255.274667V170.666667h519.253333v70.016z",
    );
    z.setAttribute("fill", "#CC2936");
    z.setAttribute("stroke", "none");
    svg.appendChild(z);
  } else if (isBashTool(n)) {
    p("M4 17l6-6-6-6");
    ln("12", "19", "20", "19");
  } else if (n.includes("search") || n.includes("grep")) {
    c("11", "11", "8");
    ln("21", "21", "16.65", "16.65");
  } else if (
    n.includes("write") ||
    n.includes("edit") ||
    n.includes("note") ||
    n.includes("field")
  ) {
    p("M12 20h9");
    p("M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z");
  } else if (n.includes("skill")) {
    p("M13 2L3 14h9l-1 8 10-12h-9l1-8z");
  } else {
    p(
      "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
    );
  }
  return svg;
}

function createChevronSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = doc.createElementNS(SVG_NS, "path");
  p.setAttribute("d", "M9 18l6-6-6-6");
  svg.appendChild(p);
  return svg;
}

function createStatusSvg(doc: Document, status: ToolStatus): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (status === "completed") {
    const p = doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", "M20 6L9 17l-5-5");
    svg.appendChild(p);
  } else if (status === "error") {
    const a = doc.createElementNS(SVG_NS, "path");
    a.setAttribute("d", "M18 6 6 18M6 6l12 12");
    svg.appendChild(a);
  } else {
    const c = doc.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", "12");
    c.setAttribute("cy", "12");
    c.setAttribute("r", "7");
    c.setAttribute("fill", "currentColor");
    c.setAttribute("stroke", "none");
    svg.appendChild(c);
  }
  return svg;
}

function renderToolCardBody(card: ToolCardState): void {
  const segments: string[] = [];
  if (isBashTool(card.name)) {
    const input = recordValue(card.input);
    const command =
      input && typeof input.command === "string" ? input.command : "";
    if (command) segments.push("$ " + command);
    if (card.result) segments.push(truncateLines(card.result));
  } else if (card.name === "Skill") {
    if (card.result) segments.push(truncateLines(card.result));
  } else if (card.name === "AskUserQuestion") {
    segments.push(
      card.result === undefined
        ? renderQuestionInput(card.input)
        : renderQuestionResult(card.result, card.input),
    );
  } else if (card.result !== undefined) {
    segments.push(truncateLines(card.result));
  } else {
    segments.push(stringifyValue(card.input));
  }
  card.content.textContent =
    segments.filter(Boolean).join("\n") || "Waiting for result...";
}

function setToolStatus(card: ToolCardState, status: ToolStatus): void {
  card.element.classList.remove("running", "completed", "error");
  card.element.classList.add(status);
  card.element.setAttribute("data-status", status);
  const doc = card.status.ownerDocument!;
  card.status.textContent = "";
  card.status.appendChild(createStatusSvg(doc, status));
}

// MCP tools are namespaced by Claude Code as mcp__<server>__<tool>. The full
// name is required to invoke them, but the card only needs to show <tool>.
export function toolDisplayName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  return parts.slice(2).join("__") || name;
}

export function appendToolCard(
  state: ToolPaneState,
  tool: { id: string; name: string; input?: unknown; partialInput?: string },
): void {
  const id = tool.id || "tool-" + Date.now();
  const toolInput =
    tool.input &&
    typeof tool.input === "object" &&
    Object.keys(tool.input as object).length > 0
      ? tool.input
      : (tool.partialInput ?? tool.input);
  const existing = state.toolCards.get(id);
  if (existing) {
    existing.input = toolInput;
    const summaryText = toolSummary(existing.name, toolInput);
    existing.summary.textContent = summaryText;
    existing.summary.style.display = summaryText ? "" : "none";
    if (existing.name === "AskUserQuestion") {
      const tooltipText = questionTooltip(toolInput);
      if (tooltipText) attachToolTooltip(existing.summary, tooltipText);
      else delete existing.summary.dataset.clauderoTooltip;
    }
    renderToolCardBody(existing);
    setToolStatus(existing, "running");
    return;
  }
  const doc = state.root.ownerDocument!;
  const card = createEl(doc, "div", "claudero-tool-card running");
  card.setAttribute("data-tool-name", tool.name || "Tool");
  const header = createEl(doc, "div", "claudero-tool-header");
  const chevron = createEl(doc, "span", "claudero-tool-chevron");
  const icon = createEl(doc, "span", "claudero-tool-icon");
  const titleWrap = createEl(doc, "span", "claudero-tool-title-wrap");
  const name = createEl(doc, "span", "claudero-tool-name");
  const summary = createEl(doc, "span", "claudero-tool-summary");
  const status = createEl(doc, "span", "claudero-tool-status");
  const content = createEl(doc, "pre", "claudero-tool-content");
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  chevron.appendChild(createChevronSvg(doc));
  const iconName = tool.name || "Tool";
  icon.appendChild(createToolIconSvg(doc, iconName));
  name.textContent = toolDisplayName(iconName);
  const summaryText = toolSummary(iconName, toolInput);
  summary.textContent = summaryText;
  summary.style.display = summaryText ? "" : "none";
  if (iconName === "AskUserQuestion") {
    const tooltipText = questionTooltip(toolInput);
    if (tooltipText) attachToolTooltip(summary, tooltipText);
  }
  titleWrap.append(name, summary);
  status.appendChild(createStatusSvg(doc, "running"));
  content.hidden = true;
  const toggleCard = () => {
    content.hidden = !content.hidden;
    card.classList.toggle("expanded", !content.hidden);
  };
  header.addEventListener("click", toggleCard);
  header.addEventListener("keydown", (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" || ke.key === " ") {
      ke.preventDefault();
      toggleCard();
    }
  });
  header.append(chevron, icon, titleWrap, status);
  card.append(header, content);
  state.transcript.appendChild(card);
  const cardState: ToolCardState = {
    element: card,
    summary,
    status,
    content,
    name: iconName,
    input: toolInput,
  };
  renderToolCardBody(cardState);
  state.toolCards.set(id, cardState);
  scrollTranscript(state);
}

export function appendToolResult(
  state: ToolPaneState,
  result: { id: string; content: string; isError: boolean },
): void {
  if (!result.id) return;
  if (!state.toolCards.has(result.id))
    appendToolCard(state, { id: result.id, name: "Tool" });
  const card = state.toolCards.get(result.id);
  if (!card) return;
  const status: ToolStatus = result.isError ? "error" : "completed";
  setToolStatus(card, status);
  const statusLabel = result.isError ? "Failed" : "Completed";
  card.status.setAttribute("title", statusLabel);
  card.status.setAttribute("aria-label", statusLabel);
  card.result = result.content || "";
  renderToolCardBody(card);
  if (result.isError) {
    card.content.hidden = false;
    card.element.classList.add("expanded");
  }
  scrollTranscript(state);
}

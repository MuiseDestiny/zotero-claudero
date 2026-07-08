import type { ToolUseEvent } from "./types";

interface ToolBlockState {
  index: string;
  id: string;
  name: string;
  input?: unknown;
  partialInput: string;
}

function parseJsonObject(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export class ToolInputStreamState {
  private toolsByIndex = new Map<string, ToolBlockState>();
  private emittedToolIds = new Set<string>();
  private textByIndex = new Map<string, string>();
  private thinkingByIndex = new Map<string, string>();
  private textDeltaSeen = false;

  resetTurn(): void {
    this.toolsByIndex.clear();
    this.emittedToolIds.clear();
    this.textByIndex.clear();
    this.thinkingByIndex.clear();
    this.textDeltaSeen = false;
  }

  markTextDelta(index = "0", text = ""): void {
    this.textDeltaSeen = true;
    if (text) {
      this.textByIndex.set(
        index,
        `${this.textByIndex.get(index) || ""}${text}`,
      );
    }
  }

  hasTextDelta(): boolean {
    return this.textDeltaSeen;
  }

  markToolResult(): void {
    // A tool result starts a new model segment. Result-message text is only a
    // fallback when that final segment did not arrive as an assistant block.
    this.textDeltaSeen = false;
    this.textByIndex.clear();
    this.thinkingByIndex.clear();
  }

  appendThinkingDelta(index: string, text: string): void {
    if (!text) return;
    this.thinkingByIndex.set(
      index,
      `${this.thinkingByIndex.get(index) || ""}${text}`,
    );
  }

  reconcileText(
    index: string,
    text: string,
  ): { kind: "none" | "append" | "snapshot"; text: string } {
    let partial = this.textByIndex.get(index);
    let resolvedIndex = index;
    if (partial === undefined) {
      const candidate = Array.from(this.textByIndex.entries())
        .filter(([, value]) => text.startsWith(value) || value.startsWith(text))
        .sort((a, b) => b[1].length - a[1].length)[0];
      const fallback =
        candidate ||
        (this.textByIndex.size === 1
          ? Array.from(this.textByIndex.entries())[0]
          : undefined);
      if (fallback) [resolvedIndex, partial] = fallback;
    }
    this.textByIndex.set(resolvedIndex, text);
    if (partial === undefined) {
      this.textDeltaSeen = true;
      return { kind: "append", text };
    }
    if (partial === text) return { kind: "none", text: "" };
    if (text.startsWith(partial)) {
      return { kind: "append", text: text.slice(partial.length) };
    }
    return { kind: "snapshot", text };
  }

  reconcileThinking(
    index: string,
    text: string,
  ): { kind: "none" | "append" | "snapshot"; text: string } {
    let partial = this.thinkingByIndex.get(index);
    let resolvedIndex = index;
    if (partial === undefined) {
      const candidate = Array.from(this.thinkingByIndex.entries())
        .filter(([, value]) => text.startsWith(value) || value.startsWith(text))
        .sort((a, b) => b[1].length - a[1].length)[0];
      const fallback =
        candidate ||
        (this.thinkingByIndex.size === 1
          ? Array.from(this.thinkingByIndex.entries())[0]
          : undefined);
      if (fallback) [resolvedIndex, partial] = fallback;
    }
    this.thinkingByIndex.set(resolvedIndex, text);
    if (partial === undefined) return { kind: "append", text };
    if (partial === text) return { kind: "none", text: "" };
    if (text.startsWith(partial)) {
      return { kind: "append", text: text.slice(partial.length) };
    }
    return { kind: "snapshot", text };
  }

  registerToolUse(index: string, tool: ToolUseEvent): ToolUseEvent | null {
    const id = tool.id || `tool-${Date.now()}`;
    const normalized: ToolBlockState = {
      index,
      id,
      name: tool.name || "unknown",
      input: tool.input,
      partialInput: "",
    };
    if (index) this.toolsByIndex.set(index, normalized);
    if (this.emittedToolIds.has(id)) return null;
    this.emittedToolIds.add(id);
    return { id, name: normalized.name, input: normalized.input };
  }

  applyInputJsonDelta(index: string, partial: string): ToolUseEvent | null {
    if (!index) return null;
    const existing = this.toolsByIndex.get(index) || {
      index,
      id: `tool-${Date.now()}`,
      name: "unknown",
      partialInput: "",
    };
    existing.partialInput = `${existing.partialInput || ""}${partial || ""}`;
    const parsed = parseJsonObject(existing.partialInput);
    if (parsed !== undefined) existing.input = parsed;
    this.toolsByIndex.set(index, existing);
    return {
      id: existing.id,
      name: existing.name,
      input: parsed,
      partialInput: existing.partialInput,
    };
  }

  stopToolUse(index: string): void {
    if (index) this.toolsByIndex.delete(index);
  }
}

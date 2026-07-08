export type MessageRole = "user" | "assistant";

import { getPref, setPref } from "../utils/prefs";

export interface ConversationImage {
  id: string;
  mediaType: string;
  data: string;
  dataUrl: string;
}

export interface ConversationTurn {
  role: MessageRole;
  text: string;
  ts: number;
  images?: ConversationImage[];
  /**
   * Structured replay blocks captured from the Claude stream. Text remains the
   * canonical plain transcript for search/title/history injection; blocks let
   * the UI restore thinking/tool/error details without asking Claude again.
   */
  blocks?: ConversationBlock[];
  model?: string;
  effort?: string;
  durationMs?: number;
  contextSnapshot?: unknown;
  assistantMessageId?: string;
  sessionId?: string;
  provider?: "claude" | "codex";
}

export interface ConversationProviderState {
  claude?: {
    sessionId?: string;
  };
  codex?: {
    threadId?: string;
    sessionFilePath?: string;
    forkSource?: {
      threadId: string;
      resumeAt?: string;
      sourceConversationId?: string;
    };
  };
}

export type ConversationBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; durationMs?: number }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: unknown;
      partialInput?: string;
    }
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  | { type: "notice"; kind?: string; title: string; text: string };

export interface SavedConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ConversationTurn[];
  /** AI titles may be replaced automatically; explicit user titles may not. */
  titleSource?: "fallback" | "ai" | "user";
  providerState?: ConversationProviderState;
  parentConversationId?: string;
  forkedAtTurnIndex?: number;
  compactedAt?: number;
}

export type PromptIcon =
  | { type: "emoji"; value: string }
  | { type: "iconify"; value: string; color?: string }
  | { type: "upload"; attachmentKey: string };

export interface CustomPrompt {
  id: string;
  icon?: PromptIcon;
  label: string;
  description?: string;
  text: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ConversationIndexEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  titleSource?: "fallback" | "ai" | "user";
}

export interface ConversationTitleChange {
  id: string;
  title: string;
  source: "ai" | "user";
}

const titleChangeListeners = new Set<
  (change: ConversationTitleChange) => void
>();

export function subscribeConversationTitleChanges(
  listener: (change: ConversationTitleChange) => void,
): () => void {
  titleChangeListeners.add(listener);
  return () => titleChangeListeners.delete(listener);
}

function emitConversationTitleChange(change: ConversationTitleChange): void {
  for (const listener of titleChangeListeners) {
    try {
      listener(change);
    } catch (error) {
      ztoolkit.log(`[History] title change listener failed: ${String(error)}`);
    }
  }
}

export function getClauderoDir(): string {
  return PathUtils.join(Zotero.Profile.dir, "claudero");
}

function getHistoryDir(): string {
  return PathUtils.join(getClauderoDir(), "history");
}

function getCustomPromptsPath(): string {
  return PathUtils.join(getClauderoDir(), "custom-prompts.json");
}

function getConversationIndexPath(): string {
  return PathUtils.join(getClauderoDir(), "conversation-index.json");
}

function conversationTitle(turns: ConversationTurn[]): string {
  const firstUser = turns.find(
    (turn) => turn.role === "user" && turn.text.trim(),
  );
  const base = (firstUser?.text || turns[0]?.text || "Untitled")
    .replace(/\s+/g, " ")
    .trim();
  return base.slice(0, 80) || "Untitled";
}

async function readConversationIndex(): Promise<ConversationIndexEntry[]> {
  try {
    const filePath = getConversationIndexPath();
    if (!(await IOUtils.exists(filePath))) return [];
    const data = JSON.parse(await IOUtils.readUTF8(filePath));
    return Array.isArray(data) ? (data as ConversationIndexEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeConversationIndex(
  entries: ConversationIndexEntry[],
): Promise<void> {
  try {
    await IOUtils.makeDirectory(getClauderoDir(), { createAncestors: true });
    await IOUtils.writeUTF8(
      getConversationIndexPath(),
      JSON.stringify(entries, null, 2),
    );
  } catch {
    // Best effort.
  }
}

export function newConversationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function saveConversationData(
  id: string,
  turns: ConversationTurn[],
  metadata: Partial<
    Pick<
      SavedConversation,
      | "providerState"
      | "parentConversationId"
      | "forkedAtTurnIndex"
      | "compactedAt"
    >
  > = {},
): Promise<void> {
  if (turns.length === 0) return;
  try {
    const dir = getHistoryDir();
    await IOUtils.makeDirectory(dir, { createAncestors: true });
    const filePath = PathUtils.join(dir, `${id}.json`);
    let existingTitle = "";
    let existingCreatedAt: number | undefined;
    let existingTitleSource: SavedConversation["titleSource"];
    let existingProviderState: SavedConversation["providerState"];
    let existingParentConversationId: string | undefined;
    let existingForkedAtTurnIndex: number | undefined;
    let existingCompactedAt: number | undefined;
    try {
      if (await IOUtils.exists(filePath)) {
        const existing = JSON.parse(
          await IOUtils.readUTF8(filePath),
        ) as Partial<SavedConversation>;
        existingTitle =
          typeof existing.title === "string" ? existing.title.trim() : "";
        existingCreatedAt =
          typeof existing.createdAt === "number"
            ? existing.createdAt
            : undefined;
        existingTitleSource = existing.titleSource;
        existingProviderState = existing.providerState;
        existingParentConversationId =
          typeof existing.parentConversationId === "string"
            ? existing.parentConversationId
            : undefined;
        existingForkedAtTurnIndex =
          typeof existing.forkedAtTurnIndex === "number"
            ? existing.forkedAtTurnIndex
            : undefined;
        existingCompactedAt =
          typeof existing.compactedAt === "number"
            ? existing.compactedAt
            : undefined;
      }
    } catch {
      existingTitle = "";
      existingCreatedAt = undefined;
      existingTitleSource = undefined;
      existingProviderState = undefined;
      existingParentConversationId = undefined;
      existingForkedAtTurnIndex = undefined;
      existingCompactedAt = undefined;
    }
    if (!existingTitle) {
      const indexEntry = (await readConversationIndex()).find(
        (entry) => entry.id === id,
      );
      existingTitle = indexEntry?.title?.trim() || "";
      existingTitleSource = indexEntry?.titleSource;
    }
    const title = existingTitle || conversationTitle(turns);
    const data: SavedConversation = {
      id,
      title,
      createdAt: existingCreatedAt ?? turns[0]?.ts ?? Date.now(),
      updatedAt: Date.now(),
      turns,
      titleSource:
        existingTitleSource || (existingTitle ? undefined : "fallback"),
      providerState: metadata.providerState ?? existingProviderState,
      parentConversationId:
        metadata.parentConversationId ?? existingParentConversationId,
      forkedAtTurnIndex:
        metadata.forkedAtTurnIndex ?? existingForkedAtTurnIndex,
      compactedAt: metadata.compactedAt ?? existingCompactedAt,
    };
    await IOUtils.writeUTF8(filePath, JSON.stringify(data, null, 2));
    const index = (await readConversationIndex()).filter(
      (entry) => entry.id !== id,
    );
    index.unshift({
      id,
      title,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      turnCount: turns.length,
      titleSource: data.titleSource,
    });
    index.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    await writeConversationIndex(index.slice(0, 200));
  } catch {
    // Best effort — conversation history should not block chat.
  }
}

export async function renameConversation(
  id: string,
  title: string,
  options: {
    source?: "ai" | "user";
    expectedTitle?: string;
    onlyIfNoUserTitle?: boolean;
  } = {},
): Promise<boolean> {
  const cleanTitle = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!id || !cleanTitle) return false;
  try {
    const filePath = PathUtils.join(getHistoryDir(), `${id}.json`);
    let currentTitle = "";
    let currentSource: SavedConversation["titleSource"];
    let persisted = false;
    if (await IOUtils.exists(filePath)) {
      const data = JSON.parse(
        await IOUtils.readUTF8(filePath),
      ) as SavedConversation;
      currentTitle = data.title || "";
      currentSource = data.titleSource;
      if (
        (options.expectedTitle !== undefined &&
          currentTitle !== options.expectedTitle) ||
        (options.onlyIfNoUserTitle && currentSource === "user")
      ) {
        ztoolkit.log(
          `[History] rename CAS rejected id=${id} expected=${JSON.stringify(options.expectedTitle ?? null)} actual=${JSON.stringify(currentTitle)} source=${currentSource || "legacy"}`,
        );
        return false;
      }
      data.title = cleanTitle;
      data.titleSource = options.source || "user";
      data.updatedAt = Date.now();
      await IOUtils.writeUTF8(filePath, JSON.stringify(data, null, 2));
      persisted = true;
    }
    const index = await readConversationIndex();
    const idx = index.findIndex((entry) => entry.id === id);
    if (idx >= 0) {
      if (!currentTitle) {
        currentTitle = index[idx]!.title || "";
        currentSource = index[idx]!.titleSource;
        if (
          (options.expectedTitle !== undefined &&
            currentTitle !== options.expectedTitle) ||
          (options.onlyIfNoUserTitle && currentSource === "user")
        ) {
          ztoolkit.log(
            `[History] rename index CAS rejected id=${id} expected=${JSON.stringify(options.expectedTitle ?? null)} actual=${JSON.stringify(currentTitle)} source=${currentSource || "legacy"}`,
          );
          return false;
        }
      }
      index[idx] = {
        ...index[idx],
        title: cleanTitle,
        titleSource: options.source || "user",
        updatedAt: Date.now(),
      };
      await writeConversationIndex(index);
      persisted = true;
    }
    if (persisted) {
      emitConversationTitleChange({
        id,
        title: cleanTitle,
        source: options.source || "user",
      });
    }
    return persisted;
  } catch (error) {
    // Best effort.
    ztoolkit.log(
      `[History] rename persistence failed id=${id}: ${String(error)}`,
    );
    return false;
  }
}

export async function getConversationTitle(id: string): Promise<string | null> {
  if (!id) return null;
  try {
    const filePath = PathUtils.join(getHistoryDir(), `${id}.json`);
    if (await IOUtils.exists(filePath)) {
      const data = JSON.parse(
        await IOUtils.readUTF8(filePath),
      ) as Partial<SavedConversation>;
      if (typeof data.title === "string" && data.title.trim()) {
        return data.title.trim();
      }
    }
    return (
      (await readConversationIndex()).find((entry) => entry.id === id)?.title ||
      null
    );
  } catch (error) {
    ztoolkit.log(
      `[History] failed to read latest title id=${id}: ${String(error)}`,
    );
    return null;
  }
}

export async function deleteConversation(id: string): Promise<void> {
  if (!id) return;
  try {
    const filePath = PathUtils.join(getHistoryDir(), `${id}.json`);
    if (await IOUtils.exists(filePath)) {
      await IOUtils.remove(filePath);
    }
  } catch {
    // Best effort.
  }
  try {
    const index = (await readConversationIndex()).filter(
      (entry) => entry.id !== id,
    );
    await writeConversationIndex(index);
  } catch {
    // Best effort.
  }
}

export async function listConversationIndex(): Promise<
  ConversationIndexEntry[]
> {
  const index = await readConversationIndex();
  if (index.length)
    return index.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const conversations = await listConversations();
  return conversations.map((conv) => ({
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turnCount: conv.turns.length,
    titleSource: conv.titleSource,
  }));
}

export async function listConversations(): Promise<SavedConversation[]> {
  try {
    const dir = getHistoryDir();
    if (!(await IOUtils.exists(dir))) return [];
    const children: string[] = await (IOUtils as any).getChildren(dir);
    const conversations: SavedConversation[] = [];
    for (const filePath of children) {
      if (!filePath.endsWith(".json")) continue;
      try {
        const data = JSON.parse(
          await IOUtils.readUTF8(filePath),
        ) as SavedConversation;
        if (data && Array.isArray(data.turns) && data.turns.length > 0) {
          conversations.push(data);
        }
      } catch {
        // Skip corrupt history entries.
      }
    }
    conversations.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return conversations;
  } catch {
    return [];
  }
}

export async function loadCustomPrompts(): Promise<CustomPrompt[]> {
  try {
    const filePath = getCustomPromptsPath();
    if (!(await IOUtils.exists(filePath))) return [];
    const parsed = JSON.parse(
      await IOUtils.readUTF8(filePath),
    ) as CustomPrompt[];
    const normalized = normalizePrompts(Array.isArray(parsed) ? parsed : []);
    if (normalized.changed) await saveCustomPrompts(normalized.prompts);
    return normalized.prompts;
  } catch {
    return [];
  }
}

export async function saveCustomPrompts(
  prompts: CustomPrompt[],
): Promise<void> {
  try {
    await IOUtils.makeDirectory(getClauderoDir(), { createAncestors: true });
    await IOUtils.writeUTF8(
      getCustomPromptsPath(),
      JSON.stringify(prompts, null, 2),
    );
  } catch {
    // Best effort.
  }
}

const LEGACY_ICON_MAP: Record<string, string> = {
  summary: "lucide:list",
  method: "lucide:workflow",
  findings: "lucide:trending-up",
  critique: "lucide:star",
  note: "lucide:file-text",
  search: "lucide:search",
  shuffle: "lucide:shuffle",
  book: "lucide:book-open",
  file: "lucide:file-text",
};

const RANDOM_ICONIFY_ICONS = [
  "lucide:list",
  "lucide:workflow",
  "lucide:trending-up",
  "lucide:star",
  "lucide:file-text",
  "lucide:book-open",
  "lucide:search",
  "lucide:lightbulb",
  "lucide:target",
  "lucide:rocket",
  "lucide:chart-column",
  "lucide:folder-open",
  "lucide:bookmark",
  "lucide:tag",
  "lucide:message-square",
  "lucide:brain",
  "lucide:link",
  "lucide:wrench",
  "lucide:settings",
  "lucide:palette",
  "lucide:compass",
  "lucide:calendar",
  "lucide:clipboard-check",
  "lucide:graduation-cap",
  "lucide:microscope",
  "lucide:telescope",
  "lucide:globe",
  "lucide:sparkles",
  "solar:document-text-outline",
  "tabler:notes",
];

function normalizePromptIcon(
  icon: PromptIcon | undefined,
): PromptIcon | undefined {
  if (icon?.type !== "iconify") return icon;
  return {
    ...icon,
    value: LEGACY_ICON_MAP[icon.value] || icon.value,
    color: icon.color || "#6366f1",
  };
}

function normalizePrompts(prompts: CustomPrompt[]): {
  prompts: CustomPrompt[];
  changed: boolean;
} {
  let changed = false;
  const normalized = prompts.map((prompt) => {
    const icon = normalizePromptIcon(prompt.icon);
    if (JSON.stringify(icon) !== JSON.stringify(prompt.icon)) changed = true;
    return { ...prompt, icon };
  });
  return { prompts: normalized, changed };
}

export function randomPromptIcon(): PromptIcon {
  const value =
    RANDOM_ICONIFY_ICONS[
      Math.floor(Math.random() * RANDOM_ICONIFY_ICONS.length)
    ] || "lucide:sparkles";
  // Default to gray; the user can pick a color in the icon picker.
  return { type: "iconify", value, color: "#55534f" };
}

const BUILTIN_DEFAULT_PROMPTS: CustomPrompt[] = [
  {
    id: "default-summary",
    icon: { type: "iconify", value: "lucide:list", color: "#337fa9" },
    label: "Summarize",
    description: "Question, method, evidence, findings",
    text: "总结这篇论文的研究问题、数据、方法、主要结果、结论和局限。用清晰的小标题回答。",
  },
  {
    id: "default-method",
    icon: { type: "iconify", value: "lucide:workflow", color: "#9065b1" },
    label: "Explain Methods",
    description: "Variables, model, data pipeline",
    text: "解释这篇论文的方法、模型、变量、数据来源和技术路线。请指出关键假设和可能的误差来源。",
  },
  {
    id: "default-findings",
    icon: { type: "iconify", value: "lucide:trending-up", color: "#448461" },
    label: "Extract Findings",
    description: "Claims, numbers, implications",
    text: "提取这篇论文的主要发现、关键数值、证据链、结论和限制，并区分作者主张与数据支持。",
  },
  {
    id: "default-critique",
    icon: { type: "iconify", value: "lucide:star", color: "#cc922e" },
    label: "Critical Review",
    description: "Strengths, weaknesses, next checks",
    text: "从审稿人视角批判性阅读这篇论文：列出优点、不足、需要核查的实验/数据问题，以及我后续阅读应重点关注什么。",
  },
  {
    id: "default-insert-note",
    icon: { type: "iconify", value: "lucide:file-text", color: "#55534f" },
    label: "Insert Note",
    description: "Save the latest answer to Zotero",
    text: "",
  },
];

export function getDefaultPrompts(): CustomPrompt[] {
  try {
    const raw = getPref("defaultPrompts");
    if (raw) {
      const parsed = JSON.parse(raw) as CustomPrompt[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const normalized = normalizePrompts(parsed);
        if (normalized.changed) saveDefaultPrompts(normalized.prompts);
        return normalized.prompts;
      }
    }
  } catch {
    // Ignore corrupt pref.
  }
  const normalized = normalizePrompts(BUILTIN_DEFAULT_PROMPTS);
  saveDefaultPrompts(normalized.prompts);
  return normalized.prompts;
}

export function saveDefaultPrompts(prompts: CustomPrompt[]): void {
  try {
    setPref("defaultPrompts", JSON.stringify(prompts));
  } catch {
    // Best effort.
  }
}

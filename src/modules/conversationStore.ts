export type MessageRole = "user" | "assistant";

import { getPref, setPref } from "../utils/prefs";
import { validateConversationData } from "./conversationValidation";
import {
  applyMetadataPatch,
  snapshotConversationValue,
  snapshotMetadataPatch,
  type ConversationMetadataPatch,
} from "./conversationSnapshot";

export interface ConversationImage {
  id: string;
  mediaType: string;
  data: string;
  /** Legacy history may contain this duplicate preview value. New records omit it. */
  dataUrl?: string;
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
  provider?: "claude" | "codex" | "deepseek";
  /** Locator metadata for short evidence links; excluded from model history. */
  evidenceReferences?: Record<string, unknown>;
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
  deepseek?: {
    sessionId?: string;
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
  | {
      type: "notice";
      kind?: string;
      title: string;
      text: string;
      /** Raw failure retained so restored history can offer localized repair actions. */
      failureMessage?: string;
    };

export interface SavedConversation {
  schemaVersion: number;
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
  recoveryManifest?: import("./conversationRecovery").RecoveryManifest;
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
  schemaVersion?: number;
  byteSize?: number;
  /** Primary and backup stat signature; absent for legacy or unreadable files. */
  fileStamp?: string;
}

interface ConversationIndexDocument {
  schemaVersion: number;
  updatedAt: number;
  entries: ConversationIndexEntry[];
}

export interface ConversationStoragePolicy {
  maxConversations: number;
  maxAgeDays: number;
  maxTotalBytes: number;
  maxConversationBytes: number;
}

export const CONVERSATION_SCHEMA_VERSION = 1;
export const CONVERSATION_INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_CONVERSATION_STORAGE_POLICY: ConversationStoragePolicy = {
  maxConversations: 200,
  maxAgeDays: 365,
  maxTotalBytes: 256 * 1024 * 1024,
  maxConversationBytes: 32 * 1024 * 1024,
};

export class ConversationStorageError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConversationStorageError";
  }
}

class UnsupportedConversationSchemaError extends ConversationStorageError {
  constructor(version: number) {
    super(
      "read",
      `Conversation schema ${version} requires a newer Claudero version. Original data has been preserved.`,
    );
  }
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
      historyLog(`[History] title change listener failed: ${String(error)}`);
    }
  }
}

export function getClauderoDir(): string {
  return PathUtils.join(Zotero.Profile.dir, "claudero");
}

function getHistoryDir(): string {
  return PathUtils.join(getClauderoDir(), "history");
}

function assertConversationId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id)) {
    throw new ConversationStorageError(
      "validate",
      "Conversation ID contains unsupported characters.",
    );
  }
  return id;
}

function getConversationPath(id: string): string {
  return PathUtils.join(getHistoryDir(), `${assertConversationId(id)}.json`);
}

function getCustomPromptsPath(): string {
  return PathUtils.join(getClauderoDir(), "custom-prompts.json");
}

function getConversationIndexPath(): string {
  return PathUtils.join(getClauderoDir(), "conversation-index.json");
}

function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

function temporaryPath(filePath: string): string {
  return `${filePath}.tmp`;
}

function describeStorageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function historyLog(message: string): void {
  if (typeof ztoolkit !== "undefined") {
    ztoolkit.log(message);
  } else {
    Zotero.debug(message);
  }
}

async function atomicWriteUTF8(
  filePath: string,
  contents: string,
  options: { backup?: boolean } = {},
): Promise<void> {
  await IOUtils.writeUTF8(filePath, contents, {
    tmpPath: temporaryPath(filePath),
    ...(options.backup === false ? {} : { backupFile: backupPath(filePath) }),
    flush: true,
    mode: "overwrite",
  });
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return Number((await IOUtils.stat(filePath)).size || 0);
  } catch {
    return 0;
  }
}

async function conversationDiskSize(filePath: string): Promise<number> {
  return (await fileSize(filePath)) + (await fileSize(backupPath(filePath)));
}

async function conversationFileState(filePath: string): Promise<{
  byteSize: number;
  fileStamp?: string;
}> {
  const stat = async (path: string) => {
    try {
      return await IOUtils.stat(path);
    } catch {
      return null;
    }
  };
  const [primary, backup] = await Promise.all([
    stat(filePath),
    stat(backupPath(filePath)),
  ]);
  return {
    byteSize: (primary?.size || 0) + (backup?.size || 0),
    fileStamp:
      primary &&
      Number.isFinite(primary.lastModified) &&
      (!backup || Number.isFinite(backup.lastModified))
        ? JSON.stringify([
            primary.size,
            primary.lastModified,
            backup?.size ?? null,
            backup?.lastModified ?? null,
          ])
        : undefined,
  };
}

async function removeIfPresent(filePath: string): Promise<void> {
  if (await IOUtils.exists(filePath)) await IOUtils.remove(filePath);
}

async function removeConversationFiles(id: string): Promise<void> {
  const filePath = getConversationPath(id);
  await removeIfPresent(filePath);
  await removeIfPresent(backupPath(filePath));
  await removeIfPresent(temporaryPath(filePath));
  const quarantineDir = PathUtils.join(getHistoryDir(), "corrupt");
  if (await IOUtils.exists(quarantineDir)) {
    for (const candidate of await IOUtils.getChildren(quarantineDir)) {
      const name = PathUtils.filename(candidate);
      const prefix = `${id}-`;
      if (
        name.startsWith(prefix) &&
        /^\d+-(?:primary|backup)\.json$/.test(name.slice(prefix.length))
      ) {
        await removeIfPresent(candidate);
      }
    }
  }
}

async function quarantineConversationFiles(id: string): Promise<void> {
  const filePath = getConversationPath(id);
  const quarantineDir = PathUtils.join(getHistoryDir(), "corrupt");
  await IOUtils.makeDirectory(quarantineDir, { createAncestors: true });
  const suffix = Date.now();
  for (const [candidate, label] of [
    [filePath, "primary"],
    [backupPath(filePath), "backup"],
  ] as const) {
    if (!(await IOUtils.exists(candidate))) continue;
    await IOUtils.move(
      candidate,
      PathUtils.join(quarantineDir, `${id}-${suffix}-${label}.json`),
    );
  }
  await removeIfPresent(temporaryPath(filePath));
}

let storageQueue: Promise<void> = Promise.resolve();
let conversationIndexInitialized = false;

function runStorageTask<T>(task: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(task, task);
  storageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

function normalizeConversation(
  value: unknown,
  fallbackId: string,
): SavedConversation | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SavedConversation>;
  if (
    typeof raw.schemaVersion === "number" &&
    raw.schemaVersion > CONVERSATION_SCHEMA_VERSION
  ) {
    throw new UnsupportedConversationSchemaError(raw.schemaVersion);
  }
  if (
    raw.schemaVersion !== undefined &&
    (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 0)
  )
    return null;
  if (validateConversationData(value)) return null;
  if (raw.id !== undefined && raw.id !== fallbackId) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : fallbackId;
  try {
    assertConversationId(id);
  } catch {
    return null;
  }
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : raw.turns![0]?.ts || Date.now();
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
      ? raw.updatedAt
      : createdAt;
  return {
    ...raw,
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    id,
    title:
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim().slice(0, 80)
        : conversationTitle(raw.turns!),
    createdAt,
    updatedAt,
    turns: raw.turns,
  } as SavedConversation;
}

function normalizeIndexEntries(
  value: unknown,
): ConversationIndexEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: ConversationIndexEntry[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Partial<ConversationIndexEntry>;
    if (typeof raw.id !== "string" || ids.has(raw.id)) continue;
    try {
      assertConversationId(raw.id);
    } catch {
      continue;
    }
    ids.add(raw.id);
    entries.push({
      id: raw.id,
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim().slice(0, 80)
          : "Untitled",
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
      turnCount:
        typeof raw.turnCount === "number" ? Math.max(0, raw.turnCount) : 0,
      titleSource: raw.titleSource,
      schemaVersion:
        typeof raw.schemaVersion === "number"
          ? raw.schemaVersion
          : CONVERSATION_SCHEMA_VERSION,
      byteSize:
        typeof raw.byteSize === "number"
          ? Math.max(0, raw.byteSize)
          : undefined,
      fileStamp: typeof raw.fileStamp === "string" ? raw.fileStamp : undefined,
    });
  }
  return entries;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await IOUtils.readUTF8(filePath)) as unknown;
}

async function readConversationFile(
  id: string,
): Promise<SavedConversation | null> {
  const filePath = getConversationPath(id);
  for (const [candidatePath, recovered] of [
    [filePath, false],
    [backupPath(filePath), true],
  ] as const) {
    try {
      if (!(await IOUtils.exists(candidatePath))) continue;
      const raw = await readJsonFile(candidatePath);
      const normalized = normalizeConversation(raw, id);
      if (!normalized) continue;
      if (recovered) {
        await atomicWriteUTF8(filePath, JSON.stringify(normalized, null, 2), {
          backup: false,
        });
        historyLog(`[History] restored conversation ${id} from backup`);
      } else if (
        !raw ||
        typeof raw !== "object" ||
        (raw as Partial<SavedConversation>).schemaVersion !==
          CONVERSATION_SCHEMA_VERSION
      ) {
        await atomicWriteUTF8(filePath, JSON.stringify(normalized, null, 2));
        historyLog(`[History] migrated conversation ${id} schema`);
      }
      return normalized;
    } catch (error) {
      if (error instanceof UnsupportedConversationSchemaError) throw error;
      historyLog(
        `[History] failed to read ${candidatePath}: ${describeStorageError(error)}`,
      );
    }
  }
  return null;
}

async function readConversationIndexDocument(): Promise<{
  entries: ConversationIndexEntry[];
  needsMigration: boolean;
}> {
  const filePath = getConversationIndexPath();
  for (const [candidatePath, recovered] of [
    [filePath, false],
    [backupPath(filePath), true],
  ] as const) {
    try {
      if (!(await IOUtils.exists(candidatePath))) continue;
      const raw = await readJsonFile(candidatePath);
      const legacyEntries = normalizeIndexEntries(raw);
      const document =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Partial<ConversationIndexDocument>)
          : null;
      const documentEntries = normalizeIndexEntries(document?.entries);
      const entries = legacyEntries || documentEntries;
      if (!entries) continue;
      const needsMigration =
        !!legacyEntries ||
        document?.schemaVersion !== CONVERSATION_INDEX_SCHEMA_VERSION;
      if (recovered) {
        await writeConversationIndex(entries, { backup: false });
        historyLog("[History] restored conversation index from backup");
      }
      return { entries, needsMigration: needsMigration || recovered };
    } catch (error) {
      historyLog(
        `[History] failed to read ${candidatePath}: ${describeStorageError(error)}`,
      );
    }
  }
  return { entries: [], needsMigration: true };
}

async function writeConversationIndex(
  entries: ConversationIndexEntry[],
  options: { backup?: boolean } = {},
): Promise<void> {
  await IOUtils.makeDirectory(getClauderoDir(), { createAncestors: true });
  const document: ConversationIndexDocument = {
    schemaVersion: CONVERSATION_INDEX_SCHEMA_VERSION,
    updatedAt: Date.now(),
    entries: [...entries].sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    ),
  };
  await atomicWriteUTF8(
    getConversationIndexPath(),
    JSON.stringify(document, null, 2),
    options,
  );
}

async function entryFromConversation(
  conversation: SavedConversation,
): Promise<ConversationIndexEntry> {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turns.length,
    titleSource: conversation.titleSource,
    schemaVersion: conversation.schemaVersion,
    ...(await conversationFileState(getConversationPath(conversation.id))),
  };
}

export function selectRetainedConversationEntries(
  entries: ConversationIndexEntry[],
  policy: ConversationStoragePolicy = DEFAULT_CONVERSATION_STORAGE_POLICY,
  protectedId?: string,
  now = Date.now(),
): {
  retained: ConversationIndexEntry[];
  removed: ConversationIndexEntry[];
} {
  const maxAgeMs = Math.max(0, policy.maxAgeDays) * 24 * 60 * 60 * 1000;
  const cutoff = maxAgeMs > 0 ? now - maxAgeMs : Number.NEGATIVE_INFINITY;
  const sorted = [...entries].sort((a, b) => {
    if (a.id === protectedId && b.id !== protectedId) return -1;
    if (b.id === protectedId && a.id !== protectedId) return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  const retained: ConversationIndexEntry[] = [];
  const removed: ConversationIndexEntry[] = [];
  let totalBytes = 0;
  for (const entry of sorted) {
    const protectedEntry = entry.id === protectedId;
    const byteSize = Math.max(0, entry.byteSize || 0);
    const expired = !protectedEntry && (entry.updatedAt || 0) < cutoff;
    const overCount =
      !protectedEntry &&
      retained.length >= Math.max(1, policy.maxConversations);
    const overQuota =
      !protectedEntry &&
      retained.length > 0 &&
      totalBytes + byteSize > Math.max(1, policy.maxTotalBytes);
    if (expired || overCount || overQuota) {
      removed.push(entry);
      continue;
    }
    retained.push(entry);
    totalBytes += byteSize;
  }
  retained.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { retained, removed };
}

async function scanConversationDirectory(
  cached: ConversationIndexEntry[] = [],
): Promise<ConversationIndexEntry[]> {
  const dir = getHistoryDir();
  if (!(await IOUtils.exists(dir))) return [];
  const children = await IOUtils.getChildren(dir);
  const entries: ConversationIndexEntry[] = [];
  const seen = new Set<string>();
  const cachedById = new Map(cached.map((entry) => [entry.id, entry]));
  for (const filePath of children) {
    const leafName = PathUtils.filename(filePath);
    if (!/\.json(?:\.bak)?$/.test(leafName)) continue;
    const id = leafName.replace(/\.json(?:\.bak)?$/, "");
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const previous = cachedById.get(id);
      if (
        previous?.fileStamp &&
        previous.schemaVersion === CONVERSATION_SCHEMA_VERSION
      ) {
        const disk = await conversationFileState(getConversationPath(id));
        if (disk.fileStamp === previous.fileStamp) {
          entries.push({ ...previous, ...disk });
          continue;
        }
      }
      const conversation = await readConversationFile(id);
      if (!conversation) continue;
      entries.push(await entryFromConversation(conversation));
    } catch (error) {
      historyLog(
        `[History] skipped invalid conversation file ${leafName}: ${describeStorageError(error)}`,
      );
    }
  }
  return entries;
}

async function hydrateEntrySizes(
  entries: ConversationIndexEntry[],
): Promise<ConversationIndexEntry[]> {
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      byteSize: await conversationDiskSize(getConversationPath(entry.id)),
    })),
  );
}

async function applyRetentionPolicy(
  entries: ConversationIndexEntry[],
  policy: ConversationStoragePolicy,
  protectedId?: string,
): Promise<ConversationIndexEntry[]> {
  const sizedEntries = await hydrateEntrySizes(entries);
  const { retained, removed } = selectRetainedConversationEntries(
    sizedEntries,
    policy,
    protectedId,
  );
  for (const entry of removed) {
    await removeConversationFiles(entry.id);
  }
  await writeConversationIndex(retained);
  if (removed.length) {
    historyLog(`[History] retention removed ${removed.length} conversation(s)`);
  }
  return retained;
}

async function ensureConversationIndex(): Promise<ConversationIndexEntry[]> {
  const current = await readConversationIndexDocument();
  if (conversationIndexInitialized && !current.needsMigration) {
    return current.entries;
  }

  // Files, not stale index entries, are authoritative after partial deletion.
  const scanned = await scanConversationDirectory(current.entries);
  await writeConversationIndex(scanned);
  conversationIndexInitialized = true;
  return scanned;
}

export interface ConversationSaveResult {
  committed: true;
  warning?: string;
}

async function repairDerivedIndex(error: unknown): Promise<string> {
  conversationIndexInitialized = false;
  // Invalidate both primary and backup; an old backup must not resurrect entries.
  for (const path of [
    getConversationIndexPath(),
    backupPath(getConversationIndexPath()),
  ]) {
    try {
      await removeIfPresent(path);
    } catch {
      /* Startup always scans files. */
    }
  }
  try {
    await writeConversationIndex(await scanConversationDirectory(), {
      backup: false,
    });
    conversationIndexInitialized = true;
  } catch (repairError) {
    historyLog(
      `[History] index repair deferred: ${describeStorageError(repairError)}`,
    );
  }
  return `Conversation saved. History index or retention maintenance needs repair: ${describeStorageError(error)}`;
}

export function enforceConversationRetention(
  policy: ConversationStoragePolicy = DEFAULT_CONVERSATION_STORAGE_POLICY,
): Promise<void> {
  return runStorageTask(async () => {
    const entries = await ensureConversationIndex();
    try {
      await applyRetentionPolicy(entries, policy);
    } catch (error) {
      await repairDerivedIndex(error);
      throw error;
    }
  });
}

export function newConversationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function saveConversationData(
  id: string,
  turns: ConversationTurn[],
  metadata: ConversationMetadataPatch = {},
): Promise<ConversationSaveResult> {
  const snapshot = snapshotConversationValue(turns);
  const patch = snapshotMetadataPatch(metadata);
  return runStorageTask(async () => {
    try {
      assertConversationId(id);
      const dir = getHistoryDir();
      await IOUtils.makeDirectory(dir, { createAncestors: true });
      const index = (await readConversationIndexDocument()).entries;
      const existing = await readConversationFile(id);
      if (
        !existing &&
        ((await IOUtils.exists(getConversationPath(id))) ||
          (await IOUtils.exists(backupPath(getConversationPath(id)))))
      ) {
        throw new ConversationStorageError(
          "save",
          "The existing conversation is unreadable. Original files were preserved; recover it or save to a new conversation.",
        );
      }
      const indexEntry = index.find((entry) => entry.id === id);
      const existingTitle = existing?.title?.trim() || indexEntry?.title || "";
      const title = existingTitle || conversationTitle(snapshot);
      const data: SavedConversation = {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        id,
        title,
        createdAt: existing?.createdAt ?? snapshot[0]?.ts ?? Date.now(),
        updatedAt: Date.now(),
        turns: snapshot,
        titleSource:
          existing?.titleSource ||
          indexEntry?.titleSource ||
          (existingTitle ? undefined : "fallback"),
        ...applyMetadataPatch(existing, patch),
      };
      const serialized = JSON.stringify(data, null, 2);
      const validationError = validateConversationData(data);
      if (validationError)
        throw new ConversationStorageError("save", validationError);
      const encodedBytes = new TextEncoder().encode(serialized).byteLength;
      if (
        encodedBytes > DEFAULT_CONVERSATION_STORAGE_POLICY.maxConversationBytes
      ) {
        throw new ConversationStorageError(
          "save",
          `Conversation is ${Math.ceil(encodedBytes / 1024 / 1024)} MB and exceeds the ${Math.floor(DEFAULT_CONVERSATION_STORAGE_POLICY.maxConversationBytes / 1024 / 1024)} MB per-conversation limit. Remove large image attachments or start a new conversation.`,
        );
      }
      const filePath = getConversationPath(id);
      await atomicWriteUTF8(filePath, serialized);
      try {
        const nextIndex = (await ensureConversationIndex()).filter(
          (entry) => entry.id !== id,
        );
        nextIndex.unshift(await entryFromConversation(data));
        await applyRetentionPolicy(
          nextIndex,
          DEFAULT_CONVERSATION_STORAGE_POLICY,
          id,
        );
        return { committed: true as const };
      } catch (error) {
        return {
          committed: true as const,
          warning: await repairDerivedIndex(error),
        };
      }
    } catch (error) {
      if (error instanceof ConversationStorageError) throw error;
      throw new ConversationStorageError(
        "save",
        `Claudero could not save this conversation: ${describeStorageError(error)}`,
        error,
      );
    }
  });
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
  return runStorageTask(async () => {
    try {
      const data = await readConversationFile(id);
      if (!data) return false;
      const currentTitle = data.title || "";
      const currentSource = data.titleSource;
      if (
        (options.expectedTitle !== undefined &&
          currentTitle !== options.expectedTitle) ||
        (options.onlyIfNoUserTitle && currentSource === "user")
      ) {
        historyLog(
          `[History] rename CAS rejected id=${id} expected=${JSON.stringify(options.expectedTitle ?? null)} actual=${JSON.stringify(currentTitle)} source=${currentSource || "legacy"}`,
        );
        return false;
      }
      data.title = cleanTitle;
      data.titleSource = options.source || "user";
      data.updatedAt = Date.now();
      const filePath = getConversationPath(id);
      await atomicWriteUTF8(filePath, JSON.stringify(data, null, 2));
      const index = (await ensureConversationIndex()).filter(
        (entry) => entry.id !== id,
      );
      index.unshift(await entryFromConversation(data));
      try {
        await writeConversationIndex(index);
      } catch (error) {
        await repairDerivedIndex(error);
      }
      emitConversationTitleChange({
        id,
        title: cleanTitle,
        source: options.source || "user",
      });
      return true;
    } catch (error) {
      historyLog(
        `[History] rename persistence failed id=${id}: ${describeStorageError(error)}`,
      );
      return false;
    }
  });
}

export async function getConversationTitle(id: string): Promise<string | null> {
  if (!id) return null;
  return runStorageTask(async () => {
    try {
      const data = await readConversationFile(id);
      if (data?.title.trim()) return data.title.trim();
      return (
        (await readConversationIndexDocument()).entries.find(
          (entry) => entry.id === id,
        )?.title || null
      );
    } catch (error) {
      historyLog(
        `[History] failed to read latest title id=${id}: ${String(error)}`,
      );
      return null;
    }
  });
}

export async function deleteConversation(id: string): Promise<void> {
  if (!id) return;
  return runStorageTask(async () => {
    try {
      await removeConversationFiles(id);
      const index = (await ensureConversationIndex()).filter(
        (entry) => entry.id !== id,
      );
      try {
        await writeConversationIndex(index);
      } catch (error) {
        await repairDerivedIndex(error);
      }
    } catch (error) {
      await repairDerivedIndex(error);
      throw new ConversationStorageError(
        "delete",
        `Claudero could not permanently delete this conversation: ${describeStorageError(error)}`,
        error,
      );
    }
  });
}

export function deleteAllConversations(): Promise<void> {
  return runStorageTask(async () => {
    try {
      await IOUtils.remove(getHistoryDir(), {
        recursive: true,
        ignoreAbsent: true,
        retryReadonly: true,
      });
      await IOUtils.makeDirectory(getHistoryDir(), { createAncestors: true });
      await writeConversationIndex([]);
      conversationIndexInitialized = true;
    } catch (error) {
      await repairDerivedIndex(error);
      throw new ConversationStorageError(
        "delete-all",
        `Claudero could not permanently delete all conversations: ${describeStorageError(error)}`,
        error,
      );
    }
  });
}

export function exportConversationToFile(
  id: string,
  destinationPath: string,
): Promise<void> {
  return runStorageTask(async () => {
    try {
      const conversation = await readConversationFile(id);
      if (!conversation) {
        throw new Error(
          "Conversation was not found or could not be recovered.",
        );
      }
      const exported = {
        format: "claudero-conversation",
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        conversation,
      };
      await atomicWriteUTF8(
        destinationPath,
        JSON.stringify(exported, null, 2),
        { backup: false },
      );
    } catch (error) {
      throw new ConversationStorageError(
        "export",
        `Claudero could not export this conversation: ${describeStorageError(error)}`,
        error,
      );
    }
  });
}

export async function listConversationIndex(
  limit = Infinity,
): Promise<ConversationIndexEntry[]> {
  return runStorageTask(async () =>
    (await ensureConversationIndex())
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, Math.max(0, limit)),
  );
}

export function loadConversationById(
  id: string,
): Promise<SavedConversation | null> {
  return runStorageTask(() => readConversationFile(id));
}

export function loadLatestSavedConversation(): Promise<SavedConversation | null> {
  return runStorageTask(async () => {
    const index = (await ensureConversationIndex()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    for (const entry of index) {
      const conversation = await readConversationFile(entry.id);
      if (conversation) return conversation;
    }
    return null;
  });
}

export async function listConversations(): Promise<SavedConversation[]> {
  return runStorageTask(async () => {
    const index = await ensureConversationIndex();
    const conversations: SavedConversation[] = [];
    const unreadableIds: string[] = [];
    for (const entry of index) {
      const conversation = await readConversationFile(entry.id);
      if (conversation) {
        conversations.push(conversation);
      } else {
        unreadableIds.push(entry.id);
      }
    }
    if (unreadableIds.length) {
      for (const id of unreadableIds) await quarantineConversationFiles(id);
      await writeConversationIndex(
        index.filter((entry) => !unreadableIds.includes(entry.id)),
      );
      historyLog(
        `[History] quarantined ${unreadableIds.length} unreadable conversation(s)`,
      );
    }
    conversations.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return conversations;
  });
}

let promptQueue: Promise<void> = Promise.resolve();

/** Wait for snapshots already enqueued by pane/editor disposal before unloading. */
export async function flushSavedData(): Promise<void> {
  await Promise.all([storageQueue, promptQueue]);
}

function runPromptTask<T>(task: () => Promise<T>): Promise<T> {
  const result = promptQueue.then(task);
  promptQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

function parsePromptList(value: unknown): CustomPrompt[] {
  const ids = new Set<string>();
  if (
    !Array.isArray(value) ||
    !value.every((prompt) => {
      if (
        !prompt ||
        typeof prompt !== "object" ||
        typeof prompt.id !== "string" ||
        !prompt.id ||
        ids.has(prompt.id) ||
        typeof prompt.label !== "string" ||
        typeof prompt.text !== "string" ||
        (prompt.description !== undefined &&
          typeof prompt.description !== "string")
      )
        return false;
      const icon = prompt.icon;
      if (
        icon !== undefined &&
        (!icon ||
          typeof icon !== "object" ||
          (icon.type === "upload"
            ? typeof icon.attachmentKey !== "string"
            : !["emoji", "iconify"].includes(icon.type) ||
              typeof icon.value !== "string" ||
              (icon.color !== undefined && typeof icon.color !== "string")))
      )
        return false;
      ids.add(prompt.id);
      return true;
    })
  )
    throw new Error(
      "Prompt data is invalid. Original files have been preserved.",
    );
  return value as CustomPrompt[];
}

async function readCustomPrompts(): Promise<CustomPrompt[]> {
  const path = getCustomPromptsPath();
  let failure: unknown;
  for (const [candidate, recovered] of [
    [path, false],
    [backupPath(path), true],
  ] as const) {
    let normalized: ReturnType<typeof normalizePrompts>;
    try {
      if (!(await IOUtils.exists(candidate))) continue;
      normalized = normalizePrompts(
        parsePromptList(await readJsonFile(candidate)),
      );
    } catch (error) {
      failure = error;
      continue;
    }
    // Once a valid version is found, a failed repair must not select older data.
    if (recovered || normalized.changed) {
      await atomicWriteUTF8(path, JSON.stringify(normalized.prompts, null, 2), {
        backup: !recovered,
      });
    }
    return normalized.prompts;
  }
  if (failure)
    throw new ConversationStorageError(
      "read-prompts",
      `Could not read saved prompts: ${describeStorageError(failure)}`,
      failure,
    );
  return [];
}

async function writeCustomPrompts(prompts: CustomPrompt[]): Promise<void> {
  parsePromptList(prompts);
  await IOUtils.makeDirectory(getClauderoDir(), { createAncestors: true });
  await atomicWriteUTF8(
    getCustomPromptsPath(),
    JSON.stringify(prompts, null, 2),
  );
}

export function loadCustomPrompts(): Promise<CustomPrompt[]> {
  return runPromptTask(readCustomPrompts);
}

export function saveCustomPrompts(prompts: CustomPrompt[]): Promise<void> {
  const snapshot = snapshotConversationValue(prompts);
  return runPromptTask(async () => {
    await readCustomPrompts();
    await writeCustomPrompts(snapshot);
  });
}

/** Compare the editor's original record inside the serialized read/modify/write. */
export function assertPromptUnchanged(
  current: CustomPrompt | undefined,
  expected: CustomPrompt | undefined,
): void {
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error(
      "This prompt changed or was deleted elsewhere. Copy your draft and reopen the editor.",
    );
  }
}

export function saveCustomPrompt(
  prompt: CustomPrompt,
  expected?: CustomPrompt,
): Promise<void> {
  const snapshot = snapshotConversationValue(prompt);
  const original = expected && snapshotConversationValue(expected);
  return runPromptTask(async () => {
    const prompts = await readCustomPrompts();
    const index = prompts.findIndex((entry) => entry.id === snapshot.id);
    assertPromptUnchanged(prompts[index], original);
    if (index >= 0) prompts[index] = snapshot;
    else prompts.push(snapshot);
    await writeCustomPrompts(prompts);
  });
}

export function deleteCustomPrompt(prompt: CustomPrompt): Promise<void> {
  const original = snapshotConversationValue(prompt);
  return runPromptTask(async () => {
    const prompts = await readCustomPrompts();
    assertPromptUnchanged(
      prompts.find((entry) => entry.id === original.id),
      original,
    );
    await writeCustomPrompts(
      prompts.filter((entry) => entry.id !== original.id),
    );
  });
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
      const parsed = parsePromptList(JSON.parse(raw));
      if (Array.isArray(parsed)) {
        const normalized = normalizePrompts(parsed);
        if (normalized.changed) saveDefaultPrompts(normalized.prompts);
        return normalized.prompts;
      }
    }
  } catch {
    // Render defaults without replacing an unreadable preference.
    return normalizePrompts(BUILTIN_DEFAULT_PROMPTS).prompts;
  }
  const normalized = normalizePrompts(BUILTIN_DEFAULT_PROMPTS);
  saveDefaultPrompts(normalized.prompts);
  return normalized.prompts;
}

export function saveDefaultPrompts(prompts: CustomPrompt[]): void {
  parsePromptList(prompts);
  setPref("defaultPrompts", JSON.stringify(prompts));
}

import { getPref } from "../utils/prefs";
import { isZoteroMcpEnabled } from "./mcpSettings";
import type { ClauderoSelectionContext } from "./zoteroContext";
import { withRequestDeadline, waitWithSignal } from "../shared/requestDeadline";
import { throwIfAborted } from "../shared/helperStream";
import {
  sanitizeDiagnosticData,
  stableDiagnosticHash,
} from "../shared/diagnosticPrivacy";

type DiagnosticLevel = "info" | "warning" | "error";

export interface DiagnosticLogEntry {
  ts: string;
  level: DiagnosticLevel;
  event: string;
  data?: Record<string, unknown>;
}

export interface DiagnosticTurnContext {
  provider?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  conversationId?: string;
  promptLength?: number;
  imageCount?: number;
  academicSkill?: string | null;
  context?: ClauderoSelectionContext | null;
}

const MAX_ENTRIES = 500;
const entries: DiagnosticLogEntry[] = [];

const EVIDENCE_TOOL_NAMES = new Set([
  "get_evidence_pack",
  "get_numbered_evidence_pack",
  "expand_evidence_range",
  "locate_quote",
  "verify_citations",
  "build_trust_report",
  "build_academic_trace",
  "inspect_figure_table_page",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function compactObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "action",
    "itemId",
    "attachmentId",
    "pageIndex",
    "pageNumber",
    "query",
    "quote",
    "claim",
    "text",
    "answer",
    "claims",
    "includePageImages",
    "maxParagraphs",
    "maxPages",
    "maxPageImages",
  ]) {
    if (!(key in record)) continue;
    const raw = record[key];
    if (typeof raw === "string") {
      compact[`${key}Length`] = raw.length;
      compact[`${key}Hash`] = stableDiagnosticHash(raw);
    } else if (Array.isArray(raw)) {
      compact[`${key}Count`] = raw.length;
      compact[`${key}Hash`] = stableDiagnosticHash(raw);
    } else if (raw !== undefined) {
      compact[key] = raw;
    }
  }
  return compact;
}

function contextSummary(context: ClauderoSelectionContext | null | undefined) {
  const activeAttachment = context?.reader;
  const selectedText = context?.selectedText || "";
  return {
    selectedItems: context?.items?.length || 0,
    activeCollection: context?.activeCollection?.name || undefined,
    activeReader: activeAttachment
      ? {
          attachmentId: activeAttachment.id,
          itemId: activeAttachment.parentItemID,
          pageIndex: activeAttachment.pageIndex,
          pageNumber: activeAttachment.pageNumber,
          pageLabel: activeAttachment.pageLabel,
          hasPath: !!activeAttachment.path,
        }
      : null,
    selectedTextLength: selectedText.length,
    selectedTextHash: selectedText
      ? stableDiagnosticHash(selectedText)
      : undefined,
    annotations: context?.selectedAnnotations?.length || 0,
    selectedItemIds: (context?.items || []).slice(0, 12).map((item) => item.id),
    attachmentIds: (context?.items || [])
      .flatMap((item) => item.attachments || [])
      .slice(0, 12)
      .map((attachment) => attachment.id),
  };
}

function push(entry: DiagnosticLogEntry): void {
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
}

export function logDiagnostic(
  event: string,
  data: Record<string, unknown> = {},
  level: DiagnosticLevel = "info",
): void {
  push({
    ts: nowIso(),
    level,
    event,
    data: sanitizeDiagnosticData(data) as Record<string, unknown>,
  });
}

export function logTurnStart(input: DiagnosticTurnContext): void {
  logDiagnostic("turn.start", {
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    conversationId: input.conversationId,
    promptLength: input.promptLength,
    imageCount: input.imageCount || 0,
    academicSkill: input.academicSkill || null,
    context: contextSummary(input.context),
  });
}

export function logToolUse(tool: {
  id?: string;
  name?: string;
  input?: unknown;
  partialInput?: string;
}): void {
  const name = tool.name || "unknown";
  logDiagnostic("tool.use", {
    id: tool.id,
    name,
    evidenceTool: EVIDENCE_TOOL_NAMES.has(name),
    input: compactObject(tool.input),
    partialInputLength: tool.partialInput?.length || undefined,
  });
}

export function logToolResult(result: {
  id?: string;
  content?: string;
  isError?: boolean;
}): void {
  const content = result.content || "";
  logDiagnostic(
    "tool.result",
    {
      id: result.id,
      isError: !!result.isError,
      contentLength: content.length,
      contentHash: content ? stableDiagnosticHash(content) : undefined,
    },
    result.isError ? "warning" : "info",
  );
}

export function logTurnEnd(data: {
  cancelled?: boolean;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
  responseChars?: number;
  thinkingTokens?: number;
}): void {
  logDiagnostic(
    data.error ? "turn.error" : "turn.end",
    data,
    data.error ? "error" : "info",
  );
}

export function snapshotDiagnosticLog(extra: Record<string, unknown> = {}) {
  const safeExtra = sanitizeDiagnosticData(extra) as Record<string, unknown>;
  return {
    version: 1,
    createdAt: nowIso(),
    addonVersion: (Zotero as any).PluginManager?.getPlugin?.(
      "claudero@muisedestiny.com",
    )?.version,
    platform: {
      os: Zotero.isMac
        ? "mac"
        : Zotero.isWin
          ? "win"
          : Zotero.isLinux
            ? "linux"
            : "unknown",
      appVersion: Zotero.version,
    },
    prefs: {
      provider: getPref("provider"),
      helperPort: getPref("helperPort"),
      permissionMode: getPref("permissionMode"),
      enableZoteroMcp: isZoteroMcpEnabled(),
    },
    ...safeExtra,
    entries: entries.slice(),
  };
}

async function fetchHelperDiagnostics(signal?: AbortSignal): Promise<unknown> {
  try {
    return await withRequestDeadline(async (requestSignal) => {
      const port = Number(getPref("helperPort") || 38660);
      const tokenPath = PathUtils.join(
        Zotero.Profile.dir,
        "claudero",
        "helper",
        ".token",
      );
      const token = (
        await waitWithSignal(IOUtils.readUTF8(tokenPath), requestSignal)
      ).trim();
      const response = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: requestSignal,
      });
      if (!response.ok) {
        return { error: `Helper returned ${response.status}` };
      }
      return response.json();
    }, signal);
  } catch (error) {
    throwIfAborted(signal);
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function desktopPath(filename: string): string {
  const desktopDir = (
    Services.dirsvc.get("Desk", Components.interfaces.nsIFile) as nsIFile
  ).path;
  return PathUtils.join(desktopDir, filename);
}

async function fallbackDiagnosticPath(filename: string): Promise<string> {
  const dir = PathUtils.join(Zotero.Profile.dir, "claudero", "diagnostics");
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  return PathUtils.join(dir, filename);
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function exportDiagnosticLog(
  signal?: AbortSignal,
): Promise<string> {
  logDiagnostic("diagnostics.export.requested", { entries: entries.length });
  const helperDiagnostics = await fetchHelperDiagnostics(signal);
  throwIfAborted(signal);
  const payload = snapshotDiagnosticLog({ helperDiagnostics });
  const filename = `claudero-diagnostics-${safeTimestamp()}.json`;
  const path = desktopPath(filename);
  const data = JSON.stringify(payload, null, 2);
  try {
    await Zotero.File.putContentsAsync(path, data, "utf-8");
    logDiagnostic("diagnostics.export", { path, entries: entries.length });
    return path;
  } catch (error) {
    throwIfAborted(signal);
    const fallback = await fallbackDiagnosticPath(filename);
    await Zotero.File.putContentsAsync(fallback, data, "utf-8");
    logDiagnostic(
      "diagnostics.export.fallback",
      {
        path: fallback,
        requestedPath: path,
        error: error instanceof Error ? error.message : String(error),
      },
      "warning",
    );
    return fallback;
  }
}

import {
  buildEvidencePack,
  locateQuote,
  verifyCitationClaims,
} from "./evidence";
import { getSelectedZoteroContext } from "./zoteroContext";

// Zotero HTTP endpoint — exposes Zotero API operations to Claude Code via curl/bash.
// Registered at POST http://127.0.0.1:23119/claudero
// Each write operation is reversible: pushed onto undoStack, undone via "undo_last".

interface UndoEntry {
  id: string;
  description: string;
  undo: () => Promise<void>;
  timestamp: number;
}

const undoStack: UndoEntry[] = [];
const MAX_UNDO = 20;

function newOpId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function pushUndo(description: string, undo: () => Promise<void>): string {
  const id = newOpId();
  undoStack.push({ id, description, undo, timestamp: Date.now() });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  return id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getItem(itemId: number): Zotero.Item | null {
  try {
    return Zotero.Items.get(itemId) || null;
  } catch {
    return null;
  }
}

async function resolveAttachmentsForItem(item: Zotero.Item) {
  if (!item.isRegularItem()) {
    return;
  }
  const attIDs: number[] = item.getAttachments();
  const atts = await Promise.all(
    attIDs.map(async (id) => {
      const a = Zotero.Items.get(id);
      if (!a) return null;
      let path: string | undefined;
      try {
        path = (await a.getFilePathAsync()) || undefined;
        if (!path) path = (a as any).getFilePath?.() || undefined;
      } catch {
        /* ignore */
      }
      return {
        id: a.id,
        key: a.key,
        title: a.getDisplayTitle(),
        contentType: a.attachmentContentType || "",
        path,
      };
    }),
  );
  return atts.filter(Boolean) as NonNullable<(typeof atts)[number]>[];
}

function creatorName(c: {
  fieldMode?: number;
  firstName?: string;
  lastName?: string;
  name?: string;
}): string {
  if (c.fieldMode === 1) return c.name || "";
  return ((c.firstName || "") + " " + (c.lastName || "")).trim();
}

async function serializeAttachmentPath(item: Zotero.Item | null) {
  if (!item || !item.isAttachment?.()) return null;
  let path: string | undefined;
  try {
    path = (await item.getFilePathAsync()) || undefined;
    if (!path) path = (item as any).getFilePath?.() || undefined;
  } catch {
    try {
      path = (item as any).getFilePath?.() || undefined;
    } catch {
      path = undefined;
    }
  }
  const parent = item.parentItem;
  return {
    id: item.id,
    key: item.key,
    title: item.getDisplayTitle(),
    contentType: item.attachmentContentType || "",
    path,
    parentItemID: parent?.id,
    parentItemKey: parent?.key,
  };
}

function parseAnnotationPosition(position: unknown) {
  if (typeof position !== "string" || !position) return undefined;
  try {
    return JSON.parse(position);
  } catch {
    return undefined;
  }
}

function serializeAnnotation(item: any) {
  const position = parseAnnotationPosition(item.annotationPosition);
  return {
    id: item.id,
    key: item.key,
    parentID: item.parentID,
    text: String(item.annotationText || "").trim(),
    comment: item.annotationComment || undefined,
    type: item.annotationType || "highlight",
    color: item.annotationColor || undefined,
    pageIndex: position?.pageIndex,
    sortIndex: item.annotationSortIndex || undefined,
    dateAdded: item.dateAdded || undefined,
    dateModified: item.dateModified || undefined,
  };
}

async function getAnnotationItemsForAttachment(
  attachment: Zotero.Item,
): Promise<any[]> {
  try {
    const raw = await (attachment as any).getAnnotations?.();
    if (Array.isArray(raw) && raw.length) {
      if (typeof raw[0] === "number") {
        return (await Zotero.Items.getAsync(raw as number[])).filter(
          Boolean,
        ) as any[];
      }
      return raw.filter(Boolean) as any[];
    }
  } catch {
    /* best effort */
  }

  try {
    const children = (Zotero.Items as any).getByParent?.(attachment.id) || [];
    return children.filter(
      (item: any) => item?.isAnnotation?.() || item?.annotationType,
    );
  } catch {
    /* best effort */
  }

  return [];
}

async function resolveAttachmentItem(
  payload: any,
): Promise<Zotero.Item | null> {
  const attachmentId = Number(payload.attachmentId || 0);
  if (attachmentId) {
    const attachment = getItem(attachmentId);
    return attachment?.isAttachment?.() ? attachment : null;
  }

  const itemId = Number(payload.itemId || 0);
  if (!itemId) return null;
  const item = getItem(itemId);
  if (!item) return null;
  if (item.isAttachment?.()) return item;
  if (!item.isRegularItem?.()) return null;

  const attachments = await Promise.all(
    item.getAttachments().map((id) => Zotero.Items.getAsync(id)),
  );
  const valid = attachments.filter(
    (att): att is Zotero.Item => !!att && !!att.isAttachment?.(),
  );
  return (
    valid.find((att) => att.attachmentContentType === "application/pdf") ||
    valid[0] ||
    null
  );
}

// ── Operations ────────────────────────────────────────────────────────────────

async function opGetCurrentContext() {
  return getSelectedZoteroContext();
}

async function opGetAttachmentPath(payload: any) {
  const attachment = await resolveAttachmentItem(payload);
  if (!attachment)
    return {
      error:
        "Attachment not found. Pass attachmentId, or itemId for an item with an attachment.",
    };
  const result = await serializeAttachmentPath(attachment);
  return result || { error: `Item ${attachment.id} is not an attachment` };
}

async function opGetEvidencePack(payload: any) {
  return buildEvidencePack({
    itemId: Number(payload.itemId || 0) || undefined,
    attachmentId: Number(payload.attachmentId || 0) || undefined,
    query: typeof payload.query === "string" ? payload.query : undefined,
    maxParagraphs: Number(payload.maxParagraphs || 0) || undefined,
    maxPages: Number(payload.maxPages || 0) || undefined,
    includeAnnotations: payload.includeAnnotations !== false,
  });
}

async function opLocateQuote(payload: any) {
  return locateQuote({
    quote: String(payload.quote || ""),
    itemId: Number(payload.itemId || 0) || undefined,
    attachmentId: Number(payload.attachmentId || 0) || undefined,
    maxMatches: Number(payload.maxMatches || 0) || undefined,
  });
}

async function opVerifyCitations(payload: any) {
  return verifyCitationClaims({
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    text: typeof payload.text === "string" ? payload.text : undefined,
    itemId: Number(payload.itemId || 0) || undefined,
    attachmentId: Number(payload.attachmentId || 0) || undefined,
  });
}

async function opGetAnnotations(payload: any) {
  const annotationId = Number(payload.annotationId || 0);
  if (annotationId) {
    const annotation = getItem(annotationId) as any;
    if (
      !annotation ||
      !(annotation.isAnnotation?.() || annotation.annotationType)
    ) {
      return { error: `Annotation ${annotationId} not found` };
    }
    return { count: 1, annotations: [serializeAnnotation(annotation)] };
  }

  const itemId = Number(payload.itemId || 0);
  const attachmentId = Number(payload.attachmentId || 0);
  const source = attachmentId
    ? getItem(attachmentId)
    : itemId
      ? getItem(itemId)
      : null;
  if (!source) return { error: "Pass itemId or attachmentId" };

  let attachments: Zotero.Item[] = [];
  if (source.isAttachment?.()) {
    attachments = [source];
  } else if (source.isRegularItem?.()) {
    const raw = await Promise.all(
      source.getAttachments().map((id) => Zotero.Items.getAsync(id)),
    );
    attachments = raw.filter(
      (att): att is Zotero.Item => !!att && !!att.isAttachment?.(),
    );
  } else if (
    (source as any).isAnnotation?.() ||
    (source as any).annotationType
  ) {
    return { count: 1, annotations: [serializeAnnotation(source)] };
  }

  const groups = await Promise.all(
    attachments.map(async (attachment) => ({
      attachment: await serializeAttachmentPath(attachment),
      annotations: (await getAnnotationItemsForAttachment(attachment)).map(
        serializeAnnotation,
      ),
    })),
  );
  const annotations = groups.flatMap((group) =>
    group.annotations.map((annotation) => ({
      ...annotation,
      attachment: group.attachment,
    })),
  );
  return { count: annotations.length, annotations };
}

async function opGetItem(payload: any) {
  const id = Number(payload.itemId);
  const item = getItem(id);
  if (!item) return { error: `Item ${id} not found` };

  const noteIDs: number[] = item.getNotes();
  const notes = await Promise.all(
    noteIDs.map(async (nid) => {
      const n = Zotero.Items.get(nid);
      return n
        ? {
            id: nid,
            title: (n as any).getNoteTitle?.() || "",
            html: n.getNote?.() || "",
          }
        : null;
    }),
  );

  const attachments = await resolveAttachmentsForItem(item);

  return {
    id: item.id,
    key: item.key,
    itemType: item.itemType,
    title: item.getField("title") as string,
    creators: item.getCreators().map(creatorName).filter(Boolean),
    date: (item.getField("date") as string) || "",
    year: (String(item.getField("date") || "").match(/\d{4}/) || [])[0] || "",
    publicationTitle:
      (item.getField("publicationTitle", false, true) as string) || "",
    abstractNote: (item.getField("abstractNote") as string) || "",
    url: (item.getField("url") as string) || "",
    DOI: (item.getField("DOI") as string) || "",
    tags: item.getTags().map((t: { tag: string }) => t.tag),
    notes: notes.filter(Boolean),
    attachments,
  };
}

async function opSearchItems(payload: any) {
  const query: string = String(payload.query || "");
  const field: string = payload.field || "any"; // "title"|"author"|"tag"|"fulltext"|"any"
  const limit = Number(payload.limit || 20);
  if (!query.trim()) return { error: "query is required" };

  const s = new Zotero.Search();
  (s as any).libraryID = Zotero.Libraries.userLibraryID;

  if (field === "title") {
    s.addCondition("title", "contains", query);
  } else if (field === "author") {
    s.addCondition("creator", "contains", query);
  } else if (field === "tag") {
    s.addCondition("tag", "is", query);
  } else if (field === "fulltext") {
    s.addCondition("fulltextWord", "contains", query);
  } else {
    s.addCondition("quicksearch-titleCreatorYear", "contains", query);
  }

  const ids: number[] = await s.search();
  const all = await Zotero.Items.getAsync(ids);
  const regular = (Zotero.Items as any).getTopLevel
    ? (Zotero.Items as any)
        .getTopLevel(all)
        .filter((i: any) => i.isRegularItem())
    : all.filter((i: any) => i.isRegularItem?.());

  const items = (regular as Zotero.Item[]).slice(0, limit).map((item) => ({
    id: item.id,
    key: item.key,
    title: item.getField("title") as string,
    year: (String(item.getField("date") || "").match(/\d{4}/) || [])[0] || "",
    itemType: item.itemType,
    creators: item.getCreators().slice(0, 3).map(creatorName).filter(Boolean),
    tags: item.getTags().map((t: { tag: string }) => t.tag),
  }));

  return { count: regular.length, items };
}

async function opWriteTags(payload: any) {
  const id = Number(payload.itemId);
  const item = getItem(id);
  if (!item) return { error: `Item ${id} not found` };

  const toAdd: string[] = Array.isArray(payload.add) ? payload.add : [];
  const toRemove: string[] = Array.isArray(payload.remove)
    ? payload.remove
    : [];

  // Snapshot
  const hadBefore = toAdd.filter((t) => item.hasTag(t));
  const hadRemoved = toRemove.filter((t) => item.hasTag(t));

  let added = 0,
    removed = 0;
  for (const t of toAdd) {
    if (!item.hasTag(t)) {
      item.addTag(t);
      added++;
    }
  }
  for (const t of toRemove) {
    if (item.hasTag(t)) {
      item.removeTag(t);
      removed++;
    }
  }
  await item.saveTx();

  const opId = pushUndo(
    `write_tags on item ${id}: +[${toAdd.join(",")}] -[${toRemove.join(",")}]`,
    async () => {
      const cur = getItem(id);
      if (!cur) return;
      for (const t of toAdd) {
        if (cur.hasTag(t) && !hadBefore.includes(t)) cur.removeTag(t);
      }
      for (const t of hadRemoved) {
        if (!cur.hasTag(t)) cur.addTag(t);
      }
      await cur.saveTx();
    },
  );

  return { added, removed, itemId: id, operationId: opId };
}

async function opCreateNote(payload: any) {
  const parentId = Number(payload.parentId);
  const parent = getItem(parentId);
  if (!parent) return { error: `Parent item ${parentId} not found` };

  const content: string = String(payload.content || "");
  let html = "";
  const betterNotes = (
    Zotero as unknown as {
      BetterNotes?: {
        api?: { convert?: { md2html?: (input: string) => Promise<string> } };
      };
    }
  ).BetterNotes;
  if (betterNotes?.api?.convert?.md2html) {
    html = await betterNotes.api.convert.md2html(content);
  } else {
    // Convert basic markdown to HTML for Zotero note format
    html = content;
  }

  const note = new Zotero.Item("note");
  note.setNote(html);
  note.parentID = parentId;
  const noteId = await note.saveTx();

  const opId = pushUndo(`create_note under item ${parentId}`, async () => {
    const n = getItem(noteId as number);
    if (n) await n.eraseTx();
  });

  return { noteId, itemId: parentId, operationId: opId };
}

async function opSetField(payload: any) {
  const id = Number(payload.itemId);
  const field: string = String(payload.field || "");
  const value: string = String(payload.value ?? "");
  const item = getItem(id);
  if (!item) return { error: `Item ${id} not found` };
  if (!field) return { error: "field is required" };

  const typeID = Zotero.ItemTypes.getID(item.itemType);
  if (typeID && !(Zotero.ItemFields as any).isValidForType(field, typeID)) {
    return {
      error: `Field "${field}" is not valid for item type "${item.itemType}"`,
    };
  }

  const oldValue = item.getField(field) as string;
  item.setField(field, value);
  await item.saveTx();

  const opId = pushUndo(
    `set_field "${field}" on item ${id} (was: "${String(oldValue).slice(0, 60)}")`,
    async () => {
      const cur = getItem(id);
      if (!cur) return;
      cur.setField(field, oldValue);
      await cur.saveTx();
    },
  );

  return { field, newValue: value, oldValue, itemId: id, operationId: opId };
}

async function opUndoLast(payload: any) {
  const targetId: string | undefined = payload.operationId;
  let entry: UndoEntry | undefined;

  if (targetId) {
    const idx = undoStack.findIndex((e) => e.id === targetId);
    if (idx === -1) return { error: `No operation with id "${targetId}"` };
    entry = undoStack.splice(idx, 1)[0];
  } else {
    entry = undoStack.pop();
  }

  if (!entry) return { error: "Nothing to undo" };

  try {
    await entry.undo();
    return { undone: entry.description, operationId: entry.id };
  } catch (e: any) {
    return { error: `Undo failed: ${e?.message || e}` };
  }
}

function opListHistory() {
  const ops = [...undoStack].reverse().map((e) => ({
    id: e.id,
    description: e.description,
    timestamp: new Date(e.timestamp).toISOString(),
  }));
  return { count: ops.length, operations: ops };
}

// ── Endpoint registration ─────────────────────────────────────────────────────

let _detectedPort = 23119;

function detectZoteroServerPort(): number {
  return 23119;
}

export function registerZoteroEndpoint(): void {
  if ((Zotero as any).Server?.Endpoints == null) {
    ztoolkit.log(
      "[Claudero] Zotero.Server not available, skipping endpoint registration",
    );
    return;
  }

  _detectedPort = detectZoteroServerPort();

  const ENDPOINT = "/claudero";
  (Zotero as any).Server.Endpoints[ENDPOINT] = function () {
    /* constructor */
  };
  (Zotero as any).Server.Endpoints[ENDPOINT].prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    allowRequestsFromUnsafeWebContent: true,
    init: function (
      postData: any,
      sendResponseCallback: (
        status: number,
        type: string,
        body: string,
      ) => void,
    ) {
      const respond = (data: unknown) =>
        sendResponseCallback(200, "application/json", JSON.stringify(data));

      const payload: any = postData;

      ztoolkit.log(payload);
      const action: string = String(payload.action || "");
      const run = async () => {
        try {
          let result: unknown;
          switch (action) {
            case "get_current_context":
              result = await opGetCurrentContext();
              break;
            case "get_item":
              result = await opGetItem(payload);
              break;
            case "search_items":
              result = await opSearchItems(payload);
              break;
            case "get_annotations":
              result = await opGetAnnotations(payload);
              break;
            case "get_attachment_path":
              result = await opGetAttachmentPath(payload);
              break;
            case "get_evidence_pack":
              result = await opGetEvidencePack(payload);
              break;
            case "locate_quote":
              result = await opLocateQuote(payload);
              break;
            case "verify_citations":
              result = await opVerifyCitations(payload);
              break;
            case "write_tags":
              result = await opWriteTags(payload);
              break;
            case "create_note":
              result = await opCreateNote(payload);
              break;
            case "set_field":
              result = await opSetField(payload);
              break;
            case "undo_last":
              result = await opUndoLast(payload);
              break;
            case "list_history":
              result = opListHistory();
              break;
            default:
              result = {
                error: `Unknown action "${action}"`,
                available: [
                  "get_current_context",
                  "get_item",
                  "search_items",
                  "get_annotations",
                  "get_attachment_path",
                  "get_evidence_pack",
                  "locate_quote",
                  "verify_citations",
                  "write_tags",
                  "create_note",
                  "set_field",
                  "undo_last",
                  "list_history",
                ],
              };
          }
          ztoolkit.log(result);
          if (
            result &&
            typeof result === "object" &&
            "error" in (result as object)
          ) {
            respond({ success: false, ...(result as object) });
          } else {
            respond({ success: true, result });
          }
        } catch (e: any) {
          respond({ success: false, error: String(e?.message ?? e) });
        }
      };

      void run();
    },
  };

  ztoolkit.log(
    `[Claudero] Zotero endpoint registered at POST http://127.0.0.1:${_detectedPort}${ENDPOINT}`,
  );
}

export function unregisterZoteroEndpoint(): void {
  try {
    delete (Zotero as any).Server.Endpoints["/claudero"];
  } catch {
    /* ignore */
  }
}

export function getZoteroEndpointBaseUrl(): string {
  return `http://127.0.0.1:${_detectedPort}/claudero`;
}

// ── System prompt description (used in buildPromptWithZoteroContext) ──────────

export function getZoteroApiSystemPrompt(): string {
  let dataDir = "";
  try {
    dataDir = String((Zotero as any).DataDirectory?.dir || "");
  } catch {
    /* best effort */
  }
  const dataDirLines = dataDir
    ? `
You also have DIRECT READ-ONLY access to Zotero's local data when you need bulk evidence or PDF-level extraction:
- Data directory: ${dataDir}
- Database: ${dataDir}/zotero.sqlite — open it READ-ONLY only. Python: sqlite3.connect("file:${dataDir}/zotero.sqlite?mode=ro&immutable=1", uri=True).
- Attachment files live under ${dataDir}/storage/<attachmentKey>/. For full text, tables, formulas, or layout, get the attachment path and read the PDF directly with Python (PyMuPDF/pdfplumber/etc.).
- Zotero annotations are database records, not guaranteed to be embedded in the PDF. Use get_annotations or read SQLite read-only when you need them.
- NEVER write to zotero.sqlite or modify Zotero files directly; ALL writes must go through MCP write tools.`
    : "";
  return `
A lightweight current Zotero context is already included with each user request. Use it as the default target.
If you need fresh or deeper Zotero data, use MCP tools: get_current_context, get_item, search_items, get_annotations, get_attachment_path, get_evidence_pack, locate_quote, verify_citations, write_tags, create_note, set_field, undo_last, list_history.
${dataDirLines}
Keep MCP usage minimal: use Zotero tools for semantic library state and safe writes; use local file/Python reads for heavy PDF understanding.
For scholarly answers, prefer get_evidence_pack before making factual claims, use locate_quote before quoting, and use verify_citations before finalizing claim-heavy output. Mark unsupported claims instead of inventing citations.
Before ANY write operation, confirm with the user or explain what will change.
Write operations are protected by Claudero's approval dialog and may be denied by the user.
After a successful write, briefly state what changed in one sentence. Do not print operationId or ask whether to undo.
`.trim();
}

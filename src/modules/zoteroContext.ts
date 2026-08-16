import { AGENT_EVIDENCE_POLICY } from "../shared/agentEvidencePolicy";

export interface ClauderoAttachmentContext {
  id: number;
  key: string;
  iconName?: string;
  /** Raw Zotero item — prefer _item.getItemTypeIconName() for the icon. */
  _item?: Zotero.Item;
  title: string;
  contentType: string;
  path?: string;
  parentItemID?: number;
  parentItemKey?: string;
  parentItemType?: string;
  pageIndex?: number;
  pageNumber?: number;
  pageLabel?: string;
  pagesCount?: number;
}

export interface ClauderoCollectionContext {
  id: number;
  key: string;
  name: string;
  path: string;
  libraryName?: string;
}

export interface ClauderoItemContext {
  id: number;
  key: string;
  itemType: string;
  title: string;
  creators: string[];
  date: string;
  publicationTitle: string;
  abstractNote: string;
  url: string;
  DOI: string;
  tags: string[];
  notes?: string[];
  attachments: ClauderoAttachmentContext[];
  collections?: ClauderoCollectionContext[];
}

export interface ClauderoAnnotationContext {
  text: string;
  comment?: string;
  type: string;
  color?: string;
  pageIndex?: number;
}

export interface ClauderoSelectionContext {
  generatedAt: string;
  selectedType: string;
  selectedTabID: string;
  items: ClauderoItemContext[];
  activeCollection?: ClauderoCollectionContext;
  reader?: ClauderoAttachmentContext;
  selectedText: string;
  selectedAnnotations?: ClauderoAnnotationContext[];
}

type CreatorLike = {
  firstName?: string;
  lastName?: string;
  name?: string;
};

function getCreatorName(creator: CreatorLike): string {
  const firstName = creator.firstName || "";
  const lastName = creator.lastName || "";
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || creator.name || "";
}

function truncateContextText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}... [truncated]`
    : text;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type CollectionLike = {
  id?: number;
  key?: string;
  name?: string;
  parentID?: number | false | null;
  libraryID?: number;
};

function getLibraryName(libraryID?: number): string {
  try {
    if (typeof libraryID !== "number") return "";
    return String((Zotero.Libraries as any).get(libraryID)?.name || "");
  } catch {
    return "";
  }
}

function getCollection(collectionID: number): CollectionLike | null {
  try {
    return (Zotero.Collections as any).get(collectionID) || null;
  } catch {
    return null;
  }
}

function getCollectionName(collection: CollectionLike | null): string {
  return String(collection?.name || "");
}

function getCollectionPath(collection: CollectionLike | null): string {
  if (!collection?.id) return "";
  const names: string[] = [];
  let current: CollectionLike | null = collection;
  const seen = new Set<number>();
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    const name = getCollectionName(current);
    if (name) names.unshift(name);
    const parentID: number =
      typeof current.parentID === "number" ? current.parentID : 0;
    current = parentID ? getCollection(parentID) : null;
  }
  return names.join(" / ");
}

function serializeCollection(
  collection: CollectionLike | null,
): ClauderoCollectionContext | undefined {
  if (!collection?.id) return undefined;
  return {
    id: collection.id,
    key: String(collection.key || ""),
    name: getCollectionName(collection),
    path: getCollectionPath(collection),
    libraryName: getLibraryName(collection.libraryID) || undefined,
  };
}

function getItemCollections(item: Zotero.Item): ClauderoCollectionContext[] {
  try {
    const ids =
      typeof item.getCollections === "function" ? item.getCollections() : [];
    return ids
      .map((id: number) => serializeCollection(getCollection(id)))
      .filter(Boolean) as ClauderoCollectionContext[];
  } catch {
    return [];
  }
}

function getActiveCollectionContext(
  pane: any,
): ClauderoCollectionContext | undefined {
  try {
    const collection =
      (pane as any).getSelectedCollection?.() ||
      (pane as any).collectionsView?.getSelectedCollection?.();
    if (collection) return serializeCollection(collection);
  } catch {
    /* best effort */
  }

  try {
    const collectionID =
      (pane as any).collectionsView?.selection?.focused ||
      (pane as any).collectionsView?.selectedID;
    if (typeof collectionID === "number")
      return serializeCollection(getCollection(collectionID));
  } catch {
    /* best effort */
  }

  return undefined;
}

function contextWindow(targetWindow?: Window | null): Window {
  return targetWindow || Zotero.getMainWindow();
}

function getCurrentReaderObject(targetWindow?: Window | null): any | null {
  try {
    const win = contextWindow(targetWindow) as Window & {
      Zotero_Tabs?: { selectedID?: string; selectedType?: string };
      Zotero?: typeof Zotero & {
        Reader?: { getByTabID?: (tabID: string | undefined) => unknown };
      };
    };
    if (win.Zotero_Tabs?.selectedType !== "reader") return null;
    return win.Zotero?.Reader?.getByTabID?.(win.Zotero_Tabs.selectedID) || null;
  } catch {
    return null;
  }
}

function getCurrentReaderStats(targetWindow?: Window | null): {
  pageIndex?: number;
  pageNumber?: number;
  pageLabel?: string;
  pagesCount?: number;
} {
  try {
    const reader = getCurrentReaderObject(targetWindow) as any;
    if (!reader) return {};
    const Cu = (globalThis as any).Components?.utils;
    const rawInternal = reader._internalReader;
    const internal =
      Cu?.waiveXrays && rawInternal ? Cu.waiveXrays(rawInternal) : rawInternal;
    const stats =
      internal?._state?.primaryViewStats || internal?._state?.primaryViewState;
    const pageIndex =
      typeof stats?.pageIndex === "number" ? stats.pageIndex : undefined;
    return {
      pageIndex,
      pageNumber: typeof pageIndex === "number" ? pageIndex + 1 : undefined,
      pageLabel:
        typeof stats?.pageLabel === "string" ? stats.pageLabel : undefined,
      pagesCount:
        typeof stats?.pagesCount === "number" ? stats.pagesCount : undefined,
    };
  } catch {
    return {};
  }
}

async function getAttachmentContext(
  attachmentID: number,
): Promise<ClauderoAttachmentContext | null> {
  const attachment = (await Zotero.Items.getAsync(attachmentID)) as Zotero.Item;
  if (!attachment) {
    return null;
  }

  let path: string | undefined;
  try {
    path = (await attachment.getFilePathAsync()) || undefined;
    if (!path) path = (attachment as any).getFilePath?.() || undefined;
  } catch {
    try {
      path = (attachment as any).getFilePath?.() || undefined;
    } catch {
      path = undefined;
    }
  }

  return {
    id: attachment.id,
    key: attachment.key,
    iconName:
      (
        attachment as unknown as { getItemTypeIconName?: () => string }
      ).getItemTypeIconName?.() || undefined,
    title: attachment.getDisplayTitle(),
    contentType: attachment.attachmentContentType || "",
    path,
  };
}

export async function getSelectedZoteroContext(
  targetWindow?: Window | null,
): Promise<ClauderoSelectionContext> {
  const win = contextWindow(targetWindow) as Window & {
    ZoteroPane?: ReturnType<typeof Zotero.getActiveZoteroPane>;
  };
  const pane = win.ZoteroPane || Zotero.getActiveZoteroPane();
  const tabs = (
    win as Window & {
      Zotero_Tabs?: { selectedType?: string; selectedID?: string };
    }
  ).Zotero_Tabs;
  const selectedType = tabs?.selectedType || "";
  const selectedTabID = tabs?.selectedID || "";
  const selected = selectedType === "library" ? pane.getSelectedItems() : [];
  const resolvedItems: Zotero.Item[] = [];
  for (const item of selected) {
    if (item.isRegularItem()) {
      resolvedItems.push(item);
    } else if (item.isAttachment?.()) {
      const parent = item.parentItem;
      if (
        parent &&
        parent.isRegularItem() &&
        !resolvedItems.some((i) => i.id === parent.id)
      ) {
        resolvedItems.push(parent);
      }
    }
  }
  const items: ClauderoItemContext[] = [];

  for (const item of resolvedItems) {
    const attachmentIDs = item.getAttachments();
    const attachments = (
      await Promise.all(attachmentIDs.map((id) => getAttachmentContext(id)))
    ).filter(Boolean) as ClauderoAttachmentContext[];

    items.push({
      id: item.id,
      key: item.key,
      itemType: item.itemType,
      title: item.getField("title") as string,
      creators: item.getCreators().map(getCreatorName).filter(Boolean),
      date: (item.getField("date", true, true) as string) || "",
      publicationTitle:
        (item.getField("publicationTitle", false, true) as string) || "",
      abstractNote: stripHtml(
        (item.getField("abstractNote") as string) || "",
      ).slice(0, 800),
      url: (item.getField("url") as string) || "",
      DOI: (item.getField("DOI") as string) || "",
      tags: item
        .getTags()
        .map((tag) => tag.tag)
        .slice(0, 30),
      attachments,
      collections: getItemCollections(item),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    selectedType,
    selectedTabID,
    items,
    activeCollection: getActiveCollectionContext(pane),
    reader: getCurrentReaderAttachmentContext(win),
    selectedText: truncateContextText(getSelectedReaderText(win), 6000),
    selectedAnnotations: getSelectedReaderAnnotations(win),
  };
}

export function getCurrentReaderFilePath(targetWindow?: Window | null): string {
  try {
    const path = getCurrentReaderItem(targetWindow)?.getFilePath?.();
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
}

function getCurrentReaderAttachmentContext(
  targetWindow?: Window | null,
): ClauderoAttachmentContext | undefined {
  const item = getCurrentReaderItem(targetWindow);
  if (!item) return undefined;
  const parent = item.parentItem;
  const stats = getCurrentReaderStats(targetWindow);
  return {
    id: typeof item.id === "number" ? item.id : 0,
    key: typeof item.key === "string" ? item.key : "",
    _item: item,
    iconName:
      (
        item as unknown as { getItemTypeIconName?: () => string }
      ).getItemTypeIconName?.() || undefined,
    title:
      typeof item.getDisplayTitle === "function" ? item.getDisplayTitle() : "",
    contentType:
      typeof item.attachmentContentType === "string"
        ? item.attachmentContentType
        : "",
    path: getCurrentReaderFilePath(targetWindow) || undefined,
    parentItemID: parent?.id,
    parentItemKey: parent?.key,
    parentItemType: parent?.itemType,
    pageIndex: stats.pageIndex,
    pageNumber: stats.pageNumber,
    pageLabel: stats.pageLabel,
    pagesCount: stats.pagesCount,
  };
}

export function getCurrentReaderItem(
  targetWindow?: Window | null,
): (Zotero.Item & { getFilePath?: () => string }) | null {
  try {
    return (
      (
        getCurrentReaderObject(targetWindow) as {
          _item?: Zotero.Item & { getFilePath?: () => string };
        } | null
      )?._item ?? null
    );
  } catch {
    return null;
  }
}

export function getSelectedReaderText(targetWindow?: Window | null): string {
  try {
    const win = contextWindow(targetWindow) as Window & {
      Zotero_Tabs?: { selectedID?: string; selectedType?: string };
      Zotero?: typeof Zotero & {
        Reader?: {
          getByTabID?: (tabID: string | undefined) => unknown;
        };
      };
    };
    if (win.Zotero_Tabs?.selectedType !== "reader") return "";
    const reader = win.Zotero?.Reader?.getByTabID?.(win.Zotero_Tabs.selectedID);
    const selectedText = ztoolkit.Reader.getSelectedText(
      reader as Parameters<typeof ztoolkit.Reader.getSelectedText>[0],
    );
    return typeof selectedText === "string" ? selectedText.trim() : "";
  } catch {
    return "";
  }
}

export function getSelectedReaderAnnotations(
  targetWindow?: Window | null,
): ClauderoAnnotationContext[] {
  try {
    const win = contextWindow(targetWindow) as Window & {
      Zotero_Tabs?: { selectedID?: string; selectedType?: string };
      Zotero?: typeof Zotero & {
        Reader?: { getByTabID?: (id: string | undefined) => unknown };
      };
    };
    if (win.Zotero_Tabs?.selectedType !== "reader") return [];
    const reader = win.Zotero?.Reader?.getByTabID?.(
      win.Zotero_Tabs.selectedID,
    ) as any;
    if (!reader) return [];
    // _internalReader lives in the reader iframe's compartment; accessing its
    // properties (and the _selectedAnnotationIDs array) from privileged code
    // throws "Permission denied" unless we waive the Xray wrapper. We only copy
    // out primitive string keys, which is safe to pass back to chrome.
    const Cu = (globalThis as any).Components?.utils;
    const rawInternal = reader._internalReader;
    if (!rawInternal) return [];
    const internal = Cu?.waiveXrays ? Cu.waiveXrays(rawInternal) : rawInternal;
    const rawKeys = internal?._primaryView?._selectedAnnotationIDs;
    const keys: string[] = [];
    try {
      const len = Number(rawKeys?.length) || 0;
      for (let i = 0; i < len; i++) keys.push(String(rawKeys[i]));
    } catch {
      return [];
    }
    if (!keys.length) return [];
    return keys.flatMap((key: string) => {
      try {
        const item = Zotero.Items.getByLibraryAndKey(
          reader._item?.libraryID,
          key,
        ) as any;
        if (!item) return [];
        return [
          {
            text: (item.annotationText || "").trim(),
            comment: item.annotationComment || undefined,
            type: item.annotationType || "highlight",
            color: item.annotationColor || undefined,
            pageIndex: item.annotationPosition
              ? JSON.parse(item.annotationPosition).pageIndex
              : undefined,
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function buildPromptWithZoteroContext(
  userPrompt: string,
  context: ClauderoSelectionContext,
  apiPrompt: string,
): string {
  return [
    "You are Claudero, a Claude Code-powered research assistant embedded in Zotero.",
    "A lightweight Zotero current context is included in <zotero_current_context>. It contains selected library items, active collection, item collections, the active reader attachment path/page state (pageIndex is 0-based; pageNumber is 1-based), selected reader text, and selected annotations only when present.",
    "Treat this context as the default target for direct instructions. If it is missing, stale, or insufficient, call the Zotero MCP tool get_current_context or targeted tools such as get_item, get_annotations, and get_attachment_path.",
    AGENT_EVIDENCE_POLICY,
    "",
    apiPrompt,
    "",
    "<zotero_current_context>",
    JSON.stringify(context, null, 2),
    "</zotero_current_context>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>",
  ].join("\n");
}

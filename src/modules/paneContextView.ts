import { getString } from "../utils/locale";
import { onElementRemoved } from "./elementLifecycle";
import { createEl } from "./paneDom";
import { type CtxCategory, type PaneState } from "./paneState";
import { asSelectionContext } from "./selectionContextValidation";
import { type ClauderoSelectionContext } from "./zoteroContext";

// Historical context chips, tooltips and detail popups. No request orchestration.
function compactText(value: string, max = 34): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function midTruncate(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return text.slice(0, head) + "…" + text.slice(text.length - tail);
}

function makeStoredItemIconEl(doc: Document, itemType: string): HTMLElement {
  const span = createEl(
    doc,
    "span",
    "claudero-chip-icon icon icon-css icon-item-type cell-icon item-icon",
  );
  if (itemType) span.setAttribute("data-item-type", itemType);
  return span;
}

// Resolve the Zotero item-type icon name for a reader attachment.  Live
// contexts carry `_item` directly; stored (imported) contexts need to re-fetch
// the attachment via Zotero.Items.
function resolveReaderIconType(reader: {
  key: string;
  _item?: Zotero.Item;
}): string {
  const liveIcon =
    reader._item?.getItemTypeIconName?.() ??
    reader._item?.topLevelItem?.getItemTypeIconName?.();
  if (liveIcon) return liveIcon;

  const fetched = Zotero.Items.getByLibraryAndKey(1, reader.key) as
    | (Zotero.Item & { topLevelItem?: Zotero.Item })
    | false;
  if (fetched) {
    const name =
      (fetched as any).getItemTypeIconName?.() ??
      (fetched as any).topLevelItem?.getItemTypeIconName?.();
    if (name) return name;
  }
  return "attachment";
}

// Zotero native library icon, using the same style as item-type icons
function makeNativeLibraryIcon(doc: Document): HTMLElement {
  return createEl(
    doc,
    "span",
    "claudero-chip-icon icon icon-css icon-library cell-icon item-icon",
  );
}

// Zotero's native annotation highlight glyph. Used everywhere we represent
// annotations (the summary chip icon and the annotations detail header).
function makeAnnotationIcon(doc: Document): HTMLElement {
  const img = createEl(doc, "img", "claudero-chip-icon");
  img.src = "chrome://zotero/skin/16/universal/annotate-highlight.svg";
  img.setAttribute("width", "16");
  img.setAttribute("height", "16");
  return img;
}

function makePdfFallbackIcon(doc: Document): HTMLElement {
  const span = createEl(doc, "span", "claudero-pdf-chip-icon");
  span.textContent = "PDF";
  return span;
}

function selectZoteroItemsFromHistory(ids: number[]): void {
  const cleanIDs = ids.filter((id) => Number.isFinite(id) && id > 0);
  if (!cleanIDs.length) return;
  try {
    const win = Zotero.getMainWindow() as Window & {
      Zotero_Tabs?: { select?: (id: string) => void };
      ZoteroPane?: { selectItems?: (ids: number[]) => unknown };
    };
    win.Zotero_Tabs?.select?.("zotero-pane");
    const pane = Zotero.getActiveZoteroPane?.() || win.ZoteroPane;
    void pane?.selectItems?.(cleanIDs);
  } catch (error) {
    ztoolkit.log("[Claudero] Failed to select historical Zotero items:", error);
  }
}

function attachChipTooltip(el: HTMLElement, text: string): void {
  // Store the text as a data attribute so repeated calls (on rebuilt chips)
  // just update the text without adding duplicate event listeners.
  el.dataset.clauderoTooltip = text;
  if (el.dataset.clauderoTooltipBound) return;
  el.dataset.clauderoTooltipBound = "1";
  const doc = el.ownerDocument!;
  let tip: HTMLElement | null = null;
  let stopWatching: (() => void) | undefined;
  const dismiss = () => {
    const dispose = stopWatching;
    stopWatching = undefined;
    tip?.remove();
    tip = null;
    dispose?.();
  };
  el.addEventListener("mouseenter", () => {
    dismiss();
    const tooltipText = el.dataset.clauderoTooltip || "";
    if (!tooltipText) return;
    tip = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    tip.className = "claudero-chip-tooltip";
    tip.textContent = tooltipText;
    // Mount hidden first so we can read its rendered size for clamping.
    tip.style.visibility = "hidden";
    doc.documentElement.appendChild(tip);
    stopWatching = onElementRemoved(tip, dismiss, el);
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
    tip.style.left = `${clampedLeft}px`;
    tip.style.top = `${anchorRect.top - tipRect.height - 6}px`;
    tip.style.visibility = "";
  });
  el.addEventListener("mouseleave", dismiss);
}

// Shared chip content builder — used by both composer chips and message chips
// so they render identically. The caller decides whether to add a remove button.
export function populateContextToken(
  el: HTMLElement,
  doc: Document,
  options: { icon?: HTMLElement; label: string; tooltip?: string },
): void {
  el.textContent = "";
  if (options.icon) el.appendChild(options.icon);
  const span = createEl(doc, "span", "claudero-chip-label");
  span.textContent = options.label;
  el.appendChild(span);
  if (options.tooltip) attachChipTooltip(el, options.tooltip);
}

// Present context categories in priority order (selected text/annotations win
// over items/PDF, which win over the active collection).
function presentContextCategories(
  context: ClauderoSelectionContext,
): CtxCategory[] {
  const categories: CtxCategory[] = [];
  if (context.selectedText?.trim()) categories.push("text");
  if (
    Array.isArray(context.selectedAnnotations) &&
    context.selectedAnnotations.length > 0
  ) {
    categories.push("annotations");
  }
  if (Array.isArray(context.items) && context.items.length > 0)
    categories.push("items");
  if (context.reader?.id || context.reader?.path) categories.push("reader");
  if (context.activeCollection?.name || context.activeCollection?.path)
    categories.push("collection");
  return categories;
}

// A native Zotero library/collection glyph (icon-library / icon-collection),
// rendered by Zotero's own stylesheet in the main window.
function makeZoteroTreeIcon(
  doc: Document,
  kind: "library" | "collection",
): HTMLElement {
  return createEl(
    doc,
    "span",
    `icon icon-css ${kind === "library" ? "icon-library" : "icon-collection"}`,
  );
}

// The "multiple items" glyph: up to three real item-type icons, overlapped —
// the same stacked treatment the composer chip uses.
function makeStackedItemIcons(
  doc: Document,
  items: ClauderoSelectionContext["items"],
): HTMLElement {
  const wrap = createEl(doc, "div", "claudero-item-icons");
  for (const item of items.slice(0, 3)) {
    const icon = makeStoredItemIconEl(doc, item.itemType || "");
    icon.classList.add("stacked");
    wrap.appendChild(icon);
  }
  return wrap;
}

// The compact icon + label shown on the summary chip for the highest-priority
// category present in a message.
function buildSummaryPrimary(
  doc: Document,
  context: ClauderoSelectionContext,
  kind: CtxCategory,
): { icon: HTMLElement; label: string } {
  switch (kind) {
    case "text":
      return {
        icon: createEl(doc, "div", "claudero-text-icon"),
        label: compactText(context.selectedText.trim(), 22),
      };
    case "annotations":
      return {
        icon: makeAnnotationIcon(doc),
        label: getString("context-annotations-section", {
          args: { count: context.selectedAnnotations?.length || 0 },
        }),
      };
    case "items": {
      const items = context.items;
      if (items.length === 1) {
        const item = items[0];
        return {
          icon: makeStoredItemIconEl(doc, item.itemType || ""),
          label: compactText(item.title || item.key || String(item.id), 22),
        };
      }
      return {
        icon: makeStackedItemIcons(doc, items),
        label: getString("context-item-many", {
          args: { count: items.length },
        }),
      };
    }
    case "reader": {
      const reader = context.reader!;
      return {
        icon: makeStoredItemIconEl(doc, resolveReaderIconType(reader)),
        label: compactText(
          reader.title || getString("context-current-pdf-label"),
          22,
        ),
      };
    }
    case "collection": {
      const collection = context.activeCollection!;
      return {
        icon: makeNativeLibraryIcon(doc),
        label: compactText(collection.path || collection.name || "", 22),
      };
    }
  }
  const exhaustive: never = kind;
  return exhaustive;
}

// A single compact pill summarising a message's captured Zotero context. Shows
// the top-priority category and a "+N" badge for the remaining categories;
// clicking it opens a categorised detail popup.
export function buildMessageContextSummaryChip(
  state: PaneState,
  snapshot: unknown,
): HTMLElement | null {
  const context = asSelectionContext(snapshot);
  if (!context) return null;
  const categories = presentContextCategories(context);
  if (!categories.length) return null;

  const doc = state.root.ownerDocument!;
  const chip = createEl(doc, "button", "claudero-message-context-summary");
  chip.type = "button";
  chip.setAttribute("tabindex", "-1");
  chip.setAttribute("title", getString("context-view"));
  chip.setAttribute("aria-label", getString("context-view"));

  const { icon, label } = buildSummaryPrimary(doc, context, categories[0]);
  chip.appendChild(icon);
  const labelEl = createEl(doc, "span", "claudero-chip-label");
  labelEl.textContent = label;
  chip.appendChild(labelEl);

  const extra = categories.length - 1;
  if (extra > 0) {
    const badge = createEl(doc, "span", "claudero-ctx-summary-badge");
    badge.textContent = `+${extra}`;
    chip.appendChild(badge);
  }

  chip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showMessageContextPopup(state, chip, context);
  });
  return chip;
}

// While a detail popup is open we keep its message's hover meta (the summary
// chip + time + actions) pinned visible, and only let it fade ~1.5s after the
// popup closes — so opening details doesn't make the chip vanish under you.
let pinnedContextStack: HTMLElement | null = null;

let pinUnpinTimer: number | null = null;

function pinContextStack(anchor: HTMLElement): void {
  const stack = anchor.closest(".claudero-message-stack") as HTMLElement | null;
  const win = anchor.ownerDocument?.defaultView ?? null;
  if (pinUnpinTimer !== null && win) win.clearTimeout(pinUnpinTimer);
  pinUnpinTimer = null;
  if (pinnedContextStack && pinnedContextStack !== stack) {
    pinnedContextStack.classList.remove("claudero-context-pinned");
  }
  pinnedContextStack = stack;
  stack?.classList.add("claudero-context-pinned");
}

function unpinContextStackSoon(doc: Document): void {
  if (!pinnedContextStack) return;
  const stack = pinnedContextStack;
  const win = doc.defaultView;
  if (pinUnpinTimer !== null && win) win.clearTimeout(pinUnpinTimer);
  if (!win) {
    stack.classList.remove("claudero-context-pinned");
    pinnedContextStack = null;
    pinUnpinTimer = null;
    return;
  }
  pinUnpinTimer = win.setTimeout(() => {
    stack.classList.remove("claudero-context-pinned");
    pinnedContextStack = null;
    pinUnpinTimer = null;
  }, 1500);
}

export function closeContextDetailPopup(doc: Document): HTMLElement | null {
  const existing = doc.querySelector(".claudero-context-detail-popup") as
    | (HTMLElement & { _cleanup?: () => void; _anchor?: HTMLElement })
    | null;
  if (existing) {
    existing._cleanup?.();
    existing.remove();
    unpinContextStackSoon(doc);
  }
  return existing;
}

function positionContextPopup(popup: HTMLElement, anchor: HTMLElement): void {
  const doc = anchor.ownerDocument!;
  const win = doc.defaultView!;
  const a = anchor.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const margin = 8;
  let left = a.right - p.width; // right-align with the chip
  left = Math.max(margin, Math.min(left, win.innerWidth - p.width - margin));
  let top = a.top - p.height - 6; // open upward by default
  if (top < margin) top = a.bottom + 6; // flip below when there's no room
  top = Math.max(margin, Math.min(top, win.innerHeight - p.height - margin));
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function makeCtxSection(
  doc: Document,
  icon: HTMLElement,
  title: string,
): { section: HTMLElement; body: HTMLElement } {
  const section = createEl(doc, "div", "claudero-ctx-section");
  const head = createEl(doc, "div", "claudero-ctx-section-head");
  icon.classList.add("claudero-ctx-head-icon");
  const titleEl = createEl(doc, "span", "claudero-ctx-section-title");
  titleEl.textContent = title;
  head.append(icon, titleEl);
  const body = createEl(doc, "div", "claudero-ctx-section-body");
  section.append(head, body);
  return { section, body };
}

// A clickable row (icon + title + optional sub-lines). Uses a div rather than a
// native <button> so block children stack predictably instead of collapsing
// into the button's single-line box.
function makeClickableRow(
  doc: Document,
  options: {
    icon: HTMLElement;
    title: string;
    subs: string[];
    onClick: () => void;
  },
): HTMLElement {
  const row = createEl(
    doc,
    "div",
    "claudero-ctx-row claudero-ctx-row-clickable",
  );
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "-1");
  options.icon.classList.add("claudero-ctx-row-icon");
  const main = createEl(doc, "div", "claudero-ctx-row-main");
  const title = createEl(doc, "div", "claudero-ctx-row-title");
  title.textContent = options.title;
  main.appendChild(title);
  for (const sub of options.subs) {
    const subEl = createEl(doc, "div", "claudero-ctx-row-sub");
    subEl.textContent = sub;
    main.appendChild(subEl);
  }
  row.append(options.icon, main);
  row.addEventListener("click", () => {
    options.onClick();
    closeContextDetailPopup(doc);
  });
  return row;
}

function buildContextSection(
  doc: Document,
  context: ClauderoSelectionContext,
  kind: CtxCategory,
): HTMLElement {
  switch (kind) {
    case "text": {
      const { section, body } = makeCtxSection(
        doc,
        createEl(doc, "div", "claudero-text-icon"),
        getString("context-selected-text-label"),
      );
      const text = createEl(doc, "div", "claudero-ctx-text");
      text.textContent = context.selectedText.trim();
      body.appendChild(text);
      return section;
    }
    case "annotations": {
      const annotations = context.selectedAnnotations || [];
      // Annotations always use Zotero's highlight glyph.
      const { section, body } = makeCtxSection(
        doc,
        makeAnnotationIcon(doc),
        getString("context-annotations-section", {
          args: { count: annotations.length },
        }),
      );
      for (const anno of annotations) {
        const row = createEl(doc, "div", "claudero-ctx-row claudero-ctx-anno");
        // The annotation's own colour shows as a left accent bar; the page badge
        // sits at the bottom-right under the text.
        if (anno.color) row.style.borderLeftColor = anno.color;
        const main = createEl(doc, "div", "claudero-ctx-row-main");
        const textEl = createEl(doc, "div", "claudero-ctx-anno-text");
        textEl.textContent =
          anno.text || getString("context-no-annotation-text");
        main.appendChild(textEl);
        if (anno.comment) {
          const comment = createEl(doc, "div", "claudero-ctx-anno-comment");
          comment.textContent = anno.comment;
          main.appendChild(comment);
        }
        if (typeof anno.pageIndex === "number") {
          const page = createEl(doc, "span", "claudero-ctx-page");
          page.textContent = `p.${anno.pageIndex + 1}`;
          main.appendChild(page);
        }
        row.appendChild(main);
        body.appendChild(row);
      }
      return section;
    }
    case "items": {
      const items = context.items;
      // Header shows the item's own icon (the single item's type icon, or
      // stacked type icons when several are selected); rows repeat each icon.
      const headIcon =
        items.length === 1
          ? makeStoredItemIconEl(doc, items[0].itemType || "")
          : makeStackedItemIcons(doc, items);
      const { section, body } = makeCtxSection(
        doc,
        headIcon,
        items.length === 1
          ? getString("context-item-one")
          : getString("context-item-many", { args: { count: items.length } }),
      );
      for (const item of items) {
        const subParts = [item.creators?.[0], (item.date || "").slice(0, 4)]
          .filter(Boolean)
          .join(" · ");
        body.appendChild(
          makeClickableRow(doc, {
            icon: makeStoredItemIconEl(doc, item.itemType || ""),
            title: item.title || item.key || String(item.id),
            subs: subParts ? [subParts] : [],
            onClick: () => selectZoteroItemsFromHistory([item.id]),
          }),
        );
      }
      return section;
    }
    case "reader": {
      const reader = context.reader!;
      const rowIcon = makeStoredItemIconEl(doc, resolveReaderIconType(reader));
      const headIcon = makeStoredItemIconEl(doc, resolveReaderIconType(reader));
      const { section, body } = makeCtxSection(
        doc,
        headIcon,
        getString("context-item-one"),
      );
      const page =
        reader.pageLabel ||
        (reader.pageNumber ? String(reader.pageNumber) : "");
      const subs: string[] = [];
      if (page)
        subs.push(
          getString("context-page", {
            args: {
              page,
              total: reader.pagesCount ? ` / ${reader.pagesCount}` : "",
            },
          }),
        );
      if (reader.path) subs.push(midTruncate(reader.path, 60));
      body.appendChild(
        makeClickableRow(doc, {
          icon: rowIcon,
          title: reader.title || getString("context-current-pdf-label"),
          subs,
          // Select the PDF attachment itself, not its parent item.
          onClick: () => selectZoteroItemsFromHistory([reader.id]),
        }),
      );
      return section;
    }
    case "collection": {
      const collection = context.activeCollection!;
      // Use Zotero native library icon style for the section header
      const { section, body } = makeCtxSection(
        doc,
        makeNativeLibraryIcon(doc),
        getString("context-collection"),
      );
      const tree = createEl(doc, "div", "claudero-ctx-coll-tree");
      const levels: {
        label: string;
        kind: "library" | "collection";
        current: boolean;
      }[] = [
        {
          label: collection.libraryName || getString("context-library"),
          kind: "library",
          current: false,
        },
      ];
      const names = (collection.path || collection.name || "")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
      names.forEach((name, index) => {
        levels.push({
          label: name,
          kind: "collection",
          current: index === names.length - 1,
        });
      });
      levels.forEach((level, index) => {
        const row = createEl(
          doc,
          "div",
          `claudero-ctx-coll-row${level.current ? " current" : ""}`,
        );
        row.style.setProperty("--level", String(index));
        const label = createEl(doc, "span", "claudero-ctx-coll-label");
        label.textContent = level.label;
        row.append(makeZoteroTreeIcon(doc, level.kind), label);
        tree.appendChild(row);
      });
      body.appendChild(tree);
      return section;
    }
  }
  const exhaustive: never = kind;
  return exhaustive;
}

function showMessageContextPopup(
  state: PaneState,
  anchor: HTMLElement,
  context: ClauderoSelectionContext,
): void {
  const doc = anchor.ownerDocument!;
  const closed = closeContextDetailPopup(doc) as
    | (HTMLElement & { _anchor?: HTMLElement })
    | null;
  if (closed && closed._anchor === anchor) return; // clicking the open chip toggles it shut

  const categories = presentContextCategories(context);
  if (!categories.length) return;

  pinContextStack(anchor); // keep the chip visible while details are open

  const popup = createEl(
    doc,
    "div",
    "claudero-context-detail-popup",
  ) as HTMLElement & {
    _cleanup?: () => void;
    _anchor?: HTMLElement;
  };
  popup._anchor = anchor;
  popup.style.visibility = "hidden"; // measure before revealing to avoid a position flash
  for (const kind of categories) {
    popup.appendChild(buildContextSection(doc, context, kind));
  }
  doc.documentElement.appendChild(popup);
  positionContextPopup(popup, anchor);
  popup.style.visibility = "";

  const win = doc.defaultView!;
  const onPointerDown = (event: Event) => {
    const target = event.target as Node;
    if (!popup.contains(target) && !anchor.contains(target))
      closeContextDetailPopup(doc);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeContextDetailPopup(doc);
  };
  const onReflow = () => closeContextDetailPopup(doc);
  doc.addEventListener("mousedown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("resize", onReflow, true);
  state.transcript.addEventListener("scroll", onReflow, true);
  popup._cleanup = onElementRemoved(
    popup,
    () => {
      popup.remove();
      doc.removeEventListener("mousedown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("resize", onReflow, true);
      state.transcript.removeEventListener("scroll", onReflow, true);
    },
    state.root,
  );
}

// A div-based dropdown. The collapsed button shows whatever label we want
// (independent of the stored value), which a XUL <menulist> cannot do — its
// collapsed text is always the selected <menuitem>'s label. That coupling is
// why the old menulist inevitably displayed "Haiku · Low" instead of just
// "Low": the only way to surface the model in one collapsed widget was to
// rewrite the menuitem label. Decoupling display from value fixes that.
import { getString } from "../utils/locale";

export interface DivSelect {
  value: string;
  disabled: boolean;
  /** Visible button element (the collapsed control). */
  element: HTMLElement;
  setItems?: (items: DivSelectItem[], preferredValue?: string) => void;
}

export interface DivSelectItem {
  value: string;
  label: string;
  description?: string;
  danger?: boolean;
}

export interface ComposerViewStateRef<S> {
  current: S | null;
}

export interface ComposerViewOptions<S> {
  providerOptions: DivSelectItem[];
  modelOptions: DivSelectItem[];
  effortOptions: DivSelectItem[];
  permissionOptions: DivSelectItem[];
  defaultProvider: string;
  defaultModel: string;
  defaultEffort: string;
  defaultPermission: string;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  onPermissionChange: (value: string) => void;
  onAtClick: (state: S) => void;
  onMagicClick: (state: S, anchor: HTMLElement) => void;
  onInputChanged: (state: S) => void;
  onAtTyped: (state: S) => void;
  onPasteImages: (state: S, files: Blob[]) => void;
}

export interface ComposerView<S> {
  element: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  providerSelect: DivSelect;
  modelSelect: DivSelect;
  effortSelect: DivSelect;
  permissionSelect: DivSelect;
  contextChips: HTMLElement;
  itemChip: HTMLElement;
  readerChip: HTMLElement;
  textChip: HTMLElement;
  annotationChip: HTMLElement;
  setStateRef: (state: S) => void;
}

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

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function caretSvg(doc: Document): SVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.classList.add("claudero-select-caret");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3.5 5.5 8 10l4.5-4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

function checkSvg(doc: Document): SVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.classList.add("claudero-select-check");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3.5 8.5 6.5 11.5 12.5 4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

/**
 * Position a floating popover relative to its anchor button, mirroring the
 * pattern used by the icon/prompt pickers: append to documentElement, measure,
 * open upward when there is little room below (the composer toolbar sits at the
 * bottom, so upward is the normal case).
 */
function placePopover(
  doc: Document,
  popover: HTMLElement,
  anchor: HTMLElement,
): void {
  const vw = doc.defaultView?.innerWidth ?? 800;
  const vh = doc.defaultView?.innerHeight ?? 800;
  const rect = anchor.getBoundingClientRect();
  const st = doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
  const sl = doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;

  let left = rect.left + sl;
  if (left + pw > vw - 8) left = vw - pw - 8;
  popover.style.left = `${Math.max(8, left)}px`;

  const spaceBelow = vh - rect.bottom - 8;
  if (spaceBelow > Math.min(ph, 200)) {
    popover.style.top = `${rect.bottom + st + 6}px`;
    popover.style.transform = "";
  } else {
    popover.style.top = `${rect.top + st - 6}px`;
    popover.style.transform = "translateY(-100%)";
  }
}

/**
 * Position a cascading flyout (the model sub-menu) beside the row that opened
 * it: aligned to the parent panel's right edge by default, flipping to the left
 * edge when there isn't room. Its top aligns to the row, nudged up so the
 * header sits beside it, and is clamped into the viewport.
 */
function placeFlyout(
  doc: Document,
  flyout: HTMLElement,
  row: HTMLElement,
  panel: HTMLElement,
): void {
  const vw = doc.defaultView?.innerWidth ?? 800;
  const vh = doc.defaultView?.innerHeight ?? 800;
  const panelRect = panel.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const st = doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
  const sl = doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
  const fw = flyout.offsetWidth;
  const fh = flyout.offsetHeight;

  // Prefer opening to the right of the panel; flip to the left if it overflows.
  let left = panelRect.right + sl + 2;
  if (left + fw > vw - 8) left = panelRect.left + sl - fw - 2;
  if (left < 8) left = 8;
  flyout.style.left = `${left}px`;

  // Align the flyout's first row roughly with the hovered row; clamp to viewport.
  let top = rowRect.top + st - 6;
  if (top + fh > vh + st - 8) top = vh + st - fh - 8;
  if (top < st + 8) top = st + 8;
  flyout.style.top = `${top}px`;
  flyout.style.transform = "";
}

function closeSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const first = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  first.setAttribute("d", "M18 6 6 18");
  const second = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  second.setAttribute("d", "m6 6 12 12");
  svg.append(first, second);
  return svg;
}

interface SelectConfig {
  className: string;
  items: DivSelectItem[];
  defaultValue: string;
  header?: string;
  // Optional secondary panel (e.g. model picker reachable from the primary one).
  sub?: {
    header: string;
    items: DivSelectItem[];
    defaultSub: string;
  };
}

function confirmDangerousPermissionMode(doc: Document): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = createEl(doc, "div", "claudero-danger-confirm-backdrop");
    const card = createEl(doc, "div", "claudero-danger-confirm-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "claudero-danger-confirm-title");

    const closeBtn = ((
      doc as Document & { createXULElement?: (tag: string) => HTMLElement }
    ).createXULElement?.("toolbarbutton") ??
      createEl(doc, "button")) as HTMLElement;
    closeBtn.className = "claudero-danger-confirm-close";
    if (closeBtn.localName !== "toolbarbutton")
      (closeBtn as HTMLButtonElement).type = "button";
    closeBtn.setAttribute("aria-label", getString("ui-cancel"));
    closeBtn.setAttribute("title", getString("ui-cancel"));
    closeBtn.setAttribute("tooltiptext", getString("ui-cancel"));
    closeBtn.appendChild(closeSvg(doc));

    const title = createEl(doc, "div", "claudero-danger-confirm-title");
    title.id = "claudero-danger-confirm-title";
    title.textContent = getString("composer-bypass-title");

    const body = createEl(doc, "div", "claudero-danger-confirm-body");
    body.textContent = getString("composer-bypass-description");

    const actions = createEl(doc, "div", "claudero-danger-confirm-actions");
    const cancel = createEl(doc, "button", "claudero-danger-confirm-cancel");
    cancel.type = "button";
    cancel.textContent = getString("ui-cancel");
    const confirm = createEl(doc, "button", "claudero-danger-confirm-primary");
    confirm.type = "button";
    confirm.textContent = getString("composer-bypass-confirm");
    actions.append(cancel, confirm);
    card.append(closeBtn, title, body, actions);
    overlay.appendChild(card);

    const cleanup = (value: boolean) => {
      doc.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") cleanup(false);
    }
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) cleanup(false);
    });
    closeBtn.addEventListener("command", () => cleanup(false));
    closeBtn.addEventListener("click", () => cleanup(false));
    cancel.addEventListener("click", () => cleanup(false));
    confirm.addEventListener("click", () => cleanup(true));
    doc.addEventListener("keydown", onKey, true);
    doc.documentElement.appendChild(overlay);
  });
}

function buildSelect(
  doc: Document,
  config: SelectConfig,
  onChange: (value: string) => void,
  onSubChange?: (value: string) => void,
): { primary: DivSelect; secondary: DivSelect | null } {
  const button = createEl(doc, "div", `claudero-select ${config.className}`);
  const labelEl = createEl(doc, "span", "claudero-select-label");
  button.append(labelEl, caretSvg(doc));

  let cur = config.defaultValue;
  let curSub = config.sub?.defaultSub ?? "";
  let disabled = false;
  // The main dropdown panel. A model sub-menu (when config.sub is set) opens as
  // a separate flyout element positioned beside this panel on hover, mirroring a
  // native cascading menu — rather than replacing the panel's contents.
  let popover: HTMLElement | null = null;
  let flyout: HTMLElement | null = null;
  let flyoutTimer: ReturnType<typeof setTimeout> | null = null;

  const labelOf = (value: string, items: DivSelectItem[]) =>
    items.find((o) => o.value === value)?.label ?? value;
  // Collapsed label. When a model sub-menu exists, show "Model Effort" with the
  // model name in primary (black) and the effort in secondary (gray); otherwise
  // just the selected item's label.
  const setCollapsedLabel = () => {
    labelEl.textContent = "";
    const selected = config.items.find((item) => item.value === cur);
    button.classList.toggle("is-danger-selected", selected?.danger === true);
    button.classList.toggle(
      "is-auto-selected",
      config.className === "permission" && cur === "auto",
    );
    if (selected?.description)
      button.setAttribute("title", selected.description);
    else button.removeAttribute("title");
    if (config.sub) {
      const model = createEl(doc, "span", "claudero-select-label-model");
      model.textContent = labelOf(curSub, config.sub.items);
      const effort = createEl(doc, "span", "claudero-select-label-effort");
      effort.textContent = labelOf(cur, config.items);
      labelEl.append(model, effort);
    } else {
      labelEl.textContent = labelOf(cur, config.items);
    }
  };
  setCollapsedLabel();

  const removeFlyout = () => {
    if (flyoutTimer) {
      clearTimeout(flyoutTimer);
      flyoutTimer = null;
    }
    flyout?.remove();
    flyout = null;
  };

  const closePopover = () => {
    removeFlyout();
    if (!popover) return;
    popover.remove();
    popover = null;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("is-open");
    doc.removeEventListener("mousedown", onOutside, true);
    doc.removeEventListener("keydown", onKey, true);
  };

  function onOutside(ev: MouseEvent): void {
    const t = ev.target as Node;
    const inMain =
      popover && (popover.contains(t) || t === button || button.contains(t));
    const inFlyout = flyout && flyout.contains(t);
    if (!inMain && !inFlyout) closePopover();
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") closePopover();
  }

  const makeRow = (
    item: DivSelectItem,
    selected: boolean,
    trailing?: Node,
  ): HTMLElement => {
    const row = createEl(doc, "div", "claudero-select-row");
    if (selected) row.classList.add("selected");
    if (item.danger) row.classList.add("is-danger");
    if (item.description) row.setAttribute("title", item.description);
    const txt = createEl(doc, "span", "claudero-select-row-label");
    txt.textContent = item.label;
    row.appendChild(txt);
    const tail = createEl(doc, "span", "claudero-select-row-tail");
    if (trailing) tail.appendChild(trailing);
    else if (selected) tail.appendChild(checkSvg(doc));
    row.appendChild(tail);
    return row;
  };

  // Build (or rebuild) the model flyout and position it beside `subRow`.
  const openFlyout = (subRow: HTMLElement) => {
    if (!config.sub || !popover) return;
    removeFlyout();
    flyout = createEl(
      doc,
      "div",
      "claudero-select-popover claudero-select-flyout",
    );
    flyout.style.zIndex = "2147483647";
    if (config.sub.header) {
      const hdr = createEl(doc, "div", "claudero-select-group-header");
      hdr.textContent = config.sub.header;
      flyout.appendChild(hdr);
    }
    for (const it of config.sub.items) {
      const row = makeRow(it, it.value === curSub);
      row.addEventListener("click", () => {
        curSub = it.value;
        onSubChange?.(it.value);
        setCollapsedLabel();
        showPrimary();
        closePopover();
      });
      flyout.appendChild(row);
    }
    flyout.addEventListener("mouseenter", () => {
      if (flyoutTimer) {
        clearTimeout(flyoutTimer);
        flyoutTimer = null;
      }
    });
    flyout.addEventListener("mouseleave", scheduleFlyoutClose);
    doc.documentElement.appendChild(flyout);
    placeFlyout(doc, flyout, subRow, popover);
  };

  const scheduleFlyoutClose = () => {
    if (flyoutTimer) clearTimeout(flyoutTimer);
    flyoutTimer = setTimeout(removeFlyout, 180);
  };

  // Render the main panel: section header, effort rows, separator, model row.
  const showPrimary = () => {
    if (!popover) return;
    removeFlyout();
    popover.textContent = "";
    if (config.header) {
      const hdr = createEl(doc, "div", "claudero-select-group-header");
      hdr.textContent = config.header;
      popover.appendChild(hdr);
    }
    for (const it of config.items) {
      const row = makeRow(it, it.value === cur);
      row.addEventListener("click", async () => {
        if (
          it.danger &&
          it.value !== cur &&
          !(await confirmDangerousPermissionMode(doc))
        )
          return;
        cur = it.value;
        setCollapsedLabel();
        onChange(it.value);
        closePopover();
      });
      row.addEventListener("mouseenter", scheduleFlyoutClose);
      popover.appendChild(row);
    }
    if (config.sub) {
      const sep = createEl(doc, "div", "claudero-select-separator");
      popover.appendChild(sep);
      const arrow = doc.createElementNS(XHTML_NS, "span");
      arrow.className = "claudero-select-sub-arrow";
      arrow.textContent = "›";
      // The model row shows the current model name directly (no "Model:" prefix)
      // and opens a flyout submenu on hover or click.
      const subRow = createEl(doc, "div", "claudero-select-subrow");
      const txt = createEl(doc, "span", "claudero-select-row-label");
      txt.textContent = labelOf(curSub, config.sub.items);
      const tail = createEl(doc, "span", "claudero-select-row-tail");
      tail.appendChild(arrow);
      subRow.append(txt, tail);
      subRow.addEventListener("mouseenter", () => openFlyout(subRow));
      subRow.addEventListener("mouseleave", scheduleFlyoutClose);
      subRow.addEventListener("click", () => openFlyout(subRow));
      popover.appendChild(subRow);
    }
  };

  const open = () => {
    if (disabled) return;
    closePopover();
    // Close any other claudero popovers first (single surface at a time).
    doc
      .querySelectorAll(".claudero-select-popover")
      .forEach((el) => el.remove());
    popover = createEl(doc, "div", "claudero-select-popover");
    popover.style.zIndex = "2147483646";
    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-open");
    doc.documentElement.appendChild(popover);
    showPrimary();
    placePopover(doc, popover, button);
    setTimeout(() => {
      doc.addEventListener("mousedown", onOutside, true);
      doc.addEventListener("keydown", onKey, true);
    }, 0);
  };

  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (popover) closePopover();
    else open();
  });

  const primary: DivSelect = {
    element: button,
    get value() {
      return cur;
    },
    set value(v: string) {
      if (!config.items.some((o) => o.value === v)) return;
      cur = v;
      setCollapsedLabel();
      if (popover) showPrimary();
    },
    get disabled() {
      return disabled;
    },
    set disabled(v: boolean) {
      disabled = v;
      button.classList.toggle("is-disabled", v);
      if (v) closePopover();
    },
    setItems(items: DivSelectItem[], preferredValue?: string) {
      config.items = items;
      if (preferredValue && items.some((o) => o.value === preferredValue)) {
        cur = preferredValue;
      } else if (!items.some((o) => o.value === cur)) {
        cur = items[0]?.value ?? "";
      }
      setCollapsedLabel();
      if (popover) showPrimary();
    },
  };

  const secondary: DivSelect | null = config.sub
    ? {
        element: button,
        get value() {
          return curSub;
        },
        set value(v: string) {
          if (!config.sub!.items.some((o) => o.value === v)) return;
          curSub = v;
          setCollapsedLabel();
          if (popover) showPrimary();
        },
        get disabled() {
          return disabled;
        },
        set disabled(v: boolean) {
          disabled = v;
          button.classList.toggle("is-disabled", v);
          if (v) closePopover();
        },
        setItems(items: DivSelectItem[], preferredValue?: string) {
          config.sub!.items = items;
          if (preferredValue && items.some((o) => o.value === preferredValue)) {
            curSub = preferredValue;
          } else if (!items.some((o) => o.value === curSub)) {
            curSub = items[0]?.value ?? "";
          }
          setCollapsedLabel();
          if (popover) showPrimary();
        },
      }
    : null;

  return { primary, secondary };
}

export function createComposerView<S>(
  doc: Document,
  options: ComposerViewOptions<S>,
): ComposerView<S> {
  const stateRef: ComposerViewStateRef<S> = { current: null };

  // ── Provider dropdown ───────────────────────────────────────────────────
  const providerSelect = buildSelect(
    doc,
    {
      className: "provider",
      items: options.providerOptions,
      defaultValue: options.defaultProvider,
    },
    options.onProviderChange,
  ).primary;

  // ── Effort + model dropdown (cascading, div-based) ───────────────────────
  const effortModel = buildSelect(
    doc,
    {
      className: "effort",
      items: options.effortOptions,
      defaultValue: options.defaultEffort,
      header: "Thinking",
      sub: {
        header: "Model",
        items: options.modelOptions,
        defaultSub: options.defaultModel,
      },
    },
    options.onEffortChange,
    options.onModelChange,
  );

  // ── Permission mode dropdown ─────────────────────────────────────────────
  const permissionSelect = buildSelect(
    doc,
    {
      className: "permission",
      items: options.permissionOptions,
      defaultValue: options.defaultPermission,
    },
    options.onPermissionChange,
  ).primary;

  // ── Rest of composer ───────────────────────────────────────────────────
  const composer = createEl(doc, "div", "claudero-composer");
  const chips = createEl(doc, "div", "claudero-context-chips");
  const itemChip = createEl(doc, "div", "claudero-context-token");
  const readerChip = createEl(doc, "div", "claudero-context-token");
  const textChip = createEl(doc, "div", "claudero-context-token");
  const annotationChip = createEl(doc, "div", "claudero-context-token");
  const input = createEl(doc, "textarea", "claudero-input");
  const toolbar = createEl(doc, "div", "claudero-composer-toolbar");

  const atBtn = createEl(doc, "button", "claudero-at-button");
  atBtn.innerHTML = `<svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path d="M554.76 549.889v341c0 26.51-21.491 48-48 48-26.51 0-48-21.49-48-48v-341H114.172c-26.51 0-48-21.49-48-48s21.49-48 48-48H458.76v-340c0-26.51 21.49-48 48-48s48 21.49 48 48v340h346.414c26.51 0 48 21.49 48 48s-21.49 48-48 48H554.76z" fill="currentColor"></path></svg>`;
  atBtn.setAttribute("tabindex", "-1");
  atBtn.setAttribute("title", getString("composer-add-context"));
  atBtn.setAttribute("aria-label", getString("composer-add-context"));

  const spacer = createEl(doc, "div", "claudero-toolbar-spacer");
  const magicBtn = createEl(doc, "button", "claudero-magic-button");
  magicBtn.setAttribute("tabindex", "-1");
  magicBtn.setAttribute("title", getString("composer-quick-prompts"));
  magicBtn.innerHTML = `<svg class="icon" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M591.296 912c-17.536 0-29.824-11.264-36.48-33.536-12.672-68.16-23.424-117.696-32.192-148.8a96.256 96.256 0 0 0-58.304-65.472c-30.08-13.696-83.456-25.856-160.384-36.48-21.248-3.904-31.936-15.68-31.936-35.2 0-21.248 10.24-32.832 30.528-34.752 76.8-12.672 130.368-25.28 160.384-37.952 29.44-10.88 51.712-35.328 59.712-65.664 8.768-32 19.52-81.664 32.128-148.8 6.848-22.272 19.008-33.344 36.544-33.344 19.328 0 31.616 11.072 36.352 33.344 11.776 67.136 22.336 116.8 32.128 148.8 8.96 30.272 31.552 54.592 61.12 65.664 31.104 12.672 84.672 25.28 160.384 37.952 20.48 2.816 30.72 14.592 30.72 34.944 0 19.328-10.24 31.104-30.72 34.944-75.712 10.56-129.28 22.848-160.384 36.352a100.48 100.48 0 0 0-61.12 65.664 1346.368 1346.368 0 0 0-32.128 153.152c-4.928 19.328-17.024 29.184-36.352 29.184zM271.68 432c-8.832 0-14.976-5.632-18.304-16.768-6.336-34.048-11.648-58.88-16.064-74.368a48.128 48.128 0 0 0-29.184-32.768c-14.976-6.848-41.664-12.928-80.128-18.24-10.624-1.92-16-7.872-16-17.6 0-10.624 5.12-16.384 15.296-17.408 38.4-6.272 65.152-12.608 80.128-18.944a48 48 0 0 0 29.888-32.832c4.416-16 9.728-40.832 16.064-74.368 3.456-11.2 9.472-16.704 18.304-16.704 9.6 0 15.744 5.504 18.176 16.64 5.824 33.6 11.136 58.432 16 74.432 4.48 15.168 15.808 27.328 30.592 32.832 15.552 6.336 42.304 12.672 80.192 18.944 10.24 1.408 15.36 7.296 15.36 17.472 0 9.664-5.12 15.552-15.36 17.536-37.888 5.248-64.64 11.392-80.192 18.176a50.24 50.24 0 0 0-30.528 32.832c-6.848 25.152-12.224 50.752-16.064 76.544-2.496 9.664-8.576 14.592-18.176 14.592z" fill="currentColor"/></svg>`;

  const sendButton = createEl(doc, "button", "claudero-send-button");

  chips.style.display = "none";
  itemChip.style.display = "none";
  readerChip.style.display = "none";
  textChip.style.display = "none";
  annotationChip.style.display = "none";
  input.placeholder = getString("composer-ask-placeholder");
  input.rows = 2;

  chips.append(itemChip, readerChip, textChip, annotationChip);
  const toolbarLeft = createEl(doc, "div", "claudero-toolbar-left");
  toolbarLeft.append(
    atBtn,
    effortModel.primary.element,
    permissionSelect.element,
    spacer,
  );
  toolbar.append(toolbarLeft, magicBtn, sendButton);
  composer.append(chips, input, toolbar);

  // Hide selects when the full toolbar is too narrow to keep action buttons visible.
  const ro = new (doc.defaultView as any).ResizeObserver(
    (entries: ResizeObserverEntry[]) => {
      const w = entries[0].contentRect.width;
      permissionSelect.element.style.display = w < 360 ? "none" : "";
      effortModel.primary.element.style.display = w < 220 ? "none" : "";
    },
  );
  ro.observe(toolbar);

  atBtn.addEventListener("click", () => {
    if (stateRef.current) options.onAtClick(stateRef.current);
  });
  magicBtn.addEventListener("click", () => {
    if (stateRef.current) options.onMagicClick(stateRef.current, magicBtn);
  });

  input.addEventListener("input", () => {
    const state = stateRef.current;
    if (!state) return;
    const val = input.value;
    if (val.endsWith("@")) {
      input.value = val.slice(0, -1);
      options.onAtTyped(state);
      return;
    }
    options.onInputChanged(state);
  });

  input.addEventListener("paste", (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items || !stateRef.current) return;
    const files: Blob[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      options.onPasteImages(stateRef.current, files);
    }
  });

  return {
    element: composer,
    input,
    sendButton,
    providerSelect,
    modelSelect: effortModel.secondary!,
    effortSelect: effortModel.primary,
    permissionSelect,
    contextChips: chips,
    itemChip,
    readerChip,
    textChip,
    annotationChip,
    setStateRef: (state: S) => {
      stateRef.current = state;
    },
  };
}

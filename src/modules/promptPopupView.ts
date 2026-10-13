import {
  getDefaultPrompts,
  loadCustomPrompts,
  saveCustomPrompt,
  deleteCustomPrompt,
  assertPromptUnchanged,
  saveDefaultPrompts,
  type CustomPrompt,
  type PromptIcon,
  randomPromptIcon,
} from "./conversationStore";
import { renderPromptIcon, showIconPicker } from "./iconPickerView";
import { getString } from "../utils/locale";
import { onElementRemoved } from "./elementLifecycle";

export interface PromptPopupState {
  root: HTMLElement;
}

export interface PromptPopupActions {
  onPrompt: (prompt: string) => void;
  onInsertNote: () => void;
  onRefinePrompt?: (
    input: {
      label: string;
      description: string;
      text: string;
    },
    signal?: AbortSignal,
  ) => Promise<Partial<Pick<CustomPrompt, "label" | "description" | "text">>>;
}

type PromptSource = "default" | "custom";
type PromptEntry = CustomPrompt & { source: PromptSource };
const promptLoads = new WeakMap<HTMLElement, Promise<PromptEntry[]>>();
const promptRenders = new WeakMap<HTMLElement, symbol>();

function promptData({ source: _source, ...prompt }: PromptEntry): CustomPrompt {
  return prompt;
}

function showPromptError(container: HTMLElement, error: unknown): void {
  let message = container.querySelector<HTMLElement>(".claudero-prompt-error");
  if (!message) {
    message = createEl(
      container.ownerDocument!,
      "div",
      "claudero-magic-empty claudero-prompt-error",
    );
    message.setAttribute("role", "alert");
    container.appendChild(message);
  }
  message.textContent = `${getString("prompt-operation-failed")} ${error instanceof Error ? error.message : String(error)}`;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(XHTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  return el;
}

function createTbBtn(
  doc: Document,
  className: string,
  label: string,
  onClick: () => void,
): HTMLElement {
  const xul = (
    doc as Document & { createXULElement?: (tag: string) => HTMLElement }
  ).createXULElement?.("toolbarbutton");
  const btn = (xul ?? doc.createElement("button")) as HTMLElement;
  btn.className = className;
  btn.setAttribute("label", label);
  // XUL toolbarbutton renders text from the `label` attribute; only set
  // textContent for the HTML <button> fallback to avoid doubling the text.
  if (btn.localName !== "toolbarbutton") btn.textContent = label;
  btn.addEventListener("command", (e) => {
    e.stopPropagation();
    onClick();
  });
  if (btn.localName !== "toolbarbutton") {
    (btn as HTMLButtonElement).type = "button";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return btn;
}

function createSvg(
  doc: Document,
  name: "plus" | "search" | "edit" | "trash" | "x",
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const line = (x1: string, y1: string, x2: string, y2: string) => {
    const el = doc.createElementNS(SVG_NS, "line");
    el.setAttribute("x1", x1);
    el.setAttribute("y1", y1);
    el.setAttribute("x2", x2);
    el.setAttribute("y2", y2);
    svg.appendChild(el);
  };
  const path = (d: string) => {
    const el = doc.createElementNS(SVG_NS, "path");
    el.setAttribute("d", d);
    svg.appendChild(el);
  };
  const circle = (cx: string, cy: string, r: string) => {
    const el = doc.createElementNS(SVG_NS, "circle");
    el.setAttribute("cx", cx);
    el.setAttribute("cy", cy);
    el.setAttribute("r", r);
    svg.appendChild(el);
  };
  const polyline = (points: string) => {
    const el = doc.createElementNS(SVG_NS, "polyline");
    el.setAttribute("points", points);
    svg.appendChild(el);
  };
  if (name === "plus") {
    line("12", "5", "12", "19");
    line("5", "12", "19", "12");
  }
  if (name === "x") {
    line("18", "6", "6", "18");
    line("6", "6", "18", "18");
  }
  if (name === "search") {
    circle("11", "11", "7");
    line("16.65", "16.65", "21", "21");
  }
  if (name === "edit") {
    path("M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7");
    path("M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z");
  }
  if (name === "trash") {
    polyline("3 6 5 6 21 6");
    path(
      "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
    );
  }
  return svg;
}

function closePromptSurfaces(root: HTMLElement): void {
  root.querySelectorAll(".claudero-magic-stack").forEach((el) => el.remove());
}

async function loadEntries(): Promise<PromptEntry[]> {
  const defaults = getDefaultPrompts().map((prompt) => ({
    ...prompt,
    source: "default" as const,
  }));
  const custom = (await loadCustomPrompts()).map((prompt) => ({
    ...prompt,
    source: "custom" as const,
  }));
  return [...defaults, ...custom];
}

function fallbackDescription(prompt: CustomPrompt): string {
  return (
    prompt.description?.trim() ||
    prompt.text.split("\n")[0]?.trim().slice(0, 88) ||
    "Custom prompt"
  );
}

function renderIcon(
  doc: Document,
  prompt: CustomPrompt,
  container: HTMLElement,
): void {
  while (container.firstChild) container.firstChild.remove();
  renderPromptIcon(doc, prompt.icon, container);
  if (!container.firstChild) {
    const mark = createEl(doc, "span", "claudero-prompt-icon-empty");
    mark.textContent = prompt.label.trim().slice(0, 1).toUpperCase() || "•";
    container.appendChild(mark);
  }
}

async function saveEntry(
  entry: PromptEntry,
  original?: PromptEntry,
): Promise<void> {
  const { source, ...prompt } = entry;
  if (source === "default") {
    const defaults = getDefaultPrompts();
    const idx = defaults.findIndex((item) => item.id === prompt.id);
    assertPromptUnchanged(defaults[idx], original && promptData(original));
    if (idx >= 0) defaults[idx] = prompt;
    else defaults.push(prompt);
    saveDefaultPrompts(defaults);
    return;
  }
  await saveCustomPrompt(prompt, original && promptData(original));
}

async function deleteEntry(entry: PromptEntry): Promise<void> {
  if (entry.source === "default") {
    assertPromptUnchanged(
      getDefaultPrompts().find((item) => item.id === entry.id),
      promptData(entry),
    );
    saveDefaultPrompts(
      getDefaultPrompts().filter((item) => item.id !== entry.id),
    );
    return;
  }
  await deleteCustomPrompt(promptData(entry));
}

function getPanel(stack: HTMLElement, className: string): HTMLElement | null {
  return stack.querySelector(`.${className}`) as HTMLElement | null;
}

function removeEditorPanels(stack: HTMLElement): void {
  getPanel(stack, "claudero-prompt-editor-panel")?.remove();
  getPanel(stack, "claudero-icon-panel")?.remove();
}

function openIconPanel(
  stack: HTMLElement,
  currentIcon: PromptIcon | undefined,
  onSelect: (icon: PromptIcon) => void,
  anchorEl?: HTMLElement,
): void {
  const doc = stack.ownerDocument!;
  doc
    .querySelectorAll(".claudero-icon-picker-popup")
    .forEach((el) => el.remove());
  const picker = showIconPicker(doc, {
    compact: true,
    initialIcon: currentIcon,
    onSelect: (icon) => {
      onSelect(icon);
    },
    onClose: () => picker.remove(),
  });
  picker.classList.add("claudero-icon-picker-popup");
  picker.style.zIndex = "2147483646";
  if (anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const vw = doc.defaultView?.innerWidth ?? 800;
    const vh = doc.defaultView?.innerHeight ?? 800;
    const pickerW = 280;
    const scrollTop = doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
    const scrollLeft =
      doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
    let left = rect.left + scrollLeft;
    if (left + pickerW > vw - 8) left = vw - pickerW - 8 + scrollLeft;
    picker.style.left = `${Math.max(8, left)}px`;
    const spaceBelow = vh - rect.bottom - 8;
    if (spaceBelow > 180) {
      picker.style.top = `${rect.bottom + scrollTop + 6}px`;
    } else {
      picker.style.top = `${rect.top + scrollTop - 6}px`;
      picker.style.transform = "translateY(-100%)";
    }
  }
  doc.documentElement.appendChild(picker);
  const onOutside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (
      !picker.contains(t) &&
      t !== anchorEl &&
      !(t as HTMLElement)?.closest?.(".claudero-color-picker-active")
    ) {
      picker.remove();
      doc.removeEventListener("mousedown", onOutside, true);
    }
  };
  doc.addEventListener("mousedown", onOutside, true);
  onElementRemoved(
    picker,
    () => {
      picker.remove();
      doc.removeEventListener("mousedown", onOutside, true);
    },
    anchorEl || stack,
  );
}

function openEditorPanel(
  stack: HTMLElement,
  actions: PromptPopupActions,
  options: { prompt?: PromptEntry; onSaved: () => void },
): void {
  const doc = stack.ownerDocument!;
  removeEditorPanels(stack);
  const panel = createEl(doc, "div", "claudero-prompt-editor-panel");
  const controller = new AbortController();
  let selectedIcon: PromptIcon | undefined =
    options.prompt?.icon ?? randomPromptIcon();

  const header = createEl(doc, "div", "claudero-side-panel-header");
  const title = createEl(doc, "div", "claudero-side-panel-title");
  title.textContent = getString(
    options.prompt ? "prompt-edit" : "prompt-create-new",
  );
  const close = createEl(doc, "button", "claudero-panel-close");
  close.type = "button";
  close.appendChild(createSvg(doc, "x"));
  close.addEventListener("click", () => removeEditorPanels(stack));
  header.append(title, close);

  const body = createEl(doc, "div", "claudero-prompt-editor-body");
  const iconRow = createEl(doc, "div", "claudero-prompt-modal-icon-row");
  const iconButton = createEl(
    doc,
    "button",
    "claudero-prompt-modal-icon-button",
  );
  iconButton.type = "button";
  const iconPreview = createEl(
    doc,
    "div",
    "claudero-prompt-modal-icon-preview",
  );
  iconButton.appendChild(iconPreview);
  const iconCopy = createEl(doc, "div", "claudero-prompt-modal-icon-copy");
  const iconLabel = createEl(doc, "div", "claudero-prompt-modal-icon-label");
  iconLabel.textContent = getString("ui-icon");
  const iconHint = createEl(doc, "div", "claudero-prompt-modal-icon-hint");
  iconHint.textContent = getString("prompt-icon-hint");
  iconCopy.append(iconLabel, iconHint);
  iconRow.append(iconButton, iconCopy);

  function updateIconPreview(): void {
    while (iconPreview.firstChild) iconPreview.firstChild.remove();
    iconButton.classList.toggle("is-empty", !selectedIcon);
    if (selectedIcon) {
      renderPromptIcon(doc, selectedIcon, iconPreview);
      // Mirror the final prompt-list icon: tint the wrap with the icon's own color
      const color =
        selectedIcon.type === "iconify"
          ? selectedIcon.color || "#55534f"
          : "#55534f";
      iconPreview.style.backgroundColor = `color-mix(in srgb, ${color} 12%, transparent)`;
    } else {
      iconPreview.style.backgroundColor = "";
      iconPreview.appendChild(createSvg(doc, "plus"));
    }
  }
  updateIconPreview();
  iconButton.addEventListener("click", () =>
    openIconPanel(
      stack,
      selectedIcon,
      (icon) => {
        selectedIcon = icon;
        updateIconPreview();
      },
      iconButton,
    ),
  );

  const makeField = (
    labelText: string,
    input: HTMLInputElement | HTMLTextAreaElement,
    optional = false,
  ) => {
    const row = createEl(doc, "label", "claudero-prompt-field");
    const label = createEl(doc, "span", "claudero-prompt-field-label");
    label.textContent = labelText;
    if (optional) {
      const optionalEl = createEl(
        doc,
        "span",
        "claudero-prompt-field-optional",
      );
      optionalEl.textContent = getString("ui-optional");
      label.appendChild(optionalEl);
    }
    row.append(label, input);
    return row;
  };

  const nameInput = createEl(
    doc,
    "input",
    "claudero-prompt-input",
  ) as HTMLInputElement;
  nameInput.type = "text";
  nameInput.placeholder = getString("prompt-name-placeholder");
  nameInput.value = options.prompt?.label ?? "";
  nameInput.setAttribute("autocomplete", "off");
  const descInput = createEl(
    doc,
    "input",
    "claudero-prompt-input",
  ) as HTMLInputElement;
  descInput.type = "text";
  descInput.placeholder = getString("prompt-description-placeholder");
  descInput.value = options.prompt?.description ?? "";
  descInput.setAttribute("autocomplete", "off");
  const textInput = createEl(
    doc,
    "textarea",
    "claudero-prompt-textarea",
  ) as HTMLTextAreaElement;
  textInput.placeholder = getString("prompt-content-placeholder");
  textInput.value = options.prompt?.text ?? "";
  textInput.rows = 8;
  [nameInput, textInput].forEach((el) =>
    el.addEventListener("input", () => el.classList.remove("error")),
  );

  body.append(
    iconRow,
    makeField(getString("ui-name"), nameInput),
    makeField(getString("ui-description"), descInput, true),
    makeField(getString("ui-prompt"), textInput),
  );

  const footer = createEl(doc, "div", "claudero-prompt-modal-footer");
  const cancelBtn = createTbBtn(
    doc,
    "claudero-prompt-secondary-btn",
    getString("ui-cancel"),
    () => removeEditorPanels(stack),
  );
  const refineBtn = createTbBtn(
    doc,
    "claudero-prompt-secondary-btn",
    getString("prompt-optimize"),
    async () => {
      if (!actions.onRefinePrompt || refineBtn.hasAttribute("disabled")) return;
      refineBtn.setAttribute("disabled", "true");
      refineBtn.setAttribute("label", getString("prompt-refining"));
      if (refineBtn.localName !== "toolbarbutton")
        refineBtn.textContent = getString("prompt-refining");
      const draft = {
        label: nameInput.value,
        description: descInput.value,
        text: textInput.value,
      };
      try {
        const result = await actions.onRefinePrompt(
          {
            label: nameInput.value.trim(),
            description: descInput.value.trim(),
            text: textInput.value.trim(),
          },
          controller.signal,
        );
        if (!panel.isConnected) return;
        if (
          nameInput.value === draft.label &&
          typeof result.label === "string" &&
          result.label.trim()
        )
          nameInput.value = result.label.trim();
        if (
          descInput.value === draft.description &&
          typeof result.description === "string"
        )
          descInput.value = result.description.trim();
        if (
          textInput.value === draft.text &&
          typeof result.text === "string" &&
          result.text.trim()
        )
          textInput.value = result.text.trim();
        [nameInput, textInput].forEach((el) => el.classList.remove("error"));
      } catch (error) {
        if (panel.isConnected) showPromptError(body, error);
      } finally {
        refineBtn.removeAttribute("disabled");
        refineBtn.setAttribute("label", getString("prompt-optimize"));
        if (refineBtn.localName !== "toolbarbutton")
          refineBtn.textContent = getString("prompt-optimize");
      }
    },
  );
  const saveBtn = createTbBtn(
    doc,
    "claudero-prompt-primary-btn",
    getString("ui-save"),
    async () => {
      if (saveBtn.hasAttribute("disabled")) return;
      const label = nameInput.value.trim();
      const text = textInput.value.trim();
      if (!label) {
        nameInput.classList.add("error");
        nameInput.focus();
        return;
      }
      if (!text) {
        textInput.classList.add("error");
        textInput.focus();
        return;
      }
      const now = Date.now();
      saveBtn.setAttribute("disabled", "true");
      try {
        await saveEntry(
          {
            id: options.prompt?.id ?? `cp-${crypto.randomUUID()}`,
            source: options.prompt?.source ?? "custom",
            icon: selectedIcon,
            label,
            description:
              descInput.value.trim() ||
              text.split("\n")[0]?.trim().slice(0, 100),
            text,
            createdAt: options.prompt?.createdAt ?? now,
            updatedAt: now,
          },
          options.prompt,
        );
        if (!panel.isConnected) return;
        removeEditorPanels(stack);
        options.onSaved();
      } catch (error) {
        if (panel.isConnected) showPromptError(body, error);
      } finally {
        saveBtn.removeAttribute("disabled");
      }
    },
  );
  footer.append(cancelBtn);
  if (actions.onRefinePrompt) footer.append(refineBtn);
  footer.append(saveBtn);
  panel.append(header, body, footer);
  const library = getPanel(stack, "claudero-magic-popup");
  if (library) stack.insertBefore(panel, library);
  else stack.appendChild(panel);
  const focusTimer = setTimeout(() => {
    if (panel.isConnected) nameInput.focus();
  }, 30);
  onElementRemoved(panel, () => {
    clearTimeout(focusTimer);
    controller.abort();
  });
  void actions;
}

async function renderPromptList(
  stack: HTMLElement,
  popup: HTMLElement,
  actions: PromptPopupActions,
  query = popup.querySelector<HTMLInputElement>(".claudero-magic-search-input")
    ?.value || "",
): Promise<void> {
  const doc = popup.ownerDocument!;
  const list = popup.querySelector(
    ".claudero-magic-list",
  ) as HTMLElement | null;
  if (!list) return;
  const render = Symbol("prompt-list");
  promptRenders.set(popup, render);
  const current = () =>
    popup.isConnected &&
    stack.isConnected &&
    promptRenders.get(popup) === render;
  const normalized = query.trim().toLowerCase();
  let loading = promptLoads.get(popup);
  if (!loading) promptLoads.set(popup, (loading = loadEntries()));
  let loaded: PromptEntry[];
  try {
    loaded = await loading;
  } catch (error) {
    if (promptLoads.get(popup) === loading) promptLoads.delete(popup);
    if (current()) {
      list.textContent = "";
      showPromptError(list, error);
    }
    return;
  }
  if (!current()) return;
  list.textContent = "";
  const refresh = () => {
    promptLoads.delete(popup);
    void renderPromptList(stack, popup, actions);
  };
  const entries = loaded.filter((entry) => {
    const haystack =
      `${entry.label} ${entry.description ?? ""} ${entry.text}`.toLowerCase();
    return !normalized || haystack.includes(normalized);
  });
  if (!entries.length) {
    const empty = createEl(doc, "div", "claudero-magic-empty");
    empty.textContent = normalized
      ? getString("prompt-no-match")
      : getString("prompt-empty");
    list.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = createEl(doc, "div", "claudero-magic-row");
    const main = createEl(doc, "button", "claudero-magic-row-main");
    main.type = "button";
    main.addEventListener("click", () => {
      closePromptSurfaces(stack.ownerDocument!.documentElement as HTMLElement);
      if (entry.id === "default-insert-note") actions.onInsertNote();
      else actions.onPrompt(entry.text);
    });
    const icon = createEl(doc, "div", "claudero-prompt-icon-wrap");
    renderIcon(doc, entry, icon);
    // Tint icon background with its own color
    const iconColor =
      entry.icon?.type === "iconify"
        ? entry.icon.color || "#55534f"
        : "#55534f";
    icon.style.backgroundColor = `color-mix(in srgb, ${iconColor} 12%, transparent)`;
    const copy = createEl(doc, "div", "claudero-prompt-copy");
    const title = createEl(doc, "div", "claudero-prompt-title");
    title.textContent = entry.label;
    const desc = createEl(doc, "div", "claudero-prompt-desc");
    desc.textContent = fallbackDescription(entry);
    copy.append(title, desc);
    main.append(icon, copy);
    row.addEventListener("mouseenter", () => {
      row.style.backgroundColor = `color-mix(in srgb, ${iconColor} 8%, var(--material-mix-quinary))`;
    });
    row.addEventListener("mouseleave", () => {
      row.style.backgroundColor = "";
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      doc.querySelectorAll(".claudero-row-ctx-menu").forEach((m) => m.remove());
      const menu = createEl(doc, "div", "claudero-row-ctx-menu");
      menu.style.position = "absolute";
      menu.style.zIndex = "2147483647";
      const editItem = createEl(doc, "button", "claudero-ctx-item");
      editItem.appendChild(createSvg(doc, "edit"));
      const editLabel = createEl(doc, "span", "");
      editLabel.textContent = getString("ui-edit");
      editItem.append(editLabel);
      editItem.addEventListener("click", () => {
        menu.remove();
        openEditorPanel(stack, actions, {
          prompt: entry,
          onSaved: refresh,
        });
      });
      const removeItem = createEl(doc, "button", "claudero-ctx-item danger");
      removeItem.appendChild(createSvg(doc, "trash"));
      const removeLabel = createEl(doc, "span", "");
      removeLabel.textContent = getString("prompt-delete");
      removeItem.append(removeLabel);
      removeItem.addEventListener("click", async () => {
        menu.remove();
        try {
          await deleteEntry(entry);
          if (stack.isConnected) refresh();
        } catch (error) {
          if (stack.isConnected) showPromptError(list, error);
        }
      });
      menu.append(editItem, removeItem);
      doc.documentElement.appendChild(menu);
      const scrollTop =
        doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
      const scrollLeft =
        doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
      const margin = 8;
      const offset = 6;
      const rect = menu.getBoundingClientRect();
      const win = doc.defaultView!;
      const left = Math.min(
        e.clientX + offset,
        win.innerWidth - rect.width - margin,
      );
      const top = Math.min(
        e.clientY + offset,
        win.innerHeight - rect.height - margin,
      );
      menu.style.left = `${Math.max(margin, left) + scrollLeft}px`;
      menu.style.top = `${Math.max(margin, top) + scrollTop}px`;
      const dismiss = (ev: MouseEvent) => {
        if (!menu.contains(ev.target as Node)) {
          menu.remove();
          doc.removeEventListener("mousedown", dismiss, true);
        }
      };
      doc.addEventListener("mousedown", dismiss, true);
      onElementRemoved(
        menu,
        () => {
          menu.remove();
          doc.removeEventListener("mousedown", dismiss, true);
        },
        stack,
      );
    });
    row.append(main);
    list.appendChild(row);
  }
}

export function showPromptPopup(
  state: PromptPopupState,
  anchor: HTMLElement,
  actions: PromptPopupActions,
): void {
  const doc = state.root.ownerDocument!;
  const existing = doc.querySelector(".claudero-magic-stack");
  if (existing) {
    closePromptSurfaces(doc.documentElement as HTMLElement);
    return;
  }
  closePromptSurfaces(doc.documentElement as HTMLElement);
  const stack = createEl(doc, "div", "claudero-magic-stack");
  const popup = createEl(doc, "div", "claudero-magic-popup");
  const header = createEl(doc, "div", "claudero-magic-header");
  const title = createEl(doc, "div", "claudero-magic-title");
  title.textContent = getString("prompt-library");
  const addBtn = createEl(doc, "button", "claudero-magic-add-btn");
  addBtn.type = "button";
  addBtn.setAttribute("aria-label", getString("prompt-create-new"));
  addBtn.appendChild(createSvg(doc, "plus"));
  header.append(title);
  const searchRow = createEl(doc, "div", "claudero-magic-search-row");
  const search = createEl(doc, "div", "claudero-magic-search");
  search.appendChild(createSvg(doc, "search"));
  const searchInput = createEl(
    doc,
    "input",
    "claudero-magic-search-input",
  ) as HTMLInputElement;
  searchInput.type = "search";
  searchInput.placeholder = getString("prompt-search-placeholder");
  searchInput.setAttribute("autocomplete", "off");
  search.append(searchInput);
  searchRow.append(search, addBtn);
  const list = createEl(doc, "div", "claudero-magic-list");
  popup.append(header, searchRow, list);
  stack.appendChild(popup);
  addBtn.addEventListener("click", () =>
    openEditorPanel(stack, actions, {
      onSaved: () => {
        promptLoads.delete(popup);
        void renderPromptList(stack, popup, actions, searchInput.value);
      },
    }),
  );
  searchInput.addEventListener(
    "input",
    () => void renderPromptList(stack, popup, actions, searchInput.value),
  );
  doc.documentElement.appendChild(stack);
  const anchorRect = anchor.getBoundingClientRect();
  const viewportHeight =
    doc.defaultView?.innerHeight ?? anchorRect.bottom + 260;
  const viewportWidth = doc.defaultView?.innerWidth ?? anchorRect.right;
  stack.style.bottom = `${Math.max(18, viewportHeight - anchorRect.top + 10)}px`;
  stack.style.right = `${Math.max(8, viewportWidth - anchorRect.right)}px`;
  void renderPromptList(stack, popup, actions);
  const focusTimer = setTimeout(() => {
    if (stack.isConnected) searchInput.focus();
  }, 20);
  const onOutside = (event: Event) => {
    const target = event.target as Node;
    if (
      !stack.contains(target) &&
      target !== anchor &&
      !(target as HTMLElement)?.closest?.(
        ".claudero-color-picker-active, .claudero-icon-picker-popup, .claudero-row-ctx-menu",
      )
    ) {
      closePromptSurfaces(doc.documentElement as HTMLElement);
      doc.removeEventListener("mousedown", onOutside, true);
    }
  };
  doc.addEventListener("mousedown", onOutside, true);
  onElementRemoved(
    stack,
    () => {
      clearTimeout(focusTimer);
      doc.removeEventListener("mousedown", onOutside, true);
      stack.remove();
    },
    state.root,
  );
}

import type { CustomPrompt, PromptIcon } from "./conversationStore";
import { showIconPicker, renderPromptIcon } from "./iconPickerView";
import { getString } from "../utils/locale";
import { onElementRemoved } from "./elementLifecycle";

export interface PromptEditorOptions {
  prompt?: CustomPrompt;
  onSave: (prompt: CustomPrompt) => void;
  onCancel: () => void;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(XHTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  return el;
}

function setFieldError(el: HTMLElement, hasError: boolean): void {
  el.classList.toggle("error", hasError);
  el.setAttribute("aria-invalid", hasError ? "true" : "false");
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function renderIconPreview(
  doc: Document,
  icon: PromptIcon | undefined,
  container: HTMLElement,
): void {
  while (container.firstChild) container.firstChild.remove();
  if (!icon) {
    container.textContent = "+";
    return;
  }
  renderPromptIcon(doc, icon, container);
}

export function showPromptEditor(
  doc: Document,
  options: PromptEditorOptions,
): HTMLElement {
  const modal = createEl(doc, "div", "claudero-prompt-editor-modal");
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");

  let closed = false;
  let activePicker: HTMLElement | null = null;

  const close = (kind: "save" | "cancel") => {
    if (closed) return;
    closed = true;
    activePicker?.remove();
    modal.remove();
    if (kind === "cancel") options.onCancel();
  };

  const backdrop = createEl(doc, "div", "claudero-prompt-editor-backdrop");
  backdrop.addEventListener("click", () => close("cancel"));

  const card = createEl(doc, "div", "claudero-prompt-editor-card");

  // ── Header ──
  const header = createEl(doc, "div", "claudero-prompt-editor-header");
  const title = createEl(doc, "h3", "claudero-prompt-editor-title");
  title.textContent = options.prompt
    ? getString("prompt-edit")
    : getString("prompt-create");
  const closeBtn = createEl(doc, "button", "claudero-prompt-editor-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", getString("ui-close"));
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => close("cancel"));
  header.append(title, closeBtn);
  card.appendChild(header);

  // ── Body ──
  const body = createEl(doc, "div", "claudero-prompt-editor-body");

  // Icon row
  const iconRow = createEl(doc, "div", "claudero-prompt-editor-icon-row");
  const iconBtn = createEl(doc, "button", "claudero-prompt-editor-icon-btn");
  iconBtn.type = "button";
  iconBtn.setAttribute("aria-label", getString("prompt-choose-icon"));
  // Force square dimensions — CSS alone may be overridden by the UA stylesheet
  const forceSquare = (el: HTMLElement, px: string) => {
    for (const prop of [
      "width",
      "height",
      "min-width",
      "max-width",
      "min-height",
      "max-height",
    ] as const)
      el.style.setProperty(prop, px, "important");
    el.style.setProperty("aspect-ratio", "1 / 1", "important");
    el.style.setProperty("flex-shrink", "0", "important");
    el.style.setProperty("overflow", "hidden", "important");
    el.style.setProperty("box-sizing", "border-box", "important");
  };
  forceSquare(iconBtn, "48px");
  const iconContent = createEl(doc, "div", "claudero-prompt-editor-icon");
  let selectedIcon: PromptIcon | undefined = options.prompt?.icon;
  const updatePreview = () => {
    if (selectedIcon) iconBtn.classList.remove("empty");
    else iconBtn.classList.add("empty");
    renderIconPreview(doc, selectedIcon, iconContent);
  };
  updatePreview();
  iconBtn.appendChild(iconContent);

  const iconTextWrap = createEl(doc, "div", "claudero-prompt-editor-icon-copy");
  const iconLabel = createEl(doc, "div", "claudero-prompt-editor-icon-label");
  iconLabel.textContent = getString("ui-icon");
  const iconHint = createEl(doc, "div", "claudero-prompt-editor-icon-hint");
  iconHint.textContent = getString("ui-optional");
  iconTextWrap.append(iconLabel, iconHint);
  iconRow.append(iconBtn, iconTextWrap);

  iconBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activePicker?.remove();
    activePicker = showIconPicker(doc, {
      compact: true,
      onSelect: (icon) => {
        selectedIcon = icon;
        updatePreview();
        activePicker?.remove();
        activePicker = null;
      },
      onClose: () => {
        activePicker?.remove();
        activePicker = null;
      },
    });
    activePicker.classList.add("claudero-prompt-editor-floating-picker");
    const rect = iconBtn.getBoundingClientRect();
    const vw = doc.defaultView?.innerWidth ?? 800;
    const vh = doc.defaultView?.innerHeight ?? 800;
    const pickerWidth = Math.min(280, vw - 16);
    activePicker.style.width = `${pickerWidth}px`;
    const scrollTop = doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
    const scrollLeft =
      doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
    const left = Math.min(
      Math.max(8, rect.left + scrollLeft),
      vw - pickerWidth - 8 + scrollLeft,
    );
    activePicker.style.left = `${left}px`;
    activePicker.style.transform = "";
    const spaceBelow = vh - rect.bottom - 8;
    if (spaceBelow > 180) {
      activePicker.style.top = `${rect.bottom + scrollTop + 6}px`;
    } else {
      activePicker.style.top = `${rect.top + scrollTop - 6}px`;
      activePicker.style.transform = "translateY(-100%)";
    }
    doc.documentElement.appendChild(activePicker);
    const onOutside = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (
        !activePicker?.contains(t) &&
        t !== iconBtn &&
        !(t as HTMLElement)?.closest?.(".claudero-color-picker-active")
      ) {
        activePicker?.remove();
        activePicker = null;
        doc.removeEventListener("mousedown", onOutside, true);
      }
    };
    doc.addEventListener("mousedown", onOutside, true);
    const picker = activePicker;
    onElementRemoved(
      picker,
      () => {
        picker.remove();
        doc.removeEventListener("mousedown", onOutside, true);
      },
      modal,
    );
  });

  // Name field
  const nameId = makeId("claudero-prompt-name");
  const descId = makeId("claudero-prompt-desc");
  const contentId = makeId("claudero-prompt-content");

  const nameRow = createEl(doc, "div", "claudero-prompt-editor-row");
  const nameLabel = createEl(doc, "label", "claudero-prompt-editor-label");
  nameLabel.textContent = getString("ui-name");
  nameLabel.setAttribute("for", nameId);
  const nameInput = createEl(
    doc,
    "input",
    "claudero-prompt-editor-input",
  ) as HTMLInputElement;
  nameInput.id = nameId;
  nameInput.type = "text";
  nameInput.placeholder = getString("prompt-name-placeholder");
  nameInput.value = options.prompt?.label ?? "";
  nameInput.setAttribute("autocomplete", "off");
  nameInput.addEventListener("input", () => setFieldError(nameInput, false));
  nameRow.append(nameLabel, nameInput);

  // Description field
  const descRow = createEl(doc, "div", "claudero-prompt-editor-row");
  const descLabel = createEl(doc, "label", "claudero-prompt-editor-label");
  descLabel.textContent = getString("ui-description");
  descLabel.setAttribute("for", descId);
  const descOptional = createEl(
    doc,
    "span",
    "claudero-prompt-editor-label-muted",
  );
  descOptional.textContent = getString("ui-optional");
  descLabel.appendChild(descOptional);
  const descInput = createEl(
    doc,
    "input",
    "claudero-prompt-editor-input",
  ) as HTMLInputElement;
  descInput.id = descId;
  descInput.type = "text";
  descInput.placeholder = getString("prompt-description-placeholder");
  descInput.value = options.prompt?.description ?? "";
  descInput.setAttribute("autocomplete", "off");
  descRow.append(descLabel, descInput);

  // Prompt content field
  const contentRow = createEl(doc, "div", "claudero-prompt-editor-row");
  const contentLabel = createEl(doc, "label", "claudero-prompt-editor-label");
  contentLabel.textContent = getString("ui-prompt");
  contentLabel.setAttribute("for", contentId);
  const contentTextarea = createEl(
    doc,
    "textarea",
    "claudero-prompt-editor-textarea",
  ) as HTMLTextAreaElement;
  contentTextarea.id = contentId;
  contentTextarea.placeholder = getString("prompt-content-placeholder");
  contentTextarea.rows = 8;
  contentTextarea.value = options.prompt?.text ?? "";
  contentTextarea.addEventListener("input", () => {
    setFieldError(contentTextarea, false);
    if (!descInput.value.trim()) {
      const firstLine = contentTextarea.value
        .split("\n")[0]
        ?.trim()
        .slice(0, 60);
      descInput.placeholder =
        firstLine || getString("prompt-description-placeholder");
    }
  });
  contentRow.append(contentLabel, contentTextarea);

  body.append(iconRow, nameRow, descRow, contentRow);
  card.appendChild(body);

  // ── Footer ──
  const footer = createEl(doc, "div", "claudero-prompt-editor-footer");

  const cancelBtn = createEl(
    doc,
    "button",
    "claudero-button claudero-prompt-editor-btn-secondary",
  );
  cancelBtn.type = "button";
  cancelBtn.textContent = getString("ui-cancel");
  cancelBtn.addEventListener("click", () => close("cancel"));

  const saveBtn = createEl(
    doc,
    "button",
    "claudero-button claudero-button-primary claudero-prompt-editor-btn-primary",
  );
  saveBtn.type = "button";
  saveBtn.textContent = getString("ui-save");

  const save = () => {
    const label = nameInput.value.trim();
    const text = contentTextarea.value.trim();
    const nameInvalid = !label;
    const textInvalid = !text;

    setFieldError(nameInput, nameInvalid);
    setFieldError(contentTextarea, textInvalid);

    if (nameInvalid) {
      nameInput.focus();
      return;
    }
    if (textInvalid) {
      contentTextarea.focus();
      return;
    }

    const description =
      descInput.value.trim() || text.split("\n")[0]?.trim().slice(0, 100) || "";
    const prompt: CustomPrompt = options.prompt
      ? {
          ...options.prompt,
          icon: selectedIcon,
          label,
          description,
          text,
          updatedAt: Date.now(),
        }
      : {
          id: `cp-${Date.now()}`,
          icon: selectedIcon,
          label,
          description,
          text,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

    closed = true;
    activePicker?.remove();
    modal.remove();
    options.onSave(prompt);
  };

  saveBtn.addEventListener("click", save);
  footer.append(cancelBtn, saveBtn);
  card.appendChild(footer);

  modal.append(backdrop, card);

  // ── Keyboard ──
  const onKeyDown = (event: KeyboardEvent) => {
    if (!modal.isConnected) {
      doc.removeEventListener("keydown", onKeyDown, true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (activePicker) {
        activePicker.remove();
        activePicker = null;
        return;
      }
      doc.removeEventListener("keydown", onKeyDown, true);
      close("cancel");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  };
  doc.addEventListener("keydown", onKeyDown, true);

  const focusTimer = setTimeout(() => {
    try {
      if (closed || !modal.isConnected) return;
      nameInput.focus();
    } catch {
      /* */
    }
  }, 50);
  onElementRemoved(modal, () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    clearTimeout(focusTimer);
    close("cancel");
  });

  return modal;
}

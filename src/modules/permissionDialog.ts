import { getPref } from "../utils/prefs";
import { createToolIconSvg } from "./toolCallRenderer";

export interface PermissionDialogState {
  root: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  running: boolean;
  permissionDialog: HTMLElement | null;
  questionDialog: HTMLElement | null;
  _savedComposerChildren: { chips: HTMLElement | null; inputEl: HTMLElement | null; toolbar: HTMLElement | null } | null;
}

export interface QuestionDialogState {
  root: HTMLElement;
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  running: boolean;
  questionDialog: HTMLElement | null;
  _savedComposerChildren: { chips: HTMLElement | null; inputEl: HTMLElement | null; toolbar: HTMLElement | null } | null;
}

export interface PermissionRequestView {
  id: string;
  toolName: string;
  input: unknown;
}

function createEl<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  return el;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Right-pointing focus arrow (→) shown beside the focused option.
function createAskArrowSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.classList.add("claudero-ask-arrow-svg");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2.5 8 H11 M7.5 4.5 L11.5 8 L7.5 11.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

// Real checkbox button with a tick SVG; shown/hidden via .is-checked in CSS.
function createAskCheckbox(doc: Document, checked: boolean): HTMLElement {
  const box = createEl(doc, "span", "claudero-ask-check claudero-ask-checkbox" + (checked ? " is-checked" : ""));
  const svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
  svg.classList.add("claudero-ask-checkbox-tick");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3.5 8.5 L6.5 11.5 L12.5 4.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  box.appendChild(svg);
  return box;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function permissionCopy(request: PermissionRequestView): { title: string; description: string; preview: string; danger: boolean } {
  const input = recordValue(request.input);
  const action = typeof input?.action === "string" ? input.action : "";
  const explicit = typeof input?.description === "string" ? input.description : "";
  const command = typeof input?.command === "string" ? input.command : "";
  const danger = /write|create|set|undo|delete|remove|erase/i.test(request.toolName + " " + action);
  return {
    title: danger ? "Approve Zotero change" : "Approve tool action",
    description: explicit || (danger ? "Claudero wants to modify your Zotero data. Review the details before allowing it." : "Claudero needs permission to continue this tool action."),
    preview: command || JSON.stringify(request.input, null, 2),
    danger,
  };
}

async function readHelperToken(): Promise<string> {
  const tokenPath = [Zotero.Profile.dir, "claudero", "helper", ".token"].join("/");
  try { return (await (IOUtils as any).readUTF8(tokenPath)).trim(); } catch { return ""; }
}

function nextFrame(doc: Document, callback: FrameRequestCallback): void {
  const win = doc.defaultView;
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(callback);
    return;
  }
  setTimeout(() => callback(0), 0);
}

function restoreComposerChildren(state: PermissionDialogState): void {
  const saved = state._savedComposerChildren;
  if (!saved) return;
  if (saved.chips) saved.chips.style.display = "";
  if (saved.inputEl) saved.inputEl.style.display = "";
  if (saved.toolbar) saved.toolbar.style.display = "";
  state._savedComposerChildren = null;
}

export function hidePermissionDialog(state: PermissionDialogState): void {
  if (!state.permissionDialog) return;
  state.permissionDialog.remove();
  state.permissionDialog = null;
  restoreComposerChildren(state);
  if (!state.running) { state.input.disabled = false; state.sendButton.disabled = false; state.input.focus(); }
}

export function showPermissionDialog(state: PermissionDialogState, request: PermissionRequestView): void {
  if (state.permissionDialog) {
    if (state.permissionDialog.getAttribute("data-request-id") === request.id) return;
    state.permissionDialog.remove(); state.permissionDialog = null;
  }
  const doc = state.root.ownerDocument!;
  const composer = state.root.querySelector(".claudero-composer") as HTMLElement | null;
  if (!composer) return;
  const chips = composer.querySelector(".claudero-context-chips") as HTMLElement | null;
  const inputEl = composer.querySelector(".claudero-input") as HTMLElement | null;
  const toolbar = composer.querySelector(".claudero-composer-toolbar") as HTMLElement | null;
  state._savedComposerChildren = { chips, inputEl, toolbar };
  if (chips) chips.style.display = "none";
  if (inputEl) inputEl.style.display = "none";
  if (toolbar) toolbar.style.display = "none";
  const copy = permissionCopy(request);
  const dialog = createEl(doc, "div", "claudero-permission-dialog modern" + (copy.danger ? " danger" : ""));
  dialog.setAttribute("data-request-id", request.id);
  const header = createEl(doc, "div", "claudero-permission-header");
  const iconWrap = createEl(doc, "span", "claudero-permission-icon");
  iconWrap.appendChild(createToolIconSvg(doc, request.toolName));
  const headerText = createEl(doc, "div", "claudero-permission-heading");
  const title = createEl(doc, "span", "claudero-permission-title");
  title.textContent = copy.title;
  const toolName = createEl(doc, "span", "claudero-permission-toolname");
  toolName.textContent = request.toolName;
  headerText.append(title, toolName);
  header.append(iconWrap, headerText);
  const description = createEl(doc, "div", "claudero-permission-description");
  description.textContent = copy.description;
  const preview = createEl(doc, "div", "claudero-permission-preview");
  const previewText = copy.preview.length > 1200 ? copy.preview.slice(0, 1200) + "..." : copy.preview;
  preview.innerHTML = "<code>" + escapeHtml(previewText) + "</code>";
  const rememberRow = createEl(doc, "label", "claudero-permission-remember");
  const remember = createEl(doc, "input", "") as HTMLInputElement;
  remember.type = "checkbox";
  const rememberText = createEl(doc, "span", "");
  rememberText.textContent = "Always allow similar actions this session";
  rememberRow.append(remember, rememberText);
  const buttons = createEl(doc, "div", "claudero-permission-buttons");
  const denyBtn = createEl(doc, "button", "claudero-button claudero-button-secondary");
  denyBtn.textContent = "Deny";
  const allowBtn = createEl(doc, "button", "claudero-button claudero-button-primary");
  allowBtn.textContent = copy.danger ? "Allow change" : "Allow";
  const handleDecision = async (allowed: boolean) => {
    denyBtn.setAttribute("disabled", "true"); allowBtn.setAttribute("disabled", "true");
    try {
      const port = Number(getPref("helperPort") || 38660);
      const token = await readHelperToken();
      const response = await fetch("http://127.0.0.1:" + port + "/permission", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: request.id, allowed, remember: remember.checked }) });
      if (!response.ok) throw new Error("Permission request was not accepted.");
      hidePermissionDialog(state);
    } catch {
      denyBtn.removeAttribute("disabled"); allowBtn.removeAttribute("disabled");
    }
  };
  denyBtn.addEventListener("click", () => void handleDecision(false));
  allowBtn.addEventListener("click", () => void handleDecision(true));
  buttons.append(denyBtn, allowBtn);
  dialog.append(header, description, preview, rememberRow, buttons);
  composer.appendChild(dialog);
  state.permissionDialog = dialog;
  state.input.disabled = true; state.sendButton.disabled = true;
  allowBtn.focus();
}

export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
  value?: string;
}

export interface AskUserQuestionItem {
  id?: string;
  question: string;
  header: string;
  multiSelect: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options: AskUserQuestionOption[];
}

export interface PendingQuestion {
  toolUseId: string;
  questions: AskUserQuestionItem[];
}

export interface PendingExitPlan {
  toolUseId: string;
  input: Record<string, unknown>;
}

function normalizeQuestionItem(value: unknown, index: number): AskUserQuestionItem {
  const record = recordValue(value);
  const question = typeof record?.question === "string" && record.question.trim()
    ? record.question.trim()
    : `Question ${index + 1}`;
  const header = typeof record?.header === "string" ? record.header.trim() : "";
  const multiSelect = record?.multiSelect === true;
  const rawOptions = Array.isArray(record?.options) ? record.options : [];
  const options = rawOptions.map((raw): AskUserQuestionOption | null => {
    if (typeof raw === "string") {
      const label = raw.trim();
      return label ? { label, description: "" } : null;
    }
    const opt = recordValue(raw);
    if (!opt) return null;
    const label = typeof opt.label === "string" ? opt.label.trim() : "";
    if (!label) return null;
    return {
      label,
      description: typeof opt.description === "string" ? opt.description.trim() : "",
      preview: typeof opt.preview === "string" ? opt.preview : undefined,
      value: typeof opt.value === "string" ? opt.value : undefined,
    };
  }).filter((opt): opt is AskUserQuestionOption => !!opt);
  return {
    id: typeof record?.id === "string" ? record.id : undefined,
    question,
    header,
    multiSelect,
    isOther: record?.isOther !== false,
    isSecret: record?.isSecret === true,
    options,
  };
}

function getQuestionKey(question: AskUserQuestionItem): string {
  return question.id || question.question;
}

function getOptionValue(option: AskUserQuestionOption): string {
  return option.value || option.label;
}

function selectedAnswerCount(
  question: AskUserQuestionItem,
  selectedAnswers: Map<string, string[]>,
  otherValue: string | undefined,
  otherSelected: boolean,
): number {
  const selected = selectedAnswers.get(getQuestionKey(question)) || [];
  const hasOther = otherSelected && !!otherValue?.trim();
  return question.multiSelect ? selected.length + (hasOther ? 1 : 0) : (hasOther ? 1 : selected.length);
}

function getAnswerText(
  question: AskUserQuestionItem,
  selectedAnswers: Map<string, string[]>,
  otherValue: string | undefined,
  otherSelected: boolean,
): string {
  const selected = selectedAnswers.get(getQuestionKey(question)) || [];
  const selectedLabels = question.options
    .filter((option) => selected.includes(getOptionValue(option)))
    .map((option) => option.label);
  const other = otherSelected ? otherValue?.trim() || "" : "";
  return [...selectedLabels, other].filter(Boolean).join(", ");
}

function saveComposerChildren(state: QuestionDialogState, composer: HTMLElement): void {
  const chips = composer.querySelector(".claudero-context-chips") as HTMLElement | null;
  const inputEl = composer.querySelector(".claudero-input") as HTMLElement | null;
  const toolbar = composer.querySelector(".claudero-composer-toolbar") as HTMLElement | null;
  state._savedComposerChildren = { chips, inputEl, toolbar };
  if (chips) chips.style.display = "none";
  if (inputEl) inputEl.style.display = "none";
  if (toolbar) toolbar.style.display = "none";
}

function restoreQuestionComposerChildren(state: QuestionDialogState): void {
  const saved = state._savedComposerChildren;
  if (!saved) return;
  if (saved.chips) saved.chips.style.display = "";
  if (saved.inputEl) saved.inputEl.style.display = "";
  if (saved.toolbar) saved.toolbar.style.display = "";
  state._savedComposerChildren = null;
}

export function hideQuestionDialog(state: QuestionDialogState): void {
  if (!state.questionDialog) return;
  state.questionDialog.remove();
  state.questionDialog = null;
  restoreQuestionComposerChildren(state);
  if (!state.running) { state.input.disabled = false; state.sendButton.disabled = false; state.input.focus(); }
}

export function showQuestionDialog(state: QuestionDialogState, pending: PendingQuestion): void {
  if (state.questionDialog) {
    if (state.questionDialog.getAttribute("data-tool-use-id") === pending.toolUseId) return;
    state.questionDialog.remove();
    state.questionDialog = null;
  }
  const doc = state.root.ownerDocument!;
  const composer = state.root.querySelector(".claudero-composer") as HTMLElement | null;
  if (!composer) return;

  const questions = (Array.isArray(pending.questions) ? pending.questions : [])
    .map((q, index) => normalizeQuestionItem(q, index));
  if (questions.length === 0) return;

  if (!state._savedComposerChildren) saveComposerChildren(state, composer);
  const otherValues = questions.map(() => "");
  const otherSelected = questions.map(() => false);
  let activeTabIndex = 0;
  let focusedItemIndex = 0;
  let inputFocused = false;
  let isSubmitting = false;
  const submitIndex = questions.length;
  const dialog = createEl(doc, "div", "claudero-question-dialog modern claudero-ask-inline");
  dialog.setAttribute("data-dialog-kind", "question");
  dialog.setAttribute("data-tool-use-id", pending.toolUseId);
  dialog.setAttribute("tabindex", "0");

  const title = createEl(doc, "div", "claudero-ask-inline-title");
  title.textContent = "Question";
  dialog.appendChild(title);

  const selectedAnswers: Map<string, string[]> = new Map();
  for (const q of questions) selectedAnswers.set(getQuestionKey(q), []);

  const tabBar = createEl(doc, "div", "claudero-question-tabbar");
  const content = createEl(doc, "div", "claudero-question-content");

  const allAnswered = () => questions.every((q, index) => selectedAnswerCount(q, selectedAnswers, otherValues[index], otherSelected[index]) > 0);
  const isQuestionAnswered = (index: number) => selectedAnswerCount(questions[index], selectedAnswers, otherValues[index], otherSelected[index]) > 0;
  const canShowOther = (question: AskUserQuestionItem) => question.isOther !== false;
  const activeQuestion = () => questions[Math.max(0, Math.min(activeTabIndex, questions.length - 1))];
  const maxFocusIndex = () => {
    if (activeTabIndex === submitIndex) return 1;
    const q = activeQuestion();
    const extra = canShowOther(q) ? 1 : 0;
    return Math.max(0, q.options.length + extra - 1);
  };
  const clampFocus = () => {
    focusedItemIndex = Math.max(0, Math.min(focusedItemIndex, maxFocusIndex()));
  };

  const buildAnswers = (): { answers: Record<string, string | string[]>; freeformResponse?: string } => {
    const answers: Record<string, string | string[]> = {};
    let freeformResponse: string | undefined;
    questions.forEach((q, index) => {
      const questionKey = getQuestionKey(q);
      const selected = selectedAnswers.get(questionKey) || [];
      const otherVal = otherSelected[index] ? otherValues[index]?.trim() || "" : "";
      if (q.multiSelect) {
        const values = [...selected];
        if (otherVal) values.push(otherVal);
        answers[questionKey] = values;
        if (otherVal) freeformResponse = otherVal;
        return;
      }
      answers[questionKey] = otherVal || selected[0] || "";
      if (otherVal) freeformResponse = otherVal;
    });
    return { answers, freeformResponse };
  };

  const renderTabs = () => {
    tabBar.replaceChildren();
    questions.forEach((question, index) => {
      const tab = createEl(doc, "button", "claudero-question-tab");
      tab.type = "button";
      tab.classList.toggle("active", activeTabIndex === index);
      tab.classList.toggle("answered", isQuestionAnswered(index));
      tab.title = question.question;
      const label = createEl(doc, "span", "claudero-question-tab-label");
      label.textContent = question.header || `Q${index + 1}`;
      tab.appendChild(label);
      if (isQuestionAnswered(index)) {
        const tick = createEl(doc, "span", "claudero-question-tab-tick");
        tick.textContent = "✓";
        tab.appendChild(tick);
      }
      tab.addEventListener("click", () => {
        activeTabIndex = index;
        focusedItemIndex = 0;
        inputFocused = false;
        renderContent();
        dialog.focus();
      });
      tabBar.appendChild(tab);
    });
    const reviewTab = createEl(doc, "button", "claudero-question-tab review");
    reviewTab.type = "button";
    reviewTab.classList.toggle("active", activeTabIndex === submitIndex);
    reviewTab.classList.toggle("answered", allAnswered());
    if (allAnswered()) {
      const check = createEl(doc, "span", "claudero-question-tab-tick");
      check.textContent = "✓";
      reviewTab.appendChild(check);
    }
    const label = createEl(doc, "span", "claudero-question-tab-label");
    label.textContent = "Submit";
    reviewTab.appendChild(label);
    reviewTab.addEventListener("click", () => {
      activeTabIndex = submitIndex;
      focusedItemIndex = 0;
      inputFocused = false;
      renderContent();
      dialog.focus();
    });
    tabBar.appendChild(reviewTab);
  };

  const setFocusedItem = (index: number) => {
    focusedItemIndex = Math.max(0, Math.min(index, maxFocusIndex()));
    content.querySelectorAll(".claudero-ask-item").forEach((item, itemIndex) => {
      const el = item as HTMLElement;
      const focused = itemIndex === focusedItemIndex;
      el.classList.toggle("is-focused", focused);
      const cursor = el.querySelector(".claudero-ask-cursor");
      if (cursor) cursor.classList.toggle("is-active", focused);
      if (focused) el.scrollIntoView({ block: "nearest" });
    });
  };

  const renderCheck = (row: HTMLElement, checked: boolean) => {
    row.appendChild(createAskCheckbox(doc, checked));
  };

  const renderItemShell = (index: number, extraClass = "") => {
    const row = createEl(doc, "div", `claudero-ask-item${extraClass ? " " + extraClass : ""}`);
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "-1");
    row.classList.toggle("is-focused", focusedItemIndex === index);
    const cursor = createEl(doc, "span", "claudero-ask-cursor" + (focusedItemIndex === index ? " is-active" : ""));
    cursor.appendChild(createAskArrowSvg(doc));
    const number = createEl(doc, "span", "claudero-ask-item-num");
    number.textContent = `${index + 1}. `;
    row.append(cursor, number);
    row.addEventListener("mouseenter", () => {
      focusedItemIndex = index;
      setFocusedItem(index);
    });
    return row;
  };

  const selectOption = (questionItem: AskUserQuestionItem, questionIndex: number, option: AskUserQuestionOption) => {
    const questionKey = getQuestionKey(questionItem);
    const optionValue = getOptionValue(option);
    const current = selectedAnswers.get(questionKey) || [];
    if (questionItem.multiSelect) {
      if (current.includes(optionValue)) {
        selectedAnswers.set(questionKey, current.filter((v) => v !== optionValue));
      } else {
        selectedAnswers.set(questionKey, [...current, optionValue]);
      }
    } else {
      selectedAnswers.set(questionKey, [optionValue]);
      otherValues[questionIndex] = "";
      otherSelected[questionIndex] = false;
    }
    if (!questionItem.multiSelect) {
      activeTabIndex = Math.min(activeTabIndex + 1, submitIndex);
      focusedItemIndex = 0;
      inputFocused = false;
      renderContent();
      dialog.focus();
      return;
    }
    renderContent();
    dialog.focus();
  };

  const toggleOther = (questionItem: AskUserQuestionItem, questionIndex: number, force?: boolean) => {
    const hasText = !!otherValues[questionIndex]?.trim();
    if (!hasText) {
      otherSelected[questionIndex] = false;
      renderTabs();
      return;
    }
    otherSelected[questionIndex] = force ?? !otherSelected[questionIndex];
    if (!questionItem.multiSelect && otherSelected[questionIndex]) {
      selectedAnswers.set(getQuestionKey(questionItem), []);
    }
    renderContent();
    dialog.focus();
  };

  const renderQuestion = (questionItem: AskUserQuestionItem, index: number) => {
    const block = createEl(doc, "div", "claudero-question-block");
    const qtext = createEl(doc, "div", "claudero-question-text");
    qtext.textContent = questionItem.question;
    block.appendChild(qtext);

    const list = createEl(doc, "div", "claudero-ask-list");
    questionItem.options.forEach((opt, optIndex) => {
      const questionKey = getQuestionKey(questionItem);
      const optionValue = getOptionValue(opt);
      const selected = selectedAnswers.get(questionKey) || [];
      const isSelected = selected.includes(optionValue);
      const row = renderItemShell(optIndex, isSelected ? "is-selected" : "");
      if (questionItem.multiSelect) renderCheck(row, isSelected);
      const body = createEl(doc, "span", "claudero-ask-item-content");
      const labelRow = createEl(doc, "span", "claudero-ask-label-row");
      const label = createEl(doc, "span", "claudero-ask-item-label");
      label.textContent = opt.label;
      labelRow.appendChild(label);
      if (!questionItem.multiSelect && isSelected) {
        const check = createEl(doc, "span", "claudero-ask-check-mark");
        check.textContent = " ✓";
        labelRow.appendChild(check);
      }
      body.appendChild(labelRow);
      if (opt.description) {
        const desc = createEl(doc, "span", "claudero-ask-item-desc");
        desc.textContent = opt.description;
        body.appendChild(desc);
      }
      row.appendChild(body);
      row.addEventListener("click", () => {
        focusedItemIndex = optIndex;
        selectOption(questionItem, index, opt);
      });
      list.appendChild(row);
    });

    if (canShowOther(questionItem)) {
      const otherIndex = questionItem.options.length;
      const isOtherSelected = otherSelected[index] && !!otherValues[index]?.trim();
      const otherRow = renderItemShell(otherIndex, `claudero-ask-custom-item${isOtherSelected ? " is-selected" : ""}`);
      if (questionItem.multiSelect) renderCheck(otherRow, isOtherSelected);
      const otherInput = createEl(doc, "input", "claudero-question-other-input claudero-ask-custom-text") as HTMLInputElement;
      otherInput.type = questionItem.isSecret ? "password" : "text";
      otherInput.placeholder = questionItem.isSecret ? "Enter secret." : "Type something.";
      otherInput.value = otherValues[index] || "";
      otherInput.addEventListener("input", () => {
        otherValues[index] = otherInput.value;
        otherSelected[index] = !!otherInput.value.trim();
        if (otherSelected[index] && !questionItem.multiSelect) {
          selectedAnswers.set(getQuestionKey(questionItem), []);
          list.querySelectorAll(".claudero-ask-item:not(.claudero-ask-custom-item)").forEach((item) => {
            item.classList.remove("is-selected");
            item.querySelector(".claudero-ask-check-mark")?.remove();
          });
        }
        otherRow.classList.toggle("is-selected", otherSelected[index]);
        const check = otherRow.querySelector(".claudero-ask-check");
        if (check) {
          check.classList.toggle("is-checked", otherSelected[index]);
        }
        renderTabs();
      });
      otherInput.addEventListener("focus", () => {
        inputFocused = true;
        focusedItemIndex = otherIndex;
        setFocusedItem(otherIndex);
      });
      otherInput.addEventListener("blur", () => {
        inputFocused = false;
      });
      otherRow.addEventListener("click", (event) => {
        focusedItemIndex = otherIndex;
        setFocusedItem(otherIndex);
        if (event.target !== otherInput && questionItem.multiSelect && otherValues[index]?.trim()) {
          toggleOther(questionItem, index);
          return;
        }
        otherInput.focus();
      });
      otherRow.appendChild(otherInput);
      list.appendChild(otherRow);
    }
    block.appendChild(list);
    const hints = createEl(doc, "div", "claudero-ask-hints");
    hints.textContent = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
    block.appendChild(hints);
    return block;
  };

  const renderReview = () => {
    const review = createEl(doc, "div", "claudero-question-review");
    const title = createEl(doc, "div", "claudero-question-review-title");
    title.textContent = "Review your answers";
    review.appendChild(title);
    questions.forEach((question, index) => {
      const row = createEl(doc, "div", "claudero-question-review-row");
      row.setAttribute("role", "button");
      const num = createEl(doc, "span", "claudero-question-review-num");
      num.textContent = `${index + 1}.`;
      const body = createEl(doc, "span", "claudero-question-review-body");
      const q = createEl(doc, "span", "claudero-question-review-question");
      q.textContent = question.question;
      const a = createEl(doc, "span", "claudero-question-review-answer");
      const answerText = getAnswerText(question, selectedAnswers, otherValues[index], otherSelected[index]);
      a.textContent = answerText || "Not answered";
      if (!answerText) a.classList.add("empty");
      body.append(q, a);
      row.append(num, body);
      row.addEventListener("click", () => {
        activeTabIndex = index;
        focusedItemIndex = 0;
        renderContent();
        dialog.focus();
      });
      review.appendChild(row);
    });

    const prompt = createEl(doc, "div", "claudero-question-review-prompt");
    prompt.textContent = "Ready to submit your answers?";
    review.appendChild(prompt);

    const actions = createEl(doc, "div", "claudero-ask-list");
    const submitRow = renderItemShell(0, allAnswered() ? "" : "is-disabled");
    const submitLabel = createEl(doc, "span", "claudero-ask-item-label");
    submitLabel.textContent = "Submit answers";
    submitRow.appendChild(submitLabel);
    submitRow.addEventListener("click", () => {
      focusedItemIndex = 0;
      setFocusedItem(0);
      void submitAnswers();
    });
    const cancelRow = renderItemShell(1);
    const cancelLabel = createEl(doc, "span", "claudero-ask-item-label");
    cancelLabel.textContent = "Cancel";
    cancelRow.appendChild(cancelLabel);
    cancelRow.addEventListener("click", () => {
      focusedItemIndex = 1;
      setFocusedItem(1);
      void cancelQuestion();
    });
    actions.append(submitRow, cancelRow);
    review.appendChild(actions);

    const hints = createEl(doc, "div", "claudero-ask-hints");
    hints.textContent = "Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
    review.appendChild(hints);
    return review;
  };

  const renderContent = () => {
    content.replaceChildren();
    clampFocus();
    if (activeTabIndex >= questions.length) {
      content.appendChild(renderReview());
    } else {
      content.appendChild(renderQuestion(questions[activeTabIndex], activeTabIndex));
    }
    renderTabs();
  };

  const submitAnswers = async () => {
    if (!allAnswered() || isSubmitting) return;
    isSubmitting = true;
    content.querySelectorAll(".claudero-ask-item").forEach((item) => item.classList.add("is-disabled"));
    const { answers, freeformResponse } = buildAnswers();
    try {
      const port = Number(getPref("helperPort") || 38660);
      const token = await readHelperToken();
      const response = await fetch("http://127.0.0.1:" + port + "/answer-question", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ toolUseId: pending.toolUseId, answers, response: freeformResponse }),
      });
      if (!response.ok) throw new Error("Question answer was not accepted.");
      hideQuestionDialog(state);
    } catch {
      isSubmitting = false;
      renderContent();
    }
  };

  const cancelQuestion = async () => {
    try {
      const port = Number(getPref("helperPort") || 38660);
      const token = await readHelperToken();
      await fetch("http://127.0.0.1:" + port + "/cancel-question", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
    } finally {
      hideQuestionDialog(state);
    }
  };

  dialog.addEventListener("keydown", (event) => {
    if (inputFocused) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        inputFocused = false;
        (doc.activeElement as HTMLElement | null)?.blur();
        dialog.focus();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        inputFocused = false;
        (doc.activeElement as HTMLElement | null)?.blur();
        activeTabIndex = event.key === "Tab" && event.shiftKey
          ? Math.max(0, activeTabIndex - 1)
          : Math.min(submitIndex, activeTabIndex + 1);
        focusedItemIndex = 0;
        renderContent();
        dialog.focus();
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        (doc.activeElement as HTMLElement | null)?.blur();
        inputFocused = false;
        setFocusedItem(event.key === "ArrowUp" ? focusedItemIndex - 1 : focusedItemIndex + 1);
        dialog.focus();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setFocusedItem(focusedItemIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setFocusedItem(focusedItemIndex - 1);
      return;
    }
    if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      activeTabIndex = Math.min(submitIndex, activeTabIndex + 1);
      focusedItemIndex = 0;
      renderContent();
      return;
    }
    if (event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      activeTabIndex = Math.max(0, activeTabIndex - 1);
      focusedItemIndex = 0;
      renderContent();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void cancelQuestion();
      return;
    }

    const number = Number(event.key);
    if (Number.isInteger(number) && number > 0 && number <= maxFocusIndex() + 1) {
      event.preventDefault();
      event.stopPropagation();
      focusedItemIndex = number - 1;
      setFocusedItem(focusedItemIndex);
      if (activeTabIndex === submitIndex) {
        if (focusedItemIndex === 0) void submitAnswers();
        else void cancelQuestion();
        return;
      }
      const q = questions[activeTabIndex];
      if (focusedItemIndex < q.options.length) {
        selectOption(q, activeTabIndex, q.options[focusedItemIndex]);
      } else {
        const input = content.querySelector(".claudero-ask-custom-text") as HTMLInputElement | null;
        if (q.multiSelect && otherValues[activeTabIndex]?.trim()) {
          toggleOther(q, activeTabIndex);
        } else {
          input?.focus();
        }
      }
      return;
    }

    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (activeTabIndex === submitIndex) {
      if (focusedItemIndex === 0) void submitAnswers();
      else void cancelQuestion();
      return;
    }
    const q = questions[activeTabIndex];
    if (focusedItemIndex < q.options.length) {
      selectOption(q, activeTabIndex, q.options[focusedItemIndex]);
      return;
    }
    const input = content.querySelector(".claudero-ask-custom-text") as HTMLInputElement | null;
    if (q.multiSelect && otherValues[activeTabIndex]?.trim()) {
      toggleOther(q, activeTabIndex);
      return;
    }
    input?.focus();
  });

  renderContent();
  dialog.append(tabBar, content);
  composer.appendChild(dialog);
  state.questionDialog = dialog;
  state.input.disabled = true;
  state.sendButton.disabled = true;
  nextFrame(doc, () => {
    dialog.focus();
    dialog.scrollIntoView({ block: "nearest" });
  });
}

function getExitPlanPreview(input: Record<string, unknown>): string {
  const plan = typeof input.plan === "string" ? input.plan : "";
  const content = typeof input.planContent === "string" ? input.planContent : "";
  const message = typeof input.message === "string" ? input.message : "";
  const summary = typeof input.summary === "string" ? input.summary : "";
  return (plan || content || message || summary || "").trim();
}

export function showExitPlanDialog(state: QuestionDialogState, pending: PendingExitPlan): void {
  if (state.questionDialog) {
    if (state.questionDialog.getAttribute("data-tool-use-id") === pending.toolUseId) return;
    state.questionDialog.remove();
    state.questionDialog = null;
  }
  const doc = state.root.ownerDocument!;
  const composer = state.root.querySelector(".claudero-composer") as HTMLElement | null;
  if (!composer) return;
  if (!state._savedComposerChildren) saveComposerChildren(state, composer);

  const dialog = createEl(doc, "div", "claudero-question-dialog modern claudero-exit-plan-dialog");
  dialog.setAttribute("data-dialog-kind", "exit-plan");
  dialog.setAttribute("data-tool-use-id", pending.toolUseId);
  dialog.setAttribute("tabindex", "0");

  let focusedIndex = 0;
  let inputFocused = false;
  let isPosting = false;
  const items: HTMLElement[] = [];

  const title = createEl(doc, "div", "claudero-plan-inline-title");
  title.textContent = "Plan ready";
  dialog.appendChild(title);

  const previewText = getExitPlanPreview(pending.input);
  if (previewText) {
    const preview = createEl(doc, "div", "claudero-exit-plan-preview");
    preview.textContent = previewText.length > 1600 ? previewText.slice(0, 1600) + "..." : previewText;
    dialog.appendChild(preview);
  }

  const allowedPrompts = Array.isArray(pending.input.allowedPrompts) ? pending.input.allowedPrompts : [];
  if (allowedPrompts.length > 0) {
    const perms = createEl(doc, "div", "claudero-exit-plan-permissions");
    const label = createEl(doc, "div", "claudero-question-header");
    label.textContent = "Requested permissions";
    perms.appendChild(label);
    for (const raw of allowedPrompts) {
      const record = recordValue(raw);
      const row = createEl(doc, "div", "claudero-exit-plan-permission");
      row.textContent = typeof record?.prompt === "string" ? record.prompt : JSON.stringify(raw);
      perms.appendChild(row);
    }
    dialog.appendChild(perms);
  }

  const actions = createEl(doc, "div", "claudero-ask-list");
  const feedback = createEl(doc, "input", "claudero-question-other-input claudero-ask-custom-text claudero-exit-plan-feedback") as HTMLInputElement;
  feedback.type = "text";
  feedback.placeholder = "Enter feedback to revise plan.";

  const updateFocus = () => {
    focusedIndex = Math.max(0, Math.min(focusedIndex, items.length - 1));
    items.forEach((item, index) => {
      const focused = index === focusedIndex;
      item.classList.toggle("is-focused", focused);
      const cursor = item.querySelector(".claudero-ask-cursor");
      if (cursor) cursor.classList.toggle("is-active", focused);
      if (focused) item.scrollIntoView({ block: "nearest" });
    });
  };

  const makeRow = (index: number, label: string, className = "") => {
    const row = createEl(doc, "div", `claudero-ask-item${className ? " " + className : ""}`);
    row.setAttribute("role", "button");
    const cursor = createEl(doc, "span", "claudero-ask-cursor" + (index === focusedIndex ? " is-active" : ""));
    cursor.appendChild(createAskArrowSvg(doc));
    const number = createEl(doc, "span", "claudero-ask-item-num");
    number.textContent = `${index + 1}. `;
    row.append(cursor, number);
    if (label) {
      const labelEl = createEl(doc, "span", "claudero-ask-item-label");
      labelEl.textContent = label;
      row.appendChild(labelEl);
    }
    row.addEventListener("mouseenter", () => {
      focusedIndex = index;
      updateFocus();
    });
    items[index] = row;
    return row;
  };

  const postDecision = async (decision: { type: "approve" } | { type: "approve-new-session"; planContent?: string } | { type: "feedback"; text: string }) => {
    if (isPosting) return;
    isPosting = true;
    actions.querySelectorAll(".claudero-ask-item").forEach((item) => item.classList.add("is-disabled"));
    try {
      const port = Number(getPref("helperPort") || 38660);
      const token = await readHelperToken();
      const response = await fetch("http://127.0.0.1:" + port + "/answer-exit-plan", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ toolUseId: pending.toolUseId, decision }),
      });
      if (!response.ok) throw new Error("Exit plan decision was not accepted.");
      hideQuestionDialog(state);
    } catch {
      isPosting = false;
      actions.querySelectorAll(".claudero-ask-item").forEach((item) => item.classList.remove("is-disabled"));
    }
  };

  const cancelExitPlan = async () => {
    try {
      const port = Number(getPref("helperPort") || 38660);
      const token = await readHelperToken();
      await fetch("http://127.0.0.1:" + port + "/cancel-exit-plan", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
      });
    } finally {
      hideQuestionDialog(state);
    }
  };

  const submitFeedback = () => {
    const text = feedback.value.trim();
    if (!text) {
      feedback.focus();
      return;
    }
    void postDecision({ type: "feedback", text });
  };

  const approveRow = makeRow(0, "Implement");
  approveRow.addEventListener("click", () => {
    focusedIndex = 0;
    updateFocus();
    void postDecision({ type: "approve" });
  });

  const feedbackRow = makeRow(1, "", "claudero-ask-custom-item");
  feedbackRow.appendChild(feedback);
  feedbackRow.addEventListener("click", () => {
    focusedIndex = 1;
    updateFocus();
    feedback.focus();
  });

  const cancelRow = makeRow(2, "Cancel");
  cancelRow.addEventListener("click", () => {
    focusedIndex = 2;
    updateFocus();
    void cancelExitPlan();
  });

  actions.append(approveRow, feedbackRow, cancelRow);

  feedback.addEventListener("focus", () => {
    inputFocused = true;
    focusedIndex = 1;
    updateFocus();
  });
  feedback.addEventListener("blur", () => {
    inputFocused = false;
  });
  feedback.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submitFeedback();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      inputFocused = false;
      feedback.blur();
      dialog.focus();
    }
  });

  dialog.addEventListener("keydown", (event) => {
    if (inputFocused) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      focusedIndex += 1;
      updateFocus();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      focusedIndex -= 1;
      updateFocus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      void cancelExitPlan();
      return;
    }
    const number = Number(event.key);
    if (Number.isInteger(number) && number >= 1 && number <= items.length) {
      event.preventDefault();
      event.stopPropagation();
      focusedIndex = number - 1;
      updateFocus();
      if (focusedIndex === 0) void postDecision({ type: "approve" });
      else if (focusedIndex === 1) feedback.focus();
      else void cancelExitPlan();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (focusedIndex === 0) void postDecision({ type: "approve" });
    else if (focusedIndex === 1) feedback.focus();
    else void cancelExitPlan();
  });

  const hints = createEl(doc, "div", "claudero-ask-hints");
  hints.textContent = "Arrow keys to navigate · Enter to select · Esc to cancel";
  dialog.append(actions, hints);
  composer.appendChild(dialog);
  state.questionDialog = dialog;
  state.input.disabled = true;
  state.sendButton.disabled = true;
  nextFrame(doc, () => {
    dialog.focus();
    dialog.scrollIntoView({ block: "nearest" });
  });
}

import { getString } from "../utils/locale";
import type { PaneState } from "./paneState";
import { normalizeProvider, providerLabel } from "./providerRegistry";
export function createEl<K extends keyof HTMLElementTagNameMap>(
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

export function isAtBottom(state: PaneState): boolean {
  const t = state.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}

export function updateScrollToBottomBtn(state: PaneState): void {
  if (!state.scrollToBottomBtn) return;
  state.scrollToBottomBtn.style.display = isAtBottom(state) ? "none" : "flex";
}

export function forceScrollToBottom(state: PaneState): void {
  state.transcript.scrollTop = state.transcript.scrollHeight;
  updateScrollToBottomBtn(state);
}

export function smoothScrollToBottom(state: PaneState): void {
  const el = state.transcript;
  const target = el.scrollHeight - el.clientHeight;
  const start = el.scrollTop;
  const distance = target - start;
  if (distance <= 0) return;

  const duration = Math.min(400, Math.max(200, distance * 0.5));
  const win = el.ownerDocument!.defaultView!;
  const startTime = win.performance.now();

  function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  function step(now: number): void {
    if (state.disposed) return;
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    el.scrollTop = start + distance * easeOutCubic(progress);
    if (progress < 1) {
      win.requestAnimationFrame(step);
    } else {
      updateScrollToBottomBtn(state);
    }
  }

  win.requestAnimationFrame(step);
}

export function scrollTranscript(state: PaneState): void {
  if (isAtBottom(state)) {
    state.transcript.scrollTop = state.transcript.scrollHeight;
  }
  updateScrollToBottomBtn(state);
}

export function setStatusDot(
  state: PaneState,
  mode: "ready" | "streaming" | "error",
): void {
  state.statusDot.className =
    `claudero-status-dot ${mode === "ready" ? "" : mode}`.trim();
  const label =
    mode === "ready"
      ? getString("pane-status-ready")
      : mode === "streaming"
        ? getString("pane-status-responding", {
            args: {
              agent: providerLabel(
                normalizeProvider(state.providerSelect.value),
              ),
            },
          })
        : getString("pane-status-failed");
  state.statusDot.setAttribute("title", label);
  state.statusDot.setAttribute("aria-label", label);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export const CHECK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
  <path d="M12.096 2.914a.7.7 0 0 1 1.134.772l-.069.125-6.25 9.166a.7.7 0 0 1-1.073.102l-3.75-3.75-.09-.11a.7.7 0 0 1 .97-.97l.11.09 3.153 3.152 5.774-8.469z"/>
</svg>`;

const REMOVE_X_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
  <line x1="18" y1="6" x2="6" y2="18"/>
  <line x1="6" y1="6" x2="18" y2="18"/>
</svg>`;

export function makeChipRemoveBtn(
  doc: Document,
  onClick: () => void,
): HTMLElement {
  const btn = createEl(doc, "button", "claudero-chip-remove");
  btn.setAttribute("tabindex", "-1");
  const wrapper = doc.createElement("div");
  wrapper.innerHTML = REMOVE_X_ICON_SVG.trim();
  const svg = wrapper.firstElementChild as SVGSVGElement;
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  btn.appendChild(svg);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    doc.querySelectorAll(".claudero-chip-tooltip").forEach((t) => t.remove());
    onClick();
  });
  return btn;
}

export function createToolbarLikeButton(
  doc: Document,
  className: string,
  title: string,
  onCommand: () => void,
): HTMLElement {
  const xulBtn = (
    doc as Document & { createXULElement?: (tag: string) => HTMLElement }
  ).createXULElement?.("toolbarbutton");
  const btn = (xulBtn ?? doc.createElement("button")) as HTMLElement;
  if (className) btn.className = className;
  btn.setAttribute("tooltiptext", title);
  btn.setAttribute("title", title);
  btn.setAttribute("aria-label", title);
  btn.setAttribute("tabindex", "-1");
  btn.addEventListener("command", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onCommand();
  });
  if (btn.localName !== "toolbarbutton") {
    (btn as HTMLButtonElement).type = "button";
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onCommand();
    });
  }
  return btn;
}

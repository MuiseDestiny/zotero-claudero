import {
  listConversations,
  renameConversation,
  subscribeConversationTitleChanges,
  type SavedConversation,
} from "./conversationStore";
import { getString } from "../utils/locale";

const popupCleanups = new WeakMap<Element, () => void>();

export interface ConversationHistoryViewState {
  root: HTMLElement;
  conversationId: string;
}

export interface ConversationHistoryHandlers {
  /** Restore the picked conversation into the chat view. */
  onRestore: (conversation: SavedConversation) => void;
  /** Delete the conversation from disk; the caller decides whether to start a new chat. */
  onDelete: (conversation: SavedConversation) => void | Promise<void>;
  /** Export the conversation to a user-selected JSON file. */
  onExport: (conversation: SavedConversation) => void | Promise<void>;
  /** Permanently remove every saved conversation. */
  onDeleteAll: () => void | Promise<void>;
  /** Ask Claude for a fresh title; resolves to the new title (already persisted) or null. */
  onAutoRename: (conversation: SavedConversation) => Promise<string | null>;
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

function createIconSvg(doc: Document, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  ) as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const RENAME_ICON = [
  "M12 20h9",
  "M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z",
];
const AUTO_ICON = [
  "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0Z",
  "M20 3v4",
  "M22 5h-4",
  "M4 17v2",
  "M5 18H3",
];
const DELETE_ICON = [
  "M3 6h18",
  "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  "M10 11v6",
  "M14 11v6",
];
const EXPORT_ICON = ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"];

// A toolbarbutton (with HTML <button> fallback) used for the per-row actions.
// Clicks never bubble to the row itself, so they can't trigger a restore.
function createActionButton(
  doc: Document,
  title: string,
  paths: string[],
  onCommand: () => void,
  extraClass?: string,
): HTMLElement {
  const xulBtn = (
    doc as Document & { createXULElement?: (tag: string) => HTMLElement }
  ).createXULElement?.("toolbarbutton");
  const btn = (xulBtn ?? doc.createElement("button")) as HTMLElement;
  btn.className =
    "claudero-history-action-btn" + (extraClass ? ` ${extraClass}` : "");
  btn.setAttribute("tooltiptext", title);
  btn.setAttribute("title", title);
  btn.setAttribute("aria-label", title);
  btn.setAttribute("tabindex", "-1");
  btn.appendChild(createIconSvg(doc, paths));
  const isToolbarButton = btn.localName === "toolbarbutton";
  ztoolkit.log(
    `[History] 创建按钮 "${title}" localName=${btn.localName} isToolbarButton=${isToolbarButton}`,
  );
  if (!isToolbarButton) {
    (btn as HTMLButtonElement).type = "button";
  }
  // Both `command` (XUL toolbarbutton) and `click` (HTML button / mouse events)
  // call onCommand. The per-action is-busy / is-editing guards prevent double-fire.
  const fire = (event: Event) => {
    ztoolkit.log(
      `[History] 按钮 "${title}" 触发 eventType=${event.type} phase=${event.eventPhase}`,
    );
    event.preventDefault();
    event.stopPropagation();
    onCommand();
  };
  btn.addEventListener("command", fire);
  btn.addEventListener("click", fire);
  btn.addEventListener("mousedown", (e) => {
    ztoolkit.log(
      `[History] 按钮 "${title}" mousedown target=${(e.target as Element)?.localName}`,
    );
    e.stopPropagation();
  });
  return btn;
}

export function showConversationHistoryPopup(
  state: ConversationHistoryViewState,
  handlers: ConversationHistoryHandlers,
): void {
  const doc = state.root.ownerDocument!;
  const existing = state.root.querySelector(".claudero-history-popup");
  if (existing) {
    popupCleanups.get(existing)?.();
    existing.remove();
    return;
  }

  const popup = createEl(doc, "div", "claudero-history-popup");
  const loading = createEl(doc, "div", "claudero-permission-desc");
  loading.style.padding = "10px";
  loading.textContent = getString("ui-loading");
  popup.appendChild(loading);
  state.root.appendChild(popup);

  const titleRows = new Map<
    string,
    {
      conv: SavedConversation;
      row: HTMLElement;
      name: HTMLElement;
      sub: HTMLElement;
    }
  >();
  let unsubscribeTitles = () => {};
  const cleanup = () => {
    doc.removeEventListener("mousedown", closePopup, true);
    unsubscribeTitles();
    popupCleanups.delete(popup);
  };
  const closePopup = (ev: MouseEvent) => {
    const inside = popup.contains(ev.target as Node);
    ztoolkit.log(
      `[History] document mousedown target=${(ev.target as Element)?.localName} insidePopup=${inside}`,
    );
    if (!inside) {
      popup.remove();
      cleanup();
    }
  };
  doc.addEventListener("mousedown", closePopup, true);

  const dismiss = () => {
    popup.remove();
    cleanup();
  };
  unsubscribeTitles = subscribeConversationTitleChanges((change) => {
    if (!popup.isConnected) {
      cleanup();
      return;
    }
    const target = titleRows.get(change.id);
    if (!target) return;
    target.conv.title = change.title;
    if (!target.row.classList.contains("is-editing")) {
      target.name.textContent = change.title;
      target.name.classList.remove("is-generating");
      target.row.classList.remove("has-rename-error");
    }
    ztoolkit.log(
      `[History] live title updated id=${change.id} source=${change.source} title=${JSON.stringify(change.title)}`,
    );
  });
  popupCleanups.set(popup, cleanup);

  void listConversations()
    .then((convs) => {
      if (!popup.isConnected) return;
      popup.textContent = "";

      const showEmpty = () => {
        const empty = createEl(doc, "div", "claudero-permission-desc");
        empty.style.padding = "10px";
        empty.textContent = getString("history-no-saved");
        popup.appendChild(empty);
      };

      if (convs.length === 0) {
        showEmpty();
        return;
      }

      let selectedRow: HTMLElement | null = null;
      for (const conv of convs.slice(0, 50)) {
        const row = createEl(doc, "div", "claudero-permission-row");
        const check = createEl(doc, "span", "claudero-permission-check");
        check.textContent = conv.id === state.conversationId ? "✓" : "";
        const info = createEl(doc, "div", "claudero-permission-info");
        const name = createEl(doc, "span", "claudero-permission-name");
        name.textContent = conv.title || getString("history-untitled");
        const sub = createEl(doc, "span", "claudero-permission-desc");
        sub.textContent = new Date(
          conv.updatedAt ?? conv.createdAt ?? Date.now(),
        ).toLocaleString();
        info.append(name, sub);

        // ── In-place rename ───────────────────────────────────────────────────
        const startRename = () => {
          ztoolkit.log(
            `[History] startRename called, is-editing=${row.classList.contains("is-editing")}`,
          );
          if (row.classList.contains("is-editing")) return;
          row.classList.add("is-editing");
          const input = createEl(doc, "input", "claudero-history-rename-input");
          input.type = "text";
          input.value = conv.title || "";
          info.replaceChild(input, name);
          input.focus();
          input.select();

          let settled = false;
          const finish = (commit: boolean) => {
            if (settled) return;
            settled = true;
            const next = input.value.replace(/\s+/g, " ").trim();
            if (input.parentNode === info) info.replaceChild(name, input);
            row.classList.remove("is-editing");
            if (commit && next && next !== conv.title) {
              const previousTitle = conv.title;
              conv.title = next;
              name.textContent = next;
              void renameConversation(conv.id, next).then((saved) => {
                if (saved || !name.isConnected) return;
                conv.title = previousTitle;
                name.textContent = previousTitle;
                sub.textContent = getString("history-rename-failed");
                row.classList.add("has-rename-error");
              });
            }
          };

          input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              ev.stopPropagation();
              finish(true);
            } else if (ev.key === "Escape") {
              ev.preventDefault();
              ev.stopPropagation();
              finish(false);
            }
          });
          input.addEventListener("blur", () => finish(true));
          // Don't let editing interactions reach the row.
          input.addEventListener("click", (ev) => ev.stopPropagation());
          input.addEventListener("mousedown", (ev) => ev.stopPropagation());
        };

        // ── Actions (shown on row hover) ──────────────────────────────────────
        const actions = createEl(doc, "div", "claudero-history-actions");
        const renameBtn = createActionButton(
          doc,
          getString("history-rename"),
          RENAME_ICON,
          startRename,
        );

        const autoBtn = createActionButton(
          doc,
          getString("history-ai-rename"),
          AUTO_ICON,
          () => {
            ztoolkit.log(
              `[History] AI重命名 called, is-busy=${autoBtn.classList.contains("is-busy")}`,
            );
            if (autoBtn.classList.contains("is-busy")) return;
            const previousTitle =
              name.textContent || conv.title || getString("history-untitled");
            const previousSub = sub.textContent || "";
            const startedAt = Date.now();
            row.classList.remove("has-rename-error");
            autoBtn.classList.add("is-busy");
            autoBtn.setAttribute("aria-busy", "true");
            autoBtn.setAttribute(
              "tooltiptext",
              getString("history-generating-title"),
            );
            autoBtn.setAttribute(
              "title",
              getString("history-generating-title"),
            );
            name.classList.add("is-generating");
            name.textContent = getString("history-generating-title");
            const timer = setInterval(() => {
              if (!name.isConnected) return;
              const seconds = Math.max(
                1,
                Math.floor((Date.now() - startedAt) / 1000),
              );
              sub.textContent = getString("history-using-haiku", {
                args: { seconds },
              });
            }, 1000);
            void Promise.resolve(handlers.onAutoRename(conv))
              .then((title) => {
                if (title && name.isConnected) {
                  conv.title = title;
                  name.textContent = title;
                  sub.textContent = previousSub;
                } else if (name.isConnected) {
                  const wasManuallyRenamed = conv.title !== previousTitle;
                  name.textContent = wasManuallyRenamed
                    ? conv.title
                    : previousTitle;
                  sub.textContent = wasManuallyRenamed
                    ? previousSub
                    : getString("history-title-failed");
                  row.classList.toggle("has-rename-error", !wasManuallyRenamed);
                }
              })
              .catch((error: unknown) => {
                const detail =
                  error instanceof Error
                    ? `${error.name}: ${error.message}${error.stack ? ` | ${error.stack.replace(/\s+/g, " ").slice(0, 1400)}` : ""}`
                    : String(error);
                ztoolkit.log(`[History] AI rename UI caught: ${detail}`);
                if (!name.isConnected) return;
                const wasManuallyRenamed = conv.title !== previousTitle;
                name.textContent = wasManuallyRenamed
                  ? conv.title
                  : previousTitle;
                sub.textContent = wasManuallyRenamed
                  ? previousSub
                  : `失败：${
                      error instanceof Error
                        ? `${error.name}${error.message ? ` · ${error.message}` : ""}`
                        : String(error)
                    }`.slice(0, 120);
                row.classList.toggle("has-rename-error", !wasManuallyRenamed);
              })
              .finally(() => {
                clearInterval(timer);
                autoBtn.classList.remove("is-busy");
                autoBtn.removeAttribute("aria-busy");
                autoBtn.setAttribute(
                  "tooltiptext",
                  getString("history-ai-rename"),
                );
                autoBtn.setAttribute("title", getString("history-ai-rename"));
                name.classList.remove("is-generating");
              });
          },
        );

        const exportBtn = createActionButton(
          doc,
          getString("history-export"),
          EXPORT_ICON,
          () => {
            if (exportBtn.classList.contains("is-busy")) return;
            exportBtn.classList.add("is-busy");
            void Promise.resolve(handlers.onExport(conv))
              .catch((error: unknown) => {
                sub.textContent =
                  error instanceof Error ? error.message : String(error);
                row.classList.add("has-rename-error");
              })
              .finally(() => exportBtn.classList.remove("is-busy"));
          },
        );

        const deleteBtn = createActionButton(
          doc,
          getString("history-delete-permanently"),
          DELETE_ICON,
          () => {
            ztoolkit.log(
              `[History] 删除 called, is-busy=${deleteBtn.classList.contains("is-busy")}`,
            );
            if (deleteBtn.classList.contains("is-busy")) return;
            const confirmed = doc.defaultView?.confirm(
              getString("history-delete-confirm", {
                args: { title: conv.title || getString("history-untitled") },
              }),
            );
            if (!confirmed) return;
            deleteBtn.classList.add("is-busy");
            void Promise.resolve(handlers.onDelete(conv))
              .then(() => {
                row.remove();
                if (!popup.querySelector(".claudero-permission-row"))
                  showEmpty();
              })
              .catch((error: unknown) => {
                sub.textContent =
                  error instanceof Error ? error.message : String(error);
                row.classList.add("has-rename-error");
              })
              .finally(() => deleteBtn.classList.remove("is-busy"));
          },
          "is-danger",
        );

        actions.append(renameBtn, autoBtn, exportBtn, deleteBtn);

        row.append(check, info, actions);
        titleRows.set(conv.id, { conv, row, name, sub });
        row.addEventListener("click", () => {
          if (
            row.classList.contains("is-editing") ||
            autoBtn.classList.contains("is-busy")
          )
            return;
          dismiss();
          handlers.onRestore(conv);
        });
        if (conv.id === state.conversationId) selectedRow = row;
        popup.appendChild(row);
      }

      const footer = createEl(doc, "div", "claudero-history-footer");
      const deleteAll = createEl(doc, "button", "claudero-history-delete-all");
      deleteAll.type = "button";
      deleteAll.append(createIconSvg(doc, DELETE_ICON));
      deleteAll.append(getString("history-delete-all"));
      deleteAll.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (deleteAll.disabled) return;
        const confirmed = doc.defaultView?.confirm(
          getString("history-delete-all-confirm"),
        );
        if (!confirmed) return;
        deleteAll.disabled = true;
        void Promise.resolve(handlers.onDeleteAll())
          .then(() => {
            popup.textContent = "";
            showEmpty();
          })
          .catch((error: unknown) => {
            deleteAll.disabled = false;
            deleteAll.textContent =
              error instanceof Error ? error.message : String(error);
          });
      });
      footer.appendChild(deleteAll);
      popup.appendChild(footer);

      if (selectedRow) {
        popup.scrollTop =
          selectedRow.offsetTop -
          popup.clientHeight / 2 +
          selectedRow.offsetHeight / 2;
      }
    })
    .catch((error: unknown) => {
      if (!popup.isConnected) return;
      loading.textContent = getString("history-load-failed", {
        args: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      loading.classList.add("error");
    });
}

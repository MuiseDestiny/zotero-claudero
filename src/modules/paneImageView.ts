import { getString } from "../utils/locale";
import { type ConversationImage } from "./conversationStore";
import {
  appendImageFiles,
  IMAGE_LIMITS,
  readImageDataURL,
  replaceImageDraft,
} from "./imageDraft";
import { createEl, makeChipRemoveBtn } from "./paneDom";
import { appendNoticeCard } from "./paneServiceNotices";
import { type PaneState, type PendingImage } from "./paneState";

// Composer attachments and previews; reads remain guarded by imageDraft.
// ── Image paste / preview ──────────────────────────────────────────────────

export async function addPastedImageFiles(
  state: PaneState,
  files: Blob[],
): Promise<void> {
  const win = state.root.ownerDocument!.defaultView as Window & {
    FileReader: typeof FileReader;
  };
  const applied = await appendImageFiles(state, files, {
    read: (file, signal) => readImageDataURL(file, signal, win.FileReader),
    onLimit: (reason) =>
      appendNoticeCard(
        state,
        "warning",
        getString(
          reason === "count"
            ? "pane-image-limit-title"
            : "pane-image-size-title",
        ),
        reason === "count"
          ? getString("pane-image-limit-description", {
              args: { count: IMAGE_LIMITS.count },
            })
          : getString("pane-image-size-description"),
      ),
  });
  if (applied) renderPendingImages(state);
}

export function imageDataUrl(image: ConversationImage): string {
  return image.dataUrl || `data:${image.mediaType};base64,${image.data}`;
}

// Remove any orphaned hover previews. Needed because removing a thumbnail mid-
// hover (clicking its ×) detaches the element before mouseleave can fire.
function removeAllImagePreviews(state: PaneState): void {
  state.root
    .querySelectorAll(".claudero-img-preview")
    .forEach((el) => el.remove());
}

// Floating large preview shown beside the hovered thumbnail.
export function attachImagePreview(
  state: PaneState,
  el: HTMLElement,
  dataUrl: string,
): void {
  const doc = state.root.ownerDocument!;
  let preview: HTMLElement | null = null;
  const hide = () => {
    preview?.remove();
    preview = null;
  };
  el.addEventListener("mouseenter", () => {
    hide();
    const win = doc.defaultView as Window;
    preview = createEl(doc, "div", "claudero-img-preview");
    const big = doc.createElement("img") as HTMLImageElement;
    big.src = dataUrl;
    preview.appendChild(big);
    preview.style.position = "fixed";
    preview.style.visibility = "hidden";
    state.root.appendChild(preview);

    const place = () => {
      if (!preview) return;
      const thumb = el.getBoundingClientRect();
      const pw = preview.offsetWidth;
      const ph = preview.offsetHeight;
      const gap = 8;
      // Prefer to the left of the thumb (the pane hugs the right screen edge);
      // fall back to the right, then clamp inside the viewport.
      let left = thumb.left - pw - gap;
      if (left < gap) left = thumb.right + gap;
      left = Math.min(left, win.innerWidth - pw - gap);
      left = Math.max(gap, left);
      let top = thumb.top + thumb.height / 2 - ph / 2;
      top = Math.max(gap, Math.min(top, win.innerHeight - ph - gap));
      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
      preview.style.visibility = "visible";
    };

    if (big.complete) place();
    else big.addEventListener("load", place, { once: true });
    place();
  });
  el.addEventListener("mouseleave", hide);
}

function ensurePendingImagesBar(state: PaneState): HTMLElement {
  if (state.pendingImagesBar && state.pendingImagesBar.isConnected) {
    return state.pendingImagesBar;
  }
  const doc = state.root.ownerDocument!;
  const composer = state.root.querySelector(
    ".claudero-composer",
  ) as HTMLElement;
  const bar = createEl(doc, "div", "claudero-pending-images");
  composer.insertBefore(bar, state.input);
  state.pendingImagesBar = bar;
  return bar;
}

export function renderPendingImages(state: PaneState): void {
  const bar = ensurePendingImagesBar(state);
  removeAllImagePreviews(state);
  bar.textContent = "";
  if (state.pendingImages.length === 0) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  const doc = state.root.ownerDocument!;
  for (const img of state.pendingImages) {
    const thumb = createEl(doc, "div", "claudero-img-thumb");
    const imgEl = doc.createElement("img") as HTMLImageElement;
    const dataUrl = imageDataUrl(img);
    imgEl.src = dataUrl;
    thumb.appendChild(imgEl);
    attachImagePreview(state, thumb, dataUrl);
    thumb.appendChild(
      makeChipRemoveBtn(doc, () => {
        replaceImageDraft(
          state,
          state.pendingImages.filter((i) => i.id !== img.id),
        );
        renderPendingImages(state);
      }),
    );
    bar.appendChild(thumb);
  }
}

export function cloneImages(images?: ConversationImage[]): PendingImage[] {
  return (images || []).map((img) => ({ ...img }));
}

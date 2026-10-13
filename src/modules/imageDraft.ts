import type { ConversationImage } from "./conversationStore";
import {
  captureConversationGuard,
  type ConversationGenerationState,
} from "./conversationTransition";
import { throwIfAborted } from "../shared/helperStream";

const reads = new WeakMap<object, Set<AbortController>>();
export const IMAGE_LIMITS = {
  count: 8,
  perFile: 10 * 1024 * 1024,
  total: 24 * 1024 * 1024,
};
const supportedTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Image data survives conversation changes in input history; bound retained text too. */
export function trimInputHistory(
  entries: Array<{ text: string; images: ConversationImage[] }>,
  maxCharacters = 32 * 1024 * 1024,
): void {
  let characters = 0;
  let keep = 0;
  for (const entry of entries.slice(0, 50)) {
    const size =
      entry.text.length +
      entry.images.reduce((sum, image) => sum + image.data.length, 0);
    // Always allow recalling the latest input, including a maximum-size paste.
    if (keep > 0 && characters + size > maxCharacters) break;
    characters += size;
    keep++;
  }
  entries.length = keep;
}

export function cancelImageReads(state: object): void {
  for (const controller of reads.get(state) || []) controller.abort();
  reads.delete(state);
}

export function replaceImageDraft(
  state: { pendingImages?: ConversationImage[] },
  images: ConversationImage[] = [],
): void {
  cancelImageReads(state);
  state.pendingImages = images;
}

export function readImageDataURL(
  file: Blob,
  signal: AbortSignal,
  Reader = FileReader,
): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      reader.onload = reader.onerror = reader.onabort = null;
    };
    const abort = () => {
      cleanup();
      reader.abort();
      reject(new DOMException("Image read cancelled", "AbortError"));
    };
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result || ""));
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error);
    };
    reader.onabort = abort;
    signal.addEventListener("abort", abort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** Commit only to the draft that initiated the read, rechecking shared quotas after IO. */
export async function appendImageFiles(
  state: ConversationGenerationState & { pendingImages: ConversationImage[] },
  files: Blob[],
  options: {
    read: (file: Blob, signal: AbortSignal) => Promise<string>;
    onLimit: (reason: "count" | "size") => void;
    limits?: typeof IMAGE_LIMITS;
  },
): Promise<boolean> {
  const target = state.pendingImages;
  const guard = captureConversationGuard(state);
  const controller = new AbortController();
  const active = () =>
    !controller.signal.aborted && guard() && state.pendingImages === target;
  if (!active()) return false;
  let pending = reads.get(state);
  if (!pending) reads.set(state, (pending = new Set()));
  pending.add(controller);
  const limits = options.limits || IMAGE_LIMITS;
  const totalBytes = () =>
    target.reduce(
      (sum, image) =>
        sum +
        Math.floor((image.data.length * 3) / 4) -
        (image.data.match(/=+$/)?.[0].length || 0),
      0,
    );
  const limit = (size: number): "count" | "size" | undefined =>
    target.length >= limits.count
      ? "count"
      : size > limits.perFile || totalBytes() + size > limits.total
        ? "size"
        : undefined;
  try {
    for (const file of files) {
      if (!active()) return false;
      if (!supportedTypes.has(file.type)) continue;
      const before = limit(file.size);
      if (before) {
        options.onLimit(before);
        if (before === "count") break;
        continue;
      }
      try {
        const dataUrl = await options.read(file, controller.signal);
        if (!active()) return false;
        const after = limit(file.size);
        if (after) {
          options.onLimit(after);
          if (after === "count") break;
          continue;
        }
        const comma = dataUrl.indexOf(",");
        const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        if (!data) continue;
        target.push({
          id: `img-${crypto.randomUUID()}`,
          mediaType: file.type,
          data,
        });
      } catch {
        if (!active()) return false;
        // Unreadable clipboard files do not prevent the remaining images.
      }
    }
    return active();
  } finally {
    pending.delete(controller);
    if (!pending.size && reads.get(state) === pending) reads.delete(state);
  }
}

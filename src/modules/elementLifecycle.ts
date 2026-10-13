interface RemovalWatch {
  callbacks: Set<(force?: boolean) => void>;
  dispose(): void;
}

const watches = new WeakMap<Document, RemovalWatch>();

/** Release external resources when a view (or any ancestor) is removed.
 * One shared observer per document avoids an observer for every popup/control.
 * Synchronous reparenting is allowed: connectivity is checked after mutations.
 */
export function onElementRemoved(
  element: Element,
  cleanup: () => void,
  owner?: Element,
): () => void {
  const doc = element.ownerDocument!;
  const win = doc.defaultView!;
  let watch = watches.get(doc);
  if (!watch) {
    const callbacks = new Set<(force?: boolean) => void>();
    const check = () => {
      for (const callback of [...callbacks]) callback();
    };
    const observer = new (
      win as Window & { MutationObserver: typeof MutationObserver }
    ).MutationObserver(check);
    const unload = () => {
      for (const callback of [...callbacks]) callback(true);
    };
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    win.addEventListener("unload", unload);
    watch = {
      callbacks,
      dispose: () => {
        observer.disconnect();
        win.removeEventListener("unload", unload);
        watches.delete(doc);
      },
    };
    watches.set(doc, watch);
  }
  const currentWatch = watch;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    currentWatch.callbacks.delete(check);
    if (!currentWatch.callbacks.size) currentWatch.dispose();
    cleanup();
  };
  const check = (force = false) => {
    if (
      force ||
      !element.isConnected ||
      (owner && !owner.isConnected) ||
      win.closed
    )
      dispose();
  };
  currentWatch.callbacks.add(check);
  return dispose;
}

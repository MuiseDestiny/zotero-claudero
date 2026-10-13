/** Own resources that otherwise keep a removed preference pane alive. */
export class PreferenceLifetime {
  private disposed = false;
  private cleanups = new Set<() => void>();

  constructor(
    private root: HTMLElement,
    private window: Window,
  ) {
    this.listen(window, "unload", () => this.dispose());
    const { MutationObserver } = window as Window & {
      MutationObserver: typeof globalThis.MutationObserver;
    };
    const observer = new MutationObserver(() => {
      if (!root.isConnected) this.dispose();
    });
    observer.observe(root.ownerDocument.documentElement, {
      childList: true,
      subtree: true,
    });
    this.onDispose(() => observer.disconnect());
  }

  get active(): boolean {
    return !this.disposed && this.root.isConnected;
  }

  onDispose(cleanup: () => void): () => void {
    if (this.disposed) cleanup();
    else this.cleanups.add(cleanup);
    return () => {
      this.cleanups.delete(cleanup);
    };
  }

  // Only use this for stable controls. Re-rendered child controls own their
  // listeners locally, so this scope doesn't retain detached rows/cards.
  listen(
    target: EventTarget | null,
    type: string,
    listener: EventListener,
  ): void {
    if (!target || this.disposed) return;
    target.addEventListener(type, listener);
    this.onDispose(() => target.removeEventListener(type, listener));
  }

  defer(callback: () => void, delay = 0): () => void {
    if (!this.active) return () => {};
    const timer = this.window.setTimeout(() => {
      release();
      if (this.active) callback();
    }, delay);
    const cancel = () => this.window.clearTimeout(timer);
    const release = this.onDispose(cancel);
    return () => {
      cancel();
      release();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const cleanups = Array.from(this.cleanups);
    this.cleanups.clear();
    for (const cleanup of cleanups) cleanup();
  }
}

/** One pending operation per control group, cancelled with its pane. */
export class PreferenceTask {
  private controller?: AbortController;
  constructor(private lifetime: PreferenceLifetime) {
    lifetime.onDispose(() => this.cancel());
  }

  get pending(): boolean {
    return !!this.controller;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  async run(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.pending || !this.lifetime.active) return;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await operation(controller.signal);
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

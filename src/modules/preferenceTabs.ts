/** Tab navigation follows Zotero Style's scrollable preference-card pattern. */
export function initializePreferenceTabs(
  root: HTMLElement,
  window: Window,
  initialPanel: string,
  onSelect: (panel: string) => void,
): () => void {
  const nav = root.querySelector<HTMLElement>(".claudero-pref-tabs");
  const wrapper = root.querySelector<HTMLElement>(
    ".claudero-pref-tabs-wrapper",
  );
  const indicator = root.querySelector<HTMLElement>(
    "#claudero-pref-tab-indicator",
  );
  const tabs = Array.from(
    root.querySelectorAll<HTMLButtonElement>(".claudero-pref-tab"),
  ) as HTMLButtonElement[];
  const panels = Array.from(
    root.querySelectorAll<HTMLElement>(".claudero-pref-panel"),
  ) as HTMLElement[];
  const prev = root.querySelector<HTMLButtonElement>("#claudero-pref-tab-prev");
  const next = root.querySelector<HTMLButtonElement>("#claudero-pref-tab-next");
  if (!nav || !wrapper || !tabs.length) return () => {};
  let disposed = false;
  let frame: number | undefined;
  let active =
    tabs.find((tab) => tab.dataset.panel === initialPanel) || tabs[0];
  const cleanups: Array<() => void> = [];
  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListener,
  ) => {
    target.addEventListener(type, listener);
    cleanups.push(() => target.removeEventListener(type, listener));
  };
  const sync = () => {
    if (disposed || !root.isConnected || !nav.clientWidth) return;
    // Measure the tabs independently of the arrow gutters, preventing arrows
    // from keeping themselves visible after the window is widened.
    const contentWidth = tabs.reduce(
      (width, tab) => width + tab.offsetWidth,
      0,
    );
    wrapper.dataset.overflow = String(contentWidth > wrapper.clientWidth + 1);
    if (prev) prev.disabled = nav.scrollLeft <= 1;
    if (next)
      next.disabled = nav.scrollLeft + nav.clientWidth >= nav.scrollWidth - 1;
    if (indicator && active.offsetWidth) {
      indicator.style.left = `${active.offsetLeft}px`;
      indicator.style.width = `${active.offsetWidth}px`;
      nav.dataset.indicatorReady = "true";
    }
  };
  const reveal = () => {
    sync();
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = left;
    else if (right > nav.scrollLeft + nav.clientWidth)
      nav.scrollLeft = right - nav.clientWidth;
    sync();
  };
  const schedule = () => {
    if (disposed || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      reveal();
    });
  };
  const select = (tab: HTMLButtonElement, focus = false) => {
    if (disposed) return;
    active = tab;
    for (const item of tabs) {
      const selected = item === tab;
      item.dataset.active = String(selected);
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels)
      panel.hidden = panel.id !== `claudero-pref-panel-${tab.dataset.panel}`;
    onSelect(tab.dataset.panel || "general");
    if (focus) tab.focus();
    reveal();
    const event = root.ownerDocument.createEvent("CustomEvent");
    event.initCustomEvent(
      "claudero-preference-panel-selected",
      false,
      false,
      tab.dataset.panel,
    );
    root.dispatchEvent(event);
  };
  nav.setAttribute("role", "tablist");
  for (const tab of tabs) {
    tab.setAttribute("role", "tab");
    tab.setAttribute(
      "aria-controls",
      `claudero-pref-panel-${tab.dataset.panel}`,
    );
    const panel = panels.find(
      (item) => item.id === `claudero-pref-panel-${tab.dataset.panel}`,
    );
    panel?.setAttribute("role", "tabpanel");
    panel?.setAttribute("aria-labelledby", tab.id);
    listen(tab, "click", () => select(tab));
    listen(tab, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const index = tabs.indexOf(tab);
      const target =
        key === "Home"
          ? tabs[0]
          : key === "End"
            ? tabs.at(-1)
            : key === "ArrowRight"
              ? tabs[(index + 1) % tabs.length]
              : key === "ArrowLeft"
                ? tabs[(index - 1 + tabs.length) % tabs.length]
                : undefined;
      if (!target) return;
      event.preventDefault();
      select(target, true);
    });
  }
  if (prev)
    listen(prev, "click", () => {
      nav.scrollLeft -= nav.clientWidth * 0.75;
      sync();
    });
  if (next)
    listen(next, "click", () => {
      nav.scrollLeft += nav.clientWidth * 0.75;
      sync();
    });
  listen(nav, "scroll", sync);
  listen(window, "resize", schedule);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    cleanups.forEach((dispose) => dispose());
  };
  listen(window, "unload", cleanup);
  const constructors = window as Window & {
    ResizeObserver?: typeof ResizeObserver;
    MutationObserver?: typeof MutationObserver;
  };
  if (constructors.ResizeObserver) {
    const observer = new constructors.ResizeObserver(schedule);
    observer.observe(wrapper);
    tabs.forEach((tab) => observer.observe(tab));
    cleanups.push(() => observer.disconnect());
  }
  if (constructors.MutationObserver) {
    const observer = new constructors.MutationObserver(() => {
      if (!root.isConnected) cleanup();
    });
    observer.observe(root.ownerDocument.documentElement, {
      childList: true,
      subtree: true,
    });
    cleanups.push(() => observer.disconnect());
  }
  const localization = (
    root.ownerDocument as Document & { l10n?: { ready: Promise<unknown> } }
  ).l10n;
  void localization?.ready.then(schedule, schedule);
  select(active);
  schedule();
  return cleanup;
}

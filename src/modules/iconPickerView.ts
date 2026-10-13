import type { PromptIcon } from "./conversationStore";
import { getString } from "../utils/locale";
import { onElementRemoved } from "./elementLifecycle";
import { withRequestDeadline } from "../shared/requestDeadline";

export interface IconPickerOptions {
  onSelect: (icon: PromptIcon) => void;
  onClose: () => void;
  compact?: boolean;
  initialIcon?: PromptIcon;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const ICONIFY_API = "https://api.iconify.design";

export const ICONIFY_SEED_ICONS = [
  "lucide:list",
  "lucide:workflow",
  "lucide:trending-up",
  "lucide:star",
  "lucide:file-text",
  "lucide:book-open",
  "lucide:search",
  "lucide:lightbulb",
  "lucide:target",
  "lucide:rocket",
  "lucide:chart-column",
  "lucide:folder-open",
  "lucide:bookmark",
  "lucide:tag",
  "lucide:message-square",
  "lucide:brain",
  "lucide:link",
  "lucide:wrench",
  "lucide:settings",
  "lucide:palette",
  "lucide:compass",
  "lucide:calendar",
  "lucide:clipboard-check",
  "lucide:home",
  "lucide:graduation-cap",
  "lucide:microscope",
  "lucide:telescope",
  "lucide:globe",
  "lucide:sparkles",
  "lucide:shuffle",
  "lucide:flask-conical",
  "lucide:quote",
  "lucide:wand",
  "lucide:list-checks",
  "lucide:notebook",
  "lucide:pen-line",
  "lucide:bar-chart-2",
  "lucide:layers",
  "lucide:cpu",
  "lucide:database",
  "lucide:code",
  "lucide:terminal",
  "lucide:git-branch",
  "lucide:zap",
  "lucide:award",
  "lucide:flag",
  "lucide:heart",
  "lucide:mail",
  "lucide:map",
  "lucide:music",
  "lucide:phone",
  "lucide:pin",
  "lucide:puzzle",
  "lucide:shield",
  "lucide:smile",
  "lucide:sun",
  "lucide:moon",
  "lucide:cloud",
  "lucide:camera",
  "lucide:video",
  "lucide:image",
  "lucide:layout",
  "lucide:maximize",
  "lucide:minus",
  "lucide:plus",
  "lucide:radio",
  "lucide:repeat",
  "lucide:send",
  "lucide:sliders",
  "lucide:table",
  "lucide:thumbs-up",
  "lucide:timer",
  "lucide:trending-down",
  "lucide:triangle",
  "lucide:truck",
  "lucide:umbrella",
  "lucide:user",
  "lucide:users",
  "lucide:watch",
  "lucide:wifi",
  "lucide:wind",
  "lucide:eye",
  "lucide:filter",
  "lucide:grid",
  "lucide:hash",
  "lucide:headphones",
  "lucide:help-circle",
  "lucide:info",
  "lucide:key",
  "lucide:lock",
  "lucide:log-in",
  "lucide:log-out",
  "lucide:map-pin",
  "lucide:maximize-2",
  "lucide:menu",
  "lucide:message-circle",
  "lucide:mic",
  "lucide:minimize",
  "lucide:minus-circle",
  "lucide:more-horizontal",
  "lucide:navigation",
  "lucide:octagon",
  "lucide:package",
  "lucide:paperclip",
  "lucide:pause",
  "lucide:play",
  "lucide:printer",
  "lucide:refresh-cw",
  "lucide:rotate-ccw",
  "lucide:save",
  "lucide:scissors",
  "lucide:share",
  "lucide:shopping-cart",
  "lucide:sidebar",
  "lucide:skip-forward",
  "lucide:slash",
  "lucide:speaker",
  "lucide:square",
  "lucide:stop-circle",
  "lucide:toggle-left",
  "lucide:pen-tool",
  "lucide:trash-2",
  "lucide:type",
  "lucide:unlock",
  "lucide:upload",
  "lucide:volume-2",
  "lucide:x-circle",
  "lucide:zoom-in",
  "lucide:zoom-out",
  "lucide:activity",
  "lucide:align-left",
  "lucide:archive",
  "lucide:at-sign",
  "lucide:bell",
  "lucide:bold",
  "lucide:box",
  "lucide:briefcase",
  "lucide:check",
  "lucide:check-circle",
  "lucide:chevron-right",
  "lucide:circle",
  "lucide:clipboard",
  "lucide:clock",
  "lucide:cloud-off",
  "lucide:columns",
  "lucide:command",
  "lucide:corner-down-right",
  "lucide:crop",
  "lucide:delete",
  "lucide:disc",
  "lucide:divide",
  "lucide:dollar-sign",
  "lucide:download",
  "lucide:droplet",
  "lucide:edit-3",
  "lucide:external-link",
  "lucide:fast-forward",
  "lucide:feather",
  "lucide:file",
  "lucide:file-code",
  "lucide:film",
  "lucide:folder",
  "lucide:frown",
  "lucide:gift",
  "lucide:git-commit",
  "lucide:github",
  "lucide:gitlab",
  "lucide:glasses",
  "lucide:globe-2",
  "lucide:grip",
  "solar:document-text-outline",
  "solar:notebook-bookmark-outline",
  "solar:pen-new-square-outline",
  "solar:graph-up-outline",
  "tabler:notes",
  "tabler:quote",
  "tabler:flask",
  "tabler:checklist",
  "tabler:wand",
];

export const DEFAULT_ICON_COLOR = "#55534f";

export const COLORS = [
  "#55534f",
  "#a7a299",
  "#a06b53",
  "#cc922e",
  "#448461",
  "#337fa9",
  "#9065b1",
  "#c14d8a",
  "#d54d47",
];

const LEGACY_ICON_MAP: Record<string, string> = {
  summary: "lucide:list",
  method: "lucide:workflow",
  findings: "lucide:trending-up",
  critique: "lucide:star",
  note: "lucide:file-text",
  search: "lucide:search",
  shuffle: "lucide:shuffle",
  book: "lucide:book-open",
  file: "lucide:file-text",
  star: "lucide:star",
};

function createEl<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(XHTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  return el;
}

function normalizeIconName(value: string): string {
  return LEGACY_ICON_MAP[value] || value;
}

function splitIconName(value: string): { prefix: string; name: string } | null {
  const normalized = normalizeIconName(value);
  const idx = normalized.indexOf(":");
  if (idx <= 0 || idx >= normalized.length - 1) return null;
  return { prefix: normalized.slice(0, idx), name: normalized.slice(idx + 1) };
}

export function getIconifySvgUrl(
  iconName: string,
  color = DEFAULT_ICON_COLOR,
  size = 24,
): string {
  const parsed = splitIconName(iconName) ?? splitIconName("lucide:file-text")!;
  const safeColor = encodeURIComponent(color);
  return `${ICONIFY_API}/${encodeURIComponent(parsed.prefix)}/${encodeURIComponent(parsed.name)}.svg?color=${safeColor}&width=${size}&height=${size}`;
}

export function normalizePromptIcon(
  icon: PromptIcon | undefined,
): PromptIcon | undefined {
  if (icon?.type !== "iconify") return icon;
  return {
    ...icon,
    value: normalizeIconName(icon.value),
    color: icon.color || DEFAULT_ICON_COLOR,
  };
}

export function randomIconifyIcon(): PromptIcon {
  const value =
    ICONIFY_SEED_ICONS[Math.floor(Math.random() * ICONIFY_SEED_ICONS.length)] ||
    "lucide:sparkles";
  return {
    type: "iconify",
    value,
    color:
      COLORS[Math.floor(Math.random() * COLORS.length)] || DEFAULT_ICON_COLOR,
  };
}

export function renderPromptIcon(
  doc: Document,
  icon: PromptIcon | undefined,
  container: HTMLElement,
): void {
  while (container.firstChild) container.firstChild.remove();
  const normalized = normalizePromptIcon(icon);
  if (!normalized) return;
  if (normalized.type === "emoji") {
    const span = createEl(doc, "span", "claudero-prompt-icon-emoji");
    span.textContent = normalized.value;
    container.appendChild(span);
    return;
  }
  if (normalized.type === "upload") {
    const img = createEl(
      doc,
      "img",
      "claudero-prompt-icon-image",
    ) as HTMLImageElement;
    img.src = normalized.attachmentKey;
    img.alt = "";
    container.appendChild(img);
    return;
  }
  const img = createEl(
    doc,
    "img",
    "claudero-prompt-icon-image claudero-iconify-image",
  ) as HTMLImageElement;
  img.src = getIconifySvgUrl(
    normalized.value,
    normalized.color || DEFAULT_ICON_COLOR,
    24,
  );
  img.alt = "";
  img.decoding = "async";
  img.loading = "lazy";
  container.appendChild(img);
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  el.style.display = hidden ? "none" : "";
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function iconLabel(iconName: string): string {
  return normalizeIconName(iconName).replace(/^.+:/, "").replace(/[-_]/g, " ");
}

export function showIconPicker(
  doc: Document,
  options: IconPickerOptions,
): HTMLElement {
  const popup = createEl(doc, "div", "claudero-icon-picker");
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", getString("icon-choose"));
  if (options.compact) popup.classList.add("compact");
  // Fit to content — avoid fixed width stretching past content
  popup.style.setProperty("height", "fit-content", "important");
  popup.style.setProperty("width", "fit-content", "important");

  let closed = false;
  let selectedColor =
    options.initialIcon?.type === "iconify"
      ? options.initialIcon.color || DEFAULT_ICON_COLOR
      : DEFAULT_ICON_COLOR;
  let requestId = 0;
  let colorPopup: HTMLElement | null = null;
  // Full icon list — starts with seed, grows after API fetch
  let allIcons: string[] = [...ICONIFY_SEED_ICONS];

  const SVG_NS2 = "http://www.w3.org/2000/svg";

  function makeSvg(
    w: number,
    h: number,
    paths: (svg: SVGSVGElement) => void,
  ): SVGSVGElement {
    const svg = doc.createElementNS(SVG_NS2, "svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    paths(svg);
    return svg;
  }

  const close = () => {
    if (closed) return;
    closed = true;
    colorPopup?.remove();
    popup.remove();
    options.onClose();
  };
  const select = (icon: PromptIcon) => {
    if (closed) return;
    closed = true;
    colorPopup?.remove();
    popup.remove();
    options.onSelect(icon);
  };

  // ── Search row ──────────────────────────────────────────────
  const searchRow = createEl(doc, "div", "claudero-icon-picker-search-row");
  const searchWrap = createEl(doc, "div", "claudero-icon-picker-search");

  // Search icon SVG (magnifier)
  const searchSvg = makeSvg(16, 16, (s) => {
    const c = doc.createElementNS(SVG_NS2, "circle");
    c.setAttribute("cx", "7");
    c.setAttribute("cy", "7");
    c.setAttribute("r", "5");
    s.appendChild(c);
    const l = doc.createElementNS(SVG_NS2, "line");
    l.setAttribute("x1", "10.8");
    l.setAttribute("y1", "10.8");
    l.setAttribute("x2", "15");
    l.setAttribute("y2", "15");
    s.appendChild(l);
  });
  searchSvg.setAttribute("stroke-width", "2");
  searchSvg.style.flexShrink = "0";
  searchSvg.style.color = "var(--fill-secondary)";

  const searchInput = createEl(
    doc,
    "input",
    "claudero-icon-picker-search-input",
  ) as HTMLInputElement;
  searchInput.type = "search";
  searchInput.placeholder = getString("icon-search-placeholder");
  searchInput.setAttribute("autocomplete", "off");
  searchWrap.append(searchSvg, searchInput);

  // Shuffle button — inline SVG (an iconify <img> with a CSS-var color fails to
  // render), picks a random icon as prompt icon
  const shuffleBtn = createEl(
    doc,
    "button",
    "claudero-icon-picker-shuffle-btn",
  );
  shuffleBtn.type = "button";
  shuffleBtn.title = "Pick random icon";
  const shuffleSvg = doc.createElementNS(SVG_NS2, "svg");
  shuffleSvg.setAttribute("viewBox", "0 0 1024 1024");
  shuffleSvg.setAttribute("width", "16");
  shuffleSvg.setAttribute("height", "16");
  shuffleSvg.setAttribute("fill", "currentColor");
  const shufflePath = doc.createElementNS(SVG_NS2, "path");
  shufflePath.setAttribute(
    "d",
    "M753.564731 337.471035c-45.8697 0-160.259984 113.849978-243.789399 194.548928C383.134027 654.383848 263.508509 773.284865 167.764911 773.284865l-58.892295 0c-24.068162 0-43.581588-19.526729-43.581588-43.581588s19.513426-43.581588 43.581588-43.581588l58.892295 0c60.504002 0 183.002964-121.68134 281.432741-216.784348 119.79641-115.744117 223.254713-219.029482 304.368102-219.029482l56.209186 0-59.641355-57.828057c-17.033955-16.993023-17.060561-42.902112-0.057305-59.927881 17.002232-17.030885 44.596707-17.064654 61.631686-0.065492l134.207631 133.874033c8.192589 8.172123 12.794397 19.238157 12.794397 30.803563 0 11.564383-4.601808 22.604834-12.794397 30.776957L811.706943 461.72599c-8.505721 8.486278-19.646456 12.522198-30.78719 12.522198-11.166317 0-22.333658-4.676509-30.844495-13.199627-17.003256-17.025769-16.975627-45.432749 0.057305-62.425771l59.641355-61.151755L753.564731 337.471035zM811.706943 561.66105c-17.034978-16.999163-44.629453-16.972557-61.631686 0.058328-17.003256 17.024745-16.975627 46.257533 0.057305 63.250556l59.641355 61.150732-56.209186 0c-35.793204 0-95.590102-52.946886-154.87637-108.373243-17.576307-16.435321-45.161572-16.3422-61.594847 1.226944-16.444531 17.568121-15.523555 46.393633 2.053776 62.823837 90.322122 84.458577 151.246703 131.484613 214.417441 131.484613l56.209186 0-59.641355 57.824987c-17.033955 16.993023-17.060561 43.736107-0.057305 60.761875 8.511861 8.523117 19.678178 12.369725 30.844495 12.369725 11.140735 0 22.281469-4.453429 30.78719-12.939707L945.914574 757.311055c8.192589-8.173147 12.794397-19.315928 12.794397-30.881334 0-11.564383-4.601808-22.682605-12.794397-30.855752L811.706943 561.66105zM108.871593 337.471035l58.892295 0c45.932122 0 114.40154 58.455343 168.915108 107.942431 8.352225 7.576559 18.832927 12.140505 29.29214 12.140505 11.852956 0 23.673166-4.394077 32.270984-13.857613 16.182564-17.807574 14.859429-46.823422-2.958378-62.998823-85.247546-77.381391-156.561755-130.388652-227.519854-130.388652l-58.892295 0c-24.068162 0-43.581588 19.526729-43.581588 43.581588S84.804455 337.471035 108.871593 337.471035z",
  );
  shuffleSvg.appendChild(shufflePath);
  shuffleBtn.appendChild(shuffleSvg);

  // Color preview button (circle)
  const colorPreviewBtn = createEl(
    doc,
    "button",
    "claudero-icon-picker-color-preview",
  );
  colorPreviewBtn.type = "button";
  colorPreviewBtn.title = "Choose color";
  colorPreviewBtn.style.backgroundColor = selectedColor;

  searchRow.append(searchWrap, shuffleBtn, colorPreviewBtn);
  popup.appendChild(searchRow);

  // ── Icon grid ────────────────────────────────────────────────
  const content = createEl(doc, "div", "claudero-icon-picker-content");
  const grid = createEl(doc, "div", "claudero-icon-picker-grid");
  content.appendChild(grid);
  popup.appendChild(content);

  function updateGridColors(): void {
    grid
      .querySelectorAll<HTMLImageElement>("img[data-icon-name]")
      .forEach((img) => {
        const name = img.dataset.iconName;
        if (name) img.src = getIconifySvgUrl(name, selectedColor, 24);
      });
  }

  function renderIcons(icons: string[]): void {
    while (grid.firstChild) grid.firstChild.remove();
    icons.forEach((rawName) => {
      const iconName = normalizeIconName(rawName);
      const btn = createEl(
        doc,
        "button",
        "claudero-icon-picker-item icon-item",
      );
      btn.type = "button";
      btn.title = iconLabel(iconName);
      btn.dataset.search = normalizeText(iconName);
      btn.setAttribute("aria-label", iconLabel(iconName));
      if (
        options.initialIcon?.type === "iconify" &&
        normalizeIconName(options.initialIcon.value) === iconName
      )
        btn.classList.add("selected");
      const img = createEl(
        doc,
        "img",
        "claudero-icon-picker-img",
      ) as HTMLImageElement;
      img.src = getIconifySvgUrl(iconName, selectedColor, 24);
      img.alt = "";
      img.dataset.iconName = iconName;
      img.loading = "lazy";
      img.decoding = "async";
      btn.appendChild(img);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        select({ type: "iconify", value: iconName, color: selectedColor });
      });
      grid.appendChild(btn);
    });
  }

  async function runSearch(query: string): Promise<void> {
    const q = normalizeText(query.trim());
    if (!q) {
      renderIcons(allIcons);
      return;
    }
    // Client-side filter by icon name — works with any language
    const filtered = allIcons.filter(
      (name) =>
        normalizeText(iconLabel(name)).includes(q) ||
        normalizeText(name).includes(q),
    );
    renderIcons(filtered.length ? filtered : allIcons);
  }

  const catalogRequest = new AbortController();
  async function loadAllIcons(): Promise<void> {
    const id = ++requestId;
    try {
      const url = `${ICONIFY_API}/search?query=&limit=999&prefix=lucide`;
      const data = await withRequestDeadline(
        async (signal) => {
          const res = await fetch(url, { cache: "force-cache", signal });
          if (!res.ok) throw new Error(`Icon catalog returned ${res.status}`);
          return (await res.json()) as { icons?: unknown[] };
        },
        catalogRequest.signal,
        10_000,
      );
      if (closed || id !== requestId) return;
      if (Array.isArray(data.icons) && data.icons.length) {
        // Merge API results with seed list (keep seed order first, then add new ones)
        const seedSet = new Set(ICONIFY_SEED_ICONS.map(normalizeIconName));
        const newIcons = data.icons.filter(
          (n): n is string =>
            typeof n === "string" && !seedSet.has(normalizeIconName(n)),
        );
        allIcons = [...ICONIFY_SEED_ICONS, ...newIcons];
        if (!searchInput.value.trim()) renderIcons(allIcons);
      }
    } catch {
      /* keep seed list */
    }
  }

  // ── Handlers ─────────────────────────────────────────────────
  let timer: number | undefined;
  searchInput.addEventListener("input", () => {
    if (timer != null) doc.defaultView?.clearTimeout(timer);
    timer = doc.defaultView?.setTimeout(() => {
      void runSearch(searchInput.value);
    }, 150);
  });

  shuffleBtn.addEventListener("click", () => {
    // Pick a random icon AND a random color, then select it immediately
    const pool = allIcons.length ? allIcons : ICONIFY_SEED_ICONS;
    const randomName =
      pool[Math.floor(Math.random() * pool.length)] || "lucide:sparkles";
    const randomColor =
      COLORS[Math.floor(Math.random() * COLORS.length)] || selectedColor;
    select({
      type: "iconify",
      value: normalizeIconName(randomName),
      color: randomColor,
    });
  });

  colorPreviewBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (colorPopup) {
      colorPopup.remove();
      colorPopup = null;
      return;
    }

    const cp = createEl(
      doc,
      "div",
      "claudero-color-picker-popup claudero-color-picker-active",
    );
    cp.style.position = "absolute";
    const btnRect = colorPreviewBtn.getBoundingClientRect();
    const scrollTop = doc.documentElement.scrollTop || doc.body?.scrollTop || 0;
    const scrollLeft =
      doc.documentElement.scrollLeft || doc.body?.scrollLeft || 0;
    const vw = doc.defaultView?.innerWidth ?? 800;
    cp.style.right = `${Math.max(0, vw - btnRect.right - scrollLeft)}px`;
    cp.style.top = `${btnRect.bottom + scrollTop + 6}px`;
    cp.style.zIndex = "2147483647";

    const grid2 = createEl(doc, "div", "claudero-color-picker-popup-grid");
    COLORS.forEach((color) => {
      const swatch = createEl(
        doc,
        "button",
        "claudero-color-picker-popup-swatch",
      );
      swatch.type = "button";
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-label", `Use color ${color}`);
      if (selectedColor === color) swatch.classList.add("selected");
      swatch.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectedColor = color;
        colorPreviewBtn.style.backgroundColor = color;
        updateGridColors();
        cp.remove();
        colorPopup = null;
      });
      grid2.appendChild(swatch);
    });
    cp.appendChild(grid2);
    doc.documentElement.appendChild(cp);
    colorPopup = cp;

    const onOutside = (ev: MouseEvent) => {
      if (!cp.contains(ev.target as Node) && ev.target !== colorPreviewBtn) {
        cp.remove();
        colorPopup = null;
        doc.removeEventListener("mousedown", onOutside, true);
      }
    };
    doc.addEventListener("mousedown", onOutside, true);
    onElementRemoved(
      cp,
      () => {
        cp.remove();
        if (colorPopup === cp) colorPopup = null;
        doc.removeEventListener("mousedown", onOutside, true);
      },
      popup,
    );
  });

  popup.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  popup.addEventListener("click", (e) => e.stopPropagation());

  // Show seed icons immediately, then load full list in background
  renderIcons(allIcons);
  void loadAllIcons();
  const focusTimer = setTimeout(() => {
    try {
      if (closed || !popup.isConnected) return;
      searchInput.focus();
    } catch {
      /* best effort */
    }
  }, 30);
  onElementRemoved(popup, () => {
    closed = true;
    catalogRequest.abort();
    requestId++;
    colorPopup?.remove();
    colorPopup = null;
    if (timer != null) doc.defaultView?.clearTimeout(timer);
    clearTimeout(focusTimer);
  });
  return popup;
}

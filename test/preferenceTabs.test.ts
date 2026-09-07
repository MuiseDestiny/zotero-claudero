import { assert } from "chai";
import { initializePreferenceTabs } from "../src/modules/preferenceTabs";

describe("preference tab navigation", function () {
  let root: HTMLElement;
  let cleanup: () => void;
  let selected: string[];
  const names = [
    "general",
    "claude",
    "codex",
    "deepseek",
    "mcp",
    "skills",
    "diagnostics",
  ];
  const tab = (name: string) =>
    root.querySelector<HTMLButtonElement>(`#claudero-pref-tab-${name}`)!;
  const panel = (name: string) =>
    root.querySelector<HTMLElement>(`#claudero-pref-panel-${name}`)!;

  beforeEach(function () {
    root = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const wrapper = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    wrapper.className = "claudero-pref-tabs-wrapper";
    wrapper.style.cssText =
      "display:grid;grid-template-columns:0 minmax(0,1fr) 0;width:240px";
    const nav = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    nav.className = "claudero-pref-tabs";
    nav.style.cssText =
      "display:flex;position:relative;overflow:auto;min-width:0";
    const prev = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    );
    prev.id = "claudero-pref-tab-prev";
    const next = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    );
    next.id = "claudero-pref-tab-next";
    wrapper.append(prev, nav, next);
    root.append(wrapper);
    for (const name of names) {
      const button = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      );
      button.id = `claudero-pref-tab-${name}`;
      button.className = "claudero-pref-tab";
      button.dataset.panel = name;
      button.style.cssText = "flex:0 0 100px";
      button.textContent = name;
      nav.append(button);
      const content = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      );
      content.id = `claudero-pref-panel-${name}`;
      content.className = "claudero-pref-panel";
      root.append(content);
    }
    const indicator = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    indicator.id = "claudero-pref-tab-indicator";
    nav.append(indicator);
    document.body.append(root);
    selected = [];
    cleanup = () => {};
  });

  afterEach(function () {
    cleanup();
    root.remove();
  });

  it("restores the saved tab with matching accessible panel state", function () {
    cleanup = initializePreferenceTabs(root, window, "codex", (name) =>
      selected.push(name),
    );
    assert.deepEqual(selected, ["codex"]);
    assert.equal(tab("codex").getAttribute("aria-selected"), "true");
    assert.equal(tab("codex").tabIndex, 0);
    assert.equal(tab("general").tabIndex, -1);
    assert.isFalse(panel("codex").hidden);
    assert.isTrue(panel("general").hidden);
    assert.equal(
      panel("codex").getAttribute("aria-labelledby"),
      tab("codex").id,
    );
  });

  it("supports arrows, Home and End while revealing the active tab", function () {
    cleanup = initializePreferenceTabs(root, window, "general", (name) =>
      selected.push(name),
    );
    tab("general").dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    assert.equal(selected.at(-1), "diagnostics");
    assert.isAbove(
      root.querySelector<HTMLElement>(".claudero-pref-tabs")!.scrollLeft,
      0,
    );
    tab("diagnostics").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    assert.equal(selected.at(-1), "general");
    tab("general").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    assert.equal(selected.at(-1), "diagnostics");
    tab("diagnostics").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    assert.equal(selected.at(-1), "general");
  });

  it("falls back from a removed tab and releases listeners on cleanup", function () {
    cleanup = initializePreferenceTabs(root, window, "removed", (name) =>
      selected.push(name),
    );
    assert.deepEqual(selected, ["general"]);
    cleanup();
    tab("codex").click();
    assert.deepEqual(selected, ["general"]);
  });

  it("measures a pane after it becomes visible and stops after removal", async function () {
    root.style.display = "none";
    cleanup = initializePreferenceTabs(root, window, "diagnostics", (name) =>
      selected.push(name),
    );
    const nav = root.querySelector<HTMLElement>(".claudero-pref-tabs")!;
    assert.notEqual(nav.dataset.indicatorReady, "true");
    root.style.display = "block";
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(nav.dataset.indicatorReady, "true");
    assert.isAbove(nav.scrollLeft, 0);
    root.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    tab("claude").click();
    assert.deepEqual(selected, ["diagnostics"]);
  });
});

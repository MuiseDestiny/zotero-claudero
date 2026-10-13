import { assert } from "chai";
import { onElementRemoved } from "../src/modules/elementLifecycle";
import {
  createComposerView,
  type ComposerView,
} from "../src/modules/composerView";
import { showIconPicker } from "../src/modules/iconPickerView";
import { installUiTestContext } from "./uiTestContext";

describe("view resource lifecycle", function () {
  const win = window as Window & {
    ResizeObserver: typeof ResizeObserver;
    MutationObserver: typeof MutationObserver;
  };
  let root: HTMLElement;
  let restoreContext: () => void;
  const makeRoot = () =>
    document.createElementNS("http://www.w3.org/1999/xhtml", "div");

  beforeEach(function () {
    restoreContext = installUiTestContext();
    root = makeRoot();
    document.body.appendChild(root);
  });

  afterEach(async function () {
    root.remove();
    await Zotero.Promise.delay(0);
    restoreContext();
  });

  it("shares removal observation, preserves reparented views, and cleans owner-bound surfaces", async function () {
    const original = win.MutationObserver;
    let observers = 0;
    let disconnected = 0;
    win.MutationObserver = class extends original {
      constructor(callback: MutationCallback) {
        super(callback);
        observers++;
      }
      disconnect() {
        disconnected++;
        super.disconnect();
      }
    };
    const popup = makeRoot();
    document.body.appendChild(popup);
    let cleanups = 0;
    try {
      const first = makeRoot();
      const second = makeRoot();
      root.append(first, second);
      const dispose = onElementRemoved(first, () => {
        cleanups++;
      });
      onElementRemoved(
        popup,
        () => {
          cleanups++;
          popup.remove();
        },
        second,
      );
      assert.equal(observers, 1);
      first.remove();
      root.appendChild(first);
      await Zotero.Promise.delay(0);
      assert.equal(
        cleanups,
        0,
        "Moving a panel between Zotero tabs must preserve it",
      );
      root.remove();
      await Zotero.Promise.delay(0);
      assert.equal(cleanups, 2);
      assert.isFalse(popup.isConnected);
      assert.equal(disconnected, 1);
      dispose();
      assert.equal(cleanups, 2, "Disposal is idempotent");
    } finally {
      popup.remove();
      win.MutationObserver = original;
    }
  });

  function createView(
    onPermissionChange = (_value: string) => {},
  ): ComposerView<object> {
    const item = (value: string) => ({ value, label: value });
    const view = createComposerView(document, {
      providerOptions: [item("claude")],
      modelOptions: [item("model")],
      effortOptions: [item("low"), item("high")],
      permissionOptions: [item("default"), { ...item("bypass"), danger: true }],
      defaultProvider: "claude",
      defaultModel: "model",
      defaultEffort: "low",
      defaultPermission: "default",
      onProviderChange() {},
      onModelChange() {},
      onEffortChange() {},
      onPermissionChange,
      onAtClick() {},
      onMagicClick() {},
      onInputChanged() {},
      onAtTyped() {},
      onPasteImages() {},
    });
    root.appendChild(view.element);
    view.setStateRef({});
    return view;
  }

  it("releases dropdown listeners and resize observers over repeated open/close cycles", async function () {
    const originalObserver = win.ResizeObserver;
    const originalAdd = document.addEventListener;
    const originalRemove = document.removeEventListener;
    const listeners = new Set<EventListenerOrEventListenerObject>();
    let activeObservers = 0;
    win.ResizeObserver = class {
      private active = false;
      observe() {
        if (!this.active) {
          this.active = true;
          activeObservers++;
        }
      }
      unobserve() {}
      disconnect() {
        if (this.active) {
          this.active = false;
          activeObservers--;
        }
      }
    } as unknown as typeof ResizeObserver;
    document.addEventListener = function (type, listener, options) {
      if (listener && ["mousedown", "keydown"].includes(type))
        listeners.add(listener);
      return originalAdd.call(this, type, listener, options);
    } as typeof document.addEventListener;
    document.removeEventListener = function (type, listener, options) {
      if (listener) listeners.delete(listener);
      return originalRemove.call(this, type, listener, options);
    } as typeof document.removeEventListener;
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        const view = createView();
        view.effortSelect.element.click();
        view.permissionSelect.element.click();
        assert.equal(
          view.effortSelect.element.getAttribute("aria-expanded"),
          "false",
        );
        assert.lengthOf(
          document.querySelectorAll(".claudero-select-popover"),
          1,
        );
        view.element.remove();
        await Zotero.Promise.delay(0);
        assert.lengthOf(
          document.querySelectorAll(".claudero-select-popover"),
          0,
        );
        assert.equal(listeners.size, 0);
        assert.equal(activeObservers, 0);
      }
    } finally {
      document.addEventListener = originalAdd;
      document.removeEventListener = originalRemove;
      win.ResizeObserver = originalObserver;
    }
  });

  it("cancels a pending permission confirmation when its composer is disposed", async function () {
    let changes = 0;
    const view = createView(() => {
      changes++;
    });
    view.permissionSelect.element.click();
    const row = document.querySelector<HTMLElement>(
      ".claudero-select-row.is-danger",
    )!;
    row.click();
    const approve = document.querySelector<HTMLButtonElement>(
      ".claudero-danger-confirm-primary",
    )!;
    assert.exists(approve);
    view.dispose();
    approve.click();
    await Zotero.Promise.delay(0);
    assert.equal(changes, 0);
    assert.equal(view.permissionSelect.value, "default");
    assert.notExists(
      document.querySelector(".claudero-danger-confirm-backdrop"),
    );
  });

  it("aborts an icon catalog request when the picker is removed", async function () {
    const originalFetch = window.fetch;
    let signal: AbortSignal | null | undefined;
    window.fetch = async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
      });
    };
    try {
      const picker = showIconPicker(document, { onSelect() {}, onClose() {} });
      root.appendChild(picker);
      assert.exists(signal);
      picker.remove();
      await Zotero.Promise.delay(0);
      assert.isTrue(signal?.aborted);
    } finally {
      window.fetch = originalFetch;
    }
  });
});

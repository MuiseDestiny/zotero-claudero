import { assert } from "chai";
import {
  getClauderoDir,
  getDefaultPrompts,
  saveDefaultPrompts,
  loadCustomPrompts,
  saveCustomPrompts,
  saveCustomPrompt,
  deleteCustomPrompt,
} from "../src/modules/conversationStore";
import { getPref, setPref, clearPref } from "../src/utils/prefs";
import { showPromptPopup } from "../src/modules/promptPopupView";
import { installUiTestContext } from "./uiTestContext";

describe("custom prompt durability", function () {
  let path: string;
  let originals: Array<string | null>;
  let originalDefaults: ReturnType<typeof getPref<"defaultPrompts">>;
  let restoreContext: () => void;
  const suffixes = ["", ".bak", ".tmp"];
  const prompt = (id: string) => ({ id, label: id, text: `Prompt ${id}` });

  beforeEach(async function () {
    restoreContext = installUiTestContext();
    path = PathUtils.join(getClauderoDir(), "custom-prompts.json");
    originalDefaults = getPref("defaultPrompts");
    originals = [];
    await IOUtils.makeDirectory(getClauderoDir(), { createAncestors: true });
    for (const suffix of suffixes) {
      originals.push(
        (await IOUtils.exists(path + suffix))
          ? await IOUtils.readUTF8(path + suffix)
          : null,
      );
      await IOUtils.remove(path + suffix, { ignoreAbsent: true });
    }
    saveDefaultPrompts([]);
  });

  afterEach(async function () {
    for (let i = 0; i < suffixes.length; i++) {
      await IOUtils.remove(path + suffixes[i], { ignoreAbsent: true });
      if (originals[i] !== null)
        await IOUtils.writeUTF8(path + suffixes[i], originals[i]!);
    }
    if (originalDefaults === undefined) clearPref("defaultPrompts");
    else setPref("defaultPrompts", originalDefaults);
    document
      .querySelectorAll(".claudero-magic-stack")
      .forEach((entry) => entry.remove());
    restoreContext();
  });

  it("serializes concurrent edits and rejects stale editors and deleted records", async function () {
    const a = prompt("alpha"),
      b = prompt("beta");
    await Promise.all([saveCustomPrompt(a), saveCustomPrompt(b)]);
    assert.lengthOf(await loadCustomPrompts(), 2);
    const next = { ...a, text: "new alpha" };
    await Promise.all([
      saveCustomPrompt(next, a),
      saveCustomPrompt({ ...b, text: "new beta" }, b),
    ]);
    assert.deepEqual(
      (await loadCustomPrompts()).map((entry) => entry.text),
      ["new alpha", "new beta"],
    );
    const stale = await saveCustomPrompt({ ...a, text: "stale" }, a).catch(
      (error) => error,
    );
    assert.include(stale.message, "changed or was deleted");
    await deleteCustomPrompt(next);
    const deleted = await saveCustomPrompt(a, next).catch((error) => error);
    assert.include(deleted.message, "changed or was deleted");
    assert.deepEqual(
      (await loadCustomPrompts()).map((entry) => entry.id),
      ["beta"],
    );
  });

  it("recovers a backup and refuses to overwrite unrecoverable prompt data", async function () {
    await saveCustomPrompts([prompt("alpha")]);
    await saveCustomPrompts([prompt("beta")]);
    await IOUtils.writeUTF8(path, JSON.stringify([null]));
    assert.equal((await loadCustomPrompts())[0].id, "alpha");
    await IOUtils.remove(path + ".bak");
    await IOUtils.writeUTF8(path, "{broken");
    const error = await saveCustomPrompt(prompt("gamma")).catch(
      (error) => error,
    );
    assert.include(error.message, "Could not read saved prompts");
    assert.equal(await IOUtils.readUTF8(path), "{broken");
  });

  it("keeps an empty default list empty", function () {
    assert.deepEqual(getDefaultPrompts(), []);
  });

  it("renders only the latest search from one in-flight load and preserves a draft on save failure", async function () {
    await saveCustomPrompts([prompt("alpha"), prompt("beta")]);
    const root = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    const anchor = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    );
    root.appendChild(anchor);
    document.body.appendChild(root);
    const read = IOUtils.readUTF8,
      write = IOUtils.writeUTF8;
    let reads = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    IOUtils.readUTF8 = async (...args) => {
      if (args[0] === path) {
        reads++;
        await blocked;
      }
      return read.apply(IOUtils, args);
    };
    try {
      showPromptPopup({ root }, anchor, { onPrompt() {}, onInsertNote() {} });
      const search = document.querySelector<HTMLInputElement>(
        ".claudero-magic-search-input",
      )!;
      for (const text of ["a", "alpha", "beta"]) {
        search.value = text;
        search.dispatchEvent(new Event("input"));
      }
      release();
      for (
        let i = 0;
        i < 100 && !document.querySelector(".claudero-magic-row");
        i++
      )
        await Zotero.Promise.delay(10);
      assert.equal(reads, 1);
      assert.lengthOf(document.querySelectorAll(".claudero-magic-row"), 1);
      assert.equal(
        document.querySelector(".claudero-prompt-title")?.textContent,
        "beta",
      );
      document.querySelector<HTMLElement>(".claudero-magic-add-btn")!.click();
      const panel = document.querySelector<HTMLElement>(
        ".claudero-prompt-editor-panel",
      )!;
      panel.querySelector<HTMLInputElement>("input")!.value = "My draft";
      panel.querySelector<HTMLTextAreaElement>("textarea")!.value =
        "Keep this content";
      IOUtils.writeUTF8 = async (...args) => {
        if (args[0] === path) throw new Error("fixture disk full");
        return write.apply(IOUtils, args);
      };
      const save = panel.querySelector<HTMLElement>(
        ".claudero-prompt-primary-btn",
      )!;
      save.dispatchEvent(
        new Event(save.localName === "toolbarbutton" ? "command" : "click"),
      );
      for (let i = 0; i < 100 && !panel.querySelector('[role="alert"]'); i++)
        await Zotero.Promise.delay(10);
      assert.include(panel.textContent, "fixture disk full");
      assert.isTrue(panel.isConnected);
      assert.equal(
        panel.querySelector<HTMLTextAreaElement>("textarea")!.value,
        "Keep this content",
      );
      assert.lengthOf(await loadCustomPrompts(), 2);
      assert.isFalse(save.hasAttribute("disabled"));
    } finally {
      release();
      IOUtils.readUTF8 = read;
      IOUtils.writeUTF8 = write;
      root.remove();
      await Zotero.Promise.delay(0);
    }
  });
});

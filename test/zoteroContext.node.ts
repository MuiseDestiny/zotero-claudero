import { assert } from "chai";
import {
  buildPromptWithZoteroContext,
  getSelectedReaderAnnotations,
  getSelectedZoteroContext,
} from "../src/modules/zoteroContext";

describe("Zotero context resilience", function () {
  it("excludes privileged item objects from the prompt", function () {
    const rawItem: any = { privateState: "must-not-enter-prompt" };
    rawItem.self = rawItem;
    const attachment = {
      id: 22,
      key: "ATTACHKEY",
      title: "PDF fixture",
      contentType: "application/pdf",
      _item: rawItem,
    };
    const prompt = buildPromptWithZoteroContext(
      "Summarize the selected paper",
      {
        generatedAt: "2026-09-12T00:00:00Z",
        selectedType: "reader",
        selectedTabID: "reader-fixture",
        selectedText: "selected text",
        items: [],
        reader: attachment,
      },
      "",
    );
    assert.include(prompt, "PDF fixture");
    assert.notInclude(prompt, "must-not-enter-prompt");
    assert.notInclude(prompt, '"_item"');
  });

  it("tolerates a Zotero pane that is not ready", async function () {
    (globalThis as any).Zotero = {};
    const context = await getSelectedZoteroContext({
      Zotero_Tabs: { selectedType: "library", selectedID: "library" },
      ZoteroPane: {
        getSelectedItems() {
          throw new Error("Pane is loading");
        },
      },
    } as unknown as Window);
    assert.deepEqual(context.items, []);
    assert.equal(context.selectedText, "");
  });

  it("keeps selected annotation text when its saved position is malformed", function () {
    const reader = {
      _item: { libraryID: 1 },
      _internalReader: {
        _primaryView: { _selectedAnnotationIDs: ["ANNOTATION"] },
      },
    };
    (globalThis as any).Zotero = {
      Items: {
        getByLibraryAndKey: () => ({
          annotationText: "Selected evidence text",
          annotationType: "highlight",
          annotationPosition: "{malformed",
        }),
      },
    };
    const annotations = getSelectedReaderAnnotations({
      Zotero_Tabs: { selectedType: "reader", selectedID: "reader" },
      Zotero: { Reader: { getByTabID: () => reader } },
    } as unknown as Window);
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].text, "Selected evidence text");
    assert.isUndefined(annotations[0].pageIndex);
  });
});

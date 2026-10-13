import { assert } from "chai";
import { asSelectionContext } from "../src/modules/selectionContextValidation";

describe("stored selection context", function () {
  const context = () => ({
    generatedAt: "2026-09-19T00:00:00Z",
    selectedType: "reader",
    selectedTabID: "tab",
    items: [],
    selectedText: "selected text",
    reader: {
      id: 1,
      key: "PDF",
      title: "Paper",
      contentType: "application/pdf",
      _item: { getItemTypeIconName: "not a function" },
    },
    selectedAnnotations: [
      { type: "highlight", text: "evidence", pageIndex: 0 },
    ],
  });

  it("preserves valid context while discarding serialized native handles", function () {
    const original = context();
    const parsed = asSelectionContext(original)!;
    assert.equal(parsed.reader?.title, "Paper");
    assert.equal(parsed.selectedAnnotations?.[0].text, "evidence");
    assert.notProperty(parsed.reader, "_item");
    assert.property(original.reader, "_item");
  });

  it("rejects malformed nested fields before replay and rendering", function () {
    const valid = context();
    for (const bad of [
      { ...valid, selectedText: 42 },
      { ...valid, items: [null] },
      { ...valid, reader: { ...valid.reader, title: {} } },
      { ...valid, selectedAnnotations: [null] },
      { ...valid, selectedAnnotations: [{ text: 42, type: "highlight" }] },
      { ...valid, activeCollection: { id: 1, key: "A", name: [], path: "" } },
    ])
      assert.isNull(asSelectionContext(bad));
  });
});

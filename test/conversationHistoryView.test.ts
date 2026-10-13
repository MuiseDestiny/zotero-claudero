import { assert } from "chai";
import { installUiTestContext } from "./uiTestContext";
import { showConversationHistoryPopup } from "../src/modules/conversationHistoryView";
import {
  deleteConversation,
  loadConversationById,
  saveConversationData,
} from "../src/modules/conversationStore";

describe("conversation history view", function () {
  let restoreContext: () => void;

  beforeEach(function () {
    restoreContext = installUiTestContext();
  });

  afterEach(function () {
    restoreContext();
  });

  it("opens from the index and loads a body only when a conversation is selected", async function () {
    const id = `history-view-${Date.now()}`;
    const root = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    document.body.appendChild(root);
    const originalRead = IOUtils.readUTF8;
    const bodies: string[] = [];
    let restored = false;
    try {
      await saveConversationData(id, [
        {
          role: "user",
          text: id,
          ts: Date.now(),
          images: [
            { id: "image", mediaType: "image/png", data: "a".repeat(100_000) },
          ],
        },
      ]);
      IOUtils.readUTF8 = async (...args) => {
        if (args[0].includes("/history/")) bodies.push(args[0]);
        return originalRead.apply(IOUtils, args);
      };
      showConversationHistoryPopup(
        { root, conversationId: id },
        {
          onRestore: async (entry) => {
            assert.notProperty(
              entry,
              "turns",
              "Rows must not retain transcripts and image data",
            );
            const conversation = await loadConversationById(entry.id);
            assert.equal(conversation?.turns[0].text, id);
            restored = true;
          },
          onDelete() {},
          onExport() {},
          onDeleteAll() {},
          onAutoRename: async () => null,
        },
      );
      for (
        let attempt = 0;
        attempt < 100 && !root.querySelector(".claudero-permission-row");
        attempt++
      )
        await Zotero.Promise.delay(10);
      assert.lengthOf(
        bodies,
        0,
        "Opening history should not parse every saved conversation",
      );
      const row = Array.from<HTMLElement>(
        root.querySelectorAll<HTMLElement>(".claudero-permission-row"),
      ).find(
        (entry) =>
          entry.querySelector(".claudero-permission-name")?.textContent === id,
      )!;
      assert.exists(row);
      row.click();
      for (let attempt = 0; attempt < 100 && !restored; attempt++)
        await Zotero.Promise.delay(10);
      assert.isTrue(restored);
      assert.lengthOf(bodies, 1);
      assert.include(bodies[0], id);
    } finally {
      IOUtils.readUTF8 = originalRead;
      root.remove();
      await Zotero.Promise.delay(0);
      await deleteConversation(id);
    }
  });

  it("shows restore failures without an unhandled rejection", async function () {
    const id = `history-error-${Date.now()}`;
    const root = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    );
    document.body.appendChild(root);
    try {
      await saveConversationData(id, [
        { role: "user", text: id, ts: Date.now() },
      ]);
      showConversationHistoryPopup(
        { root, conversationId: id },
        {
          onRestore: () => {
            throw new Error("fixture read failure");
          },
          onDelete() {},
          onExport() {},
          onDeleteAll() {},
          onAutoRename: async () => null,
        },
      );
      for (
        let attempt = 0;
        attempt < 100 && !root.querySelector(".claudero-permission-row");
        attempt++
      )
        await Zotero.Promise.delay(10);
      root.querySelector<HTMLElement>(".claudero-permission-row")!.click();
      await Zotero.Promise.delay(0);
      assert.include(root.textContent, "fixture read failure");
      assert.exists(root.querySelector(".claudero-history-popup"));
    } finally {
      root.remove();
      await Zotero.Promise.delay(0);
      await deleteConversation(id);
    }
  });
});

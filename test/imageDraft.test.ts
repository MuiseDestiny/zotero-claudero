import { assert } from "chai";
import {
  appendImageFiles,
  cancelImageReads,
  readImageDataURL,
  replaceImageDraft,
  trimInputHistory,
} from "../src/modules/imageDraft";
import type { ConversationImage } from "../src/modules/conversationStore";
import { invalidateConversation } from "../src/modules/conversationTransition";

describe("image draft isolation", function () {
  const file = () => new Blob(["image"], { type: "image/png" });
  const state = () => ({
    conversationId: "conversation",
    pendingImages: [] as ConversationImage[],
    disposed: false,
  });
  const dataUrl = "data:image/png;base64,aW1hZ2U=";

  it("bounds image retention across conversations while preserving the latest input", function () {
    const image = { id: "image", mediaType: "image/png", data: "a".repeat(24) };
    const history = [
      { text: "latest", images: [image] },
      { text: "previous", images: [] },
      { text: "old image", images: [image] },
    ];
    trimInputHistory(history, 40);
    assert.deepEqual(
      history.map((entry) => entry.text),
      ["latest", "previous"],
    );
    trimInputHistory(history, 10);
    assert.equal(history[0].images[0].data, image.data);
    assert.lengthOf(history, 1);
  });

  it("never attaches a pending read to a replaced draft or restored conversation", async function () {
    for (const reset of [replaceImageDraft, invalidateConversation]) {
      const draft = state();
      let finish!: (value: string) => void;
      const reading = appendImageFiles(draft, [file()], {
        read: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        onLimit() {},
      });
      reset(draft);
      finish(dataUrl);
      assert.isFalse(await reading);
      assert.lengthOf(draft.pendingImages, 0);
    }
  });

  it("rechecks count and byte quotas when concurrent paste operations finish", async function () {
    for (const limits of [
      { count: 1, perFile: 10, total: 100 },
      { count: 8, perFile: 10, total: 9 },
    ]) {
      const draft = state();
      const finish: Array<(value: string) => void> = [];
      const rejected: string[] = [];
      const options = {
        limits,
        read: () =>
          new Promise<string>((resolve) => {
            finish.push(resolve);
          }),
        onLimit: (reason: "count" | "size") => rejected.push(reason),
      };
      const first = appendImageFiles(draft, [file()], options);
      const second = appendImageFiles(draft, [file()], options);
      finish[1](dataUrl);
      await second;
      finish[0](dataUrl);
      await first;
      assert.lengthOf(draft.pendingImages, 1);
      assert.deepEqual(rejected, [limits.count === 1 ? "count" : "size"]);
    }
  });

  it("aborts outstanding readers on close and releases native FileReader callbacks", async function () {
    let aborted = 0;
    const readers: FakeReader[] = [];
    class FakeReader {
      onload: unknown = null;
      onerror: unknown = null;
      onabort: unknown = null;
      constructor() {
        readers.push(this);
      }
      readAsDataURL() {}
      abort() {
        aborted++;
      }
    }
    const draft = state();
    const reading = appendImageFiles(draft, [file()], {
      read: (file, signal) =>
        readImageDataURL(
          file,
          signal,
          FakeReader as unknown as typeof FileReader,
        ),
      onLimit() {},
    });
    draft.disposed = true;
    cancelImageReads(draft);
    assert.isFalse(await reading);
    assert.equal(aborted, 1);
    const [reader] = readers;
    assert.isNull(reader.onload);
    assert.isNull(reader.onerror);
    assert.isNull(reader.onabort);
    assert.lengthOf(draft.pendingImages, 0);
  });
});

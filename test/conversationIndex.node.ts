import { assert } from "chai";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listConversationIndex } from "../src/modules/conversationStore";

describe("cold history index", function () {
  it("uses unchanged file metadata and reconciles modified, missing, orphaned and backup-only conversations", async function () {
    const profile = await fs.mkdtemp(
      path.join(os.tmpdir(), "claudero-history-index-"),
    );
    const dir = path.join(profile, "claudero"),
      history = path.join(dir, "history");
    await fs.mkdir(history, { recursive: true });
    const globals = globalThis as unknown as Record<string, unknown>;
    const names = ["Zotero", "PathUtils", "IOUtils", "ztoolkit"];
    const saved = names.map((name) => globals[name]);
    const bodies: string[] = [];
    const exists = async (file: string) =>
      fs.access(file).then(
        () => true,
        () => false,
      );
    globals.Zotero = { Profile: { dir: profile }, debug() {} };
    globals.PathUtils = { join: path.join, filename: path.basename };
    globals.ztoolkit = { log() {} };
    globals.IOUtils = {
      exists,
      readUTF8: async (file: string) => {
        if (file.startsWith(history + path.sep)) bodies.push(file);
        return fs.readFile(file, "utf8");
      },
      stat: async (file: string) => {
        const stat = await fs.stat(file);
        return { size: stat.size, lastModified: stat.mtimeMs };
      },
      getChildren: async (file: string) =>
        (await fs.readdir(file)).map((entry) => path.join(file, entry)),
      makeDirectory: async (file: string) =>
        fs.mkdir(file, { recursive: true }),
      writeUTF8: async (
        file: string,
        contents: string,
        options: { tmpPath: string; backupFile?: string },
      ) => {
        await fs.writeFile(options.tmpPath, contents);
        if (options.backupFile && (await exists(file)))
          await fs.copyFile(file, options.backupFile);
        await fs.rename(options.tmpPath, file);
      },
    };
    const document = (id: string, text = id) => ({
      schemaVersion: 1,
      id,
      title: text,
      createdAt: 1,
      updatedAt: 2,
      turns: [{ role: "user", text, ts: 1 }],
    });
    try {
      const entries = [];
      for (const id of ["cached", "changed", "deleted", "recover"]) {
        const file = path.join(history, id + ".json");
        await fs.writeFile(file, JSON.stringify(document(id)));
        const stat = await fs.stat(file);
        entries.push({
          id,
          title: id,
          createdAt: 1,
          updatedAt: 2,
          turnCount: 1,
          schemaVersion: 1,
          byteSize: stat.size,
          fileStamp: JSON.stringify([stat.size, stat.mtimeMs, null, null]),
        });
      }
      await fs.writeFile(
        path.join(dir, "conversation-index.json"),
        JSON.stringify({ schemaVersion: 1, updatedAt: 2, entries }),
      );
      await fs.writeFile(
        path.join(history, "changed.json"),
        JSON.stringify(document("changed", "new saved title")),
      );
      await fs.unlink(path.join(history, "deleted.json"));
      await fs.rename(
        path.join(history, "recover.json"),
        path.join(history, "recover.json.bak"),
      );
      await fs.writeFile(
        path.join(history, "orphan.json"),
        JSON.stringify(document("orphan")),
      );
      const result = await listConversationIndex();
      assert.sameMembers(
        result.map((entry) => entry.id),
        ["cached", "changed", "recover", "orphan"],
      );
      assert.equal(
        result.find((entry) => entry.id === "changed")?.title,
        "new saved title",
      );
      assert.notInclude(bodies, path.join(history, "cached.json"));
      assert.include(bodies, path.join(history, "changed.json"));
      assert.include(bodies, path.join(history, "orphan.json"));
      assert.include(bodies, path.join(history, "recover.json.bak"));
      assert.isTrue(await exists(path.join(history, "recover.json")));
      assert.isTrue(result.every((entry) => !!entry.fileStamp));
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete globals[name];
        else globals[name] = saved[index];
      });
      await fs.rm(profile, { recursive: true, force: true });
    }
  });
});

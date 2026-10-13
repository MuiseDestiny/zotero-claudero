import { assert } from "chai";
import {
  CONVERSATION_SCHEMA_VERSION,
  DEFAULT_CONVERSATION_STORAGE_POLICY,
  deleteConversation,
  exportConversationToFile,
  getClauderoDir,
  getConversationTitle,
  flushSavedData,
  loadConversationById,
  listConversations,
  saveConversationData,
  selectRetainedConversationEntries,
  type ConversationProviderState,
  type ConversationIndexEntry,
  type ConversationTurn,
} from "../src/modules/conversationStore";

describe("conversation store provider metadata", function () {
  it("recovers invalid message structures and mismatched IDs from the matching backup", async function () {
    const id = `structure-recovery-${Date.now()}`;
    const filePath = PathUtils.join(getClauderoDir(), "history", `${id}.json`);
    const turns: ConversationTurn[] = [
      { role: "user", text: "safe backup", ts: 100 },
    ];
    try {
      await saveConversationData(id, turns);
      const valid = JSON.parse(await IOUtils.readUTF8(filePath));
      await IOUtils.writeUTF8(`${filePath}.bak`, JSON.stringify(valid));
      const invalids = [
        { ...valid, turns: [null] },
        { ...valid, turns: [{ ...turns[0], text: 12 }] },
        { ...valid, turns: [{ ...turns[0], images: [null] }] },
        {
          ...valid,
          turns: [{ ...turns[0], contextSnapshot: { items: [null] } }],
        },
        {
          ...valid,
          turns: [{ ...turns[0], blocks: [{ type: "text", text: null }] }],
        },
        { ...valid, id: `${id}-other` },
      ];
      for (const invalid of invalids) {
        await IOUtils.writeUTF8(filePath, JSON.stringify(invalid));
        const recovered = await loadConversationById(id);
        assert.equal(recovered?.id, id);
        assert.deepEqual(recovered?.turns, turns);
      }
    } finally {
      await deleteConversation(id);
    }
  });

  it("never downgrades future-schema data or overwrites an unrecoverable conversation", async function () {
    const id = `future-schema-${Date.now()}`;
    const filePath = PathUtils.join(getClauderoDir(), "history", `${id}.json`);
    const turns: ConversationTurn[] = [
      { role: "user", text: "original", ts: 100 },
    ];
    try {
      await saveConversationData(id, turns);
      const valid = JSON.parse(await IOUtils.readUTF8(filePath));
      await IOUtils.writeUTF8(`${filePath}.bak`, JSON.stringify(valid));
      const future = JSON.stringify({
        ...valid,
        schemaVersion: CONVERSATION_SCHEMA_VERSION + 1,
        title: "future data",
      });
      await IOUtils.writeUTF8(filePath, future);
      const error = await loadConversationById(id).catch((error) => error);
      assert.include(error.message, "requires a newer");
      const saveError = await saveConversationData(id, turns).catch(
        (error) => error,
      );
      assert.include(saveError.message, "requires a newer");
      assert.equal(await IOUtils.readUTF8(filePath), future);
      await IOUtils.remove(`${filePath}.bak`);
      await IOUtils.writeUTF8(filePath, "{broken");
      const corruptError = await saveConversationData(id, turns).catch(
        (error) => error,
      );
      assert.include(corruptError.message, "unreadable");
      assert.equal(await IOUtils.readUTF8(filePath), "{broken");
    } finally {
      await deleteConversation(id);
    }
  });

  it("serializes title reads with a pending atomic save", async function () {
    const id = `queued-title-${Date.now()}`;
    const filePath = PathUtils.join(getClauderoDir(), "history", `${id}.json`);
    const originalWrite = IOUtils.writeUTF8;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let write: Promise<unknown> | undefined;
    try {
      IOUtils.writeUTF8 = async (...args) => {
        if (args[0] === filePath) {
          entered();
          await gate;
        }
        return originalWrite.apply(IOUtils, args);
      };
      write = saveConversationData(id, [
        { role: "user", text: "queued title", ts: Date.now() },
      ]);
      await waiting;
      let resolved = false;
      const title = getConversationTitle(id).then((value) => {
        resolved = true;
        return value;
      });
      let flushed = false;
      const flushing = flushSavedData().then(() => {
        flushed = true;
      });
      await Zotero.Promise.delay(10);
      assert.isFalse(
        resolved,
        "Reads must wait for the in-flight atomic write",
      );
      assert.isFalse(
        flushed,
        "Shutdown must wait for pending snapshots to reach disk",
      );
      release();
      await write;
      assert.equal(await title, "queued title");
      await flushing;
      assert.isTrue(flushed);
    } finally {
      release();
      await write?.catch(() => {});
      IOUtils.writeUTF8 = originalWrite;
      await deleteConversation(id);
    }
  });

  it("deletes quarantined copies only for the exact conversation ID", async function () {
    const id = `quarantine-prefix-${Date.now()}`;
    const sibling = `${id}-other`;
    const dir = PathUtils.join(getClauderoDir(), "history", "corrupt");
    const own = PathUtils.join(dir, `${id}-123-primary.json`);
    const other = PathUtils.join(dir, `${sibling}-123-primary.json`);
    try {
      await IOUtils.makeDirectory(dir, { createAncestors: true });
      await IOUtils.writeUTF8(own, "own backup");
      await IOUtils.writeUTF8(other, "other backup");
      await deleteConversation(id);
      assert.isFalse(await IOUtils.exists(own));
      assert.equal(await IOUtils.readUTF8(other), "other backup");
    } finally {
      await deleteConversation(id);
      await deleteConversation(sibling);
    }
  });

  it("persists and preserves provider session metadata", async function () {
    const id = `provider-state-${Date.now()}`;
    const turns: ConversationTurn[] = [
      {
        role: "user",
        text: "Start a Codex task",
        ts: 100,
        provider: "codex",
      },
    ];
    const providerState: ConversationProviderState = {
      claude: { sessionId: "claude-session-1" },
      codex: {
        threadId: "codex-thread-1",
        sessionFilePath: "/tmp/codex-thread-1.json",
        forkSource: {
          threadId: "parent-thread",
          resumeAt: "turn-1",
          sourceConversationId: "parent-conv",
        },
      },
    };

    try {
      await deleteConversation(id);
      await saveConversationData(id, turns, {
        providerState,
        parentConversationId: "parent-conv",
        forkedAtTurnIndex: 0,
        compactedAt: 1234,
      });

      let saved = (await listConversations()).find((conv) => conv.id === id);
      assert.deepEqual(saved?.providerState, providerState);
      assert.equal(saved?.parentConversationId, "parent-conv");
      assert.equal(saved?.forkedAtTurnIndex, 0);
      assert.equal(saved?.compactedAt, 1234);

      await saveConversationData(id, [
        ...turns,
        {
          role: "assistant",
          text: "Done",
          ts: 200,
          provider: "codex",
        },
      ]);

      saved = (await listConversations()).find((conv) => conv.id === id);
      assert.deepEqual(saved?.providerState, providerState);
      assert.equal(saved?.parentConversationId, "parent-conv");
      assert.equal(saved?.forkedAtTurnIndex, 0);
      assert.equal(saved?.compactedAt, 1234);
    } finally {
      await deleteConversation(id);
    }
  });

  it("restores a corrupt primary file from the last atomic backup", async function () {
    const id = `backup-recovery-${Date.now()}`;
    const filePath = PathUtils.join(getClauderoDir(), "history", `${id}.json`);
    let step = "initial cleanup";
    try {
      await deleteConversation(id);
      step = "first save";
      await saveConversationData(id, [
        { role: "user", text: "first durable turn", ts: 100 },
      ]);
      step = "second save";
      await saveConversationData(id, [
        { role: "user", text: "first durable turn", ts: 100 },
        { role: "assistant", text: "second durable turn", ts: 200 },
      ]);
      step = "backup existence";
      assert.isTrue(
        await IOUtils.exists(`${filePath}.bak`),
        "the second atomic write should retain the previous primary",
      );

      step = "primary corruption";
      await IOUtils.writeUTF8(filePath, "{corrupt-json");
      step = "list and restore";
      const restored = (await listConversations()).find(
        (conversation) => conversation.id === id,
      );
      step = "restored turn count";
      assert.equal(restored?.turns.length, 1);
      step = "restored turn content";
      assert.equal(restored?.turns[0]?.text, "first durable turn");
      step = "restored schema";
      assert.equal(restored?.schemaVersion, CONVERSATION_SCHEMA_VERSION);
      step = "restored primary JSON";
      assert.isObject(JSON.parse(await IOUtils.readUTF8(filePath)));
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${error.name}: ${error.message}${error.stack ? ` | ${error.stack}` : ""}`
          : String(error);
      throw new Error(`backup recovery failed at ${step}: ${detail}`);
    } finally {
      try {
        await deleteConversation(id);
      } catch (error) {
        Zotero.debug(`[Test cleanup] backup recovery: ${String(error)}`);
      }
    }
  });

  it("migrates legacy conversation JSON to the current schema", async function () {
    const id = `schema-migration-${Date.now()}`;
    const filePath = PathUtils.join(getClauderoDir(), "history", `${id}.json`);
    try {
      await saveConversationData(id, [
        { role: "user", text: "legacy schema", ts: 100 },
      ]);
      const legacy = JSON.parse(await IOUtils.readUTF8(filePath)) as Record<
        string,
        unknown
      >;
      delete legacy.schemaVersion;
      await IOUtils.writeUTF8(filePath, JSON.stringify(legacy));

      const migrated = (await listConversations()).find(
        (conversation) => conversation.id === id,
      );
      assert.equal(migrated?.schemaVersion, CONVERSATION_SCHEMA_VERSION);
      const persisted = JSON.parse(await IOUtils.readUTF8(filePath)) as {
        schemaVersion?: number;
      };
      assert.equal(persisted.schemaVersion, CONVERSATION_SCHEMA_VERSION);
    } finally {
      await deleteConversation(id);
    }
  });

  it("exports a versioned portable document and permanently deletes all local copies", async function () {
    const id = `export-delete-${Date.now()}`;
    const historyPath = PathUtils.join(
      getClauderoDir(),
      "history",
      `${id}.json`,
    );
    const exportPath = PathUtils.join(getClauderoDir(), `${id}-export.json`);
    try {
      await saveConversationData(id, [
        { role: "user", text: "export me", ts: 100 },
      ]);
      await saveConversationData(id, [
        { role: "user", text: "export me", ts: 100 },
        { role: "assistant", text: "exported", ts: 200 },
      ]);
      await exportConversationToFile(id, exportPath);
      const exported = JSON.parse(await IOUtils.readUTF8(exportPath)) as {
        format?: string;
        exportVersion?: number;
        conversation?: { id?: string; schemaVersion?: number };
      };
      assert.equal(exported.format, "claudero-conversation");
      assert.equal(exported.exportVersion, 1);
      assert.equal(exported.conversation?.id, id);
      assert.equal(
        exported.conversation?.schemaVersion,
        CONVERSATION_SCHEMA_VERSION,
      );

      await deleteConversation(id);
      assert.isFalse(await IOUtils.exists(historyPath));
      assert.isFalse(await IOUtils.exists(`${historyPath}.bak`));
      assert.isFalse(await IOUtils.exists(`${historyPath}.tmp`));
    } finally {
      await deleteConversation(id);
      if (await IOUtils.exists(exportPath)) await IOUtils.remove(exportPath);
      if (await IOUtils.exists(`${exportPath}.tmp`)) {
        await IOUtils.remove(`${exportPath}.tmp`);
      }
    }
  });

  it("enforces age, count, and total-byte retention while protecting the active conversation", function () {
    const now = Date.now();
    const entry = (
      id: string,
      updatedAt: number,
      byteSize: number,
    ): ConversationIndexEntry => ({
      id,
      title: id,
      createdAt: updatedAt,
      updatedAt,
      turnCount: 1,
      byteSize,
    });
    const policy = {
      ...DEFAULT_CONVERSATION_STORAGE_POLICY,
      maxConversations: 2,
      maxAgeDays: 30,
      maxTotalBytes: 100,
    };
    const result = selectRetainedConversationEntries(
      [
        entry("active", now - 90 * 86_400_000, 20),
        entry("newest", now, 50),
        entry("over-quota", now - 1_000, 50),
        entry("expired", now - 40 * 86_400_000, 10),
      ],
      policy,
      "active",
      now,
    );
    assert.deepEqual(
      result.retained.map((item) => item.id),
      ["newest", "active"],
    );
    assert.sameMembers(
      result.removed.map((item) => item.id),
      ["over-quota", "expired"],
    );
  });
});

import { assert } from "chai";
import {
  CONVERSATION_SCHEMA_VERSION,
  DEFAULT_CONVERSATION_STORAGE_POLICY,
  deleteConversation,
  exportConversationToFile,
  getClauderoDir,
  listConversations,
  saveConversationData,
  selectRetainedConversationEntries,
  type ConversationProviderState,
  type ConversationIndexEntry,
  type ConversationTurn,
} from "../src/modules/conversationStore";

describe("conversation store provider metadata", function () {
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

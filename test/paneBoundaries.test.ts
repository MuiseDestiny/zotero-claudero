import { assert } from "chai";
import type { SavedConversation } from "../src/modules/conversationStore";
import { invalidateConversation } from "../src/modules/conversationTransition";
import { createPaneConversationActions } from "../src/modules/paneConversationActions";
import { closeContextDetailPopup } from "../src/modules/paneContextView";
import { cloneImages, renderPendingImages } from "../src/modules/paneImageView";
import { createPaneMessageView } from "../src/modules/paneMessageView";
import {
  getSelectedEffort,
  getSelectedModel,
  normalizePermissionMode,
} from "../src/modules/paneModelControls";
import type { PaneState } from "../src/modules/paneState";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
} from "../src/modules/providerRegistry";
import { createPaneTestState, paneTestElement } from "./paneTestState";
import { installUiTestContext } from "./uiTestContext";

type ActionHost = Parameters<typeof createPaneConversationActions>[0];
type Persistence = NonNullable<
  Parameters<typeof createPaneConversationActions>[1]
>;
const context = {
  generatedAt: "2026-09-25T00:00:00Z",
  selectedType: "reader",
  selectedTabID: "test-reader",
  items: [],
  selectedText: "Saved excerpt",
};
const image = { id: "image-one", mediaType: "image/png", data: "aGVsbG8=" };

describe("extracted pane boundaries", function () {
  let state: PaneState;
  let restore: () => void;

  beforeEach(function () {
    restore = installUiTestContext();
    state = createPaneTestState();
  });

  afterEach(function () {
    closeContextDetailPopup(state.root.ownerDocument!);
    state.disposed = true;
    state.root.remove();
    restore();
  });

  describe("message and composer views", function () {
    let calls: Array<[string, PaneState, number | undefined]>;
    let view: ReturnType<typeof createPaneMessageView>;

    beforeEach(function () {
      calls = [];
      view = createPaneMessageView({
        retryAssistantTurn: async (s, index) => {
          calls.push(["retry", s, index]);
          return true;
        },
        forkConversationAtTurn: async (s, index) => {
          calls.push(["fork", s, index]);
        },
        editLastUserTurn: async (s, index) => {
          calls.push(["edit", s, index]);
        },
        createThinkingChevron: () => paneTestElement("span"),
      });
      assert.isEmpty(
        calls,
        "factory construction must not invoke deferred commands",
      );
    });

    it("routes retry, fork and edit to injected commands with the original turn", function () {
      state.conversationTurns.push(
        { role: "user", text: "Next question", ts: 300 },
        { role: "assistant", text: "Next answer", ts: 400 },
      );
      view.renderConversationTurns(state);
      for (const action of ["retry", "fork", "edit"]) {
        state.transcript
          .querySelector<HTMLButtonElement>(
            `[data-claudero-message-action="${action}"]`,
          )!
          .click();
      }
      assert.deepEqual(
        calls.map(([action, s, index]) => [action, s === state, index]),
        [
          ["retry", true, 1],
          ["fork", true, 1],
          ["edit", true, 2],
        ],
      );
      assert.lengthOf(
        state.transcript.querySelectorAll(
          '[data-claudero-message-action="edit"]',
        ),
        1,
      );
      view.refreshEditableMessageActions(state);
      assert.isNull(
        state.transcript.querySelector('[data-claudero-message-action="edit"]'),
      );
    });

    it("restores saved context, thinking and structured text without duplicate answers", function () {
      state.conversationTurns[0].contextSnapshot = context;
      state.conversationTurns[1].blocks = [
        { type: "thinking", text: "Checking evidence", durationMs: 1000 },
        { type: "text", text: "Answer" },
      ];
      view.renderConversationTurns(state);
      assert.lengthOf(
        state.transcript.querySelectorAll(".claudero-message.assistant"),
        1,
      );
      const thinking = state.transcript.querySelector(
        ".claudero-thinking-card",
      )!;
      assert.include(thinking.textContent, "Checking evidence");
      assert.isTrue(thinking.classList.contains("done"));
      const chip = state.transcript.querySelector<HTMLButtonElement>(
        ".claudero-message-context-summary",
      )!;
      assert.isNotNull(chip);
      chip.click();
      assert.include(
        document.querySelector(".claudero-context-detail-popup")!.textContent,
        "Saved excerpt",
      );
      view.renderConversationTurns(state);
      assert.lengthOf(
        state.transcript.querySelectorAll(".claudero-message.assistant"),
        1,
      );
    });

    it("restores failure actions and ignores clicks from an old conversation", async function () {
      state.conversationTurns[1].text = "";
      state.conversationTurns[1].blocks = [
        {
          type: "notice",
          kind: "warning",
          title: "Failed",
          text: "Offline",
          failureMessage: "fetch failed",
        },
      ];
      view.renderConversationTurns(state);
      const button = state.transcript.querySelector<HTMLButtonElement>(
        ".claudero-notice-card button",
      )!;
      assert.isNotNull(button);
      button.click();
      await Zotero.Promise.delay(0);
      assert.deepEqual(
        calls.map(([action, , index]) => [action, index]),
        [["retry", 1]],
      );
      state.conversationId = "replacement";
      button.click();
      assert.lengthOf(calls, 1);
    });

    it("keeps streaming cards action-free until explicitly finalized", function () {
      const body = view.appendMessageCard(state, "assistant", "Partial");
      const card = body.closest<HTMLElement>(".claudero-message")!;
      assert.isNull(state.transcript.querySelector(".claudero-message-meta"));
      card.classList.remove("streaming");
      view.attachMessageActions(state, card, "assistant", "Complete", {
        turnIndex: 1,
      });
      view.attachMessageActions(state, card, "assistant", "Complete", {
        turnIndex: 1,
      });
      assert.lengthOf(
        state.transcript.querySelectorAll(".claudero-message-meta"),
        1,
      );
    });

    it("removes image drafts without mutating saved attachments or leaving previews", function () {
      const saved = [{ ...image }];
      state.pendingImages = cloneImages(saved);
      renderPendingImages(state);
      const thumb = state.root.querySelector<HTMLElement>(
        ".claudero-img-thumb",
      )!;
      thumb.dispatchEvent(new window.MouseEvent("mouseenter"));
      assert.isNotNull(state.root.querySelector(".claudero-img-preview"));
      thumb.querySelector<HTMLButtonElement>("button")!.click();
      assert.isEmpty(state.pendingImages);
      assert.deepEqual(saved, [image]);
      assert.isNull(state.root.querySelector(".claudero-img-preview"));
      assert.equal(state.pendingImagesBar!.style.display, "none");
    });

    it("retains provider-specific defaults and explicit model selections", function () {
      for (const provider of ["claude", "codex", "deepseek"] as const) {
        state.providerSelect.value = provider;
        assert.equal(
          getSelectedModel(state),
          defaultModelForProvider(provider),
        );
        assert.equal(
          getSelectedEffort(state),
          defaultEffortForProvider(provider),
        );
      }
      state.modelSelect.value = "custom-model";
      state.effortSelect.value = "custom-effort";
      assert.equal(getSelectedModel(state), "custom-model");
      assert.equal(getSelectedEffort(state), "custom-effort");
      assert.equal(normalizePermissionMode("plan"), "plan");
      assert.equal(normalizePermissionMode("unknown"), "auto");
    });
  });

  describe("conversation action lifecycle", function () {
    let events: string[];
    let host: ActionHost;
    let storage: Persistence;
    let originalConfirm: Window["confirm"];
    let loaded: SavedConversation;

    beforeEach(function () {
      events = [];
      loaded = {
        schemaVersion: 1,
        id: "loaded",
        title: "Loaded",
        createdAt: 1,
        updatedAt: 2,
        turns: [{ role: "user", text: "Loaded question", ts: 1 }],
      };
      host = {
        renderConversationTurns: () => {
          events.push("render");
        },
        getLastEditableUserTurnIndex: () => 0,
        sendPrompt: async () => {
          events.push("send");
        },
        updateSendButton: () => {
          events.push("composer");
        },
        appendWelcomeCard: () => {
          events.push("welcome");
        },
        pushAssistantBlock: (s, block) => {
          s.currentAssistantBlocks.push(block);
        },
      };
      storage = {
        saveCurrentConversation: async () => {
          events.push("save-original");
          return { committed: true };
        },
        saveConversationData: async () => {
          events.push("save-child");
          return { committed: true };
        },
        loadConversationById: async () => loaded,
        loadLatestConversation: async () => loaded,
      };
      originalConfirm = window.confirm;
      window.confirm = () => true;
    });

    afterEach(function () {
      window.confirm = originalConfirm;
    });

    it("does not save, fork or send when fresh recovery is declined", async function () {
      window.confirm = () => false;
      const actions = createPaneConversationActions(host, storage);
      assert.isEmpty(events);
      assert.isFalse(await actions.retryAssistantTurn(state, 1));
      assert.isEmpty(events);
      assert.equal(state.conversationId, "pane-test-original");
      assert.isUndefined(state.conversationTransition);
    });

    it("saves before applying a detached retry and clears its recovery marker", async function () {
      const originalTurns = state.conversationTurns;
      originalTurns[0].images = [image];
      originalTurns[0].contextSnapshot = context;
      storage.saveConversationData = async (id, turns, metadata) => {
        assert.equal(state.conversationId, "pane-test-original");
        assert.notEqual(id, state.conversationId);
        assert.isEmpty(turns);
        assert.equal(metadata?.parentConversationId, state.conversationId);
        events.push("save-child");
        return { committed: true };
      };
      host.sendPrompt = async (s, text, images, snapshot) => {
        assert.equal(text, "Question");
        assert.deepEqual(images, [image]);
        assert.notStrictEqual(images![0], image);
        assert.deepEqual(snapshot, context);
        assert.isUndefined(s.conversationTransition);
        assert.equal(s.pendingRecovery?.conversationId, s.conversationId);
        events.push("send");
      };
      assert.isTrue(
        await createPaneConversationActions(host, storage).retryAssistantTurn(
          state,
          1,
        ),
      );
      assert.deepEqual(events, [
        "save-original",
        "save-child",
        "render",
        "send",
      ]);
      assert.equal(state.parentConversationId, "pane-test-original");
      assert.lengthOf(originalTurns, 2);
      assert.isUndefined(state.pendingRecovery);
      assert.isUndefined(state.conversationTransition);
    });

    it("leaves the original intact on either persistence failure", async function () {
      for (const failing of [
        "saveCurrentConversation",
        "saveConversationData",
      ] as const) {
        const failingStorage = {
          ...storage,
          [failing]: async () => {
            throw new Error("Test storage unavailable");
          },
        };
        assert.isFalse(
          await createPaneConversationActions(
            host,
            failingStorage,
          ).retryAssistantTurn(state, 1),
        );
        assert.equal(state.conversationId, "pane-test-original");
        assert.lengthOf(state.conversationTurns, 2);
        assert.isUndefined(state.conversationTransition);
      }
      assert.notInclude(events, "render");
      assert.notInclude(events, "send");
    });

    it("discards delayed restores after the conversation generation changes", async function () {
      let resolve!: (value: SavedConversation) => void;
      storage.loadConversationById = () =>
        new Promise((r) => {
          resolve = r;
        });
      const pending = createPaneConversationActions(
        host,
        storage,
      ).restoreConversation(state, loaded);
      invalidateConversation(state);
      resolve(loaded);
      await pending;
      assert.equal(state.conversationId, "pane-test-original");
      assert.isEmpty(events);
      assert.isUndefined(state.conversationTransition);
    });

    it("blocks concurrent transitions and drops a stale detached save result", async function () {
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      storage.saveConversationData = async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { committed: true };
      };
      const actions = createPaneConversationActions(host, storage);
      const pending = actions.retryAssistantTurn(state, 1);
      await waiting;
      assert.isFalse(await actions.retryAssistantTurn(state, 1));
      state.disposed = true;
      release();
      assert.isFalse(await pending);
      assert.equal(state.conversationId, "pane-test-original");
      assert.deepEqual(events, ["save-original"]);
      assert.isUndefined(state.conversationTransition);
    });

    it("edits a saved detached draft without sending or mutating saved images", async function () {
      state.conversationTurns[0].images = [image];
      await createPaneConversationActions(host, storage).editLastUserTurn(
        state,
        0,
      );
      assert.deepEqual(events, [
        "save-original",
        "save-child",
        "render",
        "composer",
      ]);
      assert.equal(state.input.value, "Question");
      assert.deepEqual(state.pendingImages, [image]);
      state.pendingImages[0].data = "changed";
      assert.equal(image.data, "aGVsbG8=");
    });

    it("clears pending recovery and releases the transition after a send failure", async function () {
      host.sendPrompt = async () => {
        throw new Error("Test interrupted");
      };
      let error: unknown;
      try {
        await createPaneConversationActions(host, storage).retryAssistantTurn(
          state,
          1,
        );
      } catch (e) {
        error = e;
      }
      assert.instanceOf(error, Error);
      assert.isUndefined(state.pendingRecovery);
      assert.isUndefined(state.conversationTransition);
    });

    it("reports recovery only once for matching nonempty successful output", function () {
      const actions = createPaneConversationActions(host, storage);
      state.pendingRecovery = {
        conversationId: state.conversationId,
        provider: "codex",
      };
      actions.reportRecoverySuccess(state, "codex");
      state.lastAssistantText = "Recovered";
      actions.reportRecoverySuccess(state, "claude");
      assert.isEmpty(state.currentAssistantBlocks);
      actions.reportRecoverySuccess(state, "codex");
      actions.reportRecoverySuccess(state, "codex");
      assert.lengthOf(state.currentAssistantBlocks, 1);
      assert.equal(state.currentAssistantBlocks[0].type, "notice");
      assert.isUndefined(state.pendingRecovery);
    });

    it("does not overwrite newly entered history during a delayed startup restore", async function () {
      state.conversationTurns = [];
      let resolve!: (value: SavedConversation) => void;
      storage.loadLatestConversation = () =>
        new Promise((r) => {
          resolve = r;
        });
      const pending = createPaneConversationActions(
        host,
        storage,
      ).restoreLatestConversation(state);
      state.conversationTurns.push({
        role: "user",
        text: "New input",
        ts: 500,
      });
      resolve(loaded);
      await pending;
      assert.equal(state.conversationTurns[0].text, "New input");
      assert.isEmpty(events);
    });
  });
});

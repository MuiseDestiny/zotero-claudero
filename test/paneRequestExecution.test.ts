import { assert } from "chai";
import { invalidateConversation } from "../src/modules/conversationTransition";
import {
  createRequestFixture,
  deferred,
  type RequestKind,
} from "./paneRequestFixture";
import { installUiTestContext } from "./uiTestContext";

describe("pane request execution boundaries", function () {
  let fixture: ReturnType<typeof createRequestFixture>;
  let restore: () => void;

  beforeEach(function () {
    restore = installUiTestContext();
    fixture = createRequestFixture();
  });

  afterEach(function () {
    fixture.dispose();
    restore();
  });

  function assertReleased() {
    const { state, calls } = fixture;
    assert.isFalse(state.running);
    assert.isUndefined(state.activeRequestId);
    assert.isUndefined(state.requestController);
    assert.isUndefined(state.finalizeRequest);
    assert.isNull(state.thinkingTimer);
    assert.isNull(state.thinkingEl);
    assert.deepEqual(calls.polling, ["start", "stop"]);
    assert.deepEqual(calls.running, [true, false]);
  }

  for (const kind of ["prompt", "slash"] as RequestKind[]) {
    // Both executors must satisfy the same lifetime guarantees.
    describe(kind, function () {
      it("constructs without executing callbacks and rejects unavailable panes", async function () {
        fixture.executors();
        assert.isEmpty(fixture.calls.requests);
        assert.isEmpty(fixture.calls.running);
        for (const flag of [
          "running",
          "disposed",
          "conversationTransition",
        ] as const) {
          Object.assign(fixture.state, {
            [flag]: flag === "conversationTransition" ? Symbol() : true,
          });
          await fixture.run(kind);
          Object.assign(fixture.state, {
            [flag]: flag === "conversationTransition" ? undefined : false,
          });
        }
        assert.isEmpty(fixture.calls.requests);
        assert.isEmpty(fixture.calls.saves);
      });

      it("persists successful streamed snapshots exactly once and releases resources", async function () {
        const { state, calls, control } = fixture;
        state.pendingRecovery = {
          conversationId: state.conversationId,
          provider: "codex",
        };
        control.stream = async function* (options) {
          yield {
            type: "session",
            session: {
              provider: "codex",
              threadId: "resumed-thread",
              turnId: "turn-one",
            },
          };
          yield { type: "text_delta", text: "Partial answer" };
          yield { type: "text_snapshot", text: "Final answer" };
          yield {
            type: "done",
            requestId: options.requestId!,
            outcome: "success",
          };
        };
        await fixture.run(kind);
        assert.lengthOf(calls.saves, 1);
        assert.lengthOf(state.conversationTurns, 2);
        assert.equal(state.conversationTurns[1].text, "Final answer");
        assert.equal(state.conversationTurns[1].assistantMessageId, "turn-one");
        assert.equal(state.providerState?.codex?.threadId, "resumed-thread");
        assert.isUndefined(state.pendingRecovery);
        assert.equal(calls.recovery, 1);
        assert.notInclude(state.transcript.textContent, "Partial answer");
        assertReleased();
      });

      it("retains partial output after disconnect without retrying or claiming recovery", async function () {
        const { state, control, calls } = fixture;
        state.providerState = {
          codex: { threadId: "failed" },
          claude: { sessionId: "keep" },
        };
        control.stream = async function* () {
          yield { type: "text_delta", text: "Partial output" };
          throw new Error("fetch failed");
        };
        await fixture.run(kind);
        assert.lengthOf(calls.requests, 1);
        assert.lengthOf(calls.saves, 1);
        assert.equal(state.conversationTurns[1].text, "Partial output");
        const failure = state.conversationTurns[1].blocks?.find(
          (b) => b.type === "notice",
        );
        assert.equal(
          failure?.type === "notice" && failure.failureMessage,
          "fetch failed",
        );
        assert.isUndefined(state.providerState?.codex);
        assert.equal(state.providerState?.claude?.sessionId, "keep");
        assert.equal(calls.recovery, 0);
        assert.isEmpty(calls.retries);
        assertReleased();
        const retry = state.transcript.querySelector<HTMLButtonElement>(
          ".claudero-notice-card button",
        )!;
        assert.isNotNull(retry);
        retry.click();
        await Zotero.Promise.delay(0);
        assert.deepEqual(calls.retries, [1]);
      });

      it("treats an unsuccessful terminal event as failure rather than completion", async function () {
        fixture.control.stream = async function* (options) {
          yield { type: "error", error: "CLI upgrade interrupted the session" };
          yield {
            type: "done",
            requestId: options.requestId!,
            outcome: "error",
          };
        };
        await fixture.run(kind);
        assert.equal(fixture.calls.recovery, 0);
        assert.isEmpty(fixture.calls.titles);
        assert.lengthOf(fixture.calls.saves, 1);
        assert.include(fixture.state.statusDot.className, "error");
        assertReleased();
      });

      it("honors cancellation while streaming and ignores late output", async function () {
        const entered = deferred<void>(),
          release = deferred<void>();
        const { state, calls, control } = fixture;
        control.stream = async function* () {
          yield { type: "text_delta", text: "Retained partial" };
          entered.resolve();
          await release.promise;
          yield { type: "text_delta", text: "Late unwanted output" };
        };
        const request = fixture.run(kind);
        await entered.promise;
        state.cancelRequested = true;
        state.requestController!.abort();
        release.resolve();
        await request;
        assert.isTrue(calls.requests[0].options.signal!.aborted);
        assert.lengthOf(calls.saves, 1);
        assert.equal(state.conversationTurns[1].text, "Retained partial");
        assert.notInclude(state.transcript.textContent, "Late unwanted output");
        assert.equal(calls.recovery, 0);
        assert.isNull(
          state.transcript.querySelector(".claudero-notice-card button"),
        );
        assertReleased();
      });

      it("commits once when closing mid-turn and ignores the resumed network callback", async function () {
        const entered = deferred<void>(),
          release = deferred<void>();
        const { state, control, calls } = fixture;
        control.stream = async function* (options) {
          yield { type: "text_delta", text: "Saved before close" };
          entered.resolve();
          await release.promise;
          yield {
            type: "done",
            requestId: options.requestId!,
            outcome: "success",
          };
        };
        const request = fixture.run(kind);
        await entered.promise;
        state.cancelRequested = true;
        state.finalizeRequest!();
        state.finalizeRequest!();
        state.disposed = true;
        state.requestController!.abort();
        release.resolve();
        await request;
        assert.lengthOf(calls.saves, 1);
        assert.lengthOf(state.conversationTurns, 2);
        assert.equal(state.conversationTurns[1].text, "Saved before close");
        assert.equal(calls.recovery, 0);
        assertReleased();
      });

      it("does not persist stale events into a replacement conversation", async function () {
        const entered = deferred<void>(),
          release = deferred<void>();
        const { state, calls, control } = fixture;
        control.stream = async function* () {
          entered.resolve();
          await release.promise;
          yield { type: "text_delta", text: "From the old conversation" };
        };
        const request = fixture.run(kind);
        await entered.promise;
        invalidateConversation(state);
        state.conversationId = "replacement";
        state.conversationTurns = [
          { role: "user", text: "New conversation", ts: 1 },
        ];
        release.resolve();
        await request;
        assert.lengthOf(state.conversationTurns, 1);
        assert.equal(state.conversationTurns[0].text, "New conversation");
        assert.notInclude(
          state.transcript.textContent,
          "From the old conversation",
        );
        assert.isEmpty(calls.saves);
      });

      it("rejects a second submission while the first stream is active", async function () {
        const entered = deferred<void>(),
          release = deferred<void>();
        fixture.control.stream = async function* (options) {
          entered.resolve();
          await release.promise;
          yield { type: "text_delta", text: "Only one answer" };
          yield {
            type: "done",
            requestId: options.requestId!,
            outcome: "success",
          };
        };
        const pending = fixture.run(kind);
        await entered.promise;
        try {
          await fixture.run(kind);
          assert.lengthOf(fixture.calls.requests, 1);
          assert.isEmpty(fixture.calls.saves);
        } finally {
          release.resolve();
          await pending;
        }
        assert.lengthOf(fixture.calls.saves, 1);
        assert.lengthOf(fixture.state.conversationTurns, 2);
        assertReleased();
      });

      it("preserves reconnect feedback and sends command discovery through the host", async function () {
        const { state, calls, control } = fixture;
        control.stream = async function* (options) {
          yield {
            type: "connection_status",
            status: "reconnecting",
            attempt: 1,
            maxAttempts: 3,
          };
          assert.equal(state.activityMode, "waiting");
          yield {
            type: "commands_changed",
            commands: [
              {
                name: "inspect",
                description: "Inspect a paper",
                argumentHint: "paper",
              },
            ],
          };
          yield { type: "text_delta", text: "Reconnected" };
          yield {
            type: "done",
            requestId: options.requestId!,
            outcome: "success",
          };
        };
        await fixture.run(kind);
        assert.deepEqual(calls.commands, [
          [
            {
              name: "inspect",
              description: "Inspect a paper",
              isBuiltin: false,
              argumentHint: "paper",
            },
          ],
        ]);
        assert.equal(state.conversationTurns[1].text, "Reconnected");
        assert.lengthOf(calls.requests, 1);
      });
    });
  }

  it("wraps prompts with context and images but never wraps raw SDK commands", async function () {
    fixture.state.pendingImages = [
      { id: "image", mediaType: "image/png", data: "aGVsbG8=" },
    ];
    await fixture.run("prompt");
    const prompt = fixture.calls.requests[0];
    assert.include(prompt.prompt, "Explain this paper");
    assert.include(prompt.prompt, "Saved context excerpt");
    assert.deepEqual(prompt.options.additionalDirectories, ["/test/papers"]);
    assert.deepEqual(prompt.options.images, [
      { media_type: "image/png", data: "aGVsbG8=" },
    ]);
    assert.equal(fixture.calls.contextReads, 1);
    await fixture.run("slash");
    const raw = fixture.calls.requests[1];
    assert.equal(raw.prompt, "/compact");
    assert.isUndefined(raw.options.images);
    assert.isUndefined(raw.options.additionalDirectories);
    assert.equal(fixture.calls.contextReads, 1);
  });

  it("routes slash input through the composer without reading Zotero context", async function () {
    const finished = deferred<void>();
    fixture.control.stream = async function* (options) {
      yield { type: "done", requestId: options.requestId!, outcome: "success" };
      finished.resolve();
    };
    fixture.state.input.value = " /compact ";
    await fixture.executors().prompt(fixture.state);
    await finished.promise;
    await Zotero.Promise.delay(0);
    assert.equal(fixture.calls.requests[0].prompt, "/compact");
    assert.equal(fixture.calls.contextReads, 0);
    assert.equal(fixture.state.input.value, "");
    assert.equal(fixture.state.inputHistory[0].text, "/compact");
  });

  it("does not submit if cancelled while context collection is pending", async function () {
    const entered = deferred<void>(),
      context = deferred<typeof fixture.context>();
    fixture.control.context = () => {
      entered.resolve();
      return context.promise;
    };
    const request = fixture.run("prompt");
    await entered.promise;
    fixture.state.cancelRequested = true;
    fixture.state.requestController!.abort();
    context.resolve(fixture.context);
    await request;
    assert.isEmpty(fixture.calls.requests);
    assert.lengthOf(fixture.calls.saves, 1);
    assertReleased();
  });

  it("reuses saved context for explicit retries rather than recapturing selection", async function () {
    await fixture
      .executors()
      .prompt(fixture.state, "Retry question", [], fixture.context);
    assert.equal(fixture.calls.contextReads, 0);
    assert.include(fixture.calls.requests[0].prompt, "Saved context excerpt");
    assert.deepEqual(
      fixture.state.conversationTurns[0].contextSnapshot,
      fixture.context,
    );
  });
});

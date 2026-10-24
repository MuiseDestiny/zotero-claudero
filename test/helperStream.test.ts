import { assert } from "chai";
import { streamResponseEvents } from "../src/shared/helperStream";
import { MAX_HELPER_EVENT_BYTES } from "../src/shared/helperProtocol";

describe("bounded helper event stream", function () {
  const done = { type: "done", requestId: "r1", outcome: "success" };
  const encoder = new TextEncoder();
  const read = async (response: Response, signal?: AbortSignal) => {
    const events = [];
    for await (const event of streamResponseEvents(response, "r1", signal))
      events.push(event);
    return events;
  };
  const failure = async (body: string | Uint8Array, message: RegExp) => {
    const error = await read(new Response(body)).then(
      () => null,
      (error) => error,
    );
    assert.match(String(error), message);
  };

  it("handles split UTF-8 code points, CRLF, blank lines, and EOF after done", async function () {
    const text = "\u7814\u7a76\ud83d\udcda";
    const bytes = encoder.encode(
      `\r\n${JSON.stringify({ type: "text_delta", text })}\r\n${JSON.stringify(done)}`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    assert.deepEqual(await read(new Response(stream)), [
      { type: "text_delta", text },
      done,
    ]);
  });

  it("rejects oversized unterminated frames and cancels the reader", async function () {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_HELPER_EVENT_BYTES).fill(32));
        controller.enqueue(Uint8Array.of(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await read(new Response(stream)).catch((error) => error);
    assert.match(String(error), /frame limit/);
    assert.isTrue(cancelled);
    assert.isFalse(stream.locked);
  });

  it("counts encoded bytes, not characters, before parsing a frame", async function () {
    await failure(
      JSON.stringify({
        type: "text",
        text: "\u7814".repeat(Math.ceil(MAX_HELPER_EVENT_BYTES / 3)),
      }) + "\n",
      /frame limit/,
    );
  });

  it("limits each frame rather than the total response size", async function () {
    const frame = JSON.stringify({
      type: "text_delta",
      text: "x".repeat(MAX_HELPER_EVENT_BYTES / 2),
    });
    const events = await read(
      new Response(`${frame}\n${frame}\n${JSON.stringify(done)}\n`),
    );
    assert.lengthOf(events, 3);
  });

  it("rejects malformed fields, JSON, UTF-8, and invalid terminal sequences", async function () {
    await failure('{"type":"text","text":{}}\n', /Invalid helper event/);
    await failure('{"type":"text"\n', /SyntaxError/);
    await failure(Uint8Array.of(0xff, 10), /encoded data|encoding/i);
    await failure(
      '{"type":"ready","requestId":"other"}\n',
      /request ID mismatch/,
    );
    await failure(
      JSON.stringify(done) + '\n{"type":"text","text":"late"}\n',
      /after its terminal/,
    );
    await failure(
      '{"type":"error","error":"failed"}\n' + JSON.stringify(done),
      /success after a failed response/,
    );
    await failure('{"type":"text","text":"partial"}\n', /before.*completed/);
  });

  it("releases pending reads and abort listeners on cancellation", async function () {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++;
      },
    });
    const controller = new AbortController();
    let detached = 0;
    const remove = controller.signal.removeEventListener.bind(
      controller.signal,
    );
    controller.signal.removeEventListener = (...args) => {
      detached++;
      remove(...args);
    };
    const pending = read(new Response(stream), controller.signal).catch(
      (error) => error,
    );
    controller.abort();
    assert.equal((await pending).name, "AbortError");
    assert.equal(cancelled, 1);
    assert.equal(detached, 1);
    assert.isFalse(stream.locked);
  });

  it("cancels the reader when the consumer stops early", async function () {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"text","text":"first"}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of streamResponseEvents(
      new Response(stream),
      "r1",
    )) {
      assert.equal(event.type, "text");
      break;
    }
    assert.isTrue(cancelled);
    assert.isFalse(stream.locked);
  });
});

import { assert } from "chai";
import { isProcessAlive } from "../src/helper/runtime/processHealth";

describe("Codex runtime process health", function () {
  it("accepts only a running process with writable stdin", function () {
    assert.isTrue(
      isProcessAlive({
        killed: false,
        exitCode: null,
        signalCode: null,
        stdin: { destroyed: false, writableEnded: false },
      }),
    );
  });

  it("rejects a process terminated by signal even when killed is false", function () {
    assert.isFalse(
      isProcessAlive({
        killed: false,
        exitCode: null,
        signalCode: "SIGKILL",
        stdin: { destroyed: false, writableEnded: false },
      }),
    );
  });

  it("rejects exited processes and closed stdin", function () {
    assert.isFalse(
      isProcessAlive({
        killed: false,
        exitCode: 1,
        signalCode: null,
        stdin: { destroyed: false, writableEnded: false },
      }),
    );
    assert.isFalse(
      isProcessAlive({
        killed: false,
        exitCode: null,
        signalCode: null,
        stdin: { destroyed: true, writableEnded: true },
      }),
    );
  });
});

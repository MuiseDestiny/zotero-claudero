import { assert } from "chai";
import { ProviderModelRequest } from "../src/modules/providerModelRequest";
import type { AiProvider } from "../src/modules/providerRegistry";
import type { ProviderModelDescriptor } from "../src/shared/providerModels";

describe("model catalog request ownership", function () {
  it("coalesces refreshes and ignores out-of-order results after provider changes", async function () {
    let selected: AiProvider = "codex";
    const requests: Array<{
      provider: AiProvider;
      signal: AbortSignal;
      finish: (models: ProviderModelDescriptor[]) => void;
    }> = [];
    const applied: AiProvider[] = [];
    const loader = new ProviderModelRequest(
      (provider, signal) =>
        new Promise((resolve) =>
          requests.push({ provider, signal, finish: resolve }),
        ),
      (provider) => selected === provider,
      (provider) => applied.push(provider),
    );
    const first = loader.load("codex");
    await loader.load("codex");
    assert.lengthOf(requests, 1);
    selected = "deepseek";
    const second = loader.load("deepseek");
    assert.isTrue(requests[0].signal.aborted);
    requests[1].finish([{ value: "new", label: "New model" }]);
    await second;
    requests[0].finish([{ value: "old", label: "Old model" }]);
    await first;
    assert.deepEqual(applied, ["deepseek"]);
    loader.dispose();
  });

  it("does not apply pending results or launch requests after pane disposal", async function () {
    let signal!: AbortSignal;
    let finish!: (models: ProviderModelDescriptor[]) => void;
    let fetched = 0;
    let applied = false;
    const loader = new ProviderModelRequest(
      (_provider, requestSignal) => {
        signal = requestSignal;
        fetched++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      () => true,
      () => {
        applied = true;
      },
    );
    const pending = loader.load("codex");
    loader.dispose();
    finish([{ value: "model", label: "Model" }]);
    await pending;
    await loader.load("deepseek");
    assert.isTrue(signal.aborted);
    assert.isFalse(applied);
    assert.equal(fetched, 1);
  });
});

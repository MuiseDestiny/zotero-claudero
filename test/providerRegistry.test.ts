import { assert } from "chai";
import {
  getProviderCapabilities,
  getProviderRegistration,
  modelOptionsForProvider,
  PROVIDER_OPTIONS,
} from "../src/modules/providerRegistry";

describe("provider registry", function () {
  it("exposes stable Claude and Codex registrations", function () {
    assert.deepEqual(
      PROVIDER_OPTIONS.map((option) => option.value),
      ["claude", "codex"],
    );
    assert.equal(getProviderRegistration("claude").label, "Claude");
    assert.equal(getProviderRegistration("codex").label, "Codex");
  });

  it("publishes provider capabilities used by UI/runtime routing", function () {
    assert.isTrue(getProviderCapabilities("claude").supportsMcpTools);
    assert.isTrue(
      getProviderCapabilities("claude").supportsInteractivePlanApproval,
    );
    assert.isTrue(getProviderCapabilities("codex").supportsFork);
    assert.isTrue(getProviderCapabilities("codex").supportsCompact);
    assert.isTrue(getProviderCapabilities("codex").supportsMcpTools);
    assert.isFalse(getProviderCapabilities("codex").supportsProviderCommands);
    assert.isTrue(
      getProviderCapabilities("codex").supportsInteractivePlanApproval,
    );
  });

  it("routes model options through provider registrations", function () {
    assert.includeMembers(
      modelOptionsForProvider("claude").map((option) => option.value),
      ["haiku", "sonnet"],
    );
    assert.includeMembers(
      modelOptionsForProvider("codex").map((option) => option.value),
      ["gpt-5.4-mini", "gpt-5.5"],
    );
  });
});

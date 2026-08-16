import { assert } from "chai";
import {
  getProviderCapabilities,
  getProviderRegistration,
  modelOptionsForProvider,
  PROVIDER_OPTIONS,
} from "../src/modules/providerRegistry";

describe("provider registry", function () {
  it("exposes stable Claude, Codex, and DeepSeek registrations", function () {
    assert.deepEqual(
      PROVIDER_OPTIONS.map((option) => option.value),
      ["claude", "codex", "deepseek"],
    );
    assert.equal(getProviderRegistration("claude").label, "Claude");
    assert.equal(getProviderRegistration("codex").label, "Codex");
    assert.equal(getProviderRegistration("deepseek").label, "DeepSeek Harness");
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
    assert.isFalse(
      getProviderCapabilities("deepseek").supportsImageAttachments,
    );
    assert.isFalse(getProviderCapabilities("deepseek").supportsMcpTools);
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
    assert.includeMembers(
      modelOptionsForProvider("deepseek").map((option) => option.value),
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    );
  });

  it("serves UI defaults from provider registrations", function () {
    assert.equal(getProviderRegistration("claude").defaultModel, "haiku");
    assert.equal(getProviderRegistration("claude").defaultEffort, "high");
    assert.equal(getProviderRegistration("codex").defaultModel, "gpt-5.5");
    assert.equal(getProviderRegistration("codex").defaultEffort, "medium");
    assert.equal(
      getProviderRegistration("deepseek").defaultModel,
      "deepseek-v4-flash",
    );
    assert.equal(getProviderRegistration("deepseek").defaultEffort, "none");
  });
});

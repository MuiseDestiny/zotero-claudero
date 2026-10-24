import { assert } from "chai";
import { setupActions } from "../src/modules/setupGuide";

describe("first-use setup actions", function () {
  for (const provider of ["claude", "codex", "deepseek"] as const) {
    it(`offers prerequisite repair before ${provider} authentication`, function () {
      const actions = setupActions(provider, false, false);
      assert.deepEqual(actions.node, ["install-node", "node-path"]);
      assert.deepEqual(actions.cli, ["install-provider", "cli-path"]);
      assert.isEmpty(actions.auth);
      assert.isEmpty(setupActions(provider, false, true).auth);
      assert.isEmpty(setupActions(provider, true, false).auth);
    });
  }

  it("offers DeepSeek installation only after Node is available", function () {
    assert.deepEqual(setupActions("deepseek", true, false).cli, [
      "install-deepseek",
      "cli-path",
    ]);
    assert.deepEqual(setupActions("deepseek", true, true).auth, [
      "provider-settings",
    ]);
  });

  it("avoids redundant path controls for installed programs", function () {
    assert.deepEqual(setupActions("claude", true, true), {
      node: [],
      cli: [],
      auth: ["login"],
    });
    assert.deepEqual(setupActions("codex", true, true).auth, ["login"]);
  });

  it("never launches native Windows login for a WSL CLI", function () {
    assert.deepEqual(setupActions("codex", true, true, true).auth, [
      "wsl-login",
    ]);
    assert.deepEqual(setupActions("claude", true, true, true).auth, ["login"]);
  });

  it("does not require host Node for native providers with a bundled Helper", function () {
    for (const provider of ["claude", "codex"] as const) {
      const actions = setupActions(provider, false, true, false, true);
      assert.isEmpty(actions.node);
      assert.deepEqual(actions.auth, ["login"]);
      assert.isEmpty(setupActions(provider, false, false, false, true).auth);
    }
    assert.deepEqual(setupActions("codex", false, true, true, true).auth, [
      "wsl-login",
    ]);
  });

  it("keeps Node prerequisites for DeepSeek and npm-based provider scripts", function () {
    for (const provider of ["claude", "codex", "deepseek"] as const) {
      const actions = setupActions(provider, false, true, false, true, true);
      assert.deepEqual(actions.node, ["install-node", "node-path"]);
      assert.isEmpty(actions.auth);
    }
    assert.deepEqual(setupActions("deepseek", false, true, false, true).node, [
      "install-node",
      "node-path",
    ]);
  });
});

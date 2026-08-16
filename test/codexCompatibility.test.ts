import { assert } from "chai";
import {
  bundledCodexCandidates,
  hasModelsCacheSchemaError,
  modelsCacheRequiresNewerCodex,
  stripAnsi,
  userFacingCodexStderr,
} from "../src/helper/runtime/codexCompatibility";

describe("Codex runtime compatibility", function () {
  it("recognizes the incompatible max-effort models cache error", function () {
    const stderr =
      "\u001b[31mERROR\u001b[0m failed to load models cache: unknown variant `max`, expected one of `none`, `low`, `xhigh`";
    assert.isTrue(hasModelsCacheSchemaError(stderr));
    assert.notInclude(stripAnsi(stderr), "\u001b");
  });

  it("detects max effort in compact and formatted model caches", function () {
    assert.isTrue(
      modelsCacheRequiresNewerCodex('{"models":[{"effort":"max"}]}'),
    );
    assert.isTrue(modelsCacheRequiresNewerCodex('{\n  "effort": "max"\n}'));
    assert.isFalse(modelsCacheRequiresNewerCodex('{"effort":"xhigh"}'));
  });

  it("offers the ChatGPT Desktop Codex binary on macOS", function () {
    assert.include(
      bundledCodexCandidates("darwin", "/Users/example"),
      "/Applications/ChatGPT.app/Contents/Resources/codex",
    );
    assert.deepEqual(bundledCodexCandidates("linux", "/home/example"), []);
  });

  it("keeps non-fatal model refresh warnings out of user error cards", function () {
    const warning =
      "2026-07-10 ERROR codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit";
    assert.equal(userFacingCodexStderr(warning), "");
    assert.equal(
      userFacingCodexStderr(`${warning}\nreal failure`),
      "real failure",
    );
  });
});

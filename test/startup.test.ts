import { assert } from "chai";
import { config } from "../package.json";
import { resolveBrowserGlobal } from "../src/utils/browserGlobals";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("resolves browser Web APIs used by the plugin global", function () {
    assert.isFunction(resolveBrowserGlobal("AbortController"));
    assert.isFunction(resolveBrowserGlobal("TextDecoder"));
    assert.isFunction(resolveBrowserGlobal("URL"));
    assert.isFunction(
      (resolveBrowserGlobal("crypto") as Crypto | undefined)?.getRandomValues,
    );
  });
});

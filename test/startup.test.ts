import { assert } from "chai";
import { config } from "../package.json";
import { resolveBrowserGlobal } from "../src/utils/browserGlobals";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("resolves browser Web APIs used by the plugin global", function () {
    assert.isFunction(
      resolveBrowserGlobal("AbortController"),
      "AbortController",
    );
    assert.isFunction(resolveBrowserGlobal("TextDecoder"), "TextDecoder");
    assert.isFunction(resolveBrowserGlobal("URL"), "URL");
    assert.isFunction(
      (resolveBrowserGlobal("crypto") as Crypto | undefined)?.getRandomValues,
      "crypto.getRandomValues",
    );
  });

  it("resolves security and transport APIs without a main window", function () {
    const Controller = resolveBrowserGlobal(
      "AbortController",
      null,
    ) as typeof AbortController;
    const controller = new Controller();
    controller.abort();
    assert.isTrue(controller.signal.aborted);
    const random = resolveBrowserGlobal("crypto", null) as Crypto;
    const bytes = new Uint8Array(32);
    random.getRandomValues(bytes);
    assert.isTrue(bytes.some((value) => value !== 0));
    assert.isFunction(resolveBrowserGlobal("TextDecoder", null), "TextDecoder");
    assert.isFunction(resolveBrowserGlobal("URL", null), "URL");
  });
});

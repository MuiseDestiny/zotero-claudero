import { assert } from "chai";
import {
  hasValidBearerAuthorization,
  validateHelperServerConfig,
} from "../src/helper/runtime/helperServerSecurity";

describe("helper server security", function () {
  const token = "a".repeat(64);

  it("accepts only explicit IPv4 and IPv6 loopback hosts", function () {
    assert.deepEqual(
      validateHelperServerConfig({ host: "127.0.0.1", port: 38660, token }),
      { host: "127.0.0.1", port: 38660, token },
    );
    assert.deepEqual(
      validateHelperServerConfig({ host: "::1", port: 38660, token }),
      { host: "::1", port: 38660, token },
    );

    for (const host of ["0.0.0.0", "localhost", "192.168.1.10", "::"]) {
      assert.throws(
        () => validateHelperServerConfig({ host, port: 38660, token }),
        /only accepts loopback hosts/,
      );
    }
  });

  it("rejects invalid ports and weak tokens", function () {
    for (const port of [0, 65536, Number.NaN, 38660.5]) {
      assert.throws(
        () => validateHelperServerConfig({ host: "127.0.0.1", port, token }),
        /Invalid Claudero helper port/,
      );
    }
    assert.throws(
      () =>
        validateHelperServerConfig({
          host: "127.0.0.1",
          port: 38660,
          token: "short",
        }),
      /at least 24 characters/,
    );
  });

  it("requires an exact bearer authorization value", function () {
    assert.isTrue(hasValidBearerAuthorization(`Bearer ${token}`, token));
    assert.isFalse(hasValidBearerAuthorization(undefined, token));
    assert.isFalse(hasValidBearerAuthorization(`bearer ${token}`, token));
    assert.isFalse(hasValidBearerAuthorization(`Bearer ${token}x`, token));
    assert.isFalse(hasValidBearerAuthorization(`Bearer ${token}`, `${token}x`));
  });
});

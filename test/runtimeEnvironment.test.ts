import { assert } from "chai";
import {
  buildRuntimeEnvironment,
  parseEnvironmentVariables,
  prependNodeRuntimePath,
} from "../src/shared/runtimeEnvironment";

describe("runtime environment", function () {
  it("keeps an explicitly selected Node reachable when the Helper uses its bundled runtime", function () {
    assert.equal(
      prependNodeRuntimePath("/custom node/bin/node", "/usr/bin:/bin"),
      "/custom node/bin:/usr/bin:/bin",
    );
    assert.equal(prependNodeRuntimePath("/custom/bin/node", ""), "/custom/bin");
    assert.equal(
      prependNodeRuntimePath("/custom/bin/node", "/usr/bin:/custom/bin"),
      "/custom/bin:/usr/bin",
    );
    assert.equal(prependNodeRuntimePath("", "/usr/bin"), "/usr/bin");
    assert.equal(prependNodeRuntimePath("node", "/usr/bin"), "/usr/bin");
    assert.equal(prependNodeRuntimePath("/node", "/usr/bin"), "/:/usr/bin");
  });

  it("handles Windows runtime paths and preserves explicit provider PATH overrides", function () {
    const PATH = prependNodeRuntimePath(
      "D:\\Custom Node\\node.exe",
      "C:\\Windows;d:/custom node",
      true,
    );
    assert.equal(PATH, "D:\\Custom Node;C:\\Windows");
    assert.equal(
      prependNodeRuntimePath("D:\\node.exe", "C:\\Windows", true),
      "D:\\;C:\\Windows",
    );
    const inherited = (name: string) => (name === "PATH" ? PATH : "");
    assert.equal(
      buildRuntimeEnvironment("", "PATH=extra;$PATH", "", inherited).PATH,
      `extra;${PATH}`,
    );
    assert.equal(
      buildRuntimeEnvironment("", "", "PATH=explicit", inherited).PATH,
      "explicit",
    );
  });

  it("preserves explicitly configured CONNECT proxies without probing them", function () {
    const env = buildRuntimeEnvironment(" http://127.0.0.1:7890 ", "");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
    assert.include(env.NO_PROXY, "127.0.0.1");
    assert.include(env.NO_PROXY, "::1");
  });

  it("layers general and provider values over proxy defaults", function () {
    const env = buildRuntimeEnvironment(
      "http://localhost:7890",
      "PATH=/general:$PATH\nMODEL=general",
      "PATH=/provider:${PATH}\nMODEL=provider",
      (name) => (name === "PATH" ? "/system" : ""),
    );
    assert.equal(env.PATH, "/provider:/general:/system");
    assert.equal(env.MODEL, "provider");
  });

  it("preserves literal dollars in single-quoted and escaped credentials", function () {
    const env = parseEnvironmentVariables(
      "KEY='secret$literal'\nESCAPED=secret\\$literal\nDOUBLE=\"$BASE/suffix\"",
      { BASE: "prefix" },
    );
    assert.equal(env.KEY, "secret$literal");
    assert.equal(env.ESCAPED, "secret$literal");
    assert.equal(env.DOUBLE, "prefix/suffix");
  });

  it("supports export, CRLF, empty values, comments and equals inside values", function () {
    const env = parseEnvironmentVariables(
      '# Comment\r\nexport\tKEY="a=b#c" # comment\r\nEMPTY=\r\nPLAIN=value # comment',
    );
    assert.equal(env.KEY, "a=b#c");
    assert.equal(env.EMPTY, "");
    assert.equal(env.PLAIN, "value");
  });

  it("does not reinterpret Windows path separators or unmatched trailing quotes", function () {
    const env = parseEnvironmentVariables("PATH=C:\\Users\\me\\bin\nKEY=abc'");
    assert.equal(env.PATH, "C:\\Users\\me\\bin");
    assert.equal(env.KEY, "abc'");
    assert.equal(
      parseEnvironmentVariables(String.raw`PATH=\\server\share`).PATH,
      String.raw`\\server\share`,
    );
  });

  it("rejects malformed keys before generating login shell scripts", function () {
    for (const value of [
      "BAD-NAME=value",
      "KEY;echo nope=value",
      "1KEY=value",
    ]) {
      assert.throws(() => parseEnvironmentVariables(value), /line 1/);
    }
    assert.throws(
      () => parseEnvironmentVariables("KEY='secret"),
      /quoted environment value/,
    );
  });

  it("does not resolve inherited object properties as variables", function () {
    const env = parseEnvironmentVariables(
      "KEY=$constructor\n__proto__=safe\nCOPY=$__proto__",
    );
    assert.equal(env.KEY, "");
    assert.equal(env.COPY, "safe");
    assert.equal(Object.getPrototypeOf(env), null);
  });

  it("rejects invalid proxies without exposing credentials", function () {
    for (const proxy of [
      "127.0.0.1:7890",
      "socks5://user:secret@localhost:1080",
    ]) {
      assert.throws(
        () => buildRuntimeEnvironment(proxy, ""),
        /Invalid proxy URL/,
      );
      try {
        buildRuntimeEnvironment(proxy, "");
      } catch (error) {
        assert.notInclude(String(error), "secret");
      }
    }
    assert.deepEqual(buildRuntimeEnvironment("", ""), {});
  });
});

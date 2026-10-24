import { assert } from "chai";
import {
  isSensitiveDiagnosticKey,
  rememberDiagnosticConfiguration,
  redactSensitiveText,
  sanitizeDiagnosticData,
  stableDiagnosticHash,
  summarizeAgentEventForDiagnostics,
} from "../src/shared/diagnosticPrivacy";
import { KnownDiagnosticSecrets } from "../src/shared/knownDiagnosticSecrets";

describe("diagnostic privacy", function () {
  it("recognizes credential fields without hiding token usage counters", function () {
    assert.isTrue(isSensitiveDiagnosticKey("zoteroEndpointToken"));
    assert.isTrue(isSensitiveDiagnosticKey("OPENAI_API_KEY"));
    assert.isTrue(isSensitiveDiagnosticKey("Authorization"));
    assert.isFalse(isSensitiveDiagnosticKey("outputTokens"));
    assert.isFalse(isSensitiveDiagnosticKey("environmentKeys"));
  });

  it("redacts credentials embedded in error text", function () {
    const text = redactSensitiveText(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz and api_key=sk-example1234567890",
    );
    assert.notInclude(text, "abcdefghijklmnopqrstuvwxyz");
    assert.notInclude(text, "sk-example1234567890");
    assert.include(text, "[redacted]");
  });

  it("sanitizes nested diagnostic data and preserves useful counters", function () {
    const sanitized = sanitizeDiagnosticData({
      outputTokens: 42,
      authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
      nested: {
        zoteroEndpointToken: "secret-token-value",
        error: "request failed with password=hunter2-secret",
      },
    }) as Record<string, any>;

    assert.equal(sanitized.outputTokens, 42);
    assert.equal(sanitized.authorization, "[redacted]");
    assert.equal(sanitized.nested.zoteroEndpointToken, "[redacted]");
    assert.notInclude(sanitized.nested.error, "hunter2-secret");
  });

  it("uses stable hashes without retaining source text", function () {
    assert.equal(stableDiagnosticHash("same"), stableDiagnosticHash("same"));
    assert.notEqual(
      stableDiagnosticHash("same"),
      stableDiagnosticHash("different"),
    );
  });

  it("summarizes trace content without retaining prompts or tool results", function () {
    const text = summarizeAgentEventForDiagnostics({
      type: "text_snapshot",
      text: "private model response",
    });
    const toolResult = summarizeAgentEventForDiagnostics({
      type: "tool_result",
      result: {
        id: "tool-1",
        content: "private Zotero document text",
        isError: false,
      },
    });

    assert.equal(text.textLength, 22);
    assert.notInclude(JSON.stringify(text), "private model response");
    assert.equal(toolResult.contentLength, 28);
    assert.notInclude(JSON.stringify(toolResult), "private Zotero document");
  });

  it("remembers opaque configured secrets when they reappear without a credential label", function () {
    const secret = "fixture-opaque-credential.+[123]";
    rememberDiagnosticConfiguration({
      environment: { PROVIDER_API_KEY: secret },
    });
    const diagnostic = sanitizeDiagnosticData({
      error: `upstream rejected (${secret})`,
      [secret]: true,
    });
    assert.notInclude(JSON.stringify(diagnostic), secret);
    assert.include(JSON.stringify(diagnostic), "[redacted]");
    assert.equal(
      redactSensitiveText("unrelated research text"),
      "unrelated research text",
    );
  });

  it("redacts URL userinfo and remembers configured encoded proxy passwords", function () {
    const password = "fixture proxy password";
    const encoded = encodeURIComponent(password);
    rememberDiagnosticConfiguration({
      HTTP_PROXY: `http://proxy-user:${encoded}@localhost:7890`,
    });
    for (const text of [
      `proxy rejected ${password}`,
      `proxy rejected ${encoded}`,
      "connect https://alice:short@example.test/path?x=1",
      "connect socks5://bob:p%40ss@example.test:1080",
    ]) {
      const redacted = redactSensitiveText(text);
      assert.notInclude(redacted, password);
      assert.notInclude(redacted, encoded);
      assert.notInclude(redacted, "alice:short");
      assert.notInclude(redacted, "bob:p%40ss");
      assert.include(redacted, "[redacted]");
    }
  });

  it("does not learn arbitrary research text or non-sensitive configuration", function () {
    rememberDiagnosticConfiguration({
      model: "fixture-nonsensitive-model",
      PATH: "/fixture/path-value",
    });
    assert.equal(
      redactSensitiveText("fixture-nonsensitive-model /fixture/path-value"),
      "fixture-nonsensitive-model /fixture/path-value",
    );
    sanitizeDiagnosticData({ message: "private fixture research paragraph" });
    assert.equal(
      redactSensitiveText("private fixture research paragraph"),
      "private fixture research paragraph",
    );
  });

  it("bounds known values and replaces overlapping values longest-first", function () {
    const secrets = new KnownDiagnosticSecrets();
    secrets.remember("fixture-secret");
    secrets.remember("fixture-secret-longer");
    secrets.remember("tiny");
    secrets.remember("x".repeat(4097));
    assert.equal(
      secrets.redact("fixture-secret-longer fixture-secret tiny"),
      "[redacted] [redacted] tiny",
    );
    for (let index = 0; index < 128; index++)
      secrets.remember(`fixture-bounded-${index}`);
    assert.equal(secrets.redact("fixture-secret"), "fixture-secret");
    assert.equal(secrets.redact("fixture-bounded-127"), "[redacted]");
    for (let index = 0; index < 17; index++)
      secrets.remember(`fixture-large-${index}:` + "z".repeat(4000));
    assert.equal(secrets.redact("fixture-bounded-127"), "fixture-bounded-127");
  });

  it("handles circular arrays and re-sanitizes older entries after secrets become known", function () {
    const circular: unknown[] = [];
    circular.push(circular);
    assert.deepEqual(sanitizeDiagnosticData(circular), ["[circular]"]);
    const old = sanitizeDiagnosticData({
      error: "rejected fixture-late-secret-123",
    });
    rememberDiagnosticConfiguration({
      CUSTOM_SECRET: "fixture-late-secret-123",
    });
    assert.notInclude(
      JSON.stringify(sanitizeDiagnosticData(old)),
      "fixture-late-secret-123",
    );
  });
});

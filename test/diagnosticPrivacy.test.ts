import { assert } from "chai";
import {
  isSensitiveDiagnosticKey,
  redactSensitiveText,
  sanitizeDiagnosticData,
  stableDiagnosticHash,
  summarizeAgentEventForDiagnostics,
} from "../src/shared/diagnosticPrivacy";

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
});

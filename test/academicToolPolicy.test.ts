import { assert } from "chai";
import { toolPolicyDenialReason } from "../src/shared/academicToolPolicy";

const READ_ONLY_POLICY = {
  zoteroMcp: true,
  allowZoteroRead: true,
  allowZoteroWrite: false,
  allowWebSearch: false,
  allowScripts: false,
};

describe("academic tool policy", function () {
  it("allows Zotero reads and blocks writes, scripts, and web search", function () {
    assert.isNull(
      toolPolicyDenialReason("mcp__zotero__get_item", READ_ONLY_POLICY),
    );
    assert.match(
      toolPolicyDenialReason("mcp__zotero__create_note", READ_ONLY_POLICY) ||
        "",
      /read-only/,
    );
    assert.match(
      toolPolicyDenialReason("Bash", READ_ONLY_POLICY) || "",
      /shell/,
    );
    assert.match(
      toolPolicyDenialReason("webSearch", READ_ONLY_POLICY) || "",
      /web search/,
    );
  });
});

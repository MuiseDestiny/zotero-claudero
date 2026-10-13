import { assert } from "chai";
import { verifyCitationClaims } from "../src/modules/evidence";

function installZoteroFixture(abstractNote: string): void {
  const item = {
    id: 11,
    key: "ITEMKEY",
    itemType: "journalArticle",
    isAttachment: () => false,
    isRegularItem: () => true,
    getBestAttachment: async () => undefined,
    getAttachments: () => [],
    getDisplayTitle: () => "Fixture",
    getField: (field: string) =>
      field === "abstractNote"
        ? abstractNote
        : field === "title"
          ? "Fixture"
          : "",
    getCreators: () => [],
  };
  (globalThis as any).Zotero = {
    Items: {
      getAsync: async () => item,
    },
  };
}

describe("citation verification safeguards", function () {
  it("does not verify a quote from a lexical-only candidate", async function () {
    installZoteroFixture(
      "The intervention increased survival in the treatment group. This sentence has supporting context.",
    );
    const result = await verifyCitationClaims({
      claims: [
        {
          claim:
            'The paper says "survival increased in the intervention treatment group".',
          quote: "survival increased in the intervention treatment group",
        },
      ],
      itemId: 11,
    });
    assert.isArray(result.verifications);
    assert.notEqual(result.verifications[0].status, "verified");
    assert.match(
      result.verifications[0].warnings.join(" "),
      /exact quote match/i,
    );
  });

  it("keeps figure and table claims pending visual inspection", async function () {
    installZoteroFixture(
      "Figure 1. The intervention increased survival in the treatment group.",
    );
    const result = await verifyCitationClaims({
      claims: [
        {
          claim:
            "Figure 1. The intervention increased survival in the treatment group.",
        },
      ],
      itemId: 11,
    });
    assert.equal(result.verifications[0].status, "weak");
    assert.exists(result.verifications[0].visualInspection);
  });

  it("verifies exact quotes but not a claimed page with no matching provenance", async function () {
    const quote = "The intervention increased survival in the treatment group.";
    installZoteroFixture(quote);
    const result = await verifyCitationClaims({
      claims: [
        { claim: quote, quote },
        { claim: `On page 3: ${quote}`, quote, pageIndex: 2 },
      ],
      itemId: 11,
    });
    assert.equal(result.verifications[0].status, "verified");
    assert.equal(result.verifications[1].status, "unverified");
    assert.match(result.verifications[1].warnings.join(" "), /page/);
  });
});

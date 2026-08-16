import { assert } from "chai";
import { detectEvidenceContradiction } from "../src/shared/evidenceSemantics";

describe("evidence semantics", function () {
  it("detects negated and directional contradictions", function () {
    assert.equal(
      detectEvidenceContradiction(
        "Treatment does not increase survival.",
        "Treatment increases survival.",
      ),
      "negation polarity mismatch",
    );
    assert.equal(
      detectEvidenceContradiction(
        "The intervention decreased mortality.",
        "The intervention increased mortality.",
      ),
      "opposing directional terms",
    );
    assert.isNull(
      detectEvidenceContradiction(
        "The intervention increased survival.",
        "The intervention increases survival.",
      ),
    );
  });
});

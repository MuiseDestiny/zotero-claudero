import { assert } from "chai";
import { thinkingPresentation } from "../src/shared/thinkingPresentation";

describe("thinking presentation", function () {
  it("promotes a standalone bold reasoning summary to the title", function () {
    assert.deepEqual(thinkingPresentation("**Identifying figure tool**"), {
      title: "Identifying figure tool",
      body: "",
    });
  });

  it("keeps reasoning after the summary in the card body", function () {
    assert.deepEqual(
      thinkingPresentation(
        "**Inspecting figure**\nChecking the rendered page.",
      ),
      {
        title: "Inspecting figure",
        body: "Checking the rendered page.",
      },
    );
  });

  it("uses the latest adjacent Codex reasoning summary as the title", function () {
    assert.deepEqual(
      thinkingPresentation(
        "**Identifying all available tools****Identifying call declaration**",
      ),
      {
        title: "Identifying call declaration",
        body: "",
      },
    );
  });

  it("does not promote ordinary inline bold text", function () {
    const text = "This is **important** context.";
    assert.deepEqual(thinkingPresentation(text), {
      title: null,
      body: text,
    });
  });
});

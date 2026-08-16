import { assert } from "chai";
import {
  codexModelDisplayLabel,
  parseCodexModelListPage,
} from "../src/shared/providerModels";

describe("provider model catalog", function () {
  it("normalizes visible Codex models and their reasoning options", function () {
    const page = parseCodexModelListPage({
      data: [
        {
          id: "model-1",
          model: "gpt-5.6-sol",
          displayName: "GPT-5.6-Sol",
          description: "Fast research model",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
        },
        {
          id: "hidden-model",
          model: "hidden-model",
          displayName: "Hidden",
          hidden: true,
        },
      ],
      nextCursor: "page-2",
    });
    assert.deepEqual(page, {
      models: [
        {
          value: "gpt-5.6-sol",
          label: "5.6 Sol",
          description: "Fast research model",
          isDefault: true,
          defaultEffort: "high",
          supportedEfforts: ["medium", "high"],
        },
      ],
      nextCursor: "page-2",
    });
  });

  it("matches Codex Desktop's compact model labels", function () {
    assert.equal(
      codexModelDisplayLabel("GPT-5.3-Codex-Spark"),
      "5.3 Codex Spark",
    );
    assert.equal(codexModelDisplayLabel("o3-mini"), "o3-mini");
  });

  it("falls back from model to id and removes duplicates", function () {
    const page = parseCodexModelListPage({
      data: [
        { id: "gpt-5.5", displayName: "5.5", hidden: false },
        { id: "duplicate", model: "gpt-5.5", hidden: false },
      ],
    });
    assert.deepEqual(page.models, [{ value: "gpt-5.5", label: "5.5" }]);
  });
});

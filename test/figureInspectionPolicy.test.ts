import { assert } from "chai";
import {
  figurePageViewBox,
  figureInspectionSearchPlan,
  isRenderableCanvasLike,
  selectFigurePageCandidate,
} from "../src/shared/figureInspectionPolicy";

describe("figure inspection policy", function () {
  it("accepts a rendered canvas from another window realm", function () {
    const iframeCanvas = {
      width: 1200,
      height: 1600,
      toDataURL() {
        return "data:image/jpeg;base64,dGVzdA==";
      },
    };

    assert.isTrue(isRenderableCanvasLike(iframeCanvas));
    assert.isFalse(isRenderableCanvasLike({ width: 1200, height: 1600 }));
  });

  it("searches the full PDF for a named figure without a page", function () {
    assert.deepEqual(
      figureInspectionSearchPlan({ label: "Figure 1", maxPages: 3 }),
      {
        requestedPageIndex: undefined,
        hasSpecificTarget: true,
        maxPages: 500,
      },
    );
  });

  it("keeps a targeted page inspection narrow", function () {
    assert.deepEqual(
      figureInspectionSearchPlan({ pageNumber: 12, label: "Figure 1" }),
      {
        requestedPageIndex: 11,
        hasSpecificTarget: true,
        maxPages: 120,
      },
    );
  });

  it("accepts only finite four-coordinate PDF page view boxes", function () {
    assert.deepEqual(figurePageViewBox([0, 0, 612, 792]), [0, 0, 612, 792]);
    assert.isNull(figurePageViewBox([0, 0, 612]));
    assert.isNull(figurePageViewBox([0, 0, Number.NaN, 792]));
  });

  it("never substitutes a ranked candidate from a different explicit page", function () {
    const candidates = [
      { label: "Figure 1", locator: { pageIndex: 6 } },
      { label: "Figure 5", locator: { pageIndex: 13 } },
    ];
    assert.equal(selectFigurePageCandidate(candidates, 13)?.label, "Figure 5");
    assert.isUndefined(selectFigurePageCandidate(candidates, 9));
    assert.equal(selectFigurePageCandidate(candidates)?.label, "Figure 1");
  });
});

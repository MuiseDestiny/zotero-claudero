export interface FigureInspectionSearchInput {
  pageIndex?: number;
  pageNumber?: number;
  label?: string;
  caption?: string;
  query?: string;
  maxPages?: number;
}

export interface FigureInspectionSearchPlan {
  requestedPageIndex?: number;
  hasSpecificTarget: boolean;
  maxPages: number;
}

export type FigurePageViewBox = [number, number, number, number];

export function figurePageViewBox(value: unknown): FigurePageViewBox | null {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => Number.isFinite(coordinate))
    ? (Array.from(value) as FigurePageViewBox)
    : null;
}

export function selectFigurePageCandidate<
  T extends { locator: { pageIndex?: number } },
>(rankedCandidates: T[], requestedPageIndex?: number): T | undefined {
  return typeof requestedPageIndex === "number"
    ? rankedCandidates.find(
        (candidate) => candidate.locator.pageIndex === requestedPageIndex,
      )
    : rankedCandidates[0];
}

export function isRenderableCanvasLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    width?: unknown;
    height?: unknown;
    toDataURL?: unknown;
  };
  return (
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    typeof candidate.toDataURL === "function"
  );
}

export function figureInspectionSearchPlan(
  input: FigureInspectionSearchInput,
): FigureInspectionSearchPlan {
  const requestedPageIndex =
    typeof input.pageIndex === "number"
      ? input.pageIndex
      : typeof input.pageNumber === "number"
        ? input.pageNumber - 1
        : undefined;
  const hasSpecificTarget = !!String(
    input.label || input.caption || input.query || "",
  ).trim();
  const requestedMaxPages = Math.max(1, Number(input.maxPages || 120));
  return {
    requestedPageIndex,
    hasSpecificTarget,
    maxPages:
      hasSpecificTarget && typeof requestedPageIndex !== "number"
        ? Math.max(500, requestedMaxPages)
        : requestedMaxPages,
  };
}

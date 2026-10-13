import { isConfigRecord, isStringArray } from "../shared/configValidation";
import { asSelectionContext } from "./selectionContextValidation";

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const optionalStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );

function validBlock(value: unknown): boolean {
  if (!isConfigRecord(value)) return false;
  switch (value.type) {
    case "text":
    case "thinking":
      return (
        typeof value.text === "string" &&
        (value.durationMs === undefined || finiteNumber(value.durationMs))
      );
    case "tool_use":
      return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        optionalStrings(value, ["partialInput"])
      );
    case "tool_result":
      return (
        typeof value.id === "string" &&
        typeof value.content === "string" &&
        (value.isError === undefined || typeof value.isError === "boolean")
      );
    case "notice":
      return (
        typeof value.title === "string" &&
        typeof value.text === "string" &&
        optionalStrings(value, ["kind", "failureMessage"])
      );
    default:
      return false;
  }
}

function validTurn(value: unknown): boolean {
  if (
    !isConfigRecord(value) ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.text !== "string" ||
    !finiteNumber(value.ts)
  )
    return false;
  if (
    !optionalStrings(value, [
      "model",
      "effort",
      "assistantMessageId",
      "sessionId",
    ])
  )
    return false;
  if (
    value.provider !== undefined &&
    (typeof value.provider !== "string" ||
      !["claude", "codex", "deepseek"].includes(value.provider))
  )
    return false;
  if (value.durationMs !== undefined && !finiteNumber(value.durationMs))
    return false;
  if (
    value.contextSnapshot != null &&
    !asSelectionContext(value.contextSnapshot)
  )
    return false;
  if (
    value.blocks !== undefined &&
    (!Array.isArray(value.blocks) || !value.blocks.every(validBlock))
  )
    return false;
  if (
    value.evidenceReferences !== undefined &&
    !isConfigRecord(value.evidenceReferences)
  )
    return false;
  if (
    value.images !== undefined &&
    (!Array.isArray(value.images) ||
      !value.images.every(
        (image) =>
          isConfigRecord(image) &&
          typeof image.id === "string" &&
          typeof image.mediaType === "string" &&
          typeof image.data === "string" &&
          optionalStrings(image, ["dataUrl"]),
      ))
  )
    return false;
  return true;
}

/** Validate fields consumed by replay/UI before trusting a saved JSON document. */
export function validateConversationData(value: unknown): string | null {
  if (!isConfigRecord(value) || !Array.isArray(value.turns))
    return "Conversation must contain a turns array.";
  if (!value.turns.every(validTurn))
    return "Conversation contains an invalid message, image, or replay block.";
  if (!optionalStrings(value, ["id", "title", "parentConversationId"]))
    return "Conversation metadata contains invalid text fields.";
  for (const key of [
    "createdAt",
    "updatedAt",
    "compactedAt",
    "forkedAtTurnIndex",
  ]) {
    if (value[key] !== undefined && !finiteNumber(value[key]))
      return `Conversation ${key} must be a finite number.`;
  }
  if (value.providerState !== undefined) {
    if (!isConfigRecord(value.providerState))
      return "Conversation provider state must be an object.";
    for (const provider of ["claude", "codex", "deepseek"]) {
      const state = value.providerState[provider];
      if (state === undefined) continue;
      if (
        !isConfigRecord(state) ||
        !optionalStrings(state, ["sessionId", "threadId", "sessionFilePath"])
      )
        return "Conversation provider session is invalid.";
      if (
        state.forkSource !== undefined &&
        (!isConfigRecord(state.forkSource) ||
          typeof state.forkSource.threadId !== "string" ||
          !optionalStrings(state.forkSource, [
            "resumeAt",
            "sourceConversationId",
          ]))
      )
        return "Conversation fork source is invalid.";
    }
  }
  if (value.recoveryManifest !== undefined) {
    const manifest = value.recoveryManifest;
    if (
      !isConfigRecord(manifest) ||
      manifest.version !== 1 ||
      typeof manifest.mode !== "string" ||
      !["native", "fresh-full", "fresh-limited"].includes(manifest.mode) ||
      !isStringArray(manifest.missingMaterials) ||
      !Array.isArray(manifest.includedRange) ||
      manifest.includedRange.length !== 2 ||
      !manifest.includedRange.every(finiteNumber) ||
      ![manifest.totalTurns, manifest.includedTurns, manifest.maxChars].every(
        finiteNumber,
      ) ||
      typeof manifest.overLimit !== "boolean" ||
      (manifest.confirmed !== undefined &&
        typeof manifest.confirmed !== "boolean")
    )
      return "Conversation recovery manifest is invalid.";
  }
  return null;
}

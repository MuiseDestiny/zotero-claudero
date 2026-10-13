import type { SavedConversation } from "./conversationStore";

/** JSON-safe deep snapshot. Call before enqueueing, not inside the task. */
export function snapshotConversationValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const CONVERSATION_METADATA_KEYS = [
  "providerState",
  "parentConversationId",
  "forkedAtTurnIndex",
  "compactedAt",
  "recoveryManifest",
] as const;

type MetadataKey = (typeof CONVERSATION_METADATA_KEYS)[number];
export type ConversationMetadataPatch = {
  [K in MetadataKey]?: SavedConversation[K] | null;
};

/** Preserve presence before JSON serialization discards undefined. */
export function snapshotMetadataPatch(
  patch: ConversationMetadataPatch,
): ConversationMetadataPatch {
  const snapshot: ConversationMetadataPatch = {};
  for (const key of CONVERSATION_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      // `undefined` means the caller has no update for this field. Preserve
      // the existing metadata; callers can pass `null` when they explicitly
      // want to clear a value.
      if (patch[key] === undefined) continue;
      (snapshot as Record<string, unknown>)[key] =
        patch[key] === null ? null : snapshotConversationValue(patch[key]);
    }
  }
  return snapshot;
}

export function applyMetadataPatch(
  existing: Partial<SavedConversation> | null,
  patch: ConversationMetadataPatch,
): Partial<SavedConversation> {
  const result: Record<string, unknown> = {};
  for (const key of CONVERSATION_METADATA_KEYS) {
    const value = Object.prototype.hasOwnProperty.call(patch, key)
      ? patch[key]
      : existing?.[key];
    if (value != null) result[key] = value;
  }
  return result;
}

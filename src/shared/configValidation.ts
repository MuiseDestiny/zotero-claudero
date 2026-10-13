/** Pure configuration validation shared by Zotero preferences and the helper. */
export function isConfigRecord(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/** Extensions may contain JSON data, including own __proto__ keys, not live objects. */
export function isJsonConfigValue(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 64 || seen.has(value)) return false;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  seen.add(value);
  const valid = Object.values(value).every((entry) =>
    isJsonConfigValue(entry, seen, depth + 1),
  );
  seen.delete(value);
  return valid;
}

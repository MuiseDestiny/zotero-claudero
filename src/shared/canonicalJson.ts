export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return entry;
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(
          ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
        ),
      );
    }) ?? "undefined"
  );
}

export function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

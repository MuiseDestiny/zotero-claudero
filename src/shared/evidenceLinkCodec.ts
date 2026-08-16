const BASE64_PREFIX = "b64.";
const REFERENCE_PREFIX = "ref.";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_REFERENCES = 4096;
const evidenceReferences = new Map<string, unknown>();
const evidenceMarkers = new Map<string, unknown>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function evidenceMarkerNames(text: string): string[] {
  return Array.from(text.matchAll(/\[(E[A-Za-z0-9]+)\]/g), (match) => match[1]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] || 0;
    const second = bytes[index + 1] || 0;
    const third = bytes[index + 2] || 0;
    const value = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(value >> 18) & 63];
    output += BASE64_ALPHABET[(value >> 12) & 63];
    output +=
      index + 1 < bytes.length ? BASE64_ALPHABET[(value >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : "=";
  }
  return output;
}

function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, "");
  const output: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(clean[index] || "A");
    const second = BASE64_ALPHABET.indexOf(clean[index + 1] || "A");
    const third =
      clean[index + 2] === "="
        ? 0
        : BASE64_ALPHABET.indexOf(clean[index + 2] || "A");
    const fourth =
      clean[index + 3] === "="
        ? 0
        : BASE64_ALPHABET.indexOf(clean[index + 3] || "A");
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error("Invalid base64 evidence payload");
    }
    const value = (first << 18) | (second << 12) | (third << 6) | fourth;
    output.push((value >> 16) & 255);
    if (clean[index + 2] !== "=") output.push((value >> 8) & 255);
    if (clean[index + 3] !== "=") output.push(value & 255);
  }
  return new Uint8Array(output);
}

function referenceHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    first ^= value.charCodeAt(index);
    first = Math.imul(first, 0x01000193);
    second ^= value.charCodeAt(value.length - index - 1);
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function referenceNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number.toString(36) : "_";
}

function parseReferenceNumber(value: string | undefined): number | undefined {
  if (!value || value === "_") return undefined;
  const number = Number.parseInt(value, 36);
  return Number.isFinite(number) ? number : undefined;
}

export function encodeEvidencePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return (
    BASE64_PREFIX +
    bytesToBase64(bytes)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")
  );
}

export function decodeEvidencePayload(value: string): unknown {
  if (!value.startsWith(BASE64_PREFIX)) {
    return JSON.parse(decodeURIComponent(value));
  }
  const encoded = value
    .slice(BASE64_PREFIX.length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const json = new TextDecoder().decode(base64ToBytes(padded));
  return JSON.parse(json);
}

export function encodeEvidenceReference(
  value: Record<string, unknown>,
): string {
  const serialized = JSON.stringify(value);
  const reference = [
    REFERENCE_PREFIX.slice(0, -1),
    referenceNumber(value.attachmentId),
    referenceNumber(value.pageIndex),
    referenceNumber(value.paragraphIndex),
    referenceHash(serialized),
  ].join(".");
  evidenceReferences.set(reference, value);
  while (evidenceReferences.size > MAX_REFERENCES) {
    const oldest = evidenceReferences.keys().next().value;
    if (!oldest) break;
    evidenceReferences.delete(oldest);
  }
  return reference;
}

export function decodeEvidenceReference(value: string): unknown {
  if (!value.startsWith(REFERENCE_PREFIX)) {
    return decodeEvidencePayload(value);
  }
  const registered = evidenceReferences.get(value);
  if (registered) return registered;

  const [, attachment, page, paragraph] = value.split(".");
  const attachmentId = parseReferenceNumber(attachment);
  if (typeof attachmentId !== "number") return null;
  const pageIndex = parseReferenceNumber(page);
  const paragraphIndex = parseReferenceNumber(paragraph);
  return {
    attachmentId,
    pageIndex,
    pageNumber: typeof pageIndex === "number" ? pageIndex + 1 : undefined,
    paragraphIndex,
    sourceType: "pdfjs",
  };
}

export function encodeEvidenceMarker(value: Record<string, unknown>): string {
  const marker = `E${referenceHash(JSON.stringify(value))}`;
  evidenceMarkers.set(marker, value);
  while (evidenceMarkers.size > MAX_REFERENCES) {
    const oldest = evidenceMarkers.keys().next().value;
    if (!oldest) break;
    evidenceMarkers.delete(oldest);
  }
  return `[${marker}]`;
}

export function hydrateEvidenceMarkers(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/\[(E[A-Za-z0-9]+)\](?!\()/g, (match, marker) => {
        const locator = evidenceMarkers.get(marker);
        if (!locator || typeof locator !== "object") return match;
        const reference = encodeEvidenceReference(
          locator as Record<string, unknown>,
        );
        return `[${marker}](claudero-evidence:${reference})`;
      });
    })
    .join("");
}

/**
 * Recover marker-to-locator mappings from persisted MCP tool results. Tool
 * payloads already contain the locators used to create their short [E...] markers;
 * rebuilding this index keeps citations clickable after a Zotero restart.
 */
export function evidenceReferencesFromToolResultContent(
  content: string,
): Record<string, unknown> | undefined {
  const expectedMarkers = new Set(evidenceMarkerNames(content));
  if (!expectedMarkers.size) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  const references: Record<string, unknown> = {};

  const visit = (value: unknown): void => {
    if (Object.keys(references).length >= expectedMarkers.size) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;

    const locator = isRecord(value.locator) ? value.locator : undefined;
    if (locator) {
      const directMarkers = Object.values(value)
        .filter((entry): entry is string => typeof entry === "string")
        .flatMap(evidenceMarkerNames)
        .filter((marker) => expectedMarkers.has(marker));
      for (const marker of directMarkers) references[marker] = locator;

      // Academic trace records intentionally omit the display marker. Recreate
      // the deterministic marker from the exact serialized locator.
      const computedMarker = encodeEvidenceMarker(locator).slice(1, -1);
      if (expectedMarkers.has(computedMarker)) {
        references[computedMarker] = locator;
      }
    }

    const markdownMarkers = Object.entries(value)
      .filter(
        ([key, entry]) =>
          typeof entry === "string" &&
          /(?:markdown|contextText)$/i.test(key) &&
          entry.includes("[E"),
      )
      .flatMap(([, entry]) => evidenceMarkerNames(entry as string));
    if (markdownMarkers.length) {
      for (const entry of Object.values(value)) {
        if (!Array.isArray(entry)) continue;
        const locators = entry
          .map((item) => {
            if (!isRecord(item)) return undefined;
            if (isRecord(item.locator)) return item.locator;
            return isRecord(item.evidence) && isRecord(item.evidence.locator)
              ? item.evidence.locator
              : undefined;
          })
          .filter((item): item is Record<string, unknown> => !!item);
        if (locators.length !== markdownMarkers.length) continue;
        markdownMarkers.forEach((marker, index) => {
          references[marker] = locators[index];
        });
        break;
      }
    }

    Object.values(value).forEach(visit);
  };

  visit(parsed);
  return Object.keys(references).length ? references : undefined;
}

export function sanitizeEvidencePresentation(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(
          /(?:来源|证据)段落\s*(?:ID\s*)?[:：]?\s*para-[A-Za-z0-9_.:-]+/gi,
          "",
        )
        .replace(
          /(?:source\s+)?paragraph\s*(?:ID\s*)?[:：]?\s*para-[A-Za-z0-9_.:-]+/gi,
          "",
        )
        .replace(/\bpara-[A-Za-z0-9_.:-]+\b/gi, "")
        .replace(/[ \t]+(?=\[E[A-Za-z0-9]+\])/g, " ");
    })
    .join("");
}

export function evidenceReferencesForText(
  text: string,
): Record<string, unknown> | undefined {
  const references: Record<string, unknown> = {};
  for (const match of text.matchAll(
    /claudero-evidence:(ref\.[A-Za-z0-9_.-]+)/g,
  )) {
    const reference = match[1];
    const locator = evidenceReferences.get(reference);
    if (locator) references[reference] = locator;
  }
  for (const match of text.matchAll(/\[(E[A-Za-z0-9]+)\]/g)) {
    const marker = match[1];
    const locator = evidenceMarkers.get(marker);
    if (locator) references[marker] = locator;
  }
  return Object.keys(references).length ? references : undefined;
}

export function restoreEvidenceReferences(
  references: Record<string, unknown> | undefined,
): void {
  if (!references) return;
  for (const [key, locator] of Object.entries(references)) {
    if (!locator) continue;
    if (key.startsWith(REFERENCE_PREFIX)) {
      evidenceReferences.set(key, locator);
    } else if (/^E[A-Za-z0-9]+$/.test(key)) {
      evidenceMarkers.set(key, locator);
    }
  }
  while (evidenceReferences.size > MAX_REFERENCES) {
    const oldest = evidenceReferences.keys().next().value;
    if (!oldest) break;
    evidenceReferences.delete(oldest);
  }
}

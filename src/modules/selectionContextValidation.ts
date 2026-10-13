import { isConfigRecord, isStringArray } from "../shared/configValidation";
import type { ClauderoSelectionContext } from "./zoteroContext";

const strings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === "string");
const optionalStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const optionalNumbers = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => value[key] === undefined || number(value[key]));

function collection(value: unknown): boolean {
  return (
    isConfigRecord(value) &&
    number(value.id) &&
    strings(value, ["key", "name", "path"]) &&
    optionalStrings(value, ["libraryName"])
  );
}

function attachment(value: unknown): boolean {
  return (
    isConfigRecord(value) &&
    number(value.id) &&
    strings(value, ["key", "title", "contentType"]) &&
    optionalStrings(value, [
      "iconName",
      "path",
      "parentItemKey",
      "parentItemType",
      "pageLabel",
    ]) &&
    optionalNumbers(value, [
      "parentItemID",
      "pageIndex",
      "pageNumber",
      "pagesCount",
    ])
  );
}

function item(value: unknown): boolean {
  return (
    isConfigRecord(value) &&
    number(value.id) &&
    strings(value, [
      "key",
      "itemType",
      "title",
      "date",
      "publicationTitle",
      "abstractNote",
      "url",
      "DOI",
    ]) &&
    isStringArray(value.creators) &&
    isStringArray(value.tags) &&
    (value.notes === undefined || isStringArray(value.notes)) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(attachment) &&
    (value.collections === undefined ||
      (Array.isArray(value.collections) && value.collections.every(collection)))
  );
}

function annotation(value: unknown): boolean {
  return (
    isConfigRecord(value) &&
    strings(value, ["text", "type"]) &&
    optionalStrings(value, ["comment", "color"]) &&
    optionalNumbers(value, ["pageIndex"])
  );
}

/** Stored context is untrusted JSON, including nested values used by chip rendering. */
export function asSelectionContext(
  value: unknown,
): ClauderoSelectionContext | null {
  if (
    !isConfigRecord(value) ||
    !strings(value, [
      "generatedAt",
      "selectedType",
      "selectedTabID",
      "selectedText",
    ]) ||
    !Array.isArray(value.items) ||
    !value.items.every(item) ||
    (value.reader !== undefined && !attachment(value.reader)) ||
    (value.activeCollection !== undefined &&
      !collection(value.activeCollection)) ||
    (value.selectedAnnotations !== undefined &&
      (!Array.isArray(value.selectedAnnotations) ||
        !value.selectedAnnotations.every(annotation)))
  )
    return null;
  // Native Zotero handles never come from a saved document.
  const stripHandle = (entry: Record<string, unknown>) => {
    const data = { ...entry };
    delete data._item;
    return data;
  };
  return {
    ...value,
    items: value.items.map((entry) => ({
      ...entry,
      attachments: entry.attachments.map(stripHandle),
    })),
    ...(value.reader
      ? { reader: stripHandle(value.reader as Record<string, unknown>) }
      : {}),
  } as unknown as ClauderoSelectionContext;
}

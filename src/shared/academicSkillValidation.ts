import {
  isConfigRecord,
  isJsonConfigValue,
  isStringArray,
} from "./configValidation";

const choices = (value: unknown, values: string[]) =>
  typeof value === "string" && values.includes(value);

export function validateAcademicSkillSource(value: unknown): string | null {
  if (
    !isConfigRecord(value) ||
    !choices(value.type, [
      "builtin",
      "clauskill",
      "agent-skill",
      "mcp-prompt",
      "markdown",
    ])
  )
    return "Skill source.type is invalid.";
  for (const key of ["url", "sourceHash"]) {
    if (key in value && typeof value[key] !== "string")
      return `Skill source.${key} must be a string.`;
  }
  if (
    "importedAt" in value &&
    (typeof value.importedAt !== "number" ||
      !Number.isFinite(value.importedAt) ||
      value.importedAt < 0)
  )
    return "Skill source.importedAt must be a nonnegative timestamp.";
  return null;
}

/** Partial validation is only for import normalization; supplied fields are never coerced. */
export function validateAcademicSkill(
  value: unknown,
  partial = false,
): string | null {
  if (!isConfigRecord(value)) return "Skill must be an object.";
  for (const key of ["id", "title", "description", "routingGuidance"]) {
    if (partial && !(key in value)) continue;
    if (typeof value[key] !== "string") return `Skill ${key} must be a string.`;
    if ((key === "id" || key === "title") && !value[key].trim())
      return `Skill ${key} must not be empty.`;
  }
  if (
    (!partial || "category" in value) &&
    !choices(value.category, [
      "reading",
      "extraction",
      "comparison",
      "writing",
      "verification",
    ])
  )
    return "Skill category is invalid.";
  if (
    "builtinVersion" in value &&
    (!Number.isInteger(value.builtinVersion) ||
      (value.builtinVersion as number) < 1)
  )
    return "Skill builtinVersion must be a positive integer.";
  for (const key of ["intentExamples", "negativeExamples", "keywords"]) {
    if ((partial || key === "negativeExamples") && !(key in value)) continue;
    if (!isStringArray(value[key]))
      return `Skill ${key} must be an array of strings.`;
  }
  if (!partial || "contextRequirements" in value) {
    const req = value.contextRequirements;
    if (!isConfigRecord(req))
      return "Skill contextRequirements must be an object.";
    if (
      "selectedItems" in req &&
      !choices(req.selectedItems, ["none", "one", "many", "optional"])
    )
      return "Skill contextRequirements.selectedItems is invalid.";
    for (const key of ["pdfText", "annotations", "notes"]) {
      if (
        key in req &&
        !choices(req[key], ["none", "optional", "preferred", "required"])
      )
        return `Skill contextRequirements.${key} is invalid.`;
    }
  }
  if (!partial || "toolPolicy" in value) {
    const policy = value.toolPolicy;
    if (!isConfigRecord(policy)) return "Skill toolPolicy must be an object.";
    for (const key of [
      "zoteroMcp",
      "allowZoteroRead",
      "allowZoteroWrite",
      "allowWebSearch",
      "allowScripts",
    ]) {
      if (typeof policy[key] !== "boolean")
        return `Skill toolPolicy.${key} must be a boolean.`;
    }
  }
  if (!partial || "outputContract" in value) {
    const output = value.outputContract;
    if (!isConfigRecord(output))
      return "Skill outputContract must be an object.";
    if (
      !choices(output.format, [
        "markdown",
        "markdown-table",
        "json",
        "zotero-note",
      ])
    )
      return "Skill outputContract.format is invalid.";
    if (!choices(output.target, ["chat", "zotero-note-preview", "zotero-note"]))
      return "Skill outputContract.target is invalid.";
    if (
      "language" in output &&
      !choices(output.language, ["auto", "zh-CN", "en-US"])
    )
      return "Skill outputContract.language is invalid.";
    for (const key of ["sections", "columns"]) {
      if (key in output && !isStringArray(output[key]))
        return `Skill outputContract.${key} must be an array of strings.`;
    }
  }
  if (!partial || "promptTemplate" in value) {
    const prompt = value.promptTemplate;
    if (
      !isConfigRecord(prompt) ||
      typeof prompt.system !== "string" ||
      typeof prompt.task !== "string"
    )
      return "Skill promptTemplate must contain system and task strings.";
  }
  if ("source" in value) {
    const error = validateAcademicSkillSource(value.source);
    if (error) return error;
  }
  return isJsonConfigValue(value) ? null : "Skill must contain only JSON data.";
}

export function validateStoredAcademicSkill(
  value: unknown,
  id: string,
): string | null {
  if (!isConfigRecord(value)) return "Stored skill must be an object.";
  if (value.id !== id || !id.trim())
    return "Stored skill id must match its storage key.";
  if (typeof value.enabled !== "boolean")
    return "Stored skill enabled must be a boolean.";
  if (
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    value.updatedAt < 0
  )
    return "Stored skill updatedAt must be a nonnegative timestamp.";
  if (
    "basedOnBuiltinHash" in value &&
    value.basedOnBuiltinHash !== undefined &&
    typeof value.basedOnBuiltinHash !== "string"
  )
    return "Stored skill basedOnBuiltinHash must be a string.";
  if (value.source !== undefined) {
    const error = validateAcademicSkillSource(value.source);
    if (error) return error;
  }
  const error = validateAcademicSkill(value.skill);
  if (error) return error;
  if ((value.skill as Record<string, unknown>).id !== id)
    return "Skill id must match its storage key.";
  return null;
}

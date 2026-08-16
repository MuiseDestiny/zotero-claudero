export interface AcademicToolPolicy {
  zoteroMcp: boolean;
  allowZoteroRead: boolean;
  allowZoteroWrite: boolean;
  allowWebSearch: boolean;
  allowScripts: boolean;
}

const ZOTERO_WRITE_TOOLS = new Set([
  "write_tags",
  "create_note",
  "set_field",
  "undo_last",
]);

function normalizedToolName(toolName: string): string {
  return toolName.replace(/\s+/g, "").toLowerCase();
}

function zoteroToolAction(toolName: string): string | null {
  const normalized = normalizedToolName(toolName);
  const marker = "mcp__zotero__";
  const index = normalized.indexOf(marker);
  if (index >= 0) return normalized.slice(index + marker.length);
  return normalized.startsWith("zotero_") ? normalized.slice(7) : null;
}

export function toolPolicyDenialReason(
  toolName: string,
  policy: AcademicToolPolicy | undefined,
): string | null {
  if (!policy) return null;
  const normalized = normalizedToolName(toolName);
  const zoteroAction = zoteroToolAction(toolName);

  if (zoteroAction) {
    if (!policy.zoteroMcp || !policy.allowZoteroRead) {
      return "This academic skill does not allow Zotero tool access.";
    }
    if (ZOTERO_WRITE_TOOLS.has(zoteroAction) && !policy.allowZoteroWrite) {
      return "This academic skill is read-only and cannot modify Zotero data.";
    }
  }

  if (
    !policy.allowWebSearch &&
    ["websearch", "webfetch", "web_search", "web_fetch"].some((name) =>
      normalized.includes(name),
    )
  ) {
    return "This academic skill does not allow web search or web fetch tools.";
  }

  if (
    !policy.allowScripts &&
    [
      "bash",
      "commandexecution",
      "exec_command",
      "codeexecution",
      "code_execution",
    ].some((name) => normalized.includes(name))
  ) {
    return "This academic skill does not allow shell or script execution.";
  }

  return null;
}

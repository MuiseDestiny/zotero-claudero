import { getEnabledAcademicSkills } from "./academicSkills";
import { queryClaudeHelper, reloadSlashCommands } from "./claudeHelperClient";
import { getSelectedZoteroContext } from "./zoteroContext";
import { getZoteroApiSystemPrompt } from "./zoteroEndpoint";

/** Replace only external reads/transport in tests; production uses existing services. */
export const paneRequestServices = {
  queryClaudeHelper,
  reloadSlashCommands,
  getSelectedZoteroContext,
  getEnabledAcademicSkills,
  getZoteroApiSystemPrompt,
};

export type PaneRequestServices = typeof paneRequestServices;

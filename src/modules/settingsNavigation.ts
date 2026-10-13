import { config } from "../../package.json";
import { setPref } from "../utils/prefs";

export function openClauderoSettings(
  panel:
    | "general"
    | "claude"
    | "codex"
    | "deepseek"
    | "diagnostics" = "general",
): void {
  const panes = (
    Zotero.PreferencePanes as unknown as {
      pluginPanes: Array<{ id: string; pluginID: string }>;
    }
  ).pluginPanes;
  const pane = panes.find((entry) => entry.pluginID === config.addonID);
  if (!pane) return;
  setPref("settingsProvider", panel);
  const win = Zotero.Utilities.Internal.openPreferences(pane.id);
  // A new pane reads settingsProvider during initialization. An already-open
  // pane needs its tab selected explicitly.
  win?.document
    .querySelector<HTMLButtonElement>(`#claudero-pref-tab-${panel}`)
    ?.click();
}

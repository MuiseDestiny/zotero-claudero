import {
  registerClauderoMenu,
  registerClauderoPane,
  registerClauderoStyles,
  registerClauderoToolbarButton,
  unregisterClauderoPane,
} from "./modules/clauderoPane";
import {
  prewarmClaudeHelper,
  shutdownClaudeHelper,
} from "./modules/claudeHelperClient";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  registerZoteroEndpoint,
  unregisterZoteroEndpoint,
} from "./modules/zoteroEndpoint";
import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  addon.data.ztoolkit = createZToolkit();
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: addon.data.config.addonName,
    image: `chrome://${addon.data.config.addonRef}/content/icons/claudero.svg`,
  });

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
  registerZoteroEndpoint();
  void prewarmClaudeHelper();
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
  registerClauderoStyles(win);
  registerClauderoPane(win);
  registerClauderoToolbarButton(win);
  registerClauderoMenu();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  unregisterClauderoPane(win);
}

function onShutdown(): void {
  shutdownClaudeHelper();
  unregisterZoteroEndpoint();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {
  return;
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {
  return;
}

function onDialogEvents(_type: string) {
  return;
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};

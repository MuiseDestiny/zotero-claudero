import { config } from "../package.json";

/** View modules normally execute inside the plugin sandbox. */
export function installUiTestContext(): () => void {
  const globals = window as unknown as Record<string, unknown>;
  const previousAddon = globals.addon;
  const previousToolkit = globals.ztoolkit;
  const instance = (Zotero as unknown as Record<string, typeof addon>)[
    config.addonInstance
  ];
  globals.addon = instance;
  globals.ztoolkit = instance.data.ztoolkit;
  return () => {
    if (previousAddon === undefined) delete globals.addon;
    else globals.addon = previousAddon;
    if (previousToolkit === undefined) delete globals.ztoolkit;
    else globals.ztoolkit = previousToolkit;
  };
}

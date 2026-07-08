import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  defineBrowserGlobal("NodeFilter");
  defineBrowserGlobal("DOMParser");
  defineBrowserGlobal("XMLSerializer");
  defineBrowserGlobal("HTMLCanvasElement");
  defineBrowserGlobal("FileReader");
  defineBrowserGlobal("MutationObserver");
  defineBrowserGlobal("ResizeObserver");
  defineBrowserGlobal("IntersectionObserver");
  defineBrowserGlobal("CustomEvent");
  defineBrowserGlobal("KeyboardEvent");
  defineBrowserGlobal("MouseEvent");
  defineBrowserGlobal("Event");
  defineBrowserGlobal("Node");
  defineBrowserGlobal("Element");
  defineBrowserGlobal("HTMLElement");
  defineBrowserGlobal("XPathResult");
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}

function defineBrowserGlobal(name: string): void {
  defineGlobal(name, () => {
    const mainWindow = Zotero.getMainWindow() as Window & Record<string, any>;
    return mainWindow[name];
  });
}

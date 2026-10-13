export function resolveBrowserGlobal(
  name: string,
  mainWindow: Window | null = Zotero.getMainWindow(),
): unknown {
  const sources = [
    mainWindow,
    (
      Services as unknown as {
        appShell?: { hiddenDOMWindow?: Window };
      }
    ).appShell?.hiddenDOMWindow,
  ];
  for (const source of sources) {
    try {
      const value = (source as (Window & Record<string, unknown>) | null)?.[
        name
      ];
      if (value !== undefined) return value;
    } catch {
      // Try the next browser global source.
    }
  }
  // Zotero's headless runner has no browser window. Keep Web API instances
  // alive in a dedicated Gecko sandbox rather than weakening token creation.
  if (headlessProperties.has(name)) {
    if (sandboxGlobals.has(name)) return sandboxGlobals.get(name);
    try {
      const utilities = Components.utils as unknown as {
        Sandbox: (
          principal: unknown,
          options: { wantGlobalProperties: string[] },
        ) => Record<string, unknown>;
      };
      const sandbox = utilities.Sandbox(
        Services.scriptSecurityManager.getSystemPrincipal(),
        { wantGlobalProperties: [name] },
      );
      const value = sandbox[name];
      if (value !== undefined) {
        sandboxGlobals.set(name, value);
        return value;
      }
    } catch {
      // Not every Gecko version exposes every property in a sandbox.
    }
  }
  return undefined;
}
const sandboxGlobals = new Map<string, unknown>();
const headlessProperties = new Set([
  "AbortController",
  "AbortSignal",
  "Blob",
  "DOMException",
  "DOMParser",
  "FileReader",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "TextDecoder",
  "TextEncoder",
  "URL",
  "URLSearchParams",
  "XMLSerializer",
  "crypto",
]);

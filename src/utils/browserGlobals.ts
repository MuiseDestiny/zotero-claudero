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
  return undefined;
}

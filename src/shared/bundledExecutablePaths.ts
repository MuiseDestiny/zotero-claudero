// Shared by local setup checks and the helper so bundled installations do not
// require a separate CLI installation or a manually copied executable path.
export function bundledCodexCandidates(
  platform: string,
  home: string,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      `${home}/Applications/ChatGPT.app/Contents/Resources/codex`,
      `${home}/Applications/Codex.app/Contents/Resources/codex`,
    ];
  }
  return [];
}

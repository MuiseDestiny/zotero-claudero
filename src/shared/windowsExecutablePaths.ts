export interface WindowsExecutableEnvironment {
  appData?: string;
  localAppData?: string;
  programFiles?: string;
  programFilesX86?: string;
}

function joinWindows(root: string, ...parts: string[]): string {
  const base = root.trim().replace(/[\\/]+$/, "");
  if (!base) return "";
  return [base, ...parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, ""))]
    .filter(Boolean)
    .join("\\");
}

function uniqueWindowsPaths(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function windowsClaudeNativeCandidates(
  home: string,
  environment: WindowsExecutableEnvironment = {},
): string[] {
  const localAppData =
    environment.localAppData || joinWindows(home, "AppData", "Local");
  const programFiles = environment.programFiles || "C:\\Program Files";
  const programFilesX86 =
    environment.programFilesX86 || "C:\\Program Files (x86)";

  return uniqueWindowsPaths([
    joinWindows(home, ".local", "bin", "claude.exe"),
    joinWindows(home, ".claude", "local", "claude.exe"),
    joinWindows(localAppData, "Programs", "Claude", "claude.exe"),
    joinWindows(localAppData, "Claude", "claude.exe"),
    joinWindows(programFiles, "Claude", "claude.exe"),
    joinWindows(programFiles, "Claude Code", "claude.exe"),
    joinWindows(programFilesX86, "Claude", "claude.exe"),
  ]);
}

export function windowsClaudePackageRoots(
  home: string,
  environment: WindowsExecutableEnvironment = {},
  pathDirectories: string[] = [],
): string[] {
  const appData =
    environment.appData || joinWindows(home, "AppData", "Roaming");
  const packageParts = ["node_modules", "@anthropic-ai", "claude-code"];
  return uniqueWindowsPaths([
    ...pathDirectories.map((directory) =>
      joinWindows(directory, ...packageParts),
    ),
    joinWindows(appData, "npm", ...packageParts),
  ]);
}

export function claudePackageEntrypointCandidates(
  packageRoots: string[],
): string[] {
  return uniqueWindowsPaths(
    packageRoots.flatMap((root) => [
      joinWindows(root, "cli-wrapper.cjs"),
      joinWindows(root, "cli.js"),
    ]),
  );
}

export function windowsClaudeCandidates(
  home: string,
  environment: WindowsExecutableEnvironment = {},
  pathDirectories: string[] = [],
): string[] {
  return [
    ...windowsClaudeNativeCandidates(home, environment),
    ...claudePackageEntrypointCandidates(
      windowsClaudePackageRoots(home, environment, pathDirectories),
    ),
  ];
}

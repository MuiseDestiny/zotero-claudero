import {
  getCodexInstallationMethod,
  getHostKey,
  getProviderCliPath,
  setProviderCliPath,
  type AiProvider,
} from "./providerRegistry";
import { getPref, setPref } from "../utils/prefs";
import { windowsClaudeCandidates } from "../shared/windowsExecutablePaths";
import { bundledCodexCandidates } from "../shared/bundledExecutablePaths";

export interface SettingsAutoDetectResult {
  nodePath?: string;
  claudePath?: string;
  codexPath?: string;
  deepseekPath?: string;
}

export async function settingsFileExists(path: string): Promise<boolean> {
  if (!path.trim()) return false;
  try {
    return (await IOUtils.stat(path)).type === "regular";
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function getProfilePath(): string {
  const profile = Zotero as typeof Zotero & {
    Profile?: { dir?: string | nsIFile };
  };
  const dir = profile.Profile?.dir;
  if (typeof dir === "string") return dir;
  if (dir && typeof dir === "object" && "path" in dir) {
    return (dir as nsIFile).path;
  }
  return Zotero.Profile.dir;
}

function getHomePath(): string {
  const fromEnv =
    Services.env.get("HOME") ||
    Services.env.get("USERPROFILE") ||
    Services.env.get("USER") ||
    "";
  if (fromEnv && (fromEnv.startsWith("/") || /^[A-Z]:\\/i.test(fromEnv))) {
    return fromEnv;
  }

  const profilePath = getProfilePath();
  return (
    profilePath.split(
      /\/Library\/Application Support\/|\/\.zotero\/|\\AppData\\/,
    )[0] || ""
  );
}

function pathCandidates(executableName: string): string[] {
  const home = getHomePath();
  const managedDeepSeekEntrypoint = PathUtils.join(
    home,
    ".claudero",
    "deepseek",
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  const pathDirs = Services.env
    .get("PATH")
    .split(Zotero.isWin ? ";" : ":")
    .filter(Boolean);

  if (Zotero.isWin) {
    const executables =
      executableName === "dsh"
        ? ["dsh.cmd", "dsh.exe"]
        : [`${executableName}.exe`];
    const environment = {
      appData: Services.env.get("APPDATA"),
      localAppData: Services.env.get("LOCALAPPDATA"),
      programFiles: Services.env.get("ProgramFiles"),
      programFilesX86: Services.env.get("ProgramFiles(x86)"),
    };
    const appData =
      environment.appData || PathUtils.join(home, "AppData", "Roaming");
    const localAppData =
      environment.localAppData || PathUtils.join(home, "AppData", "Local");
    const programFiles = environment.programFiles || "C:\\Program Files";
    const programFilesX86 =
      environment.programFilesX86 || "C:\\Program Files (x86)";
    return unique([
      ...(executableName === "dsh" ? [managedDeepSeekEntrypoint] : []),
      ...pathDirs.flatMap((dir) =>
        executables.map((executable) => PathUtils.join(dir, executable)),
      ),
      ...(executableName === "claude"
        ? windowsClaudeCandidates(home, environment, pathDirs)
        : []),
      ...(executableName === "node" && Services.env.get("NVM_SYMLINK")
        ? [PathUtils.join(Services.env.get("NVM_SYMLINK"), "node.exe")]
        : []),
      ...(executableName === "codex"
        ? [
            PathUtils.join(
              localAppData,
              "Programs",
              "OpenAI",
              "Codex",
              "bin",
              "codex.exe",
            ),
            PathUtils.join(programFiles, "OpenAI", "Codex", "codex.exe"),
          ]
        : []),
      ...(executableName === "dsh"
        ? [
            PathUtils.join(
              appData,
              "npm",
              "node_modules",
              "@deepseek-ai",
              "dsh",
              "lib",
              "bin.js",
            ),
          ]
        : []),
      ...executables.flatMap((executable) => [
        PathUtils.join(home, ".local", "bin", executable),
        PathUtils.join(appData, "npm", executable),
        PathUtils.join(localAppData, executableName, executable),
        PathUtils.join(localAppData, "Programs", executableName, executable),
        PathUtils.join(programFiles, executableName, executable),
        PathUtils.join(programFiles, "nodejs", executable),
        PathUtils.join(programFilesX86, "nodejs", executable),
      ]),
    ]);
  }

  return unique([
    ...(executableName === "dsh" ? [managedDeepSeekEntrypoint] : []),
    ...(executableName === "codex"
      ? bundledCodexCandidates(Zotero.isMac ? "darwin" : "linux", home)
      : []),
    ...pathDirs.map((dir) => PathUtils.join(dir, executableName)),
    PathUtils.join(home, ".claude", "local", executableName),
    PathUtils.join(home, ".npm-global", "bin", executableName),
    PathUtils.join(home, ".local", "bin", executableName),
    PathUtils.join(home, ".bun", "bin", executableName),
    PathUtils.join(home, ".docker", "bin", executableName),
    PathUtils.join(home, ".volta", "bin", executableName),
    PathUtils.join(home, ".asdf", "shims", executableName),
    PathUtils.join("/opt/homebrew/bin", executableName),
    PathUtils.join("/usr/local/bin", executableName),
    PathUtils.join("/usr/bin", executableName),
    PathUtils.join("/bin", executableName),
  ]);
}

async function nvmBinCandidates(): Promise<string[]> {
  if (Zotero.isWin) return [];
  const nvmDir =
    Services.env.get("NVM_DIR") || PathUtils.join(getHomePath(), ".nvm");
  const versionsDir = PathUtils.join(nvmDir, "versions", "node");
  try {
    if (!(await IOUtils.exists(versionsDir))) return [];
    const versions = (
      (await (IOUtils as any).getChildren(versionsDir)) as string[]
    ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map((versionDir) => PathUtils.join(versionDir, "bin"));
  } catch {
    return [];
  }
}

async function findExecutable(
  executableName: string,
  getNvmBins: () => Promise<string[]>,
): Promise<string> {
  const nodePath = String(getPref("nodePath") || "").trim();
  const nodeBin = nodePath.replace(/[\\/][^\\/]+$/, "");
  const candidates =
    executableName === "node"
      ? unique([
          ...(await getNvmBins()).map((bin) => PathUtils.join(bin, "node")),
          ...pathCandidates("node"),
        ])
      : unique([
          ...(nodeBin && !Zotero.isWin
            ? [PathUtils.join(nodeBin, executableName)]
            : []),
          ...pathCandidates(executableName),
          ...(await getNvmBins()).map((bin) =>
            PathUtils.join(bin, executableName),
          ),
        ]);
  for (const candidate of candidates) {
    if (await settingsFileExists(candidate)) return candidate;
  }
  return "";
}

let pendingDetection: Promise<SettingsAutoDetectResult> | undefined;

function detectedPaths(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(
      String(getPref("autoDetectedPaths") || "{}"),
    );
    if (!stored || typeof stored !== "object" || Array.isArray(stored))
      return {};
    return Object.fromEntries(
      Object.entries(stored).filter(([, value]) => typeof value === "string"),
    );
  } catch {
    return {};
  }
}

function rememberDetectedPath(key: string, value: string): void {
  setPref(
    "autoDetectedPaths",
    JSON.stringify({
      ...detectedPaths(),
      [`${getHostKey()}:${key}`]: value,
    }),
  );
}

async function needsDiscovery(
  key: string,
  configured: string,
): Promise<boolean> {
  if (!configured) return true;
  // Only repair paths we chose. Unknown/legacy or manually overridden paths
  // remain the user's choice, even when unavailable. Never guess provenance.
  return (
    detectedPaths()[`${getHostKey()}:${key}`] === configured &&
    !(await settingsFileExists(configured))
  );
}

export function autoDetectSettings(): Promise<SettingsAutoDetectResult> {
  // Preferences and helper startup share a scan, but future explicit scans
  // must still see newly installed programs (including previous misses).
  return (pendingDetection ||= detectSettings().finally(() => {
    pendingDetection = undefined;
  }));
}

async function detectSettings(): Promise<SettingsAutoDetectResult> {
  const result: SettingsAutoDetectResult = {};
  // A CLI may live under a different NVM version than the helper's Node.js.
  // Share one asynchronous directory scan across all providers.
  let nvmBins: Promise<string[]> | undefined;
  const getNvmBins = () => (nvmBins ||= nvmBinCandidates());

  const configuredNode = String(getPref("nodePath") || "").trim();
  if (await needsDiscovery("node", configuredNode)) {
    const nodePath = await findExecutable("node", getNvmBins);
    if (
      nodePath &&
      String(getPref("nodePath") || "").trim() === configuredNode
    ) {
      setPref("nodePath", nodePath);
      rememberDetectedPath("node", nodePath);
      result.nodePath = nodePath;
    }
  }

  const providers: AiProvider[] = ["claude", "codex", "deepseek"];
  for (const provider of providers) {
    if (provider === "codex" && getCodexInstallationMethod() === "wsl")
      continue;
    const configuredPath = getProviderCliPath(provider);
    if (!(await needsDiscovery(provider, configuredPath))) continue;
    const cliPath = await findExecutable(
      provider === "deepseek" ? "dsh" : provider,
      getNvmBins,
    );
    // The user may select WSL while filesystem discovery is still in flight.
    if (provider === "codex" && getCodexInstallationMethod() === "wsl")
      continue;
    if (!cliPath || getProviderCliPath(provider) !== configuredPath) continue;
    setProviderCliPath(provider, cliPath);
    rememberDetectedPath(provider, cliPath);
    if (provider === "claude") result.claudePath = cliPath;
    else if (provider === "codex") result.codexPath = cliPath;
    else result.deepseekPath = cliPath;
  }

  return result;
}

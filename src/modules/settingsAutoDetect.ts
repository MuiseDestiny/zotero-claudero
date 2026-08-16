import {
  getProviderCliPath,
  setProviderCliPath,
  type AiProvider,
} from "./providerRegistry";
import { getPref, setPref } from "../utils/prefs";
import { windowsClaudeCandidates } from "../shared/windowsExecutablePaths";

export interface SettingsAutoDetectResult {
  nodePath?: string;
  claudePath?: string;
  codexPath?: string;
  deepseekPath?: string;
}

function fileExists(path: string): boolean {
  if (!path.trim()) return false;
  try {
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile) as nsIFile;
    file.initWithPath(path);
    return file.exists() && file.isFile();
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
    profilePath.split("/Library/Application Support/")[0] ||
    profilePath.split("/.zotero/")[0] ||
    profilePath.split("\\AppData\\")[0] ||
    ""
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
    return unique([
      ...(executableName === "dsh" ? [managedDeepSeekEntrypoint] : []),
      ...pathDirs.flatMap((dir) =>
        executables.map((executable) => PathUtils.join(dir, executable)),
      ),
      ...(executableName === "claude"
        ? windowsClaudeCandidates(home, environment, pathDirs)
        : []),
      ...executables.flatMap((executable) => [
        PathUtils.join(home, "AppData", "Local", executableName, executable),
        PathUtils.join(
          home,
          "AppData",
          "Local",
          "Programs",
          executableName,
          executable,
        ),
        PathUtils.join("C:\\Program Files", executableName, executable),
        PathUtils.join("C:\\Program Files\\nodejs", executable),
      ]),
    ]);
  }

  return unique([
    ...(executableName === "dsh" ? [managedDeepSeekEntrypoint] : []),
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

async function nvmNodeCandidates(): Promise<string[]> {
  if (Zotero.isWin) return [];
  const versionsDir = PathUtils.join(getHomePath(), ".nvm", "versions", "node");
  try {
    if (!(await IOUtils.exists(versionsDir))) return [];
    const versions = (
      (await (IOUtils as any).getChildren(versionsDir)) as string[]
    ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions.map((versionDir) =>
      PathUtils.join(versionDir, "bin", "node"),
    );
  } catch {
    return [];
  }
}

async function findExecutable(executableName: string): Promise<string> {
  const candidates =
    executableName === "node"
      ? unique([...(await nvmNodeCandidates()), ...pathCandidates("node")])
      : pathCandidates(executableName);
  return candidates.find(fileExists) || "";
}

export async function autoDetectSettings(): Promise<SettingsAutoDetectResult> {
  const result: SettingsAutoDetectResult = {};

  if (!String(getPref("nodePath") || "").trim()) {
    const nodePath = await findExecutable("node");
    if (nodePath) {
      setPref("nodePath", nodePath);
      result.nodePath = nodePath;
    }
  }

  const providers: AiProvider[] = ["claude", "codex", "deepseek"];
  for (const provider of providers) {
    if (getProviderCliPath(provider)) continue;
    const cliPath = await findExecutable(
      provider === "deepseek" ? "dsh" : provider,
    );
    if (!cliPath) continue;
    setProviderCliPath(provider, cliPath);
    if (provider === "claude") result.claudePath = cliPath;
    else if (provider === "codex") result.codexPath = cliPath;
    else result.deepseekPath = cliPath;
  }

  return result;
}

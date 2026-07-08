import {
  getProviderCliPath,
  setProviderCliPath,
  type AiProvider,
} from "./providerRegistry";
import { getPref, setPref } from "../utils/prefs";

export interface SettingsAutoDetectResult {
  nodePath?: string;
  claudePath?: string;
  codexPath?: string;
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
  const pathDirs = Services.env
    .get("PATH")
    .split(Zotero.isWin ? ";" : ":")
    .filter(Boolean);

  if (Zotero.isWin) {
    const exe = `${executableName}.exe`;
    return unique([
      ...pathDirs.map((dir) => PathUtils.join(dir, exe)),
      PathUtils.join(home, "AppData", "Local", executableName, exe),
      PathUtils.join(home, "AppData", "Local", "Programs", executableName, exe),
      PathUtils.join("C:\\Program Files", executableName, exe),
      PathUtils.join("C:\\Program Files\\nodejs", exe),
    ]);
  }

  return unique([
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

  const providers: AiProvider[] = ["claude", "codex"];
  for (const provider of providers) {
    if (getProviderCliPath(provider)) continue;
    const cliPath = await findExecutable(provider);
    if (!cliPath) continue;
    setProviderCliPath(provider, cliPath);
    if (provider === "claude") result.claudePath = cliPath;
    else result.codexPath = cliPath;
  }

  return result;
}

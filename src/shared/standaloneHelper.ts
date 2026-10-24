import { CLAUDERO_HELPER_VERSION } from "./helperProtocol";

export const HELPER_BUN_VERSION = "1.4.2";
export type HelperPlatform = "darwin" | "linux" | "win32";
export type HelperArchitecture = "arm64" | "x64";

export interface StandaloneHelperBinary {
  platform: HelperPlatform;
  arch: HelperArchitecture;
  file: string;
  sha256: string;
  bytes: number;
}

export interface StandaloneHelperManifest {
  schemaVersion: 1;
  helperVersion: number;
  bunVersion: string;
  binaries: StandaloneHelperBinary[];
}

export function parseStandaloneHelperManifest(
  value: unknown,
): StandaloneHelperManifest {
  if (!value || typeof value !== "object")
    throw new Error("Invalid standalone Helper manifest");
  const manifest = value as Partial<StandaloneHelperManifest>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.helperVersion !== CLAUDERO_HELPER_VERSION ||
    manifest.bunVersion !== HELPER_BUN_VERSION ||
    !Array.isArray(manifest.binaries) ||
    manifest.binaries.length < 1 ||
    manifest.binaries.length > 6
  )
    throw new Error("Incompatible standalone Helper manifest");
  const seen = new Set<string>();
  for (const binary of manifest.binaries) {
    if (!binary || typeof binary !== "object")
      throw new Error("Invalid standalone Helper binary");
    const { platform, arch, file, sha256, bytes } = binary;
    const key = `${platform}-${arch}`;
    if (
      !["darwin", "linux", "win32"].includes(platform) ||
      !["arm64", "x64"].includes(arch) ||
      file !== `claudero-helper-${key}${platform === "win32" ? ".exe" : ""}` ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1024 * 1024 ||
      bytes > 200 * 1024 * 1024 ||
      seen.has(key)
    )
      throw new Error("Invalid standalone Helper binary metadata");
    seen.add(key);
  }
  return manifest as StandaloneHelperManifest;
}

export function selectStandaloneHelper(
  manifest: StandaloneHelperManifest,
  platform: HelperPlatform,
  abi: string,
): StandaloneHelperBinary | undefined {
  const cpu = abi.split("-")[0].toLowerCase();
  const arch =
    cpu === "aarch64" || cpu === "arm64"
      ? "arm64"
      : cpu === "x86_64" || cpu === "x64"
        ? "x64"
        : undefined;
  return manifest.binaries.find(
    (binary) => binary.platform === platform && binary.arch === arch,
  );
}

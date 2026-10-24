import { throwIfAborted } from "../shared/helperStream";
import {
  parseStandaloneHelperManifest,
  selectStandaloneHelper,
  type StandaloneHelperManifest,
  type StandaloneHelperBinary,
} from "../shared/standaloneHelper";

export async function providerCliNeedsNode(cliPath: string): Promise<boolean> {
  if (!cliPath || /\.exe$/i.test(cliPath)) return false;
  if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx|cmd|bat)$/i.test(cliPath)) return true;
  try {
    const prefix = new TextDecoder().decode(
      await IOUtils.read(cliPath, { maxBytes: 256 }),
    );
    return /^#![^\r\n]*\bnode(?:js)?\b/.test(prefix);
  } catch {
    return true;
  }
}

async function bundledBinary(): Promise<
  | { manifest: StandaloneHelperManifest; binary: StandaloneHelperBinary }
  | undefined
> {
  let response: Response;
  try {
    response = await fetch(`${rootURI}content/helper/standalone/manifest.json`);
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const manifest = parseStandaloneHelperManifest(await response.json());
  const platform = Zotero.isMac ? "darwin" : Zotero.isWin ? "win32" : "linux";
  const binary = selectStandaloneHelper(
    manifest,
    platform,
    Services.appinfo?.XPCOMABI || "",
  );
  return binary ? { manifest, binary } : undefined;
}

export async function hasStandaloneHelper(): Promise<boolean> {
  try {
    return !!(await bundledBinary());
  } catch {
    return false;
  }
}

export async function ensureStandaloneHelper(
  profilePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const bundled = await bundledBinary();
  throwIfAborted(signal);
  if (!bundled) return undefined;
  const { manifest, binary } = bundled;
  const directory = PathUtils.join(
    profilePath,
    "claudero",
    "helper",
    "standalone",
    `${manifest.helperVersion}-${binary.sha256}`,
  );
  const executable = PathUtils.join(directory, binary.file);
  let valid = false;
  try {
    valid =
      (await IOUtils.stat(executable)).size === binary.bytes &&
      (await IOUtils.computeHexDigest(executable, "sha256")) === binary.sha256;
  } catch {
    // Missing or damaged cached executables are restored from the trusted XPI.
  }
  throwIfAborted(signal);
  if (!valid) {
    const response = await fetch(
      `${rootURI}content/helper/standalone/${binary.file}`,
    );
    if (!response.ok)
      throw new Error("Failed to read bundled standalone Helper");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== binary.bytes)
      throw new Error("Standalone Helper size mismatch");
    throwIfAborted(signal);
    await IOUtils.makeDirectory(directory, {
      createAncestors: true,
      permissions: 0o700,
    });
    await IOUtils.write(executable, bytes, { tmpPath: `${executable}.tmp` });
    if (
      (await IOUtils.computeHexDigest(executable, "sha256")) !== binary.sha256
    ) {
      await IOUtils.remove(executable).catch(() => {});
      throw new Error("Standalone Helper SHA-256 mismatch");
    }
  }
  throwIfAborted(signal);
  if (!Zotero.isWin) await IOUtils.setPermissions(executable, 0o700);
  return executable;
}

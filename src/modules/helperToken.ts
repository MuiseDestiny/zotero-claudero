let helperTokenPromise: Promise<string> | null = null;

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

function generateHelperToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function restrictTokenFilePermissions(tokenPath: string): Promise<void> {
  if (Zotero.isWin) return;
  try {
    await IOUtils.setPermissions(tokenPath, 0o600);
  } catch {
    // Some filesystems do not expose POSIX permissions. The profile directory
    // remains the outer access boundary in that case.
  }
}

async function loadOrCreateHelperToken(): Promise<string> {
  const helperDir = PathUtils.join(getProfilePath(), "claudero", "helper");
  const tokenPath = PathUtils.join(helperDir, ".token");
  try {
    const existing = (await IOUtils.readUTF8(tokenPath)).trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      await restrictTokenFilePermissions(tokenPath);
      return existing;
    }
  } catch {
    // Create a token below.
  }

  const token = generateHelperToken();
  await IOUtils.makeDirectory(helperDir, { createAncestors: true });
  await IOUtils.writeUTF8(tokenPath, token);
  await restrictTokenFilePermissions(tokenPath);
  return token;
}

export function getOrCreateHelperToken(): Promise<string> {
  if (!helperTokenPromise) {
    helperTokenPromise = loadOrCreateHelperToken().catch((error) => {
      helperTokenPromise = null;
      throw error;
    });
  }
  return helperTokenPromise;
}

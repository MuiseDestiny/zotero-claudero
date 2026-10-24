import { assert } from "chai";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseStandaloneHelperManifest,
  selectStandaloneHelper,
  HELPER_BUN_VERSION,
} from "../src/shared/standaloneHelper";
import { CLAUDERO_HELPER_VERSION } from "../src/shared/helperProtocol";
import {
  ensureStandaloneHelper,
  hasStandaloneHelper,
  providerCliNeedsNode,
} from "../src/modules/standaloneHelper";

describe("standalone Helper packaging", function () {
  const bytes = new Uint8Array(1024 * 1024).fill(42);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const binary = {
    platform: "darwin",
    arch: "arm64",
    file: "claudero-helper-darwin-arm64",
    sha256: digest,
    bytes: bytes.length,
  } as const;
  const manifest = () => ({
    schemaVersion: 1,
    helperVersion: CLAUDERO_HELPER_VERSION,
    bunVersion: HELPER_BUN_VERSION,
    binaries: [{ ...binary }],
  });

  it("selects native ABI targets without running a binary for a different architecture", function () {
    const parsed = parseStandaloneHelperManifest(manifest());
    assert.equal(
      selectStandaloneHelper(parsed, "darwin", "aarch64-gcc3")?.file,
      binary.file,
    );
    assert.equal(
      selectStandaloneHelper(parsed, "darwin", "arm64-gcc3")?.file,
      binary.file,
    );
    assert.isUndefined(selectStandaloneHelper(parsed, "darwin", "x86_64-gcc3"));
    assert.isUndefined(selectStandaloneHelper(parsed, "linux", "aarch64-gcc3"));
    assert.isUndefined(selectStandaloneHelper(parsed, "darwin", "unknown"));
    const x64 = parseStandaloneHelperManifest({
      ...manifest(),
      binaries: [
        {
          ...binary,
          arch: "x64",
          platform: "win32",
          file: "claudero-helper-win32-x64.exe",
        },
      ],
    });
    assert.exists(selectStandaloneHelper(x64, "win32", "x86_64-msvc"));
  });

  it("rejects unsafe names, stale versions, invalid hashes, sizes, or duplicate targets", function () {
    for (const changed of [
      { helperVersion: CLAUDERO_HELPER_VERSION - 1 },
      { bunVersion: "unverified" },
      { schemaVersion: 2 },
      { binaries: [] },
      { binaries: [binary, binary] },
      ...[
        { file: "../escape" },
        { sha256: "bad" },
        { bytes: 1 },
        { bytes: 201 * 1024 * 1024 },
        { platform: "other" },
      ].map((change) => ({ binaries: [{ ...binary, ...change }] })),
    ])
      assert.throws(() =>
        parseStandaloneHelperManifest({ ...manifest(), ...changed }),
      );
  });

  it("verifies, reuses, repairs, and permission-restricts the extracted binary", async function () {
    const globals = globalThis as unknown as Record<string, unknown>;
    const names = [
      "Zotero",
      "Services",
      "PathUtils",
      "IOUtils",
      "rootURI",
      "fetch",
    ];
    const saved = names.map((name) => globals[name]);
    const files = new Map<string, Uint8Array>();
    let writes = 0,
      downloads = 0,
      permissions = 0;
    let corrupt = false,
      available = true;
    globals.Zotero = { isMac: true };
    globals.Services = { appinfo: { XPCOMABI: "aarch64-gcc3" } };
    globals.PathUtils = { join: path.posix.join };
    globals.rootURI = "file:///fixture/";
    globals.fetch = async (url: string) => {
      if (!available) return new Response("", { status: 404 });
      if (url.endsWith("manifest.json")) return Response.json(manifest());
      downloads++;
      return new Response(
        corrupt ? new Uint8Array(bytes.length).fill(0) : bytes,
      );
    };
    globals.IOUtils = {
      stat: async (file: string) => ({ size: files.get(file)?.length || 0 }),
      computeHexDigest: async (file: string) =>
        createHash("sha256")
          .update(files.get(file) || "")
          .digest("hex"),
      makeDirectory: async () => {},
      write: async (
        file: string,
        value: Uint8Array,
        options: { tmpPath?: string },
      ) => {
        assert.equal(options.tmpPath, `${file}.tmp`);
        files.set(file, value);
        writes++;
      },
      setPermissions: async (_file: string, mode: number) => {
        assert.equal(mode, 0o700);
        permissions++;
      },
      remove: async (file: string) => {
        files.delete(file);
      },
    };
    try {
      assert.isTrue(await hasStandaloneHelper());
      const executable = await ensureStandaloneHelper("/fixture/profile");
      assert.include(executable!, `${CLAUDERO_HELPER_VERSION}-${digest}`);
      assert.equal(writes, 1);
      assert.equal(
        await ensureStandaloneHelper("/fixture/profile"),
        executable,
      );
      assert.equal(downloads, 1);
      files.set(executable!, new Uint8Array(bytes.length));
      await ensureStandaloneHelper("/fixture/profile");
      assert.equal(writes, 2);
      assert.equal(permissions, 3);
      files.clear();
      corrupt = true;
      const error = await ensureStandaloneHelper("/fixture/profile").catch(
        (error) => error,
      );
      assert.match(String(error), /SHA-256 mismatch/);
      assert.isEmpty([...files]);
      available = false;
      assert.isFalse(await hasStandaloneHelper());
      assert.isUndefined(await ensureStandaloneHelper("/fixture/profile"));
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete globals[name];
        else globals[name] = saved[index];
      });
    }
  });

  it("distinguishes native providers from Node scripts and npm shims", async function () {
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = globals.IOUtils;
    globals.IOUtils = {
      read: async (file: string) =>
        new TextEncoder().encode(
          file.endsWith("native")
            ? "\u007fELF"
            : "#!/usr/bin/env node\nfixture",
        ),
    };
    try {
      assert.isFalse(await providerCliNeedsNode("/fixture/native"));
      assert.isFalse(await providerCliNeedsNode("C:\\fixture\\native.exe"));
      assert.isTrue(await providerCliNeedsNode("/fixture/npm-link"));
      assert.isTrue(await providerCliNeedsNode("/fixture/cli.js"));
      assert.isTrue(await providerCliNeedsNode("C:\\fixture\\cli.cmd"));
    } finally {
      if (saved === undefined) delete globals.IOUtils;
      else globals.IOUtils = saved;
    }
  });
});

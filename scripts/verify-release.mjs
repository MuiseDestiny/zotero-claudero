#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const buildRoot = path.join(root, ".scaffold", "build");
const expectedRepository = "https://github.com/MuiseDestiny/zotero-claudero";
const expectedAddonId = "claudero@muisedestiny.com";
const failures = [];

function pass(name) {
  console.log(`[release] PASS ${name}`);
}

async function check(name, operation) {
  try {
    await operation();
    pass(name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : error}`);
    console.error(`[release] FAIL ${name}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function publishableFiles() {
  return [
    ...new Set(
      execFileSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        {
          cwd: root,
          encoding: "utf8",
        },
      )
        .split("\0")
        .filter(Boolean),
    ),
  ];
}

function isPrivateFile(file) {
  return (
    (/(?:^|\/)(?:\.env(?:\..*)?|AGENTS\.md|CLAUDE\.md|GEMINI\.md|zotero-cmd\.json)$/.test(
      file,
    ) &&
      file !== ".env.example") ||
    /^(?:\.scaffold|\.claude|\.codex|\.agents|\.vscode|\.claudero-eval|node_modules|build|logs|\.cache|coverage)\//.test(
      file,
    ) ||
    /\.(?:tsbuildinfo|xpi|log)$/.test(file) ||
    /^(?:doc\/agent-architecture\.md|docs\/(?:release-checklist|pdf-golden-eval|pre-release-check-[^/]+)\.md)$/.test(
      file,
    )
  );
}

const packageJson = await readJson(path.join(root, "package.json"));
const packageLock = await readJson(path.join(root, "package-lock.json"));
const updateFile = packageJson.version.includes("-")
  ? "update-beta.json"
  : "update.json";
const manifest = await readJson(path.join(buildRoot, "addon", "manifest.json"));
const updateManifest = await readJson(path.join(buildRoot, updateFile));
const xpiPath = path.join(buildRoot, "claudero.xpi");
const update = updateManifest.addons?.[expectedAddonId]?.updates?.[0];

await check("package metadata", async () => {
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version),
    "invalid semantic version",
  );
  assert(packageJson.license === "AGPL-3.0-or-later", "unexpected license");
  assert(packageJson.engines?.node === ">=20", "Node.js engine must be >=20");
  assert(
    packageJson.repository?.url === `git+${expectedRepository}.git`,
    "repository URL does not target zotero-claudero",
  );
  assert(
    packageJson.homepage?.startsWith(expectedRepository),
    "homepage URL is incorrect",
  );
  assert(
    packageJson.bugs?.url === `${expectedRepository}/issues`,
    "issues URL is incorrect",
  );
});

await check("package lock consistency", async () => {
  const rootPackage = packageLock.packages?.[""];
  assert(
    rootPackage?.version === packageJson.version,
    "package-lock version differs from package.json",
  );
  assert(
    rootPackage?.engines?.node === packageJson.engines.node,
    "package-lock Node engine differs from package.json",
  );
});

await check("built manifest", async () => {
  const zotero = manifest.applications?.zotero;
  assert(manifest.name === "Claudero", "unexpected add-on name");
  assert(
    manifest.version === packageJson.version,
    "manifest version differs from package.json",
  );
  assert(
    manifest.homepage_url === `${expectedRepository}#readme`,
    "manifest homepage is incorrect",
  );
  assert(zotero?.id === expectedAddonId, "manifest add-on ID is incorrect");
  assert(
    zotero?.strict_min_version === "6.999",
    "manifest must target Zotero 7+",
  );
  assert(
    zotero?.strict_max_version === "10.*",
    "manifest maximum Zotero version is unexpected",
  );
  assert(
    zotero?.update_url ===
      `${expectedRepository}/releases/download/release/${updateFile}`,
    "manifest update URL is incorrect",
  );
});

await check("release update metadata", async () => {
  assert(update, "missing update entry for Claudero");
  assert(
    update.version === packageJson.version,
    "update version differs from package.json",
  );
  assert(
    update.update_link ===
      `${expectedRepository}/releases/download/v${packageJson.version}/claudero.xpi`,
    "XPI download URL is incorrect",
  );
  assert(
    update.applications?.zotero?.strict_min_version ===
      manifest.applications.zotero.strict_min_version &&
      update.applications?.zotero?.strict_max_version ===
        manifest.applications.zotero.strict_max_version,
    "update compatibility range differs from manifest",
  );
});

await check("XPI package and checksum", async () => {
  const xpi = await readFile(xpiPath);
  const metadata = await stat(xpiPath);
  assert(metadata.size > 100_000, "XPI is unexpectedly small");
  assert(
    xpi[0] === 0x50 && xpi[1] === 0x4b,
    "XPI does not have a ZIP signature",
  );
  const actualHash = `sha512:${createHash("sha512").update(xpi).digest("hex")}`;
  assert(
    update?.update_hash === actualHash,
    "update_hash does not match claudero.xpi",
  );
  for (const relativePath of [
    "addon/bootstrap.js",
    "addon/content/helper/claudero-helper.mjs",
    "addon/content/scripts/claudero.js",
    "addon/manifest.json",
  ]) {
    const file = await stat(path.join(buildRoot, relativePath));
    assert(
      file.isFile() && file.size > 0,
      `missing build artifact: ${relativePath}`,
    );
  }
});

await check("bundled KaTeX version and assets", async () => {
  const katexRoot = path.join(root, "node_modules/katex");
  const katexPackage = await readJson(path.join(katexRoot, "package.json"));
  assert(
    katexPackage.version === packageJson.dependencies.katex,
    "installed KaTeX differs from the pinned renderer version",
  );
  assert(
    packageJson.overrides?.["@vscode/markdown-it-katex"]?.katex === "$katex",
    "Markdown plugin must use the same patched KaTeX renderer",
  );
  const files = [
    ["dist/katex.min.css", "katex.min.css"],
    ["LICENSE", "LICENSE.txt"],
    ...(await readdir(path.join(katexRoot, "dist/fonts"))).map((font) => [
      `dist/fonts/${font}`,
      `fonts/${font}`,
    ]),
  ];
  for (const [source, target] of files) {
    const expected = await readFile(path.join(katexRoot, source));
    const actual = await readFile(
      path.join(buildRoot, "addon/content/katex", target),
    );
    assert(actual.equals(expected), `outdated KaTeX asset: ${target}`);
  }
});

await check("publication file hygiene", async () => {
  const forbidden = publishableFiles().filter(isPrivateFile);
  assert(
    forbidden.length === 0,
    `private or generated publication files: ${forbidden.join(", ")}`,
  );
});

await check("publication secret scan", async () => {
  const textExtensions = new Set([
    ".css",
    ".example",
    ".ftl",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".toml",
    ".ts",
    ".xhtml",
    ".yaml",
    ".yml",
  ]);
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{32,}\b/,
    /\bghp_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  const matches = [];
  for (const file of publishableFiles()) {
    if (!textExtensions.has(path.extname(file)) && file !== ".env.example") {
      continue;
    }
    const value = await readFile(path.join(root, file), "utf8");
    if (patterns.some((pattern) => pattern.test(value))) matches.push(file);
  }
  assert(
    matches.length === 0,
    `possible credentials found in: ${matches.join(", ")}`,
  );
});

await check("release tag version", async () => {
  const tag =
    process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "";
  if (tag) {
    assert(
      tag === `v${packageJson.version}`,
      `tag ${tag} does not match package version ${packageJson.version}`,
    );
  }
});

if (failures.length > 0) {
  console.error("\nRelease verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\n[release] All release checks passed.");

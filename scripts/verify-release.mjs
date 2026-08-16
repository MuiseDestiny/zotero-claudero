#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

const packageJson = await readJson(path.join(root, "package.json"));
const packageLock = await readJson(path.join(root, "package-lock.json"));
const manifest = await readJson(path.join(buildRoot, "addon", "manifest.json"));
const updateManifest = await readJson(path.join(buildRoot, "update.json"));
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
      `${expectedRepository}/releases/download/release/update.json`,
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

await check("tracked file hygiene", async () => {
  const forbidden = trackedFiles().filter(
    (file) =>
      file === ".env" ||
      file.startsWith(".scaffold/") ||
      file.startsWith(".claudero-eval/") ||
      file.startsWith("node_modules/") ||
      file.endsWith(".tsbuildinfo") ||
      file.endsWith(".xpi"),
  );
  assert(
    forbidden.length === 0,
    `forbidden tracked files: ${forbidden.join(", ")}`,
  );
});

await check("tracked secret scan", async () => {
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
  for (const file of trackedFiles()) {
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

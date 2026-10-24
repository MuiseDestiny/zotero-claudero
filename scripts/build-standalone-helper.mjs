import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const bunVersion = "1.4.2";
const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "win32-arm64": "bun-windows-arm64",
  "win32-x64": "bun-windows-x64-baseline",
};

export async function buildStandaloneHelper(dist) {
  if (process.env.CLAUDERO_STANDALONE_HELPER !== "1") return;
  const bun = process.env.CLAUDERO_BUN_PATH || "bun";
  const version = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim();
  if (version !== bunVersion)
    throw new Error(
      `Standalone Helper requires Bun ${bunVersion}, not ${version}`,
    );
  const selected = (
    process.env.CLAUDERO_HELPER_TARGETS || `${process.platform}-${process.arch}`
  )
    .split(",")
    .map((target) => target.trim());
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((target) => !Object.hasOwn(targets, target))
  )
    throw new Error("Unsupported or duplicate standalone Helper targets");
  const source = await readFile("src/shared/helperProtocol.ts", "utf8");
  const helperVersion = Number(
    source.match(/CLAUDERO_HELPER_VERSION\s*=\s*(\d+)/)?.[1],
  );
  if (!Number.isSafeInteger(helperVersion))
    throw new Error("Cannot read Helper protocol version");
  const directory = path.resolve(dist, "addon/content/helper/standalone");
  await mkdir(directory, { recursive: true });
  const binaries = [];
  for (const target of selected) {
    const [platform, arch] = target.split("-");
    const file = `claudero-helper-${target}${platform === "win32" ? ".exe" : ""}`;
    const output = path.join(directory, file);
    execFileSync(
      bun,
      [
        "build",
        "src/helper/claudero-helper.ts",
        "--compile",
        `--target=${targets[target]}`,
        `--outfile=${output}`,
        "--define=__CLAUDERO_STANDALONE__=true",
        "--env=disable",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        "--no-compile-autoload-tsconfig",
        "--no-compile-autoload-package-json",
      ],
      { stdio: "inherit" },
    );
    const bytes = await readFile(output);
    binaries.push({
      platform,
      arch,
      file,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      { schemaVersion: 1, helperVersion, bunVersion, binaries },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `[standalone] Bundled ${binaries.map(({ platform, arch }) => `${platform}-${arch}`).join(", ")} with Bun ${bunVersion}`,
  );
}

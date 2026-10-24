import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  helperBunVersion as bunVersion,
  helperCompileTargets,
  shouldBundleStandaloneHelper,
  standaloneCompilerPath,
  standaloneHelperTargets,
} from "./helper-build-config.mjs";

export async function buildStandaloneHelper(dist, environment = process.env) {
  if (!shouldBundleStandaloneHelper(environment)) return;
  const selected = standaloneHelperTargets(environment);
  const bun = standaloneCompilerPath(environment);
  let version;
  try {
    version = execFileSync(bun, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    throw new Error(
      `Cannot run the Helper compiler. Run npm ci, or set CLAUDERO_BUN_PATH to Bun ${bunVersion}.`,
    );
  }
  if (version !== bunVersion)
    throw new Error(
      `Standalone Helper requires Bun ${bunVersion}, not ${version}`,
    );
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
        `--target=${helperCompileTargets[target]}`,
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

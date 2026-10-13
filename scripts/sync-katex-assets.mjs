#!/usr/bin/env node
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.dirname(
  createRequire(import.meta.url).resolve("katex/package.json"),
);
const target = path.join(root, "addon/content/katex");
await mkdir(path.join(target, "fonts"), { recursive: true });

// Keep the packaged stylesheet/fonts aligned with the bundled renderer version.
await copyFile(
  path.join(packageRoot, "dist/katex.min.css"),
  path.join(target, "katex.min.css"),
);
await copyFile(
  path.join(packageRoot, "LICENSE"),
  path.join(target, "LICENSE.txt"),
);
for (const font of await readdir(path.join(packageRoot, "dist/fonts"))) {
  await copyFile(
    path.join(packageRoot, "dist/fonts", font),
    path.join(target, "fonts", font),
  );
}

console.log(
  "[katex] Synced stylesheet, fonts, and license from installed KaTeX.",
);

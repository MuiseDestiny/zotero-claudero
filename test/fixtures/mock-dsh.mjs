#!/usr/bin/env node

if (process.argv.slice(2, 4).join(" ") !== "--profile headless") {
  process.stderr.write("invalid dsh arguments");
  process.exit(3);
}

if (process.env.MOCK_DSH_FAIL) {
  process.stderr.write(process.env.MOCK_DSH_FAIL);
  process.exit(7);
}

process.stdout.write(
  JSON.stringify({
    model: process.env.DSH_MODEL || "",
    dshHome: process.env.DSH_HOME || "",
    cwd: process.cwd(),
    prompt: process.argv.at(-1) || "",
  }),
);

const ANSI_ESCAPE_PATTERN = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*)?\\u0007)|(?:(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  "g",
);

const MODELS_CACHE_SCHEMA_ERROR =
  /failed to load models cache:\s*unknown variant [`']max[`']/i;
const NON_FATAL_MODELS_REFRESH_ERROR =
  /codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit/i;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

export function hasModelsCacheSchemaError(value: string): boolean {
  return MODELS_CACHE_SCHEMA_ERROR.test(stripAnsi(value));
}

export function userFacingCodexStderr(value: string): string {
  return stripAnsi(value)
    .split(/\r?\n/)
    .filter((line) => !NON_FATAL_MODELS_REFRESH_ERROR.test(line))
    .join("\n")
    .trim();
}

export function bundledCodexCandidates(
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      `${home}/Applications/ChatGPT.app/Contents/Resources/codex`,
      `${home}/Applications/Codex.app/Contents/Resources/codex`,
    ];
  }
  return [];
}

export function modelsCacheRequiresNewerCodex(cacheText: string): boolean {
  try {
    const parsed = JSON.parse(cacheText) as unknown;
    return JSON.stringify(parsed).includes('"effort":"max"');
  } catch {
    return /"effort"\s*:\s*"max"/.test(cacheText);
  }
}

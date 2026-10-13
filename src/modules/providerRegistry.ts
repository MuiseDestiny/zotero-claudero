import { getPref, setPref } from "../utils/prefs";

export type AiProvider = "claude" | "codex" | "deepseek";
export type CodexInstallationMethod = "native" | "wsl";
export type CodexSafeMode = "workspace-write" | "read-only";

export interface ProviderOption {
  value: AiProvider;
  label: string;
}

export interface ModelOption {
  value: string;
  label: string;
}

export interface ProviderCapabilities {
  provider: AiProvider;
  supportsPersistentRuntime: boolean;
  supportsNativeHistory: boolean;
  supportsPlanMode: boolean;
  /** Local child conversations are available even without native history fork. */
  supportsFork: boolean;
  supportsNativeFork: boolean;
  supportsRollback: boolean;
  supportsCompact: boolean;
  supportsProviderCommands: boolean;
  supportsImageAttachments: boolean;
  supportsMcpTools: boolean;
  supportsInteractivePlanApproval: boolean;
  reasoningControl: "effort" | "none";
}

export interface ProviderRegistration {
  provider: AiProvider;
  label: string;
  blankOrder: number;
  capabilities: ProviderCapabilities;
  modelOptions: ModelOption[];
  defaultModel: string;
  defaultEffort: string;
  executableName: string;
  settingsPanel: "claude" | "codex" | "deepseek";
  environmentKeyHints: string[];
}

export interface HostScopedProviderConfig {
  cliPath?: string;
  cliPathsByHost?: Record<string, string>;
  environmentVariables?: string;
}

export interface CodexProviderConfig extends HostScopedProviderConfig {
  installationMethod?: CodexInstallationMethod;
  installationMethodsByHost?: Record<string, CodexInstallationMethod>;
  wslDistroOverride?: string;
  wslDistroOverridesByHost?: Record<string, string>;
  safeMode?: CodexSafeMode;
}

export interface ProviderConfigs {
  claude?: HostScopedProviderConfig;
  codex?: CodexProviderConfig;
  deepseek?: HostScopedProviderConfig;
}

export interface ProviderRuntimePrefs {
  provider: AiProvider;
  cliPath?: string;
  environmentVariables: string;
  model: string;
  effort: string;
  codexInstallationMethod?: CodexInstallationMethod;
  codexWslDistro?: string;
  codexSafeMode?: CodexSafeMode;
}

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  { value: "haiku", label: "Haiku" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

export const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.5", label: "GPT-5.5" },
];

export const DEEPSEEK_MODEL_OPTIONS: ModelOption[] = [
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

export const PROVIDER_REGISTRY: Record<AiProvider, ProviderRegistration> = {
  claude: {
    provider: "claude",
    label: "Claude",
    blankOrder: 10,
    capabilities: {
      provider: "claude",
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsFork: true,
      supportsNativeFork: false,
      supportsRollback: false,
      supportsCompact: true,
      supportsProviderCommands: true,
      supportsImageAttachments: true,
      supportsMcpTools: true,
      supportsInteractivePlanApproval: true,
      reasoningControl: "effort",
    },
    modelOptions: CLAUDE_MODEL_OPTIONS,
    defaultModel: "haiku",
    defaultEffort: "high",
    executableName: "claude",
    settingsPanel: "claude",
    environmentKeyHints: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  },
  codex: {
    provider: "codex",
    label: "Codex",
    blankOrder: 20,
    capabilities: {
      provider: "codex",
      supportsPersistentRuntime: true,
      supportsNativeHistory: true,
      supportsPlanMode: true,
      supportsFork: true,
      supportsNativeFork: true,
      supportsRollback: true,
      supportsCompact: true,
      supportsProviderCommands: false,
      supportsImageAttachments: true,
      supportsMcpTools: true,
      supportsInteractivePlanApproval: true,
      reasoningControl: "effort",
    },
    modelOptions: CODEX_MODEL_OPTIONS,
    defaultModel: "gpt-5.5",
    defaultEffort: "medium",
    executableName: "codex",
    settingsPanel: "codex",
    environmentKeyHints: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"],
  },
  deepseek: {
    provider: "deepseek",
    label: "DeepSeek Harness",
    blankOrder: 30,
    capabilities: {
      provider: "deepseek",
      supportsPersistentRuntime: true,
      supportsNativeHistory: false,
      supportsPlanMode: false,
      supportsFork: false,
      supportsNativeFork: false,
      supportsRollback: false,
      supportsCompact: false,
      supportsProviderCommands: false,
      supportsImageAttachments: false,
      supportsMcpTools: false,
      supportsInteractivePlanApproval: false,
      reasoningControl: "none",
    },
    modelOptions: DEEPSEEK_MODEL_OPTIONS,
    defaultModel: "deepseek-v4-flash",
    defaultEffort: "none",
    executableName: "dsh",
    settingsPanel: "deepseek",
    environmentKeyHints: [
      "DEEPSEEK_API_KEY",
      "DEEPSEEK_BASE_URL",
      "DSH_MODEL",
      "DSH_HOME",
    ],
  },
};

export const PROVIDER_OPTIONS: ProviderOption[] = Object.values(
  PROVIDER_REGISTRY,
)
  .sort((a, b) => a.blankOrder - b.blankOrder)
  .map((registration) => ({
    value: registration.provider,
    label: registration.label,
  }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hashText(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function normalizeProvider(value: unknown): AiProvider {
  const normalized = String(value);
  return normalized === "codex" || normalized === "deepseek"
    ? normalized
    : "claude";
}

export function providerLabel(provider: AiProvider): string {
  return PROVIDER_REGISTRY[provider].label;
}

export function modelOptionsForProvider(provider: AiProvider): ModelOption[] {
  return PROVIDER_REGISTRY[provider].modelOptions;
}

export function getProviderRegistration(
  provider: AiProvider,
): ProviderRegistration {
  return PROVIDER_REGISTRY[provider];
}

export function getProviderCapabilities(
  provider: AiProvider,
): ProviderCapabilities {
  return PROVIDER_REGISTRY[provider].capabilities;
}

export function getHostKey(): string {
  const profile = Zotero as typeof Zotero & {
    Profile?: { dir?: string | nsIFile };
  };
  const dir = profile.Profile?.dir;
  const profilePath =
    typeof dir === "string"
      ? dir
      : dir && typeof dir === "object" && "path" in dir
        ? (dir as nsIFile).path
        : Zotero.Profile.dir;
  const osName =
    (Zotero as typeof Zotero & { platform?: string }).platform ||
    (Zotero.isWin ? "win" : Zotero.isMac ? "mac" : "linux");
  return `${osName}-${hashText(profilePath)}`;
}

export function parseProviderConfigs(
  raw = String(getPref("providerConfigs") || ""),
): ProviderConfigs {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as ProviderConfigs) : {};
  } catch {
    return {};
  }
}

export function saveProviderConfigs(configs: ProviderConfigs): void {
  setPref("providerConfigs", JSON.stringify(configs));
}

function hostScopedPath(
  config: HostScopedProviderConfig | undefined,
  legacyPath: unknown,
  hostKey = getHostKey(),
): string {
  // Once device-scoped paths exist, an empty or unknown device must use
  // auto-detection instead of another device's legacy fallback path.
  if (config?.cliPathsByHost && Object.keys(config.cliPathsByHost).length) {
    return String(config.cliPathsByHost[hostKey] || "").trim();
  }
  const direct = config?.cliPath?.trim();
  if (direct) return direct;
  return String(legacyPath || "").trim();
}

export function getProviderCliPath(
  provider: AiProvider,
  hostKey = getHostKey(),
): string {
  const configs = parseProviderConfigs();
  if (provider === "codex") {
    return hostScopedPath(configs.codex, getPref("codexPath"), hostKey);
  }
  if (provider === "deepseek") {
    return hostScopedPath(configs.deepseek, getPref("deepseekPath"), hostKey);
  }
  return hostScopedPath(configs.claude, getPref("claudePath"), hostKey);
}

export function setProviderCliPath(
  provider: AiProvider,
  value: string,
  hostKey = getHostKey(),
): void {
  const configs = parseProviderConfigs();
  const next = { ...configs };
  const key = provider === "codex" ? "codex" : provider;
  const current = { ...(next[key] || {}) } as HostScopedProviderConfig;
  const cliPathsByHost = { ...(current.cliPathsByHost || {}) };
  const trimmed = value.trim();
  cliPathsByHost[hostKey] = trimmed;
  current.cliPathsByHost = cliPathsByHost;
  current.cliPath = trimmed;
  next[key] = current as never;
  saveProviderConfigs(next);
  setPref(
    provider === "codex"
      ? "codexPath"
      : provider === "deepseek"
        ? "deepseekPath"
        : "claudePath",
    trimmed,
  );
}

export function getProviderEnvironment(provider: AiProvider): string {
  const configs = parseProviderConfigs();
  const scoped =
    provider === "codex"
      ? configs.codex?.environmentVariables
      : provider === "deepseek"
        ? configs.deepseek?.environmentVariables
        : configs.claude?.environmentVariables;
  return scoped ?? "";
}

export function setProviderEnvironment(
  provider: AiProvider,
  value: string,
): void {
  const configs = parseProviderConfigs();
  if (provider === "codex") {
    configs.codex = { ...(configs.codex || {}), environmentVariables: value };
  } else if (provider === "deepseek") {
    configs.deepseek = {
      ...(configs.deepseek || {}),
      environmentVariables: value,
    };
  } else {
    configs.claude = { ...(configs.claude || {}), environmentVariables: value };
  }
  saveProviderConfigs(configs);
}

export function getCodexInstallationMethod(
  hostKey = getHostKey(),
): CodexInstallationMethod {
  const codex = parseProviderConfigs().codex || {};
  const value =
    codex.installationMethodsByHost &&
    Object.keys(codex.installationMethodsByHost).length
      ? codex.installationMethodsByHost[hostKey]
      : codex.installationMethod;
  return value === "wsl" ? "wsl" : "native";
}

export function setCodexInstallationMethod(
  value: string,
  hostKey = getHostKey(),
): void {
  const method: CodexInstallationMethod = value === "wsl" ? "wsl" : "native";
  const configs = parseProviderConfigs();
  const codex = { ...(configs.codex || {}) };
  codex.installationMethod = method;
  codex.installationMethodsByHost = {
    ...(codex.installationMethodsByHost || {}),
    [hostKey]: method,
  };
  configs.codex = codex;
  saveProviderConfigs(configs);
}

export function getCodexWslDistro(hostKey = getHostKey()): string {
  const codex = parseProviderConfigs().codex || {};
  if (
    codex.wslDistroOverridesByHost &&
    Object.keys(codex.wslDistroOverridesByHost).length
  ) {
    return codex.wslDistroOverridesByHost[hostKey] || "";
  }
  return (
    codex.wslDistroOverridesByHost?.[hostKey] || codex.wslDistroOverride || ""
  );
}

export function setCodexWslDistro(value: string, hostKey = getHostKey()): void {
  const configs = parseProviderConfigs();
  const codex = { ...(configs.codex || {}) };
  const overrides = { ...(codex.wslDistroOverridesByHost || {}) };
  const trimmed = value.trim();
  overrides[hostKey] = trimmed;
  codex.wslDistroOverride = trimmed;
  codex.wslDistroOverridesByHost = overrides;
  configs.codex = codex;
  saveProviderConfigs(configs);
}

export function getCodexSafeMode(): CodexSafeMode {
  const value = parseProviderConfigs().codex?.safeMode;
  return value === "read-only" ? "read-only" : "workspace-write";
}

export function setCodexSafeMode(value: string): void {
  const configs = parseProviderConfigs();
  configs.codex = {
    ...(configs.codex || {}),
    safeMode: value === "read-only" ? "read-only" : "workspace-write",
  };
  saveProviderConfigs(configs);
}

export function defaultModelForProvider(provider: AiProvider): string {
  const fallback = PROVIDER_REGISTRY[provider].defaultModel;
  const value = String(
    getPref(
      provider === "codex"
        ? "codexModel"
        : provider === "deepseek"
          ? "deepseekModel"
          : "claudeModel",
    ) ||
      getPref("model") ||
      fallback,
  );
  if (provider !== "claude") return value.trim() || fallback;
  return modelOptionsForProvider(provider).some(
    (option) => option.value === value,
  )
    ? value
    : fallback;
}

export function defaultEffortForProvider(provider: AiProvider): string {
  return String(
    getPref(
      provider === "codex"
        ? "codexEffort"
        : provider === "deepseek"
          ? "deepseekEffort"
          : "claudeEffort",
    ) ||
      getPref("effort") ||
      PROVIDER_REGISTRY[provider].defaultEffort,
  );
}

export function getProviderSettingsFingerprint(provider: AiProvider): string {
  const runtime = getProviderRuntimePrefs(provider);
  return JSON.stringify({
    provider,
    cliPath: runtime.cliPath || "",
    environmentVariables: runtime.environmentVariables || "",
    model: runtime.model || "",
    effort: runtime.effort || "",
    codexInstallationMethod: runtime.codexInstallationMethod || "",
    codexWslDistro: runtime.codexWslDistro || "",
    codexSafeMode: runtime.codexSafeMode || "",
  });
}

export function getProviderRuntimePrefs(
  provider: AiProvider,
): ProviderRuntimePrefs {
  return {
    provider,
    cliPath: getProviderCliPath(provider),
    environmentVariables: getProviderEnvironment(provider),
    model: defaultModelForProvider(provider),
    effort: defaultEffortForProvider(provider),
    codexInstallationMethod:
      provider === "codex" ? getCodexInstallationMethod() : undefined,
    codexWslDistro: provider === "codex" ? getCodexWslDistro() : undefined,
    codexSafeMode: provider === "codex" ? getCodexSafeMode() : undefined,
  };
}

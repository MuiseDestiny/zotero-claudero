import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { fetchProviderModels } from "./claudeHelperClient";
import { type PaneState, type PermissionMode } from "./paneState";
import { ProviderModelRequest } from "./providerModelRequest";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getProviderCapabilities,
  normalizeProvider,
  providerLabel,
  type AiProvider,
} from "./providerRegistry";

// Model, effort and permission controls independent of pane orchestration.
export function normalizePermissionMode(value: unknown): PermissionMode {
  return [
    "auto",
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
  ].includes(String(value))
    ? (String(value) as PermissionMode)
    : "auto";
}

function permissionModeDescription(mode: PermissionMode): string {
  const provider = normalizeProvider(getPref("provider"));
  const capabilities = getProviderCapabilities(provider);
  const agent = providerLabel(provider);
  switch (mode) {
    case "auto":
      return getString("permission-mode-auto-description", { args: { agent } });
    case "default":
      return getString("permission-mode-default-description", {
        args: { agent },
      });
    case "acceptEdits":
      return getString("permission-mode-edits-description");
    case "plan":
      return capabilities.supportsInteractivePlanApproval
        ? getString("permission-mode-plan-description", { args: { agent } })
        : getString("permission-mode-plan-updates-description", {
            args: { agent },
          });
    case "dontAsk":
      return getString("permission-mode-dont-ask-description");
    case "bypassPermissions":
      return getString("permission-mode-bypass-description", {
        args: { agent },
      });
  }
}

export function permissionOptionsForProvider(provider: AiProvider) {
  const capabilities = getProviderCapabilities(provider);
  const planLabel = capabilities.supportsInteractivePlanApproval
    ? getString("permission-mode-plan-approval")
    : getString("permission-mode-plan-first");
  return [
    {
      value: "auto",
      label: getString("permission-mode-auto"),
      description: permissionModeDescription("auto"),
    },
    {
      value: "default",
      label: getString("permission-mode-default"),
      description: permissionModeDescription("default"),
    },
    {
      value: "acceptEdits",
      label: getString("permission-mode-edits"),
      description: permissionModeDescription("acceptEdits"),
    },
    ...(capabilities.supportsPlanMode
      ? [
          {
            value: "plan",
            label: planLabel,
            description: permissionModeDescription("plan"),
          },
        ]
      : []),
    {
      value: "dontAsk",
      label: getString("permission-mode-dont-ask"),
      description: permissionModeDescription("dontAsk"),
    },
    {
      value: "bypassPermissions",
      label: getString("permission-mode-bypass"),
      description: permissionModeDescription("bypassPermissions"),
      danger: true,
    },
  ];
}

const CLAUDE_EFFORT_OPTIONS = [
  { value: "low" },
  { value: "medium" },
  { value: "high" },
  { value: "xhigh" },
  { value: "max" },
];

const DEEPSEEK_EFFORT_OPTIONS = [{ value: "none" }];

function localizedEffortOptions(
  values: Array<{ value: string }>,
): Array<{ value: string; label: string }> {
  return values.map((option) => ({
    value: option.value,
    label:
      option.value === "none"
        ? getString("effort-default")
        : effortLabel(option.value),
  }));
}

export function effortOptionsForProvider(provider: AiProvider) {
  return localizedEffortOptions(
    provider === "deepseek" ? DEEPSEEK_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS,
  );
}

function effortLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "xhigh") return getString("effort-xhigh");
  return normalized
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function applyModelEfforts(state: PaneState, modelValue: string): void {
  const provider = normalizeProvider(state.providerSelect.value);
  if (provider === "deepseek") {
    state.effortSelect.setItems?.(
      localizedEffortOptions(DEEPSEEK_EFFORT_OPTIONS),
      "none",
    );
    setPref("deepseekEffort", "none");
    setPref("effort", "none");
    return;
  }
  if (provider !== "codex") return;
  const model = state.codexModels.find((entry) => entry.value === modelValue);
  const supported = model?.supportedEfforts?.filter(Boolean) || [];
  const options =
    supported.length > 0
      ? supported.map((value) => ({ value, label: effortLabel(value) }))
      : localizedEffortOptions(CLAUDE_EFFORT_OPTIONS);
  const saved = String(getPref("codexEffort") || state.effortSelect.value);
  const preferred = options.some((option) => option.value === saved)
    ? saved
    : model?.defaultEffort || options[0]?.value || "medium";
  state.effortSelect.setItems?.(options, preferred);
  setPref("codexEffort", state.effortSelect.value);
  setPref("effort", state.effortSelect.value);
}

export async function refreshProviderModels(
  state: PaneState,
  provider: AiProvider,
): Promise<void> {
  if (state.disposed) return;
  state.modelCatalog ||= new ProviderModelRequest(
    fetchProviderModels,
    (provider) =>
      !state.disposed &&
      normalizeProvider(state.providerSelect.value) === provider,
    (provider, models) => {
      state.codexModels = models;
      const modelPref =
        provider === "deepseek" ? "deepseekModel" : "codexModel";
      const saved = String(getPref(modelPref) || state.modelSelect.value);
      const preferred = models.some((model) => model.value === saved)
        ? saved
        : models.find((model) => model.isDefault)?.value || models[0].value;
      state.modelSelect.setItems?.(
        models.map((model) => ({
          value: model.value,
          label: model.label,
          description: model.description,
        })),
        preferred,
      );
      setPref(modelPref, state.modelSelect.value);
      setPref("model", state.modelSelect.value);
      applyModelEfforts(state, state.modelSelect.value);
    },
  );
  try {
    await state.modelCatalog.load(provider);
  } catch (error) {
    ztoolkit.log("[Claudero] Failed to refresh Codex models:", error);
  }
}

export function getSelectedModel(state: PaneState): string {
  const provider = normalizeProvider(state.providerSelect.value);
  return state.modelSelect.value || defaultModelForProvider(provider);
}

export function getSelectedEffort(state: PaneState): string {
  const provider = normalizeProvider(state.providerSelect.value);
  return state.effortSelect.value || defaultEffortForProvider(provider);
}

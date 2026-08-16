export interface ProviderModelDescriptor {
  value: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  defaultEffort?: string;
  supportedEfforts?: string[];
}

export interface ProviderModelPage {
  models: ProviderModelDescriptor[];
  nextCursor?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function codexModelDisplayLabel(value: string): string {
  const label = value.trim();
  return /^GPT-/i.test(label)
    ? label.replace(/^GPT-/i, "").replace(/-/g, " ")
    : label;
}

export function parseCodexModelListPage(value: unknown): ProviderModelPage {
  const response = record(value);
  const seen = new Set<string>();
  const models: ProviderModelDescriptor[] = [];
  for (const raw of Array.isArray(response?.data) ? response.data : []) {
    const model = record(raw);
    if (!model || model.hidden === true) continue;
    const id = text(model.model) || text(model.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = text(model.displayName) || id;
    const supportedEfforts = (
      Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : []
    )
      .map((entry) => text(record(entry)?.reasoningEffort))
      .filter(Boolean);
    models.push({
      value: id,
      label: codexModelDisplayLabel(displayName),
      ...(text(model.description)
        ? { description: text(model.description) }
        : {}),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      ...(text(model.defaultReasoningEffort)
        ? { defaultEffort: text(model.defaultReasoningEffort) }
        : {}),
      ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
    });
  }
  const nextCursor = text(response?.nextCursor);
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

import { type PaneState } from "./paneState";
import { type AiProvider } from "./providerRegistry";
import type { ClauderoSelectionContext } from "./zoteroContext";

// Shared request helpers; no transport, DOM operations or owned timers.

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : normalized;
}

export function getAttachmentDirectories(
  context: ClauderoSelectionContext,
): string[] {
  const directories = new Set<string>();
  for (const item of context.items) {
    for (const attachment of item.attachments) {
      if (attachment.path) directories.add(dirname(attachment.path));
    }
  }
  if (context.reader?.path) directories.add(dirname(context.reader.path));
  return [...directories];
}

const COMPLETION_FLAVOR_WORDS = [
  "Baked",
  "Brewed",
  "Crafted",
  "Forged",
  "Conjured",
  "Simmered",
  "Distilled",
  "Percolated",
  "Roasted",
  "Cogitated",
  "Steeped",
] as const;

export function pickFlavorWord(): string {
  return COMPLETION_FLAVOR_WORDS[
    Math.floor(Math.random() * COMPLETION_FLAVOR_WORDS.length)
  ];
}

export function dropProviderSession(
  state: PaneState,
  provider: AiProvider,
): void {
  if (!state.providerState) return;
  const next = { ...state.providerState };
  if (provider === "codex") delete next.codex;
  else if (provider === "deepseek") delete next.deepseek;
  else delete next.claude;
  state.providerState = next;
}

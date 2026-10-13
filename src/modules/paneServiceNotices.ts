import type { PaneState, NoticeKind } from "./paneState";
import { createEl, scrollTranscript, setStatusDot } from "./paneDom";
import { getString } from "../utils/locale";
import {
  getCodexInstallationMethod,
  normalizeProvider,
  providerLabel,
} from "./providerRegistry";
import {
  installDeepSeekHarness,
  runProviderAuthLogin,
} from "./claudeHelperClient";
import {
  classifyRequestFailure,
  createRecoveryAction,
} from "../shared/requestFailure";
import { captureConversationGuard } from "./conversationTransition";
import { openClauderoSettings } from "./settingsNavigation";
import type { AiProvider } from "./providerRegistry";
export function appendNoticeCard(
  state: PaneState,
  kind: NoticeKind,
  title: string,
  text: string,
  action?: { label: string; onClick: (button: HTMLButtonElement) => void },
): void {
  const doc = state.root.ownerDocument!;
  const card = createEl(doc, "div", `claudero-notice-card ${kind}`);
  const iconPaths: Record<NoticeKind, string> = {
    info: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    warning:
      "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
    auth: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
    success: "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3",
  };
  const iconEl = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  iconEl.setAttribute("viewBox", "0 0 24 24");
  iconEl.setAttribute("width", "16");
  iconEl.setAttribute("height", "16");
  iconEl.setAttribute("fill", "none");
  iconEl.setAttribute("stroke", "currentColor");
  iconEl.setAttribute("stroke-width", "2");
  iconEl.setAttribute("stroke-linecap", "round");
  iconEl.setAttribute("stroke-linejoin", "round");
  iconEl.setAttribute("class", "claudero-notice-icon");
  for (const d of iconPaths[kind].split("M").filter(Boolean)) {
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M" + d);
    iconEl.appendChild(path);
  }
  const content = createEl(doc, "div", "claudero-notice-content");
  const heading = createEl(doc, "strong", "claudero-notice-title");
  const body = createEl(doc, "div", "claudero-notice-body");
  heading.textContent = title;
  body.textContent = text;
  content.append(heading, body);
  card.append(iconEl as unknown as HTMLElement, content);
  if (action) {
    const button = createEl(doc, "button", "claudero-button primary-soft");
    button.type = "button";
    button.textContent = action.label;
    const current = captureConversationGuard(state);
    button.addEventListener("click", () => {
      if (current() && !state.running && !state.conversationTransition)
        action.onClick(button);
    });
    content.appendChild(button);
  }
  state.transcript.appendChild(card);
  scrollTranscript(state);
}

export function appendDeepSeekCliInstallPrompt(
  state: PaneState,
  message: string,
): void {
  setStatusDot(state, "error");
  appendNoticeCard(
    state,
    "warning",
    getString("composer-deepseek-cli-missing"),
    `${message}\n\n${getString("pane-deepseek-install-description")}`,
    {
      label: getString("composer-install-deepseek"),
      onClick: (button) => {
        const current = captureConversationGuard(state);
        button.disabled = true;
        button.textContent = getString("composer-installing-deepseek");
        installDeepSeekHarness()
          .then((result) => {
            if (!current()) return;
            appendNoticeCard(
              state,
              "success",
              getString("composer-deepseek-installed"),
              getString("pane-deepseek-installed-description", {
                args: {
                  path: result.cliPath,
                  version: result.version ? ` (version ${result.version})` : "",
                },
              }),
            );
            setStatusDot(state, "ready");
          })
          .catch((error: unknown) => {
            if (!current()) return;
            appendNoticeCard(
              state,
              "warning",
              getString("composer-deepseek-install-failed"),
              error instanceof Error ? error.message : String(error),
            );
          })
          .finally(() => {
            if (!current()) return;
            button.disabled = false;
            button.textContent = getString("composer-install-deepseek");
          });
      },
    },
  );
}

export function appendAuthPrompt(
  state: PaneState,
  message: string,
  provider: AiProvider = normalizeProvider(state.providerSelect.value),
): void {
  setStatusDot(state, "error");
  const usesWsl =
    provider === "codex" && getCodexInstallationMethod() === "wsl";
  const label = providerLabel(provider);
  appendNoticeCard(
    state,
    "auth",
    getString("pane-auth-required", { args: { agent: label } }),
    `${message}\n\n${getString("pane-auth-description", {
      args: {
        agent: label,
        instructions: getString(
          provider === "deepseek"
            ? "pane-auth-deepseek-instructions"
            : usesWsl
              ? "pane-auth-wsl-instructions"
              : "pane-auth-provider-instructions",
        ),
      },
    })}`,
    provider === "deepseek" || usesWsl
      ? {
          label: getString("pane-open-provider-settings"),
          onClick: () => openClauderoSettings(provider),
        }
      : {
          label: getString("pane-login", { args: { agent: label } }),
          onClick: (button) => {
            const current = captureConversationGuard(state);
            button.disabled = true;
            runProviderAuthLogin(provider)
              .then(() => {
                if (!current()) return;
                appendNoticeCard(
                  state,
                  "info",
                  getString("pane-login-opened", { args: { agent: label } }),
                  getString("pane-login-description"),
                );
              })
              .catch((error: unknown) => {
                if (!current()) return;
                appendNoticeCard(
                  state,
                  "warning",
                  getString("pane-login-failed", { args: { agent: label } }),
                  error instanceof Error ? error.message : String(error),
                );
              })
              .finally(() => {
                if (current()) button.disabled = false;
              });
          },
        },
  );
}

export function appendRequestFailure(
  state: PaneState,
  message: string,
  provider: AiProvider,
  retry: () => Promise<boolean | void>,
): void {
  const kind = classifyRequestFailure(message);
  if (kind === "auth") {
    appendAuthPrompt(state, message, provider);
    return;
  }
  if (kind === "limit") {
    appendLimitPrompt(
      state,
      `${message}\n\n${getString("pane-recovery-limit-description")}`,
      provider,
    );
    return;
  }
  if (kind === "cli" && provider === "deepseek") {
    appendDeepSeekCliInstallPrompt(state, message);
    return;
  }
  setStatusDot(state, "error");
  const current = captureConversationGuard(state);
  const recover = createRecoveryAction(
    () => current() && !state.running && !state.conversationTransition,
    retry,
  );
  const configure = kind === "node" || kind === "cli";
  appendNoticeCard(
    state,
    "warning",
    getString(`pane-recovery-${kind}-title`),
    `${getString(`pane-recovery-${kind}-description`)}\n\n${message}`,
    {
      label: getString(configure ? "pane-open-setup" : "pane-recovery-retry"),
      onClick: (button) => {
        if (configure) {
          openClauderoSettings();
          return;
        }
        button.disabled = true;
        let consumed = false;
        void recover()
          .then((started) => {
            consumed = started;
          })
          .catch((error: unknown) => {
            if (current())
              appendNoticeCard(
                state,
                "warning",
                getString("pane-request-failed"),
                String(error),
              );
          })
          .finally(() => {
            if (current()) button.disabled = consumed;
          });
      },
    },
  );
}

export function requestFailureDescription(message: string): string {
  const kind = classifyRequestFailure(message);
  return `${getString(`pane-recovery-${kind}-description`)}\n\n${message}`;
}

export function appendLimitPrompt(
  state: PaneState,
  message: string,
  provider: AiProvider = normalizeProvider(state.providerSelect.value),
): void {
  setStatusDot(state, "error");
  appendNoticeCard(
    state,
    "warning",
    getString("pane-session-limit", {
      args: {
        agent: providerLabel(provider),
      },
    }),
    message,
  );
}

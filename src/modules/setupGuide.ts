import type { AiProvider } from "./providerRegistry";

export type SetupAction =
  | "install-node"
  | "install-provider"
  | "install-deepseek"
  | "node-path"
  | "cli-path"
  | "login"
  | "wsl-login"
  | "provider-settings";

/** Installation and login always require a click; opening settings only scans. */
export function setupActions(
  provider: AiProvider,
  nodeReady: boolean,
  cliReady: boolean,
  usesWsl = false,
): { node: SetupAction[]; cli: SetupAction[]; auth: SetupAction[] } {
  return {
    node: nodeReady ? [] : ["install-node", "node-path"],
    cli: cliReady
      ? []
      : [
          provider === "deepseek" && nodeReady
            ? "install-deepseek"
            : "install-provider",
          "cli-path",
        ],
    auth:
      nodeReady && cliReady
        ? [
            provider === "deepseek"
              ? "provider-settings"
              : provider === "codex" && usesWsl
                ? "wsl-login"
                : "login",
          ]
        : [],
  };
}

import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import process from "node:process";
import type { PermissionManager } from "./PermissionManager";
import { createZoteroMcpServer } from "./ZoteroMcpServer";

export type ClauderoPermissionMode =
  | "auto"
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

export interface QueryOptionsConfig {
  workspacePath: string;
  claudePath: string;
  environment: Record<string, string>;
  model?: string;
  effort?: string;
  additionalDirectories?: string[];
  permissionMode?: ClauderoPermissionMode;
  zoteroEndpointUrl?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  permissionManager?: PermissionManager;
}

export function normalizeModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value || undefined;
}

export function normalizeEffort(
  effort: string | undefined,
): EffortLevel | undefined {
  const value = effort?.trim();
  return ["low", "medium", "high", "xhigh", "max"].includes(value || "")
    ? (value as EffortLevel)
    : undefined;
}

export function normalizePermissionMode(
  mode: string | undefined,
): ClauderoPermissionMode {
  return [
    "auto",
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
  ].includes(mode || "")
    ? (mode as ClauderoPermissionMode)
    : "auto";
}

export function sameEnvironment(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const left = a || {};
  const right = b || {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export function buildQueryOptions(config: QueryOptionsConfig): Options {
  const env = {
    ...process.env,
    ...config.environment,
  };

  const pm = normalizePermissionMode(config.permissionMode);
  const options: Options = {
    cwd: config.workspacePath,
    // Drive the same live text/thinking/tool-input experience as Claude Code.
    // Complete assistant messages still arrive and reconcile partial output.
    includePartialMessages: true,
    env,
    pathToClaudeCodeExecutable: config.claudePath,
    permissionMode:
      pm as import("@anthropic-ai/claude-agent-sdk").PermissionMode,
    allowDangerouslySkipPermissions: true,
  };

  const model = normalizeModel(config.model);
  const effort = normalizeEffort(config.effort);
  if (model) options.model = model;
  if (effort) options.effort = effort;
  if (config.additionalDirectories && config.additionalDirectories.length > 0) {
    options.additionalDirectories = config.additionalDirectories;
  }

  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    options.mcpServers = {
      ...(options.mcpServers || {}),
      ...(config.mcpServers as NonNullable<Options["mcpServers"]>),
    };
  }
  if (config.mcpDisabledTools && config.mcpDisabledTools.length > 0) {
    (options as Options & { disallowedTools?: string[] }).disallowedTools = [
      ...(((options as Options & { disallowedTools?: string[] })
        .disallowedTools as string[] | undefined) || []),
      ...config.mcpDisabledTools,
    ];
  }

  if (
    config.enableZoteroMcp !== false &&
    config.zoteroEndpointUrl &&
    config.permissionManager
  ) {
    options.mcpServers = {
      ...(options.mcpServers || {}),
      zotero: createZoteroMcpServer(
        config.zoteroEndpointUrl,
        config.permissionManager,
      ),
    };
  }

  return options;
}

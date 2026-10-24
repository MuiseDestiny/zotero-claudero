import type { EffortLevel, Options } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import process from "node:process";
import type { PermissionManager } from "./PermissionManager";
import { createZoteroMcpServer } from "./ZoteroMcpServer";
import { isStandaloneHelper } from "./helperRuntime";

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
  zoteroEndpointToken?: string;
  enableZoteroMcp?: boolean;
  mcpServers?: Record<string, unknown>;
  mcpDisabledTools?: string[];
  permissionManager?: PermissionManager;
  resume?: string;
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
  if (
    isStandaloneHelper() &&
    /\.(?:js|mjs|tsx|ts|jsx)$/.test(config.claudePath)
  ) {
    try {
      execFileSync(
        "node",
        [
          "-e",
          "if(Number(process.versions.node.split('.')[0])<20)process.exit(2)",
        ],
        { env, stdio: "ignore", timeout: 5000 },
      );
    } catch {
      throw new Error(
        "The npm/script version of Claude Code still requires Node.js 20+ in the provider PATH. Install Node.js or select a native Claude Code executable.",
      );
    }
  }

  const pm = normalizePermissionMode(config.permissionMode);
  const options: Options = {
    cwd: config.workspacePath,
    // Drive the same live text/thinking/tool-input experience as Claude Code.
    // Complete assistant messages still arrive and reconcile partial output.
    includePartialMessages: true,
    env,
    pathToClaudeCodeExecutable: config.claudePath,
    // Native CLIs run directly. npm scripts still need Node, not an external Bun.
    ...(isStandaloneHelper() ? { executable: "node" as const } : {}),
    permissionMode:
      pm as import("@anthropic-ai/claude-agent-sdk").PermissionMode,
    allowDangerouslySkipPermissions: true,
  };
  if (config.resume) options.resume = config.resume;

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
    if (!config.zoteroEndpointToken) {
      throw new Error("Missing Zotero endpoint capability token");
    }
    options.mcpServers = {
      ...(options.mcpServers || {}),
      zotero: createZoteroMcpServer(
        config.zoteroEndpointUrl,
        config.zoteroEndpointToken,
        config.permissionManager,
      ),
    };
  }

  return options;
}

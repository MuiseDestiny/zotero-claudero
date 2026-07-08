export interface PermissionRequest {
  id: string;
  toolName: string;
  input: unknown;
}

export interface PermissionDecision {
  allowed: boolean;
  remember?: boolean;
}

interface PendingPermissionRequest {
  resolve: (decision: PermissionDecision) => void;
  request: PermissionRequest;
}

export type ToolDecision =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      updatedPermissions?: unknown[];
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export interface ToolOptions {
  signal: AbortSignal;
  toolUseID?: string;
}

const READ_ONLY_ZOTERO_ACTIONS = new Set([
  "get_current_context",
  "get_item",
  "search_items",
  "get_annotations",
  "get_attachment_path",
  "get_evidence_pack",
  "build_academic_trace",
  "build_trust_report",
  "inspect_figure_table_page",
  "locate_quote",
  "verify_citations",
  "list_history",
]);

function isReadOnlyZoteroCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (toolName !== "Bash") return false;
  const command = toolInput.command;
  if (
    typeof command !== "string" ||
    !/127\.0\.0\.1:\d+\/claudero/.test(command)
  ) {
    return false;
  }
  const action = command.match(/"action"\s*:\s*"(\w+)"/)?.[1];
  return !!action && READ_ONLY_ZOTERO_ACTIONS.has(action);
}

export class PermissionManager {
  private currentRequest: PermissionRequest | null = null;
  private pendingRequests = new Map<string, PendingPermissionRequest>();
  private rememberedAllows = new Set<string>();

  private rememberKey(toolName: string): string {
    return toolName.replace(/\s+/g, " ").trim().toLowerCase();
  }

  isRemembered(toolName: string): boolean {
    return this.rememberedAllows.has(this.rememberKey(toolName));
  }

  remember(toolName: string): void {
    this.rememberedAllows.add(this.rememberKey(toolName));
  }

  getCurrentRequest(): PermissionRequest | null {
    return this.currentRequest;
  }

  request(request: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      this.pendingRequests.set(request.id, { resolve, request });
      this.currentRequest = request;
    });
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    pending.resolve(decision);
    this.pendingRequests.delete(requestId);
    if (this.currentRequest?.id === requestId) {
      this.currentRequest = null;
    }
    return true;
  }

  cancel(requestId: string): void {
    this.resolve(requestId, { allowed: false });
  }

  cancelAll(): void {
    for (const [id] of this.pendingRequests) {
      this.cancel(id);
    }
    this.currentRequest = null;
  }

  createCanUseToolHandler(): (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOptions: ToolOptions,
  ) => Promise<ToolDecision> {
    return async (toolName, toolInput, toolOptions) => {
      if (isReadOnlyZoteroCall(toolName, toolInput)) {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          toolUseID: toolOptions.toolUseID,
        };
      }
      if (this.isRemembered(toolName)) {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          toolUseID: toolOptions.toolUseID,
        };
      }

      const requestId = Math.random().toString(36).slice(2, 11);
      const permissionPromise = this.request({
        id: requestId,
        toolName,
        input: toolInput,
      });
      const abortHandler = () => {
        this.cancel(requestId);
      };
      toolOptions.signal.addEventListener("abort", abortHandler, {
        once: true,
      });

      try {
        const decision = await permissionPromise;
        if (decision.allowed) {
          if (decision.remember) this.remember(toolName);
          return {
            behavior: "allow",
            updatedInput: toolInput,
            toolUseID: toolOptions.toolUseID,
          };
        }
        return { behavior: "deny", message: "Operation denied by user" };
      } finally {
        toolOptions.signal.removeEventListener("abort", abortHandler);
      }
    };
  }
}

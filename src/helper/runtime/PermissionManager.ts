import {
  toolPolicyDenialReason,
  type AcademicToolPolicy,
} from "../../shared/academicToolPolicy";

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
  timer: ReturnType<typeof setTimeout>;
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

const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

export class PermissionManager {
  private pendingRequests = new Map<string, PendingPermissionRequest>();
  private requestQueue: string[] = [];
  private rememberedAllows = new Set<string>();
  private toolPolicy: AcademicToolPolicy | undefined;

  setToolPolicy(policy: AcademicToolPolicy | undefined): void {
    this.toolPolicy = policy;
  }

  getToolPolicyDenial(toolName: string): string | null {
    return toolPolicyDenialReason(toolName, this.toolPolicy);
  }

  private rememberKey(toolName: string, input: unknown): string {
    const normalizedTool = toolName.replace(/\s+/g, " ").trim().toLowerCase();
    return `${normalizedTool}:${stableValue(input)}`;
  }

  isRemembered(toolName: string, input: unknown): boolean {
    return this.rememberedAllows.has(this.rememberKey(toolName, input));
  }

  remember(toolName: string, input: unknown): void {
    this.rememberedAllows.add(this.rememberKey(toolName, input));
  }

  getCurrentRequest(): PermissionRequest | null {
    while (this.requestQueue.length > 0) {
      const pending = this.pendingRequests.get(this.requestQueue[0]);
      if (pending) return pending.request;
      this.requestQueue.shift();
    }
    return null;
  }

  request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.getToolPolicyDenial(request.toolName)) {
      return Promise.resolve({ allowed: false });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.resolve(request.id, { allowed: false }),
        PERMISSION_TIMEOUT_MS,
      );
      this.pendingRequests.set(request.id, { resolve, request, timer });
      this.requestQueue.push(request.id);
    });
  }

  resolve(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.resolve(decision);
    this.pendingRequests.delete(requestId);
    this.requestQueue = this.requestQueue.filter((id) => id !== requestId);
    return true;
  }

  cancel(requestId: string): void {
    this.resolve(requestId, { allowed: false });
  }

  cancelAll(): void {
    for (const [id] of this.pendingRequests) {
      this.cancel(id);
    }
    this.requestQueue = [];
  }

  createCanUseToolHandler(): (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOptions: ToolOptions,
  ) => Promise<ToolDecision> {
    return async (toolName, toolInput, toolOptions) => {
      const policyDenial = this.getToolPolicyDenial(toolName);
      if (policyDenial) {
        return {
          behavior: "deny",
          message: policyDenial,
          interrupt: false,
          toolUseID: toolOptions.toolUseID,
        };
      }
      if (this.isRemembered(toolName, toolInput)) {
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
          if (decision.remember) this.remember(toolName, toolInput);
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

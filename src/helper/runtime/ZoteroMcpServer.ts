import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PermissionManager } from "./PermissionManager";

const WRITE_ACTIONS = new Set(["write_tags", "create_note", "set_field", "undo_last"]);

function permissionSummary(action: string): string {
  switch (action) {
    case "write_tags":
      return "Modify Zotero item tags";
    case "create_note":
      return "Create a Zotero note";
    case "set_field":
      return "Modify Zotero item metadata";
    case "undo_last":
      return "Undo a previous Zotero write operation";
    default:
      return "Modify Zotero data";
  }
}

export function createZoteroMcpServer(
  zoteroEndpointUrl: string,
  permissionManager: PermissionManager,
) {
  const call = async (action: string, args: Record<string, unknown>) => {
    if (WRITE_ACTIONS.has(action)) {
      const toolName = "Zotero MCP: " + permissionSummary(action);
      if (permissionManager.isRemembered(toolName)) {
        // Previously approved for this helper session.
      } else {
      const requestId = Math.random().toString(36).slice(2, 11);
      const decision = await permissionManager.request({
        id: requestId,
        toolName,
        input: { action, ...args },
      });
      if (!decision.allowed) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "Operation denied by user" }) }],
        };
      }
      if (decision.remember) permissionManager.remember(toolName);
      }
    }

    const response = await fetch(zoteroEndpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...args }),
    });
    const text = await response.text();
    return { content: [{ type: "text" as const, text }] };
  };

  return createSdkMcpServer({
    name: "zotero",
    version: "0.1.0",
    alwaysLoad: true,
    instructions: [
      "A lightweight current Zotero context is already included in each user request. Use get_current_context only when you need a refresh or when the included context is insufficient.",
      "Use Zotero MCP tools for semantic library state, annotations, attachment paths, and safe writes.",
      "For full PDF text, tables, formulas, or layout, get the attachment path and read the local PDF directly with Python instead of asking Zotero MCP for full text.",
      "Read tools can be called directly.",
      "Write tools require user approval before the tool handler performs the operation.",
      "After a successful write, briefly state what changed in one sentence and do not print operation IDs.",
    ].join("\n"),
    tools: [
      {
        name: "get_current_context",
        description: "Refresh the lightweight current Zotero context: selected library items, active reader attachment path, selected reader text, and selected annotations.",
        inputSchema: {},
        handler: () => call("get_current_context", {}),
      },
      {
        name: "get_item",
        description: "Get full metadata, notes, and attachments for a Zotero item by item ID.",
        inputSchema: { itemId: z.number() },
        handler: (args) => call("get_item", args),
      },
      {
        name: "search_items",
        description: "Search the Zotero library by title, author, tag, full text, or general query.",
        inputSchema: {
          query: z.string(),
          field: z.enum(["any", "title", "author", "tag", "fulltext"]).optional(),
          limit: z.number().optional(),
        },
        handler: (args) => call("search_items", args),
      },
      {
        name: "get_annotations",
        description: "Get Zotero annotations for a regular item, attachment item, or annotation item. Use this for Zotero-created highlights and notes.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          annotationId: z.number().optional(),
        },
        handler: (args) => call("get_annotations", args),
      },
      {
        name: "get_attachment_path",
        description: "Resolve a Zotero attachment local file path. Pass attachmentId, or itemId to pick the item's primary PDF/attachment.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
        },
        handler: (args) => call("get_attachment_path", args),
      },
      {
        name: "write_tags",
        description: "Add or remove tags on a Zotero item. Requires user approval before execution.",
        inputSchema: {
          itemId: z.number(),
          add: z.array(z.string()).optional(),
          remove: z.array(z.string()).optional(),
        },
        handler: (args) => call("write_tags", args),
      },
      {
        name: "create_note",
        description: "Create a note under a Zotero item. Requires user approval before execution.",
        inputSchema: { parentId: z.number(), content: z.string() },
        handler: (args) => call("create_note", args),
      },
      {
        name: "set_field",
        description: "Set a Zotero metadata field on an item. Requires user approval before execution.",
        inputSchema: { itemId: z.number(), field: z.string(), value: z.string() },
        handler: (args) => call("set_field", args),
      },
      {
        name: "undo_last",
        description: "Undo the latest reversible Zotero write operation, or a specific operation. Requires user approval before execution.",
        inputSchema: { operationId: z.string().optional() },
        handler: (args) => call("undo_last", args),
      },
      {
        name: "list_history",
        description: "List recent reversible Zotero write operations.",
        inputSchema: {},
        handler: () => call("list_history", {}),
      },
    ],
  });
}

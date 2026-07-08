import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PermissionManager } from "./PermissionManager";

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const WRITE_ACTIONS = new Set([
  "write_tags",
  "create_note",
  "set_field",
  "undo_last",
]);

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function imageInputFromOutput(
  output: unknown,
): { media_type: string; data: string } | null {
  const wrapper = asRecord(output);
  const result = asRecord(wrapper?.result) || wrapper;
  const imageInput = asRecord(result?.imageInput);
  const mediaType = imageInput?.media_type;
  const data = imageInput?.data;
  return typeof mediaType === "string" && typeof data === "string" && data
    ? { media_type: mediaType, data }
    : null;
}

function redactImagePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactImagePayload);
  const record = asRecord(value);
  if (!record) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === "data" && typeof nested === "string" && nested.length > 1200) {
      out[key] = `<base64 omitted: ${nested.length} chars>`;
    } else if (
      key === "dataUrl" &&
      typeof nested === "string" &&
      nested.length > 1200
    ) {
      out[key] = `<dataUrl omitted: ${nested.length} chars>`;
    } else {
      out[key] = redactImagePayload(nested);
    }
  }
  return out;
}

function toolContentFromOutput(output: unknown): ToolContent[] {
  const content: ToolContent[] = [
    {
      type: "text",
      text: JSON.stringify(redactImagePayload(output)),
    },
  ];
  const imageInput = imageInputFromOutput(output);
  if (imageInput) {
    const mediaType =
      imageInput.media_type === "image/jpeg" ||
      imageInput.media_type === "image/gif" ||
      imageInput.media_type === "image/webp"
        ? imageInput.media_type
        : "image/png";
    content.push({
      type: "image",
      data: imageInput.data,
      mimeType: mediaType,
    });
  }
  return content;
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
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Operation denied by user",
                }),
              },
            ],
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
    let output: unknown = text;
    try {
      output = JSON.parse(text);
    } catch {
      output = text;
    }
    return { content: toolContentFromOutput(output) };
  };

  return createSdkMcpServer({
    name: "zotero",
    version: "0.1.0",
    alwaysLoad: true,
    instructions: [
      "A lightweight current Zotero context is already included in each user request. Use get_current_context only when you need a refresh or when the included context is insufficient.",
      "Use Zotero MCP tools for semantic library state, annotations, attachment paths, evidence packs, citation verification, and safe writes.",
      "For full PDF text, tables, formulas, or layout, get the attachment path and read the local PDF directly with Python instead of asking Zotero MCP for full text.",
      "For scholarly answers, call get_evidence_pack before making factual claims, locate_quote before quoting, build_trust_report before finalizing claim-heavy output, and build_academic_trace when the answer should be reproducible. Mark unsupported claims instead of inventing citations.",
      "For figure/table claims, call inspect_figure_table_page when page-level visual evidence is needed; use the rendered page image as the source of truth for caption and visual-content checks.",
      "Read tools can be called directly.",
      "Write tools require user approval before the tool handler performs the operation.",
      "After a successful write, briefly state what changed in one sentence and do not print operation IDs.",
    ].join("\n"),
    tools: [
      {
        name: "get_current_context",
        description:
          "Refresh the lightweight current Zotero context: selected library items, active reader attachment path, selected reader text, and selected annotations.",
        inputSchema: {},
        handler: () => call("get_current_context", {}),
      },
      {
        name: "get_item",
        description:
          "Get full metadata, notes, and attachments for a Zotero item by item ID.",
        inputSchema: { itemId: z.number() },
        handler: (args) => call("get_item", args),
      },
      {
        name: "search_items",
        description:
          "Search the Zotero library by title, author, tag, full text, or general query.",
        inputSchema: {
          query: z.string(),
          field: z
            .enum(["any", "title", "author", "tag", "fulltext"])
            .optional(),
          limit: z.number().optional(),
        },
        handler: (args) => call("search_items", args),
      },
      {
        name: "get_annotations",
        description:
          "Get Zotero annotations for a regular item, attachment item, or annotation item. Use this for Zotero-created highlights and notes.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          annotationId: z.number().optional(),
        },
        handler: (args) => call("get_annotations", args),
      },
      {
        name: "get_attachment_path",
        description:
          "Resolve a Zotero attachment local file path. Pass attachmentId, or itemId to pick the item's primary PDF/attachment.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
        },
        handler: (args) => call("get_attachment_path", args),
      },
      {
        name: "get_evidence_pack",
        description:
          "Build a citation-ready evidence pack for a Zotero item or attachment: ranked paragraphs, annotation provenance, page/open-pdf locators, and figure/table caption candidates with page-level visual evidence. Pass includePageImages=true when the PDF is open in Zotero Reader and a multimodal model needs rendered page screenshots.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          query: z.string().optional(),
          maxParagraphs: z.number().optional(),
          maxPages: z.number().optional(),
          includeAnnotations: z.boolean().optional(),
          includePageImages: z.boolean().optional(),
          maxPageImages: z.number().optional(),
          pageImageMaxWidth: z.number().optional(),
        },
        handler: (args) => call("get_evidence_pack", args),
      },
      {
        name: "locate_quote",
        description:
          "Locate a direct quote in Zotero evidence and return provenance: evidence id, page, paragraph/annotation, and zotero://open-pdf URI when available. Use before quoting text verbatim.",
        inputSchema: {
          quote: z.string(),
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          maxMatches: z.number().optional(),
        },
        handler: (args) => call("locate_quote", args),
      },
      {
        name: "verify_citations",
        description:
          "Verify claim-to-source support against Zotero evidence. Returns verified/weak/unverified status, confidence, best evidence, and a claimSourceMap. Use before finalizing citation-heavy academic output.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          text: z.string().optional(),
          claims: z
            .array(
              z.object({
                claim: z.string(),
                quote: z.string().optional(),
                itemId: z.number().optional(),
                attachmentId: z.number().optional(),
                pageIndex: z.number().optional(),
              }),
            )
            .optional(),
        },
        handler: (args) => call("verify_citations", args),
      },
      {
        name: "build_trust_report",
        description:
          "Build a concise Evidence Trust Report for an academic answer or claim list. Summarizes verified, weak, unverified, and figure/table claims that need visual inspection, without attaching page images by default.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          text: z.string().optional(),
          claims: z
            .array(
              z.object({
                claim: z.string(),
                quote: z.string().optional(),
                itemId: z.number().optional(),
                attachmentId: z.number().optional(),
                pageIndex: z.number().optional(),
              }),
            )
            .optional(),
        },
        handler: (args) => call("build_trust_report", args),
      },
      {
        name: "build_academic_trace",
        description:
          "Build a reproducible academic trace artifact for a claim-heavy answer. Includes the Evidence Trust Report, claim-to-source evidence records, failures, visual inspection queue, and a replay plan. Does not attach page images by default.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          query: z.string().optional(),
          answer: z.string().optional(),
          text: z.string().optional(),
          claims: z
            .array(
              z.object({
                claim: z.string(),
                quote: z.string().optional(),
                itemId: z.number().optional(),
                attachmentId: z.number().optional(),
                pageIndex: z.number().optional(),
              }),
            )
            .optional(),
          toolCalls: z
            .array(
              z.object({
                tool: z.string(),
                arguments: z.unknown().optional(),
                status: z
                  .enum(["planned", "called", "succeeded", "failed", "skipped"])
                  .optional(),
                summary: z.string().optional(),
                error: z.string().optional(),
              }),
            )
            .optional(),
        },
        handler: (args) => call("build_academic_trace", args),
      },
      {
        name: "inspect_figure_table_page",
        description:
          "Prepare a multimodal visual audit for a figure/table evidence page. Returns a strict inspection prompt plus the rendered PDF page as image content when the page is open in Zotero Reader. Use this before trusting figure/table claims or caption candidates.",
        inputSchema: {
          itemId: z.number().optional(),
          attachmentId: z.number().optional(),
          pageIndex: z.number().optional(),
          pageNumber: z.number().optional(),
          label: z.string().optional(),
          caption: z.string().optional(),
          query: z.string().optional(),
          claim: z.string().optional(),
          maxPages: z.number().optional(),
          pageImageMaxWidth: z.number().optional(),
        },
        handler: (args) => call("inspect_figure_table_page", args),
      },
      {
        name: "write_tags",
        description:
          "Add or remove tags on a Zotero item. Requires user approval before execution.",
        inputSchema: {
          itemId: z.number(),
          add: z.array(z.string()).optional(),
          remove: z.array(z.string()).optional(),
        },
        handler: (args) => call("write_tags", args),
      },
      {
        name: "create_note",
        description:
          "Create a note under a Zotero item. Requires user approval before execution.",
        inputSchema: { parentId: z.number(), content: z.string() },
        handler: (args) => call("create_note", args),
      },
      {
        name: "set_field",
        description:
          "Set a Zotero metadata field on an item. Requires user approval before execution.",
        inputSchema: {
          itemId: z.number(),
          field: z.string(),
          value: z.string(),
        },
        handler: (args) => call("set_field", args),
      },
      {
        name: "undo_last",
        description:
          "Undo the latest reversible Zotero write operation, or a specific operation. Requires user approval before execution.",
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

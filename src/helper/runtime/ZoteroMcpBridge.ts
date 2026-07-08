import process from "node:process";

type JsonRecord = Record<string, unknown>;
type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const WRITE_ACTIONS = new Set([
  "write_tags",
  "create_note",
  "set_field",
  "undo_last",
]);

const INSTRUCTIONS = [
  "A lightweight current Zotero context is already included in each user request. Use get_current_context only when you need a refresh or when the included context is insufficient.",
  "Use Zotero MCP tools for semantic library state, annotations, attachment paths, evidence packs, citation verification, and safe writes.",
  "For full PDF text, tables, formulas, or layout, get the attachment path and read the local PDF directly with Python instead of asking Zotero MCP for full text.",
  "For scholarly answers, call get_evidence_pack before making factual claims, locate_quote before quoting, build_trust_report before finalizing claim-heavy output, and build_academic_trace when the answer should be reproducible. Mark unsupported claims instead of inventing citations.",
  "For figure/table claims, call inspect_figure_table_page when page-level visual evidence is needed; use the rendered page image as the source of truth for caption and visual-content checks.",
  "Read tools can be called directly.",
  "Write tools require user approval before the tool handler performs the operation.",
  "After a successful write, briefly state what changed in one sentence and do not print operation IDs.",
].join("\n");

interface BridgeConfig {
  endpoint: string;
  helperUrl: string;
  token: string;
}

interface JsonRpcRequest {
  id?: number | string;
  method?: string;
  params?: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
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
  const out: JsonRecord = {};
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

function toolContentFromOutput(output: unknown): McpContent[] {
  const content: McpContent[] = [
    {
      type: "text",
      text: JSON.stringify(redactImagePayload(output), null, 2),
    },
  ];
  const imageInput = imageInputFromOutput(output);
  if (imageInput) {
    content.push({
      type: "image",
      data: imageInput.data,
      mimeType: imageInput.media_type,
    });
  }
  return content;
}

function textArg(argv: string[], name: string, fallback = ""): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function parseBridgeConfig(argv: string[]): BridgeConfig {
  return {
    endpoint: textArg(argv, "--endpoint"),
    helperUrl: textArg(argv, "--helper-url"),
    token: textArg(argv, "--token"),
  };
}

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

function toolSchema(
  properties: JsonRecord = {},
  required: string[] = [],
): JsonRecord {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function tools(): JsonRecord[] {
  return [
    {
      name: "get_current_context",
      description:
        "Refresh the lightweight current Zotero context: selected library items, active reader attachment path, selected reader text, and selected annotations.",
      inputSchema: toolSchema(),
    },
    {
      name: "get_item",
      description:
        "Get full metadata, notes, and attachments for a Zotero item by item ID.",
      inputSchema: toolSchema({ itemId: { type: "number" } }, ["itemId"]),
    },
    {
      name: "search_items",
      description:
        "Search the Zotero library by title, author, tag, full text, or general query.",
      inputSchema: toolSchema(
        {
          query: { type: "string" },
          field: {
            type: "string",
            enum: ["any", "title", "author", "tag", "fulltext"],
          },
          limit: { type: "number" },
        },
        ["query"],
      ),
    },
    {
      name: "get_annotations",
      description:
        "Get Zotero annotations for a regular item, attachment item, or annotation item.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        annotationId: { type: "number" },
      }),
    },
    {
      name: "get_attachment_path",
      description:
        "Resolve a Zotero attachment local file path. Pass attachmentId, or itemId to pick the item's primary PDF/attachment.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
      }),
    },
    {
      name: "get_evidence_pack",
      description:
        "Build a citation-ready evidence pack for a Zotero item or attachment: ranked paragraphs, annotation provenance, page/open-pdf locators, and figure/table caption candidates with page-level visual evidence. Pass includePageImages=true when the PDF is open in Zotero Reader and a multimodal model needs rendered page screenshots.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        query: { type: "string" },
        maxParagraphs: { type: "number" },
        maxPages: { type: "number" },
        includeAnnotations: { type: "boolean" },
        includePageImages: { type: "boolean" },
        maxPageImages: { type: "number" },
        pageImageMaxWidth: { type: "number" },
      }),
    },
    {
      name: "locate_quote",
      description:
        "Locate a direct quote in Zotero evidence and return provenance: evidence id, page, paragraph/annotation, and zotero://open-pdf URI when available. Use before quoting text verbatim.",
      inputSchema: toolSchema(
        {
          quote: { type: "string" },
          itemId: { type: "number" },
          attachmentId: { type: "number" },
          maxMatches: { type: "number" },
        },
        ["quote"],
      ),
    },
    {
      name: "verify_citations",
      description:
        "Verify claim-to-source support against Zotero evidence. Returns verified/weak/unverified status, confidence, best evidence, and a claimSourceMap. Use before finalizing citation-heavy academic output.",
      inputSchema: toolSchema(
        {
          itemId: { type: "number" },
          attachmentId: { type: "number" },
          text: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                claim: { type: "string" },
                quote: { type: "string" },
                itemId: { type: "number" },
                attachmentId: { type: "number" },
                pageIndex: { type: "number" },
              },
              required: ["claim"],
              additionalProperties: false,
            },
          },
        },
        [],
      ),
    },
    {
      name: "build_trust_report",
      description:
        "Build a concise Evidence Trust Report for an academic answer or claim list. Summarizes verified, weak, unverified, and figure/table claims that need visual inspection, without attaching page images by default.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        text: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              quote: { type: "string" },
              itemId: { type: "number" },
              attachmentId: { type: "number" },
              pageIndex: { type: "number" },
            },
            required: ["claim"],
            additionalProperties: false,
          },
        },
      }),
    },
    {
      name: "build_academic_trace",
      description:
        "Build a reproducible academic trace artifact for a claim-heavy answer. Includes the Evidence Trust Report, claim-to-source evidence records, failures, visual inspection queue, and a replay plan. Does not attach page images by default.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        query: { type: "string" },
        answer: { type: "string" },
        text: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              claim: { type: "string" },
              quote: { type: "string" },
              itemId: { type: "number" },
              attachmentId: { type: "number" },
              pageIndex: { type: "number" },
            },
            required: ["claim"],
            additionalProperties: false,
          },
        },
        toolCalls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              arguments: { type: "object" },
              status: {
                type: "string",
                enum: ["planned", "called", "succeeded", "failed", "skipped"],
              },
              summary: { type: "string" },
              error: { type: "string" },
            },
            required: ["tool"],
            additionalProperties: true,
          },
        },
      }),
    },
    {
      name: "inspect_figure_table_page",
      description:
        "Prepare a multimodal visual audit for a figure/table evidence page. Returns a strict inspection prompt plus the rendered PDF page as image content when the page is open in Zotero Reader. Use this before trusting figure/table claims or caption candidates.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        pageIndex: { type: "number" },
        pageNumber: { type: "number" },
        label: { type: "string" },
        caption: { type: "string" },
        query: { type: "string" },
        claim: { type: "string" },
        maxPages: { type: "number" },
        pageImageMaxWidth: { type: "number" },
      }),
    },
    {
      name: "write_tags",
      description:
        "Add or remove tags on a Zotero item. Requires user approval before execution.",
      inputSchema: toolSchema(
        {
          itemId: { type: "number" },
          add: { type: "array", items: { type: "string" } },
          remove: { type: "array", items: { type: "string" } },
        },
        ["itemId"],
      ),
    },
    {
      name: "create_note",
      description:
        "Create a note under a Zotero item. Requires user approval before execution.",
      inputSchema: toolSchema(
        { parentId: { type: "number" }, content: { type: "string" } },
        ["parentId", "content"],
      ),
    },
    {
      name: "set_field",
      description:
        "Set a Zotero metadata field on an item. Requires user approval before execution.",
      inputSchema: toolSchema(
        {
          itemId: { type: "number" },
          field: { type: "string" },
          value: { type: "string" },
        },
        ["itemId", "field", "value"],
      ),
    },
    {
      name: "undo_last",
      description:
        "Undo the latest reversible Zotero write operation, or a specific operation. Requires user approval before execution.",
      inputSchema: toolSchema({ operationId: { type: "string" } }),
    },
    {
      name: "list_history",
      description: "List recent reversible Zotero write operations.",
      inputSchema: toolSchema(),
    },
  ];
}

function writeFrame(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function result(id: number | string | undefined, value: unknown): void {
  if (id === undefined) return;
  writeFrame({ jsonrpc: "2.0", id, result: value });
}

function errorResponse(id: number | string | undefined, message: string): void {
  if (id === undefined) return;
  writeFrame({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

async function requestPermission(
  config: BridgeConfig,
  action: string,
  args: JsonRecord,
): Promise<boolean> {
  if (!config.helperUrl || !config.token) return false;
  const response = await fetch(`${config.helperUrl}/request-permission`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      toolName: "Zotero MCP: " + permissionSummary(action),
      input: { action, ...args },
    }),
  });
  if (!response.ok) return false;
  const parsed = (await response.json()) as { allowed?: boolean };
  return parsed.allowed === true;
}

async function callZotero(
  config: BridgeConfig,
  action: string,
  args: JsonRecord,
): Promise<unknown> {
  if (!config.endpoint) {
    return { success: false, error: "Missing Zotero MCP endpoint" };
  }
  if (WRITE_ACTIONS.has(action)) {
    const allowed = await requestPermission(config, action, args);
    if (!allowed) return { success: false, error: "Operation denied by user" };
  }
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...args }),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function handleRequest(
  config: BridgeConfig,
  request: JsonRpcRequest,
): Promise<void> {
  const method = request.method || "";
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    result(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "zotero", version: "0.1.0" },
      instructions: INSTRUCTIONS,
    });
    return;
  }
  if (method === "tools/list") {
    result(request.id, { tools: tools() });
    return;
  }
  if (method === "tools/call") {
    const params = asRecord(request.params) || {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = asRecord(params.arguments) || {};
    if (!name) throw new Error("Missing tool name");
    const output = await callZotero(config, name, args);
    result(request.id, {
      content: toolContentFromOutput(output),
      isError:
        asRecord(output)?.success === false ||
        typeof asRecord(output)?.error === "string",
    });
    return;
  }
  errorResponse(request.id, `Unsupported MCP method: ${method}`);
}

export function runZoteroMcpStdioServer(argv: string[]): void {
  const config = parseBridgeConfig(argv);
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    void drain();
  });

  async function drain(): Promise<void> {
    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf8");
      const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length) || length < 0) return;
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.slice(bodyEnd);
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        continue;
      }
      try {
        await handleRequest(config, request);
      } catch (error) {
        errorResponse(
          request.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

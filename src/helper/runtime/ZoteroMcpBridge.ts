import process from "node:process";
import { AGENT_EVIDENCE_POLICY_MCP_INSTRUCTIONS } from "../../shared/agentEvidencePolicy";
import { buildAuthenticatedZoteroPayload } from "../../shared/zoteroEndpointAuth";

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
  AGENT_EVIDENCE_POLICY_MCP_INSTRUCTIONS,
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

type StdioFraming = "content-length" | "line";
const MAX_MCP_MESSAGE_BYTES = 8 * 1024 * 1024;

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
        "Legacy ranked evidence helper for citation audits and verification workflows. For ordinary PDF Q&A, prefer get_numbered_evidence_pack so the model can choose source paragraph ids itself.",
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
      name: "get_numbered_evidence_pack",
      description:
        "Build Zotero-GPT-style numbered source context for a Zotero PDF. Ordinary PDFs return contextText with short citationMarkdown markers such as [Eabc123]; copy markers exactly without adding a URL. Long documents return a documentMap instead; call expand_evidence_range for relevant pages/sections before answering.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        maxPages: { type: "number" },
        includeAnnotations: { type: "boolean" },
        maxContextChars: { type: "number" },
        forceFull: { type: "boolean" },
      }),
    },
    {
      name: "expand_evidence_range",
      description:
        "Expand numbered source paragraphs from a long Zotero PDF by page range, source id range, or specific source ids. Use after get_numbered_evidence_pack returns mode='map'.",
      inputSchema: toolSchema({
        itemId: { type: "number" },
        attachmentId: { type: "number" },
        pageStart: { type: "number" },
        pageEnd: { type: "number" },
        sourceStart: { type: "string" },
        sourceEnd: { type: "string" },
        sourceIds: { type: "array", items: { type: "string" } },
        maxPages: { type: "number" },
        includeAnnotations: { type: "boolean" },
        maxContextChars: { type: "number" },
      }),
    },
    {
      name: "locate_quote",
      description:
        "Locate an exact direct quote copied from Zotero evidence and return provenance: evidence id, page, paragraph/annotation, and zotero://open-pdf URI when available. Use before quoting text verbatim; do not pass broad questions or paraphrases as quote.",
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
        "Find and prepare a visual audit for a figure/table. Searches the full PDF when a label/query is given without a page. If it returns terminal=true or status='not_found', stop and report that the visual was not found; do not call locate_quote, shell/Python, or unrelated evidence tools. Otherwise inspect the rendered page before describing the visual.",
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

function writeMessage(message: unknown, framing: StdioFraming): void {
  const json = JSON.stringify(message);
  if (framing === "line") {
    process.stdout.write(json + "\n");
    return;
  }
  const body = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function result(
  id: number | string | undefined,
  value: unknown,
  framing: StdioFraming,
): void {
  if (id === undefined) return;
  writeMessage({ jsonrpc: "2.0", id, result: value }, framing);
}

function errorResponse(
  id: number | string | undefined,
  message: string,
  framing: StdioFraming,
): void {
  if (id === undefined) return;
  writeMessage(
    { jsonrpc: "2.0", id, error: { code: -32603, message } },
    framing,
  );
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
  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildAuthenticatedZoteroPayload(action, args, config.token),
      ),
    });
  } catch (error) {
    return {
      success: false,
      error: `Failed to reach Zotero MCP endpoint ${config.endpoint}: ${describeFetchError(error)}`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    return {
      success: false,
      error: `Zotero MCP endpoint ${config.endpoint} returned HTTP ${response.status}: ${text}`,
    };
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) {
    return `${error.message} (${cause.message})`;
  }
  if (cause && typeof cause === "object") {
    const code = String((cause as { code?: unknown }).code || "");
    const message = String((cause as { message?: unknown }).message || "");
    return [error.message, code, message].filter(Boolean).join(" ");
  }
  return error.message;
}

async function handleRequest(
  config: BridgeConfig,
  request: JsonRpcRequest,
  framing: StdioFraming,
): Promise<void> {
  const method = request.method || "";
  if (method === "notifications/initialized") return;
  if (method === "initialize") {
    result(
      request.id,
      {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "zotero", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      },
      framing,
    );
    return;
  }
  if (method === "tools/list") {
    result(request.id, { tools: tools() }, framing);
    return;
  }
  if (method === "tools/call") {
    const params = asRecord(request.params) || {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = asRecord(params.arguments) || {};
    if (!name) throw new Error("Missing tool name");
    const output = await callZotero(config, name, args);
    result(
      request.id,
      {
        content: toolContentFromOutput(output),
        isError:
          asRecord(output)?.success === false ||
          typeof asRecord(output)?.error === "string",
      },
      framing,
    );
    return;
  }
  errorResponse(request.id, `Unsupported MCP method: ${method}`, framing);
}

function trimLeadingAsciiWhitespace(
  buffer: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> {
  let index = 0;
  while (
    index < buffer.length &&
    (buffer[index] === 0x09 ||
      buffer[index] === 0x0a ||
      buffer[index] === 0x0d ||
      buffer[index] === 0x20)
  ) {
    index++;
  }
  return index > 0 ? buffer.slice(index) : buffer;
}

function parseNextRequest(buffer: Buffer<ArrayBufferLike>): {
  request: JsonRpcRequest;
  framing: StdioFraming;
  rest: Buffer<ArrayBufferLike>;
} | null {
  const trimmed = trimLeadingAsciiWhitespace(buffer);
  if (trimmed.length === 0) return null;

  if (trimmed[0] === 0x7b) {
    const newline = trimmed.indexOf("\n");
    if (newline < 0) return null;
    const line = trimmed.slice(0, newline).toString("utf8").trim();
    const rest = trimmed.slice(newline + 1);
    if (!line) return { request: {}, framing: "line", rest };
    return {
      request: JSON.parse(line) as JsonRpcRequest,
      framing: "line",
      rest,
    };
  }

  const headerEnd = trimmed.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const header = trimmed.slice(0, headerEnd).toString("utf8");
  const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
  if (
    !Number.isFinite(length) ||
    length < 0 ||
    length > MAX_MCP_MESSAGE_BYTES
  ) {
    throw new Error("Malformed MCP content-length header");
  }
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (trimmed.length < bodyEnd) return null;
  return {
    request: JSON.parse(trimmed.slice(bodyStart, bodyEnd).toString("utf8")),
    framing: "content-length",
    rest: trimmed.slice(bodyEnd),
  };
}

export function runZoteroMcpStdioServer(argv: string[]): void {
  const config = parseBridgeConfig(argv);
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let draining = false;
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_MESSAGE_BYTES) {
      buffer = Buffer.alloc(0);
      process.stderr.write("Claudero MCP request exceeded 8 MB\n");
      return;
    }
    void drain();
  });

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (buffer.length > 0) {
        let parsed: ReturnType<typeof parseNextRequest>;
        try {
          parsed = parseNextRequest(buffer);
        } catch (error) {
          buffer = Buffer.alloc(0);
          errorResponse(
            undefined,
            error instanceof Error ? error.message : String(error),
            "content-length",
          );
          return;
        }
        if (!parsed) return;
        buffer = parsed.rest;
        try {
          await handleRequest(config, parsed.request, parsed.framing);
        } catch (error) {
          errorResponse(
            parsed.request.id,
            error instanceof Error ? error.message : String(error),
            parsed.framing,
          );
        }
      }
    } finally {
      draining = false;
      if (buffer.length > 0) void drain();
    }
  }
}

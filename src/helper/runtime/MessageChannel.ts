export interface ImageInput {
  media_type: string;
  data: string;
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };

type SDKUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[];
  };
  parent_tool_use_id: string | null;
  tool_use_result?: unknown;
};

interface QueuedMessage {
  prompt: string;
  images?: ImageInput[];
}

interface QueuedToolResult {
  toolUseId: string;
  result: unknown;
}

function normalizeMediaType(value: string): ImageMediaType {
  switch (value) {
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
      return "image/gif";
    case "image/webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

export class MessageChannel {
  private queue: QueuedMessage[] = [];
  private toolResultQueue: QueuedToolResult[] = [];
  private closed = false;
  private pendingResolve: (() => void) | null = null;

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed || this.queue.length > 0 || this.toolResultQueue.length > 0) {
      if (this.toolResultQueue.length > 0) {
        const { toolUseId, result } = this.toolResultQueue.shift()!;
        yield {
          type: "user",
          message: { role: "user", content: [] },
          parent_tool_use_id: toolUseId,
          tool_use_result: result,
        };
      } else if (this.queue.length > 0) {
        const { prompt, images } = this.queue.shift()!;
        const content: ContentBlock[] = [{ type: "text", text: prompt }];
        for (const img of images || []) {
          if (img && img.data && img.media_type) {
            content.push({
              type: "image",
              source: { type: "base64", media_type: normalizeMediaType(img.media_type), data: img.data },
            });
          }
        }
        yield {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
        };
      } else if (this.closed) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          this.pendingResolve = resolve;
        });
      }
    }
  }

  send(prompt: string, images?: ImageInput[]): void {
    if (this.closed) {
      throw new Error("MessageChannel is closed");
    }
    this.queue.push({ prompt, images });
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  sendToolResult(toolUseId: string, result: unknown): void {
    if (this.closed) {
      throw new Error("MessageChannel is closed");
    }
    this.toolResultQueue.push({ toolUseId, result });
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  close(): void {
    this.closed = true;
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
    }
  }

  clear(): void {
    this.queue = [];
    this.toolResultQueue = [];
  }
}

export type RequestProvider = "claude" | "codex" | "deepseek";

export class RequestBusyError extends Error {}

export class RequestLease {
  readonly controller = new AbortController();
  readonly released: Promise<void>;
  private resolveReleased!: () => void;

  constructor(
    readonly requestId: string,
    readonly provider: RequestProvider,
    readonly generation: number,
    readonly conversationId?: string,
  ) {
    this.released = new Promise((resolve) => {
      this.resolveReleased = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.controller.abort();
  }

  finish(): void {
    this.resolveReleased();
  }
}

export class RequestCoordinator {
  private readonly requests = new Map<string, RequestLease>();
  private readonly providers = new Map<RequestProvider, RequestLease>();
  private readonly recentIds = new Set<string>();
  private generation = 0;
  private paused = false;

  acquire(
    requestId: string,
    provider: RequestProvider,
    conversationId?: string,
  ): RequestLease {
    if (this.paused || this.providers.has(provider)) {
      throw new RequestBusyError(
        `${provider} is busy. Wait for its current operation to finish.`,
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) {
      throw new Error("Invalid request ID");
    }
    if (this.requests.has(requestId) || this.recentIds.has(requestId)) {
      throw new RequestBusyError("Request ID has already been used.");
    }
    const lease = new RequestLease(
      requestId,
      provider,
      ++this.generation,
      conversationId,
    );
    this.requests.set(requestId, lease);
    this.providers.set(provider, lease);
    return lease;
  }

  get(requestId: string): RequestLease | undefined {
    return this.requests.get(requestId);
  }

  active(provider: RequestProvider): RequestLease | undefined {
    return this.providers.get(provider);
  }

  owns(lease: RequestLease): boolean {
    return (
      this.requests.get(lease.requestId) === lease &&
      this.providers.get(lease.provider) === lease
    );
  }

  release(lease: RequestLease): void {
    if (!this.owns(lease)) return;
    this.requests.delete(lease.requestId);
    this.providers.delete(lease.provider);
    this.recentIds.add(lease.requestId);
    while (this.recentIds.size > 1024) {
      this.recentIds.delete(this.recentIds.values().next().value!);
    }
    lease.finish();
  }

  pause(): RequestLease[] {
    this.paused = true;
    return [...this.requests.values()];
  }

  resume(): void {
    this.paused = false;
  }
}

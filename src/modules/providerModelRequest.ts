import type { AiProvider } from "./providerRegistry";
import type { ProviderModelDescriptor } from "../shared/providerModels";

/** The pane owns one catalog request. Superseded or detached results are inert. */
export class ProviderModelRequest {
  private pending?: { provider: AiProvider; controller: AbortController };
  private disposed = false;

  constructor(
    private fetchModels: (
      provider: AiProvider,
      signal: AbortSignal,
    ) => Promise<ProviderModelDescriptor[]>,
    private current: (provider: AiProvider) => boolean,
    private apply: (
      provider: AiProvider,
      models: ProviderModelDescriptor[],
    ) => void,
  ) {}

  async load(provider: AiProvider): Promise<void> {
    if (this.disposed || this.pending?.provider === provider) return;
    this.pending?.controller.abort();
    this.pending = undefined;
    if (provider === "claude" || !this.current(provider)) return;
    const request = { provider, controller: new AbortController() };
    this.pending = request;
    try {
      const models = await this.fetchModels(
        provider,
        request.controller.signal,
      );
      if (
        !this.disposed &&
        !request.controller.signal.aborted &&
        this.pending === request &&
        this.current(provider) &&
        models.length
      ) {
        this.apply(provider, models);
      }
    } catch (error) {
      if (!request.controller.signal.aborted) throw error;
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending?.controller.abort();
    this.pending = undefined;
  }
}

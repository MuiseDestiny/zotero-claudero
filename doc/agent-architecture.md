# Claudero Agent Architecture

Claudero treats Claude Code and Codex as agent runtimes behind a shared helper
protocol. The goal is to keep Zotero UI code provider-neutral while each runtime
adapter owns provider-specific launch, session, stream, permission, and command
details.

## Layers

- Provider registry: `src/modules/providerRegistry.ts` defines provider labels,
  capabilities, defaults, host-scoped CLI paths, and Codex launch preferences.
- Client payload builder: `src/modules/claudeHelperClient.ts` converts Zotero
  preferences and conversation state into helper requests, gated by provider
  capabilities.
- Helper runtime adapters: `src/helper/runtime/AgentRuntimeAdapter.ts` exposes a
  common adapter interface for Claude and Codex runtimes.
- Event protocol: `src/shared/agentEvents.ts` defines versioned event envelopes,
  traces, and replay helpers.
- Conversation state: `src/modules/providerSessionState.ts` merges provider
  session events into saved conversation metadata.
- Diagnostics: the helper exposes `/diagnostics` and `/trace/latest`; the
  preferences Diagnostics tab renders helper/runtime/trace state.

## Trace Replay

Save a trace from `/trace/latest`, then replay it:

```bash
npm run trace:replay -- --file trace.json
```

Or read directly from a running helper:

```bash
npm run trace:replay -- --port 38660 --token-file /path/to/.token
```

The replay output reports protocol version, source provider/runtime, event
counts, latest error, and reconstructed assistant text.

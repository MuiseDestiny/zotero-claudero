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

## Academic Skills

Academic skills are hidden workflow templates behind the normal natural-language
composer. Users still type ordinary requests such as "compare these papers" or
"extract the methods"; Claudero matches the request against enabled academic
skills, checks Zotero context requirements, then compiles a stronger workflow
prompt for the active provider.

Skills are stored as:

- Builtin templates shipped with the plugin.
- Profile overrides in the `academicSkills` preference.
- Imported skills, initially disabled until the user reviews them.

Each skill declares:

- Routing metadata: description, routing guidance, examples, negative examples,
  and keywords.
- Context requirements: selected item count, PDF text, annotations, and notes.
- Tool policy: Zotero MCP, Zotero writes, web search, and script permissions.
- Output contract: Markdown, Markdown table, JSON, or Zotero note target.
- Prompt template: system/workflow instructions loaded only when matched.

Builtin update behavior is hash-based:

- Unmodified builtin skills automatically follow plugin updates.
- Modified skills keep the user's copy and show `update available` when the
  builtin hash changes.
- `Update` replaces the local copy with the latest builtin template.
- `Reset` removes the local override.

Supported import paths:

- Claudero skill JSON.
- Agent Skills `SKILL.md` frontmatter and Markdown instructions.
- MCP prompt JSON.
- Plain Markdown instructions.

Imported skills use a conservative policy: disabled by default, no Zotero writes,
no web search, and no script execution unless the user edits the skill policy.

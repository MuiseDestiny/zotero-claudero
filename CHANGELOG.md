# Changelog

## Unreleased

- Stabilize MCP connection tests with the official SDK, including process failures,
  Streamable HTTP, legacy SSE, timeouts, and paginated tool lists.
- Start and authenticate the local helper before settings requests.
- Preserve explicit proxies and correctly parse quoted environment variables.
- Fix cleared CLI paths, device-specific configuration, NVM discovery, Linux home
  detection, and WSL detection without overwriting manual edits.
- Apply workspace changes to the next persistent request.
- Improve preferences with accessible scrolling tabs, responsive fields, Reader
  theme colors, setup guidance, and complete localization.
- Separate HTTP and SSE configuration, preserve quoted command arguments, and
  protect existing MCP settings from malformed JSON and duplicate names.

## 0.1.0

Initial public preview of Claudero for Zotero 7 through 10.

- Claude Code, Codex, and DeepSeek Harness provider adapters.
- Zotero-aware conversations with PDF, annotation, evidence, and citation tools.
- Persistent conversation history, provider session state, permissions, MCP, and academic skills.
- macOS, Windows, and Linux executable discovery, including Codex WSL support.
- Loopback-only helper networking with capability-token authentication.
- Privacy-safe diagnostic summaries without raw prompts or tool-result previews.
- Automated release metadata, XPI checksum, tracked-secret, and dependency security gates.

This release requires a local Node.js 20+ runtime and the provider CLI selected
in Preferences. DeepSeek Harness support remains a developer-preview feature
and requires a compatible Node.js 24 runtime.

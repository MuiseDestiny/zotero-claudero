# Privacy

Claudero is a local Zotero plugin. The project does not operate a Claudero
backend service and does not add product analytics or telemetry.

## Data Sent Outside Zotero

When you submit a request, Claudero sends the prompt and the selected Zotero
context to the provider CLI you selected. Depending on the request, this can
include bibliographic metadata, PDF text, annotations, notes, local attachment
paths, rendered page images, and prior conversation turns. The provider CLI may
send that data to its configured remote API under the provider's own terms and
privacy policy.

Claude and Codex can also call enabled Zotero or external MCP tools. An external
MCP server receives the arguments sent to that tool. Review custom MCP server
configuration before enabling it. DeepSeek currently receives serialized
prompt context but does not use Claudero's Zotero MCP bridge.

## Data Stored Locally

Claudero stores data below `<Zotero profile>/claudero`, including conversation
history, custom prompts, the helper capability token, diagnostics, and the
default provider workspace. Conversation records may contain prompts, model
responses, images, tool data, and Zotero context snapshots. Provider CLIs may
also keep their own sessions or credentials outside the Zotero profile.

Provider environment values entered in Preferences are stored with Zotero
preferences and passed to the selected provider process. Treat the Zotero
profile and operating-system account as sensitive. Prefer a provider's native
credential store when available.

Deleting a conversation from Claudero removes its managed history files.
Uninstalling the plugin may leave the `<Zotero profile>/claudero` directory and
provider-owned data in place so an accidental uninstall does not erase user
work. Remove those locations manually when permanent deletion is required.

## Diagnostics

Diagnostic export is user-triggered. Claudero records lengths and stable hashes
instead of raw prompt, selected-text, quote, claim, answer, and tool-result
previews. Credential-shaped fields and common inline key/token formats are
redacted. Diagnostics can still contain local paths, Zotero item identifiers,
collection names, runtime configuration summaries, and sanitized errors.
Always review an exported JSON file before sharing it.

## Network Configuration

The Claudero helper is restricted to loopback and authenticated with a random
per-profile token. Provider and MCP traffic follows the selected CLI/server
configuration, including any proxy or custom base URL entered by the user.

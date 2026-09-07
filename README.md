# Claudero

[English](README.md) | [简体中文](doc/README-zhCN.md)

Claudero is a Zotero plugin that puts three agent runtimes in the Zotero
workspace: **Claude Code**, **Codex**, and **DeepSeek Harness**. It is designed
for research conversations that need access to the selected Zotero item, PDF
reader state, annotations, notes, and local attachments.

The plugin runs a local Node.js helper and sends requests to the provider CLI
selected in Zotero preferences:

```text
Zotero pane -> local helper -> provider adapter -> Claude / Codex / DeepSeek
```

## Supported Platforms

Claudero targets **Zotero 7 and later** (the current manifest accepts Zotero
7 through 10) on the operating systems supported by Zotero:

| Host    | Claude Code                   | Codex             | DeepSeek Harness       |
| ------- | ----------------------------- | ----------------- | ---------------------- |
| macOS   | Native CLI                    | Native CLI        | Native `dsh`           |
| Windows | Native CLI or executable path | Native CLI or WSL | Native `dsh.cmd`/`dsh` |
| Linux   | Native CLI                    | Native CLI        | Native `dsh`           |

The same plugin build is used on all three host operating systems. Executable
paths are auto-detected from common locations and can be overridden per device
in Preferences. On Windows, Codex can be run in WSL; set the installation mode
to **WSL** and optionally provide the distribution name.

### Runtime requirements

- Zotero 7 or newer.
- Node.js 20 or newer for the local helper. Node.js LTS is recommended.
- A network connection and valid credentials for the provider you use.
- The provider CLI you select, except that DeepSeek can be installed from the
  missing-CLI warning inside Claudero.
- DeepSeek Harness `0.1.0-rc.6` requires Node.js 24 APIs. Claudero searches
  for a compatible Node runtime automatically; set `DSH_NODE_PATH` in the
  DeepSeek environment to override it.

## Install

### Use a release package

Download the `.xpi` for your Zotero version from the project's Releases page,
then install it from **Tools -> Plugins -> gear menu -> Install Plugin From
File**. Restart Zotero after installation if it asks you to do so.

### Build from source

```bash
git clone https://github.com/MuiseDestiny/zotero-claudero.git
cd zotero-claudero
npm install
npm run build
```

The production package is written to `.scaffold/build/claudero.xpi`. Install
that file in Zotero using the same plugin installer.

For development, `npm start` starts the scaffold server and launches Zotero
with the development build. Copy `.env.example` to `.env` first and set
`ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and, when needed,
`ZOTERO_PLUGIN_PROFILE_PATH`.

## Choose a Provider

Open **Zotero Preferences -> Claudero** and select a default provider. Each
provider has its own CLI path and environment-variable panel. Leave a path
empty to use auto-detection, or enter an absolute path.

Environment fields accept `NAME=value` lines, optional `export`, and comments.
General values apply to all providers; provider values override them. Variables
such as `$PATH` and `${PATH}` expand in unquoted or double-quoted values. Use
single quotes for literal credentials containing dollar signs: `KEY='secret$value'`.

### Claude Code

Install and authenticate the official Claude Code CLI using its normal setup,
or provide the following variables in the Claude provider environment:

```dotenv
ANTHROPIC_API_KEY=...
# Optional:
# ANTHROPIC_BASE_URL=https://your-compatible-endpoint.example
```

The Claude integration supports streaming responses, native provider sessions,
image attachments, Zotero MCP tools, plan mode, provider commands, compact,
fork, rollback, permission prompts, and the Claude model/effort controls.

### Codex

Install and authenticate the Codex CLI using its normal setup, or configure an
API-compatible environment:

```dotenv
OPENAI_API_KEY=...
# Optional:
# OPENAI_BASE_URL=https://your-compatible-endpoint.example
# OPENAI_MODEL=...
```

In the Codex preferences panel choose **Native** or **WSL** on Windows. The
Codex integration supports streaming, native threads, image attachments,
Zotero MCP tools, plan mode, fork, rollback, compact, permission prompts, and
model-specific reasoning effort. Its safety setting can be **Workspace write**
or **Read only**.

### DeepSeek Harness

DeepSeek is integrated through the official headless command
`dsh --profile headless`. It is a developer-preview integration and currently
does not expose an interactive login command.

Configure the DeepSeek provider environment with:

```dotenv
DEEPSEEK_API_KEY=...
# Optional:
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# DSH_MODEL=deepseek-v4-flash
# DSH_HOME=/path/to/.dsh
# DSH_NODE_PATH=/path/to/node24
```

You can either install it yourself:

```bash
npm install -g @deepseek-ai/dsh@latest
```

or send a request with DeepSeek selected. If `dsh` is missing, Claudero shows
a warning with an **Install DeepSeek Harness** action. That action installs a
managed copy into `~/.claudero/deepseek` on macOS, Windows, and Linux, then
saves the discovered CLI path. Installation is user-triggered; Claudero does
not silently install packages. The command `dsh web` only opens the browser
UI and is not sufficient for Claudero.

DeepSeek supports text conversations and the `deepseek-v4-flash` and
`deepseek-v4-pro` model options. It currently does not support image
attachments, Zotero MCP, provider slash commands, plan approval, fork,
rollback, compact, or native session resume. Each headless turn is a separate
process, so Claudero replays the visible conversation history itself. The
latest 16 non-empty messages are replayed, and saved conversations are
replayed after Zotero restarts.

## What Claudero Can Do

### Zotero-aware research chat

The composer can use:

- Selected library items and collections.
- Item metadata, creators, abstract, tags, child notes, and attachment paths.
- The active PDF attachment and reader selection.
- Selected text and Zotero annotations, including page information.
- Local PDF files and Zotero full-text caches when available.

The current context is attached automatically. Claude and Codex can request
fresher or more detailed data through Zotero tools when the selected context is
missing or stale. DeepSeek receives the serialized context and replayed text,
but does not have the Zotero MCP tool bridge.

### Evidence and citations

Claude and Codex can use the built-in Zotero MCP evidence tools to:

- Search a paper and return numbered evidence.
- Locate and verify exact quotes.
- Expand a document map into relevant page ranges.
- Inspect figures and tables using rendered PDF pages when available.
- Verify claims and surface contradictory evidence.

Evidence markers become quiet clickable links in the response and open the
corresponding Zotero PDF page, annotation, or item. DeepSeek can still answer
from the prompt and replayed text, but it does not have the MCP evidence bridge
in this integration.

### Academic workflows and skills

Normal language requests are routed to built-in workflows when appropriate:

- Summarize a paper.
- Extract methods.
- Build a literature matrix.
- Verify citations.

Skills can require specific Zotero context, define an output format, and apply a
tool policy. Imported `SKILL.md`, MCP prompt, Markdown, and JSON skills are
disabled by default until reviewed. Academic skills default to read-only Zotero
access and do not allow web search or scripts unless explicitly configured.

### Conversation and interaction features

- Streaming assistant output, thinking blocks, tool cards, and usage activity.
- Persistent conversation history with reopen-after-restart support.
- Cross-provider history replay when a provider cannot resume a native session.
- Editable user turns, retry, copy, conversation search, rename, and delete.
- Provider-specific model and reasoning-effort controls.
- Permission dialogs for interactive tool actions.
- Optional insertion of the final response into a Zotero note.
- Diagnostics, helper health, runtime status, and event-trace export.

## Preferences

The General tab contains settings shared by providers:

- **Default provider**: Claude, Codex, or DeepSeek Harness.
- **Node.js path**: leave empty for auto-detection or provide an absolute path.
- **Workspace path**: working directory for provider processes. Empty uses
  `<Zotero profile>/claudero/workspace`.
- **Helper port**: local HTTP port used by the Node helper, default `38660`.
- **Proxy**: optional HTTP/HTTPS proxy for provider network requests. An explicit
  proxy is always passed to the provider; connection failures do not silently
  switch to a direct connection.
- **Environment variables**: one `KEY=VALUE` per line. Provider-specific
  variables should normally be entered in that provider's panel.

The MCP tab can enable the built-in Zotero server and configure external stdio
or HTTP/SSE MCP servers. The Skills tab manages built-in and imported academic
skills. The Diagnostics tab can refresh runtime state, export diagnostics, and
restart provider services.

The composer permission modes are **Auto**, **Ask permissions**,
**Accept edits**, **Plan**, **Don't ask**, and **Bypass permissions**. The
available modes and tool actions are still limited by the selected provider's
capabilities.

Do not commit API keys or other secrets to this repository. Prefer the provider
environment fields or the provider's own credential store.

## Safety Model

The plugin UI and local helper communicate over loopback only. Provider tools
are subject to the selected permission mode and provider safety settings.
Academic workflows are read-only by default. Zotero write tools require user
approval, and supported writes are tracked for undo. The assistant response is
shown in the pane before the user chooses to insert it as a note.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and security
boundaries, and [PRIVACY.md](PRIVACY.md) for provider data flow, local storage,
and diagnostic-export details.

## Troubleshooting

### Provider CLI not found

Leave the path empty and restart the panel so auto-detection can run, or set an
absolute path in the provider tab. For DeepSeek, use the **Install DeepSeek
Harness** action in the warning card and then retry.

### DeepSeek reports a Node.js compatibility error

Install Node.js 24 or newer and set `DSH_NODE_PATH` to its executable if it is
not in a standard location. `dsh web` is unrelated to the headless CLI used by
Claudero.

### Authentication or network errors

Check the provider's API key/login state, base URL, proxy, and the helper
diagnostics panel. Environment values are passed to the provider subprocess;
changing them may require restarting the provider runtime.

### PDF evidence is incomplete

Open the attachment in Zotero Reader and make sure Zotero has indexed it. For
figure/table inspection, keep the PDF open so page rendering is available.

## Development and Verification

```bash
npm install
npm run check:release
npm test
npm run lint:check
npm run audit:all
npm run test:runtime
npm run test:helper:mock
npm run test:evidence:ci
```

The helper smoke test checks the local HTTP protocol and can be run for the
providers available on the current machine:

```bash
npm run test:helper:quick
npm run test:helper -- --providers deepseek
```

`npm test` runs Zotero browser tests and therefore requires a local Zotero
binary/profile. The mock helper test does not require a provider login. Before
publishing a release, run the complete CI workflow and install the generated
XPI in a clean Zotero profile.

The complete manual and automated release gate is documented in
[docs/release-checklist.md](docs/release-checklist.md).

See [doc/agent-architecture.md](doc/agent-architecture.md) for the provider
adapter, helper protocol, event trace, academic skills, and MCP architecture.

## License

Claudero is licensed under [AGPL-3.0-or-later](LICENSE).

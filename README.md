# Claudero

[English](README.md) | [简体中文](doc/README-zhCN.md)

**An AI research assistant inside Zotero, powered by Claude Code, Codex, and
DeepSeek Harness.**

Ask questions about papers, compare selected references, work with annotations,
and follow answers back to the source without leaving Zotero.

## Features

- Read selected papers, metadata, notes, PDF selections, and annotations.
- Retrieve evidence, locate quotes, inspect figures and tables, and follow
  clickable links to the corresponding Zotero source.
- Summarize papers, extract methods, build literature matrices, and check
  citations with academic workflows.
- Save and reopen conversations, edit or retry messages, and insert answers
  into Zotero notes.
- Choose models, reasoning effort, permissions, and external MCP tools.

## Install and Start

Claudero supports **Zotero 7–10** on macOS, Windows, and Linux.

1. Download `claudero.xpi` from
   [GitHub Releases](https://github.com/MuiseDestiny/zotero-claudero/releases).
2. In Zotero, open **Tools -> Plugins -> gear menu -> Install Plugin From File**
   and select the XPI.
3. Install **Node.js 20+** and at least one provider below. Node.js 24 LTS is
   recommended; DeepSeek requires Node.js 24+.
4. Open **Zotero Preferences -> Claudero**, choose a provider, and use
   **Check details** to complete setup. Existing programs are discovered
   automatically, so most users can leave executable paths empty.
5. Select a paper or open its PDF, open the Claudero pane, and ask a question.

| Provider         | Required program | Authentication                                 |
| ---------------- | ---------------- | ---------------------------------------------- |
| Claude           | Claude Code CLI  | Existing CLI login or `ANTHROPIC_API_KEY`      |
| Codex            | Codex CLI        | Existing CLI login or `OPENAI_API_KEY`         |
| DeepSeek Harness | `dsh`            | Existing dsh credentials or `DEEPSEEK_API_KEY` |

Install and authenticate Claude Code or Codex using the provider's setup
instructions. If DeepSeek is missing, use **Install DeepSeek Harness** in
Claudero, or install it with `npm install -g @deepseek-ai/dsh@latest`.
DeepSeek support is experimental.

On Windows, Codex can also run in WSL. Select **WSL** in Codex settings and
complete login inside the selected distribution.

Model access, usage limits, and charges depend on your provider. Claudero does
not include provider credentials or model access.

## How It Works

Claudero connects Zotero to a locally installed agent runtime through a
separate Node.js helper. It does not train a model or operate its own AI backend.

```text
Zotero: your question + selected research context
    -> local Node.js helper
        -> Claude Agent SDK -> Claude Code
        -> Codex app-server
        -> DeepSeek Harness headless CLI
    -> configured AI provider

Claude / Codex -> Zotero MCP tools -> library, reader, and evidence
```

When you submit a question, Claudero collects lightweight context from the
current selection and PDF reader, rather than automatically uploading the
entire library. Claude and Codex can use **MCP (Model Context Protocol)** tools
to retrieve additional item information, notes, annotations, and PDF evidence.

For paper questions, tools return source passages and locations. Long documents
can be explored by section or page range; figure and table questions can use
rendered PDF pages. Source links in the answer open the corresponding Zotero
item, annotation, or PDF page. These links help you check the answer, but do not
guarantee that the model's interpretation is correct.

Academic skills turn common requests into structured workflows, such as a paper
summary or literature matrix. Imported skills are disabled until you review and
enable them.

Conversations are saved locally. Claude and Codex can resume native sessions
when available; DeepSeek replays recent conversation text on each turn. After
an interruption, you can explicitly retry from saved history. Retrying does not
undo any tool action that has already completed.

## Provider Differences

| Capability              | Claude         | Codex                 | DeepSeek Harness   |
| ----------------------- | -------------- | --------------------- | ------------------ |
| Text conversations      | Yes            | Yes                   | Yes                |
| Live streaming          | Yes            | Yes                   | Final answer only  |
| Image input             | Yes            | Yes                   | No                 |
| Zotero / external MCP   | Yes            | Yes                   | No                 |
| Plan mode               | Yes            | Yes                   | No                 |
| Session continuation    | Native session | Native thread         | Recent text replay |
| Conversation fork       | History replay | Native fork or replay | No                 |
| Compact                 | Yes            | Yes                   | No                 |
| Provider slash commands | Yes            | No                    | No                 |
| Reasoning effort        | Yes            | Model-dependent       | No                 |

## Settings

Most users only need to choose a provider. Optional **Advanced** settings include:

- **Executable paths:** leave empty for automatic discovery, or set an absolute
  path for a custom installation.
- **Workspace:** the working directory used by the agent. Empty uses
  `<Zotero profile>/claudero/workspace`.
- **Proxy:** leave empty to inherit the process environment, or set an HTTP/HTTPS
  proxy for provider connections.
- **Environment variables:** enter one `KEY=VALUE` per line in the selected
  provider's settings. Provider values override general values.

The **MCP** tab manages Zotero and external tools; **Skills** manages academic
workflows; **Diagnostics** shows connection state and offers service restart.

## Privacy and Permissions

The helper runs locally, but the selected provider may send your questions,
paper text, notes, conversation history, and images to its configured remote API.
External MCP servers receive their tool arguments. Claudero adds no product
telemetry.

Built-in Zotero write tools require your approval, or a matching approval you
explicitly chose to remember. Review file, shell, and external-tool permissions
before granting access. Conversation history stays under
`<Zotero profile>/claudero`; API keys entered in Preferences are stored with
Zotero preferences. Prefer the provider's own credential store when available.

See [Privacy](PRIVACY.md) and [Security](SECURITY.md) for details.

## AI-Assisted Development

Claudero is developed with AI assistance, including code, refactoring, tests,
and documentation. AI assistance does not replace maintainer responsibility or
human review. Check important research answers against the original papers.

## License

[AGPL-3.0-or-later](LICENSE).

# Claudero

Claudero embeds a Claude Code-powered research assistant in Zotero.

The plugin follows the same core idea as Claudian for Obsidian, but adapts it to Zotero's runtime:

```text
Zotero item pane
  -> local Node helper
  -> @anthropic-ai/claude-agent-sdk query()
  -> Claude Code CLI
```

## Current MVP

- Adds a Claudero section to the Zotero item pane.
- Reads the currently selected regular Zotero item as context.
- Includes metadata, creators, abstract, tags, child notes, attachment paths, and available indexed attachment text.
- Starts a local Node helper from the Zotero plugin.
- Streams Claude Code responses back into the item pane.
- Inserts the latest assistant response as a child note after user action.

## Development

```bash
npm install
npm run build
npm start
```

Create `.env` from `.env.example` for local development. This checkout is already configured with:

- Zotero binary: `/Applications/Zotero.app/Contents/MacOS/zotero`
- Profile: `/Users/muisedestiny/Library/Application Support/Zotero/Profiles/sh9ym0ac.Zotero7`

You can run either command:

```bash
npm start
npm run restart
```

## Preferences

Open Zotero preferences -> Claudero.

- `Node.js path`: leave empty to auto-detect common locations, or set an absolute path.
- `Claude Code CLI path`: optional absolute path to `claude`.
- `Workspace path`: optional Claude Code working directory. Empty uses `<Zotero profile>/claudero/workspace`.
- `Helper port`: local HTTP helper port.
- `Environment variables`: one `KEY=VALUE` per line, for example `ANTHROPIC_API_KEY=...` or `ANTHROPIC_BASE_URL=...`.

## Safety Boundary

Claude Code does not write directly to Zotero's database in this MVP. Claudero renders the answer first, then applies Zotero writes only when the user clicks `Insert Note`.

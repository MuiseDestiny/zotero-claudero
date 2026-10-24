# Standalone Helper

Claudero can bundle its Helper and Bun runtime into a platform-native executable.
This removes the separate Node.js installation requirement for the Helper and its
host-native Zotero MCP bridge. It preserves the Claude Agent SDK, Codex app-server,
permissions, and session behavior; it is not a rewrite of the provider runtimes.

## Runtime Requirements

| Installation                                  | Separate Node.js required?                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Matching standalone XPI + native Claude Code  | No, for the Helper and provider launch                                            |
| Matching standalone XPI + native Codex        | No, including the built-in host MCP bridge                                        |
| Portable XPI or unsupported standalone target | Node.js 20+ for the Helper fallback                                               |
| npm/JavaScript Claude or Codex CLI            | Yes; Node must also be available in the provider's PATH                           |
| DeepSeek Harness                              | Yes, Node.js 24+ with the required TypeScript/Zstd APIs; install `dsh` separately |
| Codex inside WSL with Zotero MCP              | Node.js inside the selected WSL distribution for the portable MCP bridge          |
| Custom MCP server written for Node            | Whatever runtime that server requires                                             |
| Developing/building Claudero                  | Node.js 20+ and npm; standalone compilation also needs Bun 1.4.2                  |

Native providers remain separate programs with their own authentication, model
access, and dependencies. Bundling Bun does not make every external program
Node-free. Prefer the provider's native installer when avoiding Node.js.

## Build Locally

The ordinary build stays portable and does not require Bun:

```sh
npm ci
npm run check:release
```

With Bun **1.4.2** installed, build a standalone package for the current host:

```sh
npm run build:standalone
node scripts/verify-release.mjs
npm run test:helper:standalone
```

`CLAUDERO_BUN_PATH` can select an isolated compiler without adding it to the
project's dependencies or the user's PATH:

```sh
CLAUDERO_BUN_PATH=/absolute/path/to/bun npm run build:standalone
```

The result is `.scaffold/build/claudero.xpi`. These commands only build and test
local files; they do not publish a plugin, tag Git, or upload artifacts.

`CLAUDERO_HELPER_TARGETS` selects comma-separated targets:

```sh
CLAUDERO_HELPER_TARGETS=darwin-arm64,darwin-x64 npm run build:standalone
```

Available targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`win32-arm64`, and `win32-x64`. Linux and Windows x64 use Bun's baseline builds
rather than requiring AVX2. Cross-compilation can download the selected runtime
at build time. Linux targets currently use glibc, not musl; platforms where the
binary cannot start can still use the Node fallback. A successful cross-build
does not establish runtime compatibility on that platform.

One macOS arm64 Helper is approximately 62 MiB uncompressed; the corresponding
XPI is approximately 28 MiB. Packing every target increases download and profile
cache size substantially. Prefer target-specific packages or deliberately select
the architectures to include. No new standalone package is published by this
work; an older downloaded XPI does not acquire a bundled runtime automatically.

## Selection, Integrity, and Compatibility

- The XPI contains `content/helper/standalone/manifest.json` with the Helper
  protocol version, pinned Bun version, exact platform/architecture, byte size,
  and SHA-256 of each binary. Wrong architectures are never selected as a guess.
- The plugin extracts only its matching bundled executable into
  `<Zotero profile>/claudero/helper/standalone/<protocol>-<sha256>/` using an atomic
  temporary write. It verifies size and SHA-256 on extraction and reuse, repairs
  damaged cached files, and applies owner-only directory/executable permissions
  on POSIX systems. Hashes detect corruption; they do not replace trust in the
  XPI's source or operating-system code signing.
- The plugin never downloads a runtime during startup. A missing, incompatible,
  corrupt, or non-launchable standalone Helper uses the existing Node script
  path when Node is installed. Failed started processes are cleaned up before
  fallback, and cancellation or plugin shutdown never triggers a new launch.
- The portable `.mjs` Helper remains bundled for fallback and the WSL bridge.
  Host-native Codex MCP starts the standalone executable itself, without treating
  it as a JavaScript interpreter. A Windows executable is not substituted for
  the Linux Node interpreter inside WSL.
- Compiled Helpers disable automatic `.env`, `bunfig.toml`, `tsconfig.json`, and
  `package.json` loading at runtime. The build does not inline environment values.
  Provider environment values continue to come from the existing explicit setup.
- Health and diagnostic responses identify the actual runtime kind, engine, and
  version. OS quarantine, library, or executable policy failures remain possible;
  Claudero does not bypass those policies or remove security attributes.
- The XPI preserves Bun's pinned upstream notice under `content/helper/licenses`.
  Bun embeds separately licensed JavaScriptCore/WebKit and other libraries.
  Before public distribution, review all required notices, source availability,
  and relinking obligations for the exact runtime; a local build and checksum
  verification are not a license-compliance certification.

## Verification

`test/standaloneHelper.node.ts` tests target selection, strict manifests, hash
verification/repair, atomic extraction, permissions, and provider runtime hints.
`test/standaloneStartup.node.ts` tests the actual Gecko client launch path with
no Node present, Node fallback after launch/health failure, no redundant
runtime-missing port loop, and shutdown during launch. Setup and Codex MCP tests
retain Node prerequisites for scripts, DeepSeek, and WSL.

`scripts/smoke-standalone-helper.mjs` builds native offline protocol fixtures and
runs the real compiled Helper with an empty PATH and isolated HOME. It checks
authentication/origins, the bundled Claude SDK, two persistent turns per provider,
Codex self-spawned MCP initialize/tools/authenticated reads, direct MCP stdio,
missing-Node guidance for a JS CLI, ignored workspace configuration, and graceful
shutdown. It separately verifies DeepSeek with an explicitly configured real
Node runtime. No provider account or external AI request is used. This proves local
protocol integration, not live provider authentication or model behavior.

CI is configured to build, inspect, and smoke-test standalone packages on macOS,
Linux, and Windows, after checking the portable path. Local execution during this
study is on macOS arm64; other platforms still require their CI results.

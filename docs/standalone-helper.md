# Standalone Helper

Standard production builds bundle the Helper and Bun runtime as platform-native
executables for macOS, Windows, and Linux, each on arm64 and x64.
This removes the separate Node.js installation requirement for the Helper and its
host-native Zotero MCP bridge. It preserves the Claude Agent SDK, Codex app-server,
permissions, and session behavior; it is not a rewrite of the provider runtimes.

## Runtime Requirements

| Installation                                  | Separate Node.js required?                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Standard XPI + native Claude Code             | No, for the Helper and provider launch                                            |
| Standard XPI + native Codex                   | No, including the built-in host MCP bridge                                        |
| Portable XPI or unsupported standalone target | Node.js 20+ for the Helper fallback                                               |
| npm/JavaScript Claude or Codex CLI            | Yes; Node must also be available in the provider's PATH                           |
| DeepSeek Harness                              | Yes, Node.js 24+ with the required TypeScript/Zstd APIs; install `dsh` separately |
| Codex inside WSL with Zotero MCP              | Node.js inside the selected WSL distribution for the portable MCP bridge          |
| Custom MCP server written for Node            | Whatever runtime that server requires                                             |
| Developing/building Claudero                  | Node.js 20+ and npm; npm installs the pinned Bun 1.4.2 build tool automatically   |

Native providers remain separate programs with their own authentication, model
access, and dependencies. Bundling Bun does not make every external program
Node-free. Prefer the provider's native installer when avoiding Node.js.

## Build Locally

The ordinary build includes all six targets. The pinned compiler is a development
dependency, installed locally by npm; no global Bun installation is necessary:

```sh
npm ci
npm run check:release
```

`npm run build` also bundles all six targets; `build:standalone` is an explicit
alias. Missing or incorrect compilers fail the build rather than silently
producing a Node-dependent standard package. Verification requires the expected
target set, both in build output and in the actual XPI.

For a smaller local package containing only the current host, select `host`:

```sh
CLAUDERO_HELPER_TARGETS=host npm run check:release
npm run test:helper:standalone
```

`CLAUDERO_BUN_PATH` can override the local pinned compiler without changing the
user's PATH (the override must also be Bun **1.4.2**):

```sh
CLAUDERO_BUN_PATH=/absolute/path/to/bun npm run build
```

The result is `.scaffold/build/claudero.xpi`. These commands only build and test
local files; they do not publish a plugin, tag Git, or upload artifacts.

`CLAUDERO_HELPER_TARGETS` selects comma-separated targets:

```sh
CLAUDERO_HELPER_TARGETS=darwin-arm64,darwin-x64 npm run check:release
```

Available targets are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`win32-arm64`, and `win32-x64`. Linux and Windows x64 use Bun's baseline builds
rather than requiring AVX2. Cross-compilation can download the selected runtime
at build time. Linux targets currently use glibc, not musl; platforms where the
binary cannot start can still use the Node fallback. When verifying a custom
target package separately, pass the same `CLAUDERO_HELPER_TARGETS` value to the
verifier. A successful cross-build does not establish runtime compatibility on
that platform.

One macOS arm64 Helper is approximately 62 MiB uncompressed; the corresponding
XPI is approximately 28 MiB. The standard six-target XPI is approximately 204 MiB,
keeping the existing single cross-platform download/update link
usable without Node. Only the host's matching runtime is extracted into the
profile cache. Targeted packages are suitable for local use, not the shared
cross-platform update channel. No new package is published by this work; an older
downloaded XPI does not acquire a bundled runtime automatically.

For an intentional lightweight Node-dependent package, use:

```sh
npm run check:portable
```

This runs `build:portable` and the verifier's explicit `--portable` mode. Normal
release verification rejects a portable package. `CLAUDERO_STANDALONE_HELPER=0`
also opts out at build time; it does not bypass normal release verification.
Development (`npm start`) and browser-test (`npm test`) builds skip native
compilation by default. `CLAUDERO_STANDALONE_HELPER=1` explicitly enables it in
those modes. Portable smoke tests deliberately use the lightweight build.

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
  An existing Node path preference stays on the child PATH for npm/script CLIs,
  DeepSeek, login, and custom tools. Explicit general/provider PATH overrides
  retain priority. DeepSeek installation uses that same configured environment
  and validates a real compatible Node before installing anything.
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

`npm run test:build` checks the default six-target policy, explicit portable and
host-only modes, development/test defaults, compiler pinning, and rejection of
incomplete/duplicate target sets.

`test/preferenceSetup.test.ts` runs the actual setup UI in Zotero with simulated
local discovery and no Node available. It checks that native Claude/Codex need
no Node-install actions, an explicit Helper check can succeed, and scripts,
DeepSeek, and portable packages retain prerequisite repair guidance. Opening the
pane never starts the Helper.

`scripts/smoke-standalone-helper.mjs` builds native offline protocol fixtures and
runs the real compiled Helper with an empty PATH and isolated HOME. It checks
authentication/origins, the bundled Claude SDK, two persistent turns per provider,
Codex self-spawned MCP initialize/tools/authenticated reads, direct MCP stdio,
missing-Node guidance for a JS CLI, ignored workspace configuration, and graceful
shutdown. It separately verifies DeepSeek with an explicitly configured real
Node runtime. No provider account or external AI request is used. This proves local
protocol integration, not live provider authentication or model behavior.

CI is configured to build, inspect, and smoke-test host-native packages on macOS,
Linux, and Windows after checking the explicit portable path. Linux additionally
builds and verifies the standard six-target XPI. npm provisions the pinned
compiler in CI and the existing release build, without a separate global-tool
setup step. Local execution is on macOS arm64; other platforms still require
their CI results.

# Magpie Study and Adoption

Reference: [yetone/magpie](https://github.com/yetone/magpie), inspected at
[`3b5a2f612d59158f20e0320cf750ffc68b76d94b`](https://github.com/yetone/magpie/tree/3b5a2f612d59158f20e0320cf750ffc68b76d94b).
This is an architectural study, not a copy of Magpie's gateway or UI.

## Adoption Checklist

| Order | Lesson                                            | Claudero improvement                                                                                           | Status |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ |
| 1     | One security boundary for every local route       | Validate request authority and browser origin in addition to bearer authentication; bound HTTP request parsing | Done   |
| 2     | Bound and validate streamed messages              | Validate event fields, limit each NDJSON frame, reject truncated or invalid streams                            | Done   |
| 3     | Tie stream lifetime to its consumer               | Honor writable backpressure and release waits on disconnect, cancellation, or timeout                          | Done   |
| 4     | Compare configuration by meaning                  | Ignore object-key order without ignoring real value changes or ordered arguments                               | Done   |
| 5     | A known secret stays secret wherever it reappears | Scrub configured credential values and credentials embedded in URLs from diagnostics                           | Done   |
| 6     | Users should not manage the application's runtime | Build a standalone Helper, prefer it when bundled, and retain the Node.js compatibility path                   | Done   |

## Sources and Boundaries

- Local HTTP security:
  [`internal/gateway/cors.go`](https://github.com/yetone/magpie/blob/3b5a2f612d59158f20e0320cf750ffc68b76d94b/internal/gateway/cors.go)
  and `lan.go`. Claudero continues to require a private bearer token on every
  route and never enables LAN sharing or permissive CORS.
- Streaming:
  [`internal/gateway/sse.go`](https://github.com/yetone/magpie/blob/3b5a2f612d59158f20e0320cf750ffc68b76d94b/internal/gateway/sse.go)
  bounds the parser and treats stream activity and completion explicitly.
  Claudero keeps its existing NDJSON protocol and request ownership.
- Semantic equality: `sameArgs` in
  [`internal/gateway/claude_subscription.go`](https://github.com/yetone/magpie/blob/3b5a2f612d59158f20e0320cf750ffc68b76d94b/internal/gateway/claude_subscription.go)
  compares decoded JSON rather than its formatting or object-key order.
- Privacy:
  [`internal/redact/known.go`](https://github.com/yetone/magpie/blob/3b5a2f612d59158f20e0320cf750ffc68b76d94b/internal/redact/known.go)
  remembers sensitive values in bounded memory. Claudero uses this idea only
  for diagnostics, not to rewrite research prompts or provider responses.
- Runtime ownership:
  [`internal/plugin/bun.go`](https://github.com/yetone/magpie/blob/3b5a2f612d59158f20e0320cf750ffc68b76d94b/internal/plugin/bun.go)
  pins and verifies Bun rather than requiring users to install Node.js.
  Magpie's core is Go; its JavaScript plugins still use Bun. Claudero should
  not claim that adopting this lesson removes all JavaScript runtimes.
- Maintenance: `docs/subsystems/README.md`, `docs/code-standards.md`, and
  `LESSONS.md` connect runtime contracts to regression tests and distinguish
  a successful build from evidence of real operation.

## Deliberately Not Adopted

- Product telemetry, automatic subscription discovery, account rotation, and
  background quota warm-up are not needed for a Zotero research assistant.
- Automatic provider fallback is unsafe after a tool may already have changed
  Zotero data. Partial output and completed side effects must remain visible;
  retry stays explicit.
- A Go rewrite of the existing Claude SDK, Codex session manager, permissions,
  and MCP bridge is not a small dependency cleanup. Preserve those contracts
  before considering a different implementation language.
- Claudero already has provider adapters, capability-driven UI, atomic
  conversation persistence, native session continuation, bounded traces,
  request ownership, and approval-gated Zotero writes. Do not duplicate them.

## Verification and Node.js Assessment

Implementation results, commands, runtime packaging details, and remaining
Node.js requirements are recorded here as each item is completed. No plugin
publication, remote deployment, branch creation, or provider credential changes
are part of this work.

### 1. Local HTTP Boundary

All Helper routes now require the correct loopback authority and reject foreign
web origins after checking the bearer token. Opaque Gecko origins still require
that token; no CORS access is granted. HTTP headers, header count, header-read
time, and request-body time are bounded. Malformed JSON and non-object bodies
return 400 rather than becoming internal errors. The Helper protocol version
changes so a plugin reload replaces an older process.

Verified with `test/helperServerSecurity.test.ts` and
`test/helperLifecycle.node.ts`: 7 passing tests, including literal Host headers,
foreign origins on health/diagnostics/shutdown, malformed bodies, parent death,
and auxiliary-process cancellation. `tsc --noEmit` also passes.

### 2. Bounded Event Protocol

The client validates every event variant and its nested fields before yielding
it to the UI. Each NDJSON frame is limited to 8 MiB of encoded UTF-8, using a
bounded geometrically growing buffer rather than an unbounded string or list of
tiny fragments. Invalid UTF-8 is rejected. A response can still contain many
valid frames and exceed 8 MiB in total. Existing request-ID, terminal-outcome,
truncation, and error-before-success checks remain in force.

Verified with `test/helperStream.test.ts`, `test/agentEvents.test.ts`,
`test/requestLifecycle.test.ts`, and `test/stream.test.ts`: 28 passing tests,
including split UTF-8, CRLF, oversized frames, malformed fields, late events,
reader cancellation, listener cleanup, and provider normalization. TypeScript
and targeted ESLint pass. The two new protocol suites are in `test:runtime`.

### 3. Writable Backpressure

Helper event writes are awaited. A full HTTP writable pauses consumption of the
provider iterator until `drain`, instead of accumulating more socket output.
Disconnects, cancellation, writable errors, and a 15-second drain timeout release
the wait and detach all temporary listeners. A stalled response is destroyed so
the existing request owner cancels its provider and permissions. Writers enforce
the same event validation and 8 MiB frame limit as readers. Terminal writes cannot
turn a failed/disconnected stream into success or skip provider cleanup.

Verified with `test/helperEventWriter.node.ts`, `test/helperStream.test.ts`, and
`test/helperLifecycle.node.ts`: 15 passing tests. TypeScript and targeted ESLint
pass. This bounds the HTTP output path; it does not claim that third-party SDK
internal queues obey transport-level backpressure.

### 4. Semantic Configuration

One canonical JSON utility compares nested object maps without depending on key
insertion order. Claude MCP configuration, Codex environment/MCP/session state,
DeepSeek environment, and permission scope/input keys use it. Ordered arrays
(including MCP command arguments) remain ordered. Real environment, endpoint,
session, CLI, or argument changes still trigger their existing restart or
approval invalidation behavior. Codex model/effort live updates stay live updates.

Verified with `test/configEquality.node.ts`, `test/permissionManager.test.ts`,
`test/runtimeEnvironment.test.ts`, `test/codexMcpConfig.test.ts`, and
`test/deepseekRuntime.node.ts`: 28 passing tests. TypeScript and targeted ESLint
pass. No live provider session or external credential is needed for these tests.

### 5. Diagnostic Secret Memory

Configured environment/MCP credentials and the Helper capability token seed an
in-memory diagnostic-only registry (8-4096 characters per value, at most 128
values and 64 Ki characters). Matching escapes regex metacharacters and prefers
longer overlapping values. URL userinfo is removed even for short passwords;
configured percent-encoded proxy passwords are remembered in both forms.
Collection and export sanitize values again, including object keys and circular
arrays. No prompt, research paragraph, or ordinary configuration string is learned
as a secret, and provider inputs/outputs are not rewritten.

Verified with privacy, Helper startup/lifecycle, and configuration regressions:
20 passing tests, including an actual authenticated Helper diagnostics request
whose workspace path repeats a configured opaque secret. TypeScript and targeted
ESLint pass. Very short/oversized or evicted credentials are still field/URL/
pattern-masked, but cannot be guaranteed masked as arbitrary unlabeled substrings.

### 6. Owned Standalone Runtime

An optional build compiles the existing Helper plus Bun 1.4.2 into a native
executable. The Gecko client selects its own OS/ABI, verifies a strict bundled
size/hash/version manifest, extracts atomically, and prefers that executable.
Failure to extract, launch, or become healthy retains the Node fallback without
creating a new process after cancellation. Missing runtimes no longer cause a
redundant 40-port launch loop. Health and diagnostics expose the runtime used.

Host-native Codex self-spawns the executable for its Zotero MCP bridge. The WSL
bridge retains its target Node script instead of trying to run a Windows binary
as a Linux interpreter. Claude's native executable runs directly through the
bundled SDK; JS/npm Claude gives an explicit remaining-Node prerequisite instead
of silently requiring an external Bun. DeepSeek still resolves and verifies a
real Node.js 24+ runtime. Setup distinguishes these cases.

Verified locally on macOS arm64 with an empty PATH and isolated HOME: authenticated
HTTP startup, two persistent Claude SDK turns, two persistent Codex turns, actual
Codex-spawned MCP initialization/tools/authenticated reads, direct MCP stdio, JS
CLI prerequisite guidance, ignored workspace config, and graceful shutdown. The
providers in this smoke are native offline protocol fixtures, not live accounts.
Packaging, Gecko launch/fallback/shutdown, setup, and WSL mapping have regression
tests. The package verifier checks both unpacked and actual XPI binary contents
against size and SHA-256; portable builds remain valid without Bun installed.

The current native binary is approximately 62 MiB; its XPI is approximately
28 MiB. CI adds standalone builds and offline smokes for macOS, Windows, and Linux;
only macOS arm64 execution is established locally. Build choices, limitations,
and the remaining dependencies are in [Standalone Helper](standalone-helper.md).

**Node.js conclusion:** the Helper's external Node dependency is removable for
a matching standalone package with native Claude/Codex. It is not honestly
removable for all configurations: DeepSeek, npm/script CLIs, Node-based custom
MCP servers, the WSL MCP bridge, and the development toolchain retain their own
requirements. This ships a controlled Bun runtime instead of deleting the need
for a JavaScript engine. No standalone release is published as part of the study.

### Consolidated Local Checks

- `npm run test:runtime`: 198 Mocha cases and 5 Node test cases pass.
- `npm run lint:check` and `tsc --noEmit`: pass.
- Portable `npm run check:release`, mock Helper communication, and all three
  evidence contract/golden/PDF-audit smokes: pass.
- `npm run build:standalone`, `node scripts/verify-release.mjs`, and
  `npm run test:helper:standalone`: pass on macOS arm64, including separate
  DeepSeek compatibility with an explicitly selected real Node runtime.
- The Zotero browser runner initially stops before application launch because
  the existing `contextMenu.test.ts` imports Node-only test modules. This is
  distinct from the passing runtime suites and is not counted as browser success.

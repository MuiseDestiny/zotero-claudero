# Magpie Study and Adoption

Reference: [yetone/magpie](https://github.com/yetone/magpie), inspected at
[`3b5a2f612d59158f20e0320cf750ffc68b76d94b`](https://github.com/yetone/magpie/tree/3b5a2f612d59158f20e0320cf750ffc68b76d94b).
This is an architectural study, not a copy of Magpie's gateway or UI.

## Adoption Checklist

| Order | Lesson                                            | Claudero improvement                                                                                           | Status  |
| ----- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| 1     | One security boundary for every local route       | Validate request authority and browser origin in addition to bearer authentication; bound HTTP request parsing | Done    |
| 2     | Bound and validate streamed messages              | Validate event fields, limit each NDJSON frame, reject truncated or invalid streams                            | Planned |
| 3     | Tie stream lifetime to its consumer               | Honor writable backpressure and release waits on disconnect, cancellation, or timeout                          | Planned |
| 4     | Compare configuration by meaning                  | Ignore object-key order without ignoring real value changes or ordered arguments                               | Planned |
| 5     | A known secret stays secret wherever it reappears | Scrub configured credential values and credentials embedded in URLs from diagnostics                           | Planned |
| 6     | Users should not manage the application's runtime | Build a standalone Helper, prefer it when bundled, and retain the Node.js compatibility path                   | Planned |

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

# Security Policy

## Supported Versions

Security fixes are applied to the latest released Claudero version. Preview and
release-candidate builds may receive fixes only through a newer preview build.

## Reporting a Vulnerability

Do not include credentials, private documents, Zotero data, or exploit details
in a public issue. Use GitHub's private vulnerability reporting page:

<https://github.com/MuiseDestiny/zotero-claudero/security/advisories/new>

If private reporting is unavailable, open a public issue requesting a private
contact channel without describing the vulnerability. Include the Claudero and
Zotero versions, operating system, affected provider, and whether the issue can
be reproduced with a clean Zotero profile.

## Security Boundaries

- The local helper accepts only explicit IPv4 or IPv6 loopback addresses and
  requires a per-profile bearer token.
- The Zotero endpoint keeps `allowRequestsFromUnsafeWebContent: true` because
  registered provider APIs depend on it. Every Claudero request must still
  present the per-profile capability token before dispatch.
- Provider CLIs and configured MCP servers run with their own permissions and
  may communicate with external services. Review their configuration and use
  the most restrictive Claudero permission mode that supports the task.
- Imported skills are disabled until reviewed. Academic skills default to
  read-only Zotero access.
- Diagnostic exports remove raw prompt, quote, tool-result, and credential
  values, but may still contain local paths, item identifiers, provider names,
  timing information, and sanitized error messages. Review a diagnostic file
  before sharing it.

See [PRIVACY.md](PRIVACY.md) for the data-flow and local-storage policy.

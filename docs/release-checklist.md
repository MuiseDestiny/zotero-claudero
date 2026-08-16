# Claudero Release Checklist

Use this checklist for every release candidate and stable release. A stable
release must not be published with an unchecked blocking item.

## Automated Gates

- [ ] `npm ci` completes on Node.js 24.
- [ ] `npm run lint:check` passes.
- [ ] `npm run check:release` builds and validates the XPI, manifest, update
      metadata, checksum, repository links, tracked files, and secret scan.
- [ ] `npm run audit:all` reports no high or critical dependency advisory.
- [ ] `npm run test:runtime` passes on Linux, macOS, and Windows.
- [ ] `npm run test:helper:mock` passes on Linux, macOS, and Windows.
- [ ] `npm run test:evidence:ci` passes.
- [ ] `npm test` passes in the Zotero browser-test job.
- [ ] All required GitHub Actions checks pass without retrying a flaky job.

## Clean-Profile Zotero Acceptance

- [ ] Install the generated XPI in a new profile on the minimum supported
      Zotero major version.
- [ ] Install the same XPI in a new profile on the maximum supported Zotero
      major version.
- [ ] Verify startup, pane open/close, Preferences, restart, disable/enable,
      update, and uninstall behavior.
- [ ] Verify light and dark themes at 100%, 125%, 150%, and 200% UI scale.
- [ ] Verify English and Simplified Chinese layouts with long model and file
      names.
- [ ] Confirm no existing Zotero item, note, annotation, attachment, or database
      data changes without an explicit approved write action.

## Provider Acceptance

Run each required row with a real authenticated CLI. DeepSeek may remain marked
Experimental when its rows are not release-blocking.

| Host    | Claude | Codex native | Codex WSL | DeepSeek |
| ------- | ------ | ------------ | --------- | -------- |
| Linux   | [ ]    | [ ]          | N/A       | [ ]      |
| macOS   | [ ]    | [ ]          | N/A       | [ ]      |
| Windows | [ ]    | [ ]          | [ ]       | [ ]      |

For every supported provider:

- [ ] Send, stream, cancel, retry, resume, fork, and reopen a saved conversation
      where supported.
- [ ] Exercise PDF context, evidence links, annotations, images, Zotero MCP, and
      one approved Zotero write where supported.
- [ ] Verify missing CLI, expired login, invalid API key, unreachable proxy,
      provider timeout, crashed process, and occupied helper-port errors.
- [ ] Verify executable and workspace paths containing spaces and non-ASCII
      characters.
- [ ] Confirm permission modes never grant a capability unsupported by the
      selected provider.

## Privacy And Security

- [ ] Confirm the helper rejects non-loopback hosts, missing/incorrect tokens,
      invalid ports, and oversized request bodies.
- [ ] Export diagnostics after using synthetic credentials and sensitive prompt
      text; confirm neither appears in the JSON.
- [ ] Review new environment variables, MCP headers, logs, and error messages for
      credential exposure.
- [ ] Review imported skills and Zotero write actions against the least-privilege
      defaults.
- [ ] Review [SECURITY.md](../SECURITY.md) and [PRIVACY.md](../PRIVACY.md) for
      changes in behavior.

## Release And Update

- [ ] Update `package.json`, `package-lock.json`, and `CHANGELOG.md` together.
- [ ] Use a tag that exactly matches the package version: `v<version>`.
- [ ] Confirm the Git worktree is clean and `main` contains the release commit.
- [ ] Publish a release candidate first when runtime, protocol, or storage code
      changed materially.
- [ ] Download the GitHub Release XPI and install that exact artifact in a clean
      profile.
- [ ] Verify the permanent `release/update.json` asset and an update from the
      previous public version.
- [ ] Keep the previous XPI available for rollback.
- [ ] Publish known limitations and identify experimental providers in the
      release notes.

## Stable Release Sign-Off

- [ ] No known P0 or P1 issue remains open.
- [ ] Required CI checks have passed on three consecutive `main` runs.
- [ ] Claude and Codex required platform rows are signed off.
- [ ] Clean install and automatic update are both verified using GitHub-hosted
      release artifacts.

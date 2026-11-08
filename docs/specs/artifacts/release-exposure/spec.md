# Release exposure audit

Pull request: https://github.com/morluto/rea/pull/8525

## Problem and outcome

REA can show what static analysis recovers from a shipped application, but a
developer who wants that answer for their own release has to run several tools
and combine the results by hand. Add one read-only audit that reads a single
shipped artifact through the existing readers and reports, per named check,
what was observed, so a team can review or gate a release before it ships.

## Requirements

- Accept one local `.app` bundle, install directory, ASAR or single executable
  through `audit_release_exposure` (MCP, absolute path) and
  `rea audit-release-exposure` (CLI, path resolved against the caller's working
  directory). Both adapters return the same report.
- Report a fixed set of checks, each with a stable id, a status of `exposed`,
  `not_observed`, `not_applicable`, `unknown` or `not_assessed`, the observation
  behind it, its locations and fixed remediation text. Severity is `null` unless
  the status is `exposed`.
- Report no pass verdict, score or grade. The report states that it does not
  establish that an application is secure, and `unknown` and `not_assessed`
  counts stay beside the findings.
- Compose existing owners: artifact inventory, Electron fuses, Go build info,
  cargo-auditable metadata, PE CodeView, embedded package classification and
  source-map parsing. Do not reimplement their parsing.
- Never execute, modify or rewrite the artifact, and make no network request.
- Bound every read. Inventory stops at 65,536 entries or 2 GiB of hashed bytes.
  Text, source-map and packaged-image reads have separate allowances reported
  under `coverage.allowances`; skipped members are listed under
  `coverage.omitted`. An exhausted bound leaves the affected checks `unknown`.
- Fail toward `unknown`: a read that could not be completed, a file or member
  whose bytes no longer match the inventoried digest, an unresolved or oversized
  source map, or missing metadata never becomes `not_observed`.
- For `text.credential_markers`, report the rule id and location only. Matched
  bytes, previews, lengths and hashes of matched bytes are omitted. Source-map
  text is counted and then dropped.
- Without `--fail_on`, the CLI exit status reflects only whether the audit
  finished. With `--fail_on high|medium|low`, a completed audit exits `3` when an
  `exposed` check meets that severity. A tool failure exits `1`.
- A declared integrity value that disagrees with the bytes is recorded as a
  limitation and the audit continues.
- Cancellation during a composed owner returns the typed cancellation error with
  the partial report attached.

## Acceptance

- Domain tests cover status aggregation, severity, `--fail_on` thresholds and the
  absence of a verdict.
- Reader tests cover source maps with and without `sourcesContent`, inline
  `data:` maps, HTML and SVG script loading, debug companions, credential markers
  in text members and binary plists, UTF-16 and NUL handling, read allowances,
  same-name package members, packaged native images and changed bytes after
  inventory, including an unpacked ASAR companion replaced after inventory.
- Service tests cover Electron fuse decisions, Go and Rust metadata, partial
  inventory and cancellation with a partial report.
- CLI and MCP return the same report; `--max-file-bytes` accepts the documented
  decimal token form.
- `npm run verify:release-exposure` audits real fixtures, recorded in
  [the verification record](../../../verification/release-exposure-2026-10-31.md).
- The [release exposure guide](../../../release-exposure.md) documents current
  behavior and limitations.

## Non-goals

Obfuscation, stripping, signing, active protection, modifying the artifact,
running the target, network calls and a security verdict. `native.hardening`,
`macho.hardened_runtime` and `android.manifest` stay `not_assessed` and name
their next probes instead.

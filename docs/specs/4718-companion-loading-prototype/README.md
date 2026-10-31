# Companion loading: inactive contract prototype

Related: [design PR #4970](https://github.com/morluto/rea/pull/4970) and
[issue #4718](https://github.com/morluto/rea/issues/4718).

Status: exploratory draft for discussion, **not integrated**. Maintainer decisions
on the loader, trusted profile source and installation ownership remain pending.
This directory is outside `package.json#files`; there is no production CLI/MCP
command, canonical skill edit, registered host adapter or installation writer.
Canonical byte verification is unchanged. The design PR remains separate.

The problem is that a companion-owned block changes REA's managed skill bytes.
This prototype explores returning checked local text from an explicit grant
instead of patching those bytes. It intentionally stops at the unresolved host
binding boundary required by CONTRIBUTING's fail-closed integration rule.

## Run the isolated experiment

Use an existing Node.js 24 runtime; no dependencies or install step are required:

```sh
node --test docs/specs/4718-companion-loading-prototype/prototype.test.mjs
```

The suite creates temporary packages, registries, hard links and directory links;
it removes only its own temporary fixtures. Windows needs permission to create
those fixtures. These Node tests are explicitly invoked experiments, outside the
normal Vitest discovery roots. They do not establish production CLI/MCP coverage.

## Values and ownership

`resolver.mjs` is a standalone experimental boundary, not a second production
filesystem abstraction. Integration would need to move the owning semantics into
the shared application/domain contracts, reuse `RegularFileRead` and the owned
regular-file primitives, and wire typed CLI/MCP consumers with boundary tests.
There are no shell, network, package execution, repair or write imports here.

An explicitly selected registry is a closed object with `schemaVersion: 1`,
`scope: {client, profileRoot, reaRoot}`, and at most eight `entries`. Each grant
contains exactly `id`, `root`, `manifest`, `manifestDigest`, `enabled` and
`delivery: "checked-text"`. Roots are normalized absolute local paths. The
client spelling is `codex` or `claude_code`; this is a manual fixture selection,
not evidence of support for either host. Shared roots never imply shared consent.
There is no default profile search, environment discovery or cross-profile fallback.

A publisher manifest contains exactly `schemaVersion: 1`, `id`, `version`,
`description`, `entrypoint`, `contract: "rea-companion-prototype-v1"`, and `files`,
a map of relative paths to lowercase SHA-256 digests. This identifier is an
experimental compatibility contract, **not an advertised REA capability**.
The entrypoint must be inventoried and the manifest cannot inventory itself.
Inventory entry text, references and package-owned helpers; mutable logs, caches
and updater state do not belong in that inventory. This prototype does not infer
or certify inventory completeness by scanning instruction links or dependencies.

`planRegistration` checks a selected installation and returns a complete next
registry plus an approval digest covering both its bytes and the prior registry
digest. New registrations default disabled; replacements preserve existing intent
unless the exact plan changes it. `approvePlan` returns bytes only after an exact
approval/current-input comparison. There is no persistence or transaction claim.
The caller must review content and scope; the hash is neither publisher identity
nor a substitute for consent. No existing setup, updater or weekly opt-in supplies
that approval. `planDisable` reads no package content and preserves repeated
disabled values byte-for-byte. Invalid/unknown schemas are refused unchanged.

`resolveManual` requires the exact selected scope, enabled grant, manifest digest
and explicit task relevance. It reads the complete inventory, checks hashes and
observed identities again, then returns the actual checked UTF-8 text with ID,
identity, root and relative-path provenance. Later text reads use the same
identity and an inventoried path. It does not execute helpers or grant tool,
network, spending or installation authority. Do not reopen unverified paths from
returned text. A requested reference is bounded just like entry text.

JSON is limited to 64 KiB and 32 nested levels, inventory to 64 files, individual
files/output to 256 KiB and total inventoried bytes to 1 MiB. These are deliberately
small experimental resource budgets, not measurements of released companion fit.
Instruction output is refused on overflow, never truncated. Duplicate decoded
JSON keys, unknown fields, traversal, drive/UNC/device paths in relative fields,
alternate streams, reserved names, case-colliding paths, nonregular files, hard
links and Node-visible directory links are rejected. Relative paths use ASCII
components to avoid Unicode normalization collisions in this initial experiment.

Snapshot and second-read checks detect observed replacements. They do not provide
an atomic snapshot across independent files or protect against malicious same-user
processes, every filesystem race, mount change, or every platform-specific reparse
type. Windows reparse-policy completeness remains unverified. The final text is
the checked buffer, not a later unchecked reopen. No automatic fallback loads
rejected content by skill name.

`health` separates canonical (`not-assessed`), desired consent, checked/suspended
content, manual-only binding and unassessed delivery. Enabled entries report
setup/update `suspended` because no adapter exists; disabled intent is `preserved`.
This is a report function, **not wired into actual setup, update or doctor**.
`resolveForHost` always returns `binding-unavailable`, even if supplied assertions
claim a trusted profile or fresh session. Static grants cannot prove delivery.

## Candidate canonical routing instruction

The following is proposed text only. It must not be copied into installed REA
bytes or generated bundles before the binding/delivery contract is settled:

> For a relevant task, use only a supported REA companion adapter that establishes
> the active client/profile, selected REA installation and executable, and registry
> from a trusted host source. Inspect approved routing metadata before selecting
> a relevant companion; resolve checked instructions and later inventoried text
> through the same approved identity and base directory. Do not execute discovery
> hooks, recursively reload instructions or repeat activation for an unchanged
> task/identity. An unavailable binding leaves automatic loading inactive. Report
> changed or rejected content and continue supported REA work without loading it
> through a fallback. Companion consent grants no additional tool authority.

No adapter currently enforces relevance or once-per-task behavior. The manual
experiment requires a relevance assertion and does not implement discovery,
recursion enforcement, native activation, caching or session control. Before
integration, metadata discovery also needs an approved bounded contract.

## Fixture-only migration

`migration.mjs` plans removal of one exact recognized marked block from the
**current** byte buffer. The fixture comes from the MIT-licensed companion's
[`integration/rea-companion.md`](https://github.com/ShadowSwaps/REA-Reconstruction-Companion/blob/4fff7d77163c0c153e3bb247c2f04c5a594ed447/integration/rea-companion.md).
Both exact LF and CRLF variants are recognized by digest. Surrounding bytes,
including BOM and newer REA text, remain unchanged. Customized, unmarked,
duplicate, missing or stale inputs are refused. The historical unmarked legacy
format is not migrated by this experiment.

Tests use a named `fixtureSchema: 1`, **not the released updater schema**. Every
state byte is preserved, including client alias, custom paths, backups, disabled
intent, weekly opt-in, cooldown and pending offer. Current inputs are returned as
backup values; there is no file replacement, rollback, updater-state conversion
or approval transfer. Registration remains disabled and uncreated, with canonical,
binding and pending-offer reassessment explicit. The companion installer remains
the proposed production writer/backup owner. Tests demonstrate stale-plan refusal
and interrupted package-update suspension; they do not prove an interrupted
multi-file migration transaction or recovery from failed writes/readback.

## Gates before an integration proposal

1. Maintainer agreement on the loading route, trusted profile/registry/executable
   source, ownership and reviewed-content consent contract.
2. One genuine pinned fresh-session adapter demonstration before any client
   support claim; separately verify every additional client. No host permissions
   or configuration are changed to manufacture that proof here.
3. Production typed contracts and bounded metadata discovery, owned read/cleanup
   semantics, durable registration/backup writes, setup/update/doctor reports,
   and companion-owned migration/recovery with exact canonical verification.
4. Full applicable static, documentation, regression, packaging and CI checks,
   including real host coverage. Prototype tests alone do not satisfy these gates.

Do not merge, enable or publish this prototype as a supported integration while
those gates remain unresolved. Human PR readiness is a separate declaration.

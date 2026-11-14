# Android UI discovery and action boundary

## Status and scope

Review-time specification of PR #3004, recorded on 2026-11-14 after its initial
implementation. This is not a claim that this specification preceded that work
or that historical design and verification steps occurred.

Observation tools are implemented on the branch. Input actions remain an
unregistered, unshipped source-tree proposal. This record does not supply the
[maintainer scope decision](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#contribution-scope)
required for expanded execution or mutation authority.

## Analyst problem

An analyst with an explicitly selected Android device and package needs to find
accessibility-exposed controls, distinguish duplicate labels and inspect their
state without guessing coordinates or treating an incomplete search as absence.
An optional action experiment must distinguish dispatch from application success
and must not silently repeat a mutation after uncertain transport or cleanup.

## Requirements

- **R1 — Explicit authority:** reuse the caller-selected adb and device serial.
  Require an operator-installed, operator-started UI Automator runner. Do not
  install, start, stop or replace that runner implicitly.
- **R2 — Observation contract:** expose `inspect_adb_ui`,
  `find_adb_ui_elements` and `wait_for_adb_ui` through the shared ADB service and
  CLI/MCP adapters. Keep the proposed action out of normal catalogs and packaging.
- **R3 — Identity and scope:** validate the full runner identity and requested
  package, display, window, snapshot and element selections. Every node must
  belong to its corresponding snapshot's package and windows. Retained pages
  must be labelled as retained, not current live observations.
- **R4 — Coverage:** retain examined coverage, limits and accessible-node facts.
  Derive clickable-ancestor links without choosing an ambiguous target for the
  caller. Incomplete coverage cannot establish absence or application idleness.
- **R5 — Transport and data:** send request bodies through private stdin/socket
  transport, not argument vectors. Preserve caller inputs and observed facts,
  excluding password-marked and explicitly sensitive text as documented. Respect
  fixed request, response and complete-capture budgets with actionable recovery.
- **R6 — Lifecycle:** serialize accepted device work and reconcile retained work
  before later ADB operations. Retain failed cleanup owners through retry. Keep
  cancellation, physical failures and validated observations separate, including
  during final acknowledgement and shutdown.
- **R7 — Experimental actions:** require explicit retained selections and fresh
  validation before input dispatch. Report dispatch and after-state separately.
  Unvalidated or response-less accepted completions remain unknown, carry a
  replay warning, and gate later actions until matching fresh inspection.

## Acceptance and verification

Public CLI/MCP and real-subprocess boundary tests must exercise scope mismatch,
retained paging, malformed replies, refused admission, cancellation before
dispatch and during finalization, lost acknowledgements, cleanup retry and replay
gates. Controlled native-boundary tests must distinguish proven no-start from
uncertain launch failure. Real Android and native-host runs are separate evidence
and must be reported with their actual scope; source tests do not establish them.
See [tasks](tasks.md) for current checks and remaining verification.

## Non-goals

No automatic target selection, background agent, dialog handler, emulator setup,
coordinate guessing, atomic UI transaction guarantee, accessibility completeness
claim, signing, protection recovery, or public action registration is added by
this specification. Custom-drawn and off-screen content can remain inaccessible.

## Owners

- [Usage and limitations](../../../guides/android/adb-ui-automation.md)
- [Named contracts](https://github.com/morluto/rea/blob/main/src/contracts/adb/adbUiToolContracts.ts)
- [Request and observation schemas](https://github.com/morluto/rea/blob/main/src/domain/adb/adbUiAnalysis.ts)
- [Implementation plan](plan.md) and [verification tasks](tasks.md)

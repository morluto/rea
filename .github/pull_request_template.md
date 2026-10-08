<!--
PR title: type(optional-scope): imperative outcome
The title becomes the squash-merge commit subject and generated changelog entry.
-->

## Summary

<!-- What user, agent, or maintainer problem does this solve? Link the issue
with "Fixes #123" when applicable. Keep the prior behavior, expected contract,
and new behavior understandable without private context. -->

## Problem and expected behavior

<!-- For fixes, give the smallest trigger and violated invariant. For features,
describe the use case and observable outcome. -->

## Change and scope

<!-- Explain the chosen approach, why it fits REA's architecture, and what is
intentionally not included. -->

## Contract and boundary impact

<!-- Complete the applicable lines; use "none" or "not applicable" explicitly. -->

- Semantic owner and earliest changed stage:
- CLI and MCP/tool-catalog contract:
- Provider, bridge, target-format, or platform compatibility:
- Evidence, artifact, provenance, or reconstruction contract:
- Process execution, authorization, cleanup, or containment impact:
- Generated metadata (`docs/public/product-catalog.json`), package, or installation impact (CI generates and validates ignored catalogs and `skills/`; edit authored instructions in `skill-src/` and never commit build outputs):

## Evidence and regression coverage

<!-- State whether evidence is executed, source-derived, or proposed. For fixes,
explain how the regression would fail on the affected base revision when practical. -->

- Tests added or updated:
- Base reproduction or other evidence:
- User-visible CLI/MCP output (if applicable):
- Remaining proof gaps:

For evidence-bearing changes:

- [ ] Observed, derived, and inferred claims remain distinguishable.
- [ ] Artifact identity, source provenance, and failed attempts remain preserved.
- [ ] Unsupported, incomplete, unavailable, or uncertain outcomes remain visible.

## Validation performed

<!-- List only commands that actually ran, with observed results. Include the
relevant real-provider or platform workflow, or explain why it was unavailable. -->

- `command` — result

## Compatibility, safety, and release

<!-- Call out breaking changes, migrations, package effects, platform/provider
limits, security/privacy/containment implications, and meaningful proof gaps. -->

- Breaking changes or migration steps:
  <!-- For ! / BREAKING CHANGE: show a previously valid call/configuration,
  its new behavior and migration, and why compatibility/deprecation cannot
  preserve it. Every release increments minor, including breaking changes;
  keep breaking markers and migration notes so callers can assess compatibility.
  See docs/releasing.md. -->
- Real Hopper/Ghidra, browser, or OS coverage:
- Package or release metadata impact:
- Security, privacy, process, or containment review:

## Review checklist

- [ ] The PR has one focused outcome and the title follows `type(scope): outcome`.
- [ ] Related issue is linked, or the reason for not linking one is stated above.
- [ ] Tests cover changed observable behavior and meaningful failure paths.
- [ ] Owning docs, contracts, and generated metadata are updated where needed.
- [ ] User-visible CLI/MCP changes include representative output.
- [ ] I checked the final diff for secrets, unrelated cleanup, and unsupported claims.

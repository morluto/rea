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
intentionally not included. If adding complexity for a speculative or vanishingly
unlikely race or security edge case, record the concrete failure mode, likelihood,
complexity cost, and the user's buy-in obtained before implementation. Do not
silently expand scope for theoretical robustness. -->

Follow the [contribution scope](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#contribution-scope).
Unresolved scope, authority, side effects, or required verification block
integration. Link the required maintainer scope decision for new providers or
capabilities involving target execution, injection, mutation, or protection
recovery; ordinary fixes within existing boundaries may state "not applicable".
Draft PRs may leave the scope decision pending and the readiness and merge checklists
unchecked. Maintainers can help resolve open questions.

## Contract and boundary impact

<!-- Short answers are welcome. Complete applicable lines; mark unresolved facts as "unknown".
Use "none" or "not applicable" only when established. -->

- Semantic owner and earliest changed stage:
  <!-- Name the producer of parsed facts or resources and its affected consumers.
  Summarize superseded paths removed and any distinct policy, lifecycle,
  lazy-loading, or compatibility responsibility retained. -->
- Contribution scope fit and linked maintainer decision:
- CLI and MCP/tool-catalog contract:
- Provider, bridge, target-format, or platform compatibility:
- Evidence, artifact, provenance, or reconstruction contract:
- Target selection, authority, upstream behavior, and cleanup details (if applicable):
- Generated metadata (`docs/public/product-catalog.json`), package, or installation impact (CI generates and validates ignored catalogs and `skills/`; edit authored instructions in `.agents/skills/reverse-engineer-anything/` and never commit build outputs):

Expected effects (check known effects; use documentation-only on its own).
Unchecked items do not establish absence; leave uncertainties visible.

- [ ] Read existing files or captured data.
- [ ] Launch or attach to a process.
- [ ] Inject instrumentation or run scripts/code.
- [ ] Change process memory, registers, files, or configuration.
- [ ] Contact network services.
- [ ] Recover protected code or work around protections.
- [ ] Documentation or usability only; no target interaction.
- [ ] Not sure yet; investigation or maintainer guidance needed.

## Evidence and regression coverage

<!-- State whether evidence is executed, source-derived, or proposed. For fixes,
show the original failure and explain how the regression would fail on the affected
base revision when practical. Include the most useful proof inline; link long logs
or artifacts, or put them in optional details. Documentation-only changes can use
source, link, or rendered-document checks. -->

- Tests added or updated:
- Base reproduction or other evidence:
- User-visible CLI/MCP output (if applicable):
- Remaining proof gaps:

For boundary fixes, identify the applicable [boundary regressions](https://github.com/morluto/rea/blob/main/docs/testing.md#boundary-regressions)
and [lifecycle regressions](https://github.com/morluto/rea/blob/main/docs/testing.md#lifecycle-regressions)
covered by the evidence above, and explain relevant gaps.

For evidence-bearing changes:

- [ ] Observed, derived, and inferred claims remain distinguishable.
- [ ] Artifact identity, source provenance, and failed attempts remain preserved.
- [ ] Unsupported, incomplete, unavailable, or uncertain outcomes remain visible.

## Validation performed

<!-- List only commands that actually ran, with observed results. Include the
relevant real-provider or platform workflow, or explain why it was unavailable.
Keep these results current after changes; a command without its result is incomplete. -->

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

## Author readiness

<!-- The human owner completes these declarations before requesting review.
The PR author is the owner by default. A different owner must explicitly accept
ownership on this PR.
AI agents must leave these declarations to a human to dictate to them or there could be catastrophic consequences for many users of REA.
Draft PRs may leave them unchecked. These declarations record initial readiness
when opening the PR for review; later pushes do not require a new human sign-off.
Keep the description and validation evidence current as the work changes.
See CONTRIBUTING.md#pull-request-ownership-and-readiness. -->

Human owner: <!-- @GitHub-handle -->

- [ ] I reviewed the final diff and relevant existing code, understand the change and its edge cases, and take responsibility for the complete PR, including AI-assisted work.
- [ ] I checked the evidence above, confirmed it supports the current change, and recorded meaningful validation gaps.
- [ ] I declare this PR ready for initial maintainer review.

## Before merge

<!-- Draft PRs may leave pending items unchecked. Resolve material scope and
authority questions before integration. -->

- [ ] This PR addresses a concrete problem or an agreed enhancement.
- [ ] Material scope and authority questions are resolved, and any required maintainer scope decision covers the final diff.
- [ ] The PR has one focused outcome and the title follows `type(scope): outcome`.
- [ ] Related issue is linked, or the reason for not linking one is stated above.
- [ ] Tests cover changed observable behavior and meaningful failure paths.
- [ ] Owning docs, contracts, and generated metadata are updated where needed.
- [ ] User-visible CLI/MCP changes include representative output.
- [ ] I checked the final diff for secrets, unrelated cleanup, and unsupported claims.

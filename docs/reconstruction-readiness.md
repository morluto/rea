# Reconstruction readiness conformance

Run the source-owned native, JavaScript CLI, Electron, Evidence, comparison,
obligation, replay, and cleanup conformance verifier from a clean checkout:

```sh
npm ci
npm run verify:readiness
```

The command builds the redistributable native conformance fixtures, inventories
the native executable through the public CLI, analyzes the generated JavaScript
CLI and Electron fixtures through both CLI and MCP, evaluates an internal
nine-stage conformance report, and proves stale/tampered replay rejection. The
report evaluator is part of the repository verifier, not a public REA tool. It
prints one compact JSON summary.

Set `REA_READINESS_REPORT_PATH` to retain the complete machine-readable report:

```sh
REA_READINESS_REPORT_PATH=readiness-report.json npm run verify:readiness
```

CI runs this command on Linux, publishes the compact summary, and retains the
full report as the `reconstruction-readiness` artifact.

## Project conformance contract

The verifier runs as `npm run verify:readiness`; it is not exposed as a public
CLI command or MCP tool. The synthetic report input and evaluator exist to
check project-owned conformance fixtures and fail-closed report behavior.

## Required stages

| Stage                           | Required proof                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `discover-classify`             | target-free startup, artifact inventory, compatible workflow selection, and exact visible limits                      |
| `diagnose-environment`          | broken runtime separated from analysis failure, version skew detected, and revision changed after recovery            |
| `declare-request`               | exact target, operation, and lifecycle are carried by the request before launch                                       |
| `static-analysis`               | native and JavaScript routing plus preserved ambiguity, truncation, unsupported syntax, and residual unknowns         |
| `reactive-scenarios`            | predicate-driven interaction, descendant settlement, Electron correlation, and cancellation cleanup Evidence          |
| `compare-authority-candidate`   | explicit partial-order/finite-trace semantics, primary divergence localization, and unknown for incomplete comparison |
| `preserve-contradictions`       | record-and-continue, affected equivalence blocked, and unaffected comparison retained                                 |
| `verify-reconstruction-closure` | incomplete reconstruction detected, incremental verifier closure, and authority-delegating candidates rejected        |
| `export-replay`                 | CLI/MCP parity, process/structured failure parity, deterministic replay, tamper rejection, and stale-input rejection  |

Every stage and required check must occur exactly once and link to Evidence in
the embedded Evidence bundle. `fail`, `unknown`, `unsupported`, `truncated`,
and `skipped` never aggregate to `pass`.

## Fail-closed rules

The evaluator rejects or withholds readiness when:

- a bounded capability omits its effective numeric limits;
- a fixture lacks exactly one compatible selected workflow;
- an incompatible or unavailable provider was invoked;
- a typed CLI failure exits zero, or an MCP failure reports success;
- concurrent behavior uses total-order comparison;
- truncation, instability, unavailable authority, or contradiction is labeled
  equivalent;
- a deliberate primary divergence is not localized;
- contradiction Evidence or its affected comparison is missing;
- the reconstruction obligation ledger is not `ready`, has no required
  obligation, or retains an unowned/unverified required obligation;
- a process exceeds its declared target/lifecycle, cancellation loses diagnostics, or owned
  resources remain;
- replay is nondeterministic, tampering/staleness is not detected, or the
  expected source digest differs.

Each finding names its stage, stable reason code, Evidence IDs, and detail.
Stage `capability_issue` and `next_action` fields map unsupported or failing
work to the responsible capability and remediation without claiming that the
requested analysis ran.

## Fixtures

The verifier uses only source-owned, redistributable fixtures:

- `tests/conformance` native executables with stable symbols and deliberate
  version divergence;
- `tests/conformance/readiness/javascript-cli`, which exposes prompts,
  alternate-screen behavior, configuration precedence, child process,
  persistence, loopback HTTP, and signal teardown to static reconstruction;
- `tests/conformance/readiness/electron`, which exposes main, preload,
  renderer, utility, IPC, renderer restart, blocked shell effect, and deep-link
  surfaces;
- the shared incomplete reconstruction and broken-runtime observations in
  `RECONSTRUCTION_READINESS_EXAMPLE`.

The synthetic example is a public typed input, not a global equivalence claim.
It demonstrates that every deliberate fault remains represented in the final
report and that only comparable Evidence can close the associated obligation.

<!-- 密级: 公开；course open-source project evidence only. -->

# Team review feedback and combined verification — 2026-10-31

This candidate brings the three issue implementations and their review corrections onto `codex/review-feedback-20261031`. It is a review candidate; human review and authorization to merge remain pending.

- Fixed main base: `746a41937d0c05fc8c53872c56f663b8b8f90b62`.
- Tested code commit: `031e6a7be0303b5f6924f251ffb300d10bdf432e`. A later report-only commit may be the branch tip; the executable and test sources must remain identical to this code commit.
- Related upstream issues: [#6045](https://github.com/morluto/rea/issues/6045), [#6216](https://github.com/morluto/rea/issues/6216), [#6226](https://github.com/morluto/rea/issues/6226).
- Existing team discussions: [PR #1](https://github.com/Yamamoto789/rea-oss-project/pull/1), [PR #2](https://github.com/Yamamoto789/rea-oss-project/pull/2), [PR #3](https://github.com/Yamamoto789/rea-oss-project/pull/3). Their targets are the individual `fix/*` branches, not main. These PRs were Draft/open/unmerged at the start of this review.

## Changes and feedback disposition

| Area                      | Verified problem or gap                                                                | Candidate behavior                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot ownership        | A failed descriptor close must remain owned and retryable on the same session          | Session-owned file scopes retain failed cleanup, gate replacement through both open entry points, and allow `close_binary` recovery                                               |
| Snapshot error precedence | Final cleanup must not erase the read/parse/integrity error or caller cancellation     | Keep the primary outcome and opaque caller reason through native and streaming read completion                                                                                    |
| Large-input regression    | Deep equality of two large Buffers exhausts a bounded test heap                        | Exact `Buffer.equals` comparison retains byte equality without per-index assertion expansion; historical bounded-heap RED/GREEN evidence is retained separately                   |
| Transport shutdown        | Two cleanup owners were both attempted, but only one rejection was logged              | `allSettled` records every rejected cleanup; the regression uses the actual transport close callback                                                                              |
| Replacement coverage      | `open_bundle_resources` already gated pending cleanup but lacked explicit coverage     | Public MCP regression checks operation, retained resource and `close_binary` remediation; lifecycle docs name both entry points                                                   |
| Node 22 compatibility     | The same cancellation case failed on the exact old PR base and head                    | Normalize only this JSON pipeline's own AbortError wrapper; physical-read failures still take precedence. This is inherited compatibility work, not a newly introduced PR failure |
| ADB verdicts              | Missing stdout verdict must remain unknown; mixed stdout failure must win              | Preserve uncertainty and explicit failure precedence. Extend empty/nonzero install/uninstall coverage, multibyte stdout byte counts and exact nonzero owner diagnostics           |
| Native handoffs           | Incoming traversal must preserve known add-on exports; final Evidence must stay scoped | Keep the known exports and exact export IDs, and require parent+A Evidence for incoming/outgoing or parent+A+B for both in the two-add-on fixture                                 |

The ADB feedback does not expand the public schema: zero-exit unknown results expose their existing captured stdout/stderr and stdout byte count; nonzero-without-verdict tests read both original streams and both byte counts through the existing command-owner reader. Success results are checked against their own existing fields.

No new provider, target-execution authority, native loading or public CLI/MCP schema is introduced by the feedback increment. Real subprocess fixtures are used where stated; inert native bytes and simulated Evidence do not establish real-provider success.

## Executed verification

Host: macOS 27.0.1 arm64. Primary toolchain: Node 24.18.0 / npm 11.16.0. Comparison runtime: Node 22.23.2.

| Scope                                                  | Result                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Unmodified main baseline: 17 existing selected files   | 323 passed, 2 Windows-only skipped                                                                                       |
| Combined candidate: all 22 selected files on Node 24   | 396 passed, 2 Windows-only skipped                                                                                       |
| Combined candidate: import-graph affected source suite | 2,079 passed, 111 files                                                                                                  |
| Combined candidate: 13 Snapshot files on Node 22       | 185 passed, 2 Windows-only skipped                                                                                       |
| `npm run check`                                        | Passed; cached tasks reused and lint warnings retained                                                                   |
| `npm run docs:check`                                   | Passed, including 9 README conformance tests                                                                             |
| `npm run verify:test-discovery`                        | 2,086 files, each discovered once; discovery is not execution                                                            |
| Source provenance                                      | All 27 changed files equal their corresponding final issue-branch candidates; original authors and source refs preserved |

The affected-source suite overlaps the explicit selections. These counts must not be added together as a unique test total.

First sandbox runs failed: baseline had 7 failures and combined selection had 9. Logs contained Swift module-cache permission failures and related missing MCP results. The exact selections passed under approved normal macOS permissions without any intervening source edits. Both failed and successful logs are retained locally; these were not hidden or counted as production fixes. No compiler/SDK installation or system setting was changed.

### Reproduce the final selections

Use the repository-pinned toolchain and locked dependencies (`npm ci`). Run from the checkout root at the fixed code commit, or at a report-only descendant with unchanged executable/test sources.

Node 24 combined selection:

```sh
npm run test:focused -- \
  tests/process-global/analysisSnapshotCloseMcp.test.ts \
  tests/process-global/analysisSnapshotRecoveryMcp.test.ts \
  tests/process-global/analysisSnapshotFinalization.test.ts \
  tests/boundary/filesystem/analysisSnapshot.test.ts \
  tests/boundary/filesystem/analysisSnapshotInput.test.ts \
  tests/boundary/filesystem/regularFileCancellation.test.ts \
  tests/boundary/filesystem/jsonFileResourceOwnership.test.ts \
  tests/composition/analysis-sessions/binarySessionCleanupRetry.test.ts \
  tests/composition/directAnalysisCleanup.test.ts \
  tests/boundary/mcp/sessionMcp.test.ts \
  tests/boundary/filesystem/directAnalysisSnapshotReplay.test.ts \
  src/server/shutdownRegistration.test.ts \
  tests/boundary/mcp/sessionResourceShutdown.test.ts \
  src/adb/AdbShellOutput.test.ts \
  src/adb/AdbProvider.test.ts \
  src/adb/AdbCommand.test.ts \
  tests/boundary/cli/adbCli.test.ts \
  tests/boundary/mcp/adbMcp.test.ts \
  tests/boundary/mcp/javascriptNativeHandoffIdentity.test.ts \
  tests/boundary/javascript/nativeTypeBindings.test.ts \
  tests/boundary/filesystem/javascriptApplicationWorkflows.test.ts \
  tests/boundary/cli/javascriptNativeHandoffSelection.test.ts
```

Additional checks:

```sh
npm run test:changed -- --base 746a41937d0c05fc8c53872c56f663b8b8f90b62
npm run check
npm run docs:check
npm run verify:test-discovery
```

For the recorded source run, `team/main` resolved to that exact base. The explicit commit above avoids base drift.

Node 22.23.2 Snapshot comparison (after the focused build has prepared the same candidate):

```sh
node node_modules/vitest/vitest.mjs run \
  tests/process-global/analysisSnapshotCloseMcp.test.ts \
  tests/process-global/analysisSnapshotRecoveryMcp.test.ts \
  tests/process-global/analysisSnapshotFinalization.test.ts \
  tests/boundary/filesystem/analysisSnapshot.test.ts \
  tests/boundary/filesystem/analysisSnapshotInput.test.ts \
  tests/boundary/filesystem/regularFileCancellation.test.ts \
  tests/boundary/filesystem/jsonFileResourceOwnership.test.ts \
  tests/composition/analysis-sessions/binarySessionCleanupRetry.test.ts \
  tests/composition/directAnalysisCleanup.test.ts \
  tests/boundary/mcp/sessionMcp.test.ts \
  tests/boundary/filesystem/directAnalysisSnapshotReplay.test.ts \
  src/server/shutdownRegistration.test.ts \
  tests/boundary/mcp/sessionResourceShutdown.test.ts \
  --coverage.enabled=false
```

## Provenance and review focus

The following 13 commits were replayed with `cherry-pick -x`. Original author identity/date and source SHA are preserved; source branches were not rewritten. Cherry-picking creates new commit IDs on the combined history.

| Original commit | Review-branch commit | Change                                                                    |
| --------------- | -------------------- | ------------------------------------------------------------------------- |
| `c072f1132b9f`  | `92d7dea91e98`       | fix(snapshot): report retained snapshot descriptors as incomplete cleanup |
| `64844013190f`  | `e874c8aaf4cc`       | fix(snapshot): retain session file cleanup and primary failures           |
| `24a83fdfcf4f`  | `caaef6adc38f`       | fix(snapshot): keep decoded primaries and opaque abort reasons            |
| `22d466fa6c34`  | `828ba995ea7c`       | fix(json): preserve pipeline cancellation reasons on Node 22              |
| `5a10910f8f80`  | `ec2616d6e8ea`       | fix(snapshot): bound regression assertions and report all close failures  |
| `e09c5a4c49c5`  | `4322f609a9b9`       | fix(adb): keep package changes without a verdict unknown                  |
| `39eb8225555d`  | `3a6a3c125dc7`       | fix(adb): prioritize explicit package failure over success                |
| `d2fa2bc69656`  | `a8c78ede34a0`       | test(adb): cover empty output and multibyte verdict diagnostics           |
| `7a0c03cd50a2`  | `8a9ac1d635e1`       | test(adb): assert exact nonzero command diagnostics                       |
| `aed6a54efa07`  | `03412861c971`       | fix(javascript): keep requested add-on exports in incoming traces         |
| `2c90f8cef34b`  | `863bccea9577`       | test(javascript): verify native handoff selection through CLI             |
| `61bad42ba330`  | `23ba81a42bb9`       | test(javascript): assert exact export node IDs for the selected add-on    |
| `4f5409ec3cbf`  | `031e6a7be030`       | test(javascript): require exact reachable evidence links                  |

Reviewers should trace the actual file/JSON/session owners, primary-error precedence, both shutdown paths, ADB unknown/mixed verdicts and raw nonzero diagnostics, and exact native export/Evidence identities. Review comments and `COMMENTED` reviews are not `APPROVED` or a merge.

The earlier independent review found a nonzero ADB assertion gap. The final candidate includes its correction: exact stdout/stderr, both byte counts, exit/signal/killed/truncation, with multibyte text in both streams. The combined 22-file run includes that assertion. Human review of this final candidate is still required.

## Limitations and next step

- Full repository `check:pr`/coverage, final Linux/Windows lanes, connected Android devices and real native-analysis providers were not run in this round. Windows-only cases remain skipped.
- No upstream acceptance, CI pass, release or deployment is claimed.
- Automated inspection and passing tests do not substitute for human readiness or merge authorization.
- Teammates should inspect the fixed combined diff and evidence, request changes as needed, then validate the exact revision intended for main. This branch is not authorization to merge.

# Windows runtime admission retry verification

Scope: [#2257](https://github.com/morluto/rea/issues/2257). Related initial
diagnosis: [#2266](https://github.com/morluto/rea/pull/2266).

## Revisions and real input

The baseline is `4f4f6cd7b5d7a400b90772a138d7b9f942c2a556`.
The candidate was developed from
`4773c152bc5f299fa682575bb8d1efea7587c7bc`; relevant runtime, native and
dependency-lock sources are identical between those two revisions.
These measurements precede integration of subsequent main changes.

The host ran Windows 11 10.0.22631.0, official Windows x64 Node 24.18.0,
and locked production dependencies. The real application input was the official
npm 11.16.0 launcher distribution's `bin` directory. REA inspected that source;
it did not execute the application as an analysis target. Runtime copies,
raw replies and test executables remain outside the checkout. No IDA or Ghidra
engine was involved in this native-runtime verification.

## Correctness and recovery

A test-owned directory handle requesting `FILE_ADD_FILE` produced an actual
kernel sharing violation (Win32 32) during native runtime-parent admission.
Releasing that handle restored admission. Before the fix, public CLI analysis
reported a permanent `unsupported_provider` failure with `retryable: false`.
The corrected CLI preserves `capability_unavailable` and the reason, with
`category: unavailable` and `retryable: true`.

Normal CLI analysis and post-conflict recovery produced the same canonical
normalized result before and after the correction: 535,733 compact JSON bytes,
SHA-256 `a24d3c2d9897cccc5ba70e9ee4dce03da88f033a939fe87457136fc5b3a3e2db`.
The complete successful CLI reply remained 537,124 bytes.

A single real SDK 2.3.1 stdio MCP connection first completed analysis, then
encountered the same kernel conflict after native authority caching, then
recovered successfully when the handle was released. Its final receipt passed
and found no residual runtime directories. The native producer supplies
`runtimeAllocation: "not-started"` only when parent admission failed before
directory creation. The adapter requires that fact and exact numeric codes
32/33; permission failures, opaque error text and unknown allocation state
remain nonretryable. Incomplete cleanup also prevents retry.

The native verifier additionally reproduces a real sharing conflict using an
owned runtime's DELETE lease, verifies the original error and allocation fact,
and confirms no child directory was allocated. This case runs unconditionally
in the Windows native verifier, without the optional process-boundary fixture.
The full verifier passed with 20 positive controls. Its optional independently
built process-boundary fixture was not supplied in this run.

The related focused suite passed 99 tests across seven files, including worker
ownership, cancellation, cleanup, error projection, loader behavior and adapter
boundaries. Source-map and WABT acquisition-failure tests use injected failures;
they establish disposition propagation, not real engine execution.

Thirty baseline native self-tests passed with no residual directories.
Win32 5 from #1701/#2196 was not reproduced on this host; these results do not
establish its cause or resolution.

## Delivery and resource measurements

One final same-connection MCP trial used one CPU per Node process, BelowNormal
priority, a 512 MiB client heap setting and a 768 MiB server heap setting.
Heap settings do not bound total process or family memory.

| Stage                              | Observed wall time | Serialized reply bytes |
| ---------------------------------- | -----------------: | ---------------------: |
| Connect                            |          11,351 ms |           Not recorded |
| Complete tool discovery, 187 tools |             744 ms |              2,498,686 |
| Normal analysis                    |          12,887 ms |              1,126,797 |
| Sharing failure                    |             265 ms |                    878 |
| Recovery on the same connection    |           5,578 ms |              1,126,797 |

The earlier warm failure reply was 1,218 bytes. Successful reply sizes and the
catalogue digest were unchanged within the tested source comparison:
`7bdadddc909f4b2b093f0b3da9f79fafdac879c9d3c147938b8fbce1b52cd726`.
These are delivery bytes, not model tokens. Model-visible discovery handling,
actual model token usage and total model task cost were not measured.

A targeted process-generation sampler collected 343 observations over
35,630 ms. Its aggregate observed CPU time was a **lower bound** of 26,766 ms:
process exits can hide the final CPU tail. Its peak sampled working-set sum was
727,244,800 bytes (about 694 MiB). This is a sampled sum, can double-count shared
pages and is not an exact physical-memory peak. Only the test-owned Node and
directory-holder processes were included; the observer itself was excluded.

This is one controlled functional trial, with no paired CPU/memory baseline.
Cold/warm filesystem caches and host noise were not normalized. No speedup,
CPU reduction, memory reduction or model-token savings are claimed. The change
adds no analysis retry loop or cache and performs no additional engine calls.
Existing successful native authority caching remains intact; failed readiness
is retried by a later caller attempt. Retry becomes useful advice only after
the transient condition clears and cleanup permits another attempt.

## Integration replay

After rebasing onto main `a2d8b94dd`, runtime candidate
`2c7a09eaf3ffe26667b40081f1cf0fd2ce44a146` again passed the 99 related tests,
static and documentation gates, real Windows CLI and same-connection MCP
normal/conflict/recovery sequence. Both workflows found no residual directories;
the CLI normalized-result digest above still matched. The MCP success and error
reply sizes remained 1,126,797 and 878 bytes respectively. Upstream Android/SAZ
contract changes increased complete discovery to 2,517,904 bytes, digest
`d14588eab7404ad129907eb34a45a0db0d43233c4de829f76babd59723bed199`.
This later catalogue is not evidence of a delivery-size change caused by the
runtime-admission fix. Resource sampling above belongs to the earlier pinned
candidate; aggregate resources were not resampled for this integration replay.

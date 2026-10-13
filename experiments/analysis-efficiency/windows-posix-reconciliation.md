# Windows reconciliation of recorded POSIX paths

Follow-up to [#2422](https://github.com/morluto/rea/pull/2422), including
@Aurantium-47's diagnosis of the host-dependent relative-path operation.

## Source pins and real data

The initial reproduction and passive producer used main
fa4b8288655188426222773ead2ccbdaf76334fd. Before branching, main was updated
to 8b181716aca2cb467be499cba226abfb5ae19141. The owning matcher and its
affected reconciliation consumers were unchanged between those revisions.
The newer baseline again reproduced both errors on the real Windows host.

Input: npm 11.16.0's published lib/utils/validate-lockfile.js, 1,023 bytes,
SHA-256 2295e2dac1c5816e1eae2d417804960ebbef17b64a0a44db4f3483ce6e6d9526.
The installed copy was independently checked against the exact module in the
[official registry package](https://registry.npmjs.org/npm/11.16.0).
The 2,945,850-byte tarball matched its published SHA-512 SRI before reading
that member; no archive extraction or installation occurred, and the tarball
was not retained.

Two actual Linux filesystem directories, Runtime/App and Runtime/app,
held byte-identical module copies and had distinct directory identities.
A controlled Node 24.18.0 process loaded the public module and ran its real
function against 587 locked dependency records: compatible trees returned zero
errors, and one controlled version mismatch returned one error. A passive REA
Inspector capture recorded 114 loaded scripts, including the selected module.
The provider did not evaluate, pause, resume or read source. The owned process
exited normally. Function execution is established by the harness receipt;
REA's passive script metadata establishes loaded status.

Production static analysis inspected both directories plus an independent
Static/public-module copy. The latter prevents implicit root matching from
hiding the explicit mapping result. Complete static/runtime Evidence was then
consumed by the actual **Windows** CLI and SDK 2.3.1 stdio MCP server, using
Windows 11 10.0.22631.0 and official Windows x64 Node 24.18.0.
No Electron GUI, IDA or Ghidra engine was used.

## Correctness and provenance

| Windows reconciliation                 | Baseline                       | Candidate                           |
| -------------------------------------- | ------------------------------ | ----------------------------------- |
| Exact POSIX input root                 | Matched, artifact path         | Same complete normalized result     |
| Case-mismatched POSIX input root       | Incorrectly matched and loaded | Unknown; static load states unknown |
| Exact explicit POSIX mapping           | Matched, operator file mapping | Same complete normalized result     |
| Case-mismatched explicit POSIX mapping | Incorrectly matched and loaded | Unknown; static load states unknown |

All four CLI and same-connection MCP normalized results agree. The input
Evidence, recorded runtime facts and caller-selected root spellings are
preserved. Rejected location membership does not establish that a module was
absent or unexecuted. The operation remains offline and performs no target or
filesystem inspection.

The shared matcher now chooses posix.relative after identifying POSIX input;
Windows coordinates continue to use win32.relative. Both location matching
and active-layer scope use this owner. The obsolete host-default import is
removed; no downstream repair or new path abstraction is introduced.

The related suite passed 102 tests: 15 workflow tests, 85 CI scope tests and
two curated-path checks. Four simulated Electron Evidence controls cover
POSIX mismatch/exact matching, Windows case-insensitive matching, the resulting
asset load state and retained mapping spelling. They are service regressions,
not real Electron-provider verification. The existing workflow test file is
registered in both the Windows execution lane and its package-change scope.

## Delivery and resource observations

Probes ran serially at BelowNormal priority with one CPU and 512 MiB Node heap
settings for CLI/server/client work. Heap settings do not bound aggregate memory.
Four corrected CLI exit-time observations reported 7.343–15.827 seconds CPU and
322,308–324,280 KiB peak working set, excluding the probe parent. Wall times
ranged from 7.785 to 17.601 seconds. There is no paired resource baseline.

One complete MCP trial connected in 18,296 ms and discovered 189 tools in
875 ms (2,588,336 serialized bytes). The four subsequent same-connection calls
took 879, 320, 353 and 422 ms. Their serialized replies were 918,133 / 913,765 /
918,571 / 914,171 bytes; inputs totalled 681,312 bytes. Discovery plus these
inputs and replies totalled 6,934,288 bytes, excluding initialization, framing
and notifications. This is delivery volume, not model token usage. Actual
model context and total model task cost were not measured.

A process-generation sampler recorded 233 observations over 25,671 ms:
15,797 ms aggregate observed CPU as a lower bound and a peak sampled working-set
sum of 491,597,824 bytes (about 469 MiB). Exited-process tails can be missed;
shared pages can be counted twice. This excludes the observer and is not an
exact physical-memory peak. The server wrote four structured completion records
to stderr; tool replies and normalized results passed the recorded checks.

Cold/warm caches and observer differences were not normalized. No latency,
CPU, memory or model-token improvement is claimed. The fix adds no lookup I/O,
engine invocation, retry or cache. Complete default replies remain available;
only compact selected findings and hashes were sent to the investigating agent.

## Main integration replay

Runtime cb0d8a9fef2b907cff2ba27f1e017493e1173eb2, rebased onto main
73dd8d6ed, again passed the 101 related tests and all four real Windows CLI/MCP
cases using the unchanged older producer Evidence. Positive results and original
runtime/layer facts remain identical. Typecheck, lint, dependency and metadata
checks passed; all five changed files passed formatting independently.
The full format gate at that main revision failed on the unchanged upstream
GhidraDoctor.test.ts and GhidraSnapshotCache.test.ts files. The PR does not
repair those unrelated baseline files. Resource figures above refer to the
earlier candidate; the integration replay does not establish a speedup.

Review found that owning only the Windows test path would still skip that lane
on a later implementation-only edit. The matcher implementation is now also
registered in package scope. A source-only classifier case verifies that it
selects both Windows package and JavaScript recovery lanes; 85 scope checks and
two curated-path checks pass. Runtime code and the real-data checks are unchanged.

The original production fix merged as
[1a1b67c88](https://github.com/morluto/rea/commit/1a1b67c88) while this follow-up
was open. The follow-up was then rebased onto main fb28ec153 and contains only
the stronger workflow assertions, Windows lane ownership, scope classification
and this verification record. The updated 131 related tests, two representative
Ghidra boundary tests, seven IDA input-thinning tests, 24 semantic-structure
tests, 16 required-lane checks, 39 release-checkpoint tests and 11 dyld CLI
tests passed after the rebase (230 total).
Upstream a0317cf73 corrected the invalid FAT fixture and consolidated unrelated
duplicated helpers; e05d3399f aligned the older parameter-provenance assertion
with the upstream semantics. Those changes, the threshold change and the new
CI qualification tiers are part of main, outside this follow-up's diff.
Upstream 747e72991 restored release preflight coverage for reusable workflow
jobs. The independently reviewed, fully green #2755 fixture correction merged
as fb28ec153 and restored real x64 dyld CLI admission without altering the
original same-named arm64e assertions.
No production source is duplicated by the follow-up.

# MCAP summary inspection experiment

This prototype asks whether REA could answer: **what channels and schemas does
this recording declare?** It uses the official `@mcap/core` reader. It is a
standalone experiment, outside REA's CLI, MCP catalog and published package.
Scope and dependency approval are still pending.

From the repository root, use the pinned Node/npm versions:

```sh
npm ci
npm ci --prefix experiments/mcap-inspection
npm test --prefix experiments/mcap-inspection
node experiments/mcap-inspection/build/experiments/mcap-inspection/cli.js recording.mcap
node experiments/mcap-inspection/build/experiments/mcap-inspection/cli.js recording.mcap --schema 1
```

The build reuses REA's Result, JSON-size and file-identity helpers. The experiment
has its own lockfile; it adds no dependency to REA's runtime manifest. The direct
Node command writes one JSON object to stdout and returns 1 on failure.

## What the output means

- Header profile and writer library; channels keyed by numeric ID, including
  their topic, encoding, metadata and schema reference.
- Schema names, encodings, byte lengths and SHA-256 hashes. `--schema ID` returns
  that definition as base64, preserving non-UTF-8 bytes. Other definitions stay
  omitted. A schema missing from the summary is unresolved, not absent from the file.
- Counts and nanosecond times from optional Statistics, kept as decimal strings
  for 64-bit values. These are **declared**, not counts from scanning messages.
  Missing statistics or per-channel counts are `null`.
- Chunk index offsets, sizes and compression names from the summary. No message
  payload is decoded and no decompressor is loaded.
- The selected path, observed file identity, and byte ranges actually read,
  each with its own SHA-256. Those range hashes are **not a whole-file hash**.
- Request arguments and parsed positionals, including rejected usage. A failed
  option check retains the caller's filename when it was parsed as a positional.
- Admission failures retain the resolved path and separate pathname, open and
  descriptor observations in `source.admission`. Each stage distinguishes
  `not_attempted`, `failed` and its successful outcome; failed lookups retain
  their diagnostics. An identity mismatch keeps both metadata snapshots. Once
  admission succeeds, the usual source metadata replaces these stage receipts.
- Independent post-read descriptor and pathname observations in `file_state`.
  Each retains metadata or its lookup error; `matches_initial: null` means the
  comparison could not be made. A failed descriptor check does not skip the path.
- A failed read that consumed bytes retains their offset, actual length and
  hash, with `complete: false` and the originally requested byte length. Earlier
  completed ranges remain present; unread bytes have no claimed digest.

The reader checks a nonzero summary CRC. It does not establish whole-file
validity: it does not scan message data, validate all references, or reject
duplicate schema/channel IDs. Its maps retain the last record for an ID.
These limits also appear in the JSON. No robot behavior, dropped-message count,
or sensor correctness is inferred.

## Limits of this draft

This version requires a summary. A valid unindexed recording returns
`reader_rejected` with the reader's reason. That label can also mean malformed
input; it does not classify every reader error as corruption.

The reader allocates the complete summary, so cumulative reads are capped at
4 MiB **before** a file buffer is allocated. Repeated/overlapping reads count
again. JSON is capped at 1 MiB, with escaping checked before serialization and
base64 expansion checked before encoding. Over-budget requests fail explicitly.
If the full response exceeds the budget, a smaller failure receipt retains the
source, read-range hashes and errors; the report is explicitly omitted. Error
messages longer than 1,024 characters retain a prefix, full byte length and hash.
If raw request provenance cannot fit, `request.omitted: "json_limit"` replaces it
with the exact request JSON byte length and SHA-256. An oversized request is
rejected before target access; a final receipt may also summarize the request
to preserve its file observations and read evidence within the output budget.
These are experimental resource budgets, not MCAP format limits or a bound on
total Node memory. There is no paging or runtime override yet.

The pinned reader can consume a field beyond its declared record length when
given a whole summary buffer. Before that parse, the experiment checks each
summary record with the same SDK parser restricted to the record's own bytes.
This adds a parsing pass without duplicating MCAP field definitions.

The command admits a regular local file, rejects symlinks and checks its metadata
again after reading. These checks can detect a changed file; they do not provide
an atomic snapshot. It opens the file read-only and attempts to close it before
printing. A close error retains the inspection result in a failure response;
the one-shot process then exits. There is no persistent provider or cleanup-retry
API. OS process termination owns cancellation; cooperative REA cancellation and
Evidence/session integration would need separate work before integration.

It does not connect to robots, play recordings, execute target code, convert
files, retrieve URLs, or inspect attachments or arbitrary metadata records.

## Verification

Tests use Node's test runner and are named `*.node-test.ts` to keep them separate
from REA's Vitest projects. Run them with the package command above. They generate
recordings with `McapWriter`; no binary fixture is committed.
They cover duplicate topic names, 64-bit precision, omitted schemas/statistics,
unknown compression, malformed magic/footer/CRC, missing summaries, read/output
limits, selected-schema expansion, file/argument errors, and read-only CLI output.
Controlled filesystem faults cover read denial, mutation after the final read,
path replacement/removal, independent metadata lookup failures, partial reads
followed by truncation or a read error, and close failure after success or a
parse failure. These are controlled failures, not claims of naturally occurring
OS permission or close-denial coverage.

The suite also checks short summary-record boundaries, strings and schema bytes
that overrun a record after a complete length prefix, final-response overflow,
large reader diagnostics, and preservation of simultaneous failures.

For the follow-up admission fix on October 31, 2026, the standard package test
command built and ran with Node 24.22.1 / npm 11.16.0 on Windows x64: **47 passed,
1 skipped** for unavailable symlink privileges. Six real-CLI regressions failed
before the fix and passed afterward, covering directory/missing input, open and
descriptor errors, pathname replacement, and combined admission/close failure.
The request-budget regression also retains partial admission observations.

For the earlier evidence fixes at `14f0c2d`, the standard package test command built
successfully with Node 24.22.1 / npm 11.16.0 on Windows x64: **40 passed, 1 skipped**
for unavailable symlink privileges. Ten CLI regressions first failed on the
previous production code, then passed with the fixes. Separate negative controls
confirmed request-budget failures before target access and request-only omission
when final metadata pushes a receipt over the output budget.

Earlier verification with Node 24.18.0 on Windows x64: 21 passed and the real symlink test
was skipped because symlink creation required unavailable OS privileges. Ubuntu
under WSL2 passed all 22 tests, including real symlink rejection. The Linux run
used the same emitted JavaScript and portable reader dependencies; it did not
repeat npm installation or TypeScript compilation. For that earlier update, the Windows
compiler needed an explicit list of the same 11 source files: native discovery
skipped the local OneDrive-backed files. Compiler options and dependencies were
unchanged. Root CI currently does not install or run this standalone package's tests.
Linux was not rerun for the October 31 fixes.

The [990-byte upstream demo](https://github.com/foxglove/mcap/blob/9b4d3e36c7f7742541df33e0cff35c95de6af2a1/testdata/mcap/demo.mcap)
returned profile `ros1`, `/chatter` (2 messages), `/diagnostics` (1), schema
`std_msgs/String`, and one Zstd chunk. Its SHA-256 remained
`b90a0af442bfc6aaf31d7ae0a361f04d2a4eecca7168f9917391b74697af5c8c`.
The official MCAP CLI v0.4.0 reported the same inventory and warned about duplicate
channel IDs. This is a synthetic example, not a clean integrity fixture or real
robot qualification. It is referenced, not redistributed.

One initial Windows invocation reported changed file metadata. Subsequent calls,
including three direct read probes on both the original and an OS-temp copy,
did not reproduce it. The historical cause is unknown; file-change checks remain
enabled.

On that sample, the Windows command read 651 bytes in four requests (including
overlap) and returned 2,250 JSON bytes with `--schema 1`. One fresh process took
376 ms from a preload measurement hook to exit, 483 ms total CPU and 46.5 MiB peak
RSS. Three subsequent fresh processes took 215–236 ms, 436–468 ms CPU and 46.4–46.6 MiB
peak RSS. CPU and RSS came from `process.resourceUsage()`; the command launches no
children. Node bootstrap before the hook is excluded, OS caches were uncontrolled,
and other checks were running. Before the record-boundary and failure-receipt
fixes, the same small sample took 61–162 ms and 139–327 ms CPU with 45.1–45.4 MiB
peak RSS. Different concurrent load prevents attributing the timing difference to
the extra parsing pass. These are observations, not a speedup claim.
Whole agent-task tokens, a cold-storage run, macOS, and large real robot
recordings remain unmeasured/unverified.

For the earlier `14f0c2d` fixes, equivalent commands on that demo were measured before
and after with Node 24.22.1. Each row records one initial fresh process followed
by three more fresh processes. Wall time includes process launch; CPU and peak
RSS come from the CLI's `process.resourceUsage()`. The CLI launches no children.

| Command / revision   | Initial wall ms | Repeated wall ms | Repeated CPU ms | Peak RSS MiB (all runs) | JSON bytes |
| -------------------- | --------------: | ---------------: | --------------: | ----------------------: | ---------: |
| `--schema 1`, before |           839.5 |       81.4–104.0 |           61–77 |               46.7–47.2 |      2,252 |
| `--schema 1`, after  |            93.4 |        85.8–92.7 |          77–108 |               46.9–47.1 |      2,874 |
| `--unknown`, before  |            79.3 |        76.0–82.3 |           62–77 |               46.6–46.9 |        289 |
| `--unknown`, after   |           100.5 |       90.1–149.1 |          92–109 |               46.7–46.9 |        272 |

The successful command retained the same four range hashes and unchanged input
hash. The rejected option now retains its input and request. OS caches were
uncontrolled and other validation ran concurrently, so these measurements do
not establish a speed change. Cold-storage, output-token, and whole-agent-task
token costs remain unmeasured; byte counts are not token counts.

For the admission follow-up, the same measurement method compared `14f0c2d`
with the fix. Directory rejection grew from 255 to 676 JSON bytes; successful
`../demo.mcap --schema 1` output stayed at 2,871 bytes. Initial fresh-process wall
times were 101.6/257.5 ms (directory, before/after) and 100.2/247.0 ms (success).
Three subsequent directory runs took 82.8–97.9/218.8–230.9 ms wall time and
62–108/233–234 ms CPU; successful runs took 80.6–87.0/233.4–241.4 ms wall time
and 46–93/233–280 ms CPU. Peak process-family RSS across all runs stayed within
46.8–47.4 MiB (the CLI has no children). Initial CPU times were 124/249 ms for
directory rejection and 78/234 ms for success. Other checks ran concurrently and
OS caches were uncontrolled; the timing difference is observed, not attributed
to the fix. Cold-storage and token costs remain unmeasured.

## Decision for maintainers

Would a summary-only MCAP inspector be useful in REA? If so, is the official
TypeScript reader an acceptable dependency, or should the first integration use
a caller-installed MCAP CLI? This draft makes the reader's limits visible so
that decision can come before CLI/MCP and retained-Evidence integration.

References: [MCAP specification](https://mcap.dev/spec),
[TypeScript reader](https://mcap.dev/docs/typescript/classes/_mcap_core.McapIndexedReader),
[contribution scope](../../CONTRIBUTING.md#contribution-scope).

# Existing Ghidra project reuse: real workflow verification

The task counts the analyzed functions, reads one 32-record inventory window,
reports the overview, decompiles two known local non-thunk functions, repeats the
inventory query, exports complete Evidence and verifies it offline. Function
bodies and the complete inventory are compared by stable function identity.
The agent receives inventory summaries and the selected page; the complete
inventory remains accessible through retained Evidence and its exported bundle.

## Executed scope

Linux x64, Ghidra 12.1.4, JDK 21.0.12.1, Node 24.22.1. Measurements follow main
`e3066c170` with the feature core at `9746ec7d9`; receipt revisions distinguish
that driver from subsequent `5d237eb0c` / `314b0e038` refinements. Subsequent core
change only improves the setting named for an invalid derived program selection.
The final source suites and actual CLI/MCP cases use the updated dependency lock.

- `/usr/bin/ls`: 652 function records; complete facts SHA-256
  `d2eb1ea6586b8d549663f98089290dbc020bcc9f9c867545f8ba132aa1a13195`.
- `/usr/lib/x86_64-linux-gnu/libcrypto.so.3`: 14,338 function records; artifact SHA-256
  `aa01e614af634bc7c8b678c9250b5c4f613c61989bacf0a5d6aed6570e7dcabd`;
  complete facts SHA-256 `033eccbb258317b7d05a4d4a48f049f5d2649b276852623cef3c1fb93e9a029a`.

Both pairs return identical full function records and the same nonempty pseudocode
for each selected address. Evidence IDs/profile identities differ intentionally:
existing-project observations commit the caller project content and unknown
original analysis history. Successful reuse verifies source project content
unchanged after closing; original binary digests remain unchanged too.

## Matched completed tasks

Each row includes SDK initialization, one discovery, every call, full bundle
export/authentication, connection cleanup and receipt publication. Both columns
in a target pair use compact output schemas and the same families:
`direct,enhanced,native,application,session`.

| Task             | Functions | Wall s | Family CPU s | Peak family GiB | First / warm inventory s | Wire tokens, estimate |
| ---------------- | --------: | -----: | -----------: | --------------: | -----------------------: | --------------------: |
| current-ls-fresh |       652 |  63.62 |        84.87 |           1.276 |            55.83 / 0.416 |                85,151 |
| current-ls-reuse |       652 |  31.69 |        46.61 |           0.938 |            20.58 / 0.151 |                85,448 |
| crypto-fresh     |    14,338 | 186.42 |       287.01 |           1.857 |           176.71 / 1.535 |                84,162 |
| crypto-reuse     |    14,338 |  25.45 |        40.23 |           1.258 |            17.29 / 1.256 |                84,516 |

The first query starts a new provider process; the warm query reuses that session.
OS caches were not flushed. These are sequential samples on a shared host, not a
general speed guarantee. Earlier completed small-target calibrations vary
substantially (fresh 34.8–56.1 seconds; reuse 19.2 seconds), so elapsed time alone
should not be treated as a stable ratio.

CPU is summed process-family user/system time. Memory sums family RSS sampled
every 100 ms; shared pages can be double-counted and short peaks missed. Every
run used 2-CPU affinity, an 8-GiB family RSS guard and a wall deadline. Fresh and
reuse used the same heap request per target: 1,536 MiB for ls, 3,072 MiB for crypto.
No measured workflow triggered OOM, a resource guard or a cleanup failure.

Token estimates encode every captured JSON-RPC message, including initialize,
full discovery schemas, requests, result text/structured content and notifications,
with `cl100k_base`. They exclude framing newlines and are not actual model usage.
The model adapter, model tokenizer, hidden prompts and billing were not measured.
Project provenance adds a small response cost; this feature primarily avoids
repeated import/analysis rather than reducing tokens. Complete Evidence files
are verified locally and are not inserted into the agent transcript.

## Preparation cost and scope refinement

The explicit pre-import step saves a new project outside REA; its time is not
hidden in a warm result. With the same 2-CPU bound, ls preparation cost 36.17 s
wall, 59.54 CPU s and 0.845 GiB peak family RSS. Crypto preparation cost 231.76 s,
251.08 CPU s and 1.615 GiB peak. Both used default analysis followed by the same
REA no-return repair that a fresh REA import uses, enabling an equivalent-data
comparison. Ordinary caller projects may have different analysis histories.
Preparation plus the first investigation can cost more than one fresh import;
the benefit is repeated sessions or separately paid analysis that exceeds startup.

The task does not actually need the native family. A narrower executed ls pair
uses `direct,enhanced,application,session`, advertises 97 tools, preserves the same
complete facts and costs 67,523 / 67,820 estimated wire tokens for fresh / reuse,
versus 85,151 / 85,448 above. Its observed wall/CPU/peak values are 37.35 s / 62.63 s /
1.089 GiB fresh and 20.17 s / 32.21 s / 0.886 GiB reuse. These separate samples
confirm the smaller catalog works; they do not establish a general speedup from
scoping. Use the narrow scope when reproducing the task.

## Negative cases and verification limits

The actual production MCP path rejected `/usr/bin/true` against the ls project
with the recorded-import digest mismatch. A separate owned source clone changed
after open was rejected by the first query with its changed-input reason, then
cleaned up; the test restores its own intentional marker edit. Successful files,
source content and cleanup outcomes are verified separately. The actual compiled
CLI `decompile` selected the same project/profile and returned the same pseudocode
as MCP for `0x10a420`.

Final focused validation: 35 files, 958 passed / 4 platform skips; typecheck/lint,
build, 9 documentation cases and full formatting passed. No real macOS, Windows,
PE or Mach-O reuse claim is made. Windows and special fresh-import profiles remain
explicitly unsupported for this mode. Very large project trees and interrupted
cross-process database writes were not measured.

Initial driver calibrations caught external-first inventory ordering and
Evidence-ID ordering across different profiles. The driver now selects known
local functions from a bounded middle page and compares pseudocode by function
identity. Those failed calibration receipts remain in the maintainer workspace;
they are not counted as completed task successes.

## Reproduce

Build with the pinned toolchain and locked dependencies. Prepare a new owned
project using the documented [pre-import route](../../docs/installation.md#reuse-an-existing-ghidra-project).
The measurement used the same no-return repair during preparation for data parity.
Run the committed driver first without `--project`, then with it and `--control`:

```sh
node experiments/analysis-efficiency/ghidra-project-reuse.mjs \
  --runtime /absolute/rea --target /usr/bin/ls --output /absolute/new-receipt \
  --profile compact --families direct,enhanced,application,session \
  --ghidra "$GHIDRA_INSTALL_DIR" --java "$JAVA_HOME" \
  --project /absolute/projects/ls-analysis.gpr --program ls \
  --control /absolute/fresh-receipt
```

Use `--heap 3072M` for the crypto case. `--expected mismatch` and `--expected stale`
exercise negative cases; stale intentionally edits/restores an owned test marker,
so use a disposable source copy. The driver retains full wire messages, catalog,
report, exported Evidence and normalized comparison facts in its output directory.
Resource receipts were collected with an external bounded process-family sampler;
its method and limits are described above. Actual model-token usage remains unmeasured.

## Review boundary regressions

After the measurement runs, review coverage adds resolved-executable defaults for
`.app` inputs (caller bundle paths remain provenance), early unavailable Windows
existing-project discovery, exact cancellation reasons from both checkpoints and
owned file reads, and selected-pair overlap checks that allow a project directly
under `/tmp`. The ambiguous Windows properties fixture cases were removed; the
test now covers its actual two distinct release-directory inputs.

A real Ghidra test copy saved seed and disabled-analyzer reports with REA's actual
pre-scripts. Reopening it through production MCP preserved both as one immutable
historical Evidence record, linked it from function observations, returned the
same function/pseudocode facts, and left source content unchanged. Fresh-import
checks still validate fresh requested work. No real macOS/Windows reuse claim is
implied by simulated platform boundary tests.

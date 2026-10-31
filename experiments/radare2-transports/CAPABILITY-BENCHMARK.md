# SQLite CFG, type and value-flow task comparison

These are completed static investigations through the [isolated analyst
prototype](CAPABILITIES.md), followed by a separate corrected-profile cohort.
They complement the [original cold/warm and agent benchmark](BENCHMARK.md).
No production provider is registered. PR #3521 is the pinned Ghidra runtime;
these experiments and native fixes are not prerequisites for its merge.
All three r2 lanes use the same experimental analyst tools over their selected
carrier; they are distinct from the original report's direct raw/typed r2mcp
baselines.

## Original capability cohort

Twelve actual Codex runs: three SQLite questions across four lanes, one trial
each. Seven answers fully completed their task. Four limit answers correctly
qualified an unresolved table constant; the MCP type answer reported its failed
import. No wrong claims or fabricated observation identifiers were found in AI
review. These five partial answers remain in all costs below.

| Task / lane                     | Elapsed s | CPU s | Peak RSS MiB | Calls | Exact answer |
| ------------------------------- | --------: | ----: | -----------: | ----: | ------------ |
| Limit / CFG / r2pipe2           |     50.31 |  3.06 |          513 |     4 | partial      |
| Limit / CFG / one-shot          |     40.11 |  3.71 |          518 |     2 | partial      |
| Limit / CFG / r2mcp             |     44.05 |  3.20 |          521 |     4 | partial      |
| Limit / CFG / Ghidra            |     99.95 | 72.12 |         2287 |    10 | partial      |
| Append / buffer flow / r2pipe2  |     36.39 |  2.34 |          513 |     2 | pass         |
| Append / buffer flow / one-shot |     46.46 |  5.23 |          533 |     4 | pass         |
| Append / buffer flow / r2mcp    |     33.70 |  3.19 |          518 |     4 | pass         |
| Append / buffer flow / Ghidra   |     87.19 | 76.75 |         2082 |     3 | pass         |
| VFS / types / r2pipe2           |     32.60 |  2.16 |          530 |     1 | pass         |
| VFS / types / one-shot          |     29.84 |  2.19 |          522 |     1 | pass         |
| VFS / types / r2mcp             |     25.46 |  2.09 |          522 |     1 | partial      |
| VFS / types / Ghidra            |     79.82 | 74.85 |         2261 |     3 | pass         |

All four append workflows recovered the capacity boundary, field offsets,
argument-to-copy dependencies and length-store order. All four limit workflows
recovered the 11-block/15-edge local CFG and guard/update/old-value-return logic,
but could not resolve the requested concrete stored value: the profile omitted
byte reads from every lane, including Ghidra's existing `read_bytes`. This was
an adapter/configuration gap, not a missing engine capability.

The MCP VFS import used `to` while its core denied file/disk access. Native r2
logged the denial but returned success; r2mcp also consumed the structured log.
The subsequent missing-type lookup failed and the agent explicitly left the
field offsets unobserved. Native commit `28603ffce3` fixes the denied import's
status without changing its permission gate. The separate upstream MCP fix
restores JSON2 diagnostics; neither fix grants file access.
The [upstream logging PR #84](https://github.com/radareorg/radare2-mcp/pull/84)
uses a version-tolerant status regression. V2 selects production commit
`4019246f4e`; its later test-only PR adjustment does not change the selected
binary or production sources.

## Corrected profile

Four new limit investigations enabled `read_bytes` in every lane and supplied
the same instruction to read referenced constants. A fifth run retried only the
MCP VFS question with the explicitly provided declaration parsed inline by `td`.
These are fresh investigations, not continuations with free prior context.
The original task prompts and target are unchanged. Native and MCP versions,
tool catalogs, instructions and type-import form changed: this cohort does not
isolate the effect of one transport or optimization.

| Task / lane            | Elapsed s | CPU s | Peak RSS MiB | Calls | Exact answer |
| ---------------------- | --------: | ----: | -----------: | ----: | ------------ |
| Limit / CFG / r2pipe2  |     32.39 |  3.24 |          520 |     5 | pass         |
| Limit / CFG / one-shot |     46.45 |  4.23 |          519 |     3 | pass         |
| Limit / CFG / r2mcp    |     49.85 |  3.43 |          514 |     5 | pass         |
| Limit / CFG / Ghidra   |     95.75 | 71.80 |         2366 |     5 | pass         |
| VFS / types / r2mcp    |     27.05 |  2.10 |          522 |     1 | pass         |

AI review counted 5 exact answers out of 5 corrected-profile attempts.

For the completed limit task, the r2 carriers took 32.39–49.85 seconds versus
Ghidra's 95.75, with 3.24–4.23 local CPU seconds versus 71.80 and 514–520 MiB
sampled peak family RSS versus 2,366. r2pipe2 had the shortest elapsed time;
one-shot used the fewest total tokens at 118,443 versus Ghidra's 395,677.
Its uncached input was 36,321 versus 42,795, illustrating why the cache
breakdown matters alongside total context. These are observed workflow costs
for this one question and profile, not a universal engine or transport ranking.

The source/disassembly oracle expects the hard-limit word at `0xf6b90` to be
little-endian `00 ca 9a 3b`, or 1,000,000,000. A valid category-zero old value
123 with request 5 therefore returns 123 and stores 30; request -1 returns 123
without the local update. Per-run coverage and any unresolved facts are retained
in the data rather than inferred from process exit status.

## Model tokens

Actual Codex whole-task usage includes base instructions, advertised schemas,
all calls, follow-ups and reasoning. Cached input is a subset of input;
uncached input = input minus cached input. Reasoning is a subset of output.
Total = input plus output; these are not billing-cost estimates.

Original profile:

| Task / lane                     |   Input | Cached input | Uncached input | Output | Reasoning |   Total |
| ------------------------------- | ------: | -----------: | -------------: | -----: | --------: | ------: |
| Limit / CFG / r2pipe2           | 168,964 |      140,032 |         28,932 |  1,500 |       270 | 170,464 |
| Limit / CFG / one-shot          |  82,909 |       50,048 |         32,861 |  1,161 |       116 |  84,070 |
| Limit / CFG / r2mcp             | 190,144 |      148,096 |         42,048 |  1,339 |       158 | 191,483 |
| Limit / CFG / Ghidra            | 329,350 |      283,136 |         46,214 |  1,923 |       281 | 331,273 |
| Append / buffer flow / r2pipe2  |  85,706 |       64,768 |         20,938 |  1,164 |       132 |  86,870 |
| Append / buffer flow / one-shot | 175,027 |      147,712 |         27,315 |  1,387 |       103 | 176,414 |
| Append / buffer flow / r2mcp    | 148,929 |      125,440 |         23,489 |  1,132 |        54 | 150,061 |
| Append / buffer flow / Ghidra   | 335,709 |      283,520 |         52,189 |  1,467 |        83 | 337,176 |
| VFS / types / r2pipe2           |  78,877 |       47,232 |         31,645 |    734 |        48 |  79,611 |
| VFS / types / one-shot          |  78,920 |       64,256 |         14,664 |    681 |        49 |  79,601 |
| VFS / types / r2mcp             |  64,014 |       54,528 |          9,486 |    710 |        79 |  64,724 |
| VFS / types / Ghidra            | 172,029 |      133,376 |         38,653 |    842 |        34 | 172,871 |

Corrected profile:

| Task / lane            |   Input | Cached input | Uncached input | Output | Reasoning |   Total |
| ---------------------- | ------: | -----------: | -------------: | -----: | --------: | ------: |
| Limit / CFG / r2pipe2  | 166,155 |      136,960 |         29,195 |  1,387 |        90 | 167,542 |
| Limit / CFG / one-shot | 117,217 |       80,896 |         36,321 |  1,226 |       138 | 118,443 |
| Limit / CFG / r2mcp    | 158,008 |      115,456 |         42,552 |  1,600 |       264 | 159,608 |
| Limit / CFG / Ghidra   | 393,899 |      351,104 |         42,795 |  1,778 |       161 | 395,677 |
| VFS / types / r2mcp    |  79,306 |       52,352 |         26,954 |    604 |         0 |  79,910 |

Earlier failed/partial attempts are not free. These sums include both attempts
for the five question/lane pairs, with their separate session/context costs.
This is not a measured in-session recovery policy.

| Task / lane            | Original + retry s | Original + retry total tokens |
| ---------------------- | -----------------: | ----------------------------: |
| Limit / CFG / r2pipe2  |              82.70 |                       338,006 |
| Limit / CFG / one-shot |              86.56 |                       202,513 |
| Limit / CFG / r2mcp    |              93.90 |                       351,091 |
| Limit / CFG / Ghidra   |             195.70 |                       726,950 |
| VFS / types / r2mcp    |              52.51 |                       144,634 |

## What should change in the proposal

- Keep focused function analysis and compact retained views. Expose byte reads
  alongside references so an agent can finish a concrete question instead of
  returning an unresolved table formula.
- Preserve explicit native failures and structured logs. Under an MCP sandbox,
  use a caller-provided inline declaration when appropriate; do not retry a
  denied file import or weaken permissions implicitly.
- Keep r2ghidra available for pseudocode/SSA and native ESIL available without
  a decompiler. Request expensive flow detail for the question that needs it.
  The task runs do not isolate a best universal flow/decompiler default.
- Reuse the selected connection and analysis. These prototype owned batches
  reopen between tool calls; their timings do not measure a future persistent
  provider. The original warm-retrieval benchmark measures reuse separately.
- Report answer coverage before ranking time or tokens. A fast partial answer
  does not establish a faster completed solution. One trial per profile/lane
  cannot establish a global transport winner or statistical improvement.

## Questions and independent checks

The unchanged target is SQLite 3.54.0 ARM64 Mach-O, SHA-256
`cbd373e61913b2990f6e5eb2cf06a9ad7e33b8192948297152dbf1a10bcc0205`.
`sqlite3_limit` is at `0x16474`; `sqlite3_str_append` is at `0x4e24`.
The VFS task compares only the first seven fields. r2 receives a public-header
prefix; Ghidra uses its existing archive. Offsets are 0/4/8/16/24/32/40, widths
4/4/4/8/8/8/8. The r2 prefix is not the complete VFS aggregate; its source and
unknown trailing alignment are not presented as recovery from the binary.

Independent checks used Apple `otool`, compile-only static assertions and the
official [SQLite 3.54.0 source](https://www.sqlite.org/2026/sqlite-amalgamation-3540000.zip)
(archive SHA3-256 `7b670a62fdfbd672b75fef004cb703c8a3e87d3a5cc7d675b4a08337004a2d93`).
No target or oracle executable was run. Agents could use only their selected
engine's MCP tools, not source, shell, web or other agents. AI grading reads
the saved answers, actual tool responses and independent oracles; it is not
human evaluation. A reported unknown is distinct from a wrong assertion.

The tasks exercise instruction-backed value dependencies and native high-p-code
views. They do not establish full interprocedural, alias-sensitive or feasible
path analysis. Native ESIL DFG slicing is separately verified against real r2;
the append agents answered without calling its trace operation. r2ghidra uses
the Ghidra decompiler family, so those lanes are not independent decompiler
algorithm comparisons. Its expanded tail-helper/stub operations can exceed the
local native CFG; the adapter preserves that scope distinction.

## Measurement and reproducibility

Runs were serial on macOS 27.0.1 ARM64, 10 logical CPUs/32 GiB, Node 24.18.0,
Codex 0.162.1, requested `gpt-6.1-sol` with medium reasoning, and Ghidra 12.1.4.
Each run starts a fresh analysis session. OS/plugin/model prompt caches and
shared-host load are warm or uncontrolled; this is not a warm-session cohort.
The older benchmark separately reports first and repeated retrieval.

Elapsed seconds include agent reasoning, tools and cleanup. CPU is local
child-family user plus system time. Peak process-family RSS is sampled at 50 ms,
can miss peaks or double-count shared pages, and can miss denied observations.
Per-run denied counts and remaining observed child identities are in the data.
Remote model CPU/memory, network resources, download/build/setup time, full
dependency closure and billing costs are unmeasured.

The r2 lanes have six or fewer selected tools and prototype observations;
Ghidra has eight or fewer selected tools and production session/Evidence work.
Their catalogs, analysis policies and provenance responsibilities differ.
Results therefore compare these complete workflows, not engine-only speed or
production feature parity. No IDA/Hopper, Linux/Windows or live iaito/HTTP
performance was measured in this follow-up.

The [per-run JSON](capability-benchmark-2026-10-15.json) includes answers,
prompts, grades, token breakdowns, resources, call arguments/status, hashes and
selected settings. Complete raw transcripts remain in the recorded local lab
paths with SHA-256 digests. Before/after hashes pin the selected source,
executables, libraries and plugin; the source checkout is not proof of every
loaded library. The embedded native version banner can lag rebuilt code.
V1 carrier configurations were captured after its cohort and are labeled as
such; v2 pins them before and after. Native fixes are mapped to separate commits
in [the capability report](CAPABILITIES.md#real-cases-and-native-fixes).

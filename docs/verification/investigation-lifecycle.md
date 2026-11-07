# Investigation record lifetime verification

Verified on Linux with Node v24.22.1 and local Codex CLI 0.165.0 for
[#8347](https://github.com/morluto/rea/issues/8347). The final production revision is
`40ec9fe79b221b7550bf6a652f55389ea0b7e54f`, including main
`d54a4661da20382ad8456564a08569fdd24131c5`. Its runtime manifest SHA-256 is
`f4e55abdc5cb9fc2a86efcec5c410f2b5bc3eb5a7109a8d5ab88f07f8511c48b`.
Earlier measurements below identify their older revisions explicitly. Documentation
was being updated during final qualification; production sources and runtime
remained unchanged.

The [MCP contract](../mcp-contracts.md) separates engine cleanup, investigation
reset and explicit checkpointing. Automatic journaling remains tracked in
[#4809](https://github.com/morluto/rea/issues/4809).

## Response publication qualification

The request-publication correction is pinned to
`40ec9fe79b221b7550bf6a652f55389ea0b7e54f`. An MCP request now retains its
originating session admission through handler cleanup and physical send
settlement. Nested operations borrow that admission, avoiding reentry behind a
queued reset. Cancellation before a suppressed send and during an already-started
send have separate completion rules. Outgoing server requests cannot acknowledge
an incoming tool response merely because their IDs coincide.

All nine genuine saved-source workflows were repeated: 313 MCP calls and 19 CLI
checks, 114.210 s guarded elapsed, 109.411889 s CPU and 1,055,035,392 B maximum
family peak. Complete original public results and source identities matched
through close, checkpoint refusal, reset and same/fresh-process recovery; all
Unknown histories were preserved. No producer replay, source/runtime changes,
OOM or unresolved owned cleanup occurred. These runs have uncontrolled OS caches
and are not a paired timing comparison with the earlier cohorts below.

A new local Codex CLI task requested `gpt-6.1-terra`/`high` with the scoped
four-domain profile. It completed 25 MCP calls, including four expected
missing-reference controls, with no producer replay. Usage was 232,677 input
tokens including the 199,552 cached subset, 3,613 output tokens and 195 separately
reported reasoning tokens; elapsed was 61.466 s, local CPU 11.031356 s and peak
806,146,048 B. Requested aliases do not establish the server-resolved model
identity, and remote model compute is unmeasured.

An independent fresh stdio process authenticated that task's 21-record,
three-revision checkpoint: 16,138,657 B, SHA-256
`a4395246473397cdc9040cb643e3175fd6f8b24db40597f8b680f0e065643df5`.
Nine calls reproduced all four complete original results and source records and
reexported byte-identical bundle bytes. This took 6.353 s elapsed, 6.060161 s CPU
and 592,621,568 B peak, with verified cleanup and no OOM.
Independent full-result/source/history authentication and manual answer review
supported the model's stated conclusions. No task or model retry was needed in
this cohort; separate checker and report-aggregation CPU was not measured.

The actual Ghidra healthy-engine control also passed on this runtime: 49 calls,
51.115 s elapsed, 50.000976 s CPU and 1,124,110,336 B peak. The verifier-owned JVM
PID/start identity/process group, public analysis run and MCP client were the same
across reset. Two explicit `address_name` queries returned identical Evidence;
no dossier, inventory or decompile producer was replayed. Full checkpoint/history
recovery and owned cleanup passed, with no OOM. This observes retained-engine
behavior rather than a before/after speedup.

Across all three model cohorts, nine actual runs plus one prelaunch failure used
2,771,744 input tokens including the 2,468,608 cached subset, 23,334 output tokens
and 1,035 separately reported reasoning tokens. Guarded elapsed totals 480.694 s
and local CPU 87.103671 s; maximum family peak is 922,148,864 B. All earlier
failed/partial attempts remain included. These are execution costs, not a paired
model-token savings claim.

All nine controlled success/error publication cases passed. Reinstating only the
old admission factory made both successful-publication cases fail at the original
admission boundary; the corrected source was restored and all nine passed again.
The final boundary run used 12.872 s elapsed, 12.647482 s CPU and 941,723,648 B
peak. Existing lifecycle/deferred/shutdown tests passed 79/79; the full HTTP suite
passed 74/74. These controlled seams establish ordering, separately from real
application behavior.

CI also exposed the 1500-file JavaScript timeout fixture's retention headroom.
At a 512 MiB parent heap, the original timeout exceeded the 10 MiB wire budget;
fallback authentication projected 771,325,184 B against 411,666,312 B available
and correctly refused. The transport/timeout fixture now uses a finite 1536 MiB
parent heap while retaining all 1500 files and every recovery/query assertion.
Its worker remains at 128 MiB; the separate memory-pressure case retains its
512 MiB parent. All three tests passed in 23.556 s elapsed, 22.989758 s CPU and
1,064,308,736 B peak, including a public assertion that retained records fit the
fixed allowance. No production limit was raised for this fixture.

## Earlier review qualification

Review corrections were qualified at clean
`6d875b3ff73d40b365a713cf4ba69a10cca257b7`, with runtime manifest SHA-256
`328f05dc2d7b114c33dc0406e488c3046a43e1c12187e15ad9263be65df7cbaa`.
SDK error Evidence retention and reply publication now share session admission;
reset retries the MCP artifact scope alongside process cleanup before saving or
clearing. Controlled public MCP regressions cover both publication orderings,
queued cancellation, terminal shutdown, ordinary export cleanup failure, mixed
cleanup outcomes and scope reuse. Reinstating the former wiring made four of the
five new regression cases fail; all five pass with the correction. Controlled
waits also use bounded acknowledgements and release/join held work in `finally`.

The nine genuine saved-source cases below were repeated against this runtime:
**313 MCP calls and 19 CLI checks**, 118.510 s guarded elapsed, 114.859544 s CPU,
and 1,065,390,080 B maximum kernel-family peak. Every complete original result,
ID, source, coverage and Unknown revision chain matched through close, checkpoint
collision refusal, reset, same-process import and fresh-process recovery. No
producer or target open was replayed in this cohort. Input/checkpoint/runtime
immutability and owned cleanup were verified, with no OOM. These normal workflows
complement the controlled error/cleanup timing regressions; they do not reproduce
those timing faults themselves.

One further local Codex CLI task requested `gpt-6.1-terra`/`high` with the
scoped four-family code-mode profile. Its 25 MCP calls included four expected
missing-reference controls and no unexpected model errors or producer replay.
Independent full-result/source/history authentication and answer review supported
the answer within its stated scope; it did not claim to query every other
Unknown. The run used 58.269 s elapsed, 9.837083 s local CPU and 885,448,704 B peak,
with 239,931 input tokens including 215,168 cached, 3,721 output tokens and 277
separately reported reasoning tokens.

A real fresh stdio client restored that same new checkpoint: 21 records and
three Unknown revisions in 16,138,749 B, SHA-256
`760fc74951abc292a3ff2fe1771391ac0d4345416b2345dfa4e85cbb6ce96181`.
Nine calls reproduced all four complete original results and source records,
then reexported byte-identical bundle bytes. This took 5.443 s elapsed,
5.253212 s CPU and 595,218,432 B peak, with verified cleanup and no OOM.
Two external-checker failures were preserved and corrected against actual event
ordinals and query filter/paging semantics; neither required model or backend
replay. Separate checker CPU and remote model compute were not measured.

Across those two earlier cohorts, eight actual model runs plus one prelaunch failure used
2,539,067 input tokens including the 2,269,056 cached subset, 19,721 output tokens,
and 840 separately reported reasoning tokens. Guarded elapsed totals 419.228 s
and local CPU 76.072315 s; maximum family peak remains 922,148,864 B. Initial
failed/partial attempts below remain included. This is execution accounting,
not a paired model-token performance comparison.

That runtime also repeated the actual Ghidra healthy-engine control:
49 calls, 44.333 s elapsed, 43.348651 s CPU and 1,093,464,064 B peak. The same
verifier-owned JVM PID/start identity/process group, public analysis run and MCP
client survived reset; two `address_name` queries returned identical Evidence.
Startup-inclusive and warm requests took 24,953.573 ms and 6.762 ms respectively,
without dossier, inventory or decompile replay. These are startup/reuse
observations rather than a PR before/after speedup. Full checkpoint/history
recovery and owned cleanup passed, with no OOM.

## Initial main-integration workflows

Main was integrated in `4e20698b7b9883f659e445c059c011aa0e5de834`, with runtime
manifest SHA-256
`ee23cbaf0ecbf8d896fb5dc7a88317e2ab8eb77bd3a4467bf5793c3471ca9c7d`.

Nine genuine saved-source cases covered eight target families:

| Family     | Actual source          | Saved-source bundle SHA-256                                        |
| ---------- | ---------------------- | ------------------------------------------------------------------ |
| Native     | jq observations        | `0a3adad6ab39bfe29320e1f070a8e598382d2f17c4d6c19079bd6ff16dfe0937` |
| JavaScript | agent-browser 0.27.0   | `66232b6eb01b3dbf435949a1cd94cb2532b7f989b91cdf952a105b3cee231bda` |
| Managed    | NuGet CLI, SDK 8.0.427 | `11ac63842299c0ac641a320ec9b2a5161b454a8a322d57724fd5f2ffb2fddfa4` |
| Android    | NewPipe 0.29.1         | `fa499d0464a40ddc2f5159c893d68b8f50aa8e6d2b0080de22f2f3e5fc326825` |
| Harmony    | Shark 1.0.8 APP        | `3a526ab0113f80ada26ff5a0631fc95dac91485946f20584fc5a76f5ee8eb880` |
| Harmony    | Shark inner HAP        | `3431c0a347f331c3effacf7984ecb890f3fef46d8b00b03b50980023b065cd4a` |
| Apple      | Rectangle 2.0.4        | `8daa6286b28aadf5ba0d41038046805e5c69874eaa0bc5daf0e265360fcae79d` |
| WASM       | tree-sitter-css        | `acb0cb6c3e0d520f83144e106e171c3ecebba70c5c0498bbb0113185a3e4bf95` |
| Process    | Controlled jq captures | `55da0f130dc2265aae54261d49949471e5c929163c2b7314b42e95df3325b739` |

Each case imported authenticated observations, composed exact retained references,
closed without an active target, refused an existing checkpoint destination,
saved and reset, checked missing references, and restored into the same process
and a fresh public stdio MCP process. Complete original public results, source
links, coverage and Evidence IDs matched throughout. Every case included an
explicit analyst question with revisions 1→2; complete revision histories and
mutation Evidence authenticated after recovery. Bundle hashes above identify
the saved observations rather than release binaries. The actual jq target was
`/usr/bin/jq`, SHA-256
`90b1eef4498f31836342898fc6e97cfeb8a197c4366773a0fb120ae02a45ea52`.

That cohort completed **313 MCP calls and 19 public CLI checks**, without
source producer replay. Summed guarded elapsed was 119.445 s and CPU was
115.040362 s; maximum kernel cgroup-family peak was 1,047,826,432 B. All pinned
input/runtime hashes stayed unchanged, owned cleanup was verified, and no resource
stop or OOM occurred.

A separate actual Ghidra 12.1.4 control reset while its jq engine remained open.
The same verifier-owned JVM PID/start identity/process group, reported analysis
run and MCP client survived reset. Two identical `address_name` queries at
`0x104500` returned the same Evidence. The first request including startup took
21,023.963 ms; the post-reset request took 6.672 ms. This observes startup versus
reuse, rather than a PR before/after speedup. No function dossiers or procedure
inventories were regenerated. The complete close/checkpoint/import/fresh-process
control used 49 calls, 39.351 s elapsed, 38.222523 s CPU and 1,094,340,608 B peak;
reset acknowledged 15 records and three Unknown revisions with `retained_target`.

Earlier actual-provider controls also passed Ghidra→Rectangle provider-family
switching and Rectangle→NewPipe target switching, with reset retaining the healthy
second target. Those pre-sync runs preserved their complete original results and
histories; they are separate from the latest-runtime qualification above.

## Equivalent completed-task measurements

These pairs used exact baseline `60149282fcfc05ac32fbc94434c107710120da6f` and
implementation `3c9fb7f44a4496d18d893beb903c5f2ba68c06b4`, before the later main
integration. The baseline exported, closed and imported before reference
composition; the candidate closed and reused references directly. Both returned
the same complete original result for the same authentic inputs.

| Saved source | MCP calls, before→after | Elapsed s   | CPU s             | Kernel-family peak B    |
| ------------ | ----------------------- | ----------- | ----------------- | ----------------------- |
| Native       | 9→7                     | 5.846→4.938 | 5.609106→4.760475 | 582,672,384→511,090,688 |
| JavaScript   | 8→6                     | 3.529→3.333 | 3.371675→3.163932 | 394,170,368→387,428,352 |
| WASM         | 7→5                     | 4.236→3.731 | 4.035871→3.520731 | 658,063,360→492,548,096 |

Each row is one sequential pair in fresh isolated processes. OS caches were
uncontrolled; builds and fingerprinting were measured separately. These samples
establish two fewer necessary calls, rather than statistical speedups or model
token savings.

## Initial Codex tasks

Local Codex requested `gpt-6.1-terra` with `high` reasoning. Native used the full
advertised surface without an enabled-tool filter or exact-name guide, both
before and after the latest main integration. JavaScript, packages and the mixed
managed/WASM/process/Harmony task used explicit scoped diagnostic profiles. The
mixed task used the existing experimental client code mode; its development
warning was retained.

All four task scopes passed independent canonical bundle/history authentication,
complete original-result comparison and final-answer review. These conclusions
were checked separately from process exit and token accounting. Native's final
12 calls preserved the original comparison, acknowledged a 14-record/three-revision
checkpoint, observed the expected missing-reference control, and restored both
Unknown heads. The mixed model used 25 calls; a separate latest-runtime fresh
stdio verifier used nine calls to restore its same 21-record/three-revision
checkpoint, reproduce all four complete originals, and reexport byte-identical
bundle bytes.

The initial cohort table includes **all attempts**, partial runs and the native task repeated
after main integration:

| Task/profile                        | Input tokens (cached subset) | Output tokens | Elapsed s / CPU s   | Kernel-family peak B |
| ----------------------------------- | ---------------------------- | ------------- | ------------------- | -------------------- |
| Native, full discovery              | 841,133 (769,536)            | 4,326         | 101.845 / 18.383645 | 888,786,944          |
| JavaScript, scoped                  | 531,546 (452,224)            | 3,421         | 88.236 / 14.456771  | 922,148,864          |
| Rectangle→NewPipe, scoped           | 629,186 (567,424)            | 4,384         | 108.062 / 22.589319 | 878,800,896          |
| Four-family mixed, scoped code mode | 297,271 (264,704)            | 3,869         | 62.816 / 10.805497  | 914,604,032          |

Seven actual model runs plus one prelaunch failure consumed 2,299,136 input tokens
including the 2,053,888 cached subset, and 16,000 output tokens. Input already
includes cached input. Reported reasoning output was 563 tokens, recorded
separately. Canonical verification costs are separate from client/model costs.
The latest SDK catalog had 234 tools and 3,919,838 JSON bytes; those representation
bytes are not model tokens. No paired baseline model cohort ran, so these counters
do not establish causal whole-task token savings.

Three failed or partial attempts were preserved:

- Native's first attempt stopped before model/MCP launch because of a redundant
  template-only harness argument. Its 0.718 s/0.473821 CPU s remains included.
- JavaScript saved its six-record/two-revision checkpoint before the isolated
  client denied `binary_session`. The harness approval was corrected; a new
  process restored the same checkpoint and identical trace without another
  producer or reset. Joint accounting includes 16 client attempts, 15 served
  calls and the client denial.
- The package model selected an unsupported generic view for a derived Apple
  projection and stopped before checkpointing. Its continuation rehydrated
  original authenticated saved inputs after matching current IDs and observed
  summaries/projections, then used the correct projectors. Two inventory producers
  ran once total; one additional NewPipe metadata reopen restored active state.
  This qualifies explicit saved-source recovery. The first run's unsaved full
  inventory body was not directly transported or checkpointed.

## Resource and regression boundaries

The genuine multi-domain/model workflows used `--max-old-space-size=512` for
MCP/CLI Node children; retention had no quota override. The controlled timeout
fixture's separate parent allowance is documented above. An earlier cumulative
default-policy control admitted all nine genuine
bundles: 34 records, 87,532,230 estimated representation bytes against its observed
150,244,580-byte allowance. Exact duplicates did not grow committed state. This
corpus did not reach default capacity; injected-policy regressions establish
atomic refusal, metadata replacement accounting and budget release on reset.

Local checks passed across 43 focused source/public-boundary files, 533 distinct
tests using each file's latest passing run, and 93 Python tests. The main
integration specifically reran eight lifecycle/recovery files with 61 passing
tests, including retained candidate cleanup failure/recovery and healthy-client
preservation. Typecheck, bounded lint, formatting, module/architecture guards,
documentation and production reachability passed. Controlled providers and
failure seams qualify cancellation, late work and cleanup orderings separately
from actual-provider observations.

Heavy tasks ran serially with one CPU, 4 GiB hard memory, 3 GiB early stop, zero
swap and 192 tasks maximum. Kernel CPU and memory.peak were observed at payload
exit while a cgroup observer remained alive. They include drivers/helpers and the
observer, exclude preflight outside the guard, and are distinct from process RSS
and retained-representation estimates. Failed model attempts, partial results,
assessments and raw receipts remain local; binaries and authentication data are
excluded from the repository.

Explicit acknowledged checkpoints qualify cross-process recovery. Uncheckpointed
process loss, automatic journaling, parent-directory power-loss recovery,
Windows, IDA/Hopper and a second actual deep engine were not qualified here.

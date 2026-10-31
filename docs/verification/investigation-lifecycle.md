# Investigation record lifetime verification

Verified on Linux with Node v24.22.1 and local Codex CLI 0.165.0 for
[#8347](https://github.com/morluto/rea/issues/8347). The implementation was
integrated with main `d54a4661da20382ad8456564a08569fdd24131c5` in
`4e20698b7b9883f659e445c059c011aa0e5de834`. The final runtime manifest SHA-256 was
`ee23cbaf0ecbf8d896fb5dc7a88317e2ab8eb77bd3a4467bf5793c3471ca9c7d`.
Earlier measurements below identify their earlier revisions explicitly.

The [MCP contract](../mcp-contracts.md) separates engine cleanup, investigation
reset and explicit checkpointing. Automatic journaling remains tracked in
[#4809](https://github.com/morluto/rea/issues/4809).

## Latest public workflows

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

The final cohort completed **313 MCP calls and 19 public CLI checks**, without
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

## Actual Codex tasks

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

The table includes **all attempts**, partial runs and the native task repeated
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

MCP/CLI Node children used `--max-old-space-size=512`; retention had no quota
override. An earlier cumulative default-policy control admitted all nine genuine
bundles: 34 records, 87,532,230 estimated representation bytes against its observed
150,244,580-byte allowance. Exact duplicates did not grow committed state. This
corpus did not reach default capacity; injected-policy regressions establish
atomic refusal, metadata replacement accounting and budget release on reset.

Local checks passed across 25 focused source/public-boundary files, 342 distinct
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

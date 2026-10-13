# Analysis efficiency measurements

Tracks the experiments for [#2016](https://github.com/morluto/rea/issues/2016).
The production CLI/MCP contracts and defaults remain the compatibility baseline.
Downloaded artifacts, runtime copies, exported Evidence, transcripts and detailed
JSON measurements belong outside the checkout. This document keeps the measured
findings, verification scope and revision references; the scripts and `corpus.json`
keep the reproduction inputs. Generated `results/` is ignored.

Follow-up: [latest-main capability audit](latest-main-audit.md) records the
Flutter, SQLite, TShark and sigrok priorities and the first shipped Dart AOT
baseline, preserving existing controls before introducing another selector.

Follow-up: [Dart AOT summary and retained string pools](flutter-aot-summary.md)
records real LocalSend delivery pairs and old Evidence continuation, preserving
ABI selection, snapshot identity, original lower bounds and partial coverage.

Follow-up: [SQLite existing-control measurements](sqlite-existing-controls.md)
tests QGIS's shipped GeoPackage through the existing column selection, preserving
full selected-table schema and typed cells before considering another API.

Follow-up: [native PE/DOS entry views and real model verification](native-entry-views.md)
records the post-merge native continuation, including a small-function case where
four selected replies cost more bytes than the complete dossier.

Follow-up: [EVM descriptor and real-template controls](evm-descriptor.md) extends
the offline corpus with digest-pinned Uniswap runtime templates and an independent
published ABI selector oracle, preserving unknown deployment/immutable metadata.

Follow-up: [EVM interface summary delivery](evm-interface-summary.md) records
the opt-in retained view, old-client/Evidence migration checks and repeated SDK
and real-model pairs, including mixed token/time results and strict-answer limits.

Follow-up: [task-scoped preset lifecycle verification](preset-lifecycle.md) checks
real Ghidra profile/snapshot boundaries, startup cancellation and retained cleanup
retry while preserving defaults and distinguishing verification from performance.

Follow-up: [EVM descriptor lifecycle acceptance](evm-lifecycle.md) verifies actual
worker replies, late SDK cancellation, permission-induced cleanup failures,
healthy WASM peers and old CLI parity with explicit runtime and platform scope.

Follow-up: [managed artifact delivery and retained views](managed-artifact-summary.md)
records two shipped assembly checks, previous-runtime portable Evidence, and four
actual Codex trials. Selected replies shrink substantially; observed model input
tokens increase and latency is mixed, so model-token savings are not claimed.

Follow-up: [model tool context and per-response usage](model-context.md) separates
raw MCP replies from observed client execution/discovery and usage. Optional
trial capture retains tool/usage items while excluding account and ambient state;
existing ephemeral trials keep their default behavior.

Follow-up: [Android package delivery and retained manifest](android-package-summary.md)
records real NewPipe SDK pairs, unchanged old requests/Evidence, exact retained
text, and actual Codex outcomes including client errors and a failed discovery.
Reply bytes fall; model-token/time gains are not established.

Follow-up: [resource counters at payload completion](resource-counters.md) adds
optional owned counter observations while preserving unknown whole-scope final
counters, default receipt shape and the unchanged CPU/memory safeguards.

The 12 detailed checkpoint receipts were archived byte-for-byte before removal
from the final PR tree. The archive `review-receipts-00d51e0fc-20261012` is in the
private experiment lab outside the checkout; its `archive-index.json` records
source revision, filenames, sizes and SHA-256.
Raw producer replies, model transcripts and exported Evidence remain in the same
private lab. These local files are not required to build or use REA. Historical
checkpoint commits retain their original receipts; no history was rewritten.

## Optimization priorities and gradual migration

Agent token consumption and end-to-end task time are the primary objectives.
Memory and CPU consumption are also measured and controlled. Correctness,
Evidence provenance, caller choices and existing-user compatibility are
acceptance conditions for every optimization.

- Tokens: minimize unnecessary model-visible data while returning the requested
  facts and useful provenance inline. Count discovery, repeated calls, errors,
  retries and follow-up turns; report total/cached/uncached input and output
  separately. Compact JSON bytes are a delivery measurement, not a token count.
- Time: measure completion of the same analyst question, including startup,
  provider work, transport, client processing and model corrections. Separate
  measured stages and cold/warm state; use repeated comparable trials before
  generalizing an observed latency improvement.
- Memory: record aggregate process-tree peaks and limit/cleanup events, account
  for retained Evidence and representation expansion, and keep host safeguards.
- CPU: record aggregate CPU time for the completed task. A one-CPU quota is an
  experiment control; it does not itself establish reduced CPU consumption.

Migrate domain by domain with focused real-artifact checks and relevant shared
contract checks. The native follow-up verifies selected PE and DOS MZ entry facts;
DOS COM and complete native application behavior remain unverified. The domain
matrix is a growing roadmap. A passed lane does not imply all
advertised platforms/providers have passed. Newly discovered REA bugs remain
in the separate local handoff document for later team repair.

Old clients using existing CLI/MCP requests against the candidate retain the
complete default path. New summary/view options require explicit selection.
Actual old Evidence import/view/export checks preserve original authenticated
records and identities. These checks establish the recorded baseline/workflow
scope, not every historical release or third-party client. A new client targeting
an older server must discover the actual schema and use a supported equivalent
where available; this study does not implement a universal automatic fallback.
The catalog intentionally gains more precise/additive schemas, so its bytes and
digest are not frozen: measured runtime `259e99dd9` has about 2.6% larger complete
catalog JSON than the frozen baseline. The separate post-integration receipt
records the newer runtime, including upstream changes. Optional views can reduce
model-visible result data; old complete requests do not silently switch delivery
or acquire that reduction automatically.

## Reproduce a measurement

Use the repository's pinned Node/npm and locked dependencies. Build each selected
revision, then copy its `dist/`, `bridge/`, `scripts/`, `skills/`, `package.json`
and `package-lock.json` to a separate runtime directory before editing production
sources. That copy needs the matching locked dependencies. The initial frozen
baseline is `42b0ed126df7d5b908ac369715378d5e519051b7`; this study does not
silently substitute a newer `main` or the previous Code Mode experiment.

The public artifacts and acquisition digests are in `corpus.json`. Supply their
actual local paths and an optional JSON object of explicit provider environment
settings. Do not add credentials to that file. Provider settings are inherited
by the child, but the report persists only the selected settings' digest. Runs
reject undeclared inherited REA/Hopper and Ghidra/Java configuration keys before
starting a measured server or creating a model profile; include those settings
explicitly in `--providers`. Both drivers use `provider-environment.json` and
record its digest. The system/runtime environment still needs comparable
controlled conditions; its contents are not serialized. Both drivers also
fingerprint the effective provider `PATH` without recording its value, and
the SDK comparator rejects different or unrecorded search paths. This detects different
search configuration, not replacement of executable bytes at the same path.
Historical receipts
predate this guard, so their selected-settings digest alone does not certify
that no undeclared provider setting was inherited.

```sh
export NODE_OPTIONS=--max-old-space-size=512
export UV_THREADPOOL_SIZE=1
export GOMAXPROCS=1
export GOMEMLIMIT=2GiB
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/frozen-runtime \
  --revision 42b0ed126df7d5b908ac369715378d5e519051b7 \
  --artifact obsidian.asar --path /absolute/obsidian-1.14.4.asar \
  --providers /absolute/selected-providers.json \
  --output /absolute/new-measurement-directory
```

The wrapper requires Linux cgroup v2 and a working user systemd manager. It owns
a unique transient scope, restricts the whole process tree to one CPU, caps
memory at 4 GiB with no swap and 192 tasks, and samples memory/tasks/CPU every
100 ms. It stops its own scope above 3 GiB or below 4 GiB host available memory;
startup requires 8 GiB available. Cleanup failures retain the owned scope's
identity. Run heavy builds, providers and model trials serially. Sampled peaks
can miss short spikes; cgroup limit events are separately reported.

An actual Codex + Chromium trial exceeded the initial 192-task allowance and
was stopped automatically below 1 GiB sampled memory, with no OOM. The isolated
browser model retry uses `resource-run.py --task-ceiling 256 -- COMMAND...` to
account for both process trees; memory, swap and CPU controls are unchanged.
Keep the original aborted run and cleanup receipt. This is experiment capacity,
not a REA defect or a successful browser analysis.

## What the numbers mean

`summary.json` records the selected artifact's before/after SHA-256, runtime
file-table digest, dispatcher and lockfile digests, runner source digest,
Node/SDK versions, catalog sizes, caller arguments and producer Evidence IDs.
`runtime-files.json` identifies the exact compiled files measured. Actual
provider settings and runtime files must stay fixed during a comparison.

Every tool call measures three intervals at the public SDK Transport boundary:

- Client work before `send`, including first-use schema preparation.
- Transport/server roundtrip, including framing, I/O, server work and client
  JSON parsing. This interval is **not** a Ghidra-only or provider-only timer.
- Client work after the parsed response reaches `onmessage`.

The SDK call's total excludes the runner's subsequent encoding and disk writes.
Result byte counts measure compact JSON of the parsed client result, not raw
wire bytes or tokens. Progress notifications retain their actual arrival times;
they do not imply more precise internal engine timings than the producer emits.
Scope CPU time and aggregate process-tree memory come from the wrapper's final
JSON line. Fresh processes have cold application caches; host page caches are
not globally flushed.

`--delivery summary` is an explicit candidate workflow, initially for artifact
inventory. It must be supported by the selected server's advertised schema.
The default `complete` runs the existing calls unchanged. Compare the same
analyst facts and complete source Evidence before crediting a smaller response.
Projection can reduce delivery bytes without reducing upstream analysis time.
For WASM, the runner validates a summary request against the actual advertised
2020-12 input schema, including SDK-generated references. Supporting servers
return the first-call summary; older servers retain their complete path and use
summary/export views after an observed transport constraint. Original errors
remain in the receipts, and the complete source Evidence ID is a compared fact.
`--javascript-question selected` analyzes only the exact Obsidian sources
`package.json` and `main.js`, keeps inventory identity, and reads each observed
`main.js` module by its exact node ID. Package metadata is not a module selector.

Compare paired runs with the same runner source and provider settings:

```sh
node experiments/analysis-efficiency/compare.mjs \
  --left /absolute/complete-run --right /absolute/summary-run \
  --output /absolute/new-comparison.json
```

This checks all selected analyst facts, including inventory source IDs, exact
path records, manifest, counts, completeness, contradictions, coverage,
unexplored branches and limitations. It excludes only delivery observation IDs
and the named recovery-path description. Different settings, changed facts or
failed workflows make the comparator fail. Binwalk's per-invocation region UUIDs
are separately preserved with both original values and JSON paths; only those
opaque lookup values are excluded from physical-region fact equality. Original
producer replies are never rewritten. Selected JavaScript comparisons likewise
preserve both values of the two named parent-heap-dependent byte budgets before
excluding their values from fact equality; fixed limits and coverage rows remain
checked. Counts include extra view calls and
observed tool errors. Use repeated runs with alternating order before claiming
a distribution or a speedup; one pair is only one observation.

For a completed WASM result exceeding the MCP response budget, the runner keeps
the original error, exports retained Evidence through the public tool, and
authenticates the exact reported record using the selected runtime's parser.
The report names this recovery; it does not relabel the oversized inline reply
as successful delivery.

## Initial observations and exclusions

The frozen baseline has 2,326,609 bytes of complete catalog JSON, of which
494,207 bytes describe names, descriptions and input schemas. One Obsidian
trial spent about 21.9 s before the first request was sent, then about 0.77 s
in that request's transport/server roundtrip. Other cold runs differed
substantially. These single observations identify a measurement boundary;
they do not establish a speedup or a distribution.

The initial matrix exercised shipped Obsidian, NewPipe, ShareX, OpenWrt, SQLite
WASM and jq artifacts. SQLite produced a complete result larger than the
transport frame and requires an explicit recovery run. A first jq attempt hit
the SDK's default 60 s timeout because the experimental runner used a superseded
three-argument call signature. SDK 2.3.1 accepts request options as argument two;
the corrected jq run completed real Ghidra analysis in about 265 s. That earlier
driver timeout is excluded from REA regression claims. Provisional runs with
different runner source digests are not one paired statistical cohort.

No cross-session engine database cache, default analyzer changes, external
plugin loading, or broad plugin SDK is enabled by this experiment.

## Obsidian delivery checkpoint

The two recorded pairs compare frozen baseline
`42b0ed12` and candidate `f1106181` in complete → summary and summary → complete
order using the same runner source, bytes and provider settings. Both preserve
every selected fact and the atomic inventory Evidence ID.

| Measurement                                         |        Complete | Summary + exact path view |
| --------------------------------------------------- | --------------: | ------------------------: |
| Tool-result compact JSON, including lifecycle calls |   937,404 bytes |              16,322 bytes |
| Tool calls per question                             |               3 |                         4 |
| Complete catalog compact JSON                       | 2,326,609 bytes |           2,370,505 bytes |
| Workflow elapsed, first pair                        |         11.04 s |                   10.23 s |
| Workflow elapsed, second pair                       |         10.57 s |                   10.18 s |

Reply JSON falls by about 98.3%; catalog JSON grows by about 1.9%. The two elapsed
observations do not establish a statistical speedup. Inventory coverage and
upstream byte acquisition are unchanged. The candidate remains opt-in; existing
requests continue to deliver the complete inspection. Each run verifies the
selected artifact's before/after digest and reports no observed OOM or task
limit events. Source typing and projection improve selected delivery without
introducing an engine database cache or an external plugin protocol.

## Task-scoped analyzer experiment

The recorded jq pair explicitly disables
`Decompiler Switch Analysis` through the existing `REA_GHIDRA_DISABLED_ANALYZERS`
setting and compares it with the unchanged Ghidra default. Both use the same
frozen runtime and real jq bytes, one CPU, a fresh ephemeral database and the
same entry/main question. Completed main dossiers exceed the MCP frame in both
runs; existing retained native views recover the selected facts, preserving the
observed transport errors in the reports.

One disabled/default pair takes 174.77/276.23 seconds. Entry and main pseudocode,
main strings and its block count agree. However, callee `0x40daa0` has 604
recovered body bytes in eight ranges by default, and 164 bytes in four ranges
with the same 646-byte span after disabling switch analysis. Equal top-level
counts do not establish call-graph equivalence. **Keep the production default.**
Use the existing control only for a caller-selected task whose required facts
have been checked; no general fast preset is introduced. A separate real
coreutils/Ghidra probe rejects a nonexistent analyzer before bridge readiness,
preserves the named failure and closes the session. Source bytes remain unchanged.

`--schemas selected` is a separate SDK 2.3.1 client experiment. It passes the exact
live named `tools/list` definition to the SDK's public `callTool` option, retaining
output validation. It does not change REA or the default runner mode. Selected
definitions compile per call rather than preparing the entire cached catalog;
report this client effect separately from engine analysis or model behavior.

## Real Codex CLI trials

`agent-trial.py` accepts an explicit frozen runtime and revision, the same
question templates in `questions/`, and optional explicit provider settings.
It fingerprints the actual runtime, runs pinned local Codex CLI with a private
temporary profile, copies only the authentication file with mode 0600, disables
shell/web/multi-agent tools, and removes copied profile state afterward. Raw
events and answers remain outside Git. A zero exit code is not a factual grade.
Review the original tool calls, failed requests, result limitations and answer.

The optional `--enabled-tools FILE` supplies a list of exact names to the
temporary Codex MCP configuration's `enabled_tools`, as described in the
[official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
It leaves the REA catalog and other clients intact. Initial Obsidian trials
showed parameter-correction attempts and different delivery choices even with
the same question; filtering alone has not established a cost or quality win.
Requested model aliases are recorded without inventing a resolved model identity.

The browser question uses `--authority browser` to permit only its explicitly
selected public scenario in a fresh, owned headless profile. Browser observations
and cleanup are graded separately from static artifact analysis.

## Real artifact compatibility checkpoint

Six frozen baseline/pilot pairs exercise
Obsidian, NewPipe, ShareX, OpenWrt, SQLite WASM and published historical WETH code
through public MCP tools. All selected facts agree under the stated comparison
rules. Obsidian complete delivery and atomic inventory Evidence identity remain
unchanged. ShareX native-boundary claims remain scoped to the selected DLL;
NewPipe retains a null DEX descriptor rather than inventing one.

SQLite's complete 15,382,128-code-unit WAT exceeds the MCP response budget in both
revisions. The control recovers complete Evidence through file export; the pilot
reads summary and four exact export forms inline, without running WABT again.
Inline byte totals exclude file exports, so they do not establish a size win.
OpenWrt comparison preserves both sets of upstream-generated region UUIDs before
comparing offsets, extents, signatures, coverage and limitations. WETH is a
published historical example; a live RPC request returned HTTP 403, so this is
not live-chain verification. Every pair records unchanged target bytes and zero
observed OOM/task-limit events. The Linux x64 results do not establish behavior
for IDA, Hopper, macOS, Windows or Harmony.

## Same-question model and selected-source follow-up

Two actual SQLite model trials preserve all
12 requested facts. The question, developer instruction, provider settings and
tool allowlist hashes match. A description-only follow-up supplies the exact
summary kind and its fields. Calls change from 42 to 3, workflow time from
292.64 to 63.79 seconds, and reported input tokens from 304,698 to 74,387. The
follow-up reads no unnecessary WAT pages. Both keep the original completed
analysis's transport error and authenticate the retained source/view identities.
This is one stochastic model pair, not a statistical or general causal claim.

The selected JavaScript pair preserves
all 24 observed `main.js` module identities and the exact two-source selection.
The strict comparison initially differs on parent budget values derived from
observed heap availability; both values and paths remain recorded separately.
Other coverage facts, per-family rows, fixed worker limits, omitted/unknown
counts, statistics and Electron observations agree. Coverage remains partial,
with 36 unselected relevant files and 384 semantic unknowns. These static facts
do not establish runtime behavior. The comparator does not rewrite Evidence.

Ten real CLI trial reviews cover native,
managed, Android, firmware, Electron/JavaScript, WASM, EVM and browser tasks.
The selected JavaScript model preserves core facts and partial coverage but
omits full budget/family provenance. The browser producer captures complete
DOM/accessibility/URL evidence and terminates its owned process; direct model
answers lose two accessibility metadata fields to client context clipping and
report them unknown. A requested under-development Codex code-mode configuration
still produces a direct MCP call in the actual trace, so no executor/composition
win is credited. Profile cleanup, original errors, actual calls, usage, facts and
scope limits remain independently reviewed. Enabling a configuration flag does
not prove that a capability was used.

Discovered REA defects are recorded separately for team repair at the user's
request. This follow-up performs no additional REA bug fixes.

## Nonempty managed boundaries and final verification

A second shipped managed library checks
11 ModuleRefs, 147 PInvoke declarations and 225 native implementations from
ShareX HelpersLib 19.0.2. All complete normalized artifact and native-boundary
fields match between baseline and pilot, including source Evidence identities.
This covers nonempty declarations beyond the main ShareX DLL's empty import
tables. It does not verify native exports, execute the assembly or resolve CLR
dependencies. The curated receipt keeps identities, coverage, all ModuleRefs,
the first three PInvoke records and digests of the complete boundary payloads.
Full producer tables and comparison inputs stay in the private lab outputs.

The earlier verification includes 42 real
WABT CLI/MCP cases and the complete real SQLite CLI JSON: the unchanged default
returns the same original source Evidence ID, normalized result and raw result
as the baseline exported MCP record. Source bytes are unchanged. The seven-file
contract/composition run passes 51/52 assertions and hits the existing 20-second
presentation-test deadline while sharing one CPU. That same unmodified assertion
passes alone in 10.835 seconds. The original combined failure and isolated pass
remain recorded; no test deadline or REA bug was patched. Build, type/lint/module
checks and generated-document checks pass. No full `check:pr` or unverified
provider/platform coverage is implied.

## Actual old Evidence migration

The migration experiment imports the original
baseline SQLite Evidence bundle into the pilot runtime, reads a typed summary
and four export forms, and exports the retained bundle again. The complete old
WASM record is deeply equal after import/export, with its original authenticated
Evidence ID. The original baseline Obsidian complete inspection also works as
inline input to the new inventory summary, retaining the old parent and atomic
inventory identities and manifest. Original input files remain byte-identical.

The runtime explicitly selects an absent WABT directory and requests no producer
operation. These views consume existing Evidence without another provider run;
this is portable-result reuse through existing import/export, not an engine
database cache. The five-call workflow completes in 5.458 seconds with a sampled
aggregate peak of 700,542,976 bytes and no observed limit or OOM events.

To repeat it with genuine old public outputs:

```sh
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/verify-migration.mjs \
  --runtime-root /absolute/frozen-pilot-runtime \
  --revision 259e99dd906290189217cf0fb1a19769bcf87101 \
  --bundle /absolute/baseline-exported-evidence.json \
  --inspection-reply /absolute/baseline-complete-inspection-reply.json \
  --output /absolute/new-migration-directory
```

## PR integration verification

The separate post-integration verification pins runtime
`0eb42a1eb8ab17aed04240174cb77612e733a1d8`, integrated with main
`c22111eca2c4bc84a084f12711f405b3e7422a40`. Conflict resolution preserves main's
HAR API-surface views, portable capture admission, exact layout/JavaScript
summary carriers and existing CLI tests alongside inventory/WASM views.
Earlier real-model observations keep their original runtime fingerprints.

Build, the complete `check` static gate and generated documentation checks pass.
Twelve focused files pass 123 assertions, including the presentation test run
separately with its original deadline. Actual package creation, private-prefix
installation and 42 real WABT CLI/MCP cases pass. No package is published.
The complete generic package verifier and full local `check:pr` were not run.

Genuine old SQLite/Obsidian Evidence migration passes again with WABT unavailable.
A fresh public SDK cohort preserves the original Obsidian default result size
(937,404 compact JSON bytes), atomic inventory identity and every selected fact;
explicit summary plus exact paths still returns 16,322 bytes. Complete catalog
JSON is 2,359,082 bytes versus the original baseline's 2,326,609 (about 1.4%
larger). That difference includes intervening main changes and does not isolate
this PR's catalog contribution. One cohort is not a latency distribution.

Recorded integration scopes have no OOM/OOM-kill or hard-limit abort. The full
source-check scope reports three `memory.high` events near its 3 GiB soft
threshold. The subsequent cold pre-push type/lint scope reports 37 such events,
with 3,221,155,840 sampled peak bytes and no hard-limit/OOM event. Heavy lanes stay
serial with the existing CPU, memory and no-swap controls. No further REA bug repairs
are included; separate local findings remain for team follow-up.

## CI attribution

Review of the actual main and PR job logs separates two PR-related
description/test mismatches from pre-existing main failures. The complete-graph
wording check now accepts capitalization changes; the existing effects audit
records why returning WASM execution/network metadata is not foreign execution.
Those two files pass 11 focused assertions without production changes. Main's
own CI already fails the same live prompt-completion assertion and Darwin
packaged-completion checks; the affected implementation and fixture files are
byte-identical here. Those failures remain unchanged for team review at the
maintainer's request. CI failures are not all infrastructure faults, and the
failed CI gate is not presented as passed.

| Failure                                  | Main `c22111eca`                                                                         | Reviewed PR `8d6f7eb1c`                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Empty prompt completion after open       | [main shard](https://github.com/morluto/rea/actions/runs/38224038323/job/114727940506)   | [PR shard](https://github.com/morluto/rea/actions/runs/38228724531/job/114742955092)   |
| Packaged prompt completion, Darwin arm64 | [main package](https://github.com/morluto/rea/actions/runs/38224038323/job/114728030045) | [PR package](https://github.com/morluto/rea/actions/runs/38228724531/job/114743092314) |
| Packaged prompt completion, Darwin x64   | [main package](https://github.com/morluto/rea/actions/runs/38224038323/job/114728029923) | [PR package](https://github.com/morluto/rea/actions/runs/38228724531/job/114743092079) |

`src/server/promptCompletion.ts`, `src/application/binary/BinarySession.ts`,
`tests/boundary/mcp/promptCompletion.test.ts` and
`scripts/verify-package-prompts.mjs` are byte-identical to that main revision.
Main commit `07b36c148946f46b99a4ce04e55726e97d0ee03a` introduces ready-provider-only
completion; the failing fixtures expect populated completion immediately after
opening. Whether those expectations or the readiness behavior should change is
left for team review. Commit `00d51e0fcd1d1bba60bf56281725e82d525a27ae`
synchronizes only the two PR-related description checks.

## Frozen runtime references

### Review follow-up

Two substantive bot findings were reproduced and addressed before merge. Atomic
inventory projections now reuse the owning subject/digest/format validation.
Actual public SDK calls with original Obsidian data demonstrated the old
acceptance of null subjects and inconsistent formats; the corrected runtime
rejects both with `invalid_request`. Six boundary assertions also cover missing
subject, wrong format and wrong digest across summary and node views.

The related three-file run passes 37 assertions, and full static/docs gates
pass. Genuine baseline SQLite/Obsidian import/view/export still preserves whole
original records and source/view identities with WABT unavailable. A new real
Obsidian summary workflow preserves every selected fact, atomic source identity
and 16,322 delivered JSON bytes; catalog bytes remain 2,359,082.

Both experimental drivers reject undeclared inherited provider controls before
server/profile creation and log no values. Explicit settings still override
the corresponding inherited values. This prevents claiming equal declared
settings while silently inheriting a different analysis option; it does not
certify every aspect of the inherited system/runtime environment. These are
research-driver controls, with no production configuration changes.

The source/static scope records 98 `memory.high` events, no hard limit/OOM event,
and a sampled peak of 3,221,209,088 bytes. The real migration/Obsidian scope peaks
at 677,367,808 bytes with no limit/OOM events. All raw receipts remain outside Git.

A later WASM finding was also reproduced: portable sources with absent subject
or a different subject path could report another artifact path. The producer and
view now share an exact path/digest identity rule. Actual WABT inspection of the
published VS Code Tree-sitter INI grammar (0.3.1, 4,716 bytes, SHA-256
`1e8cdf3027209100fa54a43d0faed69721ae1116428164c8ad6dcc496a9aa6af`)
supplied the unchanged report for public SDK before/after checks. The old runtime
accepts both inconsistencies; the corrected runtime rejects both with
`invalid_request` and WABT unavailable. Its 26 focused assertions and type/lint
checks pass, and genuine old records still round-trip unchanged. The verification
scope peaks at 3,204,509,696 bytes with no observed limit/OOM event. The initial
CSS producer exceeded the MCP reply budget as expected; that failed probe is
preserved separately and is not credited as a completed identity reproduction.

These revisions identify different experiment stages; model measurements were
not rerun or relabeled as post-integration measurements.

| Stage                                          | Source revision                            |
| ---------------------------------------------- | ------------------------------------------ |
| Original baseline                              | `42b0ed126df7d5b908ac369715378d5e519051b7` |
| Inventory delivery pairs                       | `f110618184e99f89fa776bc5e59703a61baa7c57` |
| Initial WASM pilot                             | `0002caa07ffd7319672a21ce901dbfbc55e21aac` |
| Exact WASM summary guidance                    | `259e99dd906290189217cf0fb1a19769bcf87101` |
| Main-integrated package/migration verification | `0eb42a1eb8ab17aed04240174cb77612e733a1d8` |

The baseline runtime file-table SHA-256 is
`3a1765a6fec0031db0b288112d4db9bc0dd503c9c3aa0946f07ce57f7673ab4b`;
the integrated runtime file-table SHA-256 is
`e99d3bdc851822b77e7d5bfaa9b60c57e7b99bd66e27a739bdea2e9300560d5f`.
The integrated lockfile SHA-256 is
`0a55042141899a442a39dce3d49755c65a861f86d1930bd4f9c6d89cd53f5eba`.
Actual old migration inputs have SHA-256
`e1ff3d28801436bcc11693f79cc847a4f31234f49d88449f9e0d77215c3765fc`
(SQLite bundle) and
`7cecd07012bb79f3afad2ea9e70357e056e9eab48c1aa13bbbd310cdcb43eb9f`
(Obsidian complete inspection reply). The source WASM identity
`ev_16b9f6e0fcefcab9603f14fd5e63ea00c4749accd94fef4a4e9fbb260d2e0140`
and atomic inventory identity
`ev_22c17e52489f3ec0e7298a62da37bd985dbbec202d7208a0bb1c20d863790aed`
remain unchanged after the recorded import/view/export workflows.

### Complete carrier identity and provider search configuration

The outer `inspect_artifact` carrier now uses the same owning subject/digest/format
validator as its atomic inventory. Invalid imported/inline carriers are rejected
before selected-view construction; the generic historical Evidence parser and
valid complete records are unchanged. Six additional boundary assertions cover
missing subject, wrong format and wrong digest across summary/node projections.
The negative checks use the small keyed-archive workflow so the original large
ZIP retention/capacity workflow keeps its existing deadline and distinct coverage.
An initial large-workflow placement timed out and is retained as a failed attempt.
The three public MCP workflows, build, fast static gate and generated docs pass.
The final static/test scope observed one soft `memory.high` event, with no hard
memory, task-limit, OOM or OOM-kill event; it is not a performance trial.

Both research drivers fingerprint the effective provider `PATH`, including an
explicit caller override, without serializing its value or the ambient environment.
The SDK comparator rejects absent or unequal search-path fingerprints. This
records search configuration, not executable replacement at an unchanged path;
provider/runtime identities and controlled host conditions still matter.

Actual public SDK calls using the original shipped Obsidian inspection reproduce
accepted null/wrong-format outer subjects on frozen `2ef0467bb` and `invalid_request`
on the corrected compiled runtime. Two fresh Obsidian replays with different
inherited search paths preserve selected facts and source identities, but the
comparator rejects matching settings with only `provider_search_path_sha256`
different. The original records and failed/accepted replies stay in private lab
receipts; no environment value is copied into them.

### Resource-counter closeout qualification

The experimental wrapper now attempts a final cgroup event read before waiting
or cleanup. Disappeared/incomplete counters or still-owned descendants make
`resource_counters_verified` false; last observations remain available separately.
The model grader treats missing final counters as unverified, never as zero,
and any recorded soft/hard/task-limit event prevents an unrestricted resource
pass. Lightweight parser probes cover missing/incomplete and nonzero counters;
an actual short command confirms disappearance is reported as unknown. Regrading
one already-correct SQLite model answer preserves its facts but rejects the old
receipt's absent final resource counters. Earlier receipts record last-sampled
observations, not verified final counters. Their bytes, facts and token reports
remain original observations; resource-qualified performance conclusions need
this additional closeout evidence. No analyzer/build/schema/package behavior is
changed, so unrelated verification is not repeated for this research-driver fix.

The next bounded WASM delivery cohort is documented in [first-call summary measurements](wasm-first-call.md).

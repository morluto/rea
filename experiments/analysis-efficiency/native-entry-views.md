# Native PE and DOS entry-view checkpoint

Continuation of [#2016](https://github.com/morluto/rea/issues/2016) after
#2122 and #2193 merged. Real Ghidra observations and real Codex CLI answers
support the selected native facets on these shipped inputs. They do not justify
an automatic native summary policy: the four selected replies are larger than
the complete dossier for the small PE entry, and smaller for the DOS entry.
The initial complete analysis still runs and is delivered in both cases.

This checkpoint changes experiment scripts, corpus inputs and grading only.
Existing production CLI/MCP contracts, defaults and session behavior are unchanged.

## Inputs and runtime

Production runtime: main `10400fdb57e4226c5ce15af17968a664f35498ce`,
including the merged WASM summary work and subsequent main changes. Node
24.18.0/npm 11.16.0, locked dependencies, actual Ghidra 12.1.4 on Linux.
Default auto-analysis remains enabled, with a 768 MiB JVM ceiling and one
active processor. The whole process family uses the existing one-CPU,
4 GiB hard/3 GiB early-stop, no-swap, bounded-task resource scope.

| Shipped artifact                   | Selected bytes | SHA-256                                                            | Static scope                                                                                                  |
| ---------------------------------- | -------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| ShareX 19.0.2 `ShareX.exe`         |        198,656 | `46af1ccc514b395cb703633abb5a505a771942b7db9b1915f31aeea541b3685f` | Native PE32+ x86-64 component with no CLR directory; entry `0x1400125c0` derived from original image base/RVA |
| FreeDOS EDLIN 2.24 `BIN/EDLIN.EXE` |         31,492 | `96b2b6d543e2d8bdc83e313756444e103339eb5ee2c1229abe3607539b31ad6e` | Original UPX-compressed DOS MZ; admitted entry `0x10000`, independently verified static load image            |

Acquisition URLs, archive sizes/digests and exact regular ZIP members are in
[corpus.json](corpus.json). EDLIN's package `APPINFO/EDLIN.LSM` reports its
version and UPX compression. No binary was executed, unpacked or committed.
The independent PE header does not establish Windows runtime behavior.
DOS load-image verification and unpacking-stub pseudocode do not recover the
editor's application logic or establish DOS execution. DOS COM is still untested.

The SDK and frozen model runtime share the exact `dist/` and `bridge/` file
table digest:
`e2b67eb0966072fd8b159edfab074cbaf1db9bfc0ac9c57d25ba1435cc0fdbcf`.
The model copy was independently checked against all 1,375 compiled files and
30 bridge files. Runtime copies and detailed receipts remain outside Git.

## Public SDK observations

The workflow opens the selected target with Ghidra, resolves the entry,
calls `analyze_function` once, reads retained procedure/pseudocode/callers/callees
facets, and closes the ephemeral session. DOS obtains its address from
`inspect_native_load_image` before resolving the procedure. Each facet is checked
against the complete producer facts, original parent ID, target digest and distinct
derived Evidence ID. The actual SDK validates named advertised output contracts.

| Entry        | Complete dossier JSON bytes | Four facet replies combined | Workflow seconds | First provider query seconds | Last-observed family CPU seconds | Sampled family peak MiB |
| ------------ | --------------------------: | --------------------------: | ---------------: | ---------------------------: | -------------------------------: | ----------------------: |
| ShareX PE    |                      50,936 |                      68,257 |           63.123 |                       57.490 |                           63.660 |                1,197.85 |
| EDLIN DOS MZ |                     224,670 |                      70,539 |           26.436 |                       21.366 |                           26.899 |                  939.25 |

These are exploratory observations, not a paired implementation performance
cohort. JSON byte counts include the SDK tool-result representations, excluding
catalog discovery and wire framing; they are not model token counts. Four PE
facets cost about 34% more bytes than that dossier. The DOS facets cost about
69% fewer bytes **when reading already-retained Evidence**. Their first analysis
still returned the full dossier; summing both paths increases first-task traffic.
The first provider query includes the observable wait for the imported Program
and its analysis, not an independently measured engine-only stage.

The observed PE entry contains 18 analyzed bytes, zero recorded callers and two
resolved callees. Ghidra's terminal-call caveat remains explicit. The DOS entry
contains 53 analyzed bytes and zero recorded callers/callees; overlapping
instruction and abnormal stack-frame warnings remain in the pseudocode.
Neither zero count establishes absence of unresolved runtime calls.

An earlier PE probe completed production analysis and two facets, then failed
its harness assertion: a pseudocode page is `{text, unit}`, not a string. That
failed attempt remains archived and is excluded from successful workflow figures.
The corrected exploratory SDK driver fingerprints are
`4876c0ecaa84069ddc508e29649715c6c914bd3c4960a76fa9724b5992123699`
and native-helper `76023ad45cd1edab57dcd4a8ccf29a9b8a8378029ff2d9711ae35c73940e80d6`.
The published helper in `6d7f6885c` removes redundant scopes; replaying the actual
PE/DOS replies reproduces every answer field and the same 9/10 calls. Recorded
real jq entry and entry/main replies also preserve their selected facts, profile
and 4/12-call ordering. These replays are driver regression checks, not fresh
provider runs or timing measurements.

## Real Codex CLI observations

Three serial runs used Codex CLI 0.161.0, requested alias `gpt-5.6-terra`, high
reasoning, temporary isolated profiles and the frozen modified REA MCP runtime.
Resolved server-side model identity is not inferred. The same explicit seven-tool
subset was enabled: open, containing-procedure resolution, dossier, analysis view,
load image, retained Evidence discovery and close. This is not full-catalog tool
selection verification. Questions are [PE](questions/native-pe.txt) and
[DOS](questions/native-dos.txt).

| Trial | Total input | Cached input | Uncached input | Output | Seconds | Calls / failed |
| ----- | ----------: | -----------: | -------------: | -----: | ------: | -------------: |
| PE 1  |     451,337 |      399,616 |         51,721 |  3,820 | 130.073 |         12 / 2 |
| DOS 1 |     730,578 |      658,944 |         71,634 |  3,310 | 134.435 |          9 / 0 |
| PE 2  |     498,322 |      429,056 |         69,266 |  3,038 | 192.373 |          9 / 1 |

All three answers match the selected original digest, address, procedure
classification/signature/locals, inclusive body ranges, body byte count,
pseudocode prefix and relationship counts. Actual Evidence references were
observed in the responses; target bytes remained unchanged, close completed and
the copied profiles were removed. DOS additionally matches the verified load
status and every supplied load-image metadata field. Manual review preserves
static/packed-target and terminal-flow qualifications.

The first grader expected only particular nested JSON shapes. It rejected PE's
equivalent text-page object/inclusive-range label and could not grade DOS's
explicit `entry @ 0x10000` display. The updated grader compares exact source
values for those representations without parsing displays into lookup identities.
It still rejects wrong text units, returned lengths, body endpoints and missing
facts. Original answers and first grading attempts remain archived; regrading
does not repeat model calls or change their tokens/times.

The PE agent hit the advertised-but-unimplemented native summary recipe: both
trials attempted `view: {kind: "summary"}`; the first also tried the invalid
native facet `summary`. Those failed calls and all subsequent recovery/repeated
reads remain included. The public SDK independently reproduced `invalid_request`
for native summary on both inputs. This pre-existing contract-description mismatch
is recorded in `/tmp/rea-analysis-efficiency-bugs-20261012.md` for team repair,
as requested; this branch does not repair it.

Model sampled peaks were 1,318.74 / 1,017.70 / 1,234.92 MiB, with last-observed
family CPU 72.956 / 71.534 / 74.089 seconds. SDK/model scopes did not abort and
their last-observed limit-event counters were zero. Final cgroup counters remained
unavailable after scope teardown: the strict resource-qualified overall grades
remain unverified. The selected fact/lifecycle checks pass; no universal latency,
OOM absence or CPU/memory saving is inferred from these samples.

## Reproduction and next decision

Use the pinned toolchain and build the selected production revision. Keep its
runtime copy, matching dependencies, provider settings, binaries and receipts
outside the checkout, as described in [README.md](README.md).

```sh
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/frozen-runtime --revision EXACT_PRODUCTION_SHA \
  --artifact sharex.exe --path /absolute/ShareX.exe \
  --providers /absolute/explicit-providers.json \
  --native-question entry-views --schemas selected \
  --output /absolute/new-native-measurement
```

For DOS select `--artifact freedos.edlin.exe` and the original extracted
`EDLIN.EXE`. `--native-question entry` retains the existing compact experimental
answer; `entry-views` performs additional verification reads and the explicit
summary refusal probe. It does not select summary delivery from `analyze_function`.
The helper fingerprint participates in comparison, and missing native helper
fingerprints are not treated as a comparable current driver.

The reviewed `entry-views` answer separates selected facet facts from run-specific
references: `evidence_ids.retained_views` retains each facet's original view and
parent ID, while `retained_views` holds its item, coverage, limitations and unknowns.
DOS load-image facts retain their source ID and must match the selected carrier
digest before their entry address can be used; a stale result closes the session
without querying a procedure.
Derived view IDs are checked against every prior producer reference as well as
other derived views. DOS model grades require the actual completed load-image
response and its reported source ID; status, digest, entry and supplied metadata
are checked against that observation. Missing, failed or unreferenced responses
cannot establish load-image verification.
The comparator preserves both runs' reference maps and compares the facts. Existing
`entry`/`entry-and-main` answers keep their ID arrays. Historical SDK receipts above
retain their original pre-review representation; no replies or measurements were
rewritten, and no provider/model runs were repeated for this representation fix.

Relevant validation includes the real workflows above, recorded-reply regression,
grader negative probes, JavaScript/Python syntax, formatting/diff checks and
`npm run check:fast`. The cold type/lint gate passed in 112.602 seconds with
sampled peak 3,220,914,176 bytes and five last-observed `memory.high` events;
this gate is not a performance-qualified experiment. Unrelated domain suites,
packaging and earlier model cohorts were not rerun for this experiment-only change.

The next useful comparison is question-specific native primitives versus a
complete dossier, with identical requested facts and actual model trials.
Larger PE functions and another unpacked DOS/COM application can extend the
coverage progressively. Preserve existing complete defaults and solve the
summary-description bug separately before recommending a native summary route.

# EVM interface delivery and migration checkpoint

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the static
descriptor merged in [#2261](https://github.com/morluto/rea/pull/2261). Opt-in
`inspect_evm_interface` MCP `detail: "summary"` returns every inferred interface
candidate without bytecode hex or duplicate stdout. Complete Evidence remains
retained under its original identity. Delivery bytes fall; the measured model
cohort does **not** establish a stable token or task-time improvement.

## Frozen scope

Control production is `ad08510a113d7a9b8d92fb1e385757880e469869`; candidate
production is `32c7548b9ae5c8cda348653d177b1747127c74ba`. Their compiled file-table
SHA-256 values are respectively
`f68e85030cb05082520ea9f0d7650298ae316ce7bba59a8942e0cc1318ae9850` and
`978b3a014e3b2a1e1c6620364dcd793fa7cb40f19892d44cfb0312739a8c14a3`.
The SDK driver SHA-256 is
`a95d8d8e9f72c0b2b885c61907ed13054ebf7d1642f6f13b0126163840b1221a`.
Driver commit `03bff83e70e09a917341c1fe3ebffbfdc67785c5` fixes only reading the
public `get_evidence_bundle.result.records` envelope; production is unchanged.
Both runtimes use Node 24.18.0, matching locked dependencies, SDK client/server
2.3.1 and unchanged bundled EVMole 0.9.3.

Inputs are the digest-pinned WETH historical hex carrier and Uniswap v3-core
1.0.1 Factory/Pool compiler runtime templates in [corpus.json](corpus.json).
Original carrier and decoded-byte identities remain distinct. Templates are
not authenticated deployed instances; constructor-dependent values and absent
immutable-reference metadata stay unknown. No chain, target execution or
signature lookup is introduced.

## Public SDK pairs

Two pairs per artifact run serially: complete control then selected candidate,
followed by candidate then control. Each starts a fresh MCP process, discovers
the catalog and validates the actual named advertised schema. Host caches are
not independently controlled. All six fact/settings comparisons pass. Both
answer projections omit unrequested hex; original complete replies remain intact.

| Input   | Complete / summary result bytes | Reduction | Control seconds, 1 / 2 | Candidate seconds, 1 / 2 |
| ------- | ------------------------------: | --------: | ---------------------: | -----------------------: |
| Factory |                110,424 / 14,442 |    86.92% |          3.670 / 3.766 |            3.664 / 3.867 |
| Pool    |                110,998 / 19,922 |    82.05% |          4.110 / 3.740 |            3.977 / 3.870 |
| WETH    |                 26,760 / 15,378 |    42.53% |          3.671 / 3.710 |            3.930 / 3.673 |

These measurements support smaller delivery, not faster interpretation. Analysis
still runs and the full parent still incurs producer/retention costs. Catalog
count and order stay at 184 tools. The complete catalog grows from 2,422,229 to
2,429,938 compact JSON bytes (+7,709); all name/description/input definitions
grow from 512,655 to 514,074 bytes. The EVM input definition grows from 1,443 to
2,029 bytes. Only `inspect_analysis_view` and `inspect_evm_interface` definitions
change. These discovery costs are visible and are not converted into token counts.

Nine separate measurements verify new-server complete defaults, old-server
summary fallback and retained reads for all three inputs. The four-call retained
proofs retrieve the complete canonical parent plus pages and cost 160,110,
177,106 and 79,160 bytes for Factory, Pool and WETH respectively. They are
verification workflows, not examples of one-call delivery savings.

## Real Codex pairs and answer qualification

Twelve serial Codex CLI 0.161.0 trials use the existing identical questions for
each pair, the same artifact path, one enabled EVM tool, temporary MCP profiles
and requested `gpt-5.6-terra` high. The requested alias is not proof of the
resolved model identity. Trials include schema discovery, reasoning, one actual
successful EVM call and final answer. No call fails or retries. Profiles are
removed and input bytes remain unchanged. This fixed one-tool profile does not
test selection from the full catalog.

| Input / repetition | Uncached input, control → candidate | Seconds, control → candidate | Candidate delivery |
| ------------------ | ----------------------------------: | ---------------------------: | ------------------ |
| Factory / 1        |                     22,901 → 25,668 |              52.485 → 48.768 | summary            |
| Factory / 2        |                     37,181 → 15,270 |              53.404 → 45.345 | summary            |
| Pool / 1           |                     36,652 → 26,657 |              57.764 → 66.642 | summary            |
| Pool / 2           |                     28,305 → 36,259 |              62.068 → 71.756 | complete           |
| WETH / 1           |                     21,128 → 25,187 |              44.869 → 46.809 | summary            |
| WETH / 2           |                     17,417 → 17,529 |              30.364 → 39.943 | summary            |

Keep all trials, including the candidate that explicitly chose complete delivery.
Five of six candidates select summary, but uncached input improves in only two
pairs and time improves in only two. Aggregate control → candidate observations
are 362,496 → 357,770 total input; 198,912 → 211,200 cached input;
163,584 → 146,570 uncached input; 8,953 → 10,397 output; and
300.954 → 319.263 seconds. Cache state and model/service variation are not
separated; the aggregate does not establish a repeatable saving for an individual
question or a qualified performance recommendation.

Every answer passes exact core-field checks: both identities/byte counts, every
function selector/offset/dispatch/argument/mutability including null, inference,
unknown completeness/kind/hardfork/authenticity, and absent runtime execution.
All reported IDs occur in actual responses. However, the existing grader requires
the final limitation list to equal the producer list verbatim and in order.
Only three trials pass that additional check; nine fail. The questions request
preserving limitations but do not explicitly request a verbatim ordered list.
Four failures contain all original strings with extra correct scope statements
or different ordering. The other five paraphrase or omit source caveats, including
worker or upstream-metadata limitations. Do not silently waive those omissions
or turn these into twelve fully acceptable answers. The strict reports and
original transcripts remain intact; core-field success is a narrower result.

Model scope sampled peaks range from 562.5 to 710.5 MiB, with last-observed CPU
5.945–6.878 seconds. CPU includes the local process family, not remote model
computation. All heavy jobs use one CPU, a 4 GiB hard limit, 3 GiB early-stop,
no swap and 192 tasks. No scope abort occurs in this cohort. Final cgroup
counters are unavailable after teardown: final OOM/task/limit-event assertions
remain **unverified**. Last-observed counters are not substituted for final ones.
Consequently neither strict answer acceptance nor resource-qualified performance
success is claimed for the whole cohort.

## Existing-user compatibility

Omitted and explicit-complete MCP requests, the existing CLI and provider inputs
preserve their full behavior. `detail` is removed before the unchanged provider
input; original full Evidence parameters, raw result and identity are retained.
Summary receives its own identity linked to that parent. All candidate facts,
original report limitations, stderr/truncation and explicit unknowns stay inline.
Complete-within-view candidate coverage is not global discovery completeness.
Function pages retain original order; text pages use UTF-16 code units, with
hex characters distinguished from decoded-byte function offsets.

Actual new default replies for all three artifacts validate against the frozen
old advertised input/output schemas, and structured/text payloads agree. Older
servers reject neither request nor unsupported fields because the experimental
client discovers support before selecting summary and otherwise calls complete.
This is an explicit client fallback, not universal server forward compatibility.

Three authentic old-runtime records and old-created canonical bundles pass new
MCP import, retained summary, CLI inline summary and export. Original records,
IDs and bundle source bytes stay deeply equal. The reproducible verifier below
also checks function/hex pages with the analysis limiter explicitly unavailable,
so retained reads cannot silently start successful producer analysis. This
proves the pinned old/new Linux workflows, not every historical client release.

The initial retained experiment failed because its driver read the bundle's
wrong envelope. Correcting that consumer produced passing retained proofs; the
failed receipt stays archived and is not recorded as a REA defect. Separately,
one static-check attempt hit the unchanged 3 GiB early-stop. The bounded retry
passes with Node heap 512 MiB/native checker memory controls; its roughly 3 GiB
peak and soft-limit events are excluded from efficiency comparisons.

## Reproduction and checks

Use [the shared instructions](README.md), explicit frozen revisions/runtimes and
fresh private output directories. Run `measure.mjs` for `weth.hex`,
`uniswap-v3.factory.hex` and `uniswap-v3.pool.hex`, with `--schemas selected` and
paired `--delivery complete` / `summary`; run `compare.mjs` on equivalent pairs.
Add `--verify-retained` only for the separate four-call proof. Use the unchanged
[WETH](questions/evm.txt) or [template](questions/evm-uniswap.txt) question and the
same one-tool profile for `agent-trial.py`, preserving all usage and grader results.

Export complete Evidence with the old runtime's public ledger workflow, then run:

```sh
node experiments/analysis-efficiency/verify-evm-retention.mjs \
  --runtime-root ABS_FROZEN_NEW_RUNTIME --revision NEW_SHA \
  --bundle ABS_OLD_BUNDLE_JSON --output NEW_PRIVATE_ABS_DIR
```

The script acquires no dependencies and preserves the old bundle. Revision is
caller-supplied; retain the frozen file-table receipt alongside it. Raw JSON,
transcripts, profiles, bytecode, compiler inputs and generated artifacts stay
outside Git. This checkpoint adds source verification and curated observations.

The production change passes 64 focused EVM/WASM/generic-view/domain/service
checks and full static/docs gates. Recording provider seams establish exact
schemas, old defaults, inference/null preservation, historical identity failures,
peer availability, cancellation and cleanup retry; they are not real-provider
claims. Real-provider and shared-domain checks are recorded separately.

The same frozen candidate also passes six actual public MCP artifact workflows:
SQLite WASM with WABT summary, ShareX managed metadata, Obsidian inventory,
NewPipe with JADX, an OpenWrt region inspection, and jq entry analysis with
Ghidra. These are shared-contract regressions; they do not establish AST analysis
of all Obsidian code, full firmware reconstruction, browser coverage, or new token
savings in those domains. Native Windows PE and DOS coverage remains at the
[earlier native checkpoint](native-entry-views.md), not a new Ghidra/Windows claim.
The source retention verifier passes for all three authentic old EVM bundles,
including exact summaries, function/hex pages, CLI inline views and unchanged
exported originals with the limiter explicitly unavailable.

The frozen candidate passes all 59 existing real EVM CLI/MCP verifier cases with
caller-supplied solc 0.8.30 and strace 6.1, including malformed/unsupported
carriers, unavailable limiter and capacity failures. Its scope takes 96.076
seconds with 1,345,052,672 sampled peak bytes and 95.130 last-observed CPU seconds.
This is regression evidence, not an interpreter speedup comparison; final
resource counters remain unverified. Fresh fast static and generated-document
checks also pass after adding the migration verifier and this report.

## Latest-main integration

The branch rebases without conflict onto main
`0043d9b134c0a353e8bf85c0bde4492275f1f720`. Production integration commit
`3766749316c345ccb594b1b748747b1af9582b34` preserves the same EVM projection,
provider and delivery semantics; intervening main adds unrelated capabilities.
The above performance cohort stays pinned to its original frozen runtimes and
is not relabeled as a measurement of the larger integrated catalog.

At `cda794fb9d4a5ca2bd661853a899d579fb8a47b2`, all 30 affected EVM/WASM/generic-view
MCP tests pass again, as do full `npm run check` and `npm run docs:check`. A fresh
real Factory SDK selected-summary/retained-parent/page workflow and the original
Pool bundle's SDK/CLI migration verifier also pass against the rebuilt integrated
runtime. The latter still has an explicitly unavailable analysis limiter.

The initial integrated static-check scope stops at 3,221,446,656 sampled bytes,
just above the unchanged 3 GiB early-stop. Running the same typecheck through
its single Turbo task with less launcher overhead passes at 3,219,353,600 sampled
bytes; the subsequent full gate uses that valid cached typecheck and passes.
No memory threshold or check requirement is relaxed. Preserve both receipts;
these near-limit validation jobs are excluded from efficiency conclusions.

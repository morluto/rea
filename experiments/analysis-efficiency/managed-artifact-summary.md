# Managed artifact delivery and retained views

Continues [#2016](https://github.com/morluto/rea/issues/2016) after
[#2404](https://github.com/morluto/rea/pull/2404) merged. This checkpoint pins
the complete managed workflow before implementing another optional view.
The baseline below precedes implementation; the follow-up adds explicit summary
delivery and portable collection pages while preserving complete defaults.

## Frozen control and analyst question

Control source is merged main `ae8051302b5834322fa00cfa31c968ae74ab6ed9`,
Node 24.18.0, matching locked dependencies and actual compiled stdio MCP.
The frozen `dist/`/`bridge/` file-table SHA-256 is
`7a4cec0fa4f7e929356b50a6b13472f80bd6f526221e427125370cca3ef98d00`.
Measurement source SHA-256 is
`a95d8d8e9f72c0b2b885c61907ed13054ebf7d1642f6f13b0126163840b1221a`.

Use the digest-pinned shipped ShareX DLL from [the corpus](corpus.json),
2,162,688 bytes, SHA-256
`191a191be964e434daf0f9d76d1e0d8ddce90d7e248cba2a6b5ac9577f288d53`.
The [existing model question](questions/managed.txt) requests exact identity,
complete managed classification and its evidence, frameworks and every declared
native ModuleRef/PInvoke boundary with coverage and limitations. It explicitly
excludes unrelated resource/custom-attribute inventories. Analysis reads PE/CLI
metadata without loading or executing the assembly.

The current complete result has exactly the same normalized facts as the earlier
real managed checkpoint linked from [the EVM descriptor study](evm-descriptor.md).
This comparison does not equate fresh Evidence IDs, provider versions or whole
catalogs. Original target bytes remain unchanged; SDK-converted named schemas
and actual replies validate in the public measurement workflow.

## Observed data costs

| Public operation                    | SDK result JSON UTF-8 bytes | Tool milliseconds |
| ----------------------------------- | --------------------------: | ----------------: |
| `inspect_managed_artifact`          |                   1,270,839 |           450.306 |
| `inspect_managed_native_boundaries` |                      27,913 |           142.663 |

The complete workflow, including connection/discovery and both calls, takes
3.721 seconds. The full discovered catalog is 2,482,204 compact JSON bytes;
its input definitions are 527,569 bytes. These costs include the current main
changes and are not silently substituted for an older catalog baseline.

The artifact inspection's normalized payload alone is 607,605 compact JSON UTF-8
bytes, measured with actual Node `JSON.stringify`:

| Returned collection |  Rows | Compact JSON UTF-8 bytes |
| ------------------- | ----: | -----------------------: |
| References          |    38 |                   12,153 |
| Resources           |    36 |                   10,357 |
| Custom attributes   | 1,945 |                  582,586 |

Custom attributes dominate the payload. The remaining identity, PE/CLI,
classification, metadata, framework and coverage facts are comparatively small.
`raw_result` is null. SDK result size includes both structured and text
representations; it is not the exact context a model receives or a token count.

The serial owned scope takes 4.852 seconds including the driver, samples
520,110,080 peak family bytes and records 4.699 last-observed CPU seconds.
One CPU, 4 GiB hard memory, unchanged 3 GiB early-stop, no swap and 192 tasks
remain in effect. No guard abort occurs. Final cgroup counters disappear and
remain unknown; sampled zero events are not final no-OOM proof.

## Bounded candidate and acceptance

Evaluate an explicit overview on the first artifact inspection, retaining the
unchanged complete source and returning a distinct linked view. Keep complete
identity/classification, metadata status, nullable module/MVID, assembly,
frameworks, original coverage/issues/limitations and returned-collection counts
inline. Typed pages can expose original references/resources/attributes with
their nulls, token coordinates, offsets, order and values. Returned-array
coverage must remain distinct from whole-metadata completeness.

Reuse the existing managed schemas, retained Evidence application workflow and
named registration hooks. Keep omitted/complete requests, other managed tools,
selected target/provider behavior and original export/import identities usable.
Do not strengthen historical admission to require a non-null subject or
reinterpret foreign recorded paths through this host's filesystem. Delivery
selection must not be passed to the PE/CLI parser as an analysis option.

At the baseline checkpoint the candidate was not implemented or measured. Compare the
same completed analyst question, actual discovery/results, full default
compatibility and retained paging without producer reruns. Follow with other
shipped managed inputs, partial/unavailable metadata and real Codex trials with
strict factual/reference checks. Preserve failed or truncated transcripts.
Count total/cached/uncached input, output, calls/retries, whole-task time, CPU
and family memory before recommending a token or latency improvement. A smaller
reply alone is insufficient.

## Reproduce the control

Build and freeze the explicit source revision before editing production code.
Supply the original shipped DLL and an explicit string-valued provider dictionary
in a fresh private receipt directory:

```bash
python3 experiments/analysis-efficiency/resource-run.py -- \
  node experiments/analysis-efficiency/measure.mjs \
  --runtime-root /absolute/control-ae805 \
  --revision ae8051302b5834322fa00cfa31c968ae74ab6ed9 \
  --artifact sharex.dll --path /absolute/ShareX.dll \
  --providers /absolute/explicit-providers.json --schemas selected \
  --output /absolute/new-control-receipts
```

Raw replies, runtime copies, fingerprints and detailed resource receipts stay
outside Git. No new provider, plugin SDK, database cache or target execution is
introduced by this baseline.

## Implemented candidate and real SDK observations

Candidate `8bc1601ca51e417ca472d90ea0367e9418a1a0f2` adds
`inspect_managed_artifact({path, detail: "summary"})` and managed collection pages
through the existing `inspect_analysis_view` contract. The complete parser result
remains retained. Omitted detail and explicit `complete` keep complete output;
other managed tools do not acquire this selector. CLI inspection stays complete.
The frozen candidate runtime file-table SHA-256 is
`9e7380f537301bf0cfe2926f5619011af848af7c220750e75189498e65d825e1`.
The revised measurement driver SHA-256 is
`8c22f59e931fdc347dea1204ea0faf91330578db684357261ec6f03bd0efa85e`.

Use `--managed-question identity` on **both** sides, with `--delivery complete`
for the control and `--delivery summary` for the candidate. The original default
`inventory` recipe remains unchanged. Both identity recipes make the same two
public calls, validate their advertised SDK schemas, and compare complete
identity/classification, frameworks, coverage and native-boundary facts.

| Artifact              | Complete metadata bytes | Summary metadata bytes | Complete two-call bytes | Summary two-call bytes |
| --------------------- | ----------------------: | ---------------------: | ----------------------: | ---------------------: |
| ShareX.dll            |               1,270,839 |                 10,549 |               1,298,752 |                 38,462 |
| ShareX.HelpersLib.dll |               1,296,839 |                 10,937 |               1,586,970 |                301,068 |

The helper assembly is a second shipped member of the same pinned ShareX release,
1,076,224 bytes, SHA-256
`e91bd1ec904e2bb8a1add4bb6187443b878bf33d24fe9e27f0b799bfee9de33d`.
It is not an independent application or a new runtime/provider lane. Its native
boundary report remains comparatively large and unchanged. Metadata reply bytes
fall by about 99.17% and 99.16%; two-call totals fall by about 97.04% and 81.03%.
The first committed-candidate observations take 3.699 and 3.838 seconds, versus
3.809 and 3.925 seconds for controls. These timings include discovery and do not
establish a general latency improvement. The full candidate catalog grows from
2,482,204 to 2,497,635 bytes; input definitions grow from 527,569 to 528,862.

An earlier dirty prototype produced the same runtime file-table hash and a
separate provenance receipt. Its observations remain separate; a clean baseline
commit is never presented as the source of uncommitted production changes.

## Actual Codex findings: token benefit is not established

Four sequential trials use actual Codex CLI 0.161.0, requested model
`gpt-5.6-terra`, high reasoning, the unchanged question above and the same two
enabled tools. The requested alias does not prove a resolved server model ID.
Order is control, candidate, candidate, control. Both candidate trials independently
select summary; all trials preserve dependency order, make two successful calls,
leave the artifact unchanged and remove temporary profiles.

| Trial       | Input tokens | Cached input | Uncached input | Output tokens | Wall seconds |
| ----------- | -----------: | -----------: | -------------: | ------------: | -----------: |
| Control 1   |       54,821 |       29,184 |         25,637 |         1,782 |       63.207 |
| Candidate 1 |       77,594 |       50,432 |         27,162 |         1,583 |       46.685 |
| Candidate 2 |       82,426 |       49,408 |         33,018 |         2,120 |       67.379 |
| Control 2   |       55,296 |       29,184 |         26,112 |         2,361 |       62.159 |

Uncached input is reported input minus cached input. **Candidate input and
uncached input are higher in both comparisons.** Latency is mixed. This feature
demonstrates smaller selected delivery, not measured model-token savings or a
stable whole-task speedup. Event result bytes are also not a measurement of the
exact context presented to the model. No hidden truncation/cache mechanism is
inferred from these aggregates. Keep further model-context investigation separate
from this additive view implementation.

The question prescribes a `coverage` field without prescribing its nested labels.
The grader now accepts only explicit equivalent artifact/native scope names;
conflicting duplicate scopes still fail. Original failure receipts remain intact.
Control 1 and both candidates pass the selected factual checks after that
correction. Control 2 omits `classification.container` and does not report
separate artifact/native coverage in the expected representation; it fails these
strict selected checks. The prompt did not specify every nested key, so this is
also an answer-representation limitation. It is not counted as a fully acceptable
control answer or repaired by assuming ambiguous flat coverage. Original
limitations were additionally reviewed against producer replies.

All four reports still fail the **complete** selected gate because final physical
resource counters are unavailable. The factual subset is reported separately;
it does not turn unknown final resource counters into a pass. Trial guards remain
unchanged, no guard abort is observed, and sampled peaks stay below the 3 GiB
early-stop threshold. A sampled zero OOM count is not final no-OOM proof.

## Previous-runtime Evidence compatibility

Complete actual producer Evidence from control `ae8051302b5834322fa00cfa31c968ae74ab6ed9`
for both shipped assemblies is passed, unchanged, through the candidate's public
SDK inline view. Each artifact makes 14 view calls: a summary, all original
reference/resource/attribute pages at a caller-selected 256 rows, and exhausted
pages for each collection. Summary facts, every row and order, source coverage,
parent ID, links and target digest match; the original Evidence stays unchanged.
ShareX has 38/36/1,945 reported rows and HelpersLib has 49/17/1,988. No producer
operation or target mutation is requested by this portable workflow.

The private verification driver SHA-256 is
`7bb1f24b488beda012b1e78132de29b868fe1ea91a5e1499d7f271801fa40380`;
the receipt scope takes 5.860 seconds, samples 642,244,608 peak family bytes and
5.619 last-observed CPU seconds, with no guard abort. Final counters remain unknown.
These are actual previous-runtime records, unlike the separate synthetic
null-subject compatibility test. They do not prove every historical release.

Focused SDK/domain checks cover first-call summary, complete defaults, selected
target reuse, paging after the source disappears, malformed metadata, historical
null subjects, digest mismatch, portable projection and unavailable retention
before file access. The exact candidate CI passes all checks after only the
browser cleanup and Apple `hdiutil` jobs are retried on the same source revision;
their original failures remain recorded in the private team handoff.

## Committed-runtime repetition and complete defaults

A second SDK pair reverses the order (candidate before control) for both
assemblies. Result byte totals repeat exactly. ShareX workflow times are
3.644 versus 3.687 seconds; HelpersLib times are 3.714 versus 3.859 seconds.
Both pairs preserve selected settings/facts and have no tool errors. Two pairs
per assembly, sharing one application and host, remain a narrow descriptive
sample rather than a general performance claim.

Actual omitted-detail calls on the candidate additionally reproduce **all**
normalized metadata inventories and native-boundary facts from both controls,
not just the identity recipe's selected subset. Their canonical complete
Evidence IDs also match. This verifies the recorded old request and complete
result path alongside the explicit new delivery option.

The changed shared projector also handles an actual shipped SQLite WASM run
through the candidate's SDK summary workflow, with real configured WABT:
two calls, 18,687 result JSON bytes, 5.614 seconds and no tool failure. This
checks that neighboring dispatch path; it does not establish a new WASM
performance improvement or additional operating-system/provider coverage.

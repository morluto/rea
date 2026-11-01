# Capability composition verification — 2026-11-01

Scope: issue #8429, the service composition/ownership increment of #740. Baseline
`6e9ee97a69cb16c7150d8b550e705cba055ee4f0`; implementation `bd9bf76d8`, followed
by type-only binding cleanup `161c3c146`. This changes existing composition,
metadata ownership and cleanup bookkeeping; no new provider/target authority.
`BinarySession` keeps its existing transition/admission barrier.

## Executed source and boundary checks

Full typecheck, module boundaries, architecture guards, test discovery,
production reachability, documentation consistency and repository formatting
passed. Changed-file typed lint passed with one worker and `GOMEMLIMIT=512MiB`:
39.622 s elapsed, 39.261 s process-family CPU, 2,945,368,064 B kernel peak.
Initial whole-repository typed and ordinary lint attempts hit the configured
3 GiB early stop; no OOM occurred. Whole-repository lint is not locally
qualified; changed-file checks and the final ownership-boundary typed checks
passed separately.

Relevant executed groups: 216 parser/boundary/metadata/provider-owner tests;
5 scope/factory tests; 27 MCP availability/composition tests; 28 deferred
startup/protocol/publication tests; 50 CLI factory/cleanup/target-input tests;
16 SDK schema tests; 4 compiled-verifier metadata link tests; and investigation
lifecycle, unknown-history and transport cleanup regressions. These groups
contain overlapping repeated checks and are not a unique total. The final
Android transport group passed all 4 cases, including construction failure and
failed cleanup retry. The moved Frida test body was preserved byte-for-byte;
its discovery owner changed to the adapter lane.

The old manual provider-close list was temporarily restored as a negative
control: the new successful-peer cleanup regression failed, then the current
source was restored. Synchronous close throws, undefined rejection reasons,
concurrent close joining, borrowed optional observations and failed-owner retry
are controlled tests, rather than claims of natural failures in real engines.
An initial new transport assertion omitted the existing outer
`OwnedMcpServers` AggregateError; its expected nesting was corrected. Other
preserved harness failures were missing SDK catalog preparation and two wrong
CLI test paths; corrected commands passed. One formatting issue was corrected.

Ordinary Knip reports one unused exported `DarwinHelperCache` type at
`src/process/DarwinHelperCache.ts:465`. An independent run on the clean pinned
baseline reports the identical sole issue; that file is unchanged here.

## Real applications and complete-result parity

Every case used actual public CLI/MCP routes. Inputs were hashed before/after,
with no source mutation. Both arms used pinned Node 24.22.1/npm 11.16.0 and
fresh isolated processes/configuration; OS page caches were uncontrolled.

| Domain     | Genuine application/artifact                                        | Independent fact oracle                         |
| ---------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| Go         | installed GitHub CLI `/usr/bin/gh`, Go 1.19.6                       | ELF Go build-info bytes/module data             |
| Managed    | SDK 8.0.427 `NuGet.CommandLine.XPlat.dll`, selected Program members | independent dnfile metadata/CIL facts           |
| JavaScript | installed agent-browser 0.27, selected entry source                 | original source declarations/imports            |
| Android    | NewPipe 0.29.1 APK inventory/application graph                      | complete ZIP member census and 9 member digests |
| WASM       | actual CSS WASM artifact with WABT 1.0.42                           | independent raw sections/types/exports          |

All five full public CLI Evidence results matched across arms. Explicit Go/JS
per-arm bundle output paths were verified separately, and their complete saved
parent Evidence matched. MCP performed 117 calls per arm, including six fresh
producer calls, retained derivation, repeated close, checkpoint/reset, expected
missing references, same-process restore and actual fresh-process restore.
Complete producer bundles, full derived Evidence, exact requests/IDs and
complete checkpoints matched across arms. The analyst Unknown revision 1→2
history and every canonical mutation/history record remained authenticated;
fresh re-exported checkpoints were byte-identical. Fresh consumers ran no
producer calls. Ten independent domain fact assessments passed.

| Completed workflow       | Baseline elapsed / CPU (s) | Feature elapsed / CPU (s) | Baseline / feature kernel peak (B) |
| ------------------------ | -------------------------- | ------------------------- | ---------------------------------- |
| Five CLI tasks           | 17.675 / 16.268            | 22.192 / 20.667           | 393,936,896 / 390,504,448          |
| Five MCP lifecycle tasks | 68.270 / 65.500            | 61.201 / 58.041           | 731,680,768 / 776,331,264          |

Times are single observations including setup and all calls, not a causal
speedup/regression claim. Fresh-process tasks are reported separately from
same-process/restored consumers; neither is a controlled cold OS-cache run.
All tasks ran serially under a one-CPU, 4 GiB hard/3 GiB early-stop, no-swap,
192-task guard. CPU and peak memory are kernel process-family counters at
payload exit while the observer remained alive; all completed tasks verified
owned cleanup and no OOM. Sampling/RSS is not substituted for these counters.
Scripted checks do not incur model tokens; model usage is recorded separately.

## Native engine and Codex CLI

Real Ghidra 12.1.4/JDK 21 on `/usr/bin/jq` passed 37 public MCP calls per
arm. Two new light address queries before/after healthy investigation reset
returned identical Evidence. The same MCP client retained the same owned JVM
PID, start time, process group and public run identity. Three retained native
compositions used authenticated historical dossiers; these dossiers were not
regenerated. Full derived results, original bundles and Unknown histories
matched across arms and survived same/fresh-process restore.

A mixed-routing task passed 58 calls per arm, with explicit `jq → APK → managed`
metadata target switches and five new static producer families through the final
registry. These metadata switches do not imply launching every target engine.
Complete originals, derived results and checkpoint history matched across arms.

| Completed task              | Baseline elapsed / CPU (s) | Feature elapsed / CPU (s) | Baseline / feature kernel peak (B) |
| --------------------------- | -------------------------- | ------------------------- | ---------------------------------- |
| Ghidra/native lifecycle     | 38.196 / 36.804            | 41.741 / 40.369           | 1,111,789,568 / 1,098,362,880      |
| Mixed target/domain routing | 27.557 / 26.984            | 27.255 / 26.527           | 1,039,253,504 / 1,037,910,016      |

The native task includes a fresh engine start; its second query is a healthy
same-engine observation. Historical dossier reuse and fresh process consumers
are separate phases. These are single observations with uncontrolled OS caches.

Local `codex-cli 0.165.0` ran one actual `client-code` trial with the requested
`gpt-6.1-terra` alias, reasoning `high`, and 19 selected tools. The resolved
server-side model identity is not inferred. It completed 32 MCP calls across
JavaScript, managed, Android and WASM: five new producer calls, retained
compositions, four expected missing-reference controls, close/reset/save/import
and Unknown revision 1→2. There were no unexpected MCP errors or timeout.

The model's JS self-check remained explicitly **partial/unverified**: it used
`JSON.stringify`, whose property ordering changed after canonical import.
Independent full structural comparisons of all three actual results and the
baseline proved identical fields, values, array order and Evidence ID. The
first ordering difference was only the keys of
`graph.nodes[0].observations[0].properties`. This distinction is retained in the
assessment; the model's self-check is not relabeled a complete pass.

An actual new, target-free MCP process replayed the model's checkpoint in
9 calls. Complete Evidence and Unknown revision/mutation histories authenticated,
and its 18,968,472 B export was byte-identical (17 Evidence records,
2 Unknown revisions, 1 head), SHA-256
`165188d74298f0173c5730973ecb5354a1b966ca54ec46ee177efa049ebbc755`.
All four derived results and their complete producer records matched the
independent baseline. The copied authentication profile was removed; runtime,
production source and selected input hashes remained unchanged.

Actual client usage for the single attempt: **336,490 input tokens**, of which
**295,680 were cached**; **3,659 output tokens** and **250 reasoning output
tokens** were reported. Cached input is a subset, not an additional token total.
Baseline model usage was not measured; neither token savings nor a speedup is
claimed. Scripted source-fact and fresh-process verifiers incur no model API
tokens and are separate from this model usage.

| Completed verification              | Elapsed / process-family CPU (s) | Kernel family peak (B) |
| ----------------------------------- | -------------------------------- | ---------------------- |
| Actual Codex CLI trial              | 74.644 / 26.818                  | 1,061,597,184          |
| Independent fresh checkpoint replay | 6.142 / 5.934                    | 757,895,168            |

Manual final-answer review verified the reported IDs, counts, digests, coverage
and Unknown state against complete baseline values, all actual model calls and
the independent replay. The outcome is supported with the explicit model JS
self-check limitation resolved independently. Maximum observed in-flight MCP
calls was one; no target command, web or file-change tool items occurred.
Factual-assessment SHA-256:
`33451102e5faf57f11c627481899f16c4fc47fa5cba5f12cd2ed781a3de54ccf`.
Final immutable input/runtime audit SHA-256:
`73abce493182a7b433b4b78737720640ceb41d6df435cb0fec915468a0a304c8`.

## Catalog and build identity

Both compact/full SDK catalogs are byte-identical to baseline: 234 tools,
6 prompts, 180 CLI commands. The provider projection changes from 63 to 67 rows
only for source-proven web-source/module tracing, Harmony and QLOG provenance
corrections. All other product sections are unchanged. Its expected provider
SHA-256 is `4234ed15d7e53f34599b59dfba1f678369c0ae95b2135c7ba3414d944ab156b6`.
The 66 static declarations have 49 runtime keys and 17 explicit source-owned
workflow/engine groups; 70 bindings union to 67 identities. Static imports reach
44 pure modules without schema, engine or factory runtime imports.

The baseline runtime is `0e94962f64f3f532cc96b2432916f328f60058e97cd0e8e25f5c3e6ed3cdec10`
(2,670 files). Static pairs used clean `bd9bf76d8`, runtime
`62018a023b185dd9c6839799ed1fe4f085810161c723e508fc817d2fccdb59e3`
(2,713 files). Final type-only cleanup `161c3c146` rebuilt to
`d7be1d17dc6b5c23f33468398656ac4d3961380368be1f70dc767f0ba1fac6bf`.
The complete earlier manifest is cryptographically reconstructed by removing
one emitted trailing comma in `dist/composition/capabilityServices.js`'s
existing named import; every other runtime file is byte-identical. This is not
a claim that the two runtime hashes are identical. Native/mixed/model cases use
the final runtime.

Raw inputs, outputs, commands, hashes, recorded failed checks and resource receipts
remain outside Git under
`/home/yann/yann/.rea-worktree-artifacts/20261101/capability-module-ownership/`.
Static-pair audit receipt SHA-256:
`801707569577c7cec848334cf72bfab26a7ff4a95c2a87872d71d78eef7765a3`.

## Review corrections and final qualification

Two actionable review findings were fixed at their producing owners:

- `980991573`: import-edge facts now distinguish fully erased declarations from
  inline type bindings, which still load their module under
  `verbatimModuleSyntax`. Compiler-backed parser/boundary regressions passed;
  the old parser fails the new expectations. A separate three-file probe through
  the actually selected compiler emitted both inline runtime edges and erased
  whole-declaration/type-query edges, without compiling the repository.
- `de6a61636`: the existing contract owner exposes 47 named canonical groups.
  Thirty-seven full provider bindings reference those shared arrays, while
  33 deliberate provider-subset/engine selections remain precise. The actual
  ADB metadata now includes a new valid canonical ADB operation without an edit
  to the provider declaration; reverting to the copied production lists fails
  the regression. Unknown groups, unknown names and identity conflicts fail
  catalog generation.

Final full typecheck, module boundaries, test discovery and changed-file typed
lint passed. Post-review source regressions passed 228 cases and SDK/MCP
regressions passed 34; the two strengthened boundary/metadata files passed
31 cases separately. These overlap earlier groups. Product catalog SHA-256
remains exactly `e942c72047db651939dd47a31042e6818caaca7470092d63645801954a72b523`;
both SDK catalogs remain byte-identical to the original baseline. Static metadata
retains its pure loading boundary; canonical group IDs are imported only as types.

The final implementation freeze is `de6a61636f3f84862cb4263c9ea219b7d2d4de36`,
with 2,713 runtime files, SHA-256
`be1d60c7dcca57eeb7ad09d682efd172c7f1679215e796a291b29eb52e29bda1`.
Earlier model/engine measurements remain attributed to their executed revisions;
they are not relabeled as runs on this later freeze.

A new actual mixed-routing task on this final freeze passed all 58 calls:
32.970 s elapsed, 32.180282 s process-family CPU, 1,042,538,496 B kernel peak.
Independent five-domain source facts, complete producer records and all five
full derived results/requests/IDs matched baseline and the prior qualified
implementation. Same-process and true fresh-process restore preserved the full
Unknown 1→2 mutation history and byte-identical 18,978,040 B checkpoint
(20 Evidence records, 2 Unknown revisions, 1 head), SHA-256
`0316bd6271c6d401a18c10d552b2005d39c98f3bbbc5945ae4823875af13fd5f`.
Owned cleanup, runtime/production-source/input hashes and no OOM were verified.
Append-only final-routing receipt SHA-256:
`9c410c2c31bf38d7edc569deb95b93b7f9a2cf68a7b9a7f84d3ec924f0ad75cb`.
This bounded requalification adds no model invocation or repeated native
analysis query; earlier token measurements remain unchanged.

CodeQL's six reported alert IDs (215, 490, 491, 493, 494, 495) all have open
instances on exact-base main `6e9ee97`. All 24 SARIF paths were reviewed and
independently checked: the new factory-default `process.env` sources retain the
existing command/directory selection and explicit local authority. The shared
filesystem/process sink files are byte-identical to base; Cutter's sink line
shift only removes its old identity constant. No source suppression or global
alert dismissal is included. The PR records the exact-base instance evidence
and the owner's authorized exception for this unrelated existing-alert check.

## Qualification limits

NewPipe coverage is static inventory/graph, not real JADX decompilation: JADX,
apktool and aapt2 were unavailable. No genuine local GGUF/safetensors target was
available. Real Hopper, IDA, JEB, Cutter GUI, GDB/Rizin debugger and Frida target
attachment are not qualified by these application cases; relevant factory,
protocol and cleanup tests use controlled seams. Historical native dossiers
are explicitly labeled reused evidence, not newly reproduced function analysis.
Retained records remain bounded by existing investigation policies; this does
not promise unlimited retention or a new durability backend. Further module
qualification and `BinarySession` simplification remain under parent #740.

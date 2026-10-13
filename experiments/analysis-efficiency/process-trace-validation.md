# Process trace validation

A 6,000-event directed cycle previously overflowed the JavaScript stack inside
the schema refinement. Cycle detection now uses iterative topological traversal.
Cyclic inputs retain independent declaration diagnostics without expanding all
event pairs. Unordered declarations retain group membership, with one diagnostic
per overlapping or conflicting group, instead of allocating a pair set and
repeating the same error for every pair.

A unique topological order proves that every event pair is ordered, allowing
rank comparisons without retaining transitive closure. Other acyclic graphs
retain only one origin's forward and backward reachability sets at a time.
Complete pair validation preserves the missing count and first declaration-order
missing pair. General partial orders still require quadratic pair examination
and repeated graph traversal; they trade CPU time for bounded retained state.

## Initial cycle fix comparison

Flameox ran three randomized paired blocks (seed 917), each limited to 20 seconds
and 512 MiB. Node 24.18.0 used a 384-MiB old-space limit on macOS arm64. Each
process validated the same 2,500-event acyclic chain four times, then checked the
known 6,000-event cycle failure with per-event not-before constraints and one
unordered group containing every event. All six executions passed the embedded answer
digest and expected rejection checks.

The baseline source is from `bb540826d`; the candidate is the initial cycle fix
in `10935b7b1`, which still memoized reachability sets for every queried origin.
Both modules had TypeScript annotations removed with Node's identical built-in
transform and used the same copied runtime dependencies. This isolates schema
validation rather than comparing complete packaged CLI/MCP processes.

| Median measurement                           | Baseline | Candidate |
| -------------------------------------------- | -------: | --------: |
| First validation elapsed milliseconds        |   335.80 |    177.25 |
| Warm validation elapsed milliseconds         |   313.36 |    165.23 |
| First validation CPU milliseconds            |   366.85 |    218.39 |
| Warm validation CPU milliseconds             |   335.32 |    194.08 |
| Whole-process elapsed milliseconds           | 1,344.13 |    787.00 |
| Process CPU milliseconds before final report | 1,457.67 |    941.05 |
| Peak process-family MiB                      |   328.36 |    395.52 |

The input is identical: 233,095 JSON bytes, estimated at 77,010 tokens by tokenx
1.3.0. The valid parsed result digest is
`28bd99ce83f0da8e45600ef20f114cb52bb26b5f5e6bfc1601ca3e712eaf3147`.
Actual agent tokens, catalog injection, transport, model reasoning and provider
costs were not measured. This is a component measurement, not an end-to-end
investigation speed claim.

First validation excludes module import and fixture preparation; warm runs reuse
the process but create fresh per-validation graph state. Whole-process elapsed
includes startup, imports, all four validations, the cyclic-input check, token
estimation and reporting. CPU includes startup through metrics publication;
peak RSS covers the complete single-process workload, with no children. Host
caches were not flushed. Peak memory increased in this cohort. Its retained
valid-order closure still required quadratic memory, prompting the follow-up.
Three pairs describe this fixture only.

Preserved Flameox evidence:
`d6211639446e8b6ec2e82636913eaf471def96673e28f03e9c7f98bec07f8e13`;
analysis `e663b6bd8f5693975542d5b5e2b18437b3c167a0be939bb7386eb68549936231`.
An earlier cohort lost modules during another checkout build; its three failed
executions and timing results are excluded. The successful cohort uses an
isolated runtime copy. Source-module SHA-256 values are
`a7729faa2183b0e493b9ac4fc55f6feaee5b2e5294be13d1b29b57a44b899788`
(baseline) and `725409ce84902125941251037a8a214ccc3c1eec577e484c164c361ca580d693`
(candidate).

## Bounded retention follow-up

Flameox compared `10935b7b1` with the rank/streaming implementation in three
randomized paired blocks (seed 624), under the same host, Node, heap, memory and
20-second execution bounds. Each execution validated the chain above four times,
then a 1,200-event partial order with 600 unordered two-event layers and all four
edges between consecutive layers four times, then the same cyclic failure.
All six executions passed both parsed-answer digests and the cycle diagnostic.
Runtime dependencies were copied and isolated from concurrent checkout builds.

| Median measurement                       | Memoized closure | Rank/streaming |
| ---------------------------------------- | ---------------: | -------------: |
| Chain first elapsed milliseconds         |           166.11 |          11.37 |
| Chain warm elapsed milliseconds          |           154.25 |           5.32 |
| Chain first CPU milliseconds             |           210.13 |          24.38 |
| Chain warm CPU milliseconds              |           184.76 |          16.84 |
| Partial order first elapsed milliseconds |            49.44 |         116.54 |
| Partial order warm elapsed milliseconds  |            50.67 |         110.29 |
| Partial order first CPU milliseconds     |            72.47 |         137.69 |
| Partial order warm CPU milliseconds      |            70.65 |         121.77 |
| Capture process elapsed milliseconds     |           901.24 |         557.30 |
| Process CPU milliseconds before report   |         1,101.12 |         665.03 |
| Peak process-family MiB                  |           391.13 |         127.72 |

First samples exclude module import and fixture preparation. Partial-order first
samples follow four chain validations, so they are first use of that fixture
within an already running process. Warm medians pool the three subsequent samples
from each of three processes. CPU and peak RSS cover the combined workload;
capture elapsed additionally includes Flameox capture startup and overhead.
Host caches were not flushed. The partial-order fixture is slower after this
change; these results establish a retention tradeoff, not universal acceleration.

The partial-order input is 165,590 JSON bytes, estimated at 52,783 tokens by tokenx
1.3.0; its parsed-answer SHA-256 is
`41d06e593813e497221c36793bf00d5fece7055081895b5f6c123ba6ad9a8227`.
Chain bytes, token estimate and answer digest remain unchanged. Actual agent
tokens, transport, catalog injection, model reasoning and provider costs remain
unmeasured. Both cohorts are component measurements, not complete investigations.

Preserved evidence:
`e29086af99afd8e67cbbd92e43d960ea40f73b4d318ea0cbca60f493575462b8`;
analysis `086133516f2acf031032d357a3ddb1ac611ce4f12556a24065a2becd567c5f7b`.
The baseline module SHA-256 is
`725409ce84902125941251037a8a214ccc3c1eec577e484c164c361ca580d693`;
the candidate module SHA-256 is
`2109f1096406e9ecac8bbf4f7ae8abb5113404790a9382487285d2831fcddf26`.

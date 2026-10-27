# Compact MCP output advertisements

## Question and scope

Can an SDK client with a 1 MiB receive buffer discover REA and finish an
export investigation without weakening canonical result validation or losing
Evidence? This verifies #2512 using the opt-in compact output advertisement
from #7054. The default output profile remains `full`; inputs are `compact`.

The implementation was integrated onto main `18dc78fa43175b9628b45b731df06c9321c3f730`.
Measured runtime revision: `650d483b98564d8dbe87d55ce6a77ec410608136`.
Both profiles use that same runtime, rather than two different analyzers.
The complete schema remains the server's validator; the bounded advertisement
is a widening and does not replace the delivered `structuredContent`.

## Completed public workflow and independent oracle

`mcp-output-profile.mjs` starts the packaged CLI over real stdio with the
installed MCP SDK client, an isolated account and an explicit receive cap.
It records initialize/discovery, two native export summaries (cold/warm),
selected first/last exports, complete Evidence publication, and a second
discovery after materialization. Named advertised schemas validate the calls.
After closing the server, it authenticates the complete exported bundle and
checks every export name/address against GNU `nm`. The complete sets of names
must agree; selected rows must retain their original source indices.

Linux x64, Node 24.22.1, npm 11.16.0. Real target:
`/usr/lib/x86_64-linux-gnu/libcrypto.so.3`, SHA-256
`aa01e614af634bc7c8b678c9250b5c4f613c61989bacf0a5d6aed6570e7dcabd`.
All 5,367 export names/addresses were corroborated. Both profiles produced the
same authenticated parent Evidence ID and complete-record digest. GNU `nm`
corroborates export coordinates, not behavioral equivalence.

| Measurement                                        | Full output | Compact output |
| -------------------------------------------------- | ----------: | -------------: |
| Discovered tools                                   |         229 |            229 |
| Serialized catalog result bytes                    |   3,639,545 |        554,792 |
| Catalog cl100k token estimate                      |     932,629 |        116,962 |
| Complete task wire estimate, one discovery         |     939,165 |        123,501 |
| Executed wire estimate, including second discovery |   1,871,825 |        240,494 |
| Discovery after connection, ms                     |         292 |          1,886 |
| Repeated discovery, ms                             |         333 |             49 |
| Whole harness elapsed, s                           |        9.86 |           6.18 |
| Whole harness CPU, s                               |       11.96 |           7.66 |
| Sampled process-family peak RSS, GiB               |        1.04 |           0.62 |

The SDK's real 1,048,576-byte receive cap rejects the full catalog before any
analysis call. The compact run succeeds under that cap; the successful full
control uses the SDK's normal 10 MiB cap. A small `/usr/bin/ls` pilot also
completed under 1 MiB, with all 15 export names corroborated. Neither public
workflow uses a fake provider or launches the inspected executable.

Whole harness costs include the client, server, complete publication, offline
bundle parsing/oracle, and cleanup. Each run has a fresh server; the second
inspection/discovery is warm. OS file caches were not flushed. Two CPU affinity
slots, a 3 GiB Node heap request and an 8 GiB process-family RSS guard bound the
runs. RSS is the sum sampled every 100 ms: shared pages can be counted twice
and short peaks can be missed. No run hit a resource guard or OOM, and cleanup
succeeded. One pair does not establish a general speed or memory improvement;
compact startup takes the eager path and its initial discovery is slower.

## What the token counts establish

Estimates use `tiktoken`'s `cl100k_base` over serialized JSON messages, including
initialization, request arguments, every needed reply and discovery. The
one-discovery value excludes only the explicit repeated catalog consistency
probe; the executed total includes it. Local complete-bundle bytes stay outside
the wire. These are transport serialization estimates, not actual model usage.

The names/descriptions/input-schema projection is byte-identical across both
profiles: 56,909 estimated tokens. A host forwarding only those fields gains no
model-context reduction from this output-profile setting. A host retaining
output contracts, a typed Code Mode catalog, or the entire wire has a different
cost. Native host forwarding and live model behavior were not measured here.
The demonstrated benefit is successful bounded-frame discovery with complete
analysis, plus the measured reduction in serialized output advertisements.

## Reproduction and retained failures

Build once, then use fresh output directories:

```sh
npm run build:cached
node experiments/analysis-efficiency/mcp-output-profile.mjs \
  --runtime . --profile full --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --output /tmp/rea-output-full
node experiments/analysis-efficiency/mcp-output-profile.mjs \
  --runtime . --profile compact --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --receive-bytes 1048576 --output /tmp/rea-output-compact
```

Repeat the full command with `--receive-bytes 1048576` as a negative control;
expect a nonzero exit, a receive-buffer error in `report.json`, and no analysis
calls. Reports retain the catalog, transcript, complete bundle and server log.
The resource guard/profiler is external to this driver; choose host-appropriate
limits when reproducing. Token estimates can be reproduced from the saved
messages with the tokenizer above, counting each `message` once.

Two initial small pilot attempts used incomplete source selectors in this new
driver. REA correctly returned `invalid_request`; both failed receipts were
retained with successful cleanup. The driver was corrected to use the canonical
`source: {kind: "retained-evidence", evidence_id}` before the completed runs.

Initial focused checks ran concurrent files under two CPU slots. Two full
catalog compilation assertions exceeded their 30-second test timeouts; 46 other
MCP cases and 14 source cases passed. The representative assertion passed alone
in 22 seconds, and the complete file passed with one worker, but another run
after the main rebase exceeded the deadlines again. CPU contention alone did
not fully explain the variability.

A bounded probe over the five largest output schemas isolated AJV generated-code
optimization: compile-only checks took 4.75 seconds with optimization and 2.22
seconds without it. The schema-validity fixture now disables that code-generation
optimization because it never executes these validators. It still validates the
declared dialect, compiles every schema, isolates each reference namespace, and
checks malformed/unresolved references. Actual SDK validators retain their normal
options. Test deadlines and schema/reference assertions remain unchanged.

After rebasing onto main `7d36d172a`, both complete real workflows passed again
at integration runtime `f735451d9`, retaining the same export parent Evidence
and complete-record digest across profiles. The 1 MiB compact cap still passes.
The 20 schema/profile cases also pass with the default two workers after the
compile-only optimization change; check:fast and repository formatting pass.

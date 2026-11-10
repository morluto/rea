# Source-map admission calibration — 2026-11-09

The local map default changes from 4 to **8 MiB** to admit the pinned Actual
Budget main and DateSelect maps on the first call. Other source-map defaults
remain unchanged. This is a compatibility improvement for the measured artifacts,
not an established latency, memory or context optimization or a universal optimum.

[Issue #8978](https://github.com/morluto/rea/issues/8978) identifies Actual Budget
v26.11.0. We acquired eight public shipped maps from
[the public demo](https://demo.actualbudget.org/) without running the application.
These eight preload-selected maps total 18,319,814 bytes and 834,659 structural
records; they are not the complete eleven-map scope of the issue. Pinned URLs,
SHA-256 values, counts and independently decoded lookup expectations are in
[artifacts.json](https://github.com/morluto/rea/blob/main/docs/verification/source-map-budgets-2026-11-09/artifacts.json).

The completed point task reads and verifies a selected generated script, analyst
manifest and map, runs the actual owned source codec, checks every equal-position
match and embedded-source digest, and creates and serializes complete Evidence.
The acquisition manifest is constructed and explicitly incomplete: it establishes
no browser capture, runtime execution or deployment authenticity. The independent
[Python VLQ oracle](https://github.com/morluto/rea/blob/main/docs/verification/source-map-budgets-2026-11-09/oracle.py) derives mapping positions
and counts directly from artifact bytes, separately from REA's decoder.

## Admission-only measurements before compact delivery

Each cell below is the median of three fresh-process runs. A baseline call uses
4 MiB admission and, when refused, retries the same complete map with 8 MiB. The
candidate selects 8 MiB on its first call. Other policies are identical. All
18 point runs exit successfully, verify the oracle and leave their process groups
empty. The baseline source snapshot and individual measurements/digests are in
[measurements.json](https://github.com/morluto/rea/blob/main/docs/verification/source-map-budgets-2026-11-09/measurements.json).

| Map / workflow               | Calls | Estimated task tokens | Wall s | CPU s | Sampled host-group RSS MiB |
| ---------------------------- | ----: | --------------------: | -----: | ----: | -------------------------: |
| Theme / default              |     1 |                25,103 |  0.368 | 0.359 |                       98.6 |
| Theme / 8 MiB                |     1 |                25,126 |  0.367 | 0.391 |                       99.3 |
| Main / default + retry       |     2 |             1,590,278 |  0.553 | 0.573 |                      174.0 |
| Main / 8 MiB                 |     1 |             1,589,746 |  0.539 | 0.559 |                      181.5 |
| DateSelect / default + retry |     2 |             2,232,370 |  0.582 | 0.586 |                      205.0 |
| DateSelect / 8 MiB           |     1 |             2,231,835 |  0.599 | 0.617 |                      192.4 |

Tokens are tiktoken 0.12.0 `cl100k_base` estimates of compact UTF-8 JSON arguments
and complete replies, including failed calls and retries; they are not actual
model usage. Catalog discovery was not performed. Catalog/tool schemas, JSON-RPC
envelopes, network acquisition and actual model billing are unmeasured. Complete
Evidence retains raw map text: eliminating a retry saves only about 532–535
estimated tokens against replies exceeding 1.5–2.2 million tokens. A map admission
cap is therefore not a suitable agent context budget. These measurements do not
qualify a smaller public reply projection or a live browser investigation.
Source inspection confirms that the production MCP handler records complete
Evidence before response encoding. Overflow recovery names its retained
reference and offers session export or complete CLI JSON; facts are not lost.
At the time of this admission-only experiment, local tracing had no summary,
paged matches view or native analysis-view continuation. This experiment did not
exercise a large reply through a live MCP client. The subsequent
[compact-delivery qualification](source-location-delivery.md) measures real
public MCP summaries, continuations and source-text selection separately.

Node v24.22.1 ran on macOS 26.3 arm64. Workers/processes were fresh; OS caches were
not flushed, and no cold-cache comparison is claimed. Wall time includes the
observer. CPU is OS `wait4` user +
system usage for the waited subtree; orphaned/unwaited descendants and sampler
CPU are excluded. RSS is a simultaneous process-group sum sampled every 20 ms;
short peaks and descendants leaving the group can be missed and shared pages can
be counted repeatedly. In particular, the owned codec launches in a separate
group, so its peak is unmeasured in this older table; this is not whole-family
memory. The 1536 MiB observer threshold is an early-stop guard,
not a kernel memory limit. Mixed timing/memory differences do not establish a
performance improvement.

## Unsuccessful full-fetch sizing

An eight-map sizing attempt selected 128 MiB expanded output and 1,048,576
records/segments. It generated a 123 MB full-Evidence file, but the observer's
signal race failed while the sampled process group exceeded its 1536 MiB guard.
No valid complete measurement receipt was produced; this is an unsuccessful,
unmeasured sizing attempt, not evidence of a safe completed task or a calibrated
fetch default. The observer was subsequently repaired. A small Theme fetch
control completed, but one control does not justify raising collection defaults.
Full-fetch output, records, heap and response-byte defaults stay conservative and
configurable. Local tracing retains its existing 262,144-record budget; the
largest measured individual map consumes 260,561 records, so broader map coverage
remains unqualified.

## Reproduction

No downloaded artifacts or complete large replies are committed. Publisher URLs
may change; acquisition refuses a digest mismatch. Use a separate baseline source
snapshot identified in `measurements.json`, then select the same explicit policies.
The retained driver uses production source through the pinned tsx loader and runs
the real source-owned codec. Fetch mode replays pinned HTTP artifact bytes through
the fetcher and includes schema/Evidence/serialization costs, while excluding
browser capture and generated-script analysis.

```sh
python3 docs/verification/source-map-budgets-2026-11-09/acquire.py \
  docs/verification/source-map-budgets-2026-11-09/artifacts.json /tmp/rea-map-calibration
python3 docs/verification/source-map-budgets-2026-11-09/oracle.py \
  /tmp/rea-map-calibration/artifacts.json
node --import ./node_modules/tsx/dist/loader.mjs \
  docs/verification/source-map-budgets-2026-11-09/workload.mjs "$PWD" \
  '{"artifactDir":"/tmp/rea-map-calibration","mode":"point","select":"index.","strategy":"recover","policy":{"map_bytes":8388608},"resultPath":"/tmp/map-replies.json"}'
```

For candidate-first, omit `strategy`. Use `select: "theme."` or `"DateSelect."`
for the other point cases. Wrap each invocation with
[the process-group observer](https://github.com/morluto/rea/blob/main/scripts/verify/analysis/budget-calibration-run.py) for bounded process-group
observation; keep runs serial. After the default change, reconstruct the baseline
snapshot or explicitly select `map_bytes: 4194304` for the initial baseline call.

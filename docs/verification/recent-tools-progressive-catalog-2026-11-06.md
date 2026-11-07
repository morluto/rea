# Progressive catalog costs for recent analysis tools

## Decision and compatibility

Load `inspect_analysis_view` on demand in the opt-in `hot-cold` profile. Its cross-domain output contract is unused when a producer's inline `view` answers the question. The existing catalog owner already handles exact-name discovery, visibility, notifications, scope and identity; no new cache, analysis pipeline or protocol is added.

This changes initial hot/cold visibility: clients that assumed the view was always loaded must discover it before calling it. When follow-ups are already known, discover the producer and view in one batch. On the pinned measurement baseline, the default `full` catalog is exactly unchanged: 241 tools, 4,257,925 serialized bytes, identical names, schemas, annotations and descriptions. Complete schemas, canonical validation, Evidence IDs, provenance, unknowns and requested facts remain intact.

## Pinned verification

Baseline: `1480a7c72e601f4444e21ecd50118c1afa774209`; candidate is that checkout with the `src/catalogDiscovery.ts` policy change recorded in the [JSON receipt](recent-tools-progressive-catalog-2026-11-06.json). Node 24.22.1 and MCP client/server 2.3.1, Linux x64. No target execution or browser launch occurs during these offline tasks.

Three alternating before/after suite repetitions use sequential fresh MCP servers, Client and AJV instances for six cases. The Node harness/SDK code is shared across the six cases in a repetition, so later cases have warm code. Filesystem caches were not flushed; these are repeat measurements, not a cold-disk qualification. Capture acquisition, fixture generation and builds preceded profiling. Two separate alternating batched controls use a fresh Node harness per trial. All Node processes use normal JIT and 1 GiB heaps. Stock SDK output validation/caching is retained without per-call tool-definition overrides.

The SDK 2.3.1 cache compiles validators for the complete discovered list on first use. With `application,session,artifact` families and full output schemas, the initial hot/cold catalog drops from 781,713 to 90,374 bytes. The five inline-only tasks reduce cumulative validator preparation from roughly 5–8 seconds to 0.7–1.4 seconds. This is a client/catalog cost reduction, not faster artifact parsing.

## Answer latency and token estimates

Per-case times below include discovery, analysis and oracle assertions through the verified answer; final close is accounted for in the suite totals below. Values are medians of three repetitions, except the two-repetition batched control.

Token estimates use `tiktoken==0.14.0`, `o200k_base`. The conservative column counts each distinct visible tool input definition once, recorded server instructions, a fixed question, every tool argument and every text reply. It includes discovery calls. It is a proxy, not model billing: actual hosts may prune tools, replay catalogs or render structured results differently. No model requests were made.

| Completed question                             | Answer seconds before → after | Incremental input/text token proxy before → after |
| ---------------------------------------------- | ----------------------------: | ------------------------------------------------: |
| OpenAPI: Petstore + GitHub GET declarations    |                  13.80 → 6.46 |                                     9,669 → 6,336 |
| GraphQL: SWAPI Film + GitHub Repository fields |                  13.42 → 7.56 |                                    11,898 → 8,565 |
| Playwright: small + large network events       |                  12.15 → 6.75 |                                    11,946 → 8,613 |
| Static JS / HAR: unobserved endpoint           |                  10.61 → 5.31 |                                     8,296 → 4,963 |
| OpenWrt: two FIT component inventories         |                  10.21 → 6.28 |                                    11,468 → 8,135 |
| Later-discovered retained follow-ups           |                 10.78 → 12.79 |                                   14,373 → 14,583 |
| Batched producer + retained follow-ups         |                 12.96 → 13.17 |                                   14,375 → 14,503 |

The five inline-only tasks improve in this cohort; the conservative token proxy falls 28–40%. The retained cases eventually need the same definitions and **do not establish a token reduction** under incremental loading. Discovering the view later adds one tool call and one catalog refresh; the shared-harness cohort also shows slower answer latency. Batching avoids that extra discovery/refresh, but the cold-client timing ranges overlap: no retained-workflow speedup is established.

If each refreshed catalog is instead counted once in full, the snapshot/text proxy falls further, including in the retained cases. The SDK-wire proxy additionally includes output schemas and duplicated `structuredContent`; these are transport costs and must not be presented as model input. Both ledgers and all ranges are in the JSON receipt.

## CPU, memory and cleanup

Each entire six-case suite completes all server/client closes and is measured with two CPU affinity, a 4 GiB sampled process-family RSS guard, 200 ms samples and a 20-minute deadline. No compared run hit a guard. These are suite totals, not per-case attribution.

| Six-case suite, median          |   Before |    After |
| ------------------------------- | -------: | -------: |
| Elapsed                         |  70.62 s |  46.18 s |
| User + system CPU               |  75.32 s |  47.74 s |
| Sampled process-family peak RSS | 1.11 GiB | 0.97 GiB |

The RSS statistic sums process RSS and can count shared pages more than once. Host-wide pressure, inference CPU/memory, cold-disk performance and sustained large-page generic-validator JIT behavior are unmeasured. No universal provider, model-token or memory improvement is claimed.

## Correctness oracle and limits

- OpenAPI selections agree with the original JSON path/method declarations in small Petstore and large GitHub specifications.
- GraphQL names and declaration lines come from an independent source-line oracle for SWAPI and GitHub SDL; declarations must lie inside returned source ranges, including preceding SDL descriptions, with matching source digests.
- Every selected trace network line, method, URL and status agrees with raw original ZIP `trace.network` JSON. Both original small and large Playwright recordings are used.
- Endpoint comparison reuses authenticated static JavaScript/browser-HAR Evidence from #9090 and identifies `/api/admin/export` as not observed in that capture. It does not establish endpoint absence outside the capture.
- OpenWrt 24.10.0/24.10.1 ABT ASR3000 recovery FITs retain the previously independently checked kernel/initrd changes, identical DTB and separately changed outer `.` from #9143. No decompression, device execution or native provider analysis.
- Analysis Evidence digests match across every paired run. The public stdio regression also removes its owned source file after import, discovers the view, verifies the complete advertised output schema, queries retained facts and exports the complete source Evidence. Repeat discovery emits no extra notification.

Input sizes/digests and profiler/receipt digests are recorded in JSON. Original qualification sources and scope are in #9090, #9104, #9127, #9140 and #9143. Raw harnesses and captures remain local outside Git; exact real-data timing reproduction requires those matching external fixtures. The public regression is self-contained.

An initial harness attempt used an incorrect assertion that a field declaration line must equal its source range start. SDL descriptions precede some declarations. That attempt failed, is retained separately and is excluded; the corrected oracle checks containment. The intended public regression fails on the base because the view is initially loaded, then passes after the policy change.

No default catalog change, weakened output validation, shortened IDs, omitted Evidence, guessed absence, additional parsed-result cache or parser speedup is part of this change.

## Integration verification

After rebasing onto `fbe7532fabb78de46bd00db845c1147b5325ad22`, the public workflow passed again and all six real-workflow Evidence digests matched the qualification above. An unrelated upstream managed schema change makes the default catalog 4,257,977 bytes; a separate same-base comparison confirms exact equality before and after this policy change. The repeated performance cohort remains pinned to its original baseline; the additional integration run is recorded separately in JSON.

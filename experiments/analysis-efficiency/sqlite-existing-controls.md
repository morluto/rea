# SQLite existing-control measurements

Continues [#2016](https://github.com/morluto/rea/issues/2016) after the Flutter
lane. The measured main runtime is pinned to
`172407787f1842dedbcd27b5385177595f786ce4`. Its only post-Flutter
commit repairs Windows transient runtime admission (#2467); this Linux round
does not establish Windows performance. No production/API change is proposed
merely because another summary or cache could be added.

Before PR integration, main advanced to
`bb540826d65316c164d2de8ba4ef10f81a8ad073`. Its five intervening commits cover
MCP archive contracts/documentation, an advertised-schema inventory test,
pwntools cleanup identity, concurrent Mach-O slice inspection, and transient
DMG verification retries. None changes the SQLite selector. Rebase and current
main verification do not relabel the frozen measurements below.

The committed post-format driver passes a real SDK smoke against the frozen
runtime. After rebase, a fresh build, real all/selected-column SDK pair and docs
check pass on the updated main. Selected facts match each other and the frozen
runtime; artifact bytes remain unchanged. These are integration checks, not
additional model performance pairs.

## Real application data and question

Use QGIS's bundled `world_map.gpkg`, unmodified from official immutable source
commit `e1223b8e9e71fc50ee995ed556f711c54ccc101b`. `corpus.json` pins its URL,
12,914,688-byte size, Git blob `c9ff80228dff0de93c9acdef16a97545ba360244`, and
SHA-256 `01d293159d1b77bd9212b5252587853f61aa9e25b2387135f34afaba8d057190`.
Streaming acquisition matches the upstream blob. The upstream resource install
list includes `data/*`; [its README](https://github.com/qgis/QGIS/blob/e1223b8e9e71fc50ee995ed556f711c54ccc101b/resources/data/README_world_map.md)
records data provenance. This is shipped application data, not a generated REA
fixture. QGIS is neither installed nor executed.

The source question asks for the complete returned `countries` table schema
and one sample's `fid`, `NAME`, `ISO_A3` tagged cells, in that order. It preserves
database/WAL identity, engine/encoding, exact original SQL and columns, integer
strings, text bytes, nulls, row limit/count, unspecified order, truncation and
both producer/outer limitations. It does not require geometry blobs or a full
country inventory. Neither political labels nor the sampled ordering are
inferred to be current or globally exhaustive.

SQLite already defaults to compact schema inventory without a table, detailed
selected-table schema with a table, and exposes exact `columns`. Selecting
columns avoids constructing unrelated cells without changing the requested
table schema. Thus compare existing all-visible columns against exact columns
on the same main runtime, rather than changing an old user's default or adding
a new delivery mechanism. Inventory scope cannot substitute for the detailed
schema requested by this question.

## Public SDK observations

Frozen runtime: main `172407787f1842dedbcd27b5385177595f786ce4`, compiled
dist/bridge file-table SHA-256
`72a4ac6c6db491c455f3e4a798f8f52ed5850c08831e7cdc9f25c1525a5a1d11`.
Node 24.18.0, SDK client/server 2.3.1, observed SQLite 3.53.1, WAL null. Driver,
provider settings/search-path fingerprints, artifact and locked dependencies
remain equal. Each workflow starts a fresh server and validates the selected
actual advertised schema. Host page caches are not flushed.

The initial default inventory returns 26 table entries, including explicit
virtual/shadow classifications, no rows and `not_requested` column details:
27,185 compact client-result JSON bytes. Selecting `countries` reveals eight
columns, including a geometry blob. Its one-row full reply is 485,277 bytes.
The selected request retains every requested declared-schema field and exact
tagged sample values while omitting unrelated sample cells.

| Trial         | Reply bytes | SDK workflow seconds | Payload CPU seconds | Kernel peak bytes |
| ------------- | ----------: | -------------------: | ------------------: | ----------------: |
| sdk-all-1     |     485,277 |               11.820 |              12.755 |       562,884,608 |
| sdk-columns-1 |      18,509 |               14.017 |              13.715 |       557,510,656 |
| sdk-columns-2 |      18,509 |               15.826 |              14.162 |       548,343,808 |
| sdk-all-2     |     485,277 |                5.679 |               7.310 |       561,704,960 |

Both pairs make one successful call, pass settings/selected-fact comparison,
retain complete original schema and all requested typed cells, and preserve
source bytes. Reply bytes fall about 96.2%. These observations **do not show SDK
speed or CPU improvement**: selected workflows are slower in both pairs and
timing varies substantially. No cause is inferred from these data. Payload CPU
includes runner/catalog work outside the SDK workflow timer. Memory changes
are small and do not establish a general reduction. Raw replies and the exact
pre-format driver source are archived privately.

Reproduce with `measure.mjs --artifact qgis-world-map.gpkg` and
`--sqlite-selection all|columns`, using the same `--runtime-root`, `--revision`,
artifact path and `--schemas selected`. `--delivery` stays `complete`; this is
an existing request selection, not a new summary API. Original caller arguments
and schemas remain in the private receipts. The source question is
`questions/sqlite-qgis.txt` and the selected factual grader is
`review-model.py --domain sqlite`.

## Decision and scope

The initial four actual Codex attempts never executed SQLite: the client rejected
the tool because its private snapshot writes require approval and the isolated
driver lacked this exact tool's approval override. Every factual grade fails;
these are failed client attempts, not completed-task performance comparisons.
All profiles are removed. The existing experiment-only per-tool approval list
now includes `inspect_sqlite_database`; each corrected trial exposes only that
exact enabled tool. REA annotations, target authority and global Codex configuration
are unchanged. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents the per-tool override. Corrected cohorts use fresh output directories
and retain the original failures separately.

Actual repeated Codex comparisons determine the task token/time benefit before
crediting smaller replies. An existing selector that answers the question is
evidence against adding another production mechanism. Keep negative outcomes
and unavailable coverage, including failure/retry costs and profile cleanup.

Four corrected serial trials use Codex CLI 0.161.0, requested `gpt-5.6-terra`
high, one enabled tool, identical owned context/discovery capture, and the same
frozen main runtime. The requested alias is not a verified server-resolved model.
Equal treatment instructions select the existing all-visible or exact-column
request; the source question and requested schema/sample facts stay fixed.

| Corrected trial          |  Input | Cached | Uncached | Output | Seconds | MCP calls | Facts |
| ------------------------ | -----: | -----: | -------: | -----: | ------: | --------: | ----- |
| approved-model-all-1     | 88,131 | 52,480 |   35,651 |  3,369 |  84.007 |         2 | pass  |
| approved-model-columns-1 | 37,340 | 20,992 |   16,348 |  3,006 |  87.514 |         1 | pass  |
| approved-model-columns-2 | 56,148 | 36,096 |   20,052 |  3,298 |  97.466 |         2 | pass  |
| approved-model-all-2     | 88,340 | 52,480 |   35,860 |  3,084 | 113.847 |         2 | pass  |

Both pairs pass every selected producer fact, exact SQL/schema/null/tagged
cells, observed response Evidence IDs, target-byte preservation and profile
cleanup. The grader checks producer observations, not independent geometry
semantics. Actual events contain only the chosen MCP tool and agent messages;
no shell or other agent execution appears. Usage is the final aggregate actually
reported by the CLI, one usage record per trial; cached input remains included
in total input. Output includes 853 / 357 / 523 / 664 reasoning tokens.

Total input falls **57.63% / 36.44%**, uncached input **54.14% / 44.08%**.
Time is mixed: columns are **4.17% slower** in pair 1 and **14.39% faster** in
pair 2. Output is 10.77% lower / 6.94% higher. Repeated calls remain counted;
pair 1 has two all-column calls versus one selected call, while pair 2 has two
calls on both sides. This supports scoped token savings from using the existing
selector, not a dependable speedup or a new API requirement. Client context and
usage are observed separately from raw SDK reply bytes.

Model payload CPU seconds / kernel peaks are 7.596 / 763,838,464;
7.772 / 761,143,296; 8.409 / 762,597,376; and 11.759 / 774,025,216. CPU is mixed
and memory differences are small. Payload cleanup/limit observations pass;
missing terminal counters keep every strict whole-resource grade false.

The original blocked attempts remain separate and never provide comparison
denominators. They each have one failed call, no SQLite result and failed facts:

| Blocked trial   |  Input | Cached | Uncached | Output | Seconds |
| --------------- | -----: | -----: | -------: | -----: | ------: |
| model-all-1     | 35,290 | 29,952 |    5,338 |    798 |  59.881 |
| model-columns-1 | 35,356 | 22,016 |   13,340 |    670 |  44.764 |
| model-columns-2 | 35,034 | 20,992 |   14,042 |    639 |  30.007 |
| model-all-2     | 35,104 | 20,992 |   14,112 |    673 |  25.132 |

**Decision: no production/API change.** Existing column selection materially
reduces unnecessary delivery and actual model input while retaining the complete
requested schema and exact cells. Existing documentation already recommends
table/column selection. No additional summary, schema-scope default change,
automatic field omission, plugin layer or cross-session cache is justified by
these results. Preserve the negative/mixed time, output and CPU findings.

Real one-shot CLI inventory, all-column sample and exact-column sample match
the corresponding full MCP normalized results, subjects, parameters and IDs;
the source digest remains unchanged. An independent Python binding using SQLite
3.40.1 opens this immutable artifact read-only and agrees with the exact stored
table SQL, eight declared columns and selected tagged sample cells. This is a
second engine/binding observation of this file, not a general row-order or
geometry-semantics guarantee. The six existing context/driver regression tests
pass; Python compilation and JavaScript syntax checks pass. No new product test
or production implementation is added for this measurement-only finding.

Manual review tightens the SQLite grader to distinguish missing fields from
explicit null and preserve JSON scalar types. Regrading all four stored model
answers still passes every selected fact; deliberate omission of `wal` and a
boolean substituted for numeric `row_limit` both fail. Original transcripts,
usage and previous review receipts stay intact; no model trial is rerun.

Heavy tasks remain serial under one CPU, unchanged 3 GiB early stop / 4 GiB hard
memory, no swap, owned task scopes and host guards. SDK payload observations
verify cleanup and zero phase limit events; final whole-scope counters remain
unknown. This does not establish live/WAL atomicity, all SQLite applications,
other runtimes/platforms or geospatial geometry semantics. Other packet/signal
and capture lanes remain incremental follow-ups using their existing controls.

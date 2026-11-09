# Source-location delivery qualification — 2026-11-09

Opt-in summary delivery substantially reduces the measured main-map task's
serialized transcript and its median elapsed time, CPU and sampled memory. The
small Theme control exposes a tradeoff: summary adds a call and becomes more
expensive when a client must first load the complete `inspect_analysis_view`
definition. Complete delivery remains the compatibility default. These results
support explicit summary selection for large point answers or already available
views; they do not establish a uniform whole-task token or latency improvement.

The [product guide](../guides/web/web-source-location.md#compact-point-delivery-and-retained-source-text)
explains summary, matches pages, explicit UTF-16 source text selection and retained
complete Evidence. This record measures the public compiled stdio MCP workflow.
CLI publication performance is unmeasured here.

## Task, oracle and execution

The task returns every alternative at one generated point, preserving source/map
identity and original source positions, plus a 512 UTF-16-code-unit snippet around
each mapped point. Inputs are the pinned public Actual Budget Theme, main
`index.CMrE7aQb`, and `DateSelect.BVYaCNUe` maps and generated scripts in the existing
[artifact manifest](https://github.com/morluto/rea/blob/main/docs/verification/source-map-budgets-2026-11-09/artifacts.json). Acquisition used
verified cached public bytes and the existing acquisition helper's explicitly
incomplete analyst-manifest construction. No application or browser was executed.
The independent [VLQ oracle](https://github.com/morluto/rea/blob/main/docs/verification/source-map-budgets-2026-11-09/oracle.py) supplies the
expected source declarations, positions, alternatives and content digests.

Both variants use the same compiled runtime, files and portable driver:

- **Complete:** request complete Evidence. Theme and main return it inline; the
  driver selects the required snippet locally from the returned source content.
  DateSelect exceeds the default 10 MiB transport allowance, then follows its
  retained matches continuation and requests the selected source text: three tool
  calls, including the failed delivery.
- **Summary:** request `detail: summary`, then explicitly request the selected
  source-text page: two tool calls. Match paging remains part of the driver when
  required. All three selected real points have one alternative.

This compares current **complete delivery with bounded retained-view recovery**
against opt-in summary. It does not compare against the former export-only fallback.
The measurement includes driver artifact hashing/reference parsing, initialization,
full catalog discovery, trace, necessary continuation/text calls, answer validation
and shutdown. Export is not needed to answer this task and was not included.

Three fresh-process runs per case/variant completed. Trial two reversed variant
order; OS caches were not flushed. All 18 runs exited zero, with empty owned groups
and no resource stop. Aggregation independently verifies all snippets and pinned
map/generated-script/content hashes, identical answers and parent Evidence IDs
across variants/trials, and exact raw-map SHA-256 whenever the initial complete
response includes raw text. Runtime execution and deployment authenticity remain
unknown.

## Serialized token estimates

Counts use tiktoken 0.12.0 `cl100k_base` on compact Unicode JSON-RPC request/reply
lines, including initialization, the initialized notification, `tools/list`, failed
calls, continuations and selected text. Replies include both MCP text and structured
content. These are serialized-transcript estimates, **not actual model usage or
billing**; client presentation can omit or transform those representations.

The observed full catalog uses compact input schemas and full output schemas.
`tools/list` returns 4,487,850 wire bytes. Initialization, notification and catalog
account for **1,145,053 estimated tokens** in every run. Do not add selected
contracts again to the catalog-included totals. Post-discovery counts exclude only
that discovery prefix, so they include all task retries and subsequent calls.

| Map / delivery                      | Tool calls | Catalog-included task tokens | Post-discovery tokens |
| ----------------------------------- | ---------: | ---------------------------: | --------------------: |
| Theme / complete                    |          1 |                    1,196,400 |                51,347 |
| Theme / summary                     |          2 |                    1,154,878 |                 9,825 |
| Main / complete                     |          1 |                    4,354,894 |             3,209,841 |
| Main / summary                      |          2 |                    1,154,851 |                 9,798 |
| DateSelect / complete with recovery |          3 |                    1,155,932 |                10,879 |
| DateSelect / summary                |          2 |                    1,154,974 |                 9,921 |

Selected complete wired definitions cost **8,408 tokens** for
`trace_web_source_location` and **180,576** for `inspect_analysis_view`. When those
definitions are uncached and a client loads only the tools it uses, Theme complete
costs 8,408 + 51,347 = **59,755**, whereas summary costs
8,408 + 180,576 + 9,825 = **198,809**. Summary loses in this first-use accounting
scenario. The measured full-catalog scenario already loads the view definition,
so its Theme total instead falls from 1,196,400 to 1,154,878. Main still improves
with selected complete definitions: 3,218,249 to 198,782.

As a separate **hypothetical client projection**, retaining only each definition's
`{name, description, inputSchema}` costs 548 and 3,533 tokens respectively. Adding
those selected projected definitions to the same post-discovery transcripts gives:

| Case       | Complete → summary, selected complete wired definitions | Complete → summary, hypothetical input-only definitions |
| ---------- | ------------------------------------------------------: | ------------------------------------------------------: |
| Theme      |                                        59,755 → 198,809 |                                         51,895 → 13,906 |
| Main       |                                     3,218,249 → 198,782 |                                      3,210,389 → 13,879 |
| DateSelect |                                       199,863 → 198,905 |                                         14,960 → 14,002 |

This projection is an offline accounting calculation, not an observed client/model
transformation or an alternate measured discovery workflow. Cached or deferred tool
loading, output-schema profiles and model-facing reply presentation can change the
costs. No actual model run or billing comparison was performed.

## Elapsed time, CPU and sampled memory

Values are medians of three runs on macOS 26.3 arm64 with Node v24.22.1. The small
control has a slight elapsed/CPU increase; DateSelect memory is similar across
variants. Three runs do not establish general performance guarantees.

| Map / delivery                      | Wall seconds | CPU seconds, waited subtree | Sampled group peak MiB | Sampled tree peak MiB |
| ----------------------------------- | -----------: | --------------------------: | ---------------------: | --------------------: |
| Theme / complete                    |        0.972 |                       1.128 |                  498.0 |                 555.8 |
| Theme / summary                     |        0.985 |                       1.143 |                  483.9 |                 542.1 |
| Main / complete                     |        1.625 |                       1.815 |                  776.5 |                 776.5 |
| Main / summary                      |        1.134 |                       1.294 |                  549.7 |                 661.4 |
| DateSelect / complete with recovery |        1.199 |                       1.351 |                  580.6 |                 695.6 |
| DateSelect / summary                |        1.150 |                       1.326 |                  588.6 |                 694.2 |

The observer samples simultaneous `ps` RSS sums at nominal 20 ms intervals, plus
sampling work. **Tree RSS includes
codec descendants outside the root PGID while their PPID ancestry remains linked.**
Short peaks, exited/reparented/orphaned descendants can be missed; shared pages can
be counted repeatedly. These are sampled sums, not kernel peak or private-memory
measurements. CPU is OS `wait4` user + system for the waited subtree, excluding
sampler CPU and unwaited/orphaned descendants. Wall time includes observer overhead.

The 90-second deadline, 1536 MiB observed memory early stop and cleanup signals apply
only to the **owned process group**. Observational tree membership grants no signal
authority. The group guard does not enforce a tree-wide or kernel memory hard cap;
empty-group cleanup does not prove that an unobserved orphan cannot exist.

A preliminary 18-run completed-task matrix used group-only RSS and a temporary
driver that decoded UTF-8 separately per incoming chunk. It is superseded: codec
processes can change PGID, and chunk boundaries can split UTF-8. Its local method
receipts are preserved; **none of its result statistics appear in these tables**.
All final runs use the retained driver's UTF-8 stream decoder, raw-map digest
check and the observer's additional read-only tree RSS measurement. The earlier
[map-admission calibration](source-map-budget-calibration.md) is a separate study.

## Retained evidence and reproduction

The compact [measurement record](https://github.com/morluto/rea/blob/main/scripts/verify/analysis/source-location-delivery/measurements.json)
contains 18 numeric records, per-call bytes/token estimates, oracle/answer checks,
full SHA-256 pins and the compiled-tree digest. Large replies, artifacts and model
transcripts are not committed. Runtime pins include `dist/mcp/main.js`
(`9bc4c070f63adc9963f276da20b36ffbbcc77b4079585cadf90d792dd2cc04dd`)
and the 2,921-file compiled `dist` tree
(`a8a510499dabc07b3cdf6b164d02e55f2fc6917b696dcc4d23449510e91e80fa`).
The recorded CLI digest is separately bound to `dist/cli.js`. These pins identify
the measured build and selected source-location owners. A later unrelated generated
desktop SQLite diagnostic change and rebuild are outside this snapshot; later
whole-tree hashes do not replace the measured one.

The [portable driver](https://github.com/morluto/rea/blob/main/scripts/verify/analysis/source-location-delivery/task.mjs)
has SHA-256 `b21ec9d5315682337eb55a4ad208e2145a7397d8d567cdb6653facd3f0bec90e`.
The [observer](https://github.com/morluto/rea/blob/main/scripts/verify/analysis/budget-calibration-run.py)
has SHA-256 `c18a06c44715c97ec9cbc76248dfbcd862d0e5ca3cd0c159d868bc7fa1fa9e9f`.
Use the repository's built runtime and pinned Node. Acquisition refuses changed
publisher bytes; the existing acquisition helper creates `artifacts.json` and
analyst manifests under the selected artifact directory.

Create a fresh receipt directory and its `runtime.json` before measuring. Keep
source files and the compiled runtime unchanged throughout all 18 runs and
aggregation; do not build or edit between them. The compiled-tree hash collected
afterward identifies the measured runtime under that condition. Aggregate before
any subsequent rebuild.

```sh
python3 docs/verification/source-map-budgets-2026-11-09/acquire.py \
  docs/verification/source-map-budgets-2026-11-09/artifacts.json /tmp/rea-point-artifacts
python3 - <<'PY'
import hashlib, json
from pathlib import Path
receipts = Path('/tmp/rea-source-location-measurements')
receipts.mkdir()
paths = {
    'driver_sha256': Path('scripts/verify/analysis/source-location-delivery/task.mjs'),
    'observer_sha256': Path('scripts/verify/analysis/budget-calibration-run.py'),
    'cli_sha256': Path('dist/cli.js'),
}
metadata = {key: hashlib.sha256(path.read_bytes()).hexdigest()
            for key, path in paths.items() if key != 'cli_sha256'}
cli = paths['cli_sha256']
metadata['cli_sha256'] = hashlib.sha256(cli.read_bytes()).hexdigest() if cli.is_file() else None
(receipts / 'runtime.json').write_text(json.dumps(metadata, indent=2) + '\n')
PY
python3 scripts/verify/analysis/budget-calibration-run.py \
  --output /tmp/rea-source-location-measurements/r1-index-summary.metrics.json --cwd "$PWD" \
  --timeout-seconds 90 --memory-mib 1536 -- \
  node scripts/verify/analysis/source-location-delivery/task.mjs "$PWD" \
  '{"artifactDir":"/tmp/rea-point-artifacts","select":"index.","detail":"summary","resultPath":"/tmp/rea-source-location-measurements/r1-index-summary.replies.json"}'
```

Run Theme, main and DateSelect with both detail modes serially, three times, reversing
variant order for trial two. Use unique receipt/result paths named
`r1-index-summary.metrics.json` / `.replies.json` (and the corresponding case/trial
names), preserving the runtime metadata. After measurements, the reusable
[aggregator](https://github.com/morluto/rea/blob/main/scripts/verify/analysis/source-location-delivery/aggregate.py)
requires Python with tiktoken 0.12.0 and regenerates the compact record:

```sh
python3 scripts/verify/analysis/source-location-delivery/aggregate.py \
  /tmp/rea-source-location-measurements --repo-root "$PWD" --output /tmp/point-measurements.json
```

The aggregator hashes the compiled tree after performance runs, verifies every
answer and successful complete raw-map response, and excludes large payloads from
its output. Analysis still decodes and retains complete Evidence; this study does
not qualify arbitrary larger maps, batch source-map fetching, browser execution or
disk-cold behavior.

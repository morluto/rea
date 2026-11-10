# Flutter projection budget calibration

Keep the default `pool_policy.uri_limit=500`. Two pinned real APKs show that
requesting 2048 immediately benefits a full bounded package-URI inventory, but
increases complete overview delivery when the task only needs identity and
snapshot facts. This is a task-specific selection, not evidence for a universal
2048 default. No production default changed in this experiment.

## Tasks and correctness

The inventory task retrieves every distinct complete printable ASCII run that
starts `package:` and has length 5–1024 in arm64
`_kDartIsolateSnapshotData`. Both workflows select `contains:"package:"`.
The baseline starts at the default 500 and retries with 2048 when the returned
array is shorter than its count lower bound; the candidate starts at 2048.
Both final arrays exactly match an independent Python ZIP/ELF dynamic-symbol and
section-table parser plus byte-regex oracle. Gallery has 756 matches, LocalSend
1407; 1024 is insufficient for the latter.

The overview control requires target/library identity, ABI and snapshot section
observations, without individual strings. It compares unfiltered complete
Evidence with URI 500 and URI 2048. All calls preserve `run_bytes=1024`,
`token_bytes=128`, `token_limit=2000` and existing admission budgets. Strings
remain byte-pattern observations, not recovered Dart types. Gallery has eight
printable runs over 1024 bytes and LocalSend one. Recovering every bounded
package URI does not make the overall string pool or snapshot coverage complete.

## Measurements

Three serial trials per case, 24 successful fresh source-service processes,
Node 24.22.1, macOS 26.3 arm64. Each starts `FlutterBuildAnalysisService` and closes
its provider. No app installation or execution occurred. OS caches were not
flushed; these are neither cold-cache nor warm-runtime-cache claims. No small
real Flutter artifact was available as a setup control. Eight task variants
across two APKs do not establish universal workload fit.

Values below are medians of three runs; tokens were identical within each case.
The numeric receipts, artifact manifest and portable reproduction tools are in
[`scripts/verify/analysis/flutter-budget-calibration/`](https://github.com/morluto/rea/tree/main/scripts/verify/analysis/flutter-budget-calibration).

| APK / completed task                    | Calls | cl100k tokens | Wall s | CPU s | Peak group RSS MiB |
| --------------------------------------- | ----: | ------------: | -----: | ----: | -----------------: |
| Gallery inventory, default + recovery   |     2 |        14,488 |  0.836 | 1.028 |            258.656 |
| Gallery inventory, 2048 first           |     1 |         8,631 |  0.480 | 0.601 |            238.859 |
| Gallery overview, default               |     1 |        15,995 |  0.448 | 0.639 |            241.922 |
| Gallery overview, 2048                  |     1 |        18,764 |  0.560 | 0.639 |            243.328 |
| LocalSend inventory, default + recovery |     2 |        22,360 |  0.405 | 0.519 |            221.328 |
| LocalSend inventory, 2048 first         |     1 |        16,317 |  0.296 | 0.365 |            184.781 |
| LocalSend overview, default             |     1 |        16,885 |  0.292 | 0.403 |            189.766 |
| LocalSend overview, 2048                |     1 |        27,158 |  0.293 | 0.388 |            189.641 |

Tokens use tiktoken 0.12.0 `cl100k_base`, separately encoding compact Unicode JSON
for every logical request and complete reply, including retries. They are exact
counts for that encoding and those records, not model usage. CLI/MCP discovery,
adapter delivery, retained-resource paging, chat framing and model reasoning
are unmeasured. Path spelling can change replay counts. The driver also emits
separately labeled tokenx 1.3.0 estimates; the table uses cl100k counts.

Wall time includes observer overhead. CPU is OS `wait4` user+system usage of the
waited subtree; it excludes sampler work and descendants not waited for. RSS is
the simultaneous process-group sum sampled every 20 ms: short peaks can be
missed, shared pages can be counted twice and descendants leaving the group
are excluded. The 1536 MiB observer stop is not a kernel hard limit. All 24 runs
exited 0 without a resource stop and left their groups empty. No timing or memory
claim is made for an unmeasured MCP summary workflow; the separate retained
local historical summary study (`experiments/analysis-efficiency/flutter-aot-summary.md`) measured that workflow historically.

The frozen baseline is HEAD `e2a2ede5440df396e44b3406ef511a31a680290e` plus
tracked patch SHA256 `038b69c19bbd79a303c9ecd8d9d22a1251637e3886543ca4f5a4c1b70c724eec`
and copied untracked policy sources. HEAD alone does not identify the measured
runtime. Original driver/oracle hashes and per-run values are retained in
`measurements.json`; retained portable scripts change path resolution without
changing task semantics. Later observer cleanup fixes do not change the sampled
RSS algorithm or these successful, empty-group receipts.

## Reproduce

Use the pinned Node toolchain and installed locked dependencies. Download the two
URLs in `manifest.json` to an external input directory under their declared
filenames. `oracle.py` verifies APK sizes/digests, libapp digests, section offsets
and expected counts before generating exact arrays. Do not commit APKs or raw
reply records. Run comparisons serially; replace the paths below with absolute
paths to the selected source snapshot, Node 24 and external artifacts.

```sh
REA_CAL_REPO=/absolute/path/to/rea
REA_CAL_NODE=/absolute/path/to/node24
REA_CAL_INPUTS=/absolute/path/to/apks
REA_CAL_OUTPUT=/absolute/path/to/receipts
REA_CAL_ASSETS="$REA_CAL_REPO/scripts/verify/analysis/flutter-budget-calibration"
for trial in 1 2 3; do
  python3 "$REA_CAL_ASSETS/oracle.py" "$REA_CAL_INPUTS" "$REA_CAL_OUTPUT/r$trial"
  python3 "$REA_CAL_ASSETS/configs.py" "$REA_CAL_INPUTS" "$REA_CAL_OUTPUT/r$trial"
  for config in "$REA_CAL_OUTPUT/r$trial/"*.config.json; do
    python3 "$REA_CAL_REPO/scripts/verify/analysis/budget-calibration-run.py" \
      --output "${config%.config.json}.metrics.json" --cwd "$REA_CAL_REPO" \
      --timeout-seconds 90 --memory-mib 1536 -- \
      "$REA_CAL_NODE" --import "$REA_CAL_REPO/node_modules/tsx/dist/loader.mjs" \
      "$REA_CAL_ASSETS/task.mjs" "$REA_CAL_REPO" "$config"
  done
done
python3 "$REA_CAL_ASSETS/aggregate.py" "$REA_CAL_OUTPUT" "$REA_CAL_OUTPUT/aggregate.json"
```

`aggregate.py` requires tiktoken 0.12.0. Install it separately if needed; the
calibration scripts do not change the project's dependencies or host software.
Replays on a later checkout are new measurements, not reproduction of the
frozen runtime merely because artifact hashes match.

## Other defaults remain evidence-limited

Keep Apktool strings 2000/table and 10000 aggregate: the retained real
three-APK native-decoder study (`experiments/analysis-efficiency/apktool-string-tables.md`, historical local output) has at most 1126 valid
strings in one table, and three selected locale tables fit the aggregate.
That does not calibrate all APKs or all-locales tasks. No fresh Apktool run was
performed here; the current host lacks the executable.

Keep desktop sampling defaults pending a representative complete state-view
corpus. The pinned official QGIS GPKG used in the historical local query study
(`experiments/analysis-efficiency/sqlite-existing-controls.md`) has 26 declared tables,
240 countries and 4556 states/provinces according to an independent read-only
SQLite count. A 500-row sample covers the former and omits the latter. One
all-column geometry row can expand to 485277 bytes; selected tables/columns are
more appropriate than globally multiplying retained rows. Counts alone do not
calibrate CPU/memory or text/XML defaults.

Keep JavaScript semantic candidate/depth/getter/alias defaults. They bound
analysis work and precision, rather than merely display projection. No
independent real-artifact sensitivity study crossing these defaults was found.
Synthetic recovery regressions establish behavior, not representative workload
fit. This calibration gap remains explicit.

The supporting QGIS input is pinned in `manifest.json`; the row counts were
rechecked with Python SQLite in read-only mode. Historical local studies are
context, not new provider measurements or checked-in raw receipts.

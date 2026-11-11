# JavaScript primitive-budget calibration — 2026-11-09

Keep the existing semantic precision defaults. A narrow real-source comparison
found no additional required facts when doubling `primitive_bytes`; it does not
justify a global increase or replacing the existing conservative admission rule.
The input contract now explains that rule, and its list of defaults derives from
the policy owner instead of repeating independent literals.

## What was checked

Two inert directories went through the actual compiled
`analyze-javascript-application` CLI, including its isolated source worker,
complete Evidence serialization and normal CLI cleanup:

- An original `theme.ts` embedded in the pinned Actual Budget Theme source map.
  The required task recovers all **237** literal CSS property/value pairs and
  their source identity. A separate Python parser accepts only the complete
  literal-only declaration and checks every name/value without using REA's
  evaluator. A small package descriptor constructs the analysis directory; this
  is one captured module, not the complete application or an authenticated
  browser capture.
- The installed locked **ms 2.1.3** package's original `index.js` and package
  descriptor. The requested small control recovers its `s = 1000` millisecond
  base unit. Multiplication-derived coefficients remain unsupported and unknown;
  larger byte admission does not implement arithmetic or prove those values.

Input URLs/digests, a portable preparation/oracle script, CLI task driver and
all twelve compact numeric receipts are in
[the calibration assets](https://github.com/morluto/rea/tree/main/scripts/verify/analysis/javascript-precision-calibration).
No downloaded code or complete large replies are committed. The theme original
source SHA-256 is `05307dc6f927705a8c76e43579c910bf6415ce28b375eea19251dc51dd2b1726`.

## Results

Three fresh CLI/worker trials per case compare omitted precision with explicit
`semantic_precision: {"primitive_bytes": 2097152}`. Both requests hold the worker
and CLI host old-space allowance at 512 MiB. Each task makes one analysis call,
with no retries. All twelve exit successfully, verify the required facts and
leave the observer's process group empty. Theme has no semantic unknowns; ms
keeps the same 133 unrelated unknowns in both variants. This is complete
coverage of the requested facts, not complete semantic understanding of ms.

| Task / allowance              | Required facts | Estimated CLI task tokens | Wall s | CPU s | Sampled host-group RSS MiB |
| ----------------------------- | -------------: | ------------------------: | -----: | ----: | -------------------------: |
| Theme / default 1 MiB         |            237 |                   259,396 |  0.937 | 1.226 |                      330.6 |
| Theme / explicit 2 MiB        |            237 |                   259,475 |  0.928 | 1.229 |                      330.8 |
| ms base unit / default 1 MiB  |              1 |                   234,613 |  0.899 | 1.238 |                      322.2 |
| ms base unit / explicit 2 MiB |              1 |                   234,668 |  0.905 | 1.225 |                      330.5 |

Values are medians of three serial trials, in fixed default-then-double order.
Node 24.22.1 ran on macOS 26.3 arm64; OS caches were not flushed. Mixed small
timing/memory differences do not establish a performance improvement.

Token estimates use tiktoken 0.12.0 `cl100k_base`: compact Unicode JSON of the
actual argv and complete parsed stdout Evidence, plus literal progress stderr.
The full complete replies are about 734 KB for Theme and 624 KB for ms. This
measurement includes the CLI entrypoint, worker, serialized output, and the
driver's correctness checks. It excludes artifact acquisition, one-off oracle
preparation, tokenizer computation, MCP discovery/protocol, chat framing and
model reasoning. These are not billed model tokens or a claim that full output
is an efficient agent workflow; existing retained summary/views can change
delivery independently of evaluator precision. Replays with other path spellings
can have different tokens and identities.

CPU is OS `wait4` user+system usage of the waited subtree; sampler work and
unwaited descendants are excluded. RSS sums the host process group every 20 ms:
short peaks may be missed and shared pages counted more than once. **The isolated
JavaScript worker launches into another process group, so its peak memory is
unmeasured here.** The table is not total process-family peak memory. The
observer's 1536 MiB early-stop guard is not a kernel hard limit; its 90-second
deadline was not reached. Worker old-space flags are also not whole-process
memory limits. Compiled entrypoint and owner hashes are retained because HEAD
`e2a2ede5440df396e44b3406ef511a31a680290e` alone does not identify the measured
uncommitted runtime. Portable scripts revise path handling after measurement
without changing the requested facts; original driver/oracle hashes are retained.

## Why retain the conservative rule

`primitive_bytes` charges six estimated JSON bytes per UTF-16 code unit plus
quotes, before creating concatenations. At the 1 MiB default, 174,762 ASCII units
fit and one additional unit exhausts that estimate, even though actual ASCII
JSON occupies far fewer bytes. Control characters and lone surrogates can need
six escaped bytes, so this is a conservative precision/resource policy rather
than an assertion about observed encoded bytes. Existing regressions retain the
boundary and exact exhausted-control recovery.

A bounded Babel inventory of the pinned generated Theme, main and DateSelect
scripts found their longest static strings/templates to be 152, 936 and 13,120
UTF-16 units respectively. This inventory is not full semantic analysis and
does not bound dynamically composed values or candidate cross-products. It
nevertheless supplies no representative case requiring a higher string default.

Exact preallocation accounting would need to inspect string contents across
every candidate concatenation, including pairs formed across piece boundaries,
while preserving work bounds. Without an observed task failing this estimate,
that added work and complexity are unjustified. The 256-candidate, 512-state and
other depth/work defaults remain provisional: these two tasks do not establish
their suitability for large unions, getters, aliases or adversarial sources.

## Reproduce

Download the pinned Theme map URL from `manifest.json` to external storage, use
the pinned Node toolchain and installed locked dependencies, then run:

```sh
REA_JS_REPO=/absolute/path/to/rea
REA_JS_NODE=/absolute/path/to/node24
REA_JS_DATA=/absolute/path/to/external-receipts
REA_JS_ASSETS="$REA_JS_REPO/scripts/verify/analysis/javascript-precision-calibration"
python3 "$REA_JS_ASSETS/prepare.py" "$REA_JS_REPO" /absolute/path/to/theme.js.map "$REA_JS_DATA"
for trial in 1 2 3; do
  for task in theme ms; do
    for budget in default double; do
      python3 "$REA_JS_REPO/scripts/verify/analysis/budget-calibration-run.py" \
        --output "$REA_JS_DATA/r${trial}-${task}-${budget}.metrics.json" \
        --cwd "$REA_JS_REPO" --timeout-seconds 90 --memory-mib 1536 -- \
        python3 "$REA_JS_ASSETS/task.py" "$REA_JS_REPO" "$REA_JS_NODE" \
        "$REA_JS_DATA" "$task" "$budget" "$REA_JS_DATA/r${trial}-${task}-${budget}.replies.json"
    done
  done
done
python3 "$REA_JS_ASSETS/aggregate.py" "$REA_JS_DATA" "$REA_JS_DATA/aggregate.json"
```

`aggregate.py` needs the separately installed tokenizer version above. These
scripts neither install dependencies nor change host/provider configuration.
Later checkouts are new measurements even when target hashes still match.

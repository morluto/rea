# Scoped MCP discovery over the same completed ELF investigation

## Task, revisions and independent oracle

The task discovers REA, reads cold/repeated export summaries for the local
`libcrypto.so.3`, fetches original first/last export rows, publishes complete
Evidence, verifies repeated discovery and closes the server before authenticating
the exported records. GNU `nm` independently corroborates every returned export
name/address and the complete name set. No target executable is launched.

The baseline is main `e54bf1006`, including
#7218's compact output profile. The feature is
`1cf1973dd58a303dafcbb492b2e2d02775fb90e7`, integrating #3026. Both use the
same `mcp-output-profile.mjs` driver, installed SDK, Node 24.22.1 and Linux x64
host. The target SHA-256 is
`aa01e614af634bc7c8b678c9250b5c4f613c61989bacf0a5d6aed6570e7dcabd`.

Every case completes all 5,367 exports and produces the same authenticated
parent Evidence ID and complete-record digest. The feature with no scope has
an exactly equal parsed catalog to the baseline. Selected families are
`native,application,session`: native exports, retained views and bundle IO
respectively belong to those existing owners. Include every family the task
actually needs; this is an explicit scope, not an automatic dependency resolver.

## Measurements

All cases use compact inputs. The selected-full case verifies caller choice;
its output profile differs from the compact performance comparison.

| Whole case                                           | Main, no scope | Selected, compact output | Selected, full output | Feature, no scope |
| ---------------------------------------------------- | -------------: | -----------------------: | --------------------: | ----------------: |
| Tools                                                |            229 |                       73 |                    73 |               229 |
| Catalog result bytes                                 |        554,792 |                  192,959 |             1,400,171 |           554,792 |
| Catalog cl100k estimate                              |        116,962 |                   41,157 |               354,926 |           116,962 |
| Names/descriptions/input-schema estimate             |         56,909 |                   23,070 |                23,070 |            56,909 |
| Completed task, one discovery, wire estimate         |        123,501 |                   47,693 |               361,462 |           123,501 |
| Executed task with repeated discovery, wire estimate |        240,494 |                   88,881 |               716,419 |           240,494 |
| Elapsed seconds                                      |          21.89 |                     7.00 |                 12.18 |              8.26 |
| CPU seconds                                          |          12.16 |                     6.56 |                 12.23 |              7.59 |
| Sampled family peak RSS, GiB                         |           0.60 |                     0.56 |                  1.04 |              0.59 |

Whole costs include the SDK client, server startup, both analyses, page,
complete export, offline verification and cleanup. Each case starts a fresh
server; repeated queries/discovery are warm within that connection. OS caches
were not flushed. Two CPU affinity slots, a 3 GiB Node heap request and an
8 GiB family RSS guard bound the runs. Summed family RSS is sampled every
100 ms; shared pages can be counted twice and short peaks missed. No run hit
a guard/OOM, and cleanup succeeded. One ordered set of runs does not establish
a general speed or memory improvement.

The compact-output cases finish under an actual 1 MiB SDK receive cap. The
selected-full case uses 10 MiB and retains the complete canonical advertisement;
selection does not silently change the requested output profile.

## Token interpretation

Counts are `cl100k_base` estimates over saved serialized JSON messages, not
actual model usage. Initialization, arguments, replies and discovery are all
included. The one-discovery figure excludes only the explicit repeated catalog
consistency probe; the executed total includes it. Complete local bundle bytes
stay off the wire. The input projection is counted separately for hosts that
forward only names, descriptions and input schemas. Its reduction is observable
without assuming those hosts forward output contracts. Native host prompting,
model decisions and model billing were not measured, and no context-window fit
is guaranteed.

## Reproduction

Build each pinned runtime once. Run the same driver with fresh output paths:

```sh
node experiments/analysis-efficiency/mcp-output-profile.mjs \
  --runtime /path/to/baseline --profile compact \
  --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --receive-bytes 1048576 --output /tmp/rea-families-baseline
node experiments/analysis-efficiency/mcp-output-profile.mjs \
  --runtime /path/to/feature --profile compact \
  --families native,application,session \
  --target /usr/lib/x86_64-linux-gnu/libcrypto.so.3 \
  --receive-bytes 1048576 --output /tmp/rea-families-selected
```

Repeat the feature without `--families` to check default catalog parity, and
with `--profile full` (without the 1 MiB cap) to check output-profile choice.
Reports include catalogs, complete bundles, transcripts and cleanup outcomes.
The resource profiler is external to this driver; choose appropriate bounds
when reproducing. Count each saved transcript `message` once with the tokenizer
above; the input projection contains only name, description and inputSchema.

## Additional public and boundary controls

- Public stdio acceptance confirms discovery/status counts and exact advertised
  tool availability agree, and directly calling an out-of-scope tool returns the
  SDK's disabled-tool error before reading its target.
- Public CLI setup verifies selected families, full backup of the original
  configuration, preserved unrelated entries, scope updates, byte-idempotent
  reruns and invalid-scope refusal without changing configuration or backup.
- Real production MCP doctor completes selected full/compact output scopes and
  reports an invalid family as a startup refusal. SDK boundary cases verify
  omitted families do not trigger Android/ADB/apktool/JEB/EVM probes, while an
  advertised EVM family still triggers its probe.
- The shared family inventory covers every current contract exactly once,
  including recently added analysis-setting and environment tools. Capability
  availability is computed before public scope filtering. Summary candidates
  retain omitted capabilities and meaningful unknowns.

The initial integration exposed stale upstream type signatures and a fixture
that asserted an active-target capability while reporting no open target. The
fixture now uses the existing target-summary owner with complete identity and
requires the whole SDK call to succeed; earlier tests ignored a later invalid
status response. Failed attempt receipts were retained. These fixture controls
do not establish real Ghidra or other external-provider behavior; the measured
ELF workflow uses REA's existing static export reader.

All 31 production MCP doctor cases passed. In a broader combined run, two
live-identity tests exceeded their 30-second deadlines; both then passed in an
isolated feature run (21.4/16.6 seconds), and the representative baseline case
passed in 19.1 seconds. These observations do not establish a deterministic
feature defect or a complete explanation for the timing variation. The initial
failed receipt is retained; test deadlines were unchanged.

A post-rebase combined verification command reached its 190-second outer wall
guard during documentation generation after build, all three stdio profile
cases and check:fast passed. Only the remaining documentation/format checks
were resumed and passed. This was a verification-batch stop, not an OOM or a
completed-investigation result; the stopped receipt remains available.

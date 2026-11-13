# CI shard scheduling measurements — 2026-10-20 and 2026-10-21

These measurements chose the fast tier's eight built shards and the
per-tier timing history. The rules they support live in
[Testing REA](../development/testing.md) and the
[testing lanes guide](../testing-lanes.md). Later runner hardware, worker
limits and test inventory can change every number below.

## Shard budget — run `39451548945` (2026-10-20)

Surrounding jobs, with runner queue excluded: classification 15 seconds, build
49 seconds, and the portable-test merge 29 seconds. Shard 1/5 spent 22 seconds
before built Vitest and 3 seconds after it, including `npm ci` at 9 seconds.
`node_modules` was about 674 MiB, so publishing it as a shared artifact would
transfer more data than that install saves; the npm download cache stays the
setup cache.

File timings from that run put the built suite at 7944 seconds of module time.
The sequencer keeps each file's full duration on one worker. Extra workers
overlap other files in the same sequence group, and `process-boundary` runs
after that group.

| Schedule                                                 | Peak shard file time |
| -------------------------------------------------------- | -------------------- |
| Five shards, unsplit inventory                           | 820 s                |
| Six shards, unsplit inventory                            | 684 s                |
| Eight shards, 578-second loader file split by case count | 513 s                |

The loader split kept 54 cases in the original file and moved 46 into each of
three new files; those three files were later consolidated. That run's slowest
built shard job lasted 925 seconds (shard 4/5), and shard 1/5 spent 874 seconds
in built Vitest, so hosted job time sat above the file schedule. With the
measured 25-second shard setup, an eight-shard job was about 538 seconds.
Adding classification, build and merge gave an uncontended portable critical
path of about 631 seconds, before the gap between the file schedule and hosted
Vitest. Runner queue is separate.

On the same four-core host, raising the Vitest worker cap from two to four cut
a six-file acceptance sample from 96–101 seconds to 71 seconds and did not
remove the single-file floor.

## Stale timing history — runs `39545047294` and `39552964873` (2026-10-21)

The newest full-tier history was run `39545047294`, recorded before
compiled-CLI session reuse. Fast run `39552964873` packed its eight built
shards from that history, and those shard jobs executed for 319–591 seconds.
Replaying that run's file durations through the sequencer's two-worker schedule
balances every shard at about 404 seconds of file time. The same replay with
the stale history weights leaves the slowest shard near 547 seconds and the
fastest near 293. That spread is file-schedule time, not runner queue, which is
why each tier keeps its own history.

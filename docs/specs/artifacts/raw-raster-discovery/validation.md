# Raw candidate validation notes

These observations describe this draft's heuristic, not universal detector
accuracy. No proprietary firmware or extracted private assets are committed.

## Reproducible controls

```sh
npm run test:local -- src/domain/rawRasterDiscovery.test.ts
```

The fixtures include an unheadered grayscale raster embedded in noise and RGB /
RGBA variants that are admitted by the existing decoder. They also exercise
constant data, cancellation, admission, retained-result limits, explicit offset
grid misses and incomplete budget coverage. A numeric table deliberately passes:
spatial continuity is not sufficient evidence of image identity.

The seeded-noise test checks 100 xorshift32 seeds (1..100), 8,192 bytes each,
widths 16/32/64, heights 16/32, three formats, offset step 256. It evaluates
42,600 hypotheses and accepts none. This is a fixed negative control, not an
estimated false-positive rate on real binaries.

## Local real-icon and binary controls

A local optional check converted the first 40 sorted PNGs under
`/usr/share/icons/Adwaita` to RGBA using Pillow. They are 16x16 desktop icons,
not private firmware and not committed fixtures. Tests used their exact known
geometry/start, so these results **do not measure geometry discovery**.

The initial hardcoded 0.65 threshold accepted only 6 of the first 20 icons.
Inspection of the actual neighbour/distant metrics confirmed the test was valid:
most rejected scores lay around 0.56–0.64. Exposing a threshold and using 0.5
(the neighbour difference must be at most half the distant baseline) improved
this development set to 17/20. The next 20 icons, not used for that adjustment,
scored 15/20 at 0.65 and 20/20 at 0.5. At 0.4 both groups scored 20/20, but that
more permissive value was not adopted as the default.

A separate embedding check placed each of the 40 icons at offset 2048 in an
8192-byte seeded-noise buffer. With offset step 16, budget 100000, all default
geometries/formats and threshold 0.5, the exact RGBA16x16 layout appeared in the
top100 for 34/40 and top20 for 21/40. Ranking competing windows remains imperfect.

The tradeoff matters. Using the default adaptive grid on local executables:

| File               | Tested hypotheses | Accepted at 0.65 | Accepted at 0.5 |
| ------------------ | ----------------: | ---------------: | --------------: |
| `/bin/ls`          |             17641 |              117 |             430 |
| `/bin/bash`        |             19749 |               98 |             309 |
| `/usr/bin/python3` |             19979 |               16 |             152 |

These are **not verified embedded images**. Structured binary data produces many
candidate layouts. No universal false-positive rate is inferred from three files;
the counts explain why output stays labelled hypotheses, why selected ranges and
threshold controls matter, and why rank alone cannot validate an extraction.

## Review corrections

Independent review found that skipping non-fitting layouts could bypass the
hypothesis budget and cancellation. Layouts are now prefiltered and sorted by
span; impossible selections return without scanning offsets, and each offset
stops at the first non-fitting span. Regression tests cover 32x32 impossible
geometry choices and an already-cancelled request.

The original default grid spent its whole budget near the beginning of large
selections. The default stride now adapts to the byte range, geometry count and
budget. Explicit caller strides remain unchanged. `coverage.nextOffset` identifies
the first partially or fully untested start, not a lossless resume cursor;
reducing the geometry grid or raising the budget may be necessary.

## Separate integration verification

Domain controls alone do not prove CLI/MCP registration, filesystem race handling,
cleanup or generated-catalog consistency. Those are checked separately by the
application and transport tests and reported with the final verification run.

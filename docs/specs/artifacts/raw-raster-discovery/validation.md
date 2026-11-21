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

## Development controls and limitations

Optional local desktop-icon controls exercised known RGBA geometry and planted
icons in seeded noise. Candidate ranking missed some planted layouts and showed
sensitivity to the selected threshold. These checks are not committed fixtures
and do not establish geometry-discovery accuracy.

Ordinary executable bytes produced many plausible candidates. They were not
verified embedded images: structured numerical data can have spatial continuity.
Rank and score therefore remain hypotheses, not calibrated probabilities or proof
of a successful extraction. Threshold controls trade missed candidates against
false positives; no universal false-positive rate is established.

Committed regressions cover non-fitting layouts, already-cancelled requests and
bounded scanning. The default stride adapts to range, geometry count and budget;
explicit caller strides remain unchanged. `coverage.nextOffset` identifies the
first partly or wholly untested start, not a lossless resume cursor.

## Separate integration verification

Domain controls alone do not prove CLI/MCP registration, filesystem race handling,
cleanup or generated-catalog consistency. Those are checked separately by the
application and transport tests and reported with the final verification run.

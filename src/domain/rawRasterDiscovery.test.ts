import { it as test } from "vitest";
import assert from "node:assert/strict";
import {
  discoverRawRaster,
  type RawRasterDiscoveryOptions,
} from "./rawRasterDiscovery.js";
const options: RawRasterDiscoveryOptions = {
  widths: [16, 32],
  heights: [16],
  formats: ["gray8"],
  offsetStep: 256,
  maxHypotheses: 100,
  maxCandidates: 20,
};
function noise(n: number) {
  let s = 12345;
  return Uint8Array.from({ length: n }, () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s & 255;
  });
}
test("finds an embedded unheadered raster without a firmware profile", () => {
  const bytes = noise(4096);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 32; x++)
      bytes[512 + y * 32 + x] = (x * 5 + y * 3) & 255;
  const result = discoverRawRaster(bytes, options);
  assert.ok(
    result.candidates.some(
      (c) => c.layout.offset === 512 && c.layout.width === 32,
    ),
  );
  assert.equal(result.coverage.complete, true);
  assert.equal(result.candidates[0]?.status, "hypothesis");
});
test("constant and seeded random controls have no accepted candidates", () => {
  for (const bytes of [new Uint8Array(4096), noise(4096)])
    assert.equal(discoverRawRaster(bytes, options).candidates.length, 0);
});
test("structured non-image bytes can pass and are not claimed to be images", () => {
  const bytes = Uint8Array.from(
    { length: 512 },
    (_, i) => (i % 32) * 5 + Math.floor(i / 32) * 3,
  );
  const result = discoverRawRaster(bytes, options);
  assert.ok(result.candidates.length);
  assert.match(result.limitations.join(" "), /non-image/);
});
test("reports incomplete hypothesis coverage at the budget, not absence", () => {
  const result = discoverRawRaster(noise(4096), {
    ...options,
    maxHypotheses: 1,
  });
  assert.equal(result.coverage.tested, 1);
  assert.equal(result.coverage.complete, false);
});
test("rejects invalid and excessive search configurations before scanning", () => {
  for (const patch of [
    { offsetStep: 0 },
    { widths: [0] },
    { maxHypotheses: 1000001 },
    { formats: ["indexed4"] },
    { maxCandidates: 0 },
  ])
    assert.throws(() =>
      discoverRawRaster(new Uint8Array(1024), {
        ...options,
        ...patch,
      } as RawRasterDiscoveryOptions),
    );
});
test("deterministic ranking, candidate span admission, and output cap", () => {
  const bytes = Uint8Array.from(
    { length: 4096 },
    (_, i) => (i % 32) * 4 + (Math.floor(i / 32) % 32),
  );
  const a = discoverRawRaster(bytes, { ...options, maxCandidates: 2 });
  assert.deepEqual(
    a,
    discoverRawRaster(bytes, { ...options, maxCandidates: 2 }),
  );
  assert.ok(a.candidates.length <= 2);
  for (const c of a.candidates)
    assert.ok(c.layout.offset + c.layout.length <= bytes.length);
});
test("RGB and RGBA hypotheses pass the existing decoder without external palettes", async () => {
  const { decodeRawRaster } = await import("./rawRaster.js");
  for (const format of ["rgb888", "rgba8888"] as const) {
    const channels = format === "rgb888" ? 3 : 4;
    const bytes = noise(4096);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 32; x++)
        for (let c = 0; c < channels; c++)
          bytes[256 + (y * 32 + x) * channels + c] =
            c === 3 ? 255 : x * 5 + y * 3 + c * 2;
    const report = discoverRawRaster(bytes, { ...options, formats: [format] });
    const candidate = report.candidates.find(
      (c) => c.layout.offset === 256 && c.layout.width === 32,
    );
    assert.ok(candidate);
    const decoded = decodeRawRaster(bytes, candidate.layout, {
      maxSourceBytes: 4096,
      maxOutputBytes: 4096,
    });
    assert.equal(decoded.ok, true);
  }
});
test("cancellation is honored before a hypothesis and input bytes are unchanged", () => {
  const bytes = noise(1024),
    before = bytes.slice();
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => discoverRawRaster(bytes, options, controller.signal));
  discoverRawRaster(bytes, options);
  assert.deepEqual(bytes, before);
});
test("off-grid planted image is not guaranteed and coverage is explicit", () => {
  const bytes = noise(4096);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 32; x++) bytes[513 + y * 32 + x] = x * 5 + y * 3;
  const report = discoverRawRaster(bytes, options);
  assert.ok(report.candidates.every((c) => c.layout.offset !== 513));
  assert.equal(report.coverage.offsetStep, 256);
});
test("no fitting layouts return without traversing the offset grid", () => {
  const dimensions = Array.from({ length: 32 }, (_, i) => 4000 + i);
  const report = discoverRawRaster(new Uint8Array(1024 * 1024), {
    widths: dimensions,
    heights: dimensions,
    offsetStep: 1,
    maxHypotheses: 1,
  });
  assert.equal(report.coverage.tested, 0);
  assert.equal(report.coverage.complete, true);
});
test("default adaptive grid covers a large selection instead of exhausting the prefix", () => {
  const report = discoverRawRaster(new Uint8Array(1024 * 1024));
  assert.equal(report.coverage.complete, true);
  assert.ok(report.coverage.offsetStep > 16);
  assert.equal(report.coverage.nextOffset, null);
});
test("100 seeded noise controls do not produce accepted candidates on the fixed control grid", () => {
  let tested = 0;
  for (let seed = 1; seed <= 100; seed++) {
    let state = seed;
    const bytes = Uint8Array.from({ length: 8192 }, () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state & 255;
    });
    const report = discoverRawRaster(bytes, {
      widths: [16, 32, 64],
      heights: [16, 32],
      offsetStep: 256,
      formats: ["gray8", "rgb888", "rgba8888"],
      maxHypotheses: 10000,
    });
    tested += report.coverage.tested;
    assert.equal(report.coverage.accepted, 0);
  }
  assert.equal(tested, 42600);
});
test("score threshold is explicit and validated independently of probability claims", () => {
  const bytes = Uint8Array.from(
    { length: 512 },
    (_, i) => (i % 32) * 5 + Math.floor(i / 32) * 3,
  );
  const permissive = discoverRawRaster(bytes, { ...options, minScore: 0.5 });
  const strict = discoverRawRaster(bytes, { ...options, minScore: 1 });
  assert.ok(permissive.candidates.length > strict.candidates.length);
  assert.equal(permissive.coverage.minScore, 0.5);
  for (const minScore of [-1, 1.01, NaN, Infinity])
    assert.throws(() => discoverRawRaster(bytes, { ...options, minScore }));
});

import { expect, it } from "vitest";
import { discoverStructuredRasters } from "./structuredRasterDiscovery.js";
import { discoverRasterRegistryFamily } from "./rasterRegistryFamily.js";
import { registryFixture } from "../../tests/fixtures/rasterRegistry.js";
const inspect = (
  f: ReturnType<typeof registryFixture>,
  coverage = [{ offset: 0, length: f.bytes.length }],
  maxWork?: number,
) =>
  discoverRasterRegistryFamily(
    f.bytes,
    discoverStructuredRasters(f.bytes, { coverage }),
    coverage,
    maxWork === undefined ? {} : { maxWork },
  );
it("infers relocated signed bias and keeps enclosed dynamic rows and all palette alternatives", () => {
  for (const [shift, bias] of [
    [0, 0x240000],
    [334, 0x250000],
    [4096, -4096],
  ]) {
    const f = registryFixture(shift, bias),
      r = inspect(f),
      c = r.registries[0]!;
    expect(r.status).toBe("unique");
    expect(r.coverage.complete).toBe(true);
    expect(c.pointerBias).toBe(bias);
    expect(c.rows.map((x) => x.countSource)).toEqual([
      "static-u16",
      "enclosed-dynamic",
      "static-u16",
    ]);
    expect(c.bindings).toHaveLength(10);
    expect(c.bindings[0]).toMatchObject({
      descriptorOffset: f.table,
      format: 1,
      layout: "indexed1",
      stride: 3,
      payloadRange: { offset: f.table + 120, length: 9 },
      lookupRange: { offset: f.lookup, length: 4 },
      rowOrder: "bottom-up",
      bitOrder: "msb-first",
      provenance: "profile-declared",
    });
    expect(c.palettes.map((p) => p.range.offset)).toEqual(f.palettes);
  }
});
it("rejects dynamic-only rows and excludes rows beyond static anchors", () => {
  const f = registryFixture(),
    v = new DataView(f.bytes.buffer);
  v.setUint32(f.start + 20, 560 + f.bias, true);
  expect(inspect(f).registries[0]?.rows.map((x) => x.range.offset)).toEqual([
    f.start + 56,
  ]);
  v.setUint32(f.start + 56 + 20, 560 + f.bias, true);
  expect(inspect(f).registries).toEqual([]);
});
it.each([
  "count",
  "lookup",
  "payload-gap",
  "lookup-index",
  "unsupported-0",
  "unsupported-5",
])("withholds malformed or unsupported bindings: %s", (kind) => {
  const f = registryFixture(),
    v = new DataView(f.bytes.buffer);
  let coverage = [{ offset: 0, length: f.bytes.length }];
  if (kind === "count")
    for (let i = 0; i < 3; i++) v.setUint16(512 + i * 4, 999, true);
  if (kind === "lookup") v.setUint16(f.lookup, 999, true);
  if (kind === "lookup-index") f.bytes[f.table + 1] = 255;
  if (kind === "payload-gap")
    coverage = [
      { offset: 0, length: f.table + 120 },
      { offset: f.table + 121, length: f.bytes.length - f.table - 121 },
    ];
  if (kind.startsWith("unsupported"))
    f.bytes[f.table + 108] = kind.endsWith("0") ? 0 : 5;
  expect(inspect(f, coverage).registries).toEqual([]);
});
it.each(["duplicate", "sentinel", "gap", "out-of-range"])(
  "does not bind invalid palette grammar/ranges: %s",
  (kind) => {
    const f = registryFixture(),
      v = new DataView(f.bytes.buffer);
    let coverage = [{ offset: 0, length: f.bytes.length }];
    if (kind === "duplicate") v.setUint32(f.start - 40, 1, true);
    if (kind === "sentinel") v.setUint32(f.start - 8, 1, true);
    if (kind === "out-of-range")
      for (const i of [0, 4])
        v.setUint32(f.start - 72 + i * 8, 0xffffffff, true);
    if (kind === "gap")
      coverage = [
        { offset: 0, length: f.palettes[0]! + 1 },
        {
          offset: f.palettes[0]! + 2,
          length: f.bytes.length - f.palettes[0]! - 2,
        },
      ];
    expect(inspect(f, coverage).registries[0]?.palettes).toEqual([]);
  },
);
it("keeps separate registries and conflicting repeated bindings explicit", () => {
  const f = registryFixture(),
    v = new DataView(f.bytes.buffer);
  f.bytes.set(f.bytes.slice(f.start, f.start + 28), 11520);
  expect(inspect(f).status).toBe("ambiguous");
  expect(inspect(f).registries).toHaveLength(2);
  v.setUint32(f.start + 56 + 4, f.lookup + 4 + f.bias, true);
  v.setUint16(f.lookup + 8, 2, true);
  v.setUint16(f.lookup + 10, 3, true);
  const r = inspect(f);
  expect(r.registries[0]?.bindingStatus).toBe("conflicting");
  expect(r.registries[0]?.bindings).toEqual([]);
});
it.each([
  [2, 2, 1, "indexed2"],
  [3, 4, 1, "indexed4"],
  [4, 8, 1, "indexed8"],
  [6, 16, 2, "rgb565le"],
] as const)(
  "declares supported format %i without changing generic hypotheses",
  (format, bits, unit, layout) => {
    const f = registryFixture(),
      v = new DataView(f.bytes.buffer);
    let payload = 0;
    for (let i = 0; i < 10; i++) {
      const at = f.table + i * 12;
      f.bytes[at] = format;
      f.bytes[at + 1] = 0;
      v.setUint16(at + 2, 24, true);
      v.setUint32(at + 8, payload, true);
      payload += (Math.ceil((24 * bits) / 8) * 3) / unit;
    }
    if (format < 4) {
      for (let j = 0; j < 2 << bits; j += 2)
        v.setUint16(f.lookup + j, j / 2, true);
      for (let i = 0; i < 3; i++)
        v.setUint32(f.start + i * 28 + format * 4, f.lookup + f.bias, true);
    }
    const report = discoverStructuredRasters(f.bytes),
      before = structuredClone(report);
    const r = discoverRasterRegistryFamily(f.bytes, report, [
      { offset: 0, length: f.bytes.length },
    ]);
    expect(report).toEqual(before);
    expect(r.registries[0]?.bindings[0]).toMatchObject({
      layout,
      bitsPerPixel: bits,
      offsetUnit: unit,
    });
  },
);
it("bounds independent work and propagates incomplete discovery and cancellation", () => {
  const f = registryFixture(),
    report = discoverStructuredRasters(f.bytes),
    coverage = [{ offset: 0, length: f.bytes.length }];
  expect(inspect(f, coverage, 1).coverage).toMatchObject({
    work: 1,
    maxWork: 1,
    complete: false,
    reason: "work-limit",
  });
  expect(
    discoverRasterRegistryFamily(
      f.bytes,
      { ...report, coverage: { ...report.coverage, complete: false } },
      coverage,
    ).coverage,
  ).toMatchObject({ complete: false, discoveryComplete: false });
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    discoverRasterRegistryFamily(
      f.bytes,
      report,
      coverage,
      {},
      controller.signal,
    ),
  ).toThrow();
  expect(
    discoverRasterRegistryFamily(
      f.bytes,
      { ...report, grammar: { ...report.grammar, endianness: "big" } },
      coverage,
    ).status,
  ).toBe("unsupported");
});
it.each([
  [10, "row-limit"],
  [40, "binding-limit"],
] as const)(
  "caps fanout for %i records across all alternatives",
  (count, reason) => {
    const f = registryFixture(0, 0x240000, count),
      bytes = new Uint8Array(32768).fill(255);
    bytes.set(f.bytes);
    for (let i = 0; i < 140; i++)
      bytes.set(f.bytes.slice(f.start, f.start + 28), 13000 + i * 64);
    const r = inspect({ ...f, bytes });
    expect(r.coverage).toMatchObject({ complete: false, reason });
    expect(r.registries.flatMap((x) => x.rows).length).toBeLessThanOrEqual(128);
    expect(r.registries.flatMap((x) => x.bindings).length).toBeLessThanOrEqual(
      4096,
    );
  },
);
it("admits structural non-image numerical palettes without claiming image identity, rejects noise", () => {
  const f = registryFixture();
  for (const at of f.palettes)
    for (let i = 0; i < 1024; i++) f.bytes[at + i] = (i * 73 + 19) % 256;
  expect(inspect(f).registries[0]?.palettes).toHaveLength(4);
  expect(inspect(f).limitations.join(" ")).toMatch(/non-image/);
  const bytes = Uint8Array.from(
    { length: 8192 },
    (_, i) => (i * 73 + 19) % 256,
  );
  expect(inspect({ ...f, bytes }).registries).toEqual([]);
});
it("does not invent bytes across highly fragmented covered ranges", () => {
  const f = registryFixture(),
    bytes = new Uint8Array(140000).fill(255);
  bytes.set(f.bytes);
  const coverage = Array.from({ length: 70000 }, (_, i) => ({
    offset: i * 2,
    length: 1,
  }));
  const report = discoverStructuredRasters(bytes, { coverage });
  const r = discoverRasterRegistryFamily(bytes, report, coverage);
  expect(r.registries).toEqual([]);
  expect(r.coverage.complete).toBe(true);
});
it("charges candidate fanout to work and checks cancellation during scanning", () => {
  const f = registryFixture(),
    report = discoverStructuredRasters(f.bytes),
    coverage = [{ offset: 0, length: f.bytes.length }];
  const fanout = {
    ...report,
    tables: Array.from({ length: 128 }, () => report.tables[0]!),
  };
  expect(
    discoverRasterRegistryFamily(f.bytes, fanout, coverage, { maxWork: 300 })
      .coverage,
  ).toMatchObject({ work: 300, complete: false, reason: "work-limit" });
  let calls = 0;
  const reason = new Error("during family scan");
  const signal = {
    throwIfAborted() {
      if (++calls === 100) throw reason;
    },
  } as AbortSignal;
  expect(() =>
    discoverRasterRegistryFamily(f.bytes, report, coverage, {}, signal),
  ).toThrow(reason);
  expect(calls).toBe(100);
});
it("keeps same-offset unequal aliases unbound even when generic admission is tolerant", () => {
  const f = registryFixture(),
    v = new DataView(f.bytes.buffer);
  v.setUint32(f.table + 12 + 8, 0, true);
  const report = discoverStructuredRasters(f.bytes, { minConsistency: 0.5 });
  expect(report.tables.length).toBeGreaterThan(0);
  const r = discoverRasterRegistryFamily(f.bytes, report, [
    { offset: 0, length: f.bytes.length },
  ]);
  expect(r.registries).toEqual([]);
});
it("does not span a broken registry row or bind a payload outside coverage", () => {
  const f = registryFixture(),
    v = new DataView(f.bytes.buffer);
  v.setUint32(f.start + 28 + 16, 0, true);
  expect(inspect(f).registries).toHaveLength(2);
  v.setUint32(f.table + 108 + 8, 0xffffffff, true);
  expect(inspect(f).registries).toEqual([]);
});

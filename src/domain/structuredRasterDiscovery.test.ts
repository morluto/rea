import { expect, it } from "vitest";
import {
  discoverStructuredRasters,
  DEFAULT_STRUCTURED_RASTER_GRAMMAR,
} from "./structuredRasterDiscovery.js";
function fixture(prefix = 0, big = false) {
  const n = 12,
    stride = 12,
    payload: number[] = [];
  const out = new Uint8Array(prefix + n * stride + 4096);
  out.fill(255);
  const view = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const at = prefix + i * stride,
      w = 9 + i,
      h = 8 + (i % 3),
      bits = 1;
    view.setUint8(at, 5);
    view.setUint8(at + 1, 0);
    view.setUint16(at + 2, w, !big);
    view.setUint16(at + 4, h, !big);
    view.setUint16(at + 6, 0, !big);
    view.setUint32(at + 8, payload.length, !big);
    for (let j = 0; j < Math.ceil((w * bits) / 8) * h; j++)
      payload.push(j % 251);
  }
  out.set(payload, prefix + n * stride);
  return {
    bytes: out.subarray(0, prefix + n * stride + payload.length),
    prefix,
    n,
  };
}
it("finds relocated tables with novel enum and infers sub-byte length relationships", () => {
  for (const prefix of [0, 256, 4096]) {
    const { bytes, n } = fixture(prefix);
    const r = discoverStructuredRasters(bytes);
    const t = r.tables.find((t) => t.offset === prefix);
    expect(t?.recordCount).toBe(n);
    expect(
      t?.formats[0]?.hypotheses.map((h) => [h.bitsPerPixel, h.offsetUnit]),
    ).toEqual([[1, 1]]);
    expect(
      t?.resources.every(
        (r) => r.status === "unique" && r.hypotheses[0]?.covered,
      ),
    ).toBe(true);
  }
});
it("accepts explicit alternate endian grammar rather than silently guessing", () => {
  const { bytes } = fixture(0, true);
  expect(
    discoverStructuredRasters(bytes).tables.flatMap((t) =>
      t.formats.flatMap((f) => f.hypotheses),
    ),
  ).toHaveLength(0);
  expect(
    discoverStructuredRasters(bytes, {
      grammar: { ...DEFAULT_STRUCTURED_RASTER_GRAMMAR, endianness: "big" },
    }).tables[0]?.recordCount,
  ).toBe(12);
});
it("does not bridge descriptor holes or claim covered payload across gaps", () => {
  const { bytes } = fixture();
  const hole = 12 * 12 + 10;
  const r = discoverStructuredRasters(bytes, {
    coverage: [
      { offset: 0, length: hole },
      { offset: hole + 1, length: bytes.length - hole - 1 },
    ],
  });
  expect(r.tables[0]?.resources[0]?.hypotheses[0]?.covered).toBe(false);
  const split = discoverStructuredRasters(bytes, {
    coverage: [
      { offset: 0, length: 6 * 12 },
      { offset: 6 * 12 + 1, length: bytes.length - 6 * 12 - 1 },
    ],
  });
  expect(split.tables).toHaveLength(0);
});
it("retains byte/word-unit ambiguity rather than selecting a semantic format", () => {
  const { bytes } = fixture();
  const v = new DataView(bytes.buffer);
  let offset = 0;
  for (let i = 0; i < 12; i++) {
    v.setUint16(i * 12 + 2, 16, true);
    v.setUint16(i * 12 + 4, 8, true);
    v.setUint32(i * 12 + 8, offset, true);
    offset += 128;
  }
  const r = discoverStructuredRasters(bytes);
  expect(
    r.tables[0]?.formats[0]?.hypotheses.map((h) => [
      h.bitsPerPixel,
      h.offsetUnit,
    ]),
  ).toEqual([
    [8, 1],
    [16, 2],
    [32, 4],
  ]);
  expect(r.tables[0]?.resources[0]?.status).toBe("ambiguous");
});
it("reports work exhaustion without manufacturing a table-end or payload base", () => {
  const { bytes } = fixture();
  const r = discoverStructuredRasters(bytes, { maxWork: 4 });
  expect(r.coverage.complete).toBe(false);
  expect(r.tables).toHaveLength(0);
});
it("rejects malformed grammar, budgets, coverage and cancelled work", () => {
  const { bytes } = fixture();
  expect(() => discoverStructuredRasters(bytes, { maxWork: 0 })).toThrow();
  expect(() =>
    discoverStructuredRasters(bytes, {
      grammar: { ...DEFAULT_STRUCTURED_RASTER_GRAMMAR, recordStride: 4 },
    }),
  ).toThrow();
  expect(() =>
    discoverStructuredRasters(bytes, {
      coverage: [{ offset: bytes.length, length: 1 }],
    }),
  ).toThrow();
  const controller = new AbortController();
  controller.abort();
  expect(() =>
    discoverStructuredRasters(bytes, {}, controller.signal),
  ).toThrow();
});
it("keeps structurally equivalent non-image data hypothetical and bytes unchanged", () => {
  const { bytes } = fixture();
  const before = bytes.slice();
  const r = discoverStructuredRasters(bytes);
  expect(r.tables.length).toBeGreaterThan(0);
  expect(r.limitations.join(" ")).toMatch(/non-image/);
  expect(bytes).toEqual(before);
});
it("supports a genuinely alternate stride/alignment and field placement", () => {
  const { bytes, n } = fixture();
  const stride = 16,
    prefix = 16;
  const alternate = new Uint8Array(prefix + n * stride + bytes.length - n * 12);
  alternate.fill(255);
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dst = new DataView(alternate.buffer);
  for (let i = 0; i < n; i++) {
    const at = prefix + i * stride;
    dst.setUint32(at, src.getUint32(i * 12 + 8, true), true);
    dst.setUint16(at + 4, src.getUint16(i * 12 + 4, true), true);
    dst.setUint16(at + 6, src.getUint16(i * 12 + 2, true), true);
    dst.setUint8(at + 8, src.getUint8(i * 12));
    dst.setUint16(at + 10, 0, true);
  }
  alternate.set(bytes.subarray(n * 12), prefix + n * stride);
  const report = discoverStructuredRasters(alternate, {
    grammar: {
      ...DEFAULT_STRUCTURED_RASTER_GRAMMAR,
      recordStride: stride,
      scanAlignment: 4,
      fields: {
        payloadOffset: { offset: 0, byteWidth: 4 },
        height: { offset: 4, byteWidth: 2 },
        width: { offset: 6, byteWidth: 2 },
        format: { offset: 8, byteWidth: 1 },
        reserved: { offset: 10, byteWidth: 2 },
      },
    },
  });
  const table = report.tables.find((t) => t.offset === prefix);
  expect(table?.recordCount).toBe(n);
  expect(table?.resources.every((r) => r.hypotheses[0]?.covered)).toBe(true);
});
it("marks unfinished runs as incomplete at the record limit instead of inventing an end", () => {
  const { bytes } = fixture();
  const report = discoverStructuredRasters(bytes, { maxRecords: 8 });
  expect(report.coverage.reason).toBe("record-limit");
  expect(report.coverage.complete).toBe(false);
  expect(report.tables).toHaveLength(0);
});
it("rejects random/constant controls and validates overlaps without allocating pixels", () => {
  let state = 927;
  const random = Uint8Array.from({ length: 8192 }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 255;
  });
  for (const bytes of [
    random,
    new Uint8Array(8192),
    new Uint8Array(8192).fill(255),
  ])
    expect(discoverStructuredRasters(bytes).tables).toHaveLength(0);
  expect(() =>
    discoverStructuredRasters(random, {
      grammar: {
        ...DEFAULT_STRUCTURED_RASTER_GRAMMAR,
        fields: {
          ...DEFAULT_STRUCTURED_RASTER_GRAMMAR.fields,
          width: { offset: 0, byteWidth: 2 },
        },
      },
    }),
  ).toThrow(/overlap/);
});
it("retains uncovered resources on payload truncation, without reducing ambiguity", () => {
  const { bytes } = fixture();
  const result = discoverStructuredRasters(bytes.subarray(0, bytes.length - 5));
  const resources = result.tables[0]!.resources;
  expect(resources.at(-1)?.hypotheses[0]?.covered).toBe(false);
  expect(resources.at(-1)?.status).toBe("unique");
  expect(resources.slice(0, -1).every((r) => r.hypotheses[0]?.covered)).toBe(
    true,
  );
});
it("applies the declared consistency threshold without discarding competing passing hypotheses", () => {
  const { bytes } = fixture();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(2, 265, true);
  const tolerant = discoverStructuredRasters(bytes).tables[0]!.formats[0]!;
  expect(tolerant.comparisons).toBe(11);
  expect(tolerant.hypotheses[0]?.matches).toBe(10);
  expect(tolerant.hypotheses[0]?.consistency).toBe(10 / 11);
  expect(
    discoverStructuredRasters(bytes, { minConsistency: 1 }).tables,
  ).toHaveLength(0);
  view.setUint16(14, 266, true);
  expect(discoverStructuredRasters(bytes).tables).toHaveLength(0);
});
it("does not let uncorroborated tables consume the retained table limit", () => {
  const { bytes } = fixture();
  const first = bytes.slice();
  const view = new DataView(first.buffer);
  for (let i = 0; i < 12; i++) view.setUint32(i * 12 + 8, i * 1009, true);
  const secondOffset = Math.ceil((first.length + 16) / 2) * 2;
  const combined = new Uint8Array(secondOffset + bytes.length);
  combined.fill(255);
  combined.set(first);
  combined.set(bytes, secondOffset);
  const result = discoverStructuredRasters(combined, { maxTables: 1 });
  expect(result.coverage.rejectedUncorroboratedTables).toBeGreaterThan(0);
  expect(result.tables[0]?.offset).toBe(secondOffset);
});

it("accepts every covered range admitted by the logical segment owner", async () => {
  const { materializeRasterSegments } =
    await import("./rasterLogicalSegments.js");
  const count = 65537;
  const source = new Uint8Array(count * 4);
  const image = materializeRasterSegments(
    source,
    Array.from({ length: count }, (_, i) => ({
      logicalOffset: i * 8,
      fileOffset: i * 4,
      length: 4,
    })),
  );
  expect(image.coverage).toHaveLength(count);
  const result = discoverStructuredRasters(image.bytes, {
    coverage: image.coverage,
    maxWork: 1,
  });
  expect(result.tables).toEqual([]);
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.reason).toBe("work-limit");
});

it("observes an already-aborted signal before inspecting coverage", () => {
  const controller = new AbortController();
  const reason = new Error("cancel before preprocessing");
  controller.abort(reason);
  let inspected = false;
  const range = {
    get offset() {
      inspected = true;
      return 0;
    },
    length: 16,
  };
  expect(() =>
    discoverStructuredRasters(
      new Uint8Array(16),
      { coverage: [range] },
      controller.signal,
    ),
  ).toThrow(reason);
  expect(inspected).toBe(false);
});

function aliasFixture(unequal = false) {
  const bytes = new Uint8Array(1024).fill(255),
    v = new DataView(bytes.buffer);
  for (let i = 0; i < 10; i++) {
    const at = i * 12;
    bytes[at] = 11;
    bytes[at + 1] = 0;
    v.setUint16(at + 2, unequal && i === 1 ? 8 : 16, true);
    v.setUint16(at + 4, unequal && i === 1 ? 16 : 8, true);
    v.setUint16(at + 6, 0, true);
    v.setUint32(at + 8, Math.max(0, i - 1) * 16, true);
  }
  return bytes;
}
it("counts identical payload aliases once while retaining every descriptor", () => {
  const t = discoverStructuredRasters(aliasFixture(), {
    bitsPerPixel: [1],
    offsetUnits: [1],
  }).tables[0];
  expect(t?.recordCount).toBe(10);
  expect(t?.formats[0]?.comparisons).toBe(8);
  expect(t?.formats[0]?.hypotheses[0]).toMatchObject({
    matches: 8,
    consistency: 1,
  });
  expect(t?.resources[0]?.hypotheses).toEqual(t?.resources[1]?.hypotheses);
});
it("does not treat unequal same-size aliases as corroboration or resolved resources", () => {
  expect(
    discoverStructuredRasters(aliasFixture(true), {
      bitsPerPixel: [1],
      offsetUnits: [1],
    }).tables,
  ).toEqual([]);
  const t = discoverStructuredRasters(aliasFixture(true), {
    bitsPerPixel: [1],
    offsetUnits: [1],
    minConsistency: 0.5,
  }).tables[0];
  expect(t?.resources.slice(0, 2).map((r) => r.status)).toEqual([
    "unresolved",
    "unresolved",
  ]);
});
it("does not pool equal enums in unrelated tables", () => {
  const a = fixture(0).bytes,
    b = fixture(0).bytes,
    v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 0;
  for (let i = 0; i < 12; i++) {
    v.setUint32(i * 12 + 8, offset, true);
    offset += Math.ceil(((9 + i) * 4) / 8) * (8 + (i % 3));
  }
  const bytes = new Uint8Array(8192).fill(255);
  bytes.set(a);
  bytes.set(b, 4096);
  const r = discoverStructuredRasters(bytes);
  expect(
    r.tables
      .find((t) => t.offset === 0)
      ?.formats[0]?.hypotheses.map((h) => h.bitsPerPixel),
  ).toEqual([1]);
  expect(
    r.tables
      .find((t) => t.offset === 4096)
      ?.formats[0]?.hypotheses.some((h) => h.bitsPerPixel === 4),
  ).toBe(true);
});

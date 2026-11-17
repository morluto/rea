import { expect, it } from "vitest";
import { discoverStructuredRasters } from "../../domain/structuredRasterDiscovery.js";
import { materializeRasterSegments } from "../../domain/rasterLogicalSegments.js";
import { inspectStructuredRasterCandidatesInputSchema } from "../../domain/native/structuredRasterCandidates.js";
import { planExport, reference } from "./StructuredRasterExportPlan.js";
import type { StructuredRasterExportInput } from "../../domain/native/structuredRasterExport.js";
const fixture = () => {
  const count = 140,
    table = Buffer.alloc(count * 12),
    payload = Buffer.alloc(count * 64, 0x69);
  for (let i = 0; i < count; i++) {
    table[i * 12] = 5;
    table.writeUInt16LE(8, i * 12 + 2);
    table.writeUInt16LE(8, i * 12 + 4);
    table.writeUInt32LE(i * 16, i * 12 + 8);
  }
  const bytes = Buffer.concat([table, payload]);
  const logical = materializeRasterSegments(bytes, [
    { logicalOffset: 1000, fileOffset: 0, length: bytes.length },
  ]);
  return {
    logical,
    report: discoverStructuredRasters(bytes),
    family: undefined,
  };
};
const input = (
  extra: Partial<StructuredRasterExportInput> = {},
): StructuredRasterExportInput => ({
  ...inspectStructuredRasterCandidatesInputSchema.parse({ path: "/source" }),
  expected_sha256: "0".repeat(64),
  output_directory: "/new",
  ambiguity: "skip",
  formats: ["raw", "png"],
  color_policy: { kind: "diagnostic-indices" },
  ...extra,
});
it("plans all140 retained resources rather than inspection page128 and keeps all alternatives distinct", () => {
  const prepared = fixture();
  const skipped = planExport(prepared, input());
  expect(skipped).toHaveLength(140);
  expect(skipped.every((p) => p.outcome.status === "skipped")).toBe(true);
  expect(skipped[0]!.payload).toBeUndefined();
  expect(skipped[0]!.outcome).toMatchObject({
    files: {},
    alternatives: prepared.report.tables[0]!.resources[0]!.hypotheses.map(
      (h) => ({
        hypothesis: {
          bits_per_pixel: h.bitsPerPixel,
          offset_unit: h.offsetUnit,
        },
        payload: reference(prepared, h.payloadRange),
        provenance: "inferred",
        evidence: {
          matches: h.matches,
          consistency: h.consistency,
          stride: h.stride,
          covered: h.covered,
        },
      }),
    ),
  });
  const all = planExport(prepared, input({ ambiguity: "all" }));
  expect(all).toHaveLength(420);
  expect(new Set(all.map((p) => p.outcome.files)).size).toBe(420);
  expect(all.every((p) => p.payload !== undefined)).toBe(true);
});
it("requires exact admitted descriptor/hypothesis identities", () => {
  const prepared = fixture();
  expect(() =>
    planExport(prepared, input({ selections: [{ descriptor_offset: 999 }] })),
  ).toThrow();
  const h = prepared.report.tables[0]!.resources[0]!.hypotheses[0]!;
  const selected = planExport(
    prepared,
    input({
      selections: [
        {
          descriptor_offset: 1000,
          hypothesis: {
            bits_per_pixel: h.bitsPerPixel as 1 | 2 | 4 | 8 | 16 | 24 | 32,
            offset_unit: h.offsetUnit as 1 | 2 | 4,
          },
        },
      ],
    }),
  );
  expect(selected).toHaveLength(1);
  expect(() =>
    planExport(
      prepared,
      input({
        selections: [{ descriptor_offset: 1000 }, { descriptor_offset: 1000 }],
      }),
    ),
  ).toThrow();
});
it("retains every intersecting source segment beyond256 and marks holes", () => {
  const prepared = fixture();
  prepared.logical.segments = Array.from({ length: 600 }, (_, i) => ({
    logicalOffset: 1000 + i * 2,
    fileOffset: i * 4,
    length: 2,
  }));
  expect(reference(prepared, { offset: 1, length: 1198 })).toEqual({
    offset: 1001,
    length: 1198,
    first_segment: 0,
    segment_count: 600,
    complete: true,
  });
  prepared.logical.segments.splice(300, 1);
  expect(reference(prepared, { offset: 0, length: 1200 }).complete).toBe(false);
});
it("does not silently substitute generic interpretation when requested family facts are unavailable", () => {
  expect(() =>
    planExport(fixture(), input({ resource_family: "record12-lut-registry" })),
  ).toThrow();
});

it("keeps complete export references beyond the inspection span budget", () => {
  const prepared = fixture();
  prepared.logical.segments = Array.from({ length: 300 }, (_, i) => ({
    logicalOffset: 1000 + i,
    fileOffset: i,
    length: 1,
  }));
  expect(reference(prepared, { offset: 0, length: 300 })).toEqual({
    offset: 1000,
    length: 300,
    first_segment: 0,
    segment_count: 300,
    complete: true,
  });
});

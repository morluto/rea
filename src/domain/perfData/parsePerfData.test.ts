import { describe, expect, it } from "vitest";
import { perfDataSchema } from "./perfData.js";
import { parsePerfData } from "./parsePerfData.js";
import type { PerfData } from "./perfData.js";
import {
  PERF_ATTR_BYTES,
  PERF_HEADER_BYTES,
  PERF_HEADER_BYTES_WITHOUT_FEATURES,
  PERF_STRIDE,
  buildPerfRecording,
  perfEntry,
} from "../../../tests/fixtures/perfData.js";

const artifact = {
  path: "/artifacts/perf.data",
  sha256: "a".repeat(64),
  bytes: 0,
};

const parse = (bytes: Buffer, options = {}) =>
  parsePerfData(
    bytes,
    { ...artifact, bytes: bytes.length },
    {
      maxEvents: 100,
      ...options,
    },
  );

const parsed = (bytes: Buffer, options = {}): PerfData => {
  const result = parse(bytes, options);
  if (!result.ok) throw new Error("expected a parsed recording");
  return result.value;
};

describe("parsePerfData", () => {
  it("inventories the header and event attributes", () => {
    const archive = parsed(buildPerfRecording());
    expect(archive.format).toBe("perf-data");
    expect(archive.file_header.byte_order).toBe("little-endian");
    expect(archive.file_header.header_bytes).toBe(PERF_HEADER_BYTES);
    expect(archive.file_header.attribute_bytes).toBe(PERF_STRIDE);
    expect(archive.file_header.feature_bitmap).toBe("present");
    expect(archive.events).toHaveLength(1);
    expect(archive.events[0]).toMatchObject({
      type: 0,
      config: 0,
      sample_period: 1000,
      sample_freq: false,
      attr_bytes: PERF_ATTR_BYTES,
      ids: [7],
    });
    expect(archive.summary).toEqual({
      events: 1,
      identifiers: 1,
      identifiers_present: true,
      diagnostics: 0,
    });
    expect(archive.diagnostics).toEqual([]);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });
});

describe("parsePerfData event attributes", () => {
  it("keeps each event's sampling settings rather than summarising them", () => {
    const archive = parsed(
      buildPerfRecording({
        entries: [
          perfEntry({ type: 0, config: 0, samplePeriod: 4000, ids: [11] }),
          perfEntry({
            type: 1,
            config: 1,
            samplePeriod: 99,
            freq: true,
            ids: [12],
          }),
        ],
      }),
    );
    expect(archive.events.map((event) => event.ordinal)).toEqual([0, 1]);
    expect(archive.events.map((event) => [event.type, event.config])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    // A frequency is not a period: the flag is what makes the unit explicit.
    expect(archive.events.map((event) => event.sample_period)).toEqual([
      4000, 99,
    ]);
    expect(archive.events.map((event) => event.sample_freq)).toEqual([
      false,
      true,
    ]);
    expect(archive.summary.identifiers).toBe(2);
  });

  it("reports every identifier of a multi-group event", () => {
    const archive = parsed(
      buildPerfRecording({ entries: [perfEntry({ ids: [21, 22, 23] })] }),
    );
    expect(archive.events[0]?.ids).toEqual([21, 22, 23]);
    expect(archive.summary.identifiers).toBe(3);
  });

  it("reads a big-endian recording and states the order", () => {
    const archive = parsed(buildPerfRecording({ little: false }));
    expect(archive.file_header.byte_order).toBe("big-endian");
    expect(archive.events[0]?.sample_period).toBe(1000);
    expect(archive.events[0]?.ids).toEqual([7]);
  });

  it("rejects a file without the magic instead of guessing", () => {
    const archive = parsed(Buffer.from("not a perf recording"));
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "not-a-perf-data-file" }),
    ]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("reports a header shorter than the fixed layout", () => {
    const archive = parsed(buildPerfRecording().subarray(0, 0x40));
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "truncated-header" }),
    ]);
  });

  it("accepts the pre-feature-bitmap header as absent rather than truncated", () => {
    const archive = parsed(
      buildPerfRecording({ headerBytes: PERF_HEADER_BYTES_WITHOUT_FEATURES }),
    );
    expect(archive.file_header.feature_bitmap).toBe("absent");
    expect(archive.events).toHaveLength(1);
    expect(archive.diagnostics).toEqual([]);
  });

  it("stops at the event allowance and says so", () => {
    const archive = parsed(
      buildPerfRecording({
        entries: [
          perfEntry({ ids: [1] }),
          perfEntry({ ids: [2] }),
          perfEntry({ ids: [3] }),
        ],
      }),
      { maxEvents: 2 },
    );
    expect(archive.events).toHaveLength(2);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "event-limit-reached" }),
    ]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("rejects an attribute section past the end of the file", () => {
    const bytes = buildPerfRecording();
    // `attrs.offset` is at 0x18; move it past the file without moving the data.
    bytes.writeBigUInt64LE(BigInt(bytes.length + 4096), 0x18);
    const archive = parsed(bytes);
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-attribute-section" }),
    ]);
  });

  it("reports ids that are not a whole number of in-file identifiers", () => {
    const bytes = buildPerfRecording();
    bytes.writeBigUInt64LE(7n, PERF_HEADER_BYTES + PERF_ATTR_BYTES + 8);
    const archive = parsed(bytes);
    expect(archive.events[0]?.ids).toEqual([]);
    expect(archive.summary.identifiers_present).toBe(false);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-ids-section", ordinal: 0 }),
    ]);
  });

  it("reports ids declared past the end of the file", () => {
    const bytes = buildPerfRecording();
    bytes.writeBigUInt64LE(
      BigInt(bytes.length + 8),
      PERF_HEADER_BYTES + PERF_ATTR_BYTES,
    );
    const archive = parsed(bytes);
    expect(archive.events[0]?.ids).toEqual([]);
    expect(archive.summary.identifiers_present).toBe(false);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-ids-section", ordinal: 0 }),
    ]);
  });

  it("rejects an attribute that declares less than a usable event", () => {
    const bytes = buildPerfRecording();
    bytes.writeUInt32LE(8, PERF_HEADER_BYTES + 0x04);
    const archive = parsed(bytes);
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "unsupported-attribute-size" }),
    ]);
  });

  it("conforms to the published schema", () => {
    expect(perfDataSchema.safeParse(parsed(buildPerfRecording())).success).toBe(
      true,
    );
  });
});

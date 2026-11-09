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
    // The third entry's ids were never read, so the retained count is a prefix
    // and the summary must not claim the recording's identifiers are present.
    expect(archive.summary.identifiers).toBe(2);
    expect(archive.summary.identifiers_present).toBe(false);
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

  it("marks the inventory incomplete when an ids section cannot be located", () => {
    const bytes = buildPerfRecording();
    // An offset above the safe-integer range is unreadable, not absent: the
    // group still owns identifiers this pass never saw.
    bytes.writeBigUInt64LE(
      0xffffffffffffffffn,
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

describe("parsePerfData section accounting", () => {
  it("reports a header overlap as the header's fault, not the data extent's", () => {
    const bytes = buildPerfRecording();
    // Point the attribute extent at bytes inside the file header while the data
    // extent stays disjoint: only the header rule is broken.
    bytes.writeBigUInt64LE(BigInt(PERF_HEADER_BYTES - 8), 0x18);
    const archive = parsed(bytes);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "header-attribute-overlap" }),
    ]);
    expect(archive.diagnostics.map(({ code }) => code)).not.toContain(
      "attribute-section-overlap",
    );
  });

  it("keeps an unrepresentable attribute stride unknown instead of zero", () => {
    const bytes = buildPerfRecording();
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 0x10);
    const archive = parsed(bytes);
    expect(archive.file_header.attribute_bytes).toBeNull();
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "unsafe-attribute-size" }),
    ]);
  });

  it("reports an explicitly empty attribute section as complete", () => {
    const bytes = buildPerfRecording({ entries: [] });
    const archive = parsed(bytes);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "empty-attribute-section" }),
    ]);
    // Nothing was left unexamined, so the informational diagnostic must not
    // present a fully read empty inventory as partial.
    expect(archive.summary.identifiers_present).toBe(true);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });

  it("treats a zero-length data extent as empty rather than overlapping", () => {
    const bytes = buildPerfRecording();
    // A zero-size data section that starts inside the attribute extent owns no
    // bytes, so it cannot conflict with the attributes that do.
    bytes.writeBigUInt64LE(BigInt(PERF_HEADER_BYTES), 0x28);
    bytes.writeBigUInt64LE(0n, 0x30);
    const archive = parsed(bytes);
    expect(archive.diagnostics.map(({ code }) => code)).not.toContain(
      "attribute-section-overlap",
    );
    expect(archive.events).toHaveLength(1);
    expect(archive.summary.identifiers_present).toBe(true);
  });

  it("reports an unrepresentable section extent as its own fact", () => {
    const bytes = buildPerfRecording();
    bytes.writeBigUInt64LE(0xffffffffffffffffn, 0x30);
    const archive = parsed(bytes);
    // The field was present and read; nothing is missing from the file, so this
    // must not be reported as a truncated header.
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "unsafe-section-extent" }),
    ]);
    expect(archive.diagnostics.map(({ code }) => code)).not.toContain(
      "truncated-header",
    );
  });

  it("marks the identifier inventory incomplete when its allowance truncates it", () => {
    const ids = Array.from({ length: 200_001 }, (_unused, index) => index + 1);
    const archive = parsed(
      buildPerfRecording({ entries: [perfEntry({ ids })] }),
    );
    expect(archive.events[0]?.ids_truncated).toBe(true);
    expect(archive.summary.identifiers_present).toBe(false);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "identifier-inventory-truncated" }),
    ]);
    expect(archive.source_coverage.status).not.toBe("complete-within-scope");
  });
});

describe("parsePerfData attribute widths", () => {
  it("reads the id descriptor at the end of the entry stride", () => {
    // Keep the normal stride and shrink only the declared `perf_event_attr.size`.
    // Shrinking `attrBytes` shrinks the stride with it, so the descriptor sits at
    // the same offset either way and the case cannot tell the two apart.
    const bytes = buildPerfRecording();
    bytes.writeUInt32LE(64, PERF_HEADER_BYTES + 0x04);
    const archive = parsed(bytes);
    expect(archive.file_header.attribute_bytes).toBe(PERF_STRIDE);
    expect(archive.events[0]?.attr_bytes).toBe(64);
    expect(archive.events[0]?.ids).toEqual([7]);
    expect(archive.diagnostics).toEqual([]);
  });

  it("preserves a 64-bit config and the low freq flag on a big-endian recording", () => {
    const bytes = buildPerfRecording({
      little: false,
      entries: [perfEntry({ config: 1, freq: true })],
    });
    const archive = parsed(bytes);
    expect(archive.events[0]).toMatchObject({
      config: 1,
      sample_freq: true,
    });
  });

  it("reads the freq bit where a big-endian writer puts it, not where the little-endian layout does", () => {
    // `freq` is a C bitfield. A big-endian host writes it at numeric bit 53
    // (0x0020000000000000) and `perf` reorders it with swap_bitfield on read;
    // masking the raw word with 0x400 finds nothing there. The fixture writes
    // the flag bytes verbatim, because its `freq` option encodes the
    // little-endian bit position the parser used to assume.
    const bytes = buildPerfRecording({ little: false });
    bytes.writeBigUInt64BE(0x0020000000000000n, PERF_HEADER_BYTES + 0x28);
    expect(parsed(bytes).events[0]?.sample_freq).toBe(true);
  });

  it("does not mistake the little-endian freq bit for one on a big-endian recording", () => {
    // The mirror image of the case above: a word that sets bit 10 in the
    // big-endian sense leaves the field clear.
    const bytes = buildPerfRecording({ little: false });
    bytes.writeBigUInt64BE(0x0000_0000_0000_0400n, PERF_HEADER_BYTES + 0x28);
    expect(parsed(bytes).events[0]?.sample_freq).toBe(false);
  });

  it("binds an event id to its recording, not only to the attribute offsets", () => {
    // Two recordings can hold the same ordinary attribute layout at the same
    // offsets while being different files, so offsets alone alias their facts.
    const one = buildPerfRecording();
    const other = buildPerfRecording();
    const first = parsePerfData(
      one,
      { ...artifact, sha256: "a".repeat(64), bytes: one.length },
      { maxEvents: 100 },
    );
    const second = parsePerfData(
      other,
      { ...artifact, sha256: "b".repeat(64), bytes: other.length },
      { maxEvents: 100 },
    );
    if (!first.ok || !second.ok) throw new Error("expected parsed recordings");
    expect(first.value.events[0]?.file_offset).toBe(
      second.value.events[0]?.file_offset,
    );
    expect(first.value.events[0]?.event_id).not.toBe(
      second.value.events[0]?.event_id,
    );
  });

  it("binds a diagnostic id to its recording as well", () => {
    const truncated = (sha256: string) => {
      const bytes = buildPerfRecording().subarray(0, 16);
      const result = parsePerfData(
        bytes,
        { ...artifact, sha256, bytes: bytes.length },
        { maxEvents: 100 },
      );
      if (!result.ok) throw new Error("expected a parsed recording");
      return result.value.diagnostics[0]?.diagnostic_id;
    };
    expect(truncated("a".repeat(64))).toBeTruthy();
    expect(truncated("a".repeat(64))).not.toBe(truncated("b".repeat(64)));
  });

  it("binds a diagnostic id to the allowance it was produced under", () => {
    const idAt = (maxEvents: number) => {
      const archive = parsed(
        buildPerfRecording({
          entries: [
            perfEntry({ ids: [1] }),
            perfEntry({ ids: [2] }),
            perfEntry({ ids: [3] }),
          ],
        }),
        { maxEvents },
      );
      // Both runs must actually reach the limit, or the ids below would be two
      // `undefined`s and compare equal no matter what the id contains.
      expect(archive.diagnostics.map((entry) => entry.code)).toEqual([
        "event-limit-reached",
      ]);
      return archive.diagnostics[0]?.diagnostic_id;
    };
    expect(idAt(1)).toBeTruthy();
    // Both runs report the same code at index 0, so the allowance is what
    // keeps the two query-specific facts from sharing an id.
    expect(idAt(1)).not.toBe(idAt(2));
  });

  it("reports an identifier above the safe integer range instead of dropping it silently", () => {
    const bytes = buildPerfRecording({
      entries: [perfEntry({ ids: [1] })],
    });
    // The one id array follows the single attribute entry.
    bytes.writeBigUInt64LE(
      BigInt("18446744073709551615"),
      PERF_HEADER_BYTES + PERF_STRIDE,
    );
    const archive = parsed(bytes);
    expect(archive.events[0]?.ids).toEqual([]);
    expect(archive.summary.identifiers_present).toBe(false);
    expect(archive.source_coverage.status).toBe("partial");
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "unsafe-identifier", ordinal: 0 }),
    ]);
  });

  it("reports an unrepresentable 64-bit config as unknown rather than truncated", () => {
    const bytes = buildPerfRecording();
    bytes.writeBigUInt64LE(
      BigInt("18446744073709551615"),
      PERF_HEADER_BYTES + 0x08,
    );
    expect(parsed(bytes).events[0]?.config).toBe(null);
  });
});

describe("parsePerfData identifier completeness", () => {
  it("does not report an empty, truncated entry as a complete inventory", () => {
    const bytes = buildPerfRecording({
      entries: [perfEntry(), perfEntry({ ids: [7, 8] })],
    });
    // Shrink the attribute section so the second entry cannot fit: its ids are
    // never examined, and the retained list is only a prefix.
    const firstStride = PERF_STRIDE;
    bytes.writeBigUInt64LE(BigInt(firstStride + 8), 0x20);
    const archive = parsed(bytes);
    expect(archive.events).toHaveLength(1);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "truncated-event-attribute" }),
    ]);
    expect(archive.summary.identifiers_present).toBe(false);
  });

  it("does not report a rejected attribute section as a complete inventory", () => {
    const bytes = buildPerfRecording();
    // Point the attribute section past the end of the file: no entry is
    // examined, so the identifier inventory cannot be called complete.
    bytes.writeBigUInt64LE(0xffffn, 0x18);
    const archive = parsed(bytes);
    expect(archive.events).toEqual([]);
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "invalid-attribute-section" }),
    ]);
    expect(archive.summary.identifiers_present).toBe(false);
  });
});

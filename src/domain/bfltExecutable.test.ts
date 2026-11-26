import { expect, it } from "vitest";

import { bfltFile } from "./bfltExecutable.fixture.js";
import {
  BFLT_LISTED_RELOCATIONS,
  BFLT_MAX_FILE_BYTES,
  BFLT_MAX_INFLATED_BYTES,
  hasBfltMagic,
  parseBflt,
} from "./bfltExecutable.js";

const TEXT = Buffer.from("0123456789abcdef");
const DATA = Buffer.from("datadata");

const parsed = (
  bytes: Uint8Array,
  maxExpanded?: number,
  maxInflated?: number,
) => {
  const result = parseBflt(bytes, maxExpanded, maxInflated);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const segmentSummary = (bytes: Uint8Array, maxInflated?: number) =>
  parsed(bytes, maxInflated).segments.map((segment) => [
    segment.path,
    segment.fileOffset,
    segment.metadata.image_offset,
    Buffer.from(segment.bytes).toString("latin1"),
  ]);

it("reports rev 4 header facts and segment boundaries", () => {
  const image = parsed(
    bfltFile({
      text: TEXT,
      data: DATA,
      // Offsets from the byte after the header: start of code, start of data.
      relocations: [0, 0x10],
      flags: 0x03,
      entry: 0x44,
      buildDate: 1_700_000_000,
    }),
  );
  expect(image.complete).toBe(true);
  expect(image.limitations).toEqual([]);
  expect(image.metadata).toMatchObject({
    kind: "bflt",
    revision: 4,
    entry: 0x44,
    data_start: 80,
    data_end: 88,
    bss_end: 104,
    reloc_start: 88,
    reloc_count: 2,
    flag_names: ["ram", "gotpic"],
    unknown_flags: 0,
    build_date_iso: "2023-11-14T22:13:20.000Z",
    compression: "none",
    text_size: 80,
    data_size: 8,
    bss_size: 16,
    relocations: [0, 0x10],
    relocations_truncated: false,
    out_of_range_relocation_count: 0,
  });
  expect(
    image.segments.map((s) => [s.path, s.fileOffset, s.bytes.length]),
  ).toEqual([
    ["text.bin", 0, 80],
    ["data.bin", 80, 8],
    ["relocations.bin", 88, 8],
  ]);
});

it("inflates a GZIP body and serves segments by image offset only", () => {
  const summary = segmentSummary(
    bfltFile({ text: TEXT, data: DATA, relocations: [0x10], flags: 0x05 }),
  );
  expect(summary.slice(1)).toEqual([
    ["data.bin", null, 80, "datadata"],
    ["relocations.bin", null, 88, "\u0000\u0000\u0000\u0010"],
  ]);
  expect(summary[0]?.slice(0, 3)).toEqual(["text.bin", null, 0]);
});

it("keeps GZDATA text at its file offset and inflates data", () => {
  const image = parsed(bfltFile({ text: TEXT, data: DATA, flags: 0x09 }));
  expect(image.metadata).toMatchObject({
    compression: "gzdata",
    inflated_bytes: 8,
  });
  expect(image.segments.map((s) => [s.path, s.fileOffset])).toEqual([
    ["text.bin", 0],
    ["data.bin", null],
  ]);
});

it("reports an over-budget gzip body as a limitation with the stored bytes", () => {
  const bytes = bfltFile({ text: TEXT, data: DATA, flags: 0x05 });
  const image = parsed(bytes, 16);
  expect(image.complete).toBe(false);
  expect(image.metadata.inflated_bytes).toBeNull();
  expect(image.limitations).toContainEqual(
    expect.stringContaining("16-byte artifact_limits.expanded_bytes budget"),
  );
  expect(
    image.segments.map((s) => [s.path, s.fileOffset, s.bytes.length]),
  ).toEqual([["compressed-body.gz", 64, bytes.length - 64]]);
});

it("caps in-memory inflation below a larger expanded_bytes allowance and preserves the compressed fallback", () => {
  expect(BFLT_MAX_INFLATED_BYTES).toBe(BFLT_MAX_FILE_BYTES);
  const gzipBytes = bfltFile({ text: TEXT, data: DATA, flags: 0x05 });
  // Default expanded_bytes (>= 256 MiB) and an explicit larger budget both stop
  // at the fixed in-memory ceiling rather than allocating up to expanded_bytes.
  for (const expanded of [undefined, 1024 * 1024]) {
    const image = parsed(gzipBytes, expanded, 16);
    expect(image.complete).toBe(false);
    expect(image.metadata.inflated_bytes).toBeNull();
    expect(image.limitations).toContainEqual(
      expect.stringContaining("fixed 16-byte in-memory inflation ceiling"),
    );
    expect(image.limitations.join("\n")).not.toContain(
      "Raise artifact_limits.expanded_bytes",
    );
    expect(
      image.segments.map((s) => [s.path, s.fileOffset, s.bytes.length]),
    ).toEqual([["compressed-body.gz", 64, gzipBytes.length - 64]]);
  }

  // gzdata keeps text.bin alongside compressed-body.gz when inflation hits the ceiling.
  const gzdataBytes = bfltFile({ text: TEXT, data: DATA, flags: 0x09 });
  const gzdataImage = parsed(gzdataBytes, undefined, 4);
  expect(gzdataImage.complete).toBe(false);
  expect(gzdataImage.metadata.inflated_bytes).toBeNull();
  expect(
    gzdataImage.segments.map((s) => [s.path, s.fileOffset, s.bytes.length]),
  ).toEqual([
    ["text.bin", 0, 80],
    ["compressed-body.gz", 80, gzdataBytes.length - 80],
  ]);
});

it("does not inflate or expose compressed-body.gz when gzdata starts inside the header", () => {
  const bytes = bfltFile({ text: TEXT, data: DATA, flags: 0x09 });
  bytes.writeUInt32BE(16, 12); // data_start inside the 64-byte header
  const image = parsed(bytes);
  expect(image.complete).toBe(false);
  expect(image.metadata.inflated_bytes).toBeNull();
  expect(image.limitations).toContainEqual(
    expect.stringContaining("inside the 64-byte header"),
  );
  expect(image.segments).toEqual([]);
});

it("accepts rev 2 with its stored-entry caveat", () => {
  const image = parsed(bfltFile({ revision: 2, relocations: [0x40] }));
  expect(image.metadata.revision).toBe(2);
  expect(image.limitations).toEqual([
    expect.stringContaining("Revision 2 loaders"),
  ]);
});

it("reads a rev 2 body as stored even when gzip flag bits are set", () => {
  const bytes = bfltFile({ text: TEXT, data: DATA, revision: 2, flags: 0x01 });
  bytes.writeUInt32BE(0x0d, 36); // ram, gzip and gzdata bits, as stored
  const image = parsed(bytes);
  expect(image.complete).toBe(true);
  expect(image.metadata).toMatchObject({
    flag_names: ["ram", "gzip", "gzdata"],
    compression: "none",
    inflated_bytes: null,
  });
  expect(image.segments.map((s) => [s.path, s.fileOffset])).toEqual([
    ["text.bin", 0],
    ["data.bin", 80],
  ]);
});

it("reports build_date only where the revision 4 header defines it", () => {
  const fields = (revision: number) =>
    parsed(bfltFile({ revision, buildDate: 1_700_000_000 })).metadata;
  expect(fields(2)).toMatchObject({ build_date: null, build_date_iso: null });
  expect(fields(4)).toMatchObject({
    build_date: 1_700_000_000,
    build_date_iso: "2023-11-14T22:13:20.000Z",
  });
});

it("lists rev 2 relocation words as stored without range-checking them", () => {
  // Type bits 01 (DATA) above a small offset: a raw word the revision 4
  // bss bound would reject. Revision 2 leaves it unchecked.
  const image = parsed(
    bfltFile({ revision: 2, relocations: [0x4000_0004, 0x8000_0000] }),
  );
  expect(image.metadata).toMatchObject({
    relocations: [0x4000_0004, 0x8000_0000],
    out_of_range_relocation_count: null,
  });
  expect(image.limitations.join("\n")).not.toMatch(/end of bss/u);
  expect(image.segments.at(-1)?.path).toBe("relocations.bin");
});

it("refuses a short or unmarked header", () => {
  expect(parseBflt(new Uint8Array(10)).ok).toBe(false);
  expect(parseBflt(new Uint8Array(64)).ok).toBe(false);
  expect(hasBfltMagic(Buffer.from("bFLT"))).toBe(true);
});

it("surfaces unknown revisions, unknown flags and out-of-range offsets", () => {
  const image = parsed(
    bfltFile({
      revision: 7,
      flags: 0x8001,
      entry: 0x1000,
      relocations: [0x9999],
    }),
  );
  expect(image.metadata.unknown_flags).toBe(0x8000);
  expect(image.metadata.out_of_range_relocation_count).toBe(1);
  expect(image.limitations.join("\n")).toMatch(
    /Revision 7[\s\S]*0x8000[\s\S]*entry point 0x1000[\s\S]*1 of 1 relocation/u,
  );
});

it("measures revision 4 relocations from the byte after the header through the end of bss", () => {
  // text 16, data 8, bss 128: data_end is 88 and bss_end is 216, so the
  // loader bound is 216 - 64 = 152. 100 is inside bss. 152 is start_brk.
  const inBss = parsed(
    bfltFile({
      text: TEXT,
      data: DATA,
      bssBytes: 128,
      relocations: [0, 0x10, 100, 152, 153],
    }),
  );
  expect(inBss.metadata).toMatchObject({
    data_end: 88,
    bss_end: 216,
    relocations: [0, 0x10, 100, 152, 153],
    out_of_range_relocation_count: 1,
  });
  expect(inBss.limitations).toEqual([
    "1 of 5 relocation entries point past the end of bss (offset 0x98 from the byte after the header).",
  ]);

  // On the smaller image the bss ends at loader offset 40. 0x40 is the file
  // offset of the first text byte, which is past that end.
  const fileOffset = parsed(
    bfltFile({ text: TEXT, data: DATA, relocations: [0x40] }),
  );
  expect(fileOffset.metadata.out_of_range_relocation_count).toBe(1);
  expect(fileOffset.limitations).toEqual([
    "1 of 1 relocation entries point past the end of bss (offset 0x28 from the byte after the header).",
  ]);
});

it("lists relocations past the inline budget as truncated and counts them all", () => {
  const relocations = Array.from(
    { length: BFLT_LISTED_RELOCATIONS + 5 },
    (_, index) => index * 4,
  );
  const image = parsed(bfltFile({ text: Buffer.alloc(400), relocations }));
  expect(image.metadata.relocations).toHaveLength(BFLT_LISTED_RELOCATIONS);
  expect(image.metadata.relocations_truncated).toBe(true);
  expect(image.metadata.reloc_count).toBe(relocations.length);
  expect(image.segments.at(-1)?.bytes.length).toBe(relocations.length * 4);
});

it("does not list a relocation table that runs past the file", () => {
  const image = parsed(bfltFile({ relocations: [0], relocCount: 1000 }));
  expect(image.complete).toBe(false);
  expect(image.metadata).toMatchObject({
    relocations: [],
    relocations_truncated: false,
    out_of_range_relocation_count: null,
  });
  expect(image.segments.map((s) => s.path)).toEqual(["text.bin", "data.bin"]);
});

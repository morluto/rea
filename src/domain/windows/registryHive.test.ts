import { describe, expect, it } from "vitest";

import {
  createRegfDecoder,
  DEFAULT_REGF_MAX_FILE_BYTES,
  MAXIMUM_REGF_MAX_FILE_BYTES,
  MINIMUM_REGF_MAX_FILE_BYTES,
  parseRegfHive,
  REGF_BASE_BLOCK_BYTES,
  REGF_HIVE_FILE_LIMIT_CODE,
  REGF_HIVE_MAX_FILE_SETTING_ID,
  regfHiveFileLimit,
} from "./registryHive.js";

const checksumOf = (base: Uint8Array): number => {
  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  let xor = 0;
  for (let offset = 0; offset < 508; offset += 4)
    xor ^= view.getUint32(offset, true);
  return xor >>> 0;
};

/** One `hbin` of `size` bytes whose cells are the given signed sizes. */
const hbinOf = (
  binOffset: number,
  size: number,
  cellSizes: number[],
): Uint8Array => {
  const bin = new Uint8Array(size);
  bin.set(Buffer.from("hbin", "latin1"), 0);
  const view = new DataView(bin.buffer);
  view.setUint32(4, binOffset, true);
  view.setUint32(8, size, true);
  let offset = 32;
  for (const cellSize of cellSizes) {
    if (offset + 8 > size) break;
    view.setInt32(offset, cellSize, true);
    offset += Math.abs(cellSize);
  }
  return bin;
};

interface HiveOptions {
  readonly primary: number;
  readonly secondary: number;
  readonly bins: readonly Uint8Array[];
  readonly hiveBinsDataSize?: number;
  readonly checksum?: number;
}

const hiveOf = (options: HiveOptions): Uint8Array => {
  const binsSize = options.bins.reduce((total, bin) => total + bin.length, 0);
  const file = new Uint8Array(REGF_BASE_BLOCK_BYTES + binsSize);
  const base = file.subarray(0, 512);
  base.set(Buffer.from("regf", "latin1"), 0);
  const view = new DataView(base.buffer, base.byteOffset, base.byteLength);
  view.setUint32(4, options.primary, true);
  view.setUint32(8, options.secondary, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 5, true);
  view.setUint32(36, 0x20, true);
  view.setUint32(40, options.hiveBinsDataSize ?? binsSize, true);
  view.setUint32(508, options.checksum ?? checksumOf(base), true);
  let offset = REGF_BASE_BLOCK_BYTES;
  for (const bin of options.bins) {
    file.set(bin, offset);
    offset += bin.length;
  }
  return file;
};

describe("parseRegfHive", () => {
  it("reports a clean hive's base block, bins and cells", () => {
    const hive = hiveOf({
      primary: 7,
      secondary: 7,
      bins: [hbinOf(0, 4096, [-32, 48, -24])],
    });
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata).toMatchObject({
      kind: "regf-hive",
      major_version: 1,
      minor_version: 5,
      primary_sequence: 7,
      secondary_sequence: 7,
      dirty: false,
      checksum_matches: true,
      hive_bin_count: 1,
      cell_count: 3,
      allocated_cell_count: 2,
    });
    expect(parsed.value.bins).toHaveLength(1);
    expect(parsed.value.cells.map((cell) => cell.storedSize)).toEqual([
      -32, 48, -24,
    ]);
    expect(parsed.value.cells.map((cell) => cell.payloadBytes)).toEqual([
      28, 44, 20,
    ]);
    expect(parsed.value.limitations).toEqual([]);
  });

  it("reports a mismatched sequence pair as dirty without failing", () => {
    const hive = hiveOf({
      primary: 9,
      secondary: 8,
      bins: [hbinOf(0, 4096, [-32])],
    });
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata.dirty).toBe(true);
    expect(parsed.value.limitations.join(" ")).toContain("not cleanly closed");
  });

  it("reports a checksum mismatch as a limitation, not a refusal", () => {
    const hive = hiveOf({
      primary: 1,
      secondary: 1,
      bins: [hbinOf(0, 4096, [-32])],
      checksum: 0x1234_5678,
    });
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.metadata.checksum_matches).toBe(false);
    expect(parsed.value.limitations.join(" ")).toContain(
      "does not match the computed",
    );
  });

  it("refuses a file that does not begin with regf", () => {
    const hive = hiveOf({
      primary: 1,
      secondary: 1,
      bins: [hbinOf(0, 4096, [-32])],
    });
    hive.set(Buffer.from("nope", "latin1"), 0);
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe("format");
    expect(parsed.error.message).toContain("regf signature");
  });

  it("refuses a file shorter than the base block", () => {
    const parsed = parseRegfHive(new Uint8Array(64));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe("format");
  });

  it("stops at a cell that crosses its hive bin", () => {
    const hive = hiveOf({
      primary: 1,
      secondary: 1,
      bins: [hbinOf(0, 4096, [-32, 4096])],
    });
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cells.map((cell) => cell.storedSize)).toEqual([-32]);
    expect(parsed.value.limitations.join(" ")).toContain(
      "crossing the hive bin",
    );
  });

  it("stops at a cell size that is not a multiple of eight", () => {
    const hive = hiveOf({
      primary: 1,
      secondary: 1,
      bins: [hbinOf(0, 4096, [-32, -13])],
    });
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.limitations.join(" ")).toContain(
      "not a positive multiple",
    );
  });

  it("stops at a hive bin whose span does not fit the file", () => {
    const hive = hiveOf({
      primary: 1,
      secondary: 1,
      bins: [hbinOf(0, 4096, [-32])],
      hiveBinsDataSize: 8192,
    });
    const parsed = parseRegfHive(hive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.limitations.join(" ")).toContain(
      "but the file holds only",
    );
  });
});

describe("createRegfDecoder", () => {
  it("refuses a file above the effective ceiling and names the setting", () => {
    const fileBytes = DEFAULT_REGF_MAX_FILE_BYTES + 1;
    const fileLimit = regfHiveFileLimit(fileBytes, {
      maximumBytes: DEFAULT_REGF_MAX_FILE_BYTES,
      source: "default",
    });
    const decoder = createRegfDecoder(fileBytes);
    expect(decoder.ok).toBe(false);
    if (decoder.ok) return;
    expect(decoder.error).toMatchObject({
      kind: "limit",
      boundary: "file-size",
      fileAdmission: fileLimit,
    });
    expect(fileLimit).toEqual({
      code: REGF_HIVE_FILE_LIMIT_CODE,
      setting: REGF_HIVE_MAX_FILE_SETTING_ID,
      fileBytes,
      maximumBytes: DEFAULT_REGF_MAX_FILE_BYTES,
      source: "default",
      defaultBytes: DEFAULT_REGF_MAX_FILE_BYTES,
      floorBytes: MINIMUM_REGF_MAX_FILE_BYTES,
      maximumSettingBytes: MAXIMUM_REGF_MAX_FILE_BYTES,
      updateMode: "runtime",
      pendingRestart: false,
    });
  });

  it("uses a caller-selected ceiling instead of the default", () => {
    const admission = {
      maximumBytes: MINIMUM_REGF_MAX_FILE_BYTES,
      source: "setting" as const,
    };
    const refused = createRegfDecoder(
      MINIMUM_REGF_MAX_FILE_BYTES + 1,
      admission,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.fileAdmission).toMatchObject({
      code: REGF_HIVE_FILE_LIMIT_CODE,
      setting: REGF_HIVE_MAX_FILE_SETTING_ID,
      maximumBytes: MINIMUM_REGF_MAX_FILE_BYTES,
      source: "setting",
      updateMode: "runtime",
      pendingRestart: false,
    });
    expect(createRegfDecoder(MINIMUM_REGF_MAX_FILE_BYTES, admission).ok).toBe(
      true,
    );
  });

  it("parses the same hive when fed in uneven chunks", () => {
    const hive = hiveOf({
      primary: 3,
      secondary: 3,
      bins: [hbinOf(0, 4096, [-32, -48])],
    });
    const decoder = createRegfDecoder(hive.length);
    expect(decoder.ok).toBe(true);
    if (!decoder.ok) return;
    for (let offset = 0; offset < hive.length; offset += 1000) {
      const written = decoder.value.write(hive.subarray(offset, offset + 1000));
      expect(written.ok).toBe(true);
    }
    const image = decoder.value.finish();
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    expect(image.value.cells.map((cell) => cell.storedSize)).toEqual([
      -32, -48,
    ]);
  });
});

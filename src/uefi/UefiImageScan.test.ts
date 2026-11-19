import { Buffer } from "node:buffer";
import { expect, it } from "vitest";

import {
  buildFv,
  buildFfsFile,
  buildSection,
  buildGuidedSection,
  buildLzmaGuidedSection,
} from "../../tests/fixtures/uefiImage.js";
import { AMD_ZLIB_HEADER_LENGTH } from "./FfsSections.js";
import { scanUefiImage, type UefiLzmaDecoder } from "./UefiImageScan.js";

const noDecoder: UefiLzmaDecoder = async () => ({
  ok: false,
  message: "test decoder unavailable",
});

const decodeNestedFv = (
  nestedFv: Buffer,
): {
  readonly decoder: UefiLzmaDecoder;
  readonly requests: Array<{ format: string; offset: number; length: number }>;
} => {
  const marker = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const requests: Array<{ format: string; offset: number; length: number }> =
    [];
  const decoder: UefiLzmaDecoder = async (request) => {
    requests.push({
      format: request.format,
      offset: request.physicalRange?.offset ?? -1,
      length: request.physicalRange?.length ?? -1,
    });
    return request.payload.equals(marker)
      ? {
          ok: true,
          outcome: { bytes: nestedFv, decoderVersion: "stub-1.0" },
        }
      : { ok: false, message: "unexpected carrier bytes" };
  };
  return { decoder, requests };
};

const driverFile = (guid: string, payload: Buffer): Buffer =>
  buildFfsFile({ guid, typeCode: 0x07, payload });

it("maps one volume with UI string, PE payload, checksums and pad classification", async () => {
  const ui = buildSection(0x15, Buffer.from("BiosModule\0", "utf16le"));
  const pe = buildSection(0x10, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  const fileOne = driverFile(
    "21111111-2222-3333-4444-555555555555",
    Buffer.concat([ui, pe]),
  );
  const fileTwo = buildFfsFile({
    guid: "22111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: buildSection(0x19, Buffer.from("integrity")),
    alignmentExponent: 7,
    fileChecksum: "correct",
  });
  const pad = buildFfsFile({
    guid: "00000000-0000-0000-0000-000000000000",
    typeCode: 0xf0,
    payload: Buffer.alloc(0),
  });
  const fv = buildFv({ files: [fileOne, fileTwo, pad] });
  const summary = await scanUefiImage(
    fv.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );

  expect(summary.volumes).toHaveLength(1);
  const volume = summary.volumes[0];
  expect(volume?.offset).toBe(0);
  expect(volume?.depth).toBe(0);
  expect(volume?.parent_offset).toBeNull();
  expect(volume?.file_system_guid).toBe("8c8ce578-8a3d-4f1c-9935-896185c32dd3");
  expect(volume?.ffs_files).toHaveLength(3);
  const [mappedOne, mappedTwo, mappedPad] = volume?.ffs_files ?? [];
  expect(mappedOne?.type_name).toBe("driver");
  expect(mappedOne?.ui_string).toBe("BiosModule");
  expect(mappedOne?.checksum).toBe("unchecked");
  expect(mappedOne?.sections).toHaveLength(2);
  expect(mappedOne?.sections[0]?.type_name).toBe("user-interface");
  expect(mappedOne?.sections[1]?.type_name).toBe("pe32");
  expect(mappedTwo?.checksum).toBe("valid");
  expect(mappedPad?.type_name).toBe("pad");
  expect(mappedPad?.checksum).toBe("pad-file-unchecked");
  expect(summary.budgetExhausted).toBe(false);
  // Volume block padding (erased) stays classified, never hidden.
  const tail = summary.unknownRegions.at(-1)?.observation;
  expect(tail?.classification).toBe("erased-ff");
  expect(tail?.erasure).toBe("0xff");
});

it("recurses into firmware-volume-image sections with parent linkage", async () => {
  const nestedInner = buildFfsFile({
    guid: "24111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: buildSection(0x19, Buffer.from("inner")),
  });
  const nestedFv = buildFv({ files: [nestedInner] });
  const wrapper = driverFile(
    "23111111-2222-3333-4444-555555555555",
    buildSection(0x17, nestedFv.buffer),
  );
  const image = buildFv({ files: [wrapper] });
  const summary = await scanUefiImage(
    image.buffer,
    { maxDepth: 3, maxVolumes: 2, maxFiles: 64 },
    noDecoder,
  );

  expect(summary.volumes).toHaveLength(2);
  expect(summary.budgetExhausted).toBe(false);
  const top = summary.volumes[0];
  const nested = summary.volumes[1];
  expect(nested?.depth).toBe(1);
  expect(nested?.parent_offset).toBe(top?.offset ?? -1);
  expect(nested?.logical_path.startsWith(`${top?.logical_path}/FFS:`)).toBe(
    true,
  );
  expect(top?.ffs_files[0]?.sections[0]?.sub_volumes).toEqual([
    nested?.logical_path,
  ]);
});

it("reinterprets a raw file body that directly carries an embedded firmware volume", async () => {
  const holeInner = buildFfsFile({
    guid: "25111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: buildSection(0x19, Buffer.from("hole")),
  });
  const holeFv = buildFv({ files: [holeInner] });
  // The raw body carries a full FV without a surrounding section header.
  const hole = buildFfsFile({
    guid: "27111111-2222-3333-4444-555555555555",
    typeCode: 0x01,
    payload: holeFv.buffer,
  });
  const image = buildFv({ files: [hole] });
  const summary = await scanUefiImage(
    image.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );

  expect(summary.volumes).toHaveLength(2);
  const raw = summary.volumes[0]?.ffs_files[0];
  expect(raw?.type_name).toBe("raw");
  expect(raw?.sections).toHaveLength(0);
  const nested = summary.volumes[1];
  expect(nested?.depth).toBe(1);
  expect(nested?.parent_offset).toBe(summary.volumes[0]?.offset ?? -1);
  expect(nested?.logical_path.includes("/embedded/FV@")).toBe(true);
  expect(nested?.ffs_files).toHaveLength(1);
});

it("keeps an unframed raw body without a confirmed embedded volume untouched", async () => {
  const unframed = buildFfsFile({
    guid: "28111111-2222-3333-4444-555555555555",
    typeCode: 0x01,
    payload: Buffer.alloc(80, 0x00),
  });
  const image = buildFv({ files: [unframed] });
  const summary = await scanUefiImage(
    image.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );

  expect(summary.volumes).toHaveLength(1);
  const raw = summary.volumes[0]?.ffs_files[0];
  expect(raw?.sections).toHaveLength(0);
  expect(summary.truncationObserved).toBe(false);
});

it("decodes LZMA-guided sections through the injected decoder lane", async () => {
  const nestedInner = buildFfsFile({
    guid: "26111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: buildSection(0x19, Buffer.from("inner")),
  });
  const nestedFv = buildFv({ files: [nestedInner] });
  const ui = buildSection(0x15, Buffer.from("CompressedMain\0", "utf16le"));
  const { decoder, requests: decodeRequests } = decodeNestedFv(nestedFv.buffer);
  const compressedCarrier = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const wrapper = driverFile(
    "25111111-2222-3333-4444-555555555555",
    Buffer.concat([ui, buildLzmaGuidedSection(compressedCarrier)]),
  );
  const top = buildFv({ files: [wrapper] });
  const summary = await scanUefiImage(
    top.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    decoder,
  );

  expect(summary.volumes).toHaveLength(2);
  const nested = summary.volumes[1];
  expect(nested?.depth).toBe(1);
  expect(nested?.parent_offset).toBe(0);
  expect(nested?.logical_path).toContain("/lzma/FV@");
  const lzmaSection = summary.volumes[0]?.ffs_files[0]?.sections[1];
  expect(lzmaSection?.compression).toMatchObject({
    kind: "lzma-custom",
    data_offset: 24,
  });
  expect(lzmaSection?.sub_volumes).toEqual([summary.volumes[1]?.logical_path]);
  const request = decodeRequests[0];
  expect(request?.offset).toBeGreaterThan(0);
  expect(request?.length).toBe(compressedCarrier.length);
  expect(summary.limitations).toHaveLength(0);
});

it("decodes AMI-zlib guided sections after peeling the AMD header", async () => {
  const nestedInner = buildFfsFile({
    guid: "2b111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: buildSection(0x19, Buffer.from("inner")),
  });
  const nestedFv = buildFv({ files: [nestedInner] });
  const stream = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const amdHeader = Buffer.alloc(AMD_ZLIB_HEADER_LENGTH, 0);
  amdHeader.writeUInt32LE(stream.length, 0x14);
  const { decoder, requests: decodeRequests } = decodeNestedFv(nestedFv.buffer);
  const wrapper = driverFile(
    "2c111111-2222-3333-4444-555555555555",
    buildGuidedSection({
      definitionGuid: "ce3233f5-2cd6-4d87-9152-4a238bb6d1c4",
      body: Buffer.concat([amdHeader, stream]),
    }),
  );
  const top = buildFv({ files: [wrapper] });
  const summary = await scanUefiImage(
    top.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    decoder,
  );

  expect(summary.volumes).toHaveLength(2);
  const nested = summary.volumes[1];
  expect(nested?.depth).toBe(1);
  expect(nested?.parent_offset).toBe(0);
  expect(nested?.logical_path).toContain("/zlib/FV@");
  const zlibSection = summary.volumes[0]?.ffs_files[0]?.sections[0];
  expect(zlibSection?.compression).toMatchObject({
    kind: "ami-zlib",
    data_offset: 24,
  });
  expect(zlibSection?.sub_volumes).toEqual([summary.volumes[1]?.logical_path]);
  // The lane receives only the peeled zlib stream, not the 0x100 AMD header.
  expect(decodeRequests[0]?.format).toBe("zlib");
  expect(decodeRequests[0]?.length).toBe(stream.length);
  expect(summary.limitations).toHaveLength(0);
});

it("keeps walking when the decoder returns null and records the gap", async () => {
  const compressedCarrier = Buffer.from([0x1, 0x2, 0x3, 0x4]);
  const wrapper = driverFile(
    "27111111-2222-3333-4444-555555555555",
    buildLzmaGuidedSection(compressedCarrier),
  );
  const top = buildFv({ files: [wrapper] });
  const summary = await scanUefiImage(
    top.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );
  expect(summary.volumes).toHaveLength(1);
  expect(
    summary.limitations.some((line) => line.includes("lzma decode failed")),
  ).toBe(true);
});

it("reports a too-small declared length and an overflowing file as integrity records", async () => {
  const undersized = buildFfsFile({
    guid: "28111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.alloc(0),
  });
  undersized[20] = 4;
  const oversized = buildFfsFile({
    guid: "29111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.from("more data"),
  });
  oversized[20] = 0xff;
  oversized[21] = 0xff;
  oversized[22] = 0x00; // declared length 0x00ffff exceeds the volume area
  const fv = buildFv({ files: [undersized, oversized] });
  const summary = await scanUefiImage(
    fv.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );
  const kinds = summary.integrity.map((record) => record.kind);
  expect(kinds.filter((kind) => kind === "size-truncation")).toHaveLength(2);
  expect(summary.volumes[0]?.ffs_files).toHaveLength(2); // the oversized file stays observed
});

it("records a volume checksum mismatch without dropping the volume", async () => {
  const inner = buildFfsFile({
    guid: "2a111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: Buffer.from("z"),
  });
  const fv = buildFv({ files: [inner] });
  fv.buffer[55] = 5; // revision rides the corrupted checksum word
  const summary = await scanUefiImage(
    fv.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );
  expect(summary.volumes).toHaveLength(1);
  expect(
    summary.integrity.some((record) => record.kind === "fv-checksum-mismatch"),
  ).toBe(true);
});

it("maps a plausible PSP directory and candidates an implausible one", async () => {
  const plausible = Buffer.alloc(0x20 + 2 * 16, 0);
  plausible.write("$PSP", 0, "ascii");
  plausible.writeUInt32LE(0x1f2e3d4c, 4); // checksum
  plausible.writeUInt32LE(2, 8);
  plausible.writeUInt32LE(0x2000, 0x10 + 4);
  plausible.writeBigUInt64LE(0x4000000000001000n, 0x10 + 8);
  plausible.writeBigUInt64LE(0xb123000000000aabn, 0x20 + 8);
  const bogus = Buffer.alloc(32, 0);
  bogus.write("$PL2", 0, "ascii");
  bogus.writeUInt32LE(0x1ff, 8);
  const image = Buffer.concat([plausible, bogus, Buffer.alloc(0x800, 0xff)]);
  const summary = await scanUefiImage(
    image,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 64 },
    noDecoder,
  );
  expect(summary.pspTables).toHaveLength(1);
  const table = summary.pspTables[0];
  expect(table?.tableMagic).toBe("$PSP");
  expect(table?.totalEntries).toBe(2);
  expect(table?.entryStrideBasis).toBe("psp-16");
  expect(table?.entries[0]).toMatchObject({
    declaredLocation: 0x1000,
    declaredLocationRaw: "0x4000000000001000",
    addressMode: 1,
    declaredSize: 0x2000,
    locationBasis: "declared-unverified",
  });
  expect(table?.entries[1]).toMatchObject({
    declaredLocation: null,
    declaredLocationRaw: "0xb123000000000aab",
    addressMode: 2,
  });
  expect(
    summary.pspCandidates.some(
      (candidate) => candidate.reason === "implausible-entry-count",
    ),
  ).toBe(true);
});

it("marks the scan partial when the FFS file budget is hit", async () => {
  const fileOne = driverFile(
    "2b111111-2222-3333-4444-555555555555",
    Buffer.from("a"),
  );
  const fileTwo = driverFile(
    "2c111111-2222-3333-4444-555555555555",
    Buffer.from("b"),
  );
  const fv = buildFv({ files: [fileOne, fileTwo] });
  const summary = await scanUefiImage(
    fv.buffer,
    { maxDepth: 3, maxVolumes: 64, maxFiles: 1 },
    noDecoder,
  );
  expect(summary.budgetExhausted).toBe(true);
  expect(summary.volumes[0]?.ffs_files).toHaveLength(1);
});

it("classifies uncovered ranges around volumes and in an image without a volume", async () => {
  const fv = buildFv({ files: [] }).buffer;
  const prefix = Buffer.from("vendor metadata");
  const middle = Buffer.alloc(16, 0xff);
  const suffix = Buffer.from("vendor footer");
  const image = Buffer.concat([prefix, fv, middle, fv, suffix]);
  const limits = { maxDepth: 3, maxVolumes: 2, maxFiles: 8 };
  const { unknownRegions } = await scanUefiImage(image, limits, noDecoder);
  expect(
    unknownRegions.map(({ observation: { offset, length } }) => [
      offset,
      length,
    ]),
  ).toEqual(
    expect.arrayContaining([
      [0, prefix.length],
      [prefix.length + fv.length, middle.length],
      [image.length - suffix.length, suffix.length],
    ]),
  );
  expect(
    (await scanUefiImage(prefix, limits, noDecoder)).unknownRegions.map(
      ({ observation }) => observation,
    ),
  ).toMatchObject([
    { offset: 0, length: prefix.length, classification: "no-fv-magic" },
  ]);
});

it("marks partial when the structural budget ends inside a section chain", async () => {
  const frames = Buffer.alloc(400_000);
  for (let offset = 0; offset < frames.length; offset += 4) {
    frames.writeUInt32LE(0x19000004, offset);
  }
  const file = driverFile("22111111-2222-3333-4444-555555555555", frames);
  const scan = await scanUefiImage(
    buildFv({ files: [file] }).buffer,
    { maxDepth: 3, maxVolumes: 4, maxFiles: 4 },
    noDecoder,
  );
  expect(scan.budgetExhausted).toBe(true);
  expect(
    scan.limitations.some((line) => line.includes("Structural record limit")),
  ).toBe(true);
  expect(scan.volumes[0]?.ffs_files[0]?.sections.length).toBeLessThan(100_000);
});

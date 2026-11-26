import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  classifyUbiPeb,
  parseUbiImage,
  recognizeUbiImage,
  UBI_IMAGE_LIMITATIONS,
  UBI_LAYOUT_VOLUME_ID,
  UBI_MAX_CACHED_EC_HEADERS,
  UBI_MAX_PEB_BYTES,
  UBI_MAX_PEBS,
  UBI_STATIC_PAYLOAD_CRC_LIMIT,
  type UbiEcHeaderCacheStats,
  type UbiErasedBodyVerificationStats,
  type UbiImage,
  type UbiImageParseError,
} from "./ubiImage.js";
import {
  twoVolumeUbiImage,
  ubiImageWithEmbeddedPebHeaders,
  ubiImageWithStaticGeometryEvidence,
  ubiImage,
  ubiLayoutPebs,
  ubiLebData,
  ubiVolumeTable,
  ubiVolumeTableSlots,
  UBI_FIXTURE_KERNEL,
  type UbiFixturePeb,
  type UbiFixtureVolumeRecord,
} from "./ubiImage.fixture.js";
import type { Result } from "../result.js";

/** Parse an in-memory image through the shared domain parser. */
const parse = (bytes: Buffer): Promise<Result<UbiImage, UbiImageParseError>> =>
  parseUbiImage(bytes.length, (offset, length) =>
    bytes.subarray(offset, offset + length),
  );

const image = async (bytes: Buffer): Promise<UbiImage> => {
  const parsed = await parse(bytes);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

const reassemble = async (bytes: Buffer, name: string): Promise<Buffer> => {
  const volume = (await image(bytes)).volumes.find((row) => row.name === name)!;
  return Buffer.concat(
    volume.ranges.map((range) =>
      bytes.subarray(range.offset, range.offset + range.length),
    ),
  );
};

const RECORDS: readonly UbiFixtureVolumeRecord[] = [
  { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 4 },
];

it("decodes the volume table and per-volume facts of a two-volume image", async () => {
  const parsed = await image(twoVolumeUbiImage());
  expect(parsed.geometry).toMatchObject({
    pebSize: 2048,
    lebSize: 1920,
    pebCount: 9,
    vidHeaderOffset: 64,
    dataOffset: 128,
    imageSeq: 0x1234_5678,
    volumeTableSlots: 11,
  });
  expect(parsed).toMatchObject({
    mappedPebCount: 7,
    freePebCount: 1,
    erasedPebCount: 1,
    corruptPebCount: 0,
    layoutPebCount: 2,
    staleLebCopyCount: 1,
    interruptedCopyCount: 0,
    ignoredLebCount: 0,
    minEraseCounter: 1,
    maxEraseCounter: 9,
    volumeTable: { copiesFound: 2, copiesValid: 2, copiesAgree: true },
    limitations: [],
  });
  expect(parsed.volumes.map(({ ranges: _ranges, ...facts }) => facts)).toEqual([
    {
      id: 0,
      name: "kernel",
      nameBytesHex: null,
      path: "volumes/kernel",
      type: "static",
      reservedPebs: 2,
      alignment: 1,
      dataPad: 0,
      updateMarker: false,
      flags: 0,
      autoresize: false,
      usableLebSize: 1920,
      usedEbs: 2,
      mappedLebCount: 2,
      staleLebCopyCount: 0,
      missingLebCount: 0,
      firstMissingLeb: null,
      dataBytes: UBI_FIXTURE_KERNEL.length,
      extractRefusal: null,
      limitations: [],
    },
    {
      id: 1,
      name: "rootfs",
      nameBytesHex: null,
      path: "volumes/rootfs",
      type: "dynamic",
      reservedPebs: 4,
      alignment: 1,
      dataPad: 0,
      updateMarker: false,
      flags: 1,
      autoresize: true,
      usableLebSize: 1920,
      usedEbs: null,
      mappedLebCount: 2,
      staleLebCopyCount: 1,
      missingLebCount: 0,
      firstMissingLeb: null,
      dataBytes: 3840,
      extractRefusal: null,
      limitations: [],
    },
  ]);
});

it("keeps the highest sqnum copy of a LEB and truncates a static volume at data_size", async () => {
  const bytes = twoVolumeUbiImage();
  expect((await reassemble(bytes, "kernel")).equals(UBI_FIXTURE_KERNEL)).toBe(
    true,
  );
  const rootfs = await reassemble(bytes, "rootfs");
  expect(rootfs.subarray(0, 8).toString("latin1")).toBe("ROOTFS-0");
  expect(rootfs.subarray(1920, 1928).toString("latin1")).toBe("ROOTFS-1");
  expect(rootfs.includes("STALE")).toBe(false);
});

it("recognizes UBI# with a valid header and refuses a bad CRC or version", () => {
  const bytes = twoVolumeUbiImage();
  expect(recognizeUbiImage(bytes.subarray(0, 64), bytes.length)).toEqual({
    state: "recognized",
  });
  expect(recognizeUbiImage(Buffer.from("UBI"), 3)).toBeUndefined();
  const badCrc = Buffer.from(bytes.subarray(0, 64));
  badCrc.writeUInt32BE(0, 60);
  expect(recognizeUbiImage(badCrc, bytes.length)).toEqual({
    state: "refused",
    reason: expect.stringContaining("erase-counter header CRC mismatch"),
  });
  const badVersion = ubiImage([{ kind: "free" }, { kind: "free" }]);
  badVersion[4] = 2;
  // Recompute the CRC so only the version differs.
  badVersion.writeUInt32BE(~crc32(badVersion.subarray(0, 60)) >>> 0, 60);
  expect(recognizeUbiImage(badVersion, badVersion.length)).toEqual({
    state: "refused",
    reason: expect.stringContaining("version 2 is unsupported"),
  });
});

it("refuses a UBI# file too short to hold the erase-counter header", () => {
  const header = twoVolumeUbiImage().subarray(0, 64);
  for (const size of [4, 32, 63]) {
    const truncated = Buffer.from(header.subarray(0, size));
    expect(recognizeUbiImage(truncated, truncated.length)).toEqual({
      state: "refused",
      reason: expect.stringContaining(
        `erase-counter header is truncated: the file holds ${String(size)} of its 64 bytes`,
      ),
    });
  }
  // A short prefix read from a longer file still defers to the reader.
  expect(recognizeUbiImage(header.subarray(0, 8), 4096)).toEqual({
    state: "recognized",
  });
});

it("skips PEBs with a bad EC or VID header CRC and names the limitation", async () => {
  const records = RECORDS;
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: ubiLebData(0x30, "LEB0"),
      sqnum: 2n,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 1,
      data: ubiLebData(0x31, "BADVID"),
      sqnum: 3n,
      vidCrc: 0,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 1,
      data: ubiLebData(0x31, "BADEC"),
      sqnum: 4n,
      ecCrc: 0,
    },
  ]);
  const parsed = await image(bytes);
  expect(parsed.corruptPebCount).toBe(2);
  expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.corruptPebs);
  expect(parsed.volumes[0]).toMatchObject({
    mappedLebCount: 1,
    extractRefusal: "lost_lebs",
    dataBytes: null,
  });
});

describe("a volume whose only LEB sits in a corrupt PEB", () => {
  const lostImage = (
    type: "dynamic" | "static",
    corruption: { readonly vidCrc: number } | { readonly ecCrc: number },
  ) =>
    ubiImage([
      ...ubiLayoutPebs([{ id: 0, name: "kernel", type, reservedPebs: 2 }]),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x30, "KERNEL"),
        sqnum: 2n,
        ...(type === "static" ? { usedEbs: 1 } : {}),
        ...corruption,
      },
    ]);

  it.each([
    ["static", "VID", { vidCrc: 0 }],
    ["static", "EC", { ecCrc: 0 }],
    ["dynamic", "VID", { vidCrc: 0 }],
    ["dynamic", "EC", { ecCrc: 0 }],
  ] as const)(
    "refuses a %s volume behind a bad %s header CRC instead of serving it empty",
    async (type, _header, bad) => {
      const parsed = await image(lostImage(type, bad));
      expect(parsed.corruptPebCount).toBe(1);
      expect(parsed.volumes[0]).toMatchObject({
        name: "kernel",
        usedEbs: null,
        mappedLebCount: 0,
        extractRefusal: "lost_lebs",
        dataBytes: null,
        ranges: [],
        limitations: [UBI_IMAGE_LIMITATIONS.lostLebs],
      });
      expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.lostLebs);
    },
  );

  it("still reads an unmapped volume as empty without corrupt PEBs", async () => {
    const parsed = await image(
      ubiImage(
        ubiLayoutPebs([
          { id: 0, name: "kernel", type: "static", reservedPebs: 2 },
        ]),
      ),
    );
    expect(parsed.volumes[0]).toMatchObject({
      usedEbs: 0,
      extractRefusal: null,
      dataBytes: 0,
    });
  });
});

it("refuses a dynamic volume with a missing LEB instead of inventing bytes", async () => {
  const bytes = ubiImage([
    ...ubiLayoutPebs(RECORDS),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: ubiLebData(0x30),
      sqnum: 2n,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 2,
      data: ubiLebData(0x32),
      sqnum: 3n,
    },
  ]);
  const [volume] = (await image(bytes)).volumes;
  expect(volume).toMatchObject({
    extractRefusal: "missing_lebs",
    missingLebCount: 1,
    firstMissingLeb: 1,
    dataBytes: null,
    ranges: [],
    limitations: [UBI_IMAGE_LIMITATIONS.missingLebs],
  });
});

it("refuses a static volume whose LEBs disagree on used_ebs", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "kernel", type: "static", reservedPebs: 2 },
  ];
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: ubiLebData(0x30),
      sqnum: 2n,
      volType: "static",
      usedEbs: 2,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 1,
      data: Buffer.from("x"),
      sqnum: 3n,
      volType: "static",
      usedEbs: 1,
    },
  ]);
  expect((await image(bytes)).volumes[0]).toMatchObject({
    extractRefusal: "invalid_static_size",
    usedEbs: null,
  });
});

it("uses the first valid volume table copy and names a disagreement", async () => {
  const slots = ubiVolumeTableSlots();
  const first = ubiVolumeTable(RECORDS, slots);
  const second = ubiVolumeTable([{ ...RECORDS[0]!, name: "renamed" }], slots);
  const disagreeing = await image(
    ubiImage([
      ...ubiLayoutPebs(RECORDS, {}, [first, second]),
      { kind: "free" },
    ]),
  );
  expect(disagreeing.volumeTable).toMatchObject({
    copiesValid: 2,
    copiesAgree: false,
    sourceLnum: 0,
  });
  expect(disagreeing.volumes[0]?.name).toBe("rootfs");
  expect(disagreeing.limitations).toContain(
    UBI_IMAGE_LIMITATIONS.volumeTableDisagreement,
  );

  const corrupt = Buffer.from(first);
  corrupt[20] = 0x7a;
  const fallback = await image(
    ubiImage([
      ...ubiLayoutPebs(RECORDS, {}, [corrupt, second]),
      { kind: "free" },
    ]),
  );
  expect(fallback.volumeTable).toMatchObject({
    copiesFound: 2,
    copiesValid: 1,
    copiesAgree: null,
    sourceLnum: 1,
  });
  expect(fallback.volumes[0]?.name).toBe("renamed");
  expect(fallback.limitations).toContain(
    UBI_IMAGE_LIMITATIONS.volumeTableSingleCopy,
  );

  const none = await parse(
    ubiImage([
      ...ubiLayoutPebs(RECORDS, {}, [corrupt, corrupt]),
      { kind: "free" },
    ]),
  );
  expect(none).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("no valid volume table"),
    },
  });
});

it("refuses an inconsistent eraseblock size or header layout", async () => {
  const bytes = twoVolumeUbiImage();
  expect(await parse(bytes.subarray(0, bytes.length - 512))).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("is not a multiple of the 2048-byte"),
    },
  });
  expect(await parse(bytes.subarray(0, 2048))).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("no second erase-counter header"),
    },
  });
  const mixed = Buffer.concat([
    bytes.subarray(0, 4096),
    ubiImage([{ kind: "free" }], { imageSeq: 7 }),
  ]);
  expect(await parse(mixed)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining(
        "declares image_seq 7, which differs from image_seq 305419896",
      ),
    },
  });
});

it("treats a zero image sequence as unspecified, as Linux UBI attach does", async () => {
  const legacy = ubiImage([{ kind: "free" }], { imageSeq: 0 });
  const tail = (imageSeq: number) =>
    ubiImage(
      [{ kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x30), sqnum: 2n }],
      { imageSeq },
    );
  // PEB 0 and PEB 1 carry 0; the next nonzero sequence is the image's.
  const zeroFirst = (later: Buffer) =>
    Buffer.concat([
      ubiImage(ubiLayoutPebs(RECORDS), { imageSeq: 0 }),
      legacy,
      later,
    ]);
  const parsed = await image(zeroFirst(tail(0x1234_5678)));
  expect(parsed.geometry).toMatchObject({
    pebSize: 2048,
    imageSeq: 0x1234_5678,
  });
  expect(parsed.volumes[0]).toMatchObject({ dataBytes: 1920 });
  // A zero sequence after a nonzero one is accepted while sizing.
  expect(
    (
      await image(
        Buffer.concat([
          ubiImage(ubiLayoutPebs(RECORDS).slice(0, 1)),
          legacy,
          ubiImage(ubiLayoutPebs(RECORDS).slice(1)),
        ]),
      )
    ).geometry,
  ).toMatchObject({ pebSize: 2048, pebCount: 3, imageSeq: 0x1234_5678 });
  // Two different nonzero sequences still disagree after zeros.
  expect(
    await parse(Buffer.concat([zeroFirst(tail(5)), tail(6)])),
  ).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining(
        "eraseblock 4 declares image_seq 6, which differs from image_seq 5",
      ),
    },
  });
});

it("ignores LEBs of volumes without a volume table record", async () => {
  const bytes = ubiImage([
    ...ubiLayoutPebs(RECORDS),
    { kind: "leb", volId: 5, lnum: 0, data: ubiLebData(0x35), sqnum: 2n },
    { kind: "leb", volId: 0, lnum: 9, data: ubiLebData(0x39), sqnum: 3n },
  ]);
  const parsed = await image(bytes);
  expect(parsed.ignoredLebCount).toBe(2);
  expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.ignoredLebs);
  expect(parsed.volumes[0]).toMatchObject({ dataBytes: 0, mappedLebCount: 0 });
});

it("normalizes unsafe and duplicate volume names into distinct paths", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "../etc", type: "dynamic", reservedPebs: 1 },
    { id: 1, name: "a/b", type: "dynamic", reservedPebs: 1 },
    { id: 2, name: "a_b", type: "dynamic", reservedPebs: 1 },
  ];
  const parsed = await image(
    ubiImage([...ubiLayoutPebs(records), { kind: "free" }]),
  );
  expect(parsed.volumes.map((volume) => volume.path)).toEqual([
    "volumes/_etc",
    "volumes/a_b",
    "volumes/a_b-1",
  ]);
});

it("counts missing LEBs from mapped entries when a volume declares billions", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "huge", type: "static", reservedPebs: 0xffff_fff0 },
    { id: 1, name: "sparse", type: "dynamic", reservedPebs: 0xffff_fff0 },
  ];
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: ubiLebData(0x30),
      sqnum: 2n,
      volType: "static",
      usedEbs: 0xffff_fff0,
    },
    { kind: "leb", volId: 1, lnum: 0, data: ubiLebData(0x31), sqnum: 3n },
    {
      kind: "leb",
      volId: 1,
      lnum: 0xffff_ffe0,
      data: ubiLebData(0x32),
      sqnum: 4n,
    },
  ]);
  const [huge, sparse] = (await image(bytes)).volumes;
  expect(huge).toMatchObject({
    extractRefusal: "missing_lebs",
    missingLebCount: 0xffff_ffef,
    firstMissingLeb: 1,
  });
  expect(sparse).toMatchObject({
    extractRefusal: "missing_lebs",
    missingLebCount: 0xffff_ffdf,
    firstMissingLeb: 1,
  });
});

it("refuses a PEB size measured across a skipped eraseblock", async () => {
  // PEB 1 is erased, so the second header is at PEB 2 and an even image size
  // divides by the doubled size; the header at PEB 3 contradicts it.
  const bytes = ubiImage([
    ...ubiLayoutPebs(RECORDS).slice(0, 1),
    { kind: "erased" },
    ...ubiLayoutPebs(RECORDS).slice(1),
    { kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x30), sqnum: 2n },
  ]);
  expect(await parse(bytes)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      failure: { offset: 6144 },
      message: expect.stringContaining("eraseblock size is ambiguous"),
    },
  });
});

describe("interrupted wear-leveling copies", () => {
  const copied = (dataCrc?: number) =>
    ubiImage([
      ...ubiLayoutPebs(RECORDS),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x30, "ORIGINAL"),
        sqnum: 2n,
      },
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x31, "COPY"),
        sqnum: 3n,
        copyFlag: true,
        ...(dataCrc === undefined ? {} : { dataCrc }),
      },
    ]);

  it("keeps a newer copy whose data CRC verifies", async () => {
    const bytes = copied();
    expect(
      (await reassemble(bytes, "rootfs")).subarray(0, 4).toString("latin1"),
    ).toBe("COPY");
    expect(await image(bytes)).toMatchObject({
      interruptedCopyCount: 0,
      staleLebCopyCount: 1,
    });
  });

  it("falls back to the older copy when the newer copy's data CRC fails", async () => {
    const bytes = copied(0);
    expect(
      (await reassemble(bytes, "rootfs")).subarray(0, 8).toString("latin1"),
    ).toBe("ORIGINAL");
    const parsed = await image(bytes);
    expect(parsed.interruptedCopyCount).toBe(1);
    expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.interruptedCopy);
  });

  const bothCopies = (olderCrc?: number) =>
    ubiImage([
      ...ubiLayoutPebs(RECORDS),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x30, "OLDCOPY"),
        sqnum: 2n,
        copyFlag: true,
        ...(olderCrc === undefined ? {} : { dataCrc: olderCrc }),
      },
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x31, "NEWCOPY"),
        sqnum: 3n,
        copyFlag: true,
        dataCrc: 0,
      },
    ]);

  it("falls back to an older wear-leveling copy whose data CRC verifies", async () => {
    const bytes = bothCopies();
    expect(
      (await reassemble(bytes, "rootfs")).subarray(0, 7).toString("latin1"),
    ).toBe("OLDCOPY");
    expect((await image(bytes)).volumes[0]?.extractRefusal).toBeNull();
  });

  it("refuses the volume when both competing copies fail their data CRC", async () => {
    const parsed = await image(bothCopies(0));
    expect(parsed.interruptedCopyCount).toBe(1);
    expect(parsed.volumes[0]).toMatchObject({
      name: "rootfs",
      mappedLebCount: 1,
      staleLebCopyCount: 1,
      dataBytes: null,
      ranges: [],
      extractRefusal: "unverified_copy",
    });
    expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.unverifiedCopy);
  });
});

describe("unverified wear-leveling copies of the layout volume", () => {
  const unverifiedLayoutLeb = (
    lnum: 0 | 1,
    table: Uint8Array,
    firstSqnum: bigint,
  ): readonly UbiFixturePeb[] => [
    {
      kind: "leb",
      volId: UBI_LAYOUT_VOLUME_ID,
      lnum,
      data: table,
      sqnum: firstSqnum,
      volType: "dynamic",
      copyFlag: true,
      dataCrc: 0,
    },
    {
      kind: "leb",
      volId: UBI_LAYOUT_VOLUME_ID,
      lnum,
      data: table,
      sqnum: firstSqnum + 1n,
      volType: "dynamic",
      copyFlag: true,
      dataCrc: 0,
    },
  ];

  it("ignores an unverified layout LEB 0 and uses the sound layout LEB 1 table", async () => {
    const slots = ubiVolumeTableSlots();
    const staleTable = ubiVolumeTable(
      [{ id: 0, name: "stale", type: "dynamic", reservedPebs: 1 }],
      slots,
    );
    const soundTable = ubiVolumeTable(
      [{ id: 0, name: "current", type: "dynamic", reservedPebs: 4 }],
      slots,
    );
    const bytes = ubiImage([
      ...unverifiedLayoutLeb(0, staleTable, 1n),
      {
        kind: "leb",
        volId: UBI_LAYOUT_VOLUME_ID,
        lnum: 1,
        data: soundTable,
        sqnum: 3n,
        volType: "dynamic",
      },
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: ubiLebData(0x43, "CURRENT"),
        sqnum: 4n,
      },
    ]);
    const parsed = await image(bytes);
    expect(parsed.volumeTable).toMatchObject({
      copiesFound: 1,
      copiesValid: 1,
      copiesAgree: null,
      sourceLnum: 1,
    });
    expect(parsed.volumes).toMatchObject([
      {
        id: 0,
        name: "current",
        reservedPebs: 4,
        mappedLebCount: 1,
        dataBytes: 1920,
        extractRefusal: null,
      },
    ]);
    expect(parsed.interruptedCopyCount).toBe(1);
    expect(parsed.limitations).toContain(
      UBI_IMAGE_LIMITATIONS.volumeTableSingleCopy,
    );
    expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.interruptedCopy);
    expect(
      (await reassemble(bytes, "current")).subarray(0, 7).toString("latin1"),
    ).toBe("CURRENT");
  });

  it("refuses the image when both layout LEBs are unverified wear-leveling copies", async () => {
    const slots = ubiVolumeTableSlots();
    const table = ubiVolumeTable(RECORDS, slots);
    const bytes = ubiImage([
      ...unverifiedLayoutLeb(0, table, 1n),
      ...unverifiedLayoutLeb(1, table, 3n),
    ]);
    expect(await parse(bytes)).toMatchObject({
      ok: false,
      error: {
        kind: "malformed",
        message: expect.stringContaining("no valid volume table"),
      },
    });
  });
});

it("classifies a wear-leveling copy with data_size beyond leb_size - data_pad as corrupt", async () => {
  // leb_size 1920 with alignment 1000 gives data_pad 920 and usable LEB 1000.
  const records: UbiFixtureVolumeRecord[] = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic",
      reservedPebs: 1,
      alignment: 1000,
      dataPad: 920,
    },
  ];
  const original = ubiLebData(0x30, "ORIGINAL");
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: original,
      sqnum: 2n,
      dataPad: 920,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: ubiLebData(0x31, "OVERSIZE"),
      sqnum: 3n,
      dataPad: 920,
      dataSize: 1500,
      copyFlag: true,
    },
  ]);
  const parsed = await image(bytes);
  const oversizedPeb = classifyUbiPeb(
    bytes.subarray(
      3 * parsed.geometry.pebSize,
      3 * parsed.geometry.pebSize + parsed.geometry.headerReadBytes,
    ),
    3,
    parsed.geometry,
  );
  expect(oversizedPeb).toEqual({
    ok: true,
    value: {
      state: "corrupt",
      reason: expect.stringContaining(
        "data_size 1500 and data_pad 920, which do not fit a 1920-byte logical eraseblock",
      ),
      ec: { eraseCounter: 1n, imageSeq: parsed.geometry.imageSeq },
      vidMinPebSize: 128 + 920 + 1500,
    },
  });
  expect(parsed).toMatchObject({
    corruptPebCount: 1,
    mappedPebCount: 3,
    staleLebCopyCount: 0,
    interruptedCopyCount: 0,
  });
  expect(parsed.limitations).toContain(UBI_IMAGE_LIMITATIONS.corruptPebs);
  expect(parsed.volumes[0]).toMatchObject({
    name: "rootfs",
    usableLebSize: 1000,
    mappedLebCount: 1,
    staleLebCopyCount: 0,
    dataBytes: 1000,
    extractRefusal: null,
    ranges: [{ lnum: 0, peb: 2, offset: 2 * 2048 + 128, length: 1000 }],
  });
  expect(
    (await reassemble(bytes, "rootfs")).equals(original.subarray(0, 1000)),
  ).toBe(true);
});

it("refuses a static volume whose nonfinal LEB is short", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "kernel", type: "static", reservedPebs: 2 },
  ];
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: Buffer.from("short"),
      sqnum: 2n,
      volType: "static",
      usedEbs: 2,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 1,
      data: Buffer.from("last"),
      sqnum: 3n,
      volType: "static",
      usedEbs: 2,
    },
  ]);
  expect((await image(bytes)).volumes[0]).toMatchObject({
    extractRefusal: "invalid_static_size",
    dataBytes: null,
    ranges: [],
  });
});

it("refuses a volume whose VID type or data_pad differs from its record", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "typed", type: "dynamic", reservedPebs: 2 },
    // 1920 % 928 = 64, so the record itself is consistent.
    {
      id: 1,
      name: "padded",
      type: "dynamic",
      reservedPebs: 2,
      alignment: 928,
      dataPad: 64,
    },
  ];
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: Buffer.from("static payload"),
      sqnum: 2n,
      volType: "static",
      usedEbs: 1,
    },
    { kind: "leb", volId: 1, lnum: 0, data: ubiLebData(0x31), sqnum: 3n },
  ]);
  const volumes = (await image(bytes)).volumes;
  for (const volume of volumes)
    expect(volume).toMatchObject({
      extractRefusal: "vid_record_mismatch",
      dataBytes: null,
      ranges: [],
      limitations: [UBI_IMAGE_LIMITATIONS.vidRecordMismatch],
    });
});

it("keeps the stored bytes of a volume name that is not valid UTF-8", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    {
      id: 0,
      name: "",
      nameBytes: Buffer.from([0x61, 0xff]),
      type: "dynamic",
      reservedPebs: 1,
    },
    {
      id: 1,
      name: "",
      nameBytes: Buffer.from([0x61, 0xfe]),
      type: "dynamic",
      reservedPebs: 1,
    },
    { id: 2, name: "caf\u00e9", type: "dynamic", reservedPebs: 1 },
  ];
  const parsed = await image(
    ubiImage([...ubiLayoutPebs(records), { kind: "free" }]),
  );
  expect(
    parsed.volumes.map(({ name, nameBytesHex }) => ({ name, nameBytesHex })),
  ).toEqual([
    { name: "a\ufffd", nameBytesHex: "61ff" },
    { name: "a\ufffd", nameBytesHex: "61fe" },
    { name: "caf\u00e9", nameBytesHex: null },
  ]);
});

it("refuses an eraseblock size that also fits with erased eraseblocks between", async () => {
  // Written 32 KiB eraseblocks alternate with erased ones, so the second EC
  // header is 64 KiB away, the size divides the file, and no header lies off
  // the 64 KiB grid. The 128-slot volume table fits either LEB size.
  const geometry = { pebSize: 32 * 1024 };
  const [layout0, layout1] = ubiLayoutPebs(RECORDS, geometry);
  const rootfs = {
    kind: "leb" as const,
    volId: 0,
    lnum: 0,
    data: Buffer.from("ROOTFS"),
    sqnum: 2n,
  };
  const alternating = ubiImage(
    [
      layout0!,
      { kind: "erased" },
      layout1!,
      { kind: "erased" },
      rootfs,
      { kind: "erased" },
    ],
    geometry,
  );
  expect(await parse(alternating)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining(
        "also fits a 32768-byte eraseblock size",
      ),
    },
  });

  // Data written across the half-way point rules the smaller size out.
  const wide = { pebSize: 64 * 1024 };
  const full = ubiImage(
    [
      ...ubiLayoutPebs(RECORDS, wide),
      { ...rootfs, data: Buffer.alloc(64 * 1024 - 128, 0x52) },
    ],
    wide,
  );
  const parsedFull = await image(full);
  expect(parsedFull.geometry).toMatchObject({ pebSize: 65536, pebCount: 3 });
  expect(parsedFull.volumes[0]).toMatchObject({ dataBytes: 65408 });
});

it("refuses a truncated image when embedded headers suggest a larger eraseblock", async () => {
  const bytes = ubiImageWithEmbeddedPebHeaders();
  expect((await image(bytes)).geometry.pebSize).toBe(32_768);
  expect(await parse(bytes.subarray(0, 73_728))).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("32768-byte eraseblock size"),
    },
  });
});

it("refuses an image whose next erase-counter header disagrees with the first", async () => {
  // A valid header with another image_seq or layout begins an eraseblock, so
  // it is the eraseblock size and the image is refused, not measured past.
  const geometry = { pebSize: 32 * 1024 };
  const [layout0, layout1] = ubiLayoutPebs(RECORDS, geometry);
  const rootfs = {
    kind: "leb" as const,
    volId: 0,
    lnum: 0,
    data: Buffer.from("ROOTFS"),
    sqnum: 2n,
  };
  const withSecond = (second: Buffer) =>
    Buffer.concat([
      ubiImage([layout0!], geometry),
      second,
      ubiImage([layout1!, { kind: "erased" }], geometry),
    ]);
  expect(
    await parse(withSecond(ubiImage([rootfs], { ...geometry, imageSeq: 7 }))),
  ).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining(
        "eraseblock 1 declares image_seq 7, which differs",
      ),
    },
  });
  expect(
    await parse(
      withSecond(
        ubiImage([rootfs], {
          ...geometry,
          vidHeaderOffset: 128,
          dataOffset: 192,
        }),
      ),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining(
        "eraseblock 1 declares vid_hdr_offset 128 and data_offset 192",
      ),
    },
  });

  // Sequences alternating between two nonzero values are refused rather than
  // read as eraseblocks of twice the size.
  const alternating = Buffer.concat(
    [layout0!, rootfs, layout1!, { kind: "free" as const }].map((peb, index) =>
      ubiImage([peb], { ...geometry, imageSeq: index % 2 === 0 ? 5 : 6 }),
    ),
  );
  expect(await parse(alternating)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining(
        "eraseblock 1 declares image_seq 6, which differs from image_seq 5",
      ),
    },
  });
});

it("accepts an eraseblock size whose volume table padding rules out the smaller one", async () => {
  // 128 KiB eraseblocks with data_offset 4096 leave a 126976-byte LEB, so
  // alignment 6144 pads 4096 bytes. A 64 KiB eraseblock would leave a
  // 61440-byte LEB that alignment 6144 divides, so its table would need
  // data_pad 0 and cannot describe this image, though every header position
  // on that grid is erased.
  const geometry = {
    pebSize: 128 * 1024,
    vidHeaderOffset: 2048,
    dataOffset: 4096,
  };
  const records: UbiFixtureVolumeRecord[] = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic",
      reservedPebs: 1,
      alignment: 10_240,
      dataPad: 4096,
    },
  ];
  const bytes = ubiImage(
    [
      ...ubiLayoutPebs(records, geometry),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.from("ROOTFS"),
        sqnum: 2n,
        dataPad: 4096,
      },
    ],
    geometry,
  );
  const parsed = await image(bytes);
  expect(parsed.geometry).toMatchObject({ pebSize: 131072, pebCount: 3 });
  expect(parsed.volumes[0]).toMatchObject({
    name: "rootfs",
    alignment: 10_240,
    dataPad: 4096,
  });

  // With alignment 1 both sizes pad nothing, so the ambiguity stands.
  const unaligned = ubiImage(
    [
      ...ubiLayoutPebs(
        [{ ...records[0]!, alignment: 1, dataPad: 0 }],
        geometry,
      ),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.from("ROOTFS"),
        sqnum: 2n,
      },
    ],
    geometry,
  );
  expect(await parse(unaligned)).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining(
        "also fits a 65536-byte eraseblock size",
      ),
    },
  });
});

it("refuses two copies of one LEB that share a sequence number", async () => {
  const copy = (lnum: number, fill: number, volId = 0) => ({
    kind: "leb" as const,
    volId,
    lnum,
    data: ubiLebData(fill),
    sqnum: 2n,
  });
  expect(
    await parse(
      ubiImage([...ubiLayoutPebs(RECORDS), copy(0, 0x30), copy(0, 0x31)]),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      failure: { offset: 3 * 2048 },
      message: expect.stringContaining(
        "eraseblocks 2 and 3 both hold LEB 0 of volume 0 with sqnum 2",
      ),
    },
  });
  // The layout volume is held to the same rule.
  const [layout0] = ubiLayoutPebs(RECORDS);
  expect(
    await parse(
      ubiImage([layout0!, ...ubiLayoutPebs(RECORDS), { kind: "free" }]),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("so neither copy is newer") },
  });
  // Equal sqnums on different LEBs are not a conflict.
  expect(
    (
      await image(
        ubiImage([...ubiLayoutPebs(RECORDS), copy(0, 0x30), copy(1, 0x31)]),
      )
    ).volumes[0],
  ).toMatchObject({ dataBytes: 3840 });
});

it("rejects a volume table record whose data_pad is not leb_size % alignment", async () => {
  const slots = ubiVolumeTableSlots();
  const padded = (alignment: number, dataPad: number) =>
    ubiVolumeTable([{ ...RECORDS[0]!, alignment, dataPad }], slots);
  const bad = padded(1, 1);
  // A malformed first copy loses to a valid second copy.
  const fallback = await image(
    ubiImage([
      ...ubiLayoutPebs(RECORDS, {}, [bad, ubiVolumeTable(RECORDS, slots)]),
      { kind: "free" },
    ]),
  );
  expect(fallback.volumeTable).toMatchObject({ copiesValid: 1, sourceLnum: 1 });
  expect(fallback.volumes[0]).toMatchObject({
    dataPad: 0,
    usableLebSize: 1920,
  });
  expect(
    await parse(
      ubiImage([...ubiLayoutPebs(RECORDS, {}, [bad, bad]), { kind: "free" }]),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("outside the UBI layout") },
  });
  // 1920 % 1000 = 920 is the only padding alignment 1000 admits.
  const aligned = await image(
    ubiImage([
      ...ubiLayoutPebs(RECORDS, {}, [padded(1000, 920), padded(1000, 920)]),
      { kind: "free" },
    ]),
  );
  expect(aligned.volumes[0]).toMatchObject({
    alignment: 1000,
    usableLebSize: 1000,
  });
});

it("refuses a mapped static LEB that declares zero used_ebs", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "kernel", type: "static", reservedPebs: 2 },
    { id: 1, name: "empty", type: "static", reservedPebs: 2 },
  ];
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: Buffer.from("payload"),
      sqnum: 2n,
      volType: "static",
      usedEbs: 0,
    },
  ]);
  const [kernel, empty] = (await image(bytes)).volumes;
  expect(kernel).toMatchObject({
    extractRefusal: "invalid_static_size",
    mappedLebCount: 1,
    dataBytes: null,
    ranges: [],
    limitations: [UBI_IMAGE_LIMITATIONS.invalidStaticSize],
  });
  // A static volume with no mapped LEB is empty, not contradictory.
  expect(empty).toMatchObject({
    extractRefusal: null,
    usedEbs: 0,
    dataBytes: 0,
  });
});

/** Rewrite one PEB's erase-counter header field and reseal its CRC. */
const withEcField = (
  bytes: Buffer,
  peb: number,
  pebSize: number,
  write: (header: Buffer) => void,
): Buffer => {
  const copy = Buffer.from(bytes);
  const header = copy.subarray(peb * pebSize, peb * pebSize + 64);
  write(header);
  header.writeUInt32BE(~crc32(header.subarray(0, 60)) >>> 0, 60);
  return copy;
};

it("refuses a header on a smaller grid beyond the spacing check", async () => {
  // Odd 2 KiB eraseblocks 1..9 are erased, so the second header is 4 KiB
  // away and the spacing check finds nothing off that grid. The free
  // eraseblock 11 begins on the 2 KiB grid, so 4 KiB would merge it into
  // eraseblock 10's data.
  const erased = { kind: "erased" as const };
  const [layout0, layout1] = ubiLayoutPebs(RECORDS);
  const bytes = ubiImage([
    layout0!,
    erased,
    layout1!,
    erased,
    { kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x30), sqnum: 2n },
    erased,
    erased,
    erased,
    erased,
    erased,
    { kind: "leb", volId: 0, lnum: 1, data: ubiLebData(0x31), sqnum: 3n },
    { kind: "free" },
  ]);
  expect(await parse(bytes)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      failure: { offset: 11 * 2048 },
      message: expect.stringContaining(
        "contradicts the 4096-byte eraseblock size",
      ),
    },
  });
});

it("refuses a smaller-grid header after written positions and on a finer grid", async () => {
  // The second header is 8 KiB away and nothing else lies off that grid in
  // the spacing check. The 4 KiB position at real eraseblock 2 is written (a
  // corrupt EC header), and the free eraseblock 21 begins on the 2 KiB grid
  // only, 42 KiB into the image.
  const erased = { kind: "erased" as const };
  const [layout0, layout1] = ubiLayoutPebs(RECORDS);
  const pebs: UbiFixturePeb[] = Array.from({ length: 24 }, () => erased);
  pebs[0] = layout0!;
  pebs[2] = {
    kind: "leb",
    volId: 0,
    lnum: 1,
    data: ubiLebData(0x31),
    sqnum: 9n,
    ecCrc: 0,
  };
  pebs[4] = layout1!;
  pebs[8] = {
    kind: "leb",
    volId: 0,
    lnum: 0,
    data: ubiLebData(0x30),
    sqnum: 2n,
  };
  pebs[21] = { kind: "free" };
  expect(await parse(ubiImage(pebs))).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      failure: { offset: 21 * 2048 },
      message: expect.stringContaining(
        "contradicts the 8192-byte eraseblock size",
      ),
    },
  });
});

it("accepts an eraseblock size whose static LEB cannot fit the smaller one", async () => {
  // Every header position on the 32 KiB grid is erased, but the static LEB
  // declares more data than a 32 KiB eraseblock holds.
  const wide = { pebSize: 64 * 1024 };
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "kernel", type: "static", reservedPebs: 1 },
  ];
  const data = Buffer.alloc(64 * 1024 - 128, 0x4b);
  data.fill(0xff, 32 * 1024 - 128, 32 * 1024);
  const parsed = await image(
    ubiImage(
      [
        ...ubiLayoutPebs(records, wide),
        {
          kind: "leb",
          volId: 0,
          lnum: 0,
          data,
          sqnum: 2n,
          volType: "static",
          usedEbs: 1,
        },
      ],
      wide,
    ),
  );
  expect(parsed.geometry).toMatchObject({ pebSize: 65536, pebCount: 3 });
  expect(parsed.volumes[0]).toMatchObject({ dataBytes: data.length });
});

it("probes finer PEB divisors even when a coarser divisor fails volume-table padding", async () => {
  // With 128 KiB PEBs and data_offset 4096 (LEB 126976), alignment 12288 gives
  // data_pad 4096. For 64 KiB (LEB 61440), 61440 % 12288 === 0 != 4096, so
  // 64 KiB is invalid, but 32 KiB (LEB 28672) has 28672 % 12288 === 4096 and
  // keeps the volume table valid.
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const records: UbiFixtureVolumeRecord[] = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic",
      reservedPebs: 1,
      alignment: 12_288,
      dataPad: 4096,
    },
  ];
  const erasedOffGrid = Buffer.alloc(
    wide.pebSize - wide.dataOffset - 4096,
    0x52,
  );
  // Erase the header positions at 32 KiB, 64 KiB, and 96 KiB inside the PEB.
  for (const pos of [32 * 1024, 64 * 1024, 96 * 1024]) {
    erasedOffGrid.fill(
      0xff,
      pos - wide.dataOffset,
      pos - wide.dataOffset + 256,
    );
  }
  const ambiguous = ubiImage(
    [
      ...ubiLayoutPebs(records, wide),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: erasedOffGrid,
        sqnum: 2n,
        dataPad: 4096,
      },
    ],
    wide,
  );
  expect(await parse(ambiguous)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("32768-byte eraseblock size"),
    },
  });

  // Control: writing non-header data at one 32 KiB off-grid position rules out
  // 32 KiB and accepts 128 KiB.
  const written = Buffer.from(erasedOffGrid);
  written.fill(
    0x52,
    32 * 1024 - wide.dataOffset,
    32 * 1024 - wide.dataOffset + 256,
  );
  const unambiguous = ubiImage(
    [
      ...ubiLayoutPebs(records, wide),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: written,
        sqnum: 2n,
        dataPad: 4096,
      },
    ],
    wide,
  );
  expect(await parse(unambiguous)).toMatchObject({
    ok: true,
    value: { geometry: { pebSize: 128 * 1024, pebCount: 3 } },
  });
});

it("does not let an orphan VID with oversized data_size hide a real smaller-grid EC header", async () => {
  // Damaged 32 KiB image: [layout0, erased, layout1, erased, rootfs0, erased, orphan, free].
  // Discovery measures 64 KiB. The orphan VID declares data_size=40000 (fits 64 KiB,
  // would be corrupt under 32 KiB), which must not hide the valid free EC header at 7 * 32 KiB.
  const narrow = { pebSize: 32 * 1024, dataOffset: 128 };
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 2 },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records, narrow);
  const bytes = ubiImage(
    [
      layout0!,
      { kind: "erased" },
      layout1!,
      { kind: "erased" },
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.alloc(narrow.pebSize - narrow.dataOffset, 0x41),
        sqnum: 2n,
      },
      { kind: "erased" },
      {
        kind: "leb",
        volId: 99,
        lnum: 0,
        data: Buffer.alloc(narrow.pebSize - narrow.dataOffset, 0x42),
        dataSize: 40_000,
        sqnum: 3n,
      },
      { kind: "free" },
    ],
    narrow,
  );
  expect(await parse(bytes)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      failure: { offset: 7 * narrow.pebSize },
      message: expect.stringContaining("65536-byte eraseblock size"),
    },
  });
});

it("preserves smaller-PEB ambiguity when an off-grid EC header is corrupt", async () => {
  // 128 KiB image [layout0, rootfs LEB0 (bad EC CRC, valid VID), layout1, erased].
  // Initial scan skips the corrupt EC header and measures 256 KiB; smaller-grid
  // probing must recognize the damaged UBI header at 128 KiB as ambiguous.
  const narrow = { pebSize: 128 * 1024, dataOffset: 4096 };
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records, narrow);
  const bytes = ubiImage(
    [
      layout0!,
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.alloc(narrow.pebSize - narrow.dataOffset, 0x52),
        sqnum: 2n,
        ecCrc: 0,
      },
      layout1!,
      { kind: "erased" },
    ],
    narrow,
  );
  expect(await parse(bytes)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("131072-byte eraseblock size"),
    },
  });
});

it("refuses a dynamic volume with a corrupt trailing PEB instead of truncating it", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 2 },
    { id: 1, name: "full", type: "dynamic", reservedPebs: 1 },
  ];
  for (const corruption of [{ ecCrc: 0 }, { vidCrc: 0 }] as const) {
    const bytes = ubiImage(
      [
        ...ubiLayoutPebs(records, wide),
        {
          kind: "leb",
          volId: 0,
          lnum: 0,
          data: Buffer.alloc(lebBytes, 0x30),
          sqnum: 2n,
        },
        {
          kind: "leb",
          volId: 0,
          lnum: 1,
          data: Buffer.alloc(lebBytes, 0x31),
          sqnum: 3n,
          ...corruption,
        },
        {
          kind: "leb",
          volId: 1,
          lnum: 0,
          data: Buffer.alloc(lebBytes, 0x32),
          sqnum: 4n,
        },
      ],
      wide,
    );
    const parsed = await image(bytes);
    expect(parsed.corruptPebCount).toBe(1);
    expect(parsed.volumes[0]).toMatchObject({
      name: "rootfs",
      mappedLebCount: 1,
      extractRefusal: "lost_lebs",
      dataBytes: null,
      ranges: [],
    });
    // Control: a dynamic volume whose mapped LEBs already fill reservedPebs is
    // still extractable even when another PEB is corrupt.
    expect(parsed.volumes[1]).toMatchObject({
      name: "full",
      mappedLebCount: 1,
      extractRefusal: null,
      dataBytes: lebBytes,
    });
  }
});

it("probes the full grid of a passed-over non-dividing candidate beyond the prefix window", async () => {
  // 11 x 128 KiB image truncated by 64 KiB (1344 KiB = 7 x 192 KiB).
  // Dynamic volume with alignment=65536, data_pad=61440 fits both 128 KiB and 192 KiB.
  // Genuine EC header at 896 KiB (7 * 128 KiB, past (4 + 1) * 128 KiB = 640 KiB)
  // falls inside a layout PEB under the 192 KiB retry and must refuse the retry.
  const real = { pebSize: 128 * 1024, dataOffset: 4096 };
  const trial = { pebSize: 192 * 1024, dataOffset: 4096 };
  const realLeb = real.pebSize - real.dataOffset - 61_440;
  const records: UbiFixtureVolumeRecord[] = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic",
      reservedPebs: 9,
      alignment: 65_536,
      dataPad: 61_440,
    },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records, real);
  // Build payload headers at 192 KiB multiples inside the early dynamic LEBs
  // so 192 KiB looks like a dividing candidate with layout PEBs at PEB 4 (768 KiB)
  // and PEB 5 (960 KiB).
  const fakeHeader = ubiImage(
    [
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.alloc(realLeb, 0x52),
        sqnum: 20n,
        dataPad: 61_440,
      },
    ],
    trial,
  ).subarray(0, real.dataOffset);
  const lebWithFake = (lnum: number, sqnum: bigint): UbiFixturePeb => {
    const data = Buffer.alloc(realLeb, 0x40 + lnum);
    fakeHeader.copy(data, 64 * 1024 - real.dataOffset);
    return {
      kind: "leb",
      volId: 0,
      lnum,
      data,
      sqnum,
      dataPad: 61_440,
    };
  };
  const pebs: UbiFixturePeb[] = [
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: Buffer.alloc(realLeb, 0x30),
      sqnum: 2n,
      dataPad: 61_440,
    },
    lebWithFake(1, 3n), // offset 128 KiB -> fake header at 192 KiB
    {
      kind: "leb",
      volId: 0,
      lnum: 2,
      data: Buffer.alloc(realLeb, 0x32),
      sqnum: 4n,
      dataPad: 61_440,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 3,
      data: Buffer.alloc(realLeb, 0x33),
      sqnum: 5n,
      dataPad: 61_440,
    },
    lebWithFake(4, 6n), // offset 512 KiB -> fake header at 576 KiB
    {
      kind: "leb",
      volId: 0,
      lnum: 5,
      data: Buffer.alloc(realLeb, 0x35),
      sqnum: 7n,
      dataPad: 61_440,
    },
    layout0!, // offset 768 KiB (4 * 192 KiB)
    { kind: "free" }, // offset 896 KiB (7 * 128 KiB, inside 192 KiB layout0!)
    {
      kind: "leb",
      volId: 0,
      lnum: 6,
      data: Buffer.alloc(realLeb, 0x36),
      sqnum: 8n,
      dataPad: 61_440,
    },
    layout1!, // offset 1152 KiB (6 * 192 KiB)
    { kind: "free" }, // offset 1280 KiB (truncated to 64 KiB)
  ];
  const full = ubiImage(pebs, real);
  const truncated = full.subarray(0, 11 * real.pebSize - 64 * 1024);
  expect(truncated.length).toBe(7 * trial.pebSize);
  expect(await parse(truncated)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("retries past a trial-grid layout conflict when a later static LEB proves the larger PEB size", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const innerHeader = ubiImage([{ kind: "free" }], {
    pebSize: 64 * 1024,
    dataOffset: 128,
  }).subarray(0, 64);
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 },
    { id: 1, name: "kernel", type: "static", reservedPebs: 1 },
  ];
  const rootfsData = Buffer.alloc(lebBytes, 0x52);
  innerHeader.copy(rootfsData, 64 * 1024 - wide.dataOffset);
  const kernelData = Buffer.alloc(lebBytes, 0x4b);
  const bytes = ubiImage(
    [
      { kind: "leb", volId: 0, lnum: 0, data: rootfsData, sqnum: 2n },
      ...ubiLayoutPebs(records, wide),
      {
        kind: "leb",
        volId: 1,
        lnum: 0,
        data: kernelData,
        sqnum: 3n,
        volType: "static",
        usedEbs: 1,
      },
    ],
    wide,
  );
  const parsed = await image(bytes);
  expect(parsed.geometry).toMatchObject({ pebSize: wide.pebSize, pebCount: 4 });
  expect(parsed.volumes).toMatchObject([
    { name: "rootfs", dataBytes: lebBytes, extractRefusal: null },
    { name: "kernel", dataBytes: lebBytes, extractRefusal: null },
  ]);
});

describe("erase-counter headers inside static LEB payload", () => {
  // 128 KiB eraseblocks with full 126976-byte static LEBs: no smaller
  // eraseblock holds such a LEB, so a valid EC header on a smaller grid
  // inside the payload, as a nested UBI image writes, is data.
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const nestedHeader = ubiImage([{ kind: "free" }], wide).subarray(0, 64);
  /** LEBs 0..5 of one volume; `headers` maps a LEB to payload header offsets. */
  const nestedImage = (
    type: "dynamic" | "static",
    headers: ReadonlyMap<number, number>,
  ) => {
    const records: UbiFixtureVolumeRecord[] = [
      { id: 0, name: "nested", type, reservedPebs: 6 },
    ];
    return ubiImage(
      [
        ...ubiLayoutPebs(records, wide),
        ...Array.from({ length: 6 }, (_, lnum): UbiFixturePeb => {
          const data = Buffer.alloc(lebBytes, 0x40 + lnum);
          const at = headers.get(lnum);
          if (at !== undefined) nestedHeader.copy(data, at);
          return {
            kind: "leb",
            volId: 0,
            lnum,
            data,
            sqnum: BigInt(lnum + 2),
            ...(type === "static" ? { volType: "static", usedEbs: 6 } : {}),
          };
        }),
      ],
      wide,
    );
  };
  // LEB 0 sits in PEB 2, inside the spacing check; LEB 5 in PEB 7 beyond it.
  const inSpacingCheck = new Map([[0, 64 * 1024 - wide.dataOffset]]);
  const beyondSpacingCheck = new Map([[5, 32 * 1024 - wide.dataOffset]]);

  it.each([
    ["inside the spacing check", inSpacingCheck],
    ["beyond the spacing check", beyondSpacingCheck],
  ])(
    "accepts a header %s that no smaller LEB could hold",
    async (_case, at) => {
      const parsed = await parse(nestedImage("static", at));
      expect(parsed).toMatchObject({
        ok: true,
        value: {
          geometry: { pebSize: wide.pebSize, pebCount: 8 },
          volumes: [{ extractRefusal: null, dataBytes: 6 * lebBytes }],
        },
      });
    },
  );

  it.each([
    ["inside the spacing check", inSpacingCheck, 2 * 128 * 1024 + 64 * 1024],
    [
      "beyond the spacing check",
      beyondSpacingCheck,
      7 * 128 * 1024 + 32 * 1024,
    ],
  ])(
    "still refuses a header %s when a smaller LEB fits",
    async (_case, at, offset) => {
      // Dynamic LEBs declare no data size, so a smaller size stays possible.
      expect(await parse(nestedImage("dynamic", at))).toMatchObject({
        ok: false,
        error: {
          kind: "malformed",
          failure: { offset },
          message: expect.stringContaining(
            "contradicts the 131072-byte eraseblock size",
          ),
        },
      });
    },
  );
});

describe("erase-counter headers no eraseblock could begin at", () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;

  it("reads a dynamic LEB holding a nested image the same in any PEB", async () => {
    // A nested image of 2 KiB eraseblocks at the start of a dynamic LEB puts
    // valid headers 4096 and 6144 bytes into the outer eraseblock, which no
    // eligible smaller eraseblock (8 KiB and up, dividing 128 KiB) begins at.
    const nested = ubiImage([{ kind: "free" }, { kind: "free" }]);
    const records: UbiFixtureVolumeRecord[] = [
      { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 6 },
    ];
    const withNestedLeb = (nestedLnum: number) =>
      ubiImage(
        [
          ...ubiLayoutPebs(records, wide),
          ...Array.from({ length: 6 }, (_, lnum): UbiFixturePeb => {
            const data = Buffer.alloc(lebBytes, 0x40 + lnum);
            if (lnum === nestedLnum) nested.copy(data, 0);
            return {
              kind: "leb",
              volId: 0,
              lnum,
              data,
              sqnum: BigInt(lnum + 2),
            };
          }),
        ],
        wide,
      );
    // LEB 0 sits in PEB 2, inside the spacing check; LEB 3 in PEB 5 beyond it.
    const inSpacingCheck = await parse(withNestedLeb(0));
    expect(inSpacingCheck).toMatchObject({
      ok: true,
      value: {
        geometry: { pebSize: wide.pebSize, pebCount: 8 },
        volumes: [{ extractRefusal: null, mappedLebCount: 6 }],
      },
    });
    expect(inSpacingCheck).toEqual(await parse(withNestedLeb(3)));
  });

  it.each([
    ["the same layout", wide],
    ["a different layout", { pebSize: 64 * 1024, dataOffset: 2048 }],
  ])(
    "measures past a nested header of %s inside the first PEB's static data",
    async (_case, inner) => {
      // The dump starts with a static LEB, layout LEBs elsewhere, and a
      // nested header 64 KiB into it. Its VID header declares 126976 bytes of
      // data, so the next eraseblock cannot begin before 128 KiB.
      const nestedHeader = ubiImage([{ kind: "free" }], inner).subarray(0, 64);
      const records: UbiFixtureVolumeRecord[] = [
        { id: 0, name: "kernel", type: "static", reservedPebs: 6 },
      ];
      const lebs = Array.from({ length: 6 }, (_, lnum): UbiFixturePeb => {
        const data = Buffer.alloc(lebBytes, 0x40 + lnum);
        if (lnum === 0) nestedHeader.copy(data, 64 * 1024 - wide.dataOffset);
        return {
          kind: "leb",
          volId: 0,
          lnum,
          data,
          sqnum: BigInt(lnum + 2),
          volType: "static",
          usedEbs: 6,
        };
      });
      const bytes = ubiImage(
        [lebs[0]!, ...ubiLayoutPebs(records, wide), ...lebs.slice(1)],
        wide,
      );
      expect(await parse(bytes)).toMatchObject({
        ok: true,
        value: {
          geometry: { pebSize: wide.pebSize, pebCount: 8 },
          corruptPebCount: 0,
          volumes: [{ extractRefusal: null, dataBytes: 6 * lebBytes }],
        },
      });
    },
  );

  it("reads no VID header the eraseblock ceiling rules out", async () => {
    const vidHeaderOffset = UBI_MAX_PEB_BYTES * 4;
    const header = ubiImage([{ kind: "free" }], {
      vidHeaderOffset,
      dataOffset: vidHeaderOffset + 64,
    }).subarray(0, 64);
    const reads: Array<{ offset: number; length: number }> = [];
    const parsed = await parseUbiImage(
      vidHeaderOffset + 4096,
      (offset, length) => {
        reads.push({ offset, length });
        return offset === 0 ? header.subarray(0, length) : Buffer.alloc(length);
      },
    );
    expect(parsed).toMatchObject({
      ok: false,
      error: { kind: "limit" },
    });
    expect(reads).toEqual([{ offset: 0, length: 64 }]);
  });

  it("measures past a nested image in the first PEB's dynamic data", async () => {
    // A dynamic VID header declares no data size, so only the file size rules
    // out the nested header 6144 bytes in: 524288 is not a multiple of it.
    const nested = ubiImage([{ kind: "free" }, { kind: "free" }]);
    const records: UbiFixtureVolumeRecord[] = [
      { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 2 },
    ];
    const lebs = Array.from({ length: 2 }, (_, lnum): UbiFixturePeb => {
      const data = Buffer.alloc(lebBytes, 0x40 + lnum);
      if (lnum === 0) nested.copy(data, 0);
      return { kind: "leb", volId: 0, lnum, data, sqnum: BigInt(lnum + 2) };
    });
    const bytes = ubiImage(
      [lebs[0]!, ...ubiLayoutPebs(records, wide), lebs[1]!],
      wide,
    );
    expect(bytes.length).toBe(4 * wide.pebSize);
    expect(await parse(bytes)).toMatchObject({
      ok: true,
      value: {
        geometry: { pebSize: wide.pebSize, pebCount: 4 },
        volumes: [{ extractRefusal: null, mappedLebCount: 2 }],
      },
    });
  });
});

it("retries past a dividing small EC header whose PEB count exceeds the ceiling", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 128 };
  const smallCandidate = 512;
  const lebBytes = wide.pebSize - wide.dataOffset;
  const records = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic" as const,
      reservedPebs: 1,
      alignment: lebBytes,
      dataPad: 0,
    },
  ];
  const rootfsData = Buffer.alloc(lebBytes, 0x52);
  ubiImage([{ kind: "free" }], wide)
    .subarray(0, 64)
    .copy(rootfsData, smallCandidate - wide.dataOffset);
  const rootfsLeb = {
    kind: "leb" as const,
    volId: 0,
    lnum: 0,
    data: rootfsData,
    sqnum: 2n,
  };
  const bytes = ubiImage([rootfsLeb, ...ubiLayoutPebs(records, wide)], wide);
  // Extend to the smallest 128 KiB-aligned size where the 512-byte candidate
  // exceeds UBI_MAX_PEBS while the 128 KiB grid stays under it.
  const pebCount =
    Math.floor((UBI_MAX_PEBS * smallCandidate) / wide.pebSize) + 1;
  const fileSize = pebCount * wide.pebSize;
  expect(fileSize % smallCandidate).toBe(0);
  expect(fileSize / smallCandidate).toBeGreaterThan(UBI_MAX_PEBS);
  expect(pebCount).toBeLessThanOrEqual(UBI_MAX_PEBS);
  // Model the zero-filled tail without issuing file reads across the small grid.
  const zeroes = Buffer.alloc(wide.pebSize);
  const parsed = await parseUbiImage(fileSize, (offset, length) => {
    if (offset >= bytes.length) return zeroes.subarray(0, length);
    const prefix = bytes.subarray(offset, offset + length);
    return prefix.length === length
      ? prefix
      : Buffer.concat([prefix, zeroes.subarray(0, length - prefix.length)]);
  });
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      geometry: { pebSize: wide.pebSize, pebCount },
      volumes: [
        {
          name: "rootfs",
          dataBytes: lebBytes,
          extractRefusal: null,
          ranges: [{ offset: wide.dataOffset, length: lebBytes }],
        },
      ],
    },
  });
});

it("records vidMinPebSize when classifying PEB 0 with an oversized data_pad", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const bytes = ubiImage(
    [
      {
        kind: "leb",
        volId: 1,
        lnum: 0,
        data: Buffer.alloc(lebBytes, 0x50),
        sqnum: 1n,
        dataPad: wide.pebSize,
      },
      ...ubiLayoutPebs(
        [{ id: 0, name: "config", type: "static", reservedPebs: 1 }],
        wide,
      ),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.from("CONFIG", "latin1"),
        sqnum: 2n,
        volType: "static",
        usedEbs: 1,
      },
    ],
    wide,
  );
  const parsed = await image(bytes);
  expect(
    classifyUbiPeb(
      bytes.subarray(0, parsed.geometry.headerReadBytes),
      0,
      parsed.geometry,
    ),
  ).toEqual({
    ok: true,
    value: {
      state: "corrupt",
      reason: expect.stringContaining("data_pad 131072"),
      ec: { eraseCounter: 1n, imageSeq: parsed.geometry.imageSeq },
      vidMinPebSize: wide.dataOffset + wide.pebSize + 1,
    },
  });
  expect(parsed).toMatchObject({
    geometry: { pebSize: wide.pebSize, pebCount: 4 },
    corruptPebCount: 1,
    volumes: [{ name: "config", dataBytes: 6, extractRefusal: null }],
  });
});

it.each([
  ["the same layout", { pebSize: 128 * 1024, dataOffset: 4096 }],
  ["a different layout", { pebSize: 64 * 1024, dataOffset: 2048 }],
  [
    "a different image_seq",
    { pebSize: 128 * 1024, dataOffset: 4096, imageSeq: 7 },
  ],
])(
  "retries past a dividing 64 KiB EC header (%s) in a dynamic first LEB when the volume table rules out smaller sizes",
  async (_case, inner) => {
    // 128 KiB PEBs with data_offset 4096 leave a 126976-byte LEB. With
    // alignment 10240 and data_pad 4096 (126976 % 10240 === 4096), every
    // smaller dividing PEB size (64, 32, 16, 8 KiB) invalidates the volume
    // table, leaving 122880 usable bytes per LEB.
    const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
    const lebBytes = wide.pebSize - wide.dataOffset;
    const records: UbiFixtureVolumeRecord[] = [
      {
        id: 0,
        name: "rootfs",
        type: "dynamic",
        reservedPebs: 1,
        alignment: 10_240,
        dataPad: 4_096,
      },
    ];
    const usableLebBytes = lebBytes - 4_096;
    expect(usableLebBytes).toBe(122_880);
    const rootfsData = Buffer.alloc(usableLebBytes, 0x52);
    ubiImage([{ kind: "free" }], inner)
      .subarray(0, 64)
      .copy(rootfsData, 64 * 1024 - wide.dataOffset);
    const rootfsLeb: UbiFixturePeb = {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: rootfsData,
      sqnum: 2n,
      dataPad: 4_096,
    };
    const firstLebImage = ubiImage(
      [rootfsLeb, ...ubiLayoutPebs(records, wide)],
      wide,
    );
    const trailingLebImage = ubiImage(
      [...ubiLayoutPebs(records, wide), rootfsLeb],
      wide,
    );
    expect(firstLebImage.length % (64 * 1024)).toBe(0);
    const parsed = await image(firstLebImage);
    expect(parsed.geometry).toMatchObject({
      pebSize: wide.pebSize,
      pebCount: 3,
    });
    expect(parsed.volumes[0]).toMatchObject({
      name: "rootfs",
      usableLebSize: 122_880,
      dataBytes: 122_880,
      extractRefusal: null,
    });
    const firstRootfs = await reassemble(firstLebImage, "rootfs");
    expect(firstRootfs.equals(rootfsData)).toBe(true);
    expect(
      firstRootfs.equals(await reassemble(trailingLebImage, "rootfs")),
    ).toBe(true);
  },
);

it("reads both volumes when a full static LEB verifies a wider geometry past an earlier sequence conflict", async () => {
  const { bytes, wide, rootfsData, kernelData } =
    ubiImageWithStaticGeometryEvidence(7);
  const parsed = await image(bytes);
  expect(parsed.geometry).toMatchObject({ pebSize: wide.pebSize, pebCount: 4 });
  expect(parsed.volumes).toMatchObject([
    { name: "rootfs", dataBytes: 126_976 },
    { name: "kernel", dataBytes: 126_976 },
  ]);
  expect((await reassemble(bytes, "rootfs")).equals(rootfsData)).toBe(true);
  expect((await reassemble(bytes, "kernel")).equals(kernelData)).toBe(true);
});

it.each(["static CRC mismatch", "extra header in a layout PEB"] as const)(
  "keeps a sequence conflict fatal with %s",
  async (failure) => {
    const { bytes, wide } = ubiImageWithStaticGeometryEvidence(7);
    if (failure === "static CRC mismatch") {
      // Change payload beyond the narrower boundary without touching the VID.
      bytes[2 * wide.pebSize - 1] = 0;
    } else {
      // Put a second conflicting EC header beyond the layout table.
      bytes.copy(
        bytes,
        2 * wide.pebSize + 64 * 1024,
        64 * 1024,
        64 * 1024 + 64,
      );
    }
    expect(await parse(bytes)).toMatchObject({
      ok: false,
      error: {
        kind: "malformed",
        message: expect.stringContaining("eraseblock 1 declares image_seq 7"),
      },
    });
  },
);

it("rejects an image sequence conflict outside the undersized LEB span", async () => {
  const narrow = { pebSize: 64 * 1024, dataOffset: 4096 };
  const rootfs: UbiFixturePeb = {
    kind: "leb",
    volId: 0,
    lnum: 0,
    // Written data across the 32 KiB boundary rules out a finer grid.
    data: Buffer.alloc(narrow.pebSize - narrow.dataOffset, 0x52),
    sqnum: 2n,
  };
  const [layout0, layout1] = ubiLayoutPebs(RECORDS, narrow);
  const bytes = Buffer.concat([
    ubiImage([rootfs], { ...narrow, imageSeq: 5 }),
    ubiImage([{ kind: "free" }], { ...narrow, imageSeq: 6 }),
    ubiImage(
      [
        layout0!,
        { kind: "erased" },
        layout1!,
        { kind: "erased" },
        {
          kind: "leb",
          volId: 1,
          lnum: 0,
          data: Buffer.from("orphan"),
          dataSize: 81_920,
          sqnum: 3n,
        },
        { kind: "erased" },
      ],
      { ...narrow, imageSeq: 5 },
    ),
  ]);
  expect(await parse(bytes)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining(
        "eraseblock 1 declares image_seq 6, which differs from image_seq 5",
      ),
    },
  });
});

it("bounds reads of overlapping static payloads during geometry checks", async () => {
  const geometry = { pebSize: 512, imageSeq: 5 };
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "kernel", type: "static", reservedPebs: 1 },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records, geometry);
  const dataSize = 16 * 1024;
  const bytes = Buffer.concat([
    ubiImage([layout0!], geometry),
    ubiImage([{ kind: "free" }], { ...geometry, imageSeq: 6 }),
    ubiImage(
      [
        layout1!,
        ...Array.from({ length: 61 }, (_, index): UbiFixturePeb => ({
          kind: "leb",
          volId: 0,
          lnum: 0,
          volType: "static",
          usedEbs: 1,
          data: Buffer.alloc(0),
          dataSize,
          dataCrc: 0,
          sqnum: BigInt(index),
        })),
      ],
      geometry,
    ),
  ]);
  let bytesRead = 0;
  let payloadBytesRead = 0;
  const parsed = await parseUbiImage(bytes.length, (offset, length) => {
    bytesRead += length;
    if (length === dataSize) payloadBytesRead += length;
    return bytes.subarray(offset, offset + length);
  });
  expect(parsed).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: {
          name: UBI_STATIC_PAYLOAD_CRC_LIMIT,
          maximum: 2 * bytes.length,
        },
      },
    },
  });
  expect(payloadBytesRead).toBe(2 * bytes.length);
  expect(bytesRead).toBeLessThan(4 * bytes.length);
});

it("reuses static payload CRCs across PEB size candidates", async () => {
  const geometry = { pebSize: 1536, dataOffset: 512, imageSeq: 5 };
  const bytes = Buffer.alloc(18_432, 0xff);
  const free: UbiFixturePeb = { kind: "free" };
  // Both candidate grids see the conflict and the same table and payloads.
  for (const offset of [0, 1024, 1536])
    ubiImage([free], geometry).subarray(0, 64).copy(bytes, offset);
  ubiImage([free], { ...geometry, imageSeq: 6 }).copy(bytes, 3072);
  const [layout] = ubiLayoutPebs(
    [{ id: 0, name: "kernel", type: "static", reservedPebs: 1 }],
    geometry,
  );
  ubiImage([layout!], geometry).copy(bytes, 6144);
  const data = Buffer.alloc(2048, 0x53);
  const staticPeb: UbiFixturePeb = {
    kind: "leb",
    volId: 0,
    lnum: 0,
    volType: "static",
    usedEbs: 1,
    data,
    sqnum: 1n,
  };
  ubiImage([{ ...staticPeb, dataCrc: 0 }], geometry).copy(bytes, 9216);
  // A matching CRC lets each candidate retry after checking the bad range.
  ubiImage([staticPeb], geometry).copy(bytes, 12_288);
  data.copy(bytes, 12_288 + geometry.dataOffset);

  const payloadReads: number[] = [];
  const tableReads: number[] = [];
  const parsed = await parseUbiImage(bytes.length, (offset, length) => {
    if (length === data.length) payloadReads.push(offset);
    if (offset === 6144 + geometry.dataOffset) tableReads.push(length);
    return bytes.subarray(offset, offset + length);
  });
  expect(parsed).toMatchObject({ ok: false, error: { kind: "malformed" } });
  expect(tableReads.slice(0, 2)).toEqual([344, 860]);
  expect(payloadReads).toEqual([
    9216 + geometry.dataOffset,
    12_288 + geometry.dataOffset,
  ]);
});

describe("passed-over candidate boundaries", () => {
  const narrow = { pebSize: 64 * 1024, dataOffset: 4096 };
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const records: UbiFixtureVolumeRecord[] = [
    {
      id: 0,
      name: "rootfs",
      type: "dynamic",
      reservedPebs: 1,
      alignment: 10_240,
      dataPad: 4_096,
    },
  ];
  const [layout0, layout1] = ubiLayoutPebs(records, narrow);
  const rootfs: UbiFixturePeb = {
    kind: "leb",
    volId: 0,
    lnum: 0,
    data: Buffer.alloc(narrow.pebSize - narrow.dataOffset - 4096, 0x52),
    sqnum: 2n,
    dataPad: 4096,
  };

  it.each([
    [
      "layout-first (header inside PEB 0 layout volume)",
      [
        layout0!,
        { kind: "free" },
        layout1!,
        { kind: "free" },
        rootfs,
        { kind: "free" },
      ],
    ],
    [
      "rootfs-first (later header on retried grid inside layout volume)",
      [
        rootfs,
        { kind: "free" },
        layout0!,
        { kind: "free" },
        layout1!,
        { kind: "free" },
      ],
    ],
    [
      "free-first (header inside PEB 0 free block)",
      [
        { kind: "free" },
        { kind: "free" },
        layout0!,
        { kind: "free" },
        layout1!,
        { kind: "free" },
      ],
    ],
  ] as const)(
    "refuses a 128 KiB retry when passed-over 64 KiB headers lie outside mapped non-layout LEBs (%s)",
    async (_case, pebs) => {
      const parsed = await parse(ubiImage(pebs, narrow));
      expect(parsed).toMatchObject({
        ok: false,
        error: {
          kind: "malformed",
          message: expect.stringContaining("no valid volume table"),
        },
      });
    },
  );

  it("accepts a later dividing candidate that places a non-dividing mapped nested header inside mapped non-layout LEB data", async () => {
    const lebBytes = wide.pebSize - wide.dataOffset;
    const nested = ubiImage(
      [
        {
          kind: "leb",
          volId: 0,
          lnum: 0,
          data: Buffer.alloc(100, 1),
          sqnum: 1n,
        },
        {
          kind: "leb",
          volId: 0,
          lnum: 1,
          data: Buffer.alloc(100, 2),
          sqnum: 2n,
        },
      ],
      { pebSize: 32 * 1024, dataOffset: 4096 },
    );
    const first = Buffer.alloc(lebBytes, 0x52);
    nested.copy(first, 0);
    const second = Buffer.alloc(lebBytes, 0x53);
    const bytes = ubiImage(
      [
        { kind: "leb", volId: 0, lnum: 0, data: first, sqnum: 2n },
        ...ubiLayoutPebs(
          [{ id: 0, name: "rootfs", type: "dynamic", reservedPebs: 2 }],
          wide,
        ),
        { kind: "leb", volId: 0, lnum: 1, data: second, sqnum: 3n },
      ],
      wide,
    );
    const parsed = await image(bytes);
    expect(parsed.geometry).toMatchObject({
      pebSize: wide.pebSize,
      pebCount: 4,
    });
    expect(parsed.volumes).toMatchObject([
      { name: "rootfs", dataBytes: 2 * lebBytes, extractRefusal: null },
    ]);
    expect(
      (await reassemble(bytes, "rootfs")).equals(
        Buffer.concat([first, second]),
      ),
    ).toBe(true);
  });

  it("keeps refusing a truncated dump when the later dividing candidate puts the mapped boundary inside a layout PEB", async () => {
    const truncated = ubiImageWithEmbeddedPebHeaders().subarray(0, 73_728);
    expect(await parse(truncated)).toMatchObject({
      ok: false,
      error: {
        kind: "malformed",
        message: expect.stringContaining("32768-byte eraseblock size"),
      },
    });
  });
});

it("keeps erase-counter facts of an eraseblock whose VID header is corrupt", async () => {
  const bytes = ubiImage([
    ...ubiLayoutPebs(RECORDS),
    { kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x30), sqnum: 2n },
    {
      kind: "leb",
      volId: 0,
      lnum: 1,
      data: ubiLebData(0x31),
      sqnum: 3n,
      vidCrc: 0,
      eraseCounter: 99n,
    },
  ]);
  const parsed = await image(bytes);
  expect(parsed).toMatchObject({
    corruptPebCount: 1,
    mappedPebCount: 3,
    maxEraseCounter: 99,
  });
  expect(parsed.volumes[0]).toMatchObject({ mappedLebCount: 1 });

  const conflicting = withEcField(bytes, 3, 2048, (header) =>
    header.writeUInt32BE(0x9999, 24),
  );
  expect(await parse(conflicting)).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining(
        "UBI eraseblock 3 declares image_seq 39321",
      ),
    },
  });
});

it("falls back to the other volume table copy when an update marker is invalid", async () => {
  const slots = ubiVolumeTableSlots();
  const valid = ubiVolumeTable([{ ...RECORDS[0]!, name: "second" }], slots);
  const invalid = ubiVolumeTable(RECORDS, slots);
  invalid[13] = 2;
  invalid.writeUInt32BE(~crc32(invalid.subarray(0, 168)) >>> 0, 168);
  const parsed = await image(
    ubiImage([
      ...ubiLayoutPebs(RECORDS, {}, [invalid, valid]),
      { kind: "free" },
    ]),
  );
  expect(parsed.volumeTable).toMatchObject({
    copiesFound: 2,
    copiesValid: 1,
    sourceLnum: 1,
  });
  expect(parsed.volumes[0]).toMatchObject({
    name: "second",
    updateMarker: false,
  });
});

it("counts known LEB gaps even when an earlier refusal prevents extraction", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "short-static", type: "static", reservedPebs: 3 },
    { id: 1, name: "mismatched-dynamic", type: "dynamic", reservedPebs: 4 },
    { id: 2, name: "overlarge-static", type: "static", reservedPebs: 3 },
    { id: 3, name: "inconsistent-static", type: "static", reservedPebs: 4 },
  ];
  const bytes = ubiImage([
    ...ubiLayoutPebs(records),
    // Static volume with used_ebs 3 mapping LEBs 0 and 2 where LEB 0 is short.
    {
      kind: "leb",
      volId: 0,
      lnum: 0,
      data: Buffer.from("short"),
      sqnum: 2n,
      volType: "static",
      usedEbs: 3,
    },
    {
      kind: "leb",
      volId: 0,
      lnum: 2,
      data: Buffer.from("last"),
      sqnum: 3n,
      volType: "static",
      usedEbs: 3,
    },
    // Dynamic volume with vid_record_mismatch and a gap at LEB 1.
    {
      kind: "leb",
      volId: 1,
      lnum: 0,
      data: Buffer.from("wrong-type"),
      sqnum: 4n,
      volType: "static",
      usedEbs: 1,
    },
    {
      kind: "leb",
      volId: 1,
      lnum: 2,
      data: ubiLebData(0x32),
      sqnum: 5n,
    },
    // Over-large used_ebs is bounded by reservedPebs when counting gaps.
    {
      kind: "leb",
      volId: 2,
      lnum: 0,
      data: ubiLebData(0x30),
      sqnum: 6n,
      volType: "static",
      usedEbs: 100,
    },
    // Inconsistent used_ebs claims no gaps.
    {
      kind: "leb",
      volId: 3,
      lnum: 0,
      data: ubiLebData(0x30),
      sqnum: 7n,
      volType: "static",
      usedEbs: 3,
    },
    {
      kind: "leb",
      volId: 3,
      lnum: 2,
      data: Buffer.from("tail"),
      sqnum: 8n,
      volType: "static",
      usedEbs: 4,
    },
  ]);
  const [shortStatic, mismatchedDynamic, overlargeStatic, inconsistentStatic] =
    (await image(bytes)).volumes;
  expect(shortStatic).toMatchObject({
    extractRefusal: "invalid_static_size",
    missingLebCount: 1,
    firstMissingLeb: 1,
    dataBytes: null,
    ranges: [],
  });
  expect(mismatchedDynamic).toMatchObject({
    extractRefusal: "vid_record_mismatch",
    missingLebCount: 1,
    firstMissingLeb: 1,
    dataBytes: null,
    ranges: [],
  });
  expect(overlargeStatic).toMatchObject({
    extractRefusal: "invalid_static_size",
    missingLebCount: 2,
    firstMissingLeb: 1,
    dataBytes: null,
    ranges: [],
  });
  expect(inconsistentStatic).toMatchObject({
    extractRefusal: "invalid_static_size",
    usedEbs: null,
    missingLebCount: 0,
    firstMissingLeb: null,
    dataBytes: null,
    ranges: [],
  });
});

it("classifies a block with erased headers and written payload as corrupt instead of truncating", async () => {
  const records: UbiFixtureVolumeRecord[] = [
    { id: 0, name: "rootfs", type: "dynamic", reservedPebs: 2 },
  ];
  const intact = ubiImage([
    ...ubiLayoutPebs(records),
    { kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x30), sqnum: 2n },
    { kind: "leb", volId: 0, lnum: 1, data: ubiLebData(0x31), sqnum: 3n },
  ]);
  expect((await image(intact)).volumes[0]).toMatchObject({
    extractRefusal: null,
    dataBytes: 3840,
  });

  // Erase only the first 128 bytes (EC + VID headers) of the last block while
  // keeping its payload. It must classify as corrupt so rootfs is not silently
  // truncated from 3,840 bytes to 1,920 bytes.
  const headersErased = Buffer.from(intact);
  headersErased.fill(0xff, 3 * 2048, 3 * 2048 + 128);
  const damaged = await image(headersErased);
  expect(damaged).toMatchObject({
    corruptPebCount: 1,
    erasedPebCount: 0,
  });
  expect(damaged.volumes[0]).toMatchObject({
    name: "rootfs",
    mappedLebCount: 1,
    extractRefusal: "lost_lebs",
    dataBytes: null,
    ranges: [],
  });

  // Control: erasing the entire last block makes it genuinely erased.
  const fullyErased = Buffer.from(intact);
  fullyErased.fill(0xff, 3 * 2048, 4 * 2048);
  const clean = await image(fullyErased);
  expect(clean).toMatchObject({
    corruptPebCount: 0,
    erasedPebCount: 1,
  });
  expect(clean.volumes[0]).toMatchObject({
    name: "rootfs",
    mappedLebCount: 1,
    extractRefusal: null,
    dataBytes: 1920,
  });

  // Bounded chunked reads detect a written byte past the 64 KiB chunk boundary.
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const wideLeb = wide.pebSize - wide.dataOffset;
  const wideBytes = ubiImage(
    [
      ...ubiLayoutPebs(records, wide),
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        data: Buffer.alloc(wideLeb, 0x30),
        sqnum: 2n,
      },
      { kind: "erased" },
    ],
    wide,
  );
  // Write a single non-0xFF byte near the end of the 128 KiB erased block.
  wideBytes[wideBytes.length - 1] = 0x42;
  let maxChunkRead = 0;
  const parsedWide = await parseUbiImage(wideBytes.length, (offset, length) => {
    if (offset >= 3 * wide.pebSize)
      maxChunkRead = Math.max(maxChunkRead, length);
    return wideBytes.subarray(offset, offset + length);
  });
  expect(parsedWide.ok).toBe(true);
  if (!parsedWide.ok) return;
  expect(maxChunkRead).toBeLessThanOrEqual(64 * 1024 + 64);
  expect(parsedWide.value).toMatchObject({
    corruptPebCount: 1,
    erasedPebCount: 0,
  });
  expect(parsedWide.value.volumes[0]).toMatchObject({
    extractRefusal: "lost_lebs",
    dataBytes: null,
  });
});

it("keeps total read bytes bounded when many dividing EC headers appear in a mostly-erased file", async () => {
  // 512 * 5040 = 2,580,480 bytes has 60 divisors; placing a valid EC header at
  // offset 0 and every dividing offset exercises every trial block size without
  // a valid volume table. Erased-body verification must be deferred past table
  // validation so retries do not reread the file body for each divisor.
  const unit = 512;
  const units = 5040;
  const probe = Buffer.alloc(unit * units, 0xff);
  const ecHeader = ubiImage([{ kind: "free" }]).subarray(0, 64);
  ecHeader.copy(probe, 0);
  for (let d = 1; d < units; d += 1) {
    if (units % d === 0) ecHeader.copy(probe, d * unit);
  }
  let bytesRead = 0;
  const result = await parseUbiImage(probe.length, (offset, length) => {
    bytesRead += length;
    return probe.subarray(offset, offset + length);
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("no valid volume table"),
    },
  });
  expect(bytesRead).toBeLessThanOrEqual(2 * probe.length);
});

it("verifies tens of thousands of erased blocks in linear time", async () => {
  const geometry = { pebSize: 512, dataOffset: 128 };
  const [layout0, layout1] = ubiLayoutPebs(
    [{ id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 }],
    geometry,
  );
  const prefix = ubiImage([layout0!, layout1!], geometry);
  const freeBlock = ubiImage([{ kind: "free" }], geometry);
  const erasedBlock = Buffer.alloc(geometry.pebSize, 0xff);
  const consecutiveErased = 20_000;
  const alternatingPairs = 10_000;
  const pebCount = 2 + consecutiveErased + alternatingPairs * 2;
  const fileSize = pebCount * geometry.pebSize;
  const blockAt = (pebIndex: number): Buffer => {
    if (pebIndex < 2)
      return prefix.subarray(
        pebIndex * geometry.pebSize,
        (pebIndex + 1) * geometry.pebSize,
      );
    if (pebIndex < 2 + consecutiveErased) return erasedBlock;
    return (pebIndex - 2 - consecutiveErased) % 2 === 0
      ? freeBlock
      : erasedBlock;
  };
  let bodyBytesRead = 0;
  const verificationPasses: UbiErasedBodyVerificationStats[] = [];
  const startedAt = performance.now();
  const parsed = await parseUbiImage(
    fileSize,
    (offset, length) => {
      const pebIndex = Math.floor(offset / geometry.pebSize);
      const inPeb = offset % geometry.pebSize;
      if (inPeb === geometry.dataOffset && length === geometry.pebSize - inPeb)
        bodyBytesRead += length;
      if (inPeb + length <= geometry.pebSize)
        return blockAt(pebIndex).subarray(inPeb, inPeb + length);
      const out = Buffer.alloc(length);
      let written = 0;
      while (written < length) {
        const pos = offset + written;
        const idx = Math.floor(pos / geometry.pebSize);
        const local = pos % geometry.pebSize;
        const take = Math.min(length - written, geometry.pebSize - local);
        blockAt(idx).copy(out, written, local, local + take);
        written += take;
      }
      return out;
    },
    { onErasedBodyVerification: (pass) => verificationPasses.push(pass) },
  );
  const elapsedMs = performance.now() - startedAt;
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      geometry: { pebSize: geometry.pebSize, pebCount },
      mappedPebCount: 2,
      freePebCount: alternatingPairs,
      erasedPebCount: consecutiveErased + alternatingPairs,
      corruptPebCount: 0,
    },
  });
  expect(bodyBytesRead).toBe(
    (consecutiveErased + alternatingPairs) *
      (geometry.pebSize - geometry.dataOffset),
  );
  expect(verificationPasses).toHaveLength(1);
  expect(verificationPasses[0]).toMatchObject({
    erasedRangeCount: 1 + alternatingPairs,
    nonErasedOffsetCount: 0,
  });
  expect(verificationPasses[0]!.rangeWalkSteps).toBeLessThanOrEqual(
    3 * pebCount,
  );
  expect(elapsedMs).toBeLessThan(5_000);
});

it("reuses dynamic wear-leveling copy CRCs across PEB size candidates", async () => {
  // 512 * 5040 = 2,580,480 bytes has 60 divisors; placing two competing dynamic
  // wear-leveling copies at offsets 0 and 512 * 2520 puts both on the grid of
  // every divisor of 2520 (48 divisors). Each copy's payload must be read and
  // hashed once instead of once per trial candidate.
  const unit = 512;
  const units = 5040;
  const half = 2520;
  const dataOffset = 128;
  const dataSize = unit - dataOffset;
  const probe = Buffer.alloc(unit * units, 0xff);
  const ecHeader = ubiImage([{ kind: "free" }], {
    pebSize: unit,
    dataOffset,
  }).subarray(0, 64);
  for (let d = 1; d < units; d += 1) {
    if (units % d === 0) ecHeader.copy(probe, d * unit);
  }
  const copy0 = ubiImage(
    [
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        volType: "dynamic",
        copyFlag: true,
        data: Buffer.alloc(dataSize, 0x41),
        sqnum: 1n,
      },
    ],
    { pebSize: unit, dataOffset },
  );
  const copy1 = ubiImage(
    [
      {
        kind: "leb",
        volId: 0,
        lnum: 0,
        volType: "dynamic",
        copyFlag: true,
        data: Buffer.alloc(dataSize, 0x42),
        sqnum: 2n,
      },
    ],
    { pebSize: unit, dataOffset },
  );
  copy0.copy(probe, 0);
  copy1.copy(probe, half * unit);

  let bytesRead = 0;
  const copyPayloadReads = new Map<number, number>();
  const result = await parseUbiImage(probe.length, (offset, length) => {
    bytesRead += length;
    if (
      length === dataSize &&
      (offset === dataOffset || offset === half * unit + dataOffset)
    )
      copyPayloadReads.set(offset, (copyPayloadReads.get(offset) ?? 0) + 1);
    return probe.subarray(offset, offset + length);
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining("no valid volume table"),
    },
  });
  expect(copyPayloadReads).toEqual(
    new Map([
      [dataOffset, 1],
      [half * unit + dataOffset, 1],
    ]),
  );
  expect(bytesRead).toBeLessThanOrEqual(2 * probe.length);
});

it("reuses cached EC header locations across multi-trial oversized-VID retries", async () => {
  // 3 * 5 * 7 * 32 KiB = 3,440,640 bytes with data_offset = 32 KiB admits
  // three coprime-multiple trials (96 KiB, 160 KiB, 224 KiB) whose smaller
  // plausible divisors (48 KiB, 80 KiB, 112 KiB) do not collide with the other
  // trials' EC headers. An oversized VID triggers retries across all three
  // trials; caching the EC header scan keeps total reads bounded near 1x-2x
  // file size instead of rescanning the whole image per trial.
  const unit = 32 * 1024;
  const fileSize = 3 * 5 * 7 * unit;
  const trials = [3 * unit, 5 * unit, 7 * unit] as const;
  const smallerProbes = [48 * 1024, 80 * 1024, 112 * 1024] as const;
  const probe = Buffer.alloc(fileSize, 0x55);
  const layoutGeometry = { pebSize: trials[0], dataOffset: unit };
  const [layout0] = ubiLayoutPebs(
    [{ id: 0, name: "rootfs", type: "dynamic", reservedPebs: 1 }],
    layoutGeometry,
  );
  ubiImage([layout0!], layoutGeometry).copy(probe, 0);
  const oversizedHeader = ubiImage(
    [
      {
        kind: "leb",
        volId: 1,
        lnum: 0,
        data: Buffer.alloc(0),
        dataSize: 512 * 1024,
        sqnum: 2n,
      },
    ],
    layoutGeometry,
  ).subarray(0, 128);
  for (const offset of trials) oversizedHeader.copy(probe, offset);

  let bytesRead = 0;
  const seenSmallerProbes = new Set<number>();
  const parsed = await parseUbiImage(probe.length, (offset, length) => {
    bytesRead += length;
    if (length === 128 && (smallerProbes as readonly number[]).includes(offset))
      seenSmallerProbes.add(offset);
    return probe.subarray(offset, offset + length);
  });
  expect(parsed).toMatchObject({
    ok: true,
    value: {
      geometry: { pebSize: trials[0], pebCount: fileSize / trials[0] },
    },
  });
  // Confirm all three block-size trials ran findSmallerGridError.
  expect([...seenSmallerProbes].sort((a, b) => a - b)).toEqual([
    ...smallerProbes,
  ]);
  expect(bytesRead).toBeLessThanOrEqual(2 * probe.length);
});

it("bounds the EC header scan cache when payloads are stuffed with valid UBI# headers", async () => {
  const wide = { pebSize: 128 * 1024, dataOffset: 4096 };
  const lebBytes = wide.pebSize - wide.dataOffset;
  const dynamicPebs = 300;
  const pebCount = 2 + dynamicPebs;
  const fileSize = pebCount * wide.pebSize;
  const [layout0, layout1] = ubiLayoutPebs(
    [{ id: 0, name: "rootfs", type: "dynamic", reservedPebs: dynamicPebs }],
    wide,
  );
  const layoutPrefix = ubiImage([layout0!, layout1!], wide);
  const validEcHeader = ubiImage([{ kind: "free" }], wide).subarray(0, 64);

  // Stuff every 512-byte slot outside all smaller-block grids (multiples of
  // 8 KiB) with a CRC-valid UBI# header: 233 payload headers + 1 PEB header
  // per block => > 70,000 valid EC headers across 300 blocks, exceeding
  // UBI_MAX_CACHED_EC_HEADERS.
  const stuffedPayload = Buffer.alloc(lebBytes, 0x55);
  for (let inPeb = wide.dataOffset; inPeb < wide.pebSize; inPeb += 512) {
    if (inPeb % 8192 === 0) continue;
    validEcHeader.copy(stuffedPayload, inPeb - wide.dataOffset);
  }
  const makeLebBlock = (lnum: number): Buffer =>
    ubiImage(
      [
        {
          kind: "leb",
          volId: 0,
          lnum,
          data: stuffedPayload,
          sqnum: BigInt(lnum + 2),
        },
      ],
      wide,
    );
  const templateBlock = makeLebBlock(0);
  // Precompute only the 128-byte EC+VID header per dynamic PEB to keep fixture
  // memory tiny while serving distinct valid lnum/sqnum headers.
  const dynamicHeaders = Array.from({ length: dynamicPebs }, (_, lnum) =>
    makeLebBlock(lnum).subarray(0, wide.dataOffset),
  );
  const conflictOffset = (pebCount - 1) * wide.pebSize + 64 * 1024;
  const readVirtual =
    (injectTailConflict: boolean) =>
    (offset: number, length: number): Buffer => {
      const out = Buffer.alloc(length);
      let written = 0;
      while (written < length) {
        const pos = offset + written;
        const pebIndex = Math.floor(pos / wide.pebSize);
        const inPeb = pos % wide.pebSize;
        const take = Math.min(length - written, wide.pebSize - inPeb);
        if (pebIndex < 2) {
          layoutPrefix.copy(out, written, pos, pos + take);
        } else if (inPeb < wide.dataOffset) {
          const headerTake = Math.min(take, wide.dataOffset - inPeb);
          dynamicHeaders[pebIndex - 2]!.copy(
            out,
            written,
            inPeb,
            inPeb + headerTake,
          );
          if (headerTake < take)
            templateBlock.copy(
              out,
              written + headerTake,
              wide.dataOffset,
              wide.dataOffset + (take - headerTake),
            );
        } else {
          templateBlock.copy(out, written, inPeb, inPeb + take);
        }
        written += take;
      }
      if (
        injectTailConflict &&
        offset < conflictOffset + 64 &&
        offset + length > conflictOffset
      ) {
        const start = Math.max(0, conflictOffset - offset);
        const srcStart = Math.max(0, offset - conflictOffset);
        const copyLen = Math.min(length - start, 64 - srcStart);
        validEcHeader.copy(out, start, srcStart, srcStart + copyLen);
      }
      return out;
    };

  let cleanStats: UbiEcHeaderCacheStats | undefined;
  const clean = await parseUbiImage(fileSize, readVirtual(false), {
    onEcHeaderCacheStats: (stats) => {
      cleanStats = stats;
    },
  });
  expect(clean).toMatchObject({
    ok: true,
    value: {
      geometry: { pebSize: wide.pebSize, pebCount },
      volumes: [
        {
          name: "rootfs",
          dataBytes: dynamicPebs * lebBytes,
          extractRefusal: null,
        },
      ],
    },
  });
  expect(cleanStats).toBeDefined();
  expect(cleanStats!.cachedHeaderCount).toBe(UBI_MAX_CACHED_EC_HEADERS);
  expect(cleanStats!.cacheCapped).toBe(true);
  expect(cleanStats!.ecHeaderScanEnd).toBeLessThan(fileSize);

  // A spacing conflict placed beyond the cache cap must still be detected by
  // the streaming tail scan without growing the cache.
  let conflictStats: UbiEcHeaderCacheStats | undefined;
  const conflicted = await parseUbiImage(fileSize, readVirtual(true), {
    onEcHeaderCacheStats: (stats) => {
      conflictStats = stats;
    },
  });
  expect(conflicted).toMatchObject({
    ok: false,
    error: {
      kind: "malformed",
      message: expect.stringContaining(
        `offset ${String(conflictOffset)} contradicts the ${String(wide.pebSize)}-byte eraseblock size`,
      ),
    },
  });
  expect(conflictStats).toBeDefined();
  expect(conflictStats!.cachedHeaderCount).toBe(UBI_MAX_CACHED_EC_HEADERS);
  expect(conflictStats!.cacheCapped).toBe(true);
});

describe("layout volume VID validation", () => {
  const slots = ubiVolumeTableSlots();
  const staleTable = ubiVolumeTable(
    [{ id: 0, name: "stale", type: "dynamic", reservedPebs: 1 }],
    slots,
  );
  const soundTable = ubiVolumeTable(
    [{ id: 0, name: "current", type: "dynamic", reservedPebs: 4 }],
    slots,
  );

  it.each([
    [
      "excessive data_pad leaving 1 usable byte",
      { volType: "dynamic" as const, dataPad: 1919 },
    ],
    [
      "static layout VID with data_size=1",
      { volType: "static" as const, dataSize: 1, usedEbs: 1 },
    ],
    [
      "dynamic wear-leveling copy with data_size=1",
      { volType: "dynamic" as const, copyFlag: true, dataSize: 1 },
    ],
  ])(
    "rejects an invalid layout VID (%s), falls back to LEB 1, and refuses when both are invalid",
    async (_label, invalidVid) => {
      const invalidCopy = (lnum: 0 | 1, sqnum: bigint): UbiFixturePeb => ({
        kind: "leb",
        volId: UBI_LAYOUT_VOLUME_ID,
        lnum,
        data: staleTable,
        sqnum,
        ...invalidVid,
      });
      const soundCopy: UbiFixturePeb = {
        kind: "leb",
        volId: UBI_LAYOUT_VOLUME_ID,
        lnum: 1,
        data: soundTable,
        sqnum: 2n,
        volType: "dynamic",
      };

      // Invalid LEB 0 falls back to sound LEB 1 instead of supplying the stale table.
      const fallback = await image(
        ubiImage([
          invalidCopy(0, 1n),
          soundCopy,
          { kind: "leb", volId: 0, lnum: 0, data: ubiLebData(0x43), sqnum: 3n },
        ]),
      );
      expect(fallback.volumeTable).toMatchObject({
        copiesFound: 1,
        copiesValid: 1,
        copiesAgree: null,
        sourceLnum: 1,
      });
      expect(fallback.volumes).toMatchObject([
        { name: "current", reservedPebs: 4, extractRefusal: null },
      ]);

      // Both layout copies invalid -> refuse the image.
      expect(
        await parse(
          ubiImage([
            invalidCopy(0, 1n),
            invalidCopy(1, 2n),
            {
              kind: "leb",
              volId: 0,
              lnum: 0,
              data: ubiLebData(0x43),
              sqnum: 3n,
            },
          ]),
        ),
      ).toMatchObject({
        ok: false,
        error: {
          kind: "malformed",
          message: expect.stringContaining("no valid volume table"),
        },
      });
    },
  );
});

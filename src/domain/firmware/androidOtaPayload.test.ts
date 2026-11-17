import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";

import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { expect, it } from "vitest";

import {
  ANDROID_OTA_HEADER_V2_BYTES,
  ANDROID_OTA_MAGIC,
  ANDROID_OTA_MAX_EXTENTS_TOTAL,
  ANDROID_OTA_MAX_EXTRACT_BYTES,
  ANDROID_OTA_MAX_GROUP_PARTITION_NAMES,
  ANDROID_OTA_MAX_MANIFEST_BYTES,
  ANDROID_OTA_MAX_OPERATION_DATA_BYTES,
  ANDROID_OTA_MAX_PARTITIONS,
  ANDROID_OTA_MAX_SIGNATURE_BYTES,
  ANDROID_OTA_PAYLOAD_LIMITATIONS,
  parseAndroidOtaHeader,
  parseAndroidOtaPayload,
  recognizeAndroidOtaPayload,
  reconstructAndroidOtaPartition,
  androidOtaDistinctOperationDataBytes,
  androidOtaUnsupportedVersion,
} from "./androidOtaPayload.js";
import {
  buildAndroidOtaPayload,
  deltaAndroidOtaPayload,
  fullAndroidOtaPayload,
  unknownOperationAndroidOtaPayload,
  v1AndroidOtaPayload,
} from "./androidOtaPayload.fixture.js";

const parse = (bytes: Uint8Array) =>
  parseAndroidOtaPayload(bytes, bytes.length);

const header = (fields: {
  readonly version?: bigint;
  readonly manifestSize?: bigint;
  readonly metadataSignatureSize?: number;
  readonly length?: number;
}): Buffer => {
  const bytes = Buffer.alloc(fields.length ?? ANDROID_OTA_HEADER_V2_BYTES);
  bytes.write(ANDROID_OTA_MAGIC, 0, "latin1");
  if (bytes.length >= 12) bytes.writeBigUInt64BE(fields.version ?? 2n, 4);
  if (bytes.length >= 20) bytes.writeBigUInt64BE(fields.manifestSize ?? 0n, 12);
  if (bytes.length >= 24)
    bytes.writeUInt32BE(fields.metadataSignatureSize ?? 0, 20);
  return bytes;
};

it("recognizes CrAU v2 and refuses any other readable major version", () => {
  expect(recognizeAndroidOtaPayload(Buffer.from("nope"))).toBeUndefined();
  expect(recognizeAndroidOtaPayload(Buffer.from("CrAU"))).toEqual({
    state: "recognized",
  });
  expect(recognizeAndroidOtaPayload(header({}))).toEqual({
    state: "recognized",
  });
  expect(recognizeAndroidOtaPayload(header({ version: 1n }))).toEqual({
    state: "refused",
    reason: androidOtaUnsupportedVersion(1n),
  });
  expect(recognizeAndroidOtaPayload(header({ version: 3n }))).toEqual({
    state: "refused",
    reason: androidOtaUnsupportedVersion(3n),
  });
});

it("inventories a full payload with REPLACE, ZERO, dynamic groups and apex_info", () => {
  const bytes = fullAndroidOtaPayload();
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value).toMatchObject({
    header: { magic: "CrAU", majorVersion: 2 },
    payloadKind: "full",
    minorVersion: 0,
    blockSize: 4096,
    maxTimestamp: 1_700_000_000,
    partialUpdate: false,
    securityPatchLevel: "2024-01-05",
    snapshotEnabled: true,
    vabcEnabled: true,
    vabcCompressionParam: "gz",
    blobTruncated: false,
    metadataSignatureCount: 1,
    payloadSignatureCount: 1,
  });
  expect(parsed.value.partitions.map((partition) => partition.name)).toEqual([
    "boot",
    "system",
  ]);
  expect(parsed.value.partitions[0]).toMatchObject({
    extractable: true,
    filesystemType: "raw",
    operationCounts: [{ type: "REPLACE", type_code: 0, count: 1 }],
  });
  expect(parsed.value.partitions[1]).toMatchObject({
    extractable: true,
    runPostinstall: true,
    postinstallPath: "system/bin/otapreopt_script",
    mergeOperationCount: 2,
    estimateCowSize: 4096,
    operationCounts: [{ type: "ZERO", type_code: 6, count: 1 }],
  });
  expect(parsed.value.dynamicPartitionGroups).toEqual([
    { name: "super", size: 64 * 1024 * 1024, partitionNames: ["system"] },
  ]);
  expect(parsed.value.apexInfo).toEqual([
    {
      packageName: "com.android.runtime",
      version: 340090000,
      isCompressed: true,
      decompressedSize: 12_000_000,
    },
  ]);
  expect(parsed.value.limitations.join(" ")).toContain("not verified");
});

it("reconstructs REPLACE and ZERO partitions against the declared hash", () => {
  const bytes = fullAndroidOtaPayload();
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  const blob = bytes.subarray(parsed.value.header.blobOffset);
  for (const partition of parsed.value.partitions) {
    const reconstructed = reconstructAndroidOtaPartition(
      partition,
      parsed.value.blockSize,
      (offset, length) => blob.subarray(offset, offset + length),
    );
    if (!reconstructed.ok) throw reconstructed.error;
    expect(createHash("sha256").update(reconstructed.value).digest("hex")).toBe(
      partition.newPartitionInfo.hashHex,
    );
  }
});

it("inventories a delta payload without applying SOURCE_COPY or BROTLI_BSDIFF", () => {
  const parsed = parse(deltaAndroidOtaPayload());
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.payloadKind).toBe("delta");
  expect(parsed.value.minorVersion).toBe(4);
  expect(parsed.value.partitions[0]).toMatchObject({
    name: "vendor",
    extractable: false,
    oldPartitionInfo: { size: 4096 },
    operationCounts: [
      { type: "SOURCE_COPY", type_code: 4, count: 1 },
      { type: "BROTLI_BSDIFF", type_code: 10, count: 1 },
    ],
  });
  const reconstructed = reconstructAndroidOtaPartition(
    parsed.value.partitions[0]!,
    parsed.value.blockSize,
    () => new Uint8Array(),
  );
  expect(reconstructed).toMatchObject({
    ok: false,
    error: { _tag: "AndroidOtaPayloadUnsupportedOperation", typeCode: 4 },
  });
});

it("counts an unknown InstallOperation type as unknown", () => {
  const parsed = parse(unknownOperationAndroidOtaPayload());
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.partitions[0]?.operationCounts).toEqual([
    { type: "unknown", type_code: 99, count: 1 },
  ]);
});

it("reconstructs REPLACE_ZSTD payloads", () => {
  const plain = Buffer.from("zstd-partition-bytes");
  const bytes = buildAndroidOtaPayload({
    partitions: [
      {
        name: "vendor",
        operations: [
          {
            type: 14,
            data: zstdCompressSync(plain),
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
    ],
  });
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.partitions[0]?.extractable).toBe(true);
  const blob = bytes.subarray(parsed.value.header.blobOffset);
  const reconstructed = reconstructAndroidOtaPartition(
    parsed.value.partitions[0]!,
    parsed.value.blockSize,
    (offset, length) => blob.subarray(offset, offset + length),
  );
  if (!reconstructed.ok) throw reconstructed.error;
  expect(
    Buffer.from(reconstructed.value.subarray(0, plain.length)).equals(plain),
  ).toBe(true);
});

it("refuses REPLACE_ZSTD output past destination extents as a capacity limit", () => {
  const plain = Buffer.alloc(8192, 0x61);
  const bytes = buildAndroidOtaPayload({
    partitions: [
      {
        name: "vendor",
        newSize: 4096,
        operations: [
          {
            type: 14,
            data: zstdCompressSync(plain),
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
    ],
  });
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  const blob = bytes.subarray(parsed.value.header.blobOffset);
  expect(
    reconstructAndroidOtaPartition(
      parsed.value.partitions[0]!,
      parsed.value.blockSize,
      (offset, length) => blob.subarray(offset, offset + length),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      failure: { kind: "limit", limit: { maximum: 4096 } },
    },
  });
});

it("refuses distinct operation data past the read budget as a capacity limit", () => {
  expect(
    androidOtaDistinctOperationDataBytes([
      {
        typeCode: 0,
        typeName: "REPLACE",
        dataOffset: 0,
        dataLength: ANDROID_OTA_MAX_OPERATION_DATA_BYTES + 1,
        srcExtents: [],
        dstExtents: [{ startBlock: 0, numBlocks: 1 }],
      },
    ]),
  ).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: {
          maximum: ANDROID_OTA_MAX_OPERATION_DATA_BYTES,
        },
      },
    },
  });
});

it("refuses a v1 header as an unsupported version", () => {
  const bytes = v1AndroidOtaPayload();
  expect(recognizeAndroidOtaPayload(bytes)).toMatchObject({
    state: "refused",
    reason: androidOtaUnsupportedVersion(1n),
  });
  expect(parseAndroidOtaHeader(bytes, bytes.length)).toMatchObject({
    ok: false,
    error: {
      kind: "unsupported",
      failure: { field: "major_version" },
    },
  });
});

it("refuses a bad magic, truncated header, and a truncated manifest", () => {
  expect(parse(Buffer.from("XXXX"))).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
  expect(parse(header({ length: 12 }))).toMatchObject({
    ok: false,
    error: { kind: "truncated" },
  });
  const full = fullAndroidOtaPayload();
  const parsed = parse(full);
  if (!parsed.ok) throw parsed.error;
  const cut = full.subarray(
    0,
    parsed.value.header.manifestOffset +
      Math.min(8, parsed.value.header.manifestSize),
  );
  expect(parse(cut)).toMatchObject({
    ok: false,
    error: { kind: "truncated" },
  });
});

it("keeps a complete manifest when the blob is truncated", () => {
  const full = fullAndroidOtaPayload();
  const parsed = parse(full);
  if (!parsed.ok) throw parsed.error;
  const truncated = full.subarray(0, parsed.value.header.blobOffset + 1);
  const kept = parse(truncated);
  if (!kept.ok) throw kept.error;
  expect(kept.value.blobTruncated).toBe(true);
  expect(kept.value.partitions.map((partition) => partition.name)).toEqual([
    "boot",
    "system",
  ]);
  expect(kept.value.partitions[0]?.extractable).toBe(false);
  expect(kept.value.partitions[0]?.extractRefusal).toBe("blob_truncated");
  expect(kept.value.limitations.join(" ")).toContain("truncated");
  expect(
    reconstructAndroidOtaPartition(
      kept.value.partitions[0]!,
      kept.value.blockSize,
      () => new Uint8Array(),
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AndroidOtaPayloadBlobTruncated" },
  });
});

it("names the extraction ceiling, not unsupported operations, for a large REPLACE partition", () => {
  const blockSize = 4096;
  const newSize = ANDROID_OTA_MAX_EXTRACT_BYTES + blockSize;
  const parsed = parse(
    buildAndroidOtaPayload({
      blockSize,
      partitions: [
        {
          name: "super",
          newSize,
          operations: [
            {
              type: 0,
              data: Buffer.from("SUPER"),
              dstExtents: [{ startBlock: 0, numBlocks: newSize / blockSize }],
            },
          ],
        },
      ],
    }),
  );
  if (!parsed.ok) throw parsed.error;
  const [partition] = parsed.value.partitions;
  expect(partition).toMatchObject({
    extractable: false,
    extractRefusal: "size_limit",
  });
  expect(parsed.value.limitations).toContain(
    ANDROID_OTA_PAYLOAD_LIMITATIONS.partitionSizeLimit,
  );
  expect(parsed.value.limitations).not.toContain(
    ANDROID_OTA_PAYLOAD_LIMITATIONS.unsupportedOperations,
  );
  expect(
    reconstructAndroidOtaPartition(partition!, blockSize, () => {
      throw new Error("a refused partition reads no operation data");
    }),
  ).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_EXTRACT_BYTES },
      },
    },
  });
});

it("refuses operation data that overruns the payload blob", () => {
  const bytes = buildAndroidOtaPayload({
    partitions: [
      {
        name: "boot",
        operations: [
          {
            type: 0,
            dataOffset: 50,
            dataLength: 10,
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
    ],
  });
  expect(parse(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("refuses an explicit zero manifest block_size as malformed", () => {
  const bytes = buildAndroidOtaPayload({
    blockSize: 0,
    partitions: [],
  });
  expect(parse(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("refuses a truncated protobuf field in the manifest", () => {
  const writer = new BinaryWriter();
  writer.tag(13, WireType.LengthDelimited).bytes(Uint8Array.of(0x80));
  const manifest = writer.finish();
  const bytes = Buffer.concat([
    header({ manifestSize: BigInt(manifest.length) }),
    Buffer.from(manifest),
  ]);
  expect(parse(bytes)).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("refuses an oversize manifest and metadata signature as capacity limits", () => {
  expect(
    parseAndroidOtaHeader(
      header({ manifestSize: BigInt(ANDROID_OTA_MAX_MANIFEST_BYTES + 1) }),
      ANDROID_OTA_HEADER_V2_BYTES,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_MANIFEST_BYTES },
      },
    },
  });
  expect(
    parseAndroidOtaHeader(
      header({ metadataSignatureSize: ANDROID_OTA_MAX_SIGNATURE_BYTES + 1 }),
      ANDROID_OTA_HEADER_V2_BYTES,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_SIGNATURE_BYTES },
      },
    },
  });
});

it("refuses an oversize manifest signatures_size before any signature read", () => {
  const bytes = buildAndroidOtaPayload({
    partitions: [],
    signaturesSize: ANDROID_OTA_MAX_SIGNATURE_BYTES + 1,
  });
  expect(parse(bytes)).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_SIGNATURE_BYTES },
      },
    },
  });
});

it("refuses manifest extents past the total extent budget as a capacity limit", () => {
  const extents = new Uint8Array((ANDROID_OTA_MAX_EXTENTS_TOTAL + 1) * 2);
  for (let at = 0; at < extents.length; at += 2) extents[at] = 0x32;
  const operation = new BinaryWriter()
    .tag(1, WireType.Varint)
    .int32(0)
    .finish();
  const partition = new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .string("system")
    .tag(8, WireType.LengthDelimited)
    .bytes(Buffer.concat([operation, extents]))
    .finish();
  const manifest = new BinaryWriter()
    .tag(13, WireType.LengthDelimited)
    .bytes(partition)
    .finish();
  const bytes = Buffer.concat([
    header({ manifestSize: BigInt(manifest.length) }),
    Buffer.from(manifest),
  ]);
  expect(parse(bytes)).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_EXTENTS_TOTAL },
      },
    },
  });
});

it("refuses group partition names past the manifest-wide budget as a capacity limit", () => {
  const group = (names: number) => {
    const writer = new BinaryWriter()
      .tag(1, WireType.LengthDelimited)
      .string("super");
    for (let index = 0; index < names; index += 1)
      writer.tag(3, WireType.LengthDelimited).string("");
    return writer.finish();
  };
  const half = ANDROID_OTA_MAX_GROUP_PARTITION_NAMES / 2;
  const metadata = new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .bytes(group(half))
    .tag(1, WireType.LengthDelimited)
    .bytes(group(half + 1))
    .finish();
  const manifest = new BinaryWriter()
    .tag(15, WireType.LengthDelimited)
    .bytes(metadata)
    .finish();
  const bytes = Buffer.concat([
    header({ manifestSize: BigInt(manifest.length) }),
    Buffer.from(manifest),
  ]);
  expect(parse(bytes)).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_GROUP_PARTITION_NAMES },
      },
    },
  });
});

it("reports a reconstructed hash mismatch without inventing a matching digest", () => {
  const bytes = buildAndroidOtaPayload({
    partitions: [
      {
        name: "boot",
        newHash: Buffer.alloc(32, 0xff),
        operations: [{ type: 0, data: Buffer.from("BOOT") }],
      },
    ],
  });
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  const blob = bytes.subarray(parsed.value.header.blobOffset);
  expect(
    reconstructAndroidOtaPartition(
      parsed.value.partitions[0]!,
      parsed.value.blockSize,
      (offset, length) => blob.subarray(offset, offset + length),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AndroidOtaPayloadIntegrityFailure",
      declaredHashHex: "ff".repeat(32),
    },
  });
});

it("charges repeated operations on one blob against the reconstruction budget", () => {
  const blockSize = 4096;
  const bytes = buildAndroidOtaPayload({
    blockSize,
    partitions: [
      {
        name: "boot",
        newSize: blockSize,
        operations: [
          {
            type: 0,
            data: Buffer.from("BOOT"),
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
    ],
  });
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  const [partition] = parsed.value.partitions;
  const [operation] = partition!.operations;
  const repeats = ANDROID_OTA_MAX_EXTRACT_BYTES / blockSize + 1;
  expect(
    reconstructAndroidOtaPartition(
      {
        ...partition!,
        operations: Array.from({ length: repeats }, () => operation!),
      },
      blockSize,
      () => {
        throw new Error("an over-budget partition reads no operation data");
      },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      failure: {
        kind: "limit",
        limit: { maximum: ANDROID_OTA_MAX_EXTRACT_BYTES },
      },
    },
  });
});

it("refuses destination extents outside the image and short operation data", () => {
  const blockSize = 4096;
  const reconstruct = (
    dstExtents: readonly { startBlock: number; numBlocks: number }[],
    data: Buffer,
  ) => {
    const bytes = buildAndroidOtaPayload({
      blockSize,
      partitions: [
        {
          name: "boot",
          newSize: blockSize,
          operations: [{ type: 0, data, dstExtents }],
        },
      ],
    });
    const parsed = parse(bytes);
    if (!parsed.ok) throw parsed.error;
    const blob = bytes.subarray(parsed.value.header.blobOffset);
    return reconstructAndroidOtaPartition(
      parsed.value.partitions[0]!,
      blockSize,
      (offset, length) => blob.subarray(offset, offset + length),
      { verifyDeclaredHash: false },
    );
  };
  const refused = {
    ok: false,
    error: { kind: "malformed" },
  };
  expect(
    reconstruct(
      [{ startBlock: 1, numBlocks: 1 }],
      Buffer.alloc(blockSize, 0x41),
    ),
  ).toMatchObject(refused);
  expect(
    reconstruct(
      [{ startBlock: 0, numBlocks: 2 }],
      Buffer.alloc(blockSize * 2, 0x41),
    ),
  ).toMatchObject(refused);
  expect(
    reconstruct([{ startBlock: 0, numBlocks: 1 }], Buffer.from("BOOT")),
  ).toMatchObject(refused);
  expect(
    reconstruct(
      [{ startBlock: 0, numBlocks: 1 }],
      Buffer.alloc(blockSize, 0x41),
    ),
  ).toMatchObject({ ok: true });
});

it("refuses reconstruction when destination extents leave blocks unwritten", () => {
  const blockSize = 4096;
  const bytes = buildAndroidOtaPayload({
    blockSize,
    partitions: [
      {
        name: "boot",
        newSize: blockSize * 2,
        operations: [
          {
            type: 0,
            data: Buffer.alloc(blockSize, 0x41),
            dstExtents: [{ startBlock: 0, numBlocks: 1 }],
          },
        ],
      },
    ],
  });
  const parsed = parse(bytes);
  if (!parsed.ok) throw parsed.error;
  const blob = bytes.subarray(parsed.value.header.blobOffset);
  expect(
    reconstructAndroidOtaPartition(
      parsed.value.partitions[0]!,
      blockSize,
      (offset, length) => blob.subarray(offset, offset + length),
      { verifyDeclaredHash: false },
    ),
  ).toMatchObject({
    ok: false,
    error: { kind: "malformed" },
  });
});

it("names duplicate partitions with a per-name suffix that skips taken names", () => {
  const parsed = parse(
    buildAndroidOtaPayload({
      partitions: ["boot", "boot-2", "boot", "boot", "boot"].map((name) => ({
        name,
        operations: [],
      })),
    }),
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.partitions.map((partition) => partition.path)).toEqual([
    "boot.img",
    "boot-2.img",
    "boot-1.img",
    "boot-3.img",
    "boot-4.img",
  ]);
});

it("keeps duplicate partition naming linear at the partition count limit", () => {
  const name = "d".repeat(1024);
  const bytes = buildAndroidOtaPayload({
    partitions: Array.from({ length: ANDROID_OTA_MAX_PARTITIONS }, () => ({
      name,
      operations: [],
    })),
  });
  const started = performance.now();
  const parsed = parse(bytes);
  // This parse takes tens of milliseconds; restarting the suffix search at 1
  // for every collision took over 4 seconds.
  expect(performance.now() - started).toBeLessThan(1000);
  if (!parsed.ok) throw parsed.error;
  const paths = parsed.value.partitions.map((partition) => partition.path);
  expect(new Set(paths).size).toBe(ANDROID_OTA_MAX_PARTITIONS);
  expect(paths.at(-1)).toBe(
    `${name}-${String(ANDROID_OTA_MAX_PARTITIONS - 1)}.img`,
  );
});

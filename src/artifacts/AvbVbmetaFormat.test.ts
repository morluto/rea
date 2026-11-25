import { expect, it } from "vitest";

import {
  buildVbmetaImage,
  buildVbmetaImageWithAllDescriptors,
  chainPartitionDescriptor,
  encodeDescriptor,
  hashDescriptor,
  hashtreeDescriptor,
  kernelCmdlineDescriptor,
  propertyDescriptor,
} from "../../tests/fixtures/avbVbmeta.js";
import { parseAvbVbmetaImage } from "./AndroidBootImageFormat.js";

const parsed = (bytes: Buffer, fileSize = bytes.length) => {
  const result = parseAvbVbmetaImage(bytes, fileSize);
  if (!result.ok)
    throw new Error(result.error.message, { cause: result.error });
  return result.value;
};

const failed = (bytes: Buffer, fileSize = bytes.length) => {
  const result = parseAvbVbmetaImage(bytes, fileSize);
  if (result.ok) throw new Error("Expected the vbmeta image to be refused");
  return result.error;
};

const patchU64 = (bytes: Buffer, offset: number, value: bigint): Buffer => {
  const copy = Buffer.from(bytes);
  copy.writeBigUInt64BE(value, offset);
  return copy;
};

const patchU32 = (bytes: Buffer, offset: number, value: number): Buffer => {
  const copy = Buffer.from(bytes);
  copy.writeUInt32BE(value, offset);
  return copy;
};

it("decodes the v1.x header, block bounds, and release string", () => {
  const facts = parsed(buildVbmetaImageWithAllDescriptors());
  expect(facts).toMatchObject({
    magic: "AVB0",
    requiredLibavbVersionMajor: 1,
    requiredLibavbVersionMinor: 2,
    algorithmType: 1,
    algorithmTypeName: "sha256-rsa2048",
    hashOffset: 0,
    hashSize: 32,
    signatureOffset: 32,
    signatureSize: 256,
    publicKeyOffset: 0,
    publicKeySize: 64,
    rollbackIndex: 7,
    flags: 0,
    flagNames: [],
    rollbackIndexLocation: 2,
    releaseString: "avbtool 1.2.0",
  });
  expect(facts.descriptors).toHaveLength(5);
  expect(facts.authenticationDataBlockSize).toBe(320);
  expect(facts.auxiliaryDataBlockSize % 64).toBe(0);
  expect(facts.imageSize).toBe(
    256 + facts.authenticationDataBlockSize + facts.auxiliaryDataBlockSize,
  );
  expect(facts.trailingBytes).toBe(0);
  expect(facts.limitations.join(" ")).toContain("not verified");
});

it("decodes a property descriptor key and value", () => {
  const facts = parsed(
    buildVbmetaImage({
      descriptors: [
        propertyDescriptor("com.android.build.fingerprint", "test-fingerprint"),
      ],
    }),
  );
  expect(facts.descriptors).toHaveLength(1);
  expect(facts.descriptors[0]).toMatchObject({
    kind: "property",
    tag: 0,
    tagName: "property",
    key: "com.android.build.fingerprint",
    value: "test-fingerprint",
  });
});

it("decodes hashtree, hash, kernel cmdline, and chain partition descriptors", () => {
  const facts = parsed(buildVbmetaImageWithAllDescriptors());
  const [property, hashtree, hash, cmdline, chain] = facts.descriptors;
  expect(property?.kind).toBe("property");
  expect(hashtree).toMatchObject({
    kind: "hashtree",
    tag: 1,
    dmVerityVersion: 1,
    imageSize: 4096,
    treeOffset: 4096,
    treeSize: 4096,
    dataBlockSize: 4096,
    hashBlockSize: 4096,
    hashAlgorithm: "sha256",
    partitionName: "system",
    saltHex: Buffer.from("salt").toString("hex"),
    rootDigestHex: Buffer.alloc(32, 0xab).toString("hex"),
  });
  expect(hash).toMatchObject({
    kind: "hash",
    tag: 2,
    imageSize: 2048,
    hashAlgorithm: "sha256",
    partitionName: "boot",
    saltHex: Buffer.from("salt").toString("hex"),
    digestHex: Buffer.alloc(32, 0xcd).toString("hex"),
  });
  expect(cmdline).toMatchObject({
    kind: "kernel-cmdline",
    tag: 3,
    cmdline: "androidboot.veritymode=enforcing",
  });
  expect(chain).toMatchObject({
    kind: "chain-partition",
    tag: 4,
    rollbackIndexLocation: 0,
    partitionName: "vbmeta_system",
    publicKeySize: 64,
    publicKeyHex: Buffer.alloc(64, 0x11).toString("hex"),
  });
});

it("keeps unknown descriptor tags as undecoded entries", () => {
  const facts = parsed(
    buildVbmetaImage({
      descriptors: [{ tag: 99, body: Buffer.alloc(8) }],
    }),
  );
  expect(facts.descriptors).toHaveLength(1);
  expect(facts.descriptors[0]).toMatchObject({
    kind: "unknown",
    tag: 99,
    tagName: "unknown",
  });
  expect(facts.limitations.join(" ")).toContain("unrecognized tag 99");
});

it("refuses a non-AVB0 magic", () => {
  const bytes = Buffer.from(buildVbmetaImageWithAllDescriptors());
  bytes.write("NOPE", 0, "ascii");
  expect(failed(bytes).failure.kind).toBe("malformed");
});

it("refuses a truncated header", () => {
  const image = buildVbmetaImageWithAllDescriptors();
  expect(failed(image.subarray(0, 100), 100).failure.kind).toBe("truncated");
});

it("refuses an image truncated inside its declared blocks", () => {
  const image = buildVbmetaImageWithAllDescriptors();
  const cut = image.subarray(0, image.length - 64);
  expect(failed(cut).failure.kind).toBe("truncated");
});

it("refuses a libavb major version other than 1", () => {
  const image = patchU32(buildVbmetaImageWithAllDescriptors(), 4, 2);
  const error = failed(image);
  expect(error.failure.kind).toBe("unsupported");
  expect(error.message).toContain("required libavb version 2.2");
});

it("refuses hash and signature ranges that overlap", () => {
  const image = buildVbmetaImage({
    hash: Buffer.alloc(32, 0xaa),
    signature: Buffer.alloc(256, 0xbb),
  });
  // Move the signature to the hash offset so the two ranges overlap.
  const overlapped = patchU64(image, 48, 0n);
  expect(failed(overlapped).failure.kind).toBe("malformed");
});

it("refuses a descriptor table overlapping the public key", () => {
  const image = buildVbmetaImage({
    publicKey: Buffer.alloc(64, 0xcc),
    descriptors: [propertyDescriptor("k", "v")],
  });
  // Move the descriptor table to the start of the auxiliary block.
  const overlapped = patchU64(image, 96, 0n);
  expect(failed(overlapped).failure.kind).toBe("malformed");
});

it("refuses a descriptor whose size overruns the table", () => {
  const descriptor = encodeDescriptor(propertyDescriptor("k", "v"));
  const image = buildVbmetaImage({
    descriptors: [{ tag: 0, body: descriptor.subarray(16) }],
  });
  // Inflate num_bytes_following past the end of the descriptor table.
  // No hash or signature: the authentication block is empty, so the table
  // starts right after the 256-byte header.
  const tableStart = 256;
  const inflated = patchU64(image, tableStart + 8, 1_000_000n);
  expect(failed(inflated).failure.kind).toBe("truncated");
});

it("refuses a descriptor whose size is not a multiple of 8", () => {
  const image = buildVbmetaImage({
    descriptors: [propertyDescriptor("k", "v")],
  });
  const tableStart = 256;
  const odd = patchU64(image, tableStart + 8, 7n);
  expect(failed(odd).failure.kind).toBe("malformed");
});

it("reports trailing bytes after the declared image as a limitation", () => {
  const image = buildVbmetaImageWithAllDescriptors();
  const trailed = Buffer.concat([image, Buffer.alloc(16, 0xee)]);
  const facts = parsed(trailed);
  expect(facts.trailingBytes).toBe(16);
  expect(facts.limitations.join(" ")).toContain(
    "16 trailing bytes follow the vbmeta image",
  );
});

it("names a trailing AVBf footer instead of decoding it", () => {
  const image = buildVbmetaImageWithAllDescriptors();
  const footer = Buffer.alloc(64);
  footer.write("AVBf", 0, "ascii");
  const facts = parsed(Buffer.concat([image, footer]));
  expect(facts.trailingBytes).toBe(64);
  expect(facts.limitations.join(" ")).toContain("AVBf footer");
});

it("names known flags and flags unknown bits as a limitation", () => {
  const facts = parsed(buildVbmetaImage({ flags: 0b101 }));
  expect(facts.flagNames).toEqual(["hashtree-disabled"]);
  expect(facts.limitations.join(" ")).toContain("unrecognized bits 0x4");
});

it("names an unknown algorithm type instead of interpreting it", () => {
  const facts = parsed(buildVbmetaImage({ algorithmType: 42 }));
  expect(facts.algorithmTypeName).toBe("unknown");
  expect(facts.limitations.join(" ")).toContain("Algorithm type 42");
});

it("keeps descriptor entry offsets usable for extraction", () => {
  const facts = parsed(buildVbmetaImageWithAllDescriptors());
  const offsets = facts.descriptors.map((descriptor) => descriptor.offset);
  expect(offsets[0]).toBeGreaterThan(256);
  for (let index = 1; index < offsets.length; index += 1)
    expect(offsets[index]).toBeGreaterThan(offsets[index - 1]!);
  for (const descriptor of facts.descriptors)
    expect(descriptor.offset + descriptor.size).toBeLessThanOrEqual(
      facts.imageSize,
    );
});

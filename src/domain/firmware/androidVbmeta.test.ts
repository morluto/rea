import { expect, it } from "vitest";

import { androidVbmetaMetadataSchema } from "../artifactFormatMetadata.js";
import {
  DEFAULT_ANDROID_VBMETA_READER_LIMITS,
  type AndroidVbmetaReaderLimits,
} from "../artifactReaderLimits.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import {
  ANDROID_VBMETA_LIMITATIONS,
  AVB_DESCRIPTOR_TAG,
  AVB_HEADER_FLAG,
  AVB_UNKNOWN_TAGS_NAMED,
  androidVbmetaHostBounds,
  parseAndroidVbmeta,
  type AndroidVbmetaImage,
} from "./androidVbmeta.js";
import {
  SAMPLE_CHAIN_PARTITION,
  SAMPLE_CMDLINE,
  SAMPLE_HASH_DIGEST,
  SAMPLE_HASH_PARTITION,
  SAMPLE_HASH_SALT,
  SAMPLE_HASHTREE_DIGEST,
  SAMPLE_HASHTREE_PARTITION,
  SAMPLE_HASHTREE_SALT,
  SAMPLE_PROPERTY_KEY,
  SAMPLE_PROPERTY_VALUE,
  SAMPLE_PUBLIC_KEY,
  SAMPLE_PUBLIC_KEY_METADATA,
  SAMPLE_RELEASE,
  SAMPLE_UNKNOWN_TAG,
  ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
  androidVbmetaDescriptor,
  androidVbmetaDescriptorCountOverflow,
  androidVbmetaHeader,
  androidVbmetaMalformedLaterDescriptor,
  androidVbmetaRefusals,
  buildAndroidVbmeta,
  sampleAndroidVbmeta,
} from "./androidVbmeta.fixture.js";

const parsed = (bytes: Buffer, fileSize = bytes.length): AndroidVbmetaImage => {
  const result = parseAndroidVbmeta(bytes, fileSize);
  if (!result.ok) throw result.error;
  return result.value;
};

const DEFAULTS = DEFAULT_ANDROID_VBMETA_READER_LIMITS;

const failed = (
  bytes: Buffer,
  fileSize = bytes.length,
  limits: AndroidVbmetaReaderLimits = DEFAULTS,
) => {
  const result = parseAndroidVbmeta(bytes, fileSize, limits);
  if (result.ok) throw new Error("expected the vbmeta image to be refused");
  return result.error;
};

/** A decoded image whose descriptor walk stopped on a malformed descriptor. */
const stopped = (bytes: Buffer) => {
  const image = parsed(bytes);
  const failure = image.metadata.descriptor_failure;
  if (failure === null) throw new Error("expected the descriptor walk to stop");
  return { image, failure };
};

const descriptorHeaders = (
  bytes: Buffer,
): { tag: number; offset: number; following: number }[] => {
  const authentication = Number(bytes.readBigUInt64BE(12));
  const descriptorsOffset = Number(bytes.readBigUInt64BE(96));
  const descriptorsSize = Number(bytes.readBigUInt64BE(104));
  const start = 256 + authentication + descriptorsOffset;
  const table = bytes.subarray(start, start + descriptorsSize);
  const headers = [];
  let cursor = 0;
  while (cursor + 16 <= table.length) {
    const following = Number(table.readBigUInt64BE(cursor + 8));
    headers.push({
      tag: Number(table.readBigUInt64BE(cursor)),
      offset: start + cursor,
      following,
    });
    cursor += 16 + following;
  }
  return headers;
};

const sampleMetadata = (bytes: Buffer) => {
  const image = parsed(bytes);
  return {
    image,
    metadata: androidVbmetaMetadataSchema.parse({
      kind: "android-vbmeta",
      ...image.metadata,
    }),
  };
};

it("decodes the header, names the disabled flags, and exposes stored ranges", () => {
  const bytes = sampleAndroidVbmeta();
  expect(bytes.subarray(0, 4).toString("ascii")).toBe("AVB0");
  expect(bytes.readUInt32BE(4)).toBe(1);
  expect(bytes.readUInt32BE(8)).toBe(0);
  expect(bytes.readUInt32BE(28)).toBe(1);
  expect(bytes.readBigUInt64BE(112)).toBe(42n);
  expect(bytes.readUInt32BE(120)).toBe(3);
  expect(bytes.readUInt32BE(124)).toBe(0);
  expect(
    bytes.subarray(128, 128 + SAMPLE_RELEASE.length).toString("utf8"),
  ).toBe(SAMPLE_RELEASE);
  expect(bytes[128 + SAMPLE_RELEASE.length]).toBe(0);
  expect(bytes.subarray(256, 256 + 32).equals(Buffer.alloc(32, 0x11))).toBe(
    true,
  );

  const { image, metadata } = sampleMetadata(bytes);
  expect(metadata.descriptor_failure).toBeNull();
  expect(metadata).toMatchObject({
    magic: "AVB0",
    required_libavb_version_major: 1,
    required_libavb_version_minor: 0,
    algorithm_type: 1,
    algorithm_name: "SHA256_RSA2048",
    hash_offset: 0,
    hash_size: 32,
    signature_offset: 32,
    signature_size: 256,
    public_key_offset: 0,
    public_key_size: SAMPLE_PUBLIC_KEY.length,
    public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
    public_key_metadata_offset: SAMPLE_PUBLIC_KEY.length,
    public_key_metadata_size: SAMPLE_PUBLIC_KEY_METADATA.length,
    rollback_index: "42",
    rollback_index_location: 0,
    flags:
      AVB_HEADER_FLAG.HASHTREE_DISABLED | AVB_HEADER_FLAG.VERIFICATION_DISABLED,
    flag_names: ["HASHTREE_DISABLED", "VERIFICATION_DISABLED"],
    release_string: SAMPLE_RELEASE,
    trailing_bytes: 4,
    signatures_verified: false,
  });
  expect(metadata.release_string_bytes_hex).toHaveLength(96);
  expect(metadata.authentication_data_block_size % 64).toBe(0);
  expect(metadata.auxiliary_data_block_size % 64).toBe(0);
  expect(image.imageSize).toBe(
    256 +
      metadata.authentication_data_block_size +
      metadata.auxiliary_data_block_size,
  );
  expect(bytes.length - image.imageSize).toBe(4);

  const auxiliary = 256 + metadata.authentication_data_block_size;
  expect(
    bytes
      .subarray(auxiliary, auxiliary + SAMPLE_PUBLIC_KEY.length)
      .equals(SAMPLE_PUBLIC_KEY),
  ).toBe(true);
  expect(image.children).toEqual([
    {
      path: "authentication_block",
      role: "authentication-block",
      offset: 256,
      size: metadata.authentication_data_block_size,
    },
    {
      path: "public_key",
      role: "public-key",
      offset: auxiliary,
      size: SAMPLE_PUBLIC_KEY.length,
    },
    {
      path: "public_key_metadata",
      role: "public-key-metadata",
      offset: auxiliary + SAMPLE_PUBLIC_KEY.length,
      size: SAMPLE_PUBLIC_KEY_METADATA.length,
    },
  ]);
  expect(image.limitations).toContain(ANDROID_VBMETA_LIMITATIONS.unverified);
  expect(image.limitations).toContain(ANDROID_VBMETA_LIMITATIONS.untrusted);
});

it("decodes one of each descriptor and retains an unknown tag", () => {
  const bytes = sampleAndroidVbmeta();
  const { image, metadata } = sampleMetadata(bytes);
  const headers = descriptorHeaders(bytes);
  expect(
    metadata.descriptors.map(({ tag, offset, num_bytes_following }) => ({
      tag: Number(tag),
      offset,
      following: num_bytes_following,
    })),
  ).toEqual(headers);
  expect(headers.map(({ tag }) => tag)).toEqual([
    AVB_DESCRIPTOR_TAG.PROPERTY,
    AVB_DESCRIPTOR_TAG.HASHTREE,
    AVB_DESCRIPTOR_TAG.HASH,
    AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE,
    AVB_DESCRIPTOR_TAG.CHAIN_PARTITION,
    SAMPLE_UNKNOWN_TAG,
  ]);

  expect(metadata.descriptors[0]).toMatchObject({
    tag_name: "PROPERTY",
    key: SAMPLE_PROPERTY_KEY,
    value: SAMPLE_PROPERTY_VALUE,
  });
  const property = metadata.descriptors[0]!;
  if (property.tag_name !== "PROPERTY") throw new Error("property");
  expect(
    bytes
      .subarray(
        property.offset + 32,
        property.offset + 32 + SAMPLE_PROPERTY_KEY.length,
      )
      .toString("utf8"),
  ).toBe(SAMPLE_PROPERTY_KEY);

  expect(metadata.descriptors[1]).toMatchObject({
    tag_name: "HASHTREE",
    partition_name: SAMPLE_HASHTREE_PARTITION,
    dm_verity_version: 1,
    image_size: "409600",
    tree_offset: "409600",
    tree_size: "4096",
    data_block_size: 4_096,
    hash_block_size: 4_096,
    fec_num_roots: 2,
    fec_offset: "413696",
    fec_size: "4096",
    hash_algorithm: "sha256",
    salt_hex: SAMPLE_HASHTREE_SALT.toString("hex"),
    root_digest_hex: SAMPLE_HASHTREE_DIGEST.toString("hex"),
    flags: 1,
    flag_names: ["DO_NOT_USE_AB"],
  });
  expect(metadata.descriptors[2]).toMatchObject({
    tag_name: "HASH",
    partition_name: SAMPLE_HASH_PARTITION,
    image_size: "32768",
    hash_algorithm: "sha256",
    salt_hex: SAMPLE_HASH_SALT.toString("hex"),
    digest_hex: SAMPLE_HASH_DIGEST.toString("hex"),
    flags: 0,
    flag_names: [],
  });
  expect(metadata.descriptors[3]).toMatchObject({
    tag_name: "KERNEL_CMDLINE",
    flags: 1,
    flag_names: ["USE_ONLY_IF_HASHTREE_NOT_DISABLED"],
    cmdline: SAMPLE_CMDLINE,
  });
  expect(metadata.descriptors[4]).toMatchObject({
    tag_name: "CHAIN_PARTITION",
    rollback_index_location: 2,
    partition_name: SAMPLE_CHAIN_PARTITION,
    public_key_size: SAMPLE_PUBLIC_KEY.length,
    public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
    flags: 1,
    flag_names: ["DO_NOT_USE_AB"],
  });
  expect(metadata.descriptors[5]).toMatchObject({
    tag_name: "UNKNOWN",
    tag: String(SAMPLE_UNKNOWN_TAG),
    offset: headers[5]!.offset,
    num_bytes_following: 8,
  });
  expect(image.limitations).toContain(
    `1 descriptor with an unknown AVB tag (${String(SAMPLE_UNKNOWN_TAG)}) is retained with its tag, size, and file offset.`,
  );
});

it("keeps full-width rollback indexes and descriptor tags as decimal strings", () => {
  const maxU64 = 0xffff_ffff_ffff_ffffn;
  const unsafe = 2n ** 53n;
  const image = parsed(
    buildAndroidVbmeta({
      header: { rollbackIndex: unsafe },
      descriptorBytes: Buffer.concat([
        androidVbmetaDescriptor(maxU64, Buffer.alloc(8)),
        androidVbmetaDescriptor(
          AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE,
          Buffer.alloc(8),
        ),
      ]),
    }),
  );
  const metadata = androidVbmetaMetadataSchema.parse({
    kind: "android-vbmeta",
    ...image.metadata,
  });
  expect(metadata.rollback_index).toBe("9007199254740992");
  expect(metadata.descriptors.map(({ tag_name }) => tag_name)).toEqual([
    "UNKNOWN",
    "KERNEL_CMDLINE",
  ]);
  expect(metadata.descriptors[0]).toMatchObject({
    tag: "18446744073709551615",
    num_bytes_following: 8,
  });
});

it("reports every unknown descriptor in one bounded limitation", () => {
  const tags = Array.from(
    { length: AVB_UNKNOWN_TAGS_NAMED + 3 },
    (_, index) => 100 + index,
  );
  const descriptors = [...tags, ...tags].map((tag) =>
    androidVbmetaDescriptor(tag, Buffer.alloc(0)),
  );
  const image = parsed(
    buildAndroidVbmeta({ descriptorBytes: Buffer.concat(descriptors) }),
  );
  expect(image.metadata.descriptors).toHaveLength(tags.length * 2);
  const unknown = image.limitations.filter((line) =>
    line.includes("unknown AVB tags"),
  );
  expect(unknown).toEqual([
    `${String(tags.length * 2)} descriptors with unknown AVB tags (${tags
      .slice(0, AVB_UNKNOWN_TAGS_NAMED)
      .join(
        ", ",
      )}, and 3 more) are retained with their tag, size, and file offset.`,
  ]);
  expect(image.limitations.join(" ")).not.toMatch(/offset \d/u);
});

it("keeps an empty image, an unaligned public key, and unknown flag bits", () => {
  const empty = parsed(buildAndroidVbmeta());
  expect(empty.metadata).toMatchObject({
    algorithm_name: "NONE",
    authentication_data_block_size: 0,
    auxiliary_data_block_size: 0,
    public_key_sha256: null,
    release_string: "",
    flag_names: [],
    descriptors: [],
    trailing_bytes: 0,
    signatures_verified: false,
  });
  expect(empty.children).toEqual([]);

  const key = Buffer.from([0x01]);
  const unaligned = parsed(
    buildAndroidVbmeta({
      publicKey: key,
      descriptorBytes: androidVbmetaDescriptor(
        SAMPLE_UNKNOWN_TAG,
        Buffer.alloc(0),
      ),
    }),
  );
  expect(unaligned.metadata.descriptors_offset).toBe(1);
  expect(unaligned.metadata.public_key_sha256).toBe(sha256Hex(key));
  expect(unaligned.metadata.descriptors).toHaveLength(1);

  const flagged = parsed(
    buildAndroidVbmeta({ header: { flags: 0x8000_0003 } }),
  );
  expect(flagged.metadata.flag_names).toEqual([
    "HASHTREE_DISABLED",
    "VERIFICATION_DISABLED",
    "0x80000000",
  ]);
});

it("retains unknown algorithms, other majors, reserved bytes, and invalid text", () => {
  const unknown = parsed(buildAndroidVbmeta({ header: { algorithmType: 99 } }));
  expect(unknown.metadata.algorithm_name).toBe("UNKNOWN");
  expect(unknown.metadata.algorithm_type).toBe(99);
  expect(unknown.limitations.join(" ")).toContain("Algorithm type 99");

  const major = parsed(buildAndroidVbmeta({ header: { major: 2, minor: 3 } }));
  expect(major.metadata.required_libavb_version_major).toBe(2);
  expect(major.limitations).toContain(
    "Required libavb version 2.3 is not a supported major version. Its header, descriptors, and child ranges were decoded with the version-1 layout as an assumption and are unconfirmed.",
  );
  const supported = parsed(buildAndroidVbmeta({ header: { minor: 3 } }));
  expect(supported.limitations.join(" ")).not.toContain("assumption");

  const reserved = parsed(
    buildAndroidVbmeta({ header: { reserved: Buffer.from([1]) } }),
  );
  expect(reserved.limitations).toContain(
    "The header reserved field contains non-zero bytes.",
  );

  const release = Buffer.alloc(48, 0);
  release[0] = 0xff;
  const text = parsed(buildAndroidVbmeta({ header: { release } }));
  expect(text.metadata.release_string).toBeNull();
  expect(text.metadata.release_string_bytes_hex.startsWith("ff")).toBe(true);

  const value = Buffer.from([0xff]);
  const key = Buffer.from("k");
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(key.length), 0);
  lengths.writeBigUInt64BE(BigInt(value.length), 8);
  const property = parsed(
    buildAndroidVbmeta({
      descriptorBytes: androidVbmetaDescriptor(
        AVB_DESCRIPTOR_TAG.PROPERTY,
        Buffer.concat([
          lengths,
          key,
          Buffer.from([0]),
          value,
          Buffer.from([0]),
        ]),
      ),
    }),
  );
  expect(property.metadata.descriptors[0]).toMatchObject({
    tag_name: "PROPERTY",
    key: "k",
    value: null,
    value_bytes_hex: "ff",
  });
});

it("admits a descriptor table past the default count when the caller raises it", () => {
  const bytes = androidVbmetaDescriptorCountOverflow();
  expect(bytes.length).toBe(65_856);
  const refused = failed(bytes);
  expect(refused.failure).toMatchObject({
    kind: "limit",
    field: "descriptors",
    limit: {
      name: "Android vbmeta descriptor count",
      maximum: DEFAULTS.descriptor_count,
      required: ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
    },
  });
  const raised = parseAndroidVbmeta(bytes, bytes.length, {
    ...DEFAULTS,
    descriptor_count: ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
  });
  if (!raised.ok) throw raised.error;
  expect(raised.value.metadata.descriptors).toHaveLength(
    ANDROID_VBMETA_OVERFLOW_DESCRIPTORS,
  );
  expect(raised.value.metadata.descriptor_failure).toBeNull();

  const header = androidVbmetaHeader({
    authenticationDataBlockSize: DEFAULTS.authentication_block_bytes + 64,
  });
  expect(failed(header).failure).toMatchObject({
    kind: "limit",
    limit: { required: BigInt(DEFAULTS.authentication_block_bytes + 64) },
  });
  // Once admitted, the declared block is checked against the file instead.
  expect(
    failed(header, header.length, {
      ...DEFAULTS,
      authentication_block_bytes: DEFAULTS.authentication_block_bytes + 64,
    }).failure,
  ).toMatchObject({ kind: "truncated", field: "image" });
});

it("refuses a raised-limit kernel cmdline too long to hex-encode as a capacity failure", () => {
  const maxStringLength = 100;
  const cmdline = Buffer.alloc(maxStringLength / 2 + 1, 0x61);
  const fixed = Buffer.alloc(8);
  fixed.writeUInt32BE(cmdline.length, 4);
  const bytes = buildAndroidVbmeta({
    descriptorBytes: androidVbmetaDescriptor(
      AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE,
      Buffer.concat([fixed, cmdline]),
    ),
  });
  const original = androidVbmetaHostBounds.maxStringLength;
  androidVbmetaHostBounds.maxStringLength = maxStringLength;
  try {
    const failure = failed(bytes, bytes.length, {
      ...DEFAULTS,
      descriptor_bytes: bytes.length,
      auxiliary_block_bytes: bytes.length,
    }).failure;
    expect(failure).toMatchObject({
      kind: "limit",
      field: "kernel cmdline",
      limit: {
        name: "Android vbmeta hex field bytes",
        maximum: maxStringLength / 2,
        required: cmdline.length,
      },
    });
  } finally {
    androidVbmetaHostBounds.maxStringLength = original;
  }
});

it("refuses header ranges, alignment, truncation, and ceilings", () => {
  for (const fixture of androidVbmetaRefusals()) {
    expect(failed(fixture.bytes).failure, fixture.name).toMatchObject({
      kind: fixture.kind,
      format: "android-vbmeta",
    });
  }
  const overAuthentication = failed(
    androidVbmetaHeader({
      authenticationDataBlockSize: DEFAULTS.authentication_block_bytes + 64,
    }),
  );
  expect(overAuthentication.failure).toMatchObject({
    kind: "limit",
    field: "authentication block",
  });
  expect(
    overAuthentication.failure.kind === "limit" &&
      overAuthentication.failure.limit.maximum,
  ).toBe(DEFAULTS.authentication_block_bytes);

  const misaligned = Buffer.alloc(24);
  misaligned.writeBigUInt64BE(BigInt(SAMPLE_UNKNOWN_TAG), 0);
  misaligned.writeBigUInt64BE(4n, 8);
  expect(
    stopped(buildAndroidVbmeta({ descriptorBytes: misaligned })).failure,
  ).toMatchObject({
    kind: "malformed",
    field: "num_bytes_following",
  });

  const overrun = Buffer.alloc(32);
  overrun.writeBigUInt64BE(BigInt(SAMPLE_UNKNOWN_TAG), 0);
  overrun.writeBigUInt64BE(24n, 8);
  expect(
    stopped(buildAndroidVbmeta({ descriptorBytes: overrun })).failure,
  ).toMatchObject({
    kind: "malformed",
    field: "descriptor",
  });

  const leftover = Buffer.concat([
    androidVbmetaDescriptor(SAMPLE_UNKNOWN_TAG, Buffer.alloc(0)),
    Buffer.alloc(4),
  ]);
  const afterOne = stopped(buildAndroidVbmeta({ descriptorBytes: leftover }));
  expect(afterOne.failure.detail).toContain("descriptor header does not fit");
  expect(afterOne.failure.unexamined_bytes).toBe(4);
  expect(afterOne.image.metadata.descriptors).toHaveLength(1);

  const descriptor = androidVbmetaDescriptor(
    SAMPLE_UNKNOWN_TAG,
    Buffer.alloc(0),
  );
  const atLimit = stopped(
    buildAndroidVbmeta({
      descriptorBytes: Buffer.concat([
        Buffer.alloc(descriptor.length * DEFAULTS.descriptor_count, descriptor),
        Buffer.alloc(8),
      ]),
      publicKey: SAMPLE_PUBLIC_KEY,
    }),
  );
  expect(atLimit.failure).toMatchObject({
    kind: "malformed",
    field: "descriptor",
    unexamined_bytes: 8,
  });
  expect(atLimit.image.metadata.descriptors).toHaveLength(
    DEFAULTS.descriptor_count,
  );
  expect(atLimit.image.children).toMatchObject([{ path: "public_key" }]);

  const counted = failed(androidVbmetaDescriptorCountOverflow());
  expect(counted.failure).toMatchObject({
    kind: "limit",
    field: "descriptors",
  });
  if (counted.failure.kind === "limit")
    expect(counted.failure.limit.maximum).toBe(DEFAULTS.descriptor_count);

  const auxiliary = failed(
    androidVbmetaHeader({
      auxiliaryDataBlockSize: DEFAULTS.auxiliary_block_bytes + 64,
    }),
  );
  expect(auxiliary.failure).toMatchObject({
    kind: "limit",
    field: "auxiliary block",
  });

  const algorithm = Buffer.alloc(164, 0);
  algorithm.fill(0xff, 56, 88);
  expect(
    stopped(
      buildAndroidVbmeta({
        descriptorBytes: androidVbmetaDescriptor(
          AVB_DESCRIPTOR_TAG.HASHTREE,
          algorithm,
        ),
      }),
    ).failure.detail,
  ).toContain("NUL-terminated");

  const key = Buffer.from("abcd");
  const value = Buffer.from("ab");
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(key.length), 0);
  lengths.writeBigUInt64BE(BigInt(value.length), 8);
  const content = Buffer.concat([
    lengths,
    key,
    Buffer.from([0]),
    value,
    Buffer.from([0]),
  ]);
  const padded = Buffer.concat([content, Buffer.alloc(8)]);
  const header = Buffer.alloc(16);
  header.writeBigUInt64BE(0n, 0);
  header.writeBigUInt64BE(BigInt(padded.length), 8);
  expect(
    stopped(
      buildAndroidVbmeta({
        descriptorBytes: Buffer.concat([header, padded]),
      }),
    ).failure.detail,
  ).toContain("padding");
});

it("preserves UINT64_MAX in partition metadata", () => {
  const bytes = sampleAndroidVbmeta();
  const [, tree, hash] = descriptorHeaders(bytes);
  const max = (1n << 64n) - 1n;
  for (const field of [4, 12, 20, 40, 48])
    bytes.writeBigUInt64BE(max, tree!.offset + 16 + field);
  bytes.writeBigUInt64BE(max, hash!.offset + 16);
  const { descriptors } = androidVbmetaMetadataSchema.parse({
    kind: "android-vbmeta",
    ...parsed(bytes).metadata,
  });
  expect(descriptors[1]).toMatchObject({
    image_size: max.toString(),
    tree_offset: max.toString(),
    tree_size: max.toString(),
    fec_offset: max.toString(),
    fec_size: max.toString(),
  });
  expect(descriptors[2]).toMatchObject({ image_size: max.toString() });
});

it("locates invalid lengths and ranges in the original carrier", () => {
  const sample = sampleAndroidVbmeta();
  const [property] = descriptorHeaders(sample);
  for (const offset of [
    property!.offset + 8,
    property!.offset + 16,
    property!.offset + 24,
  ]) {
    const bytes = Buffer.from(sample);
    bytes.writeBigUInt64BE(1n << 63n, offset);
    expect(stopped(bytes).failure).toMatchObject({
      kind: "malformed",
      offset,
      descriptor_offset: property!.offset,
    });
  }
  for (const offset of [64, 72]) {
    const bytes = Buffer.from(sample);
    bytes.writeBigUInt64BE(BigInt(bytes.length + 1), offset);
    expect(failed(bytes).failure).toMatchObject({ kind: "malformed", offset });
  }
});

it("locates malformed property key and value terminators in the carrier", () => {
  const sample = sampleAndroidVbmeta();
  const descriptorOffset = descriptorHeaders(sample)[0]!.offset;
  const keyNul = descriptorOffset + 32 + Buffer.byteLength(SAMPLE_PROPERTY_KEY);
  const valueNul = keyNul + 1 + Buffer.byteLength(SAMPLE_PROPERTY_VALUE);
  for (const offset of [keyNul, valueNul]) {
    const bytes = Buffer.from(sample);
    bytes[offset] = 1;
    expect(stopped(bytes).failure).toMatchObject({
      kind: "malformed",
      offset,
      descriptor_offset: descriptorOffset,
    });
  }
});

it("refuses a release string whose final byte is not NUL", () => {
  for (const release of [
    Buffer.concat([Buffer.from("rel\0"), Buffer.alloc(44, 0x41)]),
    Buffer.alloc(48, 0x41),
  ]) {
    expect(failed(androidVbmetaHeader({ release })).failure).toMatchObject({
      kind: "malformed",
      field: "release string",
      offset: 175,
    });
  }
});

it("stops the walk on a chain partition with rollback index location 0", () => {
  const bytes = sampleAndroidVbmeta();
  const headers = descriptorHeaders(bytes);
  const chain = headers.find(
    ({ tag }) => tag === AVB_DESCRIPTOR_TAG.CHAIN_PARTITION,
  )!;
  bytes.writeUInt32BE(0, chain.offset + 16);
  const { image, failure } = stopped(bytes);
  expect(failure).toMatchObject({
    kind: "malformed",
    field: "rollback index location",
    offset: chain.offset + 16,
    descriptor_offset: chain.offset,
  });
  expect(image.metadata.descriptors.map(({ tag_name }) => tag_name)).toEqual([
    "PROPERTY",
    "HASHTREE",
    "HASH",
    "KERNEL_CMDLINE",
  ]);
});

it("locates an unterminated hashtree algorithm at its field", () => {
  const bytes = Buffer.from(sampleAndroidVbmeta());
  const hashtree = descriptorHeaders(bytes).find(
    ({ tag }) => tag === AVB_DESCRIPTOR_TAG.HASHTREE,
  )!;
  const field = hashtree.offset + 16 + 56;
  bytes.fill(0x41, field, field + 32);
  expect(stopped(bytes).failure).toMatchObject({
    kind: "malformed",
    field: "hash algorithm",
    offset: field,
    descriptor_offset: hashtree.offset,
  });
});

it("locates oversized tail lengths at their length fields", () => {
  const cases = [
    [AVB_DESCRIPTOR_TAG.HASHTREE, 88, "partition name length"],
    [AVB_DESCRIPTOR_TAG.HASHTREE, 96, "root digest length"],
    [AVB_DESCRIPTOR_TAG.HASH, 44, "salt length"],
    [AVB_DESCRIPTOR_TAG.KERNEL_CMDLINE, 4, "kernel cmdline length"],
    [AVB_DESCRIPTOR_TAG.CHAIN_PARTITION, 8, "public key length"],
  ] as const;
  for (const [tag, bodyOffset, field] of cases) {
    const bytes = Buffer.from(sampleAndroidVbmeta());
    const descriptor = descriptorHeaders(bytes).find(
      (header) => header.tag === tag,
    )!;
    bytes.writeUInt32BE(0xffff, descriptor.offset + 16 + bodyOffset);
    expect(stopped(bytes).failure).toMatchObject({
      kind: "malformed",
      field,
      offset: descriptor.offset + 16 + bodyOffset,
      descriptor_offset: descriptor.offset,
    });
  }
});

it("keeps decoded descriptors when a later descriptor is malformed", () => {
  const bytes = androidVbmetaMalformedLaterDescriptor();
  const headers = descriptorHeaders(bytes);
  const { image, failure } = stopped(bytes);
  const metadata = androidVbmetaMetadataSchema.parse({
    kind: "android-vbmeta",
    ...image.metadata,
  });
  expect(metadata.descriptors.map(({ tag_name }) => tag_name)).toEqual([
    "PROPERTY",
    "HASHTREE",
  ]);
  expect(metadata.descriptors.map(({ offset }) => offset)).toEqual([
    headers[0]!.offset,
    headers[1]!.offset,
  ]);
  expect(metadata.descriptors[0]).toMatchObject({
    key: SAMPLE_PROPERTY_KEY,
    value: SAMPLE_PROPERTY_VALUE,
  });
  expect(metadata.descriptors[1]).toMatchObject({
    partition_name: SAMPLE_HASHTREE_PARTITION,
  });
  const tableEnd =
    256 +
    metadata.authentication_data_block_size +
    metadata.descriptors_offset +
    metadata.descriptors_size;
  expect(failure).toEqual({
    kind: "malformed",
    detail: "hash algorithm is not NUL-terminated",
    field: "hash algorithm",
    offset: headers[2]!.offset + 16 + 8,
    descriptor_offset: headers[2]!.offset,
    unexamined_bytes: tableEnd - headers[2]!.offset,
  });
  expect(image.limitations).toContain(
    `Descriptor walk stopped at file offset ${String(headers[2]!.offset)}: hash algorithm is not NUL-terminated. The 2 descriptors before it are decoded; the remaining ${String(tableEnd - headers[2]!.offset)} bytes of the descriptor table were not examined.`,
  );
  expect(metadata.signatures_verified).toBe(false);
  expect(metadata.rollback_index).toBe("0");
});

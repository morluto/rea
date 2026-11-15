import {
  RPM_FILE_FLAG,
  RPM_HEADER_MAGIC,
  RPM_LEAD_MAGIC,
  RPM_LEAD_SIZE,
  RPM_SENSE,
  RPM_SIG_TAG,
  RPM_TAG,
  RPM_TYPE,
} from "./RpmPackageTags.js";

export {
  RPM_FILE_FLAG,
  RPM_HEADER_MAGIC,
  RPM_LEAD_MAGIC,
  RPM_LEAD_SIZE,
  RPM_SENSE,
  RPM_SIG_TAG,
  RPM_TAG,
  RPM_TYPE,
} from "./RpmPackageTags.js";

export type RpmFixtureTag = {
  readonly tag: number;
  readonly type: number;
  readonly count?: number;
  readonly string?: string;
  readonly strings?: readonly string[];
  readonly int16?: readonly number[];
  readonly int32?: readonly number[];
  readonly int64?: readonly bigint[];
  readonly bin?: Uint8Array;
  readonly offset?: number;
};

const concat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

const u8 = (value: number): Buffer => Buffer.from([value & 0xff]);
const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};
const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const u64 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
};

const alignmentFor = (type: number): number => {
  if (type === RPM_TYPE.int16) return 2;
  if (type === RPM_TYPE.int32) return 4;
  if (type === RPM_TYPE.int64) return 8;
  return 1;
};

const padTo = (store: Buffer, align: number): Buffer => {
  const rem = store.length % align;
  return rem === 0 ? store : concat(store, Buffer.alloc(align - rem));
};

const encodeTagData = (tag: RpmFixtureTag): Buffer => {
  if (tag.string !== undefined) return Buffer.from(`${tag.string}\0`, "utf8");
  if (tag.strings !== undefined)
    return Buffer.from(`${tag.strings.join("\0")}\0`, "utf8");
  if (tag.int16 !== undefined) return concat(...tag.int16.map(u16));
  if (tag.int32 !== undefined) return concat(...tag.int32.map(u32));
  if (tag.int64 !== undefined) return concat(...tag.int64.map(u64));
  if (tag.bin !== undefined) return Buffer.from(tag.bin);
  return Buffer.alloc(0);
};

const tagCount = (tag: RpmFixtureTag): number => {
  if (tag.count !== undefined) return tag.count;
  if (tag.bin !== undefined) return tag.bin.length;
  if (tag.int16 !== undefined) return tag.int16.length;
  if (tag.int32 !== undefined) return tag.int32.length;
  if (tag.int64 !== undefined) return tag.int64.length;
  if (tag.strings !== undefined) return tag.strings.length;
  return 1;
};

/** Serialize one RPM header (magic, index, store) without 8-byte trailing pad. */
export const encodeRpmHeader = (tags: readonly RpmFixtureTag[]): Buffer => {
  let store: Buffer = Buffer.alloc(0);
  const entries: Buffer[] = [];
  for (const tag of tags) {
    store = padTo(store, alignmentFor(tag.type));
    const offset = tag.offset ?? store.length;
    if (tag.offset === undefined) store = concat(store, encodeTagData(tag));
    entries.push(
      concat(u32(tag.tag), u32(tag.type), u32(offset), u32(tagCount(tag))),
    );
  }
  return concat(
    u32(RPM_HEADER_MAGIC),
    u32(0),
    u32(tags.length),
    u32(store.length),
    ...entries,
    store,
  );
};

export const encodeRpmLead = (options: {
  readonly name?: string;
  readonly type?: 0 | 1;
  readonly major?: number;
  readonly minor?: number;
  readonly arch?: number;
  readonly os?: number;
  readonly signatureType?: number;
}): Buffer => {
  const lead = Buffer.alloc(RPM_LEAD_SIZE);
  lead.writeUInt32BE(RPM_LEAD_MAGIC, 0);
  lead[4] = options.major ?? 3;
  lead[5] = options.minor ?? 0;
  lead.writeUInt16BE(options.type ?? 0, 6);
  lead.writeUInt16BE(options.arch ?? 1, 8);
  Buffer.from((options.name ?? "demo-1.0.0-1").slice(0, 65), "latin1").copy(
    lead,
    10,
  );
  lead.writeUInt16BE(options.os ?? 1, 76);
  lead.writeUInt16BE(options.signatureType ?? 5, 78);
  return lead;
};

/** Minimal OpenPGP v4 signature packet with an issuer key ID. */
export const openPgpSignatureBlob = (
  options: { readonly algorithm?: number; readonly keyId?: string } = {},
): Buffer => {
  const keyId = Buffer.from(
    (options.keyId ?? "a1b2c3d4e5f60708").slice(0, 16),
    "hex",
  );
  const unhashed = concat(u8(9), u8(16), keyId);
  const body = concat(
    u8(4),
    u8(0),
    u8(options.algorithm ?? 1),
    u8(8),
    u16(0),
    u16(unhashed.length),
    unhashed,
    u16(0),
  );
  return concat(u8(0x88), u8(body.length), body);
};

const sha256Hex = "ab".repeat(32);
const sha1Hex = "cd".repeat(20);
const md5 = Buffer.alloc(16, 0xee);

const defaultSignatureTags = (): RpmFixtureTag[] => [
  { tag: RPM_SIG_TAG.sha256Header, type: RPM_TYPE.string, string: sha256Hex },
  { tag: RPM_SIG_TAG.sha1Header, type: RPM_TYPE.string, string: sha1Hex },
  { tag: RPM_SIG_TAG.md5, type: RPM_TYPE.bin, bin: md5 },
  { tag: RPM_SIG_TAG.size, type: RPM_TYPE.int32, int32: [256] },
  {
    tag: RPM_SIG_TAG.rsaHeader,
    type: RPM_TYPE.bin,
    bin: openPgpSignatureBlob({ algorithm: 1, keyId: "a1b2c3d4e5f60708" }),
  },
  {
    tag: RPM_TAG.payloadDigest,
    type: RPM_TYPE.stringArray,
    strings: ["ef".repeat(32)],
  },
  { tag: RPM_TAG.payloadDigestAlgo, type: RPM_TYPE.int32, int32: [8] },
];

const defaultIdentityTags = (): RpmFixtureTag[] => [
  { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "demo" },
  { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "1.0.0" },
  { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
  { tag: RPM_TAG.epoch, type: RPM_TYPE.int32, int32: [2] },
  {
    tag: RPM_TAG.summary,
    type: RPM_TYPE.i18nString,
    strings: ["A tiny fixture package"],
  },
  { tag: RPM_TAG.license, type: RPM_TYPE.string, string: "MIT" },
  { tag: RPM_TAG.vendor, type: RPM_TYPE.string, string: "Demo Vendor" },
  { tag: RPM_TAG.packager, type: RPM_TYPE.string, string: "Demo Packager" },
  {
    tag: RPM_TAG.url,
    type: RPM_TYPE.string,
    string: "https://example.invalid/demo",
  },
  { tag: RPM_TAG.buildTime, type: RPM_TYPE.int32, int32: [1_700_000_000] },
  {
    tag: RPM_TAG.buildHost,
    type: RPM_TYPE.string,
    string: "build.example.invalid",
  },
  { tag: RPM_TAG.os, type: RPM_TYPE.string, string: "linux" },
  { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
  {
    tag: RPM_TAG.sourceRpm,
    type: RPM_TYPE.string,
    string: "demo-1.0.0-1.src.rpm",
  },
  { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
  { tag: RPM_TAG.payloadCompressor, type: RPM_TYPE.string, string: "gzip" },
  { tag: RPM_TAG.payloadFlags, type: RPM_TYPE.string, string: "9" },
];

const defaultDependencyTags = (): RpmFixtureTag[] => [
  { tag: RPM_TAG.provideName, type: RPM_TYPE.stringArray, strings: ["demo"] },
  { tag: RPM_TAG.provideFlags, type: RPM_TYPE.int32, int32: [RPM_SENSE.equal] },
  {
    tag: RPM_TAG.provideVersion,
    type: RPM_TYPE.stringArray,
    strings: ["1.0.0-1"],
  },
  {
    tag: RPM_TAG.requireName,
    type: RPM_TYPE.stringArray,
    strings: ["rpmlib(CompressedFileNames)", "/bin/sh", "libc.so.6"],
  },
  {
    tag: RPM_TAG.requireFlags,
    type: RPM_TYPE.int32,
    int32: [
      RPM_SENSE.rpmlib | RPM_SENSE.equal,
      RPM_SENSE.interp | RPM_SENSE.scriptPre,
      RPM_SENSE.greater | RPM_SENSE.equal,
    ],
  },
  {
    tag: RPM_TAG.requireVersion,
    type: RPM_TYPE.stringArray,
    strings: ["3.0.4-1", "", "2.17"],
  },
  {
    tag: RPM_TAG.conflictName,
    type: RPM_TYPE.stringArray,
    strings: ["demo-old"],
  },
  { tag: RPM_TAG.conflictFlags, type: RPM_TYPE.int32, int32: [RPM_SENSE.less] },
  {
    tag: RPM_TAG.conflictVersion,
    type: RPM_TYPE.stringArray,
    strings: ["1.0.0"],
  },
  {
    tag: RPM_TAG.obsoleteName,
    type: RPM_TYPE.stringArray,
    strings: ["demo-legacy"],
  },
  {
    tag: RPM_TAG.obsoleteFlags,
    type: RPM_TYPE.int32,
    int32: [RPM_SENSE.equal],
  },
  {
    tag: RPM_TAG.obsoleteVersion,
    type: RPM_TYPE.stringArray,
    strings: ["0.9"],
  },
  {
    tag: RPM_TAG.recommendName,
    type: RPM_TYPE.stringArray,
    strings: ["extra"],
  },
  {
    tag: RPM_TAG.recommendFlags,
    type: RPM_TYPE.int32,
    int32: [RPM_SENSE.equal],
  },
  {
    tag: RPM_TAG.recommendVersion,
    type: RPM_TYPE.stringArray,
    strings: ["1"],
  },
];

const defaultScriptletAndFileTags = (): RpmFixtureTag[] => [
  { tag: RPM_TAG.headerImmutable, type: RPM_TYPE.bin, bin: Buffer.alloc(16) },
  { tag: RPM_TAG.prein, type: RPM_TYPE.string, string: "echo prein\n" },
  { tag: RPM_TAG.preinProg, type: RPM_TYPE.stringArray, strings: ["/bin/sh"] },
  { tag: RPM_TAG.postin, type: RPM_TYPE.string, string: "echo postin\n" },
  { tag: RPM_TAG.postinProg, type: RPM_TYPE.stringArray, strings: ["/bin/sh"] },
  {
    tag: RPM_TAG.triggerScripts,
    type: RPM_TYPE.stringArray,
    strings: ["echo trigger\n"],
  },
  {
    tag: RPM_TAG.triggerScriptProg,
    type: RPM_TYPE.stringArray,
    strings: ["/bin/sh"],
  },
  {
    tag: RPM_TAG.triggerName,
    type: RPM_TYPE.stringArray,
    strings: ["demo"],
  },
  { tag: RPM_TAG.triggerIndex, type: RPM_TYPE.int32, int32: [0] },
  {
    tag: RPM_TAG.dirNames,
    type: RPM_TYPE.stringArray,
    strings: ["/usr/bin/", "/etc/"],
  },
  {
    tag: RPM_TAG.baseNames,
    type: RPM_TYPE.stringArray,
    strings: ["demo", "demo.conf"],
  },
  { tag: RPM_TAG.dirIndexes, type: RPM_TYPE.int32, int32: [0, 1] },
  { tag: RPM_TAG.fileSizes, type: RPM_TYPE.int32, int32: [12, 4] },
  { tag: RPM_TAG.fileModes, type: RPM_TYPE.int16, int16: [0o100755, 0o100644] },
  {
    tag: RPM_TAG.fileDigests,
    type: RPM_TYPE.stringArray,
    strings: ["aa".repeat(32), "bb".repeat(32)],
  },
  { tag: RPM_TAG.fileDigestAlgo, type: RPM_TYPE.int32, int32: [8] },
  {
    tag: RPM_TAG.fileFlags,
    type: RPM_TYPE.int32,
    int32: [0, RPM_FILE_FLAG.config],
  },
  {
    tag: RPM_TAG.fileUserName,
    type: RPM_TYPE.stringArray,
    strings: ["root", "root"],
  },
  {
    tag: RPM_TAG.fileGroupName,
    type: RPM_TYPE.stringArray,
    strings: ["root", "root"],
  },
];

const defaultHeaderTags = (): RpmFixtureTag[] => [
  ...defaultIdentityTags(),
  ...defaultDependencyTags(),
  ...defaultScriptletAndFileTags(),
];

const sourceHeaderTags = (): RpmFixtureTag[] => [
  { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "demo" },
  { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "1.0.0" },
  { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
  { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "src" },
  { tag: RPM_TAG.os, type: RPM_TYPE.string, string: "linux" },
  { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
  { tag: RPM_TAG.payloadCompressor, type: RPM_TYPE.string, string: "gzip" },
  { tag: RPM_TAG.dirNames, type: RPM_TYPE.stringArray, strings: [""] },
  {
    tag: RPM_TAG.baseNames,
    type: RPM_TYPE.stringArray,
    strings: ["demo.spec"],
  },
  { tag: RPM_TAG.dirIndexes, type: RPM_TYPE.int32, int32: [0] },
  { tag: RPM_TAG.fileSizes, type: RPM_TYPE.int32, int32: [32] },
  { tag: RPM_TAG.fileModes, type: RPM_TYPE.int16, int16: [0o100644] },
];

const padSignature = (header: Buffer): Buffer => {
  const rem = header.length % 8;
  return rem === 0 ? header : concat(header, Buffer.alloc(8 - rem));
};

/** Assemble lead + signature header + main header + optional payload bytes. */
export const encodeRpmPackage = (options: {
  readonly lead?: Parameters<typeof encodeRpmLead>[0];
  readonly signatureTags?: readonly RpmFixtureTag[];
  readonly headerTags?: readonly RpmFixtureTag[];
  readonly payload?: Uint8Array;
}): Buffer => {
  const lead = encodeRpmLead(options.lead ?? {});
  const signature = padSignature(
    encodeRpmHeader(options.signatureTags ?? defaultSignatureTags()),
  );
  const header = encodeRpmHeader(options.headerTags ?? defaultHeaderTags());
  const payload = options.payload ?? Buffer.from("payload");
  return concat(lead, signature, header, Buffer.from(payload));
};

/** Inert binary RPM with identity, flagged dependencies, scriptlets, and files. */
export const rpmBinaryPackageFixture = (
  options: {
    readonly headerTags?: readonly RpmFixtureTag[];
    readonly signatureTags?: readonly RpmFixtureTag[];
    readonly payload?: Uint8Array;
    readonly lead?: Parameters<typeof encodeRpmLead>[0];
  } = {},
): Buffer => encodeRpmPackage(options);

/** Inert source RPM (lead type 1) with a spec-file inventory row. */
export const rpmSourcePackageFixture = (): Buffer =>
  encodeRpmPackage({
    lead: { type: 1, name: "demo-1.0.0-1.src.rpm" },
    headerTags: sourceHeaderTags(),
  });

/** Binary RPM that omits optional identity, weak-dep, and scriptlet tags. */
export const rpmSparsePackageFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "sparse" },
      { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "0.1" },
      { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
      { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
      { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
      { tag: RPM_TAG.payloadCompressor, type: RPM_TYPE.string, string: "zstd" },
    ],
  });

/** Binary RPM whose summary, file path, and scriptlet carry UTF-8 text. */
export const rpmUtf8PackageFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "cafe" },
      { tag: RPM_TAG.version, type: RPM_TYPE.string, string: "1.0" },
      { tag: RPM_TAG.release, type: RPM_TYPE.string, string: "1" },
      {
        tag: RPM_TAG.summary,
        type: RPM_TYPE.i18nString,
        strings: ["Café résumé tool"],
      },
      { tag: RPM_TAG.arch, type: RPM_TYPE.string, string: "noarch" },
      { tag: RPM_TAG.prein, type: RPM_TYPE.string, string: "echo é\n" },
      {
        tag: RPM_TAG.preinProg,
        type: RPM_TYPE.stringArray,
        strings: ["/bin/sh"],
      },
      {
        tag: RPM_TAG.dirNames,
        type: RPM_TYPE.stringArray,
        strings: ["/usr/share/café/"],
      },
      {
        tag: RPM_TAG.baseNames,
        type: RPM_TYPE.stringArray,
        strings: ["naïve.txt"],
      },
      { tag: RPM_TAG.dirIndexes, type: RPM_TYPE.int32, int32: [0] },
      { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
    ],
  });

/** BASENAMES entry `caf\xe9.txt` holds a Latin-1 byte that is not valid UTF-8. */
export const rpmInvalidUtf8FilenameFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "latin1" },
      {
        tag: RPM_TAG.dirNames,
        type: RPM_TYPE.stringArray,
        strings: ["/srv/"],
      },
      {
        tag: RPM_TAG.baseNames,
        type: RPM_TYPE.stringArray,
        count: 2,
        bin: Buffer.from("cafe.txt\0caf\xe9.txt\0", "latin1"),
      },
      { tag: RPM_TAG.dirIndexes, type: RPM_TYPE.int32, int32: [0, 0] },
    ],
  });

/** In-bounds PREIN stored as INT32 rather than the STRING its reader requires. */
export const rpmInt32PreinFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "mistyped" },
      { tag: RPM_TAG.prein, type: RPM_TYPE.int32, int32: [0x6563686f] },
      {
        tag: RPM_TAG.preinProg,
        type: RPM_TYPE.stringArray,
        strings: ["/bin/sh"],
      },
      { tag: RPM_TAG.payloadFormat, type: RPM_TYPE.string, string: "cpio" },
    ],
  });

/** Header whose first index entry points past the data store. */
export const rpmOutOfBoundsIndexFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      {
        tag: RPM_TAG.name,
        type: RPM_TYPE.string,
        string: "oob",
        offset: 0xffff,
      },
    ],
  });

/** Two trigger scripts whose three TRIGGERNAME conditions map through TRIGGERINDEX. */
export const rpmGroupedTriggerFixture = (
  indexes: readonly number[] = [0, 0, 1],
): Buffer =>
  encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "triggers" },
      {
        tag: RPM_TAG.triggerScripts,
        type: RPM_TYPE.stringArray,
        strings: ["echo first\n", "echo second\n"],
      },
      {
        tag: RPM_TAG.triggerScriptProg,
        type: RPM_TYPE.stringArray,
        strings: ["/bin/sh", "/bin/bash"],
      },
      {
        tag: RPM_TAG.triggerName,
        type: RPM_TYPE.stringArray,
        strings: ["foo", "bar", "baz"],
      },
      { tag: RPM_TAG.triggerIndex, type: RPM_TYPE.int32, int32: [...indexes] },
    ],
  });

/** Binary RPM that stores its file sizes in LONGFILESIZES instead of FILESIZES. */
export const rpmLongFileSizesFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: defaultHeaderTags().map((tag) =>
      tag.tag === RPM_TAG.fileSizes
        ? {
            tag: RPM_TAG.longFileSizes,
            type: RPM_TYPE.int64,
            int64: [5_000_000_000n, 12n],
          }
        : tag,
    ),
  });

/** Binary RPM whose FILEMODES array has one value for two BASENAMES rows. */
export const rpmMismatchedFileModesFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: defaultHeaderTags().map((tag) =>
      tag.tag === RPM_TAG.fileModes
        ? { tag: RPM_TAG.fileModes, type: RPM_TYPE.int16, int16: [0o100755] }
        : tag,
    ),
  });

/** Two trigger scripts with a single TRIGGERSCRIPTPROG value. */
export const rpmMismatchedTriggerProgFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      { tag: RPM_TAG.name, type: RPM_TYPE.string, string: "triggers" },
      {
        tag: RPM_TAG.triggerScripts,
        type: RPM_TYPE.stringArray,
        strings: ["echo first\n", "echo second\n"],
      },
      {
        tag: RPM_TAG.triggerScriptProg,
        type: RPM_TYPE.stringArray,
        strings: ["/bin/sh"],
      },
    ],
  });

/** Header that declares more index entries than are stored. */
export const rpmTruncatedHeaderFixture = (): Buffer => {
  const complete = rpmBinaryPackageFixture();
  return complete.subarray(0, RPM_LEAD_SIZE + 32);
};

/** Complete signature header followed by a main header cut inside its index. */
export const rpmTruncatedMainHeaderFixture = (): Buffer => {
  const signature = padSignature(encodeRpmHeader(defaultSignatureTags()));
  return rpmBinaryPackageFixture().subarray(
    0,
    RPM_LEAD_SIZE + signature.length + 32,
  );
};

/** Default header with a second NAME entry whose offset leaves the data store. */
export const rpmDuplicateTagFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: [
      ...defaultHeaderTags(),
      {
        tag: RPM_TAG.name,
        type: RPM_TYPE.string,
        string: "oob",
        offset: 0xffff,
      },
    ],
  });

/** Default header plus unknown BIN tags that all name one store range. */
export const rpmUnknownBinTagsFixture = (
  count: number,
  offset = 0,
  valueBytes?: number,
): Buffer => {
  const shared = {
    type: RPM_TYPE.bin,
    bin: new Uint8Array(64),
    offset,
    ...(valueBytes === undefined ? {} : { count: valueBytes }),
  };
  return encodeRpmPackage({
    headerTags: [
      ...defaultHeaderTags(),
      ...Array.from({ length: count }, (_, index) => ({
        tag: 90_000 + index,
        ...shared,
      })),
    ],
  });
};

/** Default header plus unknown STRING_ARRAY tags that all read one store range. */
export const rpmOverlappingStringTagsFixture = (tags: number): Buffer =>
  encodeRpmPackage({
    headerTags: [
      ...defaultHeaderTags(),
      ...Array.from({ length: tags }, (_, index) => ({
        tag: 91_000 + index,
        type: RPM_TYPE.stringArray,
        strings: ["shared"],
        offset: 0,
      })),
    ],
  });

/** Default header whose FILEDIGESTS values are not hexadecimal digests. */
export const rpmMalformedDigestFixture = (): Buffer =>
  encodeRpmPackage({
    headerTags: defaultHeaderTags().map((tag) =>
      tag.tag === RPM_TAG.fileDigests
        ? { ...tag, strings: (tag.strings ?? []).map(() => "zz") }
        : tag,
    ),
  });

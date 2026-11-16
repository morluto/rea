import { rpmPackageSchema } from "../domain/rpm/package.js";
import { keyedBy, uniqueKeyed } from "../domain/keyedCollection.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  InspectRpmPackageInput,
  RpmDependency,
  RpmDependencyComparison,
  RpmFileDigestAlgorithm,
  RpmPackage,
  RpmPackageFile,
  RpmScriptlet,
  RpmScriptletKind,
  RpmSignatureBlob,
} from "../domain/rpm/package.js";
import {
  type ParseFailureKind,
  ParseFailureError,
  unsupportedInput,
} from "../domain/parseFailure.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { RpmPackageCapacityFailure } from "./RpmPackage.errors.js";
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

const DIGEST_ALGORITHMS: Readonly<Record<number, RpmFileDigestAlgorithm>> = {
  1: "md5",
  2: "sha1",
  3: "ripemd160",
  5: "md2",
  6: "tiger192",
  7: "haval-5-160",
  8: "sha256",
  9: "sha384",
  10: "sha512",
  11: "sha224",
};

const OPENPGP_ALGORITHMS: Readonly<Record<number, string>> = {
  1: "rsa",
  2: "rsa-encrypt",
  3: "rsa-sign",
  16: "elgamal",
  17: "dsa",
  18: "ecdh",
  19: "ecdsa",
  22: "eddsa",
};

const SCRIPTLET_SENSE =
  RPM_SENSE.pretrans |
  RPM_SENSE.posttrans |
  RPM_SENSE.interp |
  RPM_SENSE.scriptPre |
  RPM_SENSE.scriptPost |
  RPM_SENSE.scriptPreun |
  RPM_SENSE.scriptPostun;

const DEFINED_TYPES: ReadonlySet<number> = new Set(Object.values(RPM_TYPE));

const TYPE_SIZE: Readonly<Record<number, number>> = {
  [RPM_TYPE.char]: 1,
  [RPM_TYPE.int8]: 1,
  [RPM_TYPE.int16]: 2,
  [RPM_TYPE.int32]: 4,
  [RPM_TYPE.int64]: 8,
};

const TYPE_ALIGN: Readonly<Record<number, number>> = {
  [RPM_TYPE.int16]: 2,
  [RPM_TYPE.int32]: 4,
  [RPM_TYPE.int64]: 8,
};

export const RPM_PACKAGE_LIMITATIONS = [
  "This workflow reads RPM lead, signature and header metadata without installing the package, running scriptlets, verifying signatures, or decompressing the payload.",
  "Signature blobs report presence and trivially decoded OpenPGP algorithm/key-id bytes only; they do not establish trust.",
  "File inventory and payload identity come from header tags; the cpio payload is not decompressed.",
] as const;

/** Header text stays raw until a reader decodes it, so no bytes are replaced. */
type HeaderValue =
  | { readonly kind: "string"; readonly raw: Buffer }
  | { readonly kind: "strings"; readonly raw: readonly Buffer[] }
  | { readonly kind: "ints"; readonly values: readonly number[] }
  | { readonly kind: "bin"; readonly value: Buffer };

interface IndexEntry {
  readonly tag: number;
  readonly type: number;
  readonly offset: number;
  readonly count: number;
}

interface DecodedHeader {
  readonly label: "signature" | "main";
  readonly location: { readonly offset: number; readonly bytes: number };
  readonly indexEntries: number;
  readonly storeBytes: number;
  readonly storeOffset: number;
  readonly values: ReadonlyMap<number, HeaderValue>;
  readonly tags: readonly IndexEntry[];
}

interface Lead {
  readonly magic: "edabeedb";
  readonly version: { readonly major: number; readonly minor: number };
  readonly type: "binary" | "source";
  readonly arch_number: number;
  readonly os_number: number;
  readonly name: string | null;
  readonly signature_type: number;
  readonly location: { readonly offset: 0; readonly bytes: 96 };
}

const text = (value: string | undefined): string | null => {
  if (value === undefined || value.length === 0) return null;
  return value;
};

const hex = (bytes: Buffer): string => bytes.toString("hex");

const FORMAT = "rpm";

const fail = (
  detail: string,
  facts?: {
    readonly offset?: number;
    readonly field?: string;
    readonly observed?: JsonValue;
  },
): never => {
  throw new ParseFailureError({
    kind: "malformed",
    format: FORMAT,
    detail,
    ...facts,
  });
};

/** Attach the facts decoded so far to a format failure raised while reading on. */
const observing = <T>(observed: JsonValue, read: () => T): T => {
  try {
    return read();
  } catch (cause) {
    if (
      !(cause instanceof ParseFailureError) ||
      cause.kind === "limit" ||
      cause.failure.observed !== undefined
    )
      throw cause;
    throw new ParseFailureError<ParseFailureKind>(
      { ...cause.failure, observed },
      { cause },
    );
  }
};

const leadObserved = (lead: Lead): Record<string, JsonValue> => ({
  lead: {
    magic: lead.magic,
    version: lead.version,
    type: lead.type,
    arch_number: lead.arch_number,
    os_number: lead.os_number,
    name: lead.name,
    signature_type: lead.signature_type,
  },
});

const parseLead = (reader: BinaryReader): Lead => {
  reader.range(0, 4, "RPM lead magic");
  const magic = reader.u32(0);
  if (magic !== RPM_LEAD_MAGIC)
    throw unsupportedInput(
      FORMAT,
      `Selected file is not an RPM (magic ${magic.toString(16)}).`,
      { offset: 0, field: "lead magic" },
    );
  const bytes = observing({ lead: { magic: "edabeedb" } }, () =>
    reader.range(0, RPM_LEAD_SIZE, "RPM lead"),
  );
  const typeNumber = reader.u16(6);
  if (typeNumber !== 0 && typeNumber !== 1)
    fail(`RPM lead type ${String(typeNumber)} is not binary or source.`, {
      offset: 6,
      field: "lead type",
      observed: { lead_type: typeNumber },
    });
  const rawName = bytes.subarray(10, 76);
  const nul = rawName.indexOf(0);
  const name = rawName
    .subarray(0, nul === -1 ? rawName.length : nul)
    .toString("latin1");
  return {
    magic: "edabeedb",
    version: { major: bytes[4]!, minor: bytes[5]! },
    type: typeNumber === 1 ? "source" : "binary",
    arch_number: reader.u16(8),
    os_number: reader.u16(76),
    name: text(name),
    signature_type: reader.u16(78),
    location: { offset: 0, bytes: RPM_LEAD_SIZE },
  };
};

const readCString = (
  store: Buffer,
  offset: number,
  message: string,
): { readonly raw: Buffer; readonly next: number } => {
  if (offset >= store.length) fail(message, { field: "data store" });
  const nul = store.indexOf(0, offset);
  if (nul === -1) fail(message, { field: "data store" });
  return { raw: store.subarray(offset, nul), next: nul + 1 };
};

const readStrings = (
  store: Buffer,
  offset: number,
  count: number,
  message: string,
): readonly Buffer[] => {
  const raw: Buffer[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    const read = readCString(store, cursor, message);
    raw.push(read.raw);
    cursor = read.next;
  }
  return raw;
};

// RPM header text is UTF-8. Strict decoding keeps a leading U+FEFF as text
// and refuses invalid sequences instead of replacing them with U+FFFD.

/** Raw bytes quoted in an invalid-UTF-8 refusal; PATH_MAX covers file paths. */
const MAX_QUOTED_RAW_BYTES = 4096;

/** Decode one read text value, or refuse it with its exact stored bytes. */
const headerText = (
  header: DecodedHeader,
  tag: number,
  raw: Buffer,
  index?: number,
): string => {
  try {
    return decodeStrictUtf8(raw, "preserve");
  } catch {
    const quoted = raw.subarray(0, MAX_QUOTED_RAW_BYTES);
    const position = index === undefined ? "" : `[${String(index)}]`;
    const extent =
      quoted.length < raw.length
        ? `first ${String(quoted.length)} of ${String(raw.length)} raw bytes`
        : `raw bytes`;
    return fail(
      `RPM ${header.label} header tag ${String(tag)}${position} is not valid UTF-8, so its text cannot be reported without replacing source bytes (${extent}: ${hex(quoted)}).`,
      { field: `${header.label} tag ${String(tag)}` },
    );
  }
};

const readInts = (
  store: BinaryReader,
  offset: number,
  count: number,
  size: 1 | 2 | 4 | 8,
): readonly number[] => {
  if (size * count > store.bytes.length - offset)
    fail(
      `RPM integer array at store offset ${String(offset)} leaves the data store.`,
      { field: "data store" },
    );
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * size;
    if (size === 1) values.push(store.bytes[at]!);
    else if (size === 2) values.push(store.u16(at));
    else if (size === 4) values.push(store.u32(at));
    else {
      const value = store.word(at, 64);
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail(
          `RPM INT64 at store offset ${String(at)} exceeds a safe integer.`,
          { field: "data store" },
        );
      values.push(Number(value));
    }
  }
  return values;
};

/** Checks shared by every index entry, decoded or not; allocates nothing. */
const checkEntryPlacement = (store: BinaryReader, entry: IndexEntry): void => {
  const field = `tag ${String(entry.tag)}`;
  if (!DEFINED_TYPES.has(entry.type))
    fail(
      `RPM tag ${String(entry.tag)} type ${String(entry.type)} is not a defined RPM type.`,
      { field },
    );
  const align = TYPE_ALIGN[entry.type] ?? 1;
  if (entry.count < 1)
    fail(
      `RPM tag ${String(entry.tag)} count ${String(entry.count)} is not positive.`,
      { field },
    );
  if (entry.offset < 0 || entry.offset > store.bytes.length)
    fail(
      `RPM tag ${String(entry.tag)} offset ${String(entry.offset)} is outside the data store.`,
      { field },
    );
  if (align > 1 && entry.offset % align !== 0)
    fail(
      `RPM tag ${String(entry.tag)} offset ${String(entry.offset)} is not aligned for type ${String(entry.type)}.`,
      { field },
    );
};

const isStringType = (type: number): boolean =>
  type === RPM_TYPE.string ||
  type === RPM_TYPE.stringArray ||
  type === RPM_TYPE.i18nString;

/**
 * Refuse an entry whose declared count cannot fit in the bytes stored after
 * its offset, without reading or allocating its value. Fixed-width values need
 * size * count bytes, BIN needs count bytes, and each string needs at least its
 * NUL byte. Run before any resource budget so an impossible extent reads as
 * malformed input, not as a limit the caller could raise.
 */
const checkStoredExtent = (store: BinaryReader, entry: IndexEntry): void => {
  checkEntryPlacement(store, entry);
  const remaining = store.bytes.length - entry.offset;
  const size = TYPE_SIZE[entry.type];
  const minimum =
    size !== undefined
      ? size * entry.count
      : entry.type === RPM_TYPE.bin || isStringType(entry.type)
        ? entry.count
        : 0;
  if (minimum > remaining)
    fail(`RPM tag ${String(entry.tag)} value leaves the data store.`, {
      field: `tag ${String(entry.tag)}`,
    });
};

/**
 * Check that an entry's whole value lies inside the data store without
 * materializing it, for tags the report does not read.
 */
const checkEntryExtent = (
  store: BinaryReader,
  entry: IndexEntry,
  scan: { remaining: number },
): void => {
  checkStoredExtent(store, entry);
  if (isStringType(entry.type)) {
    const bytes = store.bytes;
    const leaves = (): never =>
      fail(`RPM tag ${String(entry.tag)} value leaves the data store.`, {
        field: `tag ${String(entry.tag)}`,
      });
    // Each string needs at least one NUL byte, so one entry's scan is bounded
    // by the store. Entries that share store bytes would rescan them, so all
    // unread entries together may scan the store only once.
    let cursor = entry.offset;
    for (let index = 0; index < entry.count; index += 1) {
      const nul = bytes.indexOf(0, cursor);
      if (nul === -1) leaves();
      scan.remaining -= nul + 1 - cursor;
      if (scan.remaining < 0)
        fail(
          "RPM unread string tags overlap in the data store; their values were not scanned again.",
          { field: `tag ${String(entry.tag)}` },
        );
      cursor = nul + 1;
    }
  }
};

const decodeEntry = (store: BinaryReader, entry: IndexEntry): HeaderValue => {
  const field = `tag ${String(entry.tag)}`;
  checkEntryPlacement(store, entry);
  const size = TYPE_SIZE[entry.type];
  switch (entry.type) {
    case RPM_TYPE.null:
      return { kind: "ints", values: [] };
    case RPM_TYPE.char:
    case RPM_TYPE.int8:
    case RPM_TYPE.int16:
    case RPM_TYPE.int32:
    case RPM_TYPE.int64:
      return {
        kind: "ints",
        values: readInts(
          store,
          entry.offset,
          entry.count,
          size as 1 | 2 | 4 | 8,
        ),
      };
    case RPM_TYPE.string: {
      if (entry.count !== 1)
        fail(
          `RPM STRING tag ${String(entry.tag)} count ${String(entry.count)} is not 1.`,
          { field },
        );
      const read = readCString(
        store.bytes,
        entry.offset,
        `RPM STRING tag ${String(entry.tag)} is not NUL-terminated in the data store.`,
      );
      return { kind: "string", raw: read.raw };
    }
    case RPM_TYPE.bin: {
      if (entry.count > store.bytes.length - entry.offset)
        fail(`RPM BIN tag ${String(entry.tag)} leaves the data store.`, {
          field,
        });
      return {
        kind: "bin",
        // A view of the bounded data store; repeated ranges never copy.
        value: store.range(entry.offset, entry.count, field),
      };
    }
    case RPM_TYPE.stringArray:
    case RPM_TYPE.i18nString:
      return {
        kind: "strings",
        raw: readStrings(
          store.bytes,
          entry.offset,
          entry.count,
          `RPM string array tag ${String(entry.tag)} is not NUL-terminated in the data store.`,
        ),
      };
    default:
      return fail(
        `RPM tag ${String(entry.tag)} type ${String(entry.type)} is not a defined RPM type.`,
        { field },
      );
  }
};

/** The stored types and, where fixed, the count each read tag must have. */
interface TagSpec {
  readonly name: string;
  readonly types: readonly number[];
  readonly count?: number;
}

const TYPE_NAMES: Readonly<Record<number, string>> = {
  [RPM_TYPE.null]: "NULL",
  [RPM_TYPE.char]: "CHAR",
  [RPM_TYPE.int8]: "INT8",
  [RPM_TYPE.int16]: "INT16",
  [RPM_TYPE.int32]: "INT32",
  [RPM_TYPE.int64]: "INT64",
  [RPM_TYPE.string]: "STRING",
  [RPM_TYPE.bin]: "BIN",
  [RPM_TYPE.stringArray]: "STRING_ARRAY",
  [RPM_TYPE.i18nString]: "I18NSTRING",
};

const typeName = (type: number): string =>
  TYPE_NAMES[type] ?? `type ${String(type)}`;

const oneString = (name: string): TagSpec => ({
  name,
  types: [RPM_TYPE.string],
  count: 1,
});
// rpm itself reads an I18NSTRING tag stored as a plain STRING.
const i18nString = (name: string): TagSpec => ({
  name,
  types: [RPM_TYPE.i18nString, RPM_TYPE.string],
});
const stringList = (name: string): TagSpec => ({
  name,
  types: [RPM_TYPE.stringArray],
});
// Older rpm stored scriptlet interpreters as STRING, newer as STRING_ARRAY.
const program = (name: string): TagSpec => ({
  name,
  types: [RPM_TYPE.string, RPM_TYPE.stringArray],
});
const oneInt32 = (name: string): TagSpec => ({
  name,
  types: [RPM_TYPE.int32],
  count: 1,
});
const int32List = (name: string): TagSpec => ({
  name,
  types: [RPM_TYPE.int32],
});
const binary = (name: string, count?: number): TagSpec => ({
  name,
  types: [RPM_TYPE.bin],
  ...(count === undefined ? {} : { count }),
});

/** Every main-header tag this parser reads. */
const MAIN_TAG_SPECS: ReadonlyMap<number, TagSpec> = new Map([
  [RPM_TAG.name, oneString("NAME")],
  [RPM_TAG.version, oneString("VERSION")],
  [RPM_TAG.release, oneString("RELEASE")],
  [RPM_TAG.epoch, oneInt32("EPOCH")],
  [RPM_TAG.summary, i18nString("SUMMARY")],
  [RPM_TAG.buildTime, oneInt32("BUILDTIME")],
  [RPM_TAG.buildHost, oneString("BUILDHOST")],
  [RPM_TAG.vendor, oneString("VENDOR")],
  [RPM_TAG.license, oneString("LICENSE")],
  [RPM_TAG.packager, oneString("PACKAGER")],
  [RPM_TAG.url, oneString("URL")],
  [RPM_TAG.os, oneString("OS")],
  [RPM_TAG.arch, oneString("ARCH")],
  [RPM_TAG.sourceRpm, oneString("SOURCERPM")],
  [RPM_TAG.prein, oneString("PREIN")],
  [RPM_TAG.postin, oneString("POSTIN")],
  [RPM_TAG.preun, oneString("PREUN")],
  [RPM_TAG.postun, oneString("POSTUN")],
  [RPM_TAG.pretrans, oneString("PRETRANS")],
  [RPM_TAG.posttrans, oneString("POSTTRANS")],
  [RPM_TAG.preinProg, program("PREINPROG")],
  [RPM_TAG.postinProg, program("POSTINPROG")],
  [RPM_TAG.preunProg, program("PREUNPROG")],
  [RPM_TAG.postunProg, program("POSTUNPROG")],
  [RPM_TAG.pretransProg, program("PRETRANSPROG")],
  [RPM_TAG.posttransProg, program("POSTTRANSPROG")],
  [RPM_TAG.triggerScripts, stringList("TRIGGERSCRIPTS")],
  [RPM_TAG.triggerName, stringList("TRIGGERNAME")],
  [RPM_TAG.triggerIndex, int32List("TRIGGERINDEX")],
  [RPM_TAG.triggerScriptProg, stringList("TRIGGERSCRIPTPROG")],
  [RPM_TAG.fileSizes, int32List("FILESIZES")],
  [RPM_TAG.longFileSizes, { name: "LONGFILESIZES", types: [RPM_TYPE.int64] }],
  [RPM_TAG.fileModes, { name: "FILEMODES", types: [RPM_TYPE.int16] }],
  [RPM_TAG.fileDigests, stringList("FILEDIGESTS")],
  [RPM_TAG.fileFlags, int32List("FILEFLAGS")],
  [RPM_TAG.fileUserName, stringList("FILEUSERNAME")],
  [RPM_TAG.fileGroupName, stringList("FILEGROUPNAME")],
  [RPM_TAG.fileDigestAlgo, oneInt32("FILEDIGESTALGO")],
  [RPM_TAG.dirIndexes, int32List("DIRINDEXES")],
  [RPM_TAG.baseNames, stringList("BASENAMES")],
  [RPM_TAG.dirNames, stringList("DIRNAMES")],
  [RPM_TAG.provideName, stringList("PROVIDENAME")],
  [RPM_TAG.provideFlags, int32List("PROVIDEFLAGS")],
  [RPM_TAG.provideVersion, stringList("PROVIDEVERSION")],
  [RPM_TAG.requireName, stringList("REQUIRENAME")],
  [RPM_TAG.requireFlags, int32List("REQUIREFLAGS")],
  [RPM_TAG.requireVersion, stringList("REQUIREVERSION")],
  [RPM_TAG.conflictName, stringList("CONFLICTNAME")],
  [RPM_TAG.conflictFlags, int32List("CONFLICTFLAGS")],
  [RPM_TAG.conflictVersion, stringList("CONFLICTVERSION")],
  [RPM_TAG.obsoleteName, stringList("OBSOLETENAME")],
  [RPM_TAG.obsoleteFlags, int32List("OBSOLETEFLAGS")],
  [RPM_TAG.obsoleteVersion, stringList("OBSOLETEVERSION")],
  [RPM_TAG.recommendName, stringList("RECOMMENDNAME")],
  [RPM_TAG.recommendFlags, int32List("RECOMMENDFLAGS")],
  [RPM_TAG.recommendVersion, stringList("RECOMMENDVERSION")],
  [RPM_TAG.suggestName, stringList("SUGGESTNAME")],
  [RPM_TAG.suggestFlags, int32List("SUGGESTFLAGS")],
  [RPM_TAG.suggestVersion, stringList("SUGGESTVERSION")],
  [RPM_TAG.supplementName, stringList("SUPPLEMENTNAME")],
  [RPM_TAG.supplementFlags, int32List("SUPPLEMENTFLAGS")],
  [RPM_TAG.supplementVersion, stringList("SUPPLEMENTVERSION")],
  [RPM_TAG.enhanceName, stringList("ENHANCENAME")],
  [RPM_TAG.enhanceFlags, int32List("ENHANCEFLAGS")],
  [RPM_TAG.enhanceVersion, stringList("ENHANCEVERSION")],
  [RPM_TAG.payloadFormat, oneString("PAYLOADFORMAT")],
  [RPM_TAG.payloadCompressor, oneString("PAYLOADCOMPRESSOR")],
  [RPM_TAG.payloadFlags, oneString("PAYLOADFLAGS")],
  [RPM_TAG.payloadDigest, stringList("PAYLOADDIGEST")],
  [RPM_TAG.payloadDigestAlgo, oneInt32("PAYLOADDIGESTALGO")],
]);

/** Every signature-header tag this parser reads. */
const SIGNATURE_TAG_SPECS: ReadonlyMap<number, TagSpec> = new Map([
  [RPM_SIG_TAG.size, oneInt32("SIG_SIZE")],
  [RPM_SIG_TAG.md5, binary("SIG_MD5", 16)],
  [RPM_SIG_TAG.pgp, binary("SIG_PGP")],
  [RPM_SIG_TAG.gpg, binary("SIG_GPG")],
  [RPM_SIG_TAG.rsaHeader, binary("RSAHEADER")],
  [RPM_SIG_TAG.dsaHeader, binary("DSAHEADER")],
  [RPM_SIG_TAG.sha1Header, oneString("SHA1HEADER")],
  [RPM_SIG_TAG.sha256Header, oneString("SHA256HEADER")],
  [RPM_TAG.payloadDigest, stringList("PAYLOADDIGEST")],
  [RPM_TAG.payloadDigestAlgo, oneInt32("PAYLOADDIGESTALGO")],
]);

/** Refuse a read tag whose stored type or count cannot carry its meaning. */
const checkTagSpec = (
  entry: IndexEntry,
  specs: ReadonlyMap<number, TagSpec>,
  label: "signature" | "main",
  at: number,
): void => {
  const spec = specs.get(entry.tag);
  if (spec === undefined) return;
  const field = `${label} tag ${String(entry.tag)}`;
  if (!spec.types.includes(entry.type))
    fail(
      `RPM ${label} header tag ${String(entry.tag)} (${spec.name}) is stored as ${typeName(entry.type)}; expected ${spec.types.map(typeName).join(" or ")}.`,
      { offset: at, field },
    );
  if (spec.count !== undefined && entry.count !== spec.count)
    fail(
      `RPM ${label} header tag ${String(entry.tag)} (${spec.name}) has count ${String(entry.count)}; expected ${String(spec.count)}.`,
      { offset: at, field },
    );
};

/**
 * Main-header tags that hold one value per file row. Their declared counts are
 * checked against max_files before any value is built, so a store that
 * declares millions of empty strings never materializes them.
 */
const PER_FILE_TAGS: ReadonlyMap<number, string> = new Map([
  [RPM_TAG.baseNames, "BASENAMES"],
  [RPM_TAG.dirNames, "DIRNAMES"],
  [RPM_TAG.dirIndexes, "DIRINDEXES"],
  [RPM_TAG.fileSizes, "FILESIZES"],
  [RPM_TAG.longFileSizes, "LONGFILESIZES"],
  [RPM_TAG.fileModes, "FILEMODES"],
  [RPM_TAG.fileDigests, "FILEDIGESTS"],
  [RPM_TAG.fileFlags, "FILEFLAGS"],
  [RPM_TAG.fileUserName, "FILEUSERNAME"],
  [RPM_TAG.fileGroupName, "FILEGROUPNAME"],
]);

const checkPerFileCount = (entry: IndexEntry, maxFiles: number): void => {
  const name = PER_FILE_TAGS.get(entry.tag);
  if (name !== undefined && entry.count > maxFiles)
    throw new RpmPackageCapacityFailure(
      "max_files",
      maxFiles,
      `RPM ${name} declares ${String(entry.count)} rows, above the ${String(maxFiles)}-file budget.`,
    );
};

const parseHeader = (
  reader: BinaryReader,
  start: number,
  budget: { readonly maxIndex: number; readonly maxFiles?: number },
  label: "signature" | "main",
): DecodedHeader => {
  const { maxIndex, maxFiles = Number.POSITIVE_INFINITY } = budget;
  reader.range(start, 16, `RPM ${label} header`);
  const magic = reader.u32(start);
  if (magic !== RPM_HEADER_MAGIC)
    fail(`RPM ${label} header magic ${magic.toString(16)} is not 8eade801.`, {
      offset: start,
      field: `${label} header magic`,
    });
  const indexEntries = reader.u32(start + 8);
  const storeBytes = reader.u32(start + 12);
  const indexBytes = indexEntries * 16;
  // A declared extent past the end of the file is truncation that no budget
  // can supply, so it is checked before the entry budget.
  reader.range(
    start + 16,
    indexBytes + storeBytes,
    `RPM ${label} header index and data store`,
  );
  if (indexEntries > maxIndex)
    throw new RpmPackageCapacityFailure(
      "max_header_index_entries",
      maxIndex,
      `RPM ${label} header declares ${String(indexEntries)} index entries, above the ${String(maxIndex)}-entry budget.`,
    );
  const storeOffset = start + 16 + indexBytes;
  const store = new BinaryReader(
    reader.range(storeOffset, storeBytes, `RPM ${label} data store`),
    false,
    FORMAT,
  );
  const tags: IndexEntry[] = [];
  const values = new Map<number, HeaderValue>();
  const unreadScan = { remaining: storeBytes };
  for (let index = 0; index < indexEntries; index += 1) {
    const at = start + 16 + index * 16;
    const entry: IndexEntry = {
      tag: reader.u32(at),
      type: reader.u32(at + 4),
      // The on-disk offset is a signed 32-bit field.
      offset: reader.u32(at + 8) | 0,
      count: reader.u32(at + 12),
    };
    tags.push(entry);
    if (
      entry.tag === RPM_SIG_TAG.headerSignatures ||
      entry.tag === RPM_TAG.headerImmutable
    ) {
      if (entry.type !== RPM_TYPE.bin || entry.count !== 16)
        fail(
          `RPM ${label} region tag ${String(entry.tag)} is not a 16-byte BIN value.`,
          { offset: at, field: `${label} region tag` },
        );
      if (entry.offset < 0 || entry.offset > storeBytes - 16)
        fail(
          `RPM ${label} region tag ${String(entry.tag)} is outside the data store.`,
          { offset: at, field: `${label} region tag` },
        );
      continue;
    }
    const specs = label === "main" ? MAIN_TAG_SPECS : SIGNATURE_TAG_SPECS;
    // Only tags this reader reports are decoded, so unknown tags cannot make
    // the parser materialize values the report never uses.
    if (!specs.has(entry.tag)) {
      checkEntryExtent(store, entry, unreadScan);
      continue;
    }
    checkTagSpec(entry, specs, label, at);
    if (values.has(entry.tag))
      fail(
        `RPM ${label} header repeats tag ${String(entry.tag)}, so its value is ambiguous.`,
        { offset: at, field: `${label} tag ${String(entry.tag)}` },
      );
    if (label === "main") {
      // Placement and impossible stored extents are malformed input, so they
      // are refused before the file budget, which only guards allocation.
      checkStoredExtent(store, entry);
      checkPerFileCount(entry, maxFiles);
    }
    values.set(entry.tag, decodeEntry(store, entry));
  }
  return {
    label,
    location: { offset: start, bytes: 16 + indexBytes + storeBytes },
    indexEntries,
    storeBytes,
    storeOffset,
    values,
    tags,
  };
};

/**
 * Tag specs are checked before any getter runs, so a present value of another
 * kind is a parser defect; refuse it rather than report the tag as missing.
 */
const unexpectedKind = (tag: number, value: HeaderValue): never =>
  fail(
    `RPM tag ${String(tag)} decoded as ${value.kind}, which its reader does not accept.`,
    { field: `tag ${String(tag)}` },
  );

const stringValue = (
  header: DecodedHeader,
  tag: number,
): string | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "string") return headerText(header, tag, value.raw);
  if (value.kind === "strings")
    return headerText(header, tag, value.raw[0]!, 0);
  return unexpectedKind(tag, value);
};

/** Stored byte length plus text decoded only when the report includes it. */
interface StoredString {
  readonly text: () => string;
  readonly bytes: number;
}

const stored = (
  header: DecodedHeader,
  tag: number,
  raw: Buffer,
  index?: number,
): StoredString => ({
  text: () => headerText(header, tag, raw, index),
  bytes: raw.length,
});

const storedString = (
  header: DecodedHeader,
  tag: number,
): StoredString | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "string") return stored(header, tag, value.raw);
  if (value.kind === "strings") return stored(header, tag, value.raw[0]!, 0);
  return unexpectedKind(tag, value);
};

const storedStrings = (
  header: DecodedHeader,
  tag: number,
): readonly StoredString[] | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "strings")
    return value.raw.map((raw, index) => stored(header, tag, raw, index));
  if (value.kind === "string") return [stored(header, tag, value.raw)];
  return unexpectedKind(tag, value);
};

const stringArray = (
  header: DecodedHeader,
  tag: number,
): readonly string[] | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "strings")
    return value.raw.map((raw, index) => headerText(header, tag, raw, index));
  if (value.kind === "string") return [headerText(header, tag, value.raw)];
  return unexpectedKind(tag, value);
};

const intValue = (header: DecodedHeader, tag: number): number | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "ints") return value.values[0];
  return unexpectedKind(tag, value);
};

const intArray = (
  header: DecodedHeader,
  tag: number,
): readonly number[] | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "ints") return value.values;
  return unexpectedKind(tag, value);
};

const binValue = (header: DecodedHeader, tag: number): Buffer | undefined => {
  const value = header.values.get(tag);
  if (value === undefined) return undefined;
  if (value.kind === "bin") return value.value;
  return unexpectedKind(tag, value);
};

const comparison = (flags: number): RpmDependencyComparison | null => {
  const less = (flags & RPM_SENSE.less) !== 0;
  const greater = (flags & RPM_SENSE.greater) !== 0;
  const equal = (flags & RPM_SENSE.equal) !== 0;
  if (less && equal) return "<=";
  if (greater && equal) return ">=";
  if (equal) return "=";
  if (less) return "<";
  if (greater) return ">";
  return null;
};

const dependencies = (
  header: DecodedHeader,
  namesTag: number,
  flagsTag: number,
  versionsTag: number,
): RpmDependency[] | null => {
  const names = stringArray(header, namesTag);
  if (names === undefined) return null;
  const flags = intArray(header, flagsTag);
  const versions = stringArray(header, versionsTag) ?? [];
  if (
    (flags !== undefined &&
      flags.length !== 0 &&
      flags.length !== names.length) ||
    (versions.length !== 0 && versions.length !== names.length)
  )
    fail(
      `RPM dependency arrays for tag ${String(namesTag)} have mismatched counts.`,
      { field: `tag ${String(namesTag)}` },
    );
  return names.map((name, index) => {
    const flag = flags?.[index];
    return {
      name,
      version: text(versions[index]),
      flags: flag ?? null,
      comparison: flag === undefined ? null : comparison(flag),
      rpmlib:
        name.startsWith("rpmlib(") ||
        (flag !== undefined && (flag & RPM_SENSE.rpmlib) !== 0),
      scriptlet_only:
        flag === undefined ? null : (flag & SCRIPTLET_SENSE) !== 0,
    };
  });
};

const openPgpLength = (
  reader: BinaryReader,
  at: number,
): { readonly length: number; readonly next: number } | undefined => {
  const { bytes } = reader;
  if (at >= bytes.length) return undefined;
  const first = bytes[at]!;
  if (first < 192) return { length: first, next: at + 1 };
  if (first < 224) {
    if (at + 1 >= bytes.length) return undefined;
    return { length: (first - 192) * 256 + bytes[at + 1]! + 192, next: at + 2 };
  }
  if (first === 255) {
    if (at + 5 > bytes.length) return undefined;
    return { length: reader.u32(at + 1), next: at + 5 };
  }
  return undefined;
};

const issuerKeyId = (subpackets: Buffer): string | null => {
  const reader = new BinaryReader(subpackets, false, FORMAT);
  let cursor = 0;
  while (cursor < subpackets.length) {
    const decoded = openPgpLength(reader, cursor);
    if (decoded === undefined || decoded.length < 1) return null;
    const body = subpackets.subarray(
      decoded.next,
      decoded.next + decoded.length,
    );
    if (body.length < decoded.length) return null;
    const type = body[0];
    if (type === 16 && body.length >= 9) return hex(body.subarray(1, 9));
    cursor = decoded.next + decoded.length;
  }
  return null;
};

const decodeOpenPgpSignature = (
  blob: Buffer,
): { readonly algorithm: string | null; readonly key_id: string | null } => {
  if (blob.length < 2) return { algorithm: null, key_id: null };
  const reader = new BinaryReader(blob, false, FORMAT);
  const first = blob[0]!;
  if ((first & 0x80) === 0) return { algorithm: null, key_id: null };
  let tag: number;
  let body: Buffer;
  if ((first & 0x40) === 0) {
    tag = (first >> 2) & 0x0f;
    const lengthType = first & 0x03;
    let offset = 1;
    let length = 0;
    if (lengthType === 0) {
      if (blob.length < 2) return { algorithm: null, key_id: null };
      length = blob[1]!;
      offset = 2;
    } else if (lengthType === 1) {
      if (blob.length < 3) return { algorithm: null, key_id: null };
      length = reader.u16(1);
      offset = 3;
    } else if (lengthType === 2) {
      if (blob.length < 5) return { algorithm: null, key_id: null };
      length = reader.u32(1);
      offset = 5;
    } else return { algorithm: null, key_id: null };
    body = blob.subarray(offset, offset + length);
  } else {
    tag = first & 0x3f;
    const decoded = openPgpLength(reader, 1);
    if (decoded === undefined) return { algorithm: null, key_id: null };
    body = blob.subarray(decoded.next, decoded.next + decoded.length);
  }
  if (tag !== 2 || body.length < 2) return { algorithm: null, key_id: null };
  const version = body[0]!;
  if (version === 3 && body.length >= 17) {
    return {
      algorithm: OPENPGP_ALGORITHMS[body[15]!] ?? null,
      key_id: hex(body.subarray(7, 15)),
    };
  }
  if (version === 4 && body.length >= 8) {
    const algorithm = OPENPGP_ALGORITHMS[body[2]!] ?? null;
    const fields = new BinaryReader(body, false, FORMAT);
    const hashedLength = fields.u16(4);
    const hashedStart = 6;
    const unhashedStart = hashedStart + hashedLength;
    if (unhashedStart + 2 > body.length) return { algorithm, key_id: null };
    const unhashedLength = fields.u16(unhashedStart);
    const unhashed = body.subarray(
      unhashedStart + 2,
      unhashedStart + 2 + unhashedLength,
    );
    const hashed = body.subarray(hashedStart, hashedStart + hashedLength);
    return {
      algorithm,
      key_id: issuerKeyId(unhashed) ?? issuerKeyId(hashed),
    };
  }
  return { algorithm: null, key_id: null };
};

const signatureBlob = (
  header: DecodedHeader,
  tag: number,
  name: RpmSignatureBlob["tag"],
): RpmSignatureBlob | undefined => {
  const blob = binValue(header, tag);
  if (blob === undefined) return undefined;
  const decoded = decodeOpenPgpSignature(blob);
  return {
    present: true,
    tag: name,
    bytes: blob.length,
    algorithm: decoded.algorithm,
    key_id: decoded.key_id,
  };
};

const digestAlgorithm = (
  id: number | undefined,
): {
  readonly id: number | null;
  readonly name: RpmFileDigestAlgorithm | null;
} => {
  if (id === undefined) return { id: null, name: null };
  return { id, name: DIGEST_ALGORITHMS[id] ?? null };
};

const files = (
  header: DecodedHeader,
  maxFiles: number,
  maxPathBytes: number,
): RpmPackageFile[] | null => {
  const baseNames = stringArray(header, RPM_TAG.baseNames);
  const dirNames = stringArray(header, RPM_TAG.dirNames);
  const dirIndexes = intArray(header, RPM_TAG.dirIndexes);
  if (baseNames === undefined) return null;
  if (baseNames.length > maxFiles)
    throw new RpmPackageCapacityFailure(
      "max_files",
      maxFiles,
      `RPM file inventory has ${String(baseNames.length)} rows, above the ${String(maxFiles)}-file budget.`,
    );
  if (dirNames === undefined || dirIndexes === undefined)
    return fail("RPM file inventory is missing DIRNAMES or DIRINDEXES.", {
      field: "file inventory",
    });
  if (dirIndexes.length !== baseNames.length)
    return fail("RPM DIRINDEXES count does not match BASENAMES.", {
      field: "file inventory",
    });
  // Packages with large files store sizes in LONGFILESIZES instead.
  const longSizes = intArray(header, RPM_TAG.longFileSizes);
  const sizes = longSizes ?? intArray(header, RPM_TAG.fileSizes);
  const modes = intArray(header, RPM_TAG.fileModes);
  const digests = stringArray(header, RPM_TAG.fileDigests);
  const flags = intArray(header, RPM_TAG.fileFlags);
  const users = stringArray(header, RPM_TAG.fileUserName);
  const groups = stringArray(header, RPM_TAG.fileGroupName);
  const algorithm = digestAlgorithm(intValue(header, RPM_TAG.fileDigestAlgo));
  // A present per-file array must have one value per BASENAMES row, so a
  // short or long array is not read as a missing value.
  for (const [name, values] of [
    [longSizes === undefined ? "FILESIZES" : "LONGFILESIZES", sizes],
    ["FILEMODES", modes],
    ["FILEDIGESTS", digests],
    ["FILEFLAGS", flags],
    ["FILEUSERNAME", users],
    ["FILEGROUPNAME", groups],
  ] as const)
    if (values !== undefined && values.length !== baseNames.length)
      fail(
        `RPM ${name} has ${String(values.length)} entries for ${String(baseNames.length)} BASENAMES rows.`,
        { field: "file inventory" },
      );
  // Every row repeats its DIRNAMES value, so one long directory shared by many
  // rows expands far past the stored header bytes. The joined path text is
  // counted against the read budget before any path string is built.
  const dirBytes = dirNames.map((name) => Buffer.byteLength(name, "utf8"));
  let pathBytes = 0;
  baseNames.forEach((baseName, index) => {
    const dirIndex = dirIndexes[index]!;
    if (dirIndex < 0 || dirIndex >= dirNames.length)
      fail(
        `RPM DIRINDEXES[${String(index)}] ${String(dirIndex)} is outside DIRNAMES.`,
        { field: "file inventory" },
      );
    pathBytes += dirBytes[dirIndex]! + Buffer.byteLength(baseName, "utf8");
    if (pathBytes > maxPathBytes)
      throw new RpmPackageCapacityFailure(
        "max_file_bytes",
        maxPathBytes,
        `RPM file paths expand past the ${String(maxPathBytes)}-byte read budget.`,
      );
  });
  return baseNames.map((baseName, index) => {
    const directory = dirNames[dirIndexes[index]!]!;
    const flag = flags?.[index];
    return {
      path: `${directory}${baseName}`,
      size: sizes?.[index] ?? null,
      mode: modes?.[index] ?? null,
      digest: text(digests?.[index]?.toLowerCase()),
      digest_algorithm: algorithm.name,
      digest_algorithm_id: algorithm.id,
      flags: flag ?? null,
      config: flag === undefined ? null : (flag & RPM_FILE_FLAG.config) !== 0,
      doc: flag === undefined ? null : (flag & RPM_FILE_FLAG.doc) !== 0,
      user: text(users?.[index]),
      group: text(groups?.[index]),
    };
  });
};

const scriptText = (
  source: StoredString | undefined,
  include: boolean,
  maxBytes: number,
  kind: RpmScriptletKind,
): { readonly bytes: number; readonly text: string | null } | undefined => {
  if (source === undefined) return undefined;
  if (include && source.bytes > maxBytes)
    throw new RpmPackageCapacityFailure(
      "max_script_bytes",
      maxBytes,
      `RPM ${kind} scriptlet is ${String(source.bytes)} bytes, above the ${String(maxBytes)}-byte script budget.`,
    );
  return { bytes: source.bytes, text: include ? source.text() : null };
};

/** Group each TRIGGERNAME condition under the TRIGGERSCRIPTS entry its TRIGGERINDEX names. */
const triggerConditions = (
  header: DecodedHeader,
  scriptCount: number,
): string[][] => {
  const grouped = Array.from({ length: scriptCount }, (): string[] => []);
  const names = stringArray(header, RPM_TAG.triggerName) ?? [];
  if (names.length === 0) return grouped;
  const indexes = intArray(header, RPM_TAG.triggerIndex);
  if (indexes?.length !== names.length)
    fail(
      `RPM TRIGGERINDEX has ${String(indexes?.length ?? 0)} entries for ${String(names.length)} TRIGGERNAME conditions.`,
      { field: "trigger index" },
    );
  for (const [position, name] of names.entries()) {
    const scriptIndex = indexes![position]!;
    if (scriptIndex < 0 || scriptIndex >= scriptCount)
      fail(
        `RPM TRIGGERINDEX[${String(position)}] ${String(scriptIndex)} is outside TRIGGERSCRIPTS.`,
        { field: "trigger index" },
      );
    grouped[scriptIndex]!.push(name);
  }
  return grouped;
};

const scriptlets = (
  header: DecodedHeader,
  includeText: boolean,
  maxBytes: number,
): RpmScriptlet[] | null => {
  const rows: RpmScriptlet[] = [];
  const kinds: readonly {
    readonly kind: Exclude<RpmScriptletKind, "trigger">;
    readonly text: number;
    readonly prog: number;
  }[] = [
    { kind: "prein", text: RPM_TAG.prein, prog: RPM_TAG.preinProg },
    { kind: "postin", text: RPM_TAG.postin, prog: RPM_TAG.postinProg },
    { kind: "preun", text: RPM_TAG.preun, prog: RPM_TAG.preunProg },
    { kind: "postun", text: RPM_TAG.postun, prog: RPM_TAG.postunProg },
    { kind: "pretrans", text: RPM_TAG.pretrans, prog: RPM_TAG.pretransProg },
    { kind: "posttrans", text: RPM_TAG.posttrans, prog: RPM_TAG.posttransProg },
  ];
  for (const item of kinds) {
    const body = scriptText(
      storedString(header, item.text),
      includeText,
      maxBytes,
      item.kind,
    );
    if (body === undefined) continue;
    rows.push({
      kind: item.kind,
      interpreter: text(stringValue(header, item.prog)),
      bytes: body.bytes,
      text: body.text,
      trigger_names: null,
    });
  }
  const triggerScripts = storedStrings(header, RPM_TAG.triggerScripts);
  if (triggerScripts !== undefined) {
    const programs = stringArray(header, RPM_TAG.triggerScriptProg);
    if (programs !== undefined && programs.length !== triggerScripts.length)
      fail(
        `RPM TRIGGERSCRIPTPROG has ${String(programs.length)} entries for ${String(triggerScripts.length)} TRIGGERSCRIPTS.`,
        { field: "trigger script programs" },
      );
    const conditions = triggerConditions(header, triggerScripts.length);
    for (const [index, source] of triggerScripts.entries()) {
      const body = scriptText(source, includeText, maxBytes, "trigger");
      if (body === undefined) continue;
      rows.push({
        kind: "trigger",
        interpreter: text(programs?.[index]),
        bytes: body.bytes,
        text: body.text,
        trigger_names: conditions[index]!,
      });
    }
  }
  return rows.length === 0 ? null : rows;
};

/** Every signature-header fact, read before the main header so later failures keep it. */
const signatureObservation = (
  signatureHeader: DecodedHeader,
  padBytes: number,
) => {
  const md5 = binValue(signatureHeader, RPM_SIG_TAG.md5);
  const blobs = [
    signatureBlob(signatureHeader, RPM_SIG_TAG.pgp, "pgp"),
    signatureBlob(signatureHeader, RPM_SIG_TAG.gpg, "gpg"),
    signatureBlob(signatureHeader, RPM_SIG_TAG.rsaHeader, "rsa"),
    signatureBlob(signatureHeader, RPM_SIG_TAG.dsaHeader, "dsa"),
  ].filter((blob): blob is RpmSignatureBlob => blob !== undefined);
  return {
    location: signatureHeader.location,
    pad_bytes: padBytes,
    index_entries: signatureHeader.indexEntries,
    store_bytes: signatureHeader.storeBytes,
    size: intValue(signatureHeader, RPM_SIG_TAG.size) ?? null,
    md5: md5 === undefined ? null : hex(md5),
    sha1_header: text(stringValue(signatureHeader, RPM_SIG_TAG.sha1Header)),
    sha256_header: text(stringValue(signatureHeader, RPM_SIG_TAG.sha256Header)),
    payload_digest: text(stringValue(signatureHeader, RPM_TAG.payloadDigest)),
    payload_digest_algorithm:
      intValue(signatureHeader, RPM_TAG.payloadDigestAlgo) ?? null,
    blobs,
  };
};

const pad8 = (offset: number): number => (8 - (offset % 8)) % 8;

const dependencyCount = (
  ...sets: ReadonlyArray<readonly RpmDependency[] | null>
): number | null => {
  let total = 0;
  let present = false;
  for (const set of sets) {
    if (set === null) continue;
    present = true;
    total += set.length;
  }
  return present ? total : null;
};

/** Decode one RPM file's lead, signature header, and main header. */
export const parseRpmPackage = (
  bytes: Buffer,
  artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  },
  input: InspectRpmPackageInput,
  signal?: AbortSignal,
): RpmPackage => {
  signal?.throwIfAborted();
  const reader = new BinaryReader(bytes, false, FORMAT);
  const lead = parseLead(reader);
  const observed = leadObserved(lead);
  if (lead.signature_type !== 5)
    throw new ParseFailureError({
      kind: "unsupported",
      format: FORMAT,
      detail: `RPM signature type ${String(lead.signature_type)} is not the header signature format.`,
      offset: 78,
      field: "lead signature type",
      undecodedContent: false,
      observed,
    });
  const signatureHeader = observing(observed, () =>
    parseHeader(
      reader,
      RPM_LEAD_SIZE,
      { maxIndex: input.max_header_index_entries },
      "signature",
    ),
  );
  const padBytes = pad8(signatureHeader.location.bytes);
  const headerStart =
    signatureHeader.location.offset + signatureHeader.location.bytes + padBytes;
  const signatureFacts = observing(
    {
      ...observed,
      signature: {
        offset: signatureHeader.location.offset,
        bytes: signatureHeader.location.bytes,
        index_entries: signatureHeader.indexEntries,
      },
    },
    () => signatureObservation(signatureHeader, padBytes),
  );
  const withSignature = { ...observed, signature: signatureFacts };
  signal?.throwIfAborted();
  return observing(withSignature, (): RpmPackage => {
    const mainHeader = parseHeader(
      reader,
      headerStart,
      {
        maxIndex: input.max_header_index_entries,
        maxFiles: input.max_files,
      },
      "main",
    );
    const payloadOffset =
      mainHeader.location.offset + mainHeader.location.bytes;
    if (payloadOffset > bytes.length)
      fail("RPM payload offset is past the end of the file.", {
        offset: payloadOffset,
        field: "payload",
      });
    // A repeated region tag would leave the immutable region ambiguous.
    const immutableRegion = uniqueKeyed(
      keyedBy(mainHeader.tags, (entry) => entry.tag),
      RPM_TAG.headerImmutable,
    );
    const immutable = immutableRegion.ok
      ? immutableRegion.value
      : fail(
          `RPM main header repeats region tag ${String(RPM_TAG.headerImmutable)}, so its immutable region is ambiguous.`,
          { field: "main region tag" },
        );
    const provides = dependencies(
      mainHeader,
      RPM_TAG.provideName,
      RPM_TAG.provideFlags,
      RPM_TAG.provideVersion,
    );
    const requires = dependencies(
      mainHeader,
      RPM_TAG.requireName,
      RPM_TAG.requireFlags,
      RPM_TAG.requireVersion,
    );
    const conflicts = dependencies(
      mainHeader,
      RPM_TAG.conflictName,
      RPM_TAG.conflictFlags,
      RPM_TAG.conflictVersion,
    );
    const obsoletes = dependencies(
      mainHeader,
      RPM_TAG.obsoleteName,
      RPM_TAG.obsoleteFlags,
      RPM_TAG.obsoleteVersion,
    );
    const recommends = dependencies(
      mainHeader,
      RPM_TAG.recommendName,
      RPM_TAG.recommendFlags,
      RPM_TAG.recommendVersion,
    );
    const suggests = dependencies(
      mainHeader,
      RPM_TAG.suggestName,
      RPM_TAG.suggestFlags,
      RPM_TAG.suggestVersion,
    );
    const supplements = dependencies(
      mainHeader,
      RPM_TAG.supplementName,
      RPM_TAG.supplementFlags,
      RPM_TAG.supplementVersion,
    );
    const enhances = dependencies(
      mainHeader,
      RPM_TAG.enhanceName,
      RPM_TAG.enhanceFlags,
      RPM_TAG.enhanceVersion,
    );
    const fileRows = files(mainHeader, input.max_files, input.max_file_bytes);
    const scriptletRows = scriptlets(
      mainHeader,
      input.include_script_text,
      input.max_script_bytes,
    );
    const payloadFormat =
      stringValue(mainHeader, RPM_TAG.payloadFormat) ?? null;
    const payloadCompressor =
      stringValue(mainHeader, RPM_TAG.payloadCompressor) ?? null;
    const payloadFlags = stringValue(mainHeader, RPM_TAG.payloadFlags) ?? null;
    const limitations = [
      ...RPM_PACKAGE_LIMITATIONS,
      ...(input.include_script_text
        ? []
        : [
            "Scriptlet source text is omitted unless include_script_text is true.",
          ]),
    ];
    const report: RpmPackage = {
      artifact,
      lead,
      signature: {
        ...signatureFacts,
        payload_digest:
          signatureFacts.payload_digest ??
          text(stringValue(mainHeader, RPM_TAG.payloadDigest)),
        payload_digest_algorithm:
          signatureFacts.payload_digest_algorithm ??
          intValue(mainHeader, RPM_TAG.payloadDigestAlgo) ??
          null,
      },
      header: {
        location: mainHeader.location,
        index_entries: mainHeader.indexEntries,
        store_bytes: mainHeader.storeBytes,
        immutable_region:
          immutable === undefined
            ? null
            : {
                present: true,
                store_offset: immutable.offset,
                bytes: immutable.count,
              },
      },
      package: {
        name: text(stringValue(mainHeader, RPM_TAG.name)),
        version: text(stringValue(mainHeader, RPM_TAG.version)),
        release: text(stringValue(mainHeader, RPM_TAG.release)),
        epoch: intValue(mainHeader, RPM_TAG.epoch) ?? null,
        arch: text(stringValue(mainHeader, RPM_TAG.arch)),
        os: text(stringValue(mainHeader, RPM_TAG.os)),
        summary: text(stringValue(mainHeader, RPM_TAG.summary)),
        license: text(stringValue(mainHeader, RPM_TAG.license)),
        vendor: text(stringValue(mainHeader, RPM_TAG.vendor)),
        packager: text(stringValue(mainHeader, RPM_TAG.packager)),
        url: text(stringValue(mainHeader, RPM_TAG.url)),
        build_time: intValue(mainHeader, RPM_TAG.buildTime) ?? null,
        build_host: text(stringValue(mainHeader, RPM_TAG.buildHost)),
        source_rpm: text(stringValue(mainHeader, RPM_TAG.sourceRpm)),
        payload_format: text(payloadFormat ?? undefined),
        payload_compressor: text(payloadCompressor ?? undefined),
        payload_flags: text(payloadFlags ?? undefined),
      },
      provides,
      requires,
      conflicts,
      obsoletes,
      recommends,
      suggests,
      supplements,
      enhances,
      scriptlets: scriptletRows,
      files: fileRows,
      payload: {
        offset: payloadOffset,
        size: bytes.length - payloadOffset,
        format: text(payloadFormat ?? undefined),
        compressor: text(payloadCompressor ?? undefined),
        flags: text(payloadFlags ?? undefined),
        listing_source: "header",
      },
      coverage: {
        status: "complete",
        header_tags: mainHeader.indexEntries,
        files: fileRows === null ? null : fileRows.length,
        dependencies: dependencyCount(
          provides,
          requires,
          conflicts,
          obsoletes,
          recommends,
          suggests,
          supplements,
          enhances,
        ),
      },
      limitations,
    };
    // Header values the report cannot carry (a non-hex digest, an empty
    // dependency name) are refused here, inside the observed scope, so the
    // lead and signature facts already read survive the failure.
    const checked = rpmPackageSchema.safeParse(report);
    if (!checked.success) {
      const issue = checked.error.issues[0]!;
      fail(
        `RPM header value at ${issue.path.join(".")} is not admissible: ${issue.message}`,
        {
          field: issue.path.join("."),
        },
      );
    }
    return report;
  });
};

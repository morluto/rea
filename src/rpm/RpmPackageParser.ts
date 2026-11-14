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
  RpmPackageCapacityFailure,
  RpmPackageFormatFailure,
} from "./RpmPackage.errors.js";
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
  RPM_SENSE.interp |
  RPM_SENSE.scriptPre |
  RPM_SENSE.scriptPost |
  RPM_SENSE.scriptPreun |
  RPM_SENSE.scriptPostun;

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

type HeaderValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "strings"; readonly values: readonly string[] }
  | { readonly kind: "ints"; readonly values: readonly number[] }
  | { readonly kind: "bin"; readonly value: Buffer };

interface IndexEntry {
  readonly tag: number;
  readonly type: number;
  readonly offset: number;
  readonly count: number;
}

interface DecodedHeader {
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

const fail = (
  message: string,
  observed?: Readonly<Record<string, JsonValue>>,
  kind: "malformed" | "unsupported" = "malformed",
): never => {
  throw new RpmPackageFormatFailure(kind, message, observed);
};

const requireRange = (
  bytes: Buffer,
  offset: number,
  length: number,
  message: string,
  observed?: Readonly<Record<string, JsonValue>>,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > bytes.length - length
  )
    fail(message, observed);
};

const u16 = (bytes: Buffer, offset: number): number => {
  requireRange(
    bytes,
    offset,
    2,
    `RPM integer at ${String(offset)} is truncated.`,
  );
  return bytes.readUInt16BE(offset);
};

const u32 = (bytes: Buffer, offset: number): number => {
  requireRange(
    bytes,
    offset,
    4,
    `RPM integer at ${String(offset)} is truncated.`,
  );
  return bytes.readUInt32BE(offset);
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

const parseLead = (bytes: Buffer): Lead => {
  if (bytes.length < 4) fail("RPM lead is truncated.", undefined, "malformed");
  const magic = bytes.readUInt32BE(0);
  if (magic !== RPM_LEAD_MAGIC)
    fail(
      `Selected file is not an RPM (magic ${magic.toString(16)}).`,
      undefined,
      "unsupported",
    );
  if (bytes.length < RPM_LEAD_SIZE)
    fail(
      "RPM lead is truncated.",
      { lead: { magic: "edabeedb" } },
      "malformed",
    );
  const typeNumber = u16(bytes, 6);
  if (typeNumber !== 0 && typeNumber !== 1)
    fail(`RPM lead type ${String(typeNumber)} is not binary or source.`, {
      lead_type: typeNumber,
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
    arch_number: u16(bytes, 8),
    os_number: u16(bytes, 76),
    name: text(name),
    signature_type: u16(bytes, 78),
    location: { offset: 0, bytes: RPM_LEAD_SIZE },
  };
};

const readCString = (
  store: Buffer,
  offset: number,
  message: string,
  observed?: Readonly<Record<string, JsonValue>>,
): { readonly value: string; readonly next: number } => {
  if (offset >= store.length) fail(message, observed);
  const nul = store.indexOf(0, offset);
  if (nul === -1) fail(message, observed);
  return {
    value: store.subarray(offset, nul).toString("binary"),
    next: nul + 1,
  };
};

const readStrings = (
  store: Buffer,
  offset: number,
  count: number,
  message: string,
  observed?: Readonly<Record<string, JsonValue>>,
): readonly string[] => {
  const values: string[] = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    const read = readCString(store, cursor, message, observed);
    values.push(read.value);
    cursor = read.next;
  }
  return values;
};

const readInts = (
  store: Buffer,
  offset: number,
  count: number,
  size: 1 | 2 | 4 | 8,
  observed?: Readonly<Record<string, JsonValue>>,
): readonly number[] => {
  const width = size * count;
  requireRange(
    store,
    offset,
    width,
    `RPM integer array at store offset ${String(offset)} leaves the data store.`,
    observed,
  );
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * size;
    if (size === 1) values.push(store[at]!);
    else if (size === 2) values.push(store.readUInt16BE(at));
    else if (size === 4) values.push(store.readUInt32BE(at));
    else {
      const value = store.readBigUInt64BE(at);
      if (value > BigInt(Number.MAX_SAFE_INTEGER))
        fail(
          `RPM INT64 at store offset ${String(at)} exceeds a safe integer.`,
          observed,
        );
      values.push(Number(value));
    }
  }
  return values;
};

const decodeEntry = (
  store: Buffer,
  entry: IndexEntry,
  observed?: Readonly<Record<string, JsonValue>>,
): HeaderValue => {
  const align = TYPE_ALIGN[entry.type] ?? 1;
  if (entry.count < 1)
    fail(
      `RPM tag ${String(entry.tag)} count ${String(entry.count)} is not positive.`,
      observed,
    );
  if (entry.offset < 0 || entry.offset > store.length)
    fail(
      `RPM tag ${String(entry.tag)} offset ${String(entry.offset)} is outside the data store.`,
      observed,
    );
  if (align > 1 && entry.offset % align !== 0)
    fail(
      `RPM tag ${String(entry.tag)} offset ${String(entry.offset)} is not aligned for type ${String(entry.type)}.`,
      observed,
    );
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
          observed,
        ),
      };
    case RPM_TYPE.string:
      if (entry.count !== 1)
        fail(
          `RPM STRING tag ${String(entry.tag)} count ${String(entry.count)} is not 1.`,
          observed,
        );
      return {
        kind: "string",
        value: readCString(
          store,
          entry.offset,
          `RPM STRING tag ${String(entry.tag)} is not NUL-terminated in the data store.`,
          observed,
        ).value,
      };
    case RPM_TYPE.bin: {
      requireRange(
        store,
        entry.offset,
        entry.count,
        `RPM BIN tag ${String(entry.tag)} leaves the data store.`,
        observed,
      );
      return {
        kind: "bin",
        value: Buffer.from(
          store.subarray(entry.offset, entry.offset + entry.count),
        ),
      };
    }
    case RPM_TYPE.stringArray:
    case RPM_TYPE.i18nString:
      return {
        kind: "strings",
        values: readStrings(
          store,
          entry.offset,
          entry.count,
          `RPM string array tag ${String(entry.tag)} is truncated.`,
          observed,
        ),
      };
    default:
      return fail(
        `RPM tag ${String(entry.tag)} type ${String(entry.type)} is not a defined RPM type.`,
        observed,
      );
  }
};

const parseHeader = (
  bytes: Buffer,
  start: number,
  maxIndex: number,
  observed: Readonly<Record<string, JsonValue>>,
  label: "signature" | "main",
): DecodedHeader => {
  requireRange(bytes, start, 16, `RPM ${label} header is truncated.`, observed);
  const magic = u32(bytes, start);
  if (magic !== RPM_HEADER_MAGIC)
    fail(
      `RPM ${label} header magic ${magic.toString(16)} is not 8eade801.`,
      observed,
    );
  const indexEntries = u32(bytes, start + 8);
  const storeBytes = u32(bytes, start + 12);
  if (indexEntries > maxIndex)
    throw new RpmPackageCapacityFailure(
      "max_header_index_entries",
      maxIndex,
      `RPM ${label} header declares ${String(indexEntries)} index entries, above the ${String(maxIndex)}-entry budget.`,
    );
  const indexBytes = indexEntries * 16;
  requireRange(
    bytes,
    start + 16,
    indexBytes + storeBytes,
    `RPM ${label} header index or data store is truncated.`,
    observed,
  );
  const storeOffset = start + 16 + indexBytes;
  const store = bytes.subarray(storeOffset, storeOffset + storeBytes);
  const tags: IndexEntry[] = [];
  const values = new Map<number, HeaderValue>();
  for (let index = 0; index < indexEntries; index += 1) {
    const at = start + 16 + index * 16;
    const entry: IndexEntry = {
      tag: u32(bytes, at),
      type: u32(bytes, at + 4),
      offset: bytes.readInt32BE(at + 8),
      count: u32(bytes, at + 12),
    };
    tags.push(entry);
    if (
      entry.tag === RPM_SIG_TAG.headerSignatures ||
      entry.tag === RPM_TAG.headerImmutable
    ) {
      if (entry.type !== RPM_TYPE.bin || entry.count !== 16)
        fail(
          `RPM ${label} region tag ${String(entry.tag)} is not a 16-byte BIN value.`,
          observed,
        );
      if (entry.offset < 0 || entry.offset > storeBytes - 16)
        fail(
          `RPM ${label} region tag ${String(entry.tag)} is outside the data store.`,
          observed,
        );
      continue;
    }
    if (values.has(entry.tag)) continue;
    values.set(entry.tag, decodeEntry(store, entry, observed));
  }
  return {
    location: { offset: start, bytes: 16 + indexBytes + storeBytes },
    indexEntries,
    storeBytes,
    storeOffset,
    values,
    tags,
  };
};

const stringValue = (
  header: DecodedHeader,
  tag: number,
): string | undefined => {
  const value = header.values.get(tag);
  if (value?.kind === "string") return value.value;
  if (value?.kind === "strings") return value.values[0];
  return undefined;
};

const stringArray = (
  header: DecodedHeader,
  tag: number,
): readonly string[] | undefined => {
  const value = header.values.get(tag);
  if (value?.kind === "strings") return value.values;
  if (value?.kind === "string") return [value.value];
  return undefined;
};

const intValue = (header: DecodedHeader, tag: number): number | undefined => {
  const value = header.values.get(tag);
  if (value?.kind === "ints") return value.values[0];
  return undefined;
};

const intArray = (
  header: DecodedHeader,
  tag: number,
): readonly number[] | undefined => {
  const value = header.values.get(tag);
  if (value?.kind === "ints") return value.values;
  return undefined;
};

const binValue = (header: DecodedHeader, tag: number): Buffer | undefined => {
  const value = header.values.get(tag);
  if (value?.kind === "bin") return value.value;
  return undefined;
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
  observed: Readonly<Record<string, JsonValue>>,
): RpmDependency[] | null => {
  const names = stringArray(header, namesTag);
  if (names === undefined) return null;
  const flags = intArray(header, flagsTag) ?? [];
  const versions = stringArray(header, versionsTag) ?? [];
  if (
    (flags.length !== 0 && flags.length !== names.length) ||
    (versions.length !== 0 && versions.length !== names.length)
  )
    fail(
      `RPM dependency arrays for tag ${String(namesTag)} have mismatched counts.`,
      observed,
    );
  return names.map((name, index) => {
    const flag = flags[index] ?? 0;
    return {
      name,
      version: text(versions[index]),
      flags: flag,
      comparison: comparison(flag),
      rpmlib: (flag & RPM_SENSE.rpmlib) !== 0 || name.startsWith("rpmlib("),
      scriptlet_only: (flag & SCRIPTLET_SENSE) !== 0,
    };
  });
};

const openPgpLength = (
  bytes: Buffer,
  at: number,
): { readonly length: number; readonly next: number } | undefined => {
  if (at >= bytes.length) return undefined;
  const first = bytes[at]!;
  if (first < 192) return { length: first, next: at + 1 };
  if (first < 224) {
    if (at + 1 >= bytes.length) return undefined;
    return { length: (first - 192) * 256 + bytes[at + 1]! + 192, next: at + 2 };
  }
  if (first === 255) {
    if (at + 5 > bytes.length) return undefined;
    return { length: bytes.readUInt32BE(at + 1), next: at + 5 };
  }
  return undefined;
};

const issuerKeyId = (subpackets: Buffer): string | null => {
  let cursor = 0;
  while (cursor < subpackets.length) {
    const decoded = openPgpLength(subpackets, cursor);
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
      length = blob.readUInt16BE(1);
      offset = 3;
    } else if (lengthType === 2) {
      if (blob.length < 5) return { algorithm: null, key_id: null };
      length = blob.readUInt32BE(1);
      offset = 5;
    } else return { algorithm: null, key_id: null };
    body = blob.subarray(offset, offset + length);
  } else {
    tag = first & 0x3f;
    const decoded = openPgpLength(blob, 1);
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
    const hashedLength = body.readUInt16BE(4);
    const hashedStart = 6;
    const unhashedStart = hashedStart + hashedLength;
    if (unhashedStart + 2 > body.length) return { algorithm, key_id: null };
    const unhashedLength = body.readUInt16BE(unhashedStart);
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
  observed: Readonly<Record<string, JsonValue>>,
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
    return fail(
      "RPM file inventory is missing DIRNAMES or DIRINDEXES.",
      observed,
    );
  if (dirIndexes.length !== baseNames.length)
    return fail("RPM DIRINDEXES count does not match BASENAMES.", observed);
  const sizes = intArray(header, RPM_TAG.fileSizes);
  const modes = intArray(header, RPM_TAG.fileModes);
  const digests = stringArray(header, RPM_TAG.fileDigests);
  const flags = intArray(header, RPM_TAG.fileFlags);
  const users = stringArray(header, RPM_TAG.fileUserName);
  const groups = stringArray(header, RPM_TAG.fileGroupName);
  const algorithm = digestAlgorithm(intValue(header, RPM_TAG.fileDigestAlgo));
  return baseNames.map((baseName, index) => {
    const dirIndex = dirIndexes[index]!;
    if (dirIndex < 0 || dirIndex >= dirNames.length)
      fail(
        `RPM DIRINDEXES[${String(index)}] ${String(dirIndex)} is outside DIRNAMES.`,
        observed,
      );
    const directory = dirNames[dirIndex]!;
    const flag = flags?.[index];
    return {
      path: `${directory}${baseName}`,
      size: sizes?.[index] ?? null,
      mode: modes?.[index] ?? null,
      digest: text(digests?.[index]?.toLowerCase()),
      digest_algorithm: algorithm.name,
      digest_algorithm_id: algorithm.id,
      flags: flag ?? null,
      config: flag !== undefined && (flag & RPM_FILE_FLAG.config) !== 0,
      doc: flag !== undefined && (flag & RPM_FILE_FLAG.doc) !== 0,
      user: text(users?.[index]),
      group: text(groups?.[index]),
    };
  });
};

const scriptText = (
  source: string | undefined,
  include: boolean,
  maxBytes: number,
  kind: RpmScriptletKind,
): { readonly bytes: number; readonly text: string | null } | undefined => {
  if (source === undefined) return undefined;
  const encoded = Buffer.from(source, "binary");
  if (include && encoded.length > maxBytes)
    throw new RpmPackageCapacityFailure(
      "max_script_bytes",
      maxBytes,
      `RPM ${kind} scriptlet is ${String(encoded.length)} bytes, above the ${String(maxBytes)}-byte script budget.`,
    );
  return { bytes: encoded.length, text: include ? source : null };
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
      stringValue(header, item.text),
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
      trigger_name: null,
    });
  }
  const triggerScripts = stringArray(header, RPM_TAG.triggerScripts);
  if (triggerScripts !== undefined) {
    const programs = stringArray(header, RPM_TAG.triggerScriptProg) ?? [];
    const names = stringArray(header, RPM_TAG.triggerName) ?? [];
    for (const [index, source] of triggerScripts.entries()) {
      const body = scriptText(source, includeText, maxBytes, "trigger");
      if (body === undefined) continue;
      rows.push({
        kind: "trigger",
        interpreter: text(programs[index]),
        bytes: body.bytes,
        text: body.text,
        trigger_name: text(names[index]),
      });
    }
  }
  return rows.length === 0 ? null : rows;
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
  const lead = parseLead(bytes);
  const observed = leadObserved(lead);
  if (lead.signature_type !== 5)
    fail(
      `RPM signature type ${String(lead.signature_type)} is not the header signature format.`,
      observed,
      "unsupported",
    );
  const signatureHeader = parseHeader(
    bytes,
    RPM_LEAD_SIZE,
    input.max_header_index_entries,
    observed,
    "signature",
  );
  const padBytes = pad8(signatureHeader.location.bytes);
  const headerStart =
    signatureHeader.location.offset + signatureHeader.location.bytes + padBytes;
  const withSignature = {
    ...observed,
    signature: {
      offset: signatureHeader.location.offset,
      bytes: signatureHeader.location.bytes,
      index_entries: signatureHeader.indexEntries,
    },
  };
  signal?.throwIfAborted();
  const mainHeader = parseHeader(
    bytes,
    headerStart,
    input.max_header_index_entries,
    withSignature,
    "main",
  );
  const payloadOffset = mainHeader.location.offset + mainHeader.location.bytes;
  if (payloadOffset > bytes.length)
    fail("RPM payload offset is past the end of the file.", withSignature);
  const immutable = mainHeader.tags.find(
    (entry) => entry.tag === RPM_TAG.headerImmutable,
  );
  const provides = dependencies(
    mainHeader,
    RPM_TAG.provideName,
    RPM_TAG.provideFlags,
    RPM_TAG.provideVersion,
    withSignature,
  );
  const requires = dependencies(
    mainHeader,
    RPM_TAG.requireName,
    RPM_TAG.requireFlags,
    RPM_TAG.requireVersion,
    withSignature,
  );
  const conflicts = dependencies(
    mainHeader,
    RPM_TAG.conflictName,
    RPM_TAG.conflictFlags,
    RPM_TAG.conflictVersion,
    withSignature,
  );
  const obsoletes = dependencies(
    mainHeader,
    RPM_TAG.obsoleteName,
    RPM_TAG.obsoleteFlags,
    RPM_TAG.obsoleteVersion,
    withSignature,
  );
  const recommends = dependencies(
    mainHeader,
    RPM_TAG.recommendName,
    RPM_TAG.recommendFlags,
    RPM_TAG.recommendVersion,
    withSignature,
  );
  const suggests = dependencies(
    mainHeader,
    RPM_TAG.suggestName,
    RPM_TAG.suggestFlags,
    RPM_TAG.suggestVersion,
    withSignature,
  );
  const supplements = dependencies(
    mainHeader,
    RPM_TAG.supplementName,
    RPM_TAG.supplementFlags,
    RPM_TAG.supplementVersion,
    withSignature,
  );
  const enhances = dependencies(
    mainHeader,
    RPM_TAG.enhanceName,
    RPM_TAG.enhanceFlags,
    RPM_TAG.enhanceVersion,
    withSignature,
  );
  const fileRows = files(mainHeader, input.max_files, withSignature);
  const scriptletRows = scriptlets(
    mainHeader,
    input.include_script_text,
    input.max_script_bytes,
  );
  const blobs = [
    signatureBlob(signatureHeader, RPM_SIG_TAG.pgp, "pgp"),
    signatureBlob(signatureHeader, RPM_SIG_TAG.gpg, "gpg"),
    signatureBlob(signatureHeader, RPM_SIG_TAG.rsaHeader, "rsa"),
    signatureBlob(signatureHeader, RPM_SIG_TAG.dsaHeader, "dsa"),
  ].filter((blob): blob is RpmSignatureBlob => blob !== undefined);
  const md5 = binValue(signatureHeader, RPM_SIG_TAG.md5);
  if (md5 !== undefined && md5.length !== 16)
    fail("RPM MD5 signature tag is not 16 bytes.", withSignature);
  const payloadFormat = stringValue(mainHeader, RPM_TAG.payloadFormat) ?? null;
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
  return {
    artifact,
    lead,
    signature: {
      location: signatureHeader.location,
      pad_bytes: padBytes,
      index_entries: signatureHeader.indexEntries,
      store_bytes: signatureHeader.storeBytes,
      size: intValue(signatureHeader, RPM_SIG_TAG.size) ?? null,
      md5: md5 === undefined ? null : hex(md5),
      sha1_header: text(stringValue(signatureHeader, RPM_SIG_TAG.sha1Header)),
      sha256_header: text(
        stringValue(signatureHeader, RPM_SIG_TAG.sha256Header),
      ),
      payload_digest: text(
        stringValue(signatureHeader, RPM_TAG.payloadDigest) ??
          stringValue(mainHeader, RPM_TAG.payloadDigest),
      ),
      payload_digest_algorithm:
        intValue(signatureHeader, RPM_TAG.payloadDigestAlgo) ??
        intValue(mainHeader, RPM_TAG.payloadDigestAlgo) ??
        null,
      blobs,
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
};
